//! AI-driven git helpers = the Electron `git:generateCommitMessage`,
//! `git:generatePRSummary`, and `git:reviewDiff` handlers.
//!
//! Each spawns the session's CLI in one-shot mode (`claude --print`,
//! `codex exec --quiet`, `gemini --prompt-stdin`) with the prompt on
//! stdin and captures the stdout. No persistent session, no bridge —
//! these are renderer-driven one-shots used by the Quick Commit and
//! Create PR pipelines (and pre-PR Review dialog).
//!
//! Faithful with main.cjs: same prompts, same diff-prep, same parsing,
//! same truncation thresholds (30 kB commit diff, 60 kB PR diff,
//! 50/20 kB committed/working review diffs).

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{json, Value};

use crate::shell::git;

const CLAUDE: (&str, &[&str]) = ("claude", &["--print"]);
const CODEX: (&str, &[&str]) = ("codex", &["exec", "--quiet"]);
const GEMINI: (&str, &[&str]) = ("gemini", &["--prompt-stdin"]);

fn cli_for(tool: Option<&str>) -> (&'static str, &'static [&'static str]) {
    match tool.unwrap_or("claude") {
        "codex" => CODEX,
        "gemini" => GEMINI,
        _ => CLAUDE, // unknown → claude (parity with the Electron fallback)
    }
}

/// CLIs to try when the chosen tool's binary isn't on PATH. Order is
/// "most likely to be installed in a Fleetify dev environment" first,
/// then the others. We skip the originally-requested tool because the
/// caller already discovered it's missing.
fn cli_fallback_chain(skip: &str) -> Vec<(&'static str, &'static [&'static str])> {
    [CLAUDE, CODEX, GEMINI]
        .into_iter()
        .filter(|(bin, _)| *bin != skip)
        .collect()
}

/// Cheap PATH probe via `which` (Unix) / `where` (Windows). Used to
/// detect "binary missing" without paying the spawn cost.
async fn binary_on_path(bin: &str) -> bool {
    let probe_cmd = if cfg!(windows) { "where" } else { "which" };
    let out = tokio::process::Command::new(probe_cmd)
        .arg(bin)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .await;
    matches!(out, Ok(s) if s.success())
}

/// `(ok, cli, out, err)`. Mirrors `runSessionCli` — stdout/stderr
/// captured, soft-killed on timeout, non-zero exit treated as failure.
///
/// If the requested tool's binary isn't on PATH, transparently falls
/// back through the remaining CLIs in `cli_fallback_chain` order so a
/// user with only `claude` installed still gets a working AI summary
/// when their session was created with `tool: "gemini"`.
async fn run_session_cli(
    folder: &str,
    tool: Option<&str>,
    prompt: &str,
    timeout: Duration,
) -> (bool, String, String, String) {
    let (bin, args) = cli_for(tool);
    if !binary_on_path(bin).await {
        tracing::info!(
            target: "fleetify.ai_git",
            "{bin} not on PATH — trying fallback CLIs"
        );
        for (alt_bin, alt_args) in cli_fallback_chain(bin) {
            if binary_on_path(alt_bin).await {
                tracing::info!(
                    target: "fleetify.ai_git",
                    "falling back from {bin} to {alt_bin}"
                );
                return spawn_session_cli(folder, alt_bin, alt_args, prompt, timeout).await;
            }
        }
        return (
            false,
            bin.to_string(),
            String::new(),
            format!("{bin} not on PATH — install claude/codex/gemini CLI to enable AI summaries"),
        );
    }
    spawn_session_cli(folder, bin, args, prompt, timeout).await
}

async fn spawn_session_cli(
    folder: &str,
    bin: &str,
    args: &[&str],
    prompt: &str,
    timeout: Duration,
) -> (bool, String, String, String) {
    let mut cmd = tokio::process::Command::new(bin);
    cmd.args(args)
        .current_dir(folder)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return (false, bin.to_string(), String::new(), format!("{bin}: {e}")),
    };
    // Write the prompt and close stdin so the CLI sees EOF.
    if let Some(mut stdin) = child.stdin.take() {
        use tokio::io::AsyncWriteExt;
        let _ = stdin.write_all(prompt.as_bytes()).await;
        let _ = stdin.flush().await;
        drop(stdin);
    }
    let wait_with_output = child.wait_with_output();
    let out = match tokio::time::timeout(timeout, wait_with_output).await {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => {
            return (false, bin.to_string(), String::new(), e.to_string());
        }
        Err(_) => {
            return (
                false,
                bin.to_string(),
                String::new(),
                format!("{bin} timed out"),
            );
        }
    };
    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&out.stderr).to_string();
    if !out.status.success() {
        let code = out.status.code().unwrap_or(-1);
        let err = if stderr.is_empty() {
            format!("{bin} exited {code}")
        } else {
            stderr
        };
        return (false, bin.to_string(), String::new(), err);
    }
    (true, bin.to_string(), stdout, String::new())
}

async fn git_out(folder: &Path, args: &[&str], timeout: Duration) -> (bool, String) {
    let (rc, out, _) = git::run("git", args, folder, timeout).await;
    (rc == 0, out)
}

// ── generateCommitMessage ───────────────────────────────────────
pub async fn generate_commit_message(
    folder: String,
    tool: Option<String>,
    is_initial: bool,
) -> Value {
    let path = PathBuf::from(&folder);
    let context = if is_initial {
        let (ls_ok, ls_out) =
            git_out(&path, &["ls-files", "--cached"], Duration::from_secs(5)).await;
        let (st_ok, st_out) = git_out(
            &path,
            &["diff", "--cached", "--shortstat"],
            Duration::from_secs(5),
        )
        .await;
        let files = if ls_ok {
            ls_out.lines().take(80).collect::<Vec<_>>().join("\n")
        } else {
            String::new()
        };
        let files_block = if files.is_empty() {
            "(empty)".to_string()
        } else {
            files
        };
        format!(
            "# Files in initial commit\n{files_block}\n\n# Shortstat\n{}",
            if st_ok { st_out } else { String::new() }
        )
    } else {
        let (st_ok, st_out) =
            git_out(&path, &["diff", "--shortstat"], Duration::from_secs(5)).await;
        let (fl_ok, fl_out) =
            git_out(&path, &["diff", "--name-status"], Duration::from_secs(5)).await;
        let (df_ok, df_out) =
            git_out(&path, &["diff", "--unified=2"], Duration::from_secs(8)).await;
        let truncated = if df_ok && df_out.len() > 30_000 {
            format!("{}\n…[truncated]", &df_out[..30_000])
        } else if df_ok {
            df_out
        } else {
            String::new()
        };
        format!(
            "# Shortstat\n{}\n\n# Files\n{}\n\n# Diff\n{truncated}",
            if st_ok { st_out } else { String::new() },
            if fl_ok { fl_out } else { String::new() },
        )
    };

    let prompt = format!(
        "You are writing a git commit message. Read the context below and emit a SINGLE LINE message (≤72 characters, imperative voice, no trailing period, no quotes, no Markdown). Focus on WHAT changed and WHY. Output ONLY the message text — no preamble, no explanation.\n\n{context}\n"
    );

    let (ok, cli, out, err) =
        run_session_cli(&folder, tool.as_deref(), &prompt, Duration::from_secs(20)).await;
    if !ok {
        return json!({ "ok": false, "error": err });
    }
    // First non-empty trimmed line, strip wrapping quotes, truncate to 72.
    let mut message: String = out
        .split('\n')
        .map(|s| s.trim().to_string())
        .find(|s| !s.is_empty())
        .unwrap_or_default();
    while message.starts_with('"') || message.starts_with('\'') || message.starts_with('`') {
        message.remove(0);
    }
    while message.ends_with('"') || message.ends_with('\'') || message.ends_with('`') {
        message.pop();
    }
    if message.len() > 72 {
        message.truncate(72);
    }
    if message.is_empty() {
        return json!({ "ok": false, "error": format!("{cli} returned an empty message") });
    }
    json!({ "ok": true, "message": message })
}

// ── generatePRSummary ───────────────────────────────────────────
pub async fn generate_pr_summary(
    folder: String,
    base_branch: Option<String>,
    tool: Option<String>,
) -> Value {
    let base = base_branch.unwrap_or_else(|| "main".to_string());
    let path = PathBuf::from(&folder);
    let range_dot3 = format!("{base}...HEAD");
    let range_dot2 = format!("{base}..HEAD");

    let (files_ok, files_out) = git_out(
        &path,
        &["diff", "--name-status", &range_dot3],
        Duration::from_secs(5),
    )
    .await;
    let (log_ok, log_out) = git_out(
        &path,
        &["log", "--oneline", "--no-decorate", &range_dot2],
        Duration::from_secs(5),
    )
    .await;
    let (stat_ok, stat_out) = git_out(
        &path,
        &["diff", "--shortstat", &range_dot3],
        Duration::from_secs(5),
    )
    .await;
    let (diff_ok, diff_out) = git_out(
        &path,
        &["diff", "--unified=2", &range_dot3],
        Duration::from_secs(8),
    )
    .await;
    if !files_ok || !log_ok {
        return json!({ "ok": false, "error": "couldn't read diff" });
    }
    let diff = if diff_ok { diff_out } else { String::new() };
    let truncated = if diff.len() > 60_000 {
        format!("{}\n…[truncated]", &diff[..60_000])
    } else {
        diff
    };

    let prompt = format!(
        "You are drafting a GitHub pull request. Read the diff below and emit STRICT JSON with two keys:\n\
- \"title\": ≤72 characters, imperative voice, no trailing period\n\
- \"body\":  Markdown. Lead with a 1-2 sentence summary of what changed and why. Then a \"## Changes\" section with 3–6 bullet points grouping related edits. Do not list every file. End with \"## Test plan\" listing what should be verified, as a bulleted checklist of TODOs.\n\n\
Output ONLY the JSON object, no prose around it, no code fence.\n\n\
# Commits since {base}\n{}\n\n\
# Shortstat\n{}\n\n\
# Files\n{}\n\n\
# Diff\n{truncated}\n",
        if log_out.is_empty() { "(no commits)".to_string() } else { log_out },
        if stat_ok { stat_out } else { String::new() },
        if files_out.is_empty() { "(no files)".to_string() } else { files_out },
    );

    let (ok, cli, raw, err) =
        run_session_cli(&folder, tool.as_deref(), &prompt, Duration::from_secs(25)).await;
    if !ok {
        return json!({ "ok": false, "error": err });
    }

    // Strip ```json ... ``` fence if present, then extract the first
    // balanced {...} block in case the model wrapped chatter around it.
    let mut s = raw;
    if let Some(start) = s.find("```") {
        if let Some(rel_end) = s[start + 3..].find("```") {
            let mut inner = &s[start + 3..start + 3 + rel_end];
            // Drop a leading "json\n" tag if present.
            if let Some(stripped) = inner.strip_prefix("json") {
                inner = stripped.trim_start_matches(['\n', '\r', ' ']);
            } else if let Some(stripped) = inner.strip_prefix("JSON") {
                inner = stripped.trim_start_matches(['\n', '\r', ' ']);
            }
            s = inner.trim().to_string();
        }
    }
    if let (Some(obj_start), Some(obj_end)) = (s.find('{'), s.rfind('}')) {
        if obj_end > obj_start {
            s = s[obj_start..=obj_end].to_string();
        }
    }
    let parsed: Result<Value, _> = serde_json::from_str(&s);
    if let Ok(v) = parsed {
        let title = v.get("title").and_then(|x| x.as_str()).unwrap_or("");
        let body = v.get("body").and_then(|x| x.as_str()).unwrap_or("");
        if !title.is_empty() && !body.is_empty() {
            let t = if title.chars().count() > 72 {
                title.chars().take(72).collect::<String>()
            } else {
                title.to_string()
            };
            return json!({ "ok": true, "title": t, "body": body });
        }
    }
    json!({ "ok": false, "error": format!("{cli} output wasn't valid JSON") })
}

// ── reviewDiff ──────────────────────────────────────────────────
pub async fn review_diff(
    folder: String,
    base_branch: Option<String>,
    tool: Option<String>,
) -> Value {
    let base = base_branch.unwrap_or_else(|| "main".to_string());
    let path = PathBuf::from(&folder);
    let range = format!("{base}...HEAD");

    let (cf_ok, cf_out) = git_out(
        &path,
        &["diff", "--name-status", &range],
        Duration::from_secs(5),
    )
    .await;
    let (cd_ok, cd_out) = git_out(
        &path,
        &["diff", "--unified=3", &range],
        Duration::from_secs(8),
    )
    .await;
    let (wd_ok, wd_out) = git_out(&path, &["diff", "--unified=3"], Duration::from_secs(8)).await;
    let (st_ok, st_out) = git_out(
        &path,
        &["diff", "--shortstat", &range],
        Duration::from_secs(5),
    )
    .await;

    let committed = if cd_ok { cd_out } else { String::new() };
    let working = if wd_ok { wd_out } else { String::new() };
    let trunc_committed = if committed.len() > 50_000 {
        format!("{}\n…[truncated]", &committed[..50_000])
    } else {
        committed.clone()
    };
    let trunc_working = if working.len() > 20_000 {
        format!("{}\n…[truncated]", &working[..20_000])
    } else {
        working.clone()
    };

    if trunc_committed.is_empty() && trunc_working.is_empty() {
        return json!({ "ok": false, "error": format!("No diff to review against {base}.") });
    }

    let prompt = format!(
        "You are doing a code review for a Fleetify session before the user opens a pull request. Read the diff below and produce a focused review in Markdown.\n\n\
Structure:\n\
- Lead with a 1–2 sentence summary of what changed.\n\
- \"## Findings\" — bullet list grouped as **Must fix** / **Should consider** / **Looks good**. Cite file paths + line numbers when relevant. Skip categories that are empty (don't write \"Must fix: none\").\n\
- \"## Tests\" — 1–2 sentences on test coverage and what remains untested.\n\
- Keep it under 400 words total. Be direct; no filler.\n\n\
Do NOT wrap the output in code fences. Output Markdown directly.\n\n\
# Shortstat\n{}\n\n\
# Files\n{}\n\n\
# Committed diff (since {base})\n{}\n\n\
# Working-tree diff (uncommitted)\n{}\n",
        if st_ok { st_out } else { String::new() },
        if cf_ok { cf_out } else { String::new() },
        if trunc_committed.is_empty() { "(no committed changes)".to_string() } else { trunc_committed },
        if trunc_working.is_empty() { "(none)".to_string() } else { trunc_working },
    );

    let (ok, cli, out, err) =
        run_session_cli(&folder, tool.as_deref(), &prompt, Duration::from_secs(35)).await;
    if !ok {
        return json!({ "ok": false, "error": err });
    }
    json!({ "ok": true, "review": out, "cli": cli })
}

// ── diagnoseFailure ──────────────────────────────────────────────
// Recovery verbs the agent is allowed to suggest. Anything outside
// this set is coerced to "manual" downstream. Whitelist applies to
// applyRecovery too (kept in shell::ipc::git_apply_recovery).
pub const RECOVERY_ACTIONS: &[&str] = &[
    "pull-rebase",
    "force-with-lease",
    "set-upstream",
    "custom-command",
    "manual",
];
pub const RECOVERY_BINARIES: &[&str] = &["git", "gh"];

/// Tokens that disqualify a `custom-command` string from auto-apply.
/// We never spawn through a shell, so these can't be interpreted as
/// shell ops at the spawn site — the regex check is here so the user
/// sees a clean rejection upstream of execFile.
pub fn has_shell_meta(s: &str) -> bool {
    // |, ;, &, <, >, `, $, (, ), \, and multi-char compounds.
    if s.contains('|')
        || s.contains(';')
        || s.contains('&')
        || s.contains('<')
        || s.contains('>')
        || s.contains('`')
        || s.contains('$')
        || s.contains('(')
        || s.contains(')')
        || s.contains('\\')
    {
        return true;
    }
    s.contains("&&") || s.contains("||") || s.contains(">>") || s.contains("<<")
}

pub async fn diagnose_failure(
    folder: String,
    error_message: String,
    tool: Option<String>,
    context: Option<String>,
    base_branch: Option<String>,
) -> Value {
    if error_message.trim().is_empty() {
        return json!({ "ok": false, "error": "no error message to diagnose" });
    }
    let base = base_branch.unwrap_or_else(|| "main".to_string());
    let path = PathBuf::from(&folder);
    let (br_ok, br_out) = git_out(
        &path,
        &["rev-parse", "--abbrev-ref", "HEAD"],
        Duration::from_secs(5),
    )
    .await;
    let (st_ok, st_out) = git_out(
        &path,
        &["status", "--porcelain", "-b"],
        Duration::from_secs(5),
    )
    .await;
    let (lg_ok, lg_out) = git_out(
        &path,
        &["log", "--oneline", "--no-decorate", "-n", "5"],
        Duration::from_secs(5),
    )
    .await;
    let (rm_ok, rm_out) = git_out(&path, &["remote", "-v"], Duration::from_secs(5)).await;

    let prompt = format!(
        "You are diagnosing a Git / GitHub failure inside a Fleetify session. Read the error message and the repository state below, then emit STRICT JSON with these keys:\n\n\
- \"summary\":    1-2 sentence diagnosis of what went wrong.\n\
- \"action\":     ONE of: \"pull-rebase\" | \"force-with-lease\" | \"set-upstream\" | \"custom-command\" | \"manual\"\n\
- \"rationale\":  1-2 sentences explaining why the chosen action is the right one.\n\
- \"command\":    The single command the action runs (REQUIRED for \"custom-command\", null for \"manual\"). MUST start with \"git \" or \"gh \" — no other binaries. NO shell pipes, redirects, &&, ||, ;, backticks, $(…). One process invocation only.\n\
- \"risk\":       ONE of: \"low\" | \"medium\" | \"high\"  — your honest estimate of blast radius. Force-pushing is at least \"medium\". History rewrites are \"high\". Pull-rebase on a clean tree is \"low\".\n\n\
Rules:\n\
- Prefer the named verbs when they fit:\n\
  - \"pull-rebase\" → assumes base \"{base}\".\n\
  - \"force-with-lease\" → only when the user clearly intended to overwrite (rebased locally, remote has the pre-rebase commits).\n\
  - \"set-upstream\" → \"no upstream branch\" / \"no remote tracking\" errors.\n\
- \"custom-command\" is the escape hatch when none of the named verbs fit but a single `git` or `gh` invocation would resolve it. Examples: `gh auth refresh`, `git rebase --abort`, `git fetch origin`, `git lfs install`. Always pair it with rationale + an honest risk rating.\n\
- \"manual\" is for cases that need user judgement, multiple steps, or non-git tooling (install a binary, edit a config, contact admin). Set command to null.\n\
- Be honest about risk. Conservative is better. The user sees the EXACT command before approving — no surprises.\n\n\
Output ONLY the JSON object, no prose around it, no code fence.\n\n\
# Context\n{}\n\n\
# Raw error\n{error_message}\n\n\
# Repo state\n\
current branch: {}\n\n\
## git status -sb\n{}\n\n\
## last 5 commits\n{}\n\n\
## remotes\n{}\n",
        context.as_deref().filter(|s| !s.is_empty()).unwrap_or("Create PR failed"),
        if br_ok && !br_out.is_empty() { br_out.clone() } else { "(unknown)".to_string() },
        if st_ok { st_out } else { "(unavailable)".to_string() },
        if lg_ok { lg_out } else { "(unavailable)".to_string() },
        if rm_ok { rm_out } else { "(unavailable)".to_string() },
    );

    let (ok, cli, raw, err) =
        run_session_cli(&folder, tool.as_deref(), &prompt, Duration::from_secs(25)).await;
    if !ok {
        return json!({ "ok": false, "error": err });
    }

    // Same JSON extraction as generate_pr_summary.
    let mut s = raw;
    if let Some(start) = s.find("```") {
        if let Some(rel_end) = s[start + 3..].find("```") {
            let mut inner = &s[start + 3..start + 3 + rel_end];
            for tag in ["json", "JSON"] {
                if let Some(stripped) = inner.strip_prefix(tag) {
                    inner = stripped.trim_start_matches(['\n', '\r', ' ']);
                    break;
                }
            }
            s = inner.trim().to_string();
        }
    }
    if let (Some(obj_start), Some(obj_end)) = (s.find('{'), s.rfind('}')) {
        if obj_end > obj_start {
            s = s[obj_start..=obj_end].to_string();
        }
    }
    let parsed: Value = match serde_json::from_str(&s) {
        Ok(v) => v,
        Err(_) => return json!({ "ok": false, "error": format!("{cli} output wasn't valid JSON") }),
    };
    let summary = match parsed.get("summary").and_then(|v| v.as_str()) {
        Some(s) if !s.is_empty() => s.chars().take(500).collect::<String>(),
        _ => return json!({ "ok": false, "error": format!("{cli} response missing 'summary'") }),
    };
    let requested = parsed
        .get("action")
        .and_then(|v| v.as_str())
        .unwrap_or("manual");
    let mut action = if RECOVERY_ACTIONS.contains(&requested) {
        requested.to_string()
    } else {
        "manual".to_string()
    };
    let mut command: Option<String> = if action == "manual" {
        None
    } else {
        parsed
            .get("command")
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    };
    if action == "custom-command" {
        let first_tok = command
            .as_deref()
            .map(|c| c.split_whitespace().next().unwrap_or(""))
            .unwrap_or("");
        let bin_ok = !first_tok.is_empty() && RECOVERY_BINARIES.contains(&first_tok);
        let valid = bin_ok && !has_shell_meta(command.as_deref().unwrap_or(""));
        if !valid {
            action = "manual".to_string();
            command = None;
        }
    }
    let risk = match parsed.get("risk").and_then(|v| v.as_str()) {
        Some(r @ ("low" | "medium" | "high")) => r.to_string(),
        _ => "medium".to_string(),
    };
    let rationale = parsed
        .get("rationale")
        .and_then(|v| v.as_str())
        .map(|s| s.chars().take(500).collect::<String>())
        .unwrap_or_default();
    json!({
        "ok": true,
        "summary": summary,
        "action": action,
        "rationale": rationale,
        "command": command,
        "risk": risk,
        "cli": cli,
    })
}

/// Tokenise a `custom-command` string the same way the Electron build's
/// tokenizeCommand() does: whitespace splits, double quotes with
/// backslash escapes, single quotes as literals. Used by applyRecovery
/// only — its caller has already ruled out shell-meta.
pub fn tokenize_command(input: &str) -> Vec<String> {
    enum Mode {
        Ws,
        Tok,
        Dq,
        Sq,
    }
    let mut out: Vec<String> = Vec::new();
    let mut buf = String::new();
    let mut mode = Mode::Ws;
    let mut chars = input.chars().peekable();
    while let Some(c) = chars.next() {
        match mode {
            Mode::Ws => {
                if c.is_whitespace() {
                    continue;
                }
                if c == '"' {
                    mode = Mode::Dq;
                    buf.clear();
                    continue;
                }
                if c == '\'' {
                    mode = Mode::Sq;
                    buf.clear();
                    continue;
                }
                mode = Mode::Tok;
                buf.push(c);
            }
            Mode::Tok => {
                if c.is_whitespace() {
                    out.push(std::mem::take(&mut buf));
                    mode = Mode::Ws;
                    continue;
                }
                if c == '"' {
                    mode = Mode::Dq;
                    continue;
                }
                if c == '\'' {
                    mode = Mode::Sq;
                    continue;
                }
                buf.push(c);
            }
            Mode::Dq => {
                if c == '"' {
                    mode = Mode::Tok;
                    continue;
                }
                if c == '\\' {
                    if let Some(next) = chars.next() {
                        buf.push(next);
                    }
                    continue;
                }
                buf.push(c);
            }
            Mode::Sq => {
                if c == '\'' {
                    mode = Mode::Tok;
                    continue;
                }
                buf.push(c);
            }
        }
    }
    if !buf.is_empty() {
        out.push(buf);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cli_for_picks_per_tool() {
        assert_eq!(cli_for(Some("claude")).0, "claude");
        assert_eq!(cli_for(Some("codex")).0, "codex");
        assert_eq!(cli_for(Some("gemini")).0, "gemini");
        // Unknown → claude (parity with Electron fallback).
        assert_eq!(cli_for(Some("does-not-exist")).0, "claude");
        assert_eq!(cli_for(None).0, "claude");
    }

    #[test]
    fn shell_meta_detector_catches_compounds() {
        assert!(has_shell_meta("git status | grep foo"));
        assert!(has_shell_meta("git log; rm -rf /"));
        assert!(has_shell_meta("git rev-parse `whoami`"));
        assert!(has_shell_meta("git log $(echo HEAD)"));
        assert!(has_shell_meta("git log && rm"));
        assert!(has_shell_meta("git push --force-with-lease > out"));
        // Clean commands should pass.
        assert!(!has_shell_meta("git pull --rebase origin main"));
        assert!(!has_shell_meta("gh auth refresh"));
        assert!(!has_shell_meta("git rebase --abort"));
    }

    #[test]
    fn tokenize_command_quoted_strings() {
        assert_eq!(
            tokenize_command("git commit -m \"fix: x\""),
            vec!["git", "commit", "-m", "fix: x"]
        );
        assert_eq!(
            tokenize_command("git commit -m 'literal $var stays'"),
            vec!["git", "commit", "-m", "literal $var stays"]
        );
        assert_eq!(
            tokenize_command("  gh   auth   refresh  "),
            vec!["gh", "auth", "refresh"]
        );
        assert_eq!(
            tokenize_command(r#"git config user.name "Doe, J.""#),
            vec!["git", "config", "user.name", "Doe, J."]
        );
        // Backslash escape inside double quotes.
        assert_eq!(
            tokenize_command(r#"echo "say \"hi\"""#),
            vec!["echo", "say \"hi\""]
        );
    }
}
