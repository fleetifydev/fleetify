//! Pure execution of a single tool call. No streaming, no LLM, no
//! conversation state — just `(ToolCall, Workspace, Mode) -> ToolResult`.
//!
//! Why pure
//! --------
//!
//! The agentic loop calls the executor with each tool the model emitted.
//! Keeping the executor pure means:
//!   - Easy to unit-test (filesystem ops in a tempdir, no mocks needed).
//!   - Cheap to reuse from non-loop contexts (e.g. a future composer
//!     mode that lets the user manually pre-approve specific tools).
//!   - Permission decisions live ONE level up — the executor only knows
//!     "is this tool allowed in this mode?", not who clicked what in the
//!     renderer.

use std::process::Stdio;
use std::time::Duration;

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::permissions::{Disposition, Mode, PermissionGate};
use super::workspace::Workspace;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCall {
    /// Provider-emitted id. Echoed back in the matching `ToolResult` so
    /// the bridge can pair them when building the next request (Anthropic
    /// `tool_use_id`, OpenAI `tool_call_id`).
    pub id: String,
    pub name: String,
    pub input: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolResult {
    pub tool_call_id: String,
    pub content: String,
    pub is_error: bool,
}

/// Execute one tool call. Disposition dispatch:
///
/// - `AutoAllow`: run the tool directly.
/// - `Ask`: call the gate; on Allow run the tool, on Deny return a
///   tool error the model sees as a normal `tool_result` and can adapt
///   to ("user declined — here's the code instead, apply it yourself").
/// - `Deny`: unknown tool — error out without touching the gate.
pub async fn execute(
    call: &ToolCall,
    workspace: &Workspace,
    mode: Mode,
    gate: &dyn PermissionGate,
) -> ToolResult {
    let make_result = |content: String, is_error: bool| ToolResult {
        tool_call_id: call.id.clone(),
        content,
        is_error,
    };

    match mode.disposition(&call.name) {
        Disposition::Deny => {
            return make_result(
                format!(
                    "Tool `{}` is not in the catalog (or denied by mode {:?}).",
                    call.name, mode
                ),
                true,
            );
        }
        Disposition::AutoAllow => {}
        Disposition::Ask => {
            let allowed = gate.ask(&call.id, &call.name, &call.input).await;
            if !allowed {
                return make_result(
                    format!(
                        "User denied permission for `{}`. Describe what you would have done so they can decide whether to retry with a different choice or switch to a higher autonomy mode.",
                        call.name
                    ),
                    true,
                );
            }
        }
    }

    let outcome: Result<String> = match call.name.as_str() {
        "read_file" => exec_read_file(&call.input, workspace).await,
        "edit_file" => exec_edit_file(&call.input, workspace).await,
        "write_file" => exec_write_file(&call.input, workspace).await,
        "list_dir" => exec_list_dir(&call.input, workspace).await,
        "grep" => exec_grep(&call.input, workspace).await,
        "glob" => exec_glob(&call.input, workspace).await,
        "run_command" => exec_run_command(&call.input, workspace).await,
        // Unreachable: Disposition::Deny upstream short-circuits any
        // unknown tool before we get here. Kept as a defence-in-depth
        // catch in case the catalog grows out of step with disposition.
        other => Err(anyhow!(
            "tool `{other}` reached executor without a match arm"
        )),
    };

    match outcome {
        Ok(content) => make_result(content, false),
        Err(e) => make_result(format!("Tool error: {e}"), true),
    }
}

// ----- per-tool implementations ---------------------------------------

async fn exec_read_file(input: &Value, ws: &Workspace) -> Result<String> {
    let path = input
        .get("path")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow!("missing `path`"))?;
    let offset = input.get("offset").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
    let limit = input.get("limit").and_then(|v| v.as_u64()).unwrap_or(2000) as usize;

    let resolved = ws.resolve(path)?;
    let bytes = tokio::fs::read(&resolved)
        .await
        .map_err(|e| anyhow!("read {}: {e}", resolved.display()))?;
    let text = String::from_utf8_lossy(&bytes);

    let lines: Vec<&str> = text.lines().collect();
    let total = lines.len();
    let start = offset.min(total);
    let end = (start.saturating_add(limit)).min(total);
    let slice = &lines[start..end];

    // Prefix each line with its 1-indexed number so subsequent edit_file
    // calls can refer back unambiguously when picking old_string.
    let mut out = String::with_capacity(bytes.len() + slice.len() * 8);
    for (i, line) in slice.iter().enumerate() {
        let lineno = start + i + 1;
        out.push_str(&format!("{lineno:>6}\t{line}\n"));
    }
    if end < total {
        out.push_str(&format!(
            "\n[truncated: showing lines {}–{} of {}; pass offset+limit to read more]\n",
            start + 1,
            end,
            total
        ));
    }
    if total == 0 {
        out.push_str("(empty file)\n");
    }
    Ok(out)
}

async fn exec_edit_file(input: &Value, ws: &Workspace) -> Result<String> {
    let path = input
        .get("path")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow!("missing `path`"))?;
    let old_string = input
        .get("old_string")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow!("missing `old_string`"))?;
    let new_string = input
        .get("new_string")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow!("missing `new_string`"))?;
    let replace_all = input
        .get("replace_all")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let resolved = ws.resolve(path)?;
    let content = tokio::fs::read_to_string(&resolved)
        .await
        .map_err(|e| anyhow!("read {}: {e}", resolved.display()))?;

    let count = content.matches(old_string).count();
    if count == 0 {
        return Err(anyhow!("`old_string` not found in {}", path));
    }
    if count > 1 && !replace_all {
        return Err(anyhow!(
            "`old_string` appears {count} times in {}; pass replace_all=true or add more surrounding context to disambiguate",
            path
        ));
    }
    let new_content = if replace_all {
        content.replace(old_string, new_string)
    } else {
        // Single match: replacen(_, _, 1) == replace(_, _).
        content.replacen(old_string, new_string, 1)
    };
    tokio::fs::write(&resolved, &new_content)
        .await
        .map_err(|e| anyhow!("write {}: {e}", resolved.display()))?;
    let replacements = if replace_all { count } else { 1 };
    Ok(format!(
        "edited {} ({replacements} replacement{})",
        path,
        if replacements == 1 { "" } else { "s" }
    ))
}

async fn exec_write_file(input: &Value, ws: &Workspace) -> Result<String> {
    let path = input
        .get("path")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow!("missing `path`"))?;
    let content = input
        .get("content")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow!("missing `content`"))?;

    let resolved = ws.resolve(path)?;
    if let Some(parent) = resolved.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| anyhow!("mkdir -p {}: {e}", parent.display()))?;
    }
    tokio::fs::write(&resolved, content)
        .await
        .map_err(|e| anyhow!("write {}: {e}", resolved.display()))?;
    Ok(format!("wrote {} ({} bytes)", path, content.len()))
}

async fn exec_list_dir(input: &Value, ws: &Workspace) -> Result<String> {
    let path = input.get("path").and_then(|v| v.as_str()).unwrap_or(".");
    let include_hidden = input
        .get("include_hidden")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let resolved = ws.resolve(path)?;
    let mut entries = tokio::fs::read_dir(&resolved)
        .await
        .map_err(|e| anyhow!("read_dir {}: {e}", resolved.display()))?;

    let mut items: Vec<(String, bool)> = Vec::new();
    while let Some(entry) = entries
        .next_entry()
        .await
        .map_err(|e| anyhow!("next_entry: {e}"))?
    {
        let name = entry.file_name().to_string_lossy().to_string();
        if !include_hidden && name.starts_with('.') {
            continue;
        }
        let is_dir = entry
            .file_type()
            .await
            .map(|ft| ft.is_dir())
            .unwrap_or(false);
        items.push((name, is_dir));
    }
    // Dirs first, then files, both alphabetical — readable for the model
    // and predictable for snapshot-style tests.
    items.sort_by(|a, b| match (a.1, b.1) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.0.cmp(&b.0),
    });

    if items.is_empty() {
        return Ok(format!("(empty: {path})"));
    }
    let mut out = String::with_capacity(items.len() * 16);
    for (name, is_dir) in items {
        out.push_str(&name);
        if is_dir {
            out.push('/');
        }
        out.push('\n');
    }
    Ok(out)
}

async fn exec_grep(input: &Value, ws: &Workspace) -> Result<String> {
    let pattern = input
        .get("pattern")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow!("missing `pattern`"))?;
    let path = input.get("path").and_then(|v| v.as_str()).unwrap_or(".");
    let glob_pattern = input.get("glob").and_then(|v| v.as_str());

    let resolved_root = ws.resolve(path)?;
    let re = regex::Regex::new(pattern).map_err(|e| anyhow!("invalid regex `{pattern}`: {e}"))?;
    let glob_matcher = glob_pattern
        .map(|g| glob::Pattern::new(g).map_err(|e| anyhow!("invalid glob `{g}`: {e}")))
        .transpose()?;

    // Walk synchronously on a blocking thread — walkdir is sync and the
    // I/O might be heavy on large trees.
    let ws_root = ws.root().to_path_buf();
    let result = tokio::task::spawn_blocking(move || -> Result<String> {
        let mut matches: Vec<String> = Vec::new();
        let mut visited = 0usize;
        const MAX_MATCHES: usize = 100;
        const MAX_FILES: usize = 5000;

        for entry in walkdir::WalkDir::new(&resolved_root)
            .follow_links(false)
            .into_iter()
            .filter_entry(|e| !is_noise_dir(e))
            .filter_map(Result::ok)
        {
            if !entry.file_type().is_file() {
                continue;
            }
            if let Some(m) = &glob_matcher {
                let rel = entry.path().strip_prefix(&ws_root).unwrap_or(entry.path());
                if !m.matches(&rel.to_string_lossy()) {
                    continue;
                }
            }
            visited += 1;
            if visited > MAX_FILES {
                matches.push(format!("[stopped after scanning {MAX_FILES} files]"));
                break;
            }
            let Ok(content) = std::fs::read_to_string(entry.path()) else {
                continue; // Binary or unreadable — skip silently.
            };
            for (lineno, line) in content.lines().enumerate() {
                if re.is_match(line) {
                    let rel = entry.path().strip_prefix(&ws_root).unwrap_or(entry.path());
                    matches.push(format!("{}:{}: {}", rel.display(), lineno + 1, line));
                    if matches.len() >= MAX_MATCHES {
                        break;
                    }
                }
            }
            if matches.len() >= MAX_MATCHES {
                matches.push(format!("[truncated at {MAX_MATCHES} matches]"));
                break;
            }
        }
        if matches.is_empty() {
            Ok("(no matches)".into())
        } else {
            Ok(matches.join("\n"))
        }
    })
    .await
    .map_err(|e| anyhow!("grep task panicked: {e}"))??;
    Ok(result)
}

async fn exec_glob(input: &Value, ws: &Workspace) -> Result<String> {
    let pattern = input
        .get("pattern")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow!("missing `pattern`"))?;
    let ws_root = ws.root().to_path_buf();
    let pat = glob::Pattern::new(pattern).map_err(|e| anyhow!("invalid glob `{pattern}`: {e}"))?;

    let result = tokio::task::spawn_blocking(move || -> Result<String> {
        let mut hits: Vec<(std::time::SystemTime, std::path::PathBuf)> = Vec::new();
        const MAX_HITS: usize = 100;

        for entry in walkdir::WalkDir::new(&ws_root)
            .follow_links(false)
            .into_iter()
            .filter_entry(|e| !is_noise_dir(e))
            .filter_map(Result::ok)
        {
            if !entry.file_type().is_file() {
                continue;
            }
            let rel = entry.path().strip_prefix(&ws_root).unwrap_or(entry.path());
            if !pat.matches(&rel.to_string_lossy()) {
                continue;
            }
            let mtime = entry
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .unwrap_or(std::time::UNIX_EPOCH);
            hits.push((mtime, entry.path().to_path_buf()));
        }
        hits.sort_by_key(|h| std::cmp::Reverse(h.0)); // newest first
        let truncated = hits.len() > MAX_HITS;
        hits.truncate(MAX_HITS);

        if hits.is_empty() {
            return Ok("(no matches)".into());
        }
        let mut out = String::with_capacity(hits.len() * 64);
        for (_, p) in &hits {
            let rel = p.strip_prefix(&ws_root).unwrap_or(p);
            out.push_str(&rel.to_string_lossy());
            out.push('\n');
        }
        if truncated {
            out.push_str(&format!("[truncated at {MAX_HITS} matches]\n"));
        }
        Ok(out)
    })
    .await
    .map_err(|e| anyhow!("glob task panicked: {e}"))??;
    Ok(result)
}

async fn exec_run_command(input: &Value, ws: &Workspace) -> Result<String> {
    let command = input
        .get("command")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow!("missing `command`"))?;
    let cwd_rel = input.get("cwd").and_then(|v| v.as_str()).unwrap_or(".");
    let timeout_secs = input
        .get("timeout_secs")
        .and_then(|v| v.as_u64())
        .unwrap_or(60)
        .clamp(1, 300);

    let cwd = ws.resolve(cwd_rel)?;
    if !cwd.is_dir() {
        return Err(anyhow!("cwd `{}` is not a directory", cwd_rel));
    }

    let mut cmd = if cfg!(windows) {
        let mut c = tokio::process::Command::new("cmd");
        c.args(["/C", command]);
        c
    } else {
        let mut c = tokio::process::Command::new("sh");
        c.args(["-c", command]);
        c
    };
    cmd.current_dir(&cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // Kill the process group on drop (set via tokio's kill_on_drop)
        // so a timed-out child doesn't linger after we move on.
        .kill_on_drop(true);
    // cmd.exe truncates an inherited PATH over 8191 chars, after which not
    // even System32 programs are found; the dev launch chain grows PATH past
    // that. Give the shell the user's canonical PATH. No-op off Windows.
    crate::bridges::apply_clean_path(&mut cmd);

    let child = cmd.spawn().map_err(|e| anyhow!("spawn failed: {e}"))?;
    let out = tokio::time::timeout(Duration::from_secs(timeout_secs), child.wait_with_output())
        .await
        .map_err(|_| anyhow!("command timed out after {timeout_secs}s"))?
        .map_err(|e| anyhow!("command failed: {e}"))?;

    let mut s = String::new();
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    if !stdout.is_empty() {
        s.push_str("stdout:\n");
        s.push_str(&stdout);
        if !stdout.ends_with('\n') {
            s.push('\n');
        }
    }
    if !stderr.is_empty() {
        s.push_str("stderr:\n");
        s.push_str(&stderr);
        if !stderr.ends_with('\n') {
            s.push('\n');
        }
    }
    s.push_str(&format!(
        "exit code: {}\n",
        out.status
            .code()
            .map(|c| c.to_string())
            .unwrap_or_else(|| "(signal)".into())
    ));
    Ok(s)
}

/// Centralised noise-dir filter for grep + glob walks. Skipping these
/// avoids drowning the model in dependency / build / vcs files and keeps
/// scans fast on large repos. If a tool genuinely needs to see e.g.
/// `node_modules`, the user can pass an explicit `path` under it.
fn is_noise_dir(entry: &walkdir::DirEntry) -> bool {
    if !entry.file_type().is_dir() {
        return false;
    }
    let name = entry.file_name().to_string_lossy();
    matches!(
        name.as_ref(),
        ".git" | "node_modules" | "target" | ".venv" | "__pycache__" | ".next" | "dist" | "build"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agentic::permissions::StaticGate;
    use tempfile::tempdir;

    fn call(name: &str, input: serde_json::Value) -> ToolCall {
        ToolCall {
            id: "tc-1".into(),
            name: name.into(),
            input,
        }
    }

    /// Convenience wrapper: every test that doesn't care about the gate
    /// passes `StaticGate(true)` so Mode-allowed AND Mode-Ask both
    /// proceed. Tests that exercise the Ask + Deny path use the explicit
    /// `execute(...)` call with their own `StaticGate(false)`.
    async fn ex(call: &ToolCall, ws: &Workspace, mode: Mode) -> ToolResult {
        execute(call, ws, mode, &StaticGate(true)).await
    }

    #[tokio::test]
    async fn chat_mode_write_blocked_when_gate_denies() {
        // Mode::Chat asks for write; gate=StaticGate(false) refuses.
        // No filesystem mutation; clear error in the tool_result.
        let dir = tempdir().unwrap();
        let ws = Workspace::new(dir.path()).unwrap();
        let r = execute(
            &call(
                "write_file",
                serde_json::json!({"path": "x.txt", "content": "x"}),
            ),
            &ws,
            Mode::Chat,
            &StaticGate(false),
        )
        .await;
        assert!(r.is_error);
        assert!(r.content.contains("denied permission"));
        assert!(
            !dir.path().join("x.txt").exists(),
            "deny must not write to disk"
        );
    }

    #[tokio::test]
    async fn chat_mode_write_succeeds_when_gate_approves() {
        // Same Mode::Chat + write_file, but gate=StaticGate(true) — the
        // user clicked Approve in the dialog. File lands.
        let dir = tempdir().unwrap();
        let ws = Workspace::new(dir.path()).unwrap();
        let r = execute(
            &call(
                "write_file",
                serde_json::json!({"path": "x.txt", "content": "x"}),
            ),
            &ws,
            Mode::Chat,
            &StaticGate(true),
        )
        .await;
        assert!(!r.is_error, "got: {}", r.content);
        assert_eq!(
            std::fs::read_to_string(dir.path().join("x.txt")).unwrap(),
            "x"
        );
    }

    #[tokio::test]
    async fn read_file_returns_numbered_lines_within_offset_limit() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("a.txt");
        std::fs::write(&path, "line1\nline2\nline3\nline4\n").unwrap();
        let ws = Workspace::new(dir.path()).unwrap();

        let r = ex(
            &call(
                "read_file",
                serde_json::json!({"path": "a.txt", "offset": 1, "limit": 2}),
            ),
            &ws,
            Mode::Autonomous,
        )
        .await;
        assert!(!r.is_error, "got: {}", r.content);
        assert!(r.content.contains("line2"));
        assert!(r.content.contains("line3"));
        assert!(!r.content.contains("line1"));
        assert!(r.content.contains("truncated"), "expected truncation note");
    }

    #[tokio::test]
    async fn edit_file_unique_match_succeeds_ambiguous_fails() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("a.txt");
        std::fs::write(&path, "foo bar foo\n").unwrap();
        let ws = Workspace::new(dir.path()).unwrap();

        // Two "foo" → ambiguous without replace_all.
        let r = ex(
            &call(
                "edit_file",
                serde_json::json!({"path": "a.txt", "old_string": "foo", "new_string": "baz"}),
            ),
            &ws,
            Mode::Autonomous,
        )
        .await;
        assert!(r.is_error);
        assert!(r.content.contains("appears 2 times"));

        // replace_all=true rewrites every match.
        let r = ex(
            &call(
                "edit_file",
                serde_json::json!({
                    "path": "a.txt",
                    "old_string": "foo",
                    "new_string": "baz",
                    "replace_all": true,
                }),
            ),
            &ws,
            Mode::Autonomous,
        )
        .await;
        assert!(!r.is_error);
        let content = std::fs::read_to_string(&path).unwrap();
        assert_eq!(content, "baz bar baz\n");
    }

    #[tokio::test]
    async fn write_file_creates_parent_dirs() {
        let dir = tempdir().unwrap();
        let ws = Workspace::new(dir.path()).unwrap();
        let r = ex(
            &call(
                "write_file",
                serde_json::json!({"path": "a/b/c.txt", "content": "hi"}),
            ),
            &ws,
            Mode::Autonomous,
        )
        .await;
        assert!(!r.is_error);
        let content = std::fs::read_to_string(dir.path().join("a/b/c.txt")).unwrap();
        assert_eq!(content, "hi");
    }

    #[tokio::test]
    async fn list_dir_excludes_hidden_by_default_sorts_dirs_first() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join("visible.txt"), "").unwrap();
        std::fs::write(dir.path().join(".secret"), "").unwrap();
        std::fs::create_dir(dir.path().join("sub")).unwrap();
        let ws = Workspace::new(dir.path()).unwrap();
        let r = ex(
            &call("list_dir", serde_json::json!({})),
            &ws,
            Mode::Autonomous,
        )
        .await;
        assert!(!r.is_error);
        assert!(r.content.contains("visible.txt"));
        assert!(r.content.contains("sub/"));
        assert!(!r.content.contains(".secret"));
        // Dirs-first invariant: "sub/" comes before "visible.txt".
        let sub_idx = r.content.find("sub/").unwrap();
        let vis_idx = r.content.find("visible.txt").unwrap();
        assert!(sub_idx < vis_idx);
    }

    #[tokio::test]
    async fn grep_finds_pattern_with_relative_paths_and_line_numbers() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), "alpha\nbeta\nalpha2\n").unwrap();
        std::fs::write(dir.path().join("b.txt"), "no match here\n").unwrap();
        let ws = Workspace::new(dir.path()).unwrap();
        let r = ex(
            &call("grep", serde_json::json!({"pattern": "alpha"})),
            &ws,
            Mode::Autonomous,
        )
        .await;
        assert!(!r.is_error);
        assert!(r.content.contains("a.txt:1:"));
        assert!(r.content.contains("a.txt:3:"));
        assert!(!r.content.contains("b.txt"));
    }

    #[tokio::test]
    async fn grep_filters_by_glob() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join("a.rs"), "needle\n").unwrap();
        std::fs::write(dir.path().join("a.txt"), "needle\n").unwrap();
        let ws = Workspace::new(dir.path()).unwrap();
        let r = ex(
            &call(
                "grep",
                serde_json::json!({"pattern": "needle", "glob": "*.rs"}),
            ),
            &ws,
            Mode::Autonomous,
        )
        .await;
        assert!(!r.is_error);
        assert!(r.content.contains("a.rs"));
        assert!(!r.content.contains("a.txt"));
    }

    #[tokio::test]
    async fn glob_finds_files_by_pattern() {
        let dir = tempdir().unwrap();
        std::fs::create_dir(dir.path().join("src")).unwrap();
        std::fs::write(dir.path().join("src/a.rs"), "").unwrap();
        std::fs::write(dir.path().join("src/b.ts"), "").unwrap();
        let ws = Workspace::new(dir.path()).unwrap();
        let r = ex(
            &call("glob", serde_json::json!({"pattern": "**/*.rs"})),
            &ws,
            Mode::Autonomous,
        )
        .await;
        assert!(!r.is_error);
        assert!(r.content.contains("a.rs"));
        assert!(!r.content.contains("b.ts"));
    }

    #[tokio::test]
    async fn run_command_echo_returns_stdout_and_exit_code() {
        let dir = tempdir().unwrap();
        let ws = Workspace::new(dir.path()).unwrap();
        let r = ex(
            &call("run_command", serde_json::json!({"command": "echo hello"})),
            &ws,
            Mode::Autonomous,
        )
        .await;
        assert!(!r.is_error, "got: {}", r.content);
        assert!(r.content.contains("hello"));
        assert!(r.content.contains("exit code: 0"));
    }

    #[tokio::test]
    async fn run_command_times_out_cleanly() {
        let dir = tempdir().unwrap();
        let ws = Workspace::new(dir.path()).unwrap();
        let cmd = if cfg!(windows) {
            // `ping -n N` waits N-1 seconds; 30 pings = 29s wall. Plenty
            // to exceed our 1s timeout. Named by full path: cmd.exe
            // truncates a long PATH (the next test covers that), and the
            // full path keeps this test about the timeout alone.
            r"%SystemRoot%\System32\ping.exe -n 30 127.0.0.1 >NUL"
        } else {
            "sleep 30"
        };
        let r = ex(
            &call(
                "run_command",
                serde_json::json!({"command": cmd, "timeout_secs": 1}),
            ),
            &ws,
            Mode::Autonomous,
        )
        .await;
        assert!(r.is_error, "expected timeout error, got: {}", r.content);
        assert!(r.content.contains("timed out"));
    }

    #[cfg(windows)]
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn run_command_finds_programs_when_inherited_path_is_too_long() {
        // cmd.exe truncates a PATH over 8191 chars, and then even System32
        // programs are "not recognized". The dev launch chain grows PATH
        // past that, so run_command must not hand the shell the inherited one.
        //
        // PATH is process-wide: hold the env lock across the run, and put
        // the original back on the way out, even if an assertion fails.
        let _g = crate::test_support::home_lock()
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        struct RestorePath(Option<std::ffi::OsString>);
        impl Drop for RestorePath {
            fn drop(&mut self) {
                match self.0.take() {
                    Some(path) => std::env::set_var("PATH", path),
                    None => std::env::remove_var("PATH"),
                }
            }
        }
        let original = std::env::var_os("PATH");
        let _restore = RestorePath(original.clone());

        // Junk entries alone go past the limit; the real PATH follows them.
        let mut long = std::ffi::OsString::new();
        let mut i = 0;
        while long.len() <= 8191 {
            long.push(format!(r"C:\fleetify-test-path-padding\{i:04};"));
            i += 1;
        }
        if let Some(path) = &original {
            long.push(path);
        }
        std::env::set_var("PATH", &long);

        let dir = tempdir().unwrap();
        let ws = Workspace::new(dir.path()).unwrap();
        let r = ex(
            &call("run_command", serde_json::json!({"command": "where cmd"})),
            &ws,
            Mode::Autonomous,
        )
        .await;
        assert!(!r.is_error, "got: {}", r.content);
        assert!(r.content.contains("exit code: 0"), "got: {}", r.content);
        assert!(
            r.content.to_ascii_lowercase().contains("cmd.exe"),
            "got: {}",
            r.content
        );
    }

    #[tokio::test]
    async fn unknown_tool_returns_clear_error() {
        let dir = tempdir().unwrap();
        let ws = Workspace::new(dir.path()).unwrap();
        let r = ex(
            &call("frobnicate", serde_json::json!({})),
            &ws,
            Mode::Autonomous,
        )
        .await;
        assert!(r.is_error);
        assert!(r.content.contains("not in the catalog"));
    }

    #[tokio::test]
    async fn path_escape_attempt_is_rejected() {
        let dir = tempdir().unwrap();
        std::fs::create_dir(dir.path().join("inner")).unwrap();
        let ws = Workspace::new(dir.path().join("inner")).unwrap();
        let r = ex(
            &call(
                "read_file",
                serde_json::json!({"path": "../../../etc/passwd"}),
            ),
            &ws,
            Mode::Autonomous,
        )
        .await;
        assert!(r.is_error);
    }

    #[tokio::test]
    async fn grep_skips_noise_dirs() {
        let dir = tempdir().unwrap();
        std::fs::create_dir(dir.path().join("node_modules")).unwrap();
        std::fs::write(dir.path().join("node_modules/x.js"), "needle\n").unwrap();
        std::fs::write(dir.path().join("ok.txt"), "needle\n").unwrap();
        let ws = Workspace::new(dir.path()).unwrap();
        let r = ex(
            &call("grep", serde_json::json!({"pattern": "needle"})),
            &ws,
            Mode::Autonomous,
        )
        .await;
        assert!(!r.is_error);
        assert!(r.content.contains("ok.txt"));
        assert!(!r.content.contains("node_modules"));
    }
}
