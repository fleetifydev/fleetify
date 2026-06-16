//! System prompt builder. Composes a single string the adapter feeds
//! into the provider's "system" slot at the start of a session.
//!
//! What goes in
//! ------------
//!
//! - Identity / tool guidance — short header so the model knows it's
//!   inside a desktop IDE with a workspace and a tool catalog.
//! - `<environment>` block — workspace path, OS, arch, shell. Affects
//!   how the model writes shell commands (`del` vs `rm`, path separators).
//! - `<workspace_tree>` — top-level + one level deep, capped at 200
//!   entries, noise dirs (`.git`, `node_modules`, `target`, `.venv`,
//!   `dist`, `build`, `__pycache__`) skipped. Saves a `list_dir` round
//!   trip on the first turn.
//! - First found of `CLAUDE.md` / `AGENTS.md` / `README.md`, truncated
//!   at 5K chars. These are the project's onboarding docs; giving them
//!   to the model upfront is cheap context that often eliminates 3-5
//!   tool calls per session.
//! - `<git>` block if the workspace is a git repo — current branch +
//!   clean/dirty. Helps the model frame "should I commit" suggestions.
//! - `<tool_usage>` block — concrete tips on when to use which tool.
//!   Models that don't know our catalog default to `read_file` for
//!   everything; the guidance routes them toward grep/glob first.
//!
//! What we deliberately leave OUT
//! ------------------------------
//!
//! - Full file contents (besides the README). The model can read with
//!   `read_file` if it needs to; loading every source file upfront
//!   wastes tokens on files the model never references.
//! - Recent git history. `run_command git log` is one call away if needed.
//! - Open tabs / cursor position. Composer-mode UX (deferred PR).

use std::path::Path;

use super::workspace::Workspace;

const SYSTEM_HEADER: &str = "\
You are an AI coding assistant working inside Fleetify, a desktop IDE. \
You have tools (read_file, edit_file, write_file, list_dir, grep, glob, run_command) \
that operate inside the user's workspace. Stay scoped to the workspace; the sandbox \
rejects paths that escape it.\n\
\n\
Be proactive, not interrogative\n\
- When the user gives a vague request (\"create a sample file\", \"add a README\", \
\"refactor this\"), make reasonable defaults and DO THE WORK. Don't ping-pong \
asking for the filename, the content, or the exact wording. Pick something \
sensible, do it, then summarise what you chose in the reply.\n\
- Only ask follow-up questions when there's a real ambiguity that would change \
the outcome materially (\"do you want this in Python or Rust?\"). \"What should \
I name the file?\" is not that — pick a name.\n\
- If a tool call is denied (permission mode restricts it), say what you would \
have done and offer the user the option to switch modes. Don't pretend you can't \
proceed at all.\n\
- For file edits, prefer surgical `edit_file` over wholesale `write_file`. Use \
`grep` + `glob` to locate code before reading files you don't already know about.\n\
\n";

const README_BUDGET: usize = 5_000;
const TREE_MAX_DEPTH: usize = 2;
const TREE_MAX_ENTRIES: usize = 200;

/// Build the full system prompt for a fresh session against `workspace`.
/// Each section is best-effort: if reading the workspace tree fails or
/// git isn't installed, that section is omitted but the rest still ships.
pub async fn build_system_context(workspace: &Workspace, header: Option<&str>) -> String {
    let mut out = String::with_capacity(8_192);
    let header = header.unwrap_or(SYSTEM_HEADER);
    out.push_str(header);
    if !header.ends_with('\n') {
        out.push_str("\n\n");
    }

    out.push_str("<environment>\n");
    out.push_str(&format!("workspace: {}\n", workspace.root().display()));
    out.push_str(&format!("os: {}\n", std::env::consts::OS));
    out.push_str(&format!("arch: {}\n", std::env::consts::ARCH));
    out.push_str(&format!("shell: {}\n", default_shell()));
    out.push_str("</environment>\n\n");

    // Onboarding docs — first match wins, don't bombard the model.
    for name in ["CLAUDE.md", "AGENTS.md", "README.md"] {
        let path = workspace.root().join(name);
        if let Ok(content) = tokio::fs::read_to_string(&path).await {
            let body = if content.len() > README_BUDGET {
                format!(
                    "{}\n[truncated at {README_BUDGET} chars — use read_file for the full document]",
                    &content[..README_BUDGET]
                )
            } else {
                content
            };
            out.push_str(&format!("<{name}>\n"));
            out.push_str(&body);
            if !out.ends_with('\n') {
                out.push('\n');
            }
            out.push_str(&format!("</{name}>\n\n"));
            break;
        }
    }

    if let Ok(tree) = shallow_tree(workspace.root().to_path_buf()).await {
        out.push_str("<workspace_tree>\n");
        out.push_str(&tree);
        out.push_str("</workspace_tree>\n\n");
    }

    if let Some(git) = git_state(workspace.root()).await {
        out.push_str("<git>\n");
        out.push_str(&git);
        if !git.ends_with('\n') {
            out.push('\n');
        }
        out.push_str("</git>\n\n");
    }

    out.push_str(TOOL_USAGE_GUIDE);
    out
}

const TOOL_USAGE_GUIDE: &str = "<tool_usage>\n\
- Use read_file with offset+limit for files >2000 lines.\n\
- Use edit_file for surgical changes; reserve write_file for full rewrites or new files.\n\
- edit_file's old_string must appear EXACTLY ONCE unless replace_all=true — include surrounding context to disambiguate.\n\
- Use grep / glob before read_file when you don't know where to look.\n\
- run_command runs in the workspace root by default; pass cwd= to scope to a subdir.\n\
- run_command starts a FRESH shell each invocation — `cd subdir` is not preserved \
across calls, `export FOO=bar` doesn't leak to the next call, and `source venv/bin/activate` \
doesn't persist. Chain dependent steps in a single command with `&&` (POSIX) or `;` (cmd), \
or use the `cwd` parameter to scope a single call.\n\
- When write_file / edit_file / run_command is the right call, JUST CALL IT. Do not \
ask the user to confirm filenames or content in advance — that's the user's job to \
decide AFTER seeing your work, not before. The permission system handles consent \
at execution time; your job is to do the work.\n\
</tool_usage>\n";

fn default_shell() -> &'static str {
    if cfg!(windows) {
        "cmd.exe (run_command uses `cmd /C`)"
    } else {
        "sh (run_command uses `sh -c`)"
    }
}

/// Best-effort shallow tree walk. Skips the same noise dirs as grep/glob
/// and hidden entries; capped at TREE_MAX_ENTRIES to keep the prompt
/// bounded on big repos.
async fn shallow_tree(root: std::path::PathBuf) -> anyhow::Result<String> {
    tokio::task::spawn_blocking(move || -> anyhow::Result<String> {
        let mut out = String::new();
        let mut count = 0usize;

        for entry in walkdir::WalkDir::new(&root)
            .max_depth(TREE_MAX_DEPTH)
            .min_depth(1)
            .into_iter()
            .filter_entry(|e| {
                let name = e.file_name().to_string_lossy();
                !name.starts_with('.')
                    && !matches!(
                        name.as_ref(),
                        "node_modules"
                            | "target"
                            | "__pycache__"
                            | ".venv"
                            | "dist"
                            | "build"
                            | ".next"
                    )
            })
            .filter_map(Result::ok)
        {
            let rel = entry.path().strip_prefix(&root).unwrap_or(entry.path());
            if rel.as_os_str().is_empty() {
                continue;
            }
            let depth = rel.components().count();
            let indent = "  ".repeat(depth.saturating_sub(1));
            let name = entry.file_name().to_string_lossy();
            let suffix = if entry.file_type().is_dir() { "/" } else { "" };
            out.push_str(&format!("{indent}{name}{suffix}\n"));
            count += 1;
            if count >= TREE_MAX_ENTRIES {
                out.push_str(&format!(
                    "[...{count}+ entries; listing truncated — use list_dir for subdirs]\n"
                ));
                break;
            }
        }
        Ok(out)
    })
    .await?
}

/// Best-effort git state: branch + dirty/clean. Returns `None` when the
/// workspace isn't a git repo OR when `git` isn't on PATH — both are
/// non-fatal, the system prompt just omits the section.
async fn git_state(root: &Path) -> Option<String> {
    if !root.join(".git").exists() {
        return None;
    }
    let root_str = root.to_string_lossy().to_string();

    let branch_out = tokio::process::Command::new("git")
        .args(["-C", &root_str, "branch", "--show-current"])
        .output()
        .await
        .ok()?;
    if !branch_out.status.success() {
        return None;
    }
    let branch = String::from_utf8_lossy(&branch_out.stdout)
        .trim()
        .to_string();

    let status_out = tokio::process::Command::new("git")
        .args([
            "-C",
            &root_str,
            "status",
            "--porcelain",
            "--untracked-files=no",
        ])
        .output()
        .await
        .ok()?;
    let dirty = !status_out.stdout.is_empty();

    Some(format!(
        "branch: {branch}\nstatus: {}",
        if dirty { "dirty" } else { "clean" }
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[tokio::test]
    async fn includes_workspace_path_and_env_block() {
        let dir = tempdir().unwrap();
        let ws = Workspace::new(dir.path()).unwrap();
        let prompt = build_system_context(&ws, None).await;
        assert!(prompt.contains("<environment>"));
        assert!(prompt.contains(&ws.root().to_string_lossy().to_string()));
        assert!(prompt.contains(&format!("os: {}", std::env::consts::OS)));
    }

    #[tokio::test]
    async fn embeds_claude_md_when_present_and_takes_precedence_over_readme() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join("CLAUDE.md"), "# Project rules\nUse TDD.\n").unwrap();
        std::fs::write(dir.path().join("README.md"), "# Public\nDon't pick me\n").unwrap();
        let ws = Workspace::new(dir.path()).unwrap();
        let prompt = build_system_context(&ws, None).await;
        assert!(prompt.contains("<CLAUDE.md>"));
        assert!(prompt.contains("Project rules"));
        assert!(!prompt.contains("<README.md>"));
    }

    #[tokio::test]
    async fn truncates_oversize_readme_with_marker() {
        let dir = tempdir().unwrap();
        let huge = "x".repeat(README_BUDGET + 500);
        std::fs::write(dir.path().join("README.md"), huge).unwrap();
        let ws = Workspace::new(dir.path()).unwrap();
        let prompt = build_system_context(&ws, None).await;
        assert!(prompt.contains("<README.md>"));
        assert!(prompt.contains(&format!("[truncated at {README_BUDGET} chars")));
    }

    #[tokio::test]
    async fn workspace_tree_lists_top_level_only_skipping_noise_dirs() {
        let dir = tempdir().unwrap();
        std::fs::create_dir(dir.path().join("src")).unwrap();
        std::fs::write(dir.path().join("src/main.rs"), "").unwrap();
        std::fs::create_dir(dir.path().join("node_modules")).unwrap();
        std::fs::write(dir.path().join("node_modules/x.js"), "").unwrap();
        let ws = Workspace::new(dir.path()).unwrap();
        let prompt = build_system_context(&ws, None).await;
        assert!(prompt.contains("<workspace_tree>"));
        assert!(prompt.contains("src/"));
        assert!(prompt.contains("main.rs"));
        assert!(!prompt.contains("node_modules"));
    }

    #[tokio::test]
    async fn git_state_omitted_for_non_git_dir() {
        let dir = tempdir().unwrap();
        let ws = Workspace::new(dir.path()).unwrap();
        let prompt = build_system_context(&ws, None).await;
        assert!(!prompt.contains("<git>"));
    }

    #[tokio::test]
    async fn staff_header_overrides_default_and_keeps_env_tools() {
        let dir = tempfile::tempdir().unwrap();
        let ws = Workspace::new(dir.path()).unwrap();
        let prompt = build_system_context(&ws, Some("You ARE Fleet — orchestrator.")).await;
        assert!(prompt.contains("You ARE Fleet"));
        assert!(!prompt.contains("You are an AI coding assistant"));
        assert!(prompt.contains("<environment>"));
        assert!(prompt.contains("<tool_usage>"));
    }

    #[tokio::test]
    async fn default_header_used_when_none() {
        let dir = tempfile::tempdir().unwrap();
        let ws = Workspace::new(dir.path()).unwrap();
        let prompt = build_system_context(&ws, None).await;
        assert!(prompt.contains("You are an AI coding assistant"));
    }

    #[tokio::test]
    async fn includes_tool_usage_guide() {
        let dir = tempdir().unwrap();
        let ws = Workspace::new(dir.path()).unwrap();
        let prompt = build_system_context(&ws, None).await;
        assert!(prompt.contains("<tool_usage>"));
        assert!(prompt.contains("edit_file"));
        assert!(prompt.contains("grep"));
    }
}
