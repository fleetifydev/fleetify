//! AI-driven git helpers = the Electron `git:generateCommitMessage`,
//! `git:generatePRSummary`, and `git:reviewDiff` handlers.
//!
//! Each spawns the session's CLI in one-shot mode (`claude --print`,
//! `codex exec --quiet`) with the prompt on
//! stdin and captures the stdout. No persistent session, no bridge —
//! these are renderer-driven one-shots used by the Quick Commit and
//! Create PR pipelines (and pre-PR Review dialog).
//!
//! Faithful with main.cjs: same prompts, same diff-prep, same parsing,
//! same truncation thresholds (30 kB commit diff, 60 kB PR diff,
//! 50/20 kB committed/working review diffs).

use std::path::{Path, PathBuf};
use std::time::Duration;

use fleetify_core::text::{prefix_within_bytes, truncate_chars};
use serde_json::{json, Value};

use crate::shell::git;

// Tuple is (binary, args). The provider id is "claude-code" (see cli_for's
// default) but the spawned binary stays "claude" — that's the executable the
// `@anthropic-ai/claude-code` npm package installs on PATH.
const CLAUDE: (&str, &[&str]) = ("claude", &["--print"]);
const CODEX: (&str, &[&str]) = ("codex", &["exec", "--quiet"]);

// ── AI call budgets ───────────────────────────────────────────────────
// These CLIs are AGENTS, not completion endpoints: when a prompt doesn't
// fully answer itself they go and read the repo, and a long answer is a long
// generation. Measured on a Windows dev box against `claude --print`:
// commit message with a real diff ~6 s, PR summary with an empty commit range
// ~37 s, a 400-word review 30-39 s. The old 20/25/35 s budgets sat right on
// those numbers, so user-visible actions failed with "claude timed out" on
// perfectly healthy runs. Each of these is behind a spinner the user can
// cancel by closing the dialog, so waiting is strictly better than a
// false failure.
const AI_COMMIT_TIMEOUT: Duration = Duration::from_secs(45);
const AI_SUMMARY_TIMEOUT: Duration = Duration::from_secs(60);
const AI_REVIEW_TIMEOUT: Duration = Duration::from_secs(90);

fn cli_for(tool: Option<&str>) -> (&'static str, &'static [&'static str]) {
    match tool.unwrap_or("claude-code") {
        "codex-cli" => CODEX,
        _ => CLAUDE, // unknown → claude (parity with the Electron fallback)
    }
}

/// CLIs to try when the chosen tool's binary isn't on PATH. Order is
/// "most likely to be installed in a Fleetify dev environment" first,
/// then the others. We skip the originally-requested tool because the
/// caller already discovered it's missing.
fn cli_fallback_chain(skip: &str) -> Vec<(&'static str, &'static [&'static str])> {
    [CLAUDE, CODEX]
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
/// when their session was created with `tool: "codex-cli"`.
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
            format!("{bin} not on PATH — install claude/codex CLI to enable AI summaries"),
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

/// Cut a diff to at most `max_bytes` for a prompt, marking the cut. The cut
/// backs off to a character boundary: diffs carry whatever the user's files
/// contain, and slicing inside a character panics.
fn cap_diff(diff: String, max_bytes: usize) -> String {
    let head = prefix_within_bytes(&diff, max_bytes);
    if head.len() == diff.len() {
        diff
    } else {
        format!("{head}\n…[truncated]")
    }
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
        // The auto-commit step stages everything (`git add -A`) BEFORE calling
        // this, so read the STAGED diff — the plain unstaged `git diff` is empty
        // by then (and untracked work never shows up in it at all).
        let (st_ok, st_out) = git_out(
            &path,
            &["diff", "--cached", "--shortstat"],
            Duration::from_secs(5),
        )
        .await;
        let (fl_ok, fl_out) = git_out(
            &path,
            &["diff", "--cached", "--name-status"],
            Duration::from_secs(5),
        )
        .await;
        let (df_ok, df_out) = git_out(
            &path,
            &["diff", "--cached", "--unified=2"],
            Duration::from_secs(8),
        )
        .await;
        let truncated = if df_ok {
            cap_diff(df_out, 30_000)
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
        "You are writing a git commit message in the Conventional Commits format. Emit a SINGLE LINE shaped as `<type>(<scope>): <description>` (omit the `(<scope>)` part when the scope is unclear). `type` MUST be one of: feat, fix, docs, style, refactor, perf, test, build, ci, chore. The description is imperative and lowercase; the whole line is ≤72 characters, with no trailing period, no quotes, and no Markdown. Focus on WHAT changed and WHY. Output ONLY the commit message line — no preamble, no body, no explanation.\n\n{context}\n"
    );

    let (ok, cli, out, err) =
        run_session_cli(&folder, tool.as_deref(), &prompt, AI_COMMIT_TIMEOUT).await;
    if !ok {
        return json!({ "ok": false, "error": err });
    }
    let message = clean_commit_message(&out);
    if message.is_empty() {
        return json!({ "ok": false, "error": format!("{cli} returned an empty message") });
    }
    json!({ "ok": true, "message": message })
}

/// Turn the CLI's raw output into a commit subject: the first non-empty
/// trimmed line, wrapping quotes stripped, at most 72 characters. The limit
/// counts characters, not bytes, and never splits one: the subject is often
/// Turkish.
fn clean_commit_message(out: &str) -> String {
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
    truncate_chars(&mut message, 72);
    message
}

// ── generatePRSummary ───────────────────────────────────────────
/// Diff context for the PR summary prompt. `uncommitted` marks the fallback
/// case: the branch has no commits against the base yet, so the context came
/// from the working tree instead of the commit range.
#[derive(Debug, Default, PartialEq)]
pub struct PrSummaryContext {
    pub log: String,
    pub stat: String,
    pub files: String,
    pub diff: String,
    pub uncommitted: bool,
}

/// Build the diff context for {@link generate_pr_summary}.
///
/// The commit range is empty whenever the branch has no commits yet — the
/// normal state when the PR dialog is opened BEFORE `create_pr_via_gh` runs its
/// `git add -A` + auto-commit. Handing the CLI `(no commits)` plus an empty
/// diff doesn't make it fast: it makes it go read the repo itself to work out
/// what changed, which blew past the timeout every time (measured against
/// `claude --print`: 5.7 s with a real diff, 36.5 s with an empty one, on a
/// 25 s budget). So fall back to the working-tree diff — the same context
/// `review_diff` already uses — and the model answers from what it was given.
///
/// `None` means the range couldn't be read at all (not a repo / bad base).
pub async fn pr_summary_context(path: &Path, base: &str) -> Option<PrSummaryContext> {
    let range_dot3 = format!("{base}...HEAD");
    let range_dot2 = format!("{base}..HEAD");

    let (files_ok, files_out) = git_out(
        path,
        &["diff", "--name-status", &range_dot3],
        Duration::from_secs(5),
    )
    .await;
    let (log_ok, log_out) = git_out(
        path,
        &["log", "--oneline", "--no-decorate", &range_dot2],
        Duration::from_secs(5),
    )
    .await;
    let (stat_ok, stat_out) = git_out(
        path,
        &["diff", "--shortstat", &range_dot3],
        Duration::from_secs(5),
    )
    .await;
    let (diff_ok, diff_out) = git_out(
        path,
        &["diff", "--unified=2", &range_dot3],
        Duration::from_secs(8),
    )
    .await;
    if !files_ok || !log_ok {
        return None;
    }

    let mut ctx = PrSummaryContext {
        log: log_out,
        stat: if stat_ok { stat_out } else { String::new() },
        files: files_out,
        diff: if diff_ok { diff_out } else { String::new() },
        uncommitted: false,
    };
    if ctx.diff.trim().is_empty() {
        let (wd_ok, wd_out) = git_out(
            path,
            &["diff", "--unified=2", "HEAD"],
            Duration::from_secs(8),
        )
        .await;
        if wd_ok && !wd_out.trim().is_empty() {
            ctx.uncommitted = true;
            ctx.diff = wd_out;
            let (wf_ok, wf_out) = git_out(
                path,
                &["diff", "--name-status", "HEAD"],
                Duration::from_secs(5),
            )
            .await;
            if wf_ok && !wf_out.trim().is_empty() {
                ctx.files = wf_out;
            }
            let (ws_ok, ws_out) = git_out(
                path,
                &["diff", "--shortstat", "HEAD"],
                Duration::from_secs(5),
            )
            .await;
            if ws_ok {
                ctx.stat = ws_out;
            }
        }
    }
    Some(ctx)
}

pub async fn generate_pr_summary(
    folder: String,
    base_branch: Option<String>,
    tool: Option<String>,
) -> Value {
    let base = base_branch.unwrap_or_else(|| "main".to_string());
    let path = PathBuf::from(&folder);

    let Some(ctx) = pr_summary_context(&path, &base).await else {
        return json!({ "ok": false, "error": "couldn't read diff" });
    };
    let PrSummaryContext {
        log: log_out,
        stat: stat_out,
        files: files_out,
        diff,
        uncommitted,
    } = ctx;
    let truncated = cap_diff(diff, 60_000);

    let prompt = format!(
        "You are drafting a GitHub pull request. Read the diff below and emit STRICT JSON with two keys:\n\
- \"title\": ≤72 characters, imperative voice, no trailing period\n\
- \"body\":  Markdown. Lead with a 1-2 sentence summary of what changed and why. Then a \"## Changes\" section with 3–6 bullet points grouping related edits. Do not list every file. End with \"## Test plan\" listing what should be verified, as a bulleted checklist of TODOs.\n\n\
Output ONLY the JSON object, no prose around it, no code fence.\n\n\
# Commits since {base}\n{}\n\n\
# Shortstat\n{}\n\n\
# Files\n{}\n\n\
# {}\n{truncated}\n",
        if log_out.is_empty() { "(no commits)".to_string() } else { log_out },
        stat_out,
        if files_out.is_empty() { "(no files)".to_string() } else { files_out },
        if uncommitted { "Diff (uncommitted working tree — this is what the PR will contain)" } else { "Diff" },
    );

    let (ok, cli, raw, err) =
        run_session_cli(&folder, tool.as_deref(), &prompt, AI_SUMMARY_TIMEOUT).await;
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
    let trunc_committed = cap_diff(committed, 50_000);
    let trunc_working = cap_diff(working, 20_000);

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
        run_session_cli(&folder, tool.as_deref(), &prompt, AI_REVIEW_TIMEOUT).await;
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

/// `git remote -v` for `diagnose_failure`'s prompt, without the credentials
/// a remote URL can hold (`https://user:token@…`): the prompt goes to the
/// user's AI provider. `None` when git can't list the remotes.
async fn remotes_for_prompt(folder: &Path) -> Option<String> {
    let (ok, out) = git_out(folder, &["remote", "-v"], Duration::from_secs(5)).await;
    ok.then(|| git::redact_url_credentials(&out))
}

/// The error `diagnose_failure` asks about, as its prompt carries it: without
/// the credentials a URL quoted in it can hold, as the prompt goes to the
/// user's AI provider.
fn error_for_prompt(message: &str) -> String {
    git::redact_url_credentials(message)
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
    let remotes = remotes_for_prompt(&path).await;
    let raw_error = error_for_prompt(&error_message);

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
# Raw error\n{raw_error}\n\n\
# Repo state\n\
current branch: {}\n\n\
## git status -sb\n{}\n\n\
## last 5 commits\n{}\n\n\
## remotes\n{}\n",
        context.as_deref().filter(|s| !s.is_empty()).unwrap_or("Create PR failed"),
        if br_ok && !br_out.is_empty() { br_out.clone() } else { "(unknown)".to_string() },
        if st_ok { st_out } else { "(unavailable)".to_string() },
        if lg_ok { lg_out } else { "(unavailable)".to_string() },
        remotes.unwrap_or_else(|| "(unavailable)".to_string()),
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

    async fn git_ok(args: &[&str], p: &Path) -> bool {
        git::run("git", args, p, Duration::from_secs(10)).await.0 == 0
    }

    async fn seed_repo(p: &Path) -> bool {
        if !git_ok(&["init", "-b", "main"], p).await {
            return false;
        }
        let _ = git_ok(&["config", "user.email", "t@x"], p).await;
        let _ = git_ok(&["config", "user.name", "T"], p).await;
        std::fs::write(
            p.join("app.js"),
            "export const a = 1;
",
        )
        .unwrap();
        git_ok(&["add", "-A"], p).await && git_ok(&["commit", "-m", "init"], p).await
    }

    /// Regression: the PR dialog calls this BEFORE anything commits, so on a
    /// freshly carved branch `main...HEAD` is empty. Feeding the CLI an empty
    /// diff didn't make it cheap — it went and read the repo instead, and the
    /// call timed out ("claude timed out") every single time. The context must
    /// fall back to the working tree so the model has something to summarise.
    #[tokio::test]
    async fn pr_summary_context_falls_back_to_the_working_tree() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("proj");
        std::fs::create_dir_all(&repo).unwrap();
        if !seed_repo(&repo).await {
            return; // no usable git in this sandbox
        }
        // A carved branch with NO commits of its own, and an uncommitted edit.
        assert!(git_ok(&["checkout", "-b", "fleet/topic-abc12345"], &repo).await);
        std::fs::write(
            repo.join("app.js"),
            "export const a = 2;
",
        )
        .unwrap();

        let ctx = pr_summary_context(&repo, "main").await.expect("context");
        assert!(
            ctx.uncommitted,
            "should have flagged the working-tree fallback"
        );
        assert!(
            ctx.diff.contains("export const a = 2"),
            "working-tree diff missing from context: {:?}",
            ctx.diff
        );
        assert!(
            ctx.files.contains("app.js"),
            "files missing: {:?}",
            ctx.files
        );
    }

    /// The committed range still wins when the branch HAS commits — the
    /// fallback must not shadow a real PR diff with unrelated local edits.
    #[tokio::test]
    async fn pr_summary_context_prefers_the_commit_range() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("proj");
        std::fs::create_dir_all(&repo).unwrap();
        if !seed_repo(&repo).await {
            return;
        }
        assert!(git_ok(&["checkout", "-b", "fleet/topic-abc12345"], &repo).await);
        std::fs::write(
            repo.join("app.js"),
            "export const a = 3;
",
        )
        .unwrap();
        assert!(git_ok(&["commit", "-am", "bump"], &repo).await);

        let ctx = pr_summary_context(&repo, "main").await.expect("context");
        assert!(!ctx.uncommitted, "committed range should be used as-is");
        assert!(ctx.diff.contains("export const a = 3"));
        assert!(!ctx.log.trim().is_empty(), "commit log should be populated");
    }

    /// The failure diagnosis sends `git remote -v` to the user's AI provider.
    #[tokio::test]
    async fn the_diagnosis_prompt_lists_remotes_without_credentials() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("proj");
        std::fs::create_dir_all(&repo).unwrap();
        if !seed_repo(&repo).await {
            return;
        }
        let origin = "https://u:t@github.com/o/r.git";
        assert!(git_ok(&["remote", "add", "origin", origin], &repo).await);

        assert_eq!(
            remotes_for_prompt(&repo).await.as_deref(),
            Some(
                "origin\thttps://github.com/o/r.git (fetch)\n\
                 origin\thttps://github.com/o/r.git (push)\n"
            )
        );
    }

    /// The failure diagnosis sends the error it is asked about to the user's
    /// AI provider too, and git or gh output can quote a remote URL.
    #[test]
    fn the_diagnosis_prompt_carries_the_error_without_credentials() {
        assert_eq!(
            error_for_prompt(
                "fatal: unable to access 'https://u:t@github.com/o/r.git/': denied\n\
                 remote: https://token@github.com/o/r/pull/new/x"
            ),
            "fatal: unable to access 'https://github.com/o/r.git/': denied\n\
             remote: https://github.com/o/r/pull/new/x"
        );
    }

    /// Regression: Fleetify is Türkiye-first, so AI-written subjects are often
    /// Turkish. Cutting at byte 72 landed inside a two-byte letter and
    /// panicked, crashing "generate commit message" and "Create PR".
    #[test]
    fn commit_message_keeps_72_characters_of_a_turkish_subject() {
        let subject =
            "fix(git): uzun Türkçe commit başlığı kısaltılırken uygulama çökmesin güvenle kes";
        assert_eq!(subject.chars().count(), 80);
        assert!(
            !subject.is_char_boundary(72),
            "fixture must put byte 72 inside a letter"
        );

        let message = clean_commit_message(&format!("\n  `{subject}`  \nbody text\n"));

        assert_eq!(message.chars().count(), 72);
        assert_eq!(
            message,
            "fix(git): uzun Türkçe commit başlığı kısaltılırken uygulama çökmesin güv"
        );
    }

    /// Diffs carry whatever the user's files contain, Turkish comments
    /// included, so the prompt budget must not cut through a letter either.
    #[test]
    fn diff_cap_never_splits_a_turkish_letter() {
        let diff = "+// çğış\n".repeat(3000); // 13 bytes a line, 39 000 in all
        assert!(
            !diff.is_char_boundary(30_000),
            "fixture must put byte 30 000 inside a letter"
        );

        let capped = cap_diff(diff.clone(), 30_000);

        let head = capped
            .strip_suffix("\n…[truncated]")
            .expect("cut is marked");
        // Backs off one byte, to the start of the ı that byte 30 000 is in.
        assert_eq!(head.len(), 29_999);
        assert!(diff.starts_with(head));
        assert_eq!(cap_diff("+kısa\n".to_string(), 30_000), "+kısa\n");
    }

    #[test]
    fn cli_for_picks_per_tool() {
        assert_eq!(cli_for(Some("claude-code")).0, "claude");
        assert_eq!(cli_for(Some("codex-cli")).0, "codex");
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
