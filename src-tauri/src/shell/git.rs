//! Git / gh helpers — faithful with `electron/main.cjs`'s gitExec/ghExec
//! handlers. Each #[tauri::command] in `shell::ipc` is a thin wrapper
//! around a pure helper here (testable with real git in a tempdir).

use std::path::Path;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::process::Command;

/// Run `git` or `gh` and return (exit_code, stdout, stderr).
/// 8s default timeout — matches the Electron `gitExec` cap.
pub async fn run(bin: &str, args: &[&str], cwd: &Path, timeout: Duration) -> (i32, String, String) {
    let fut = async {
        let out = Command::new(bin)
            .args(args)
            .current_dir(cwd)
            .output()
            .await;
        match out {
            Ok(o) => (
                o.status.code().unwrap_or(-1),
                String::from_utf8_lossy(&o.stdout).to_string(),
                String::from_utf8_lossy(&o.stderr).to_string(),
            ),
            Err(e) => (-1, String::new(), e.to_string()),
        }
    };
    match tokio::time::timeout(timeout, fut).await {
        Ok(r) => r,
        Err(_) => (-1, String::new(), format!("{bin} timed out")),
    }
}

async fn git(args: &[&str], cwd: &Path) -> (i32, String, String) {
    run("git", args, cwd, Duration::from_secs(8)).await
}

async fn gh(args: &[&str], cwd: &Path) -> (i32, String, String) {
    run("gh", args, cwd, Duration::from_secs(20)).await
}

pub async fn get_context(folder: &Path) -> Value {
    let (rc_b, branch, _) = git(&["rev-parse", "--abbrev-ref", "HEAD"], folder).await;
    if rc_b != 0 {
        return json!({ "error": "not a git repository" });
    }
    let branch = branch.trim();
    let branch_v: Value =
        if branch.is_empty() || branch == "HEAD" { Value::Null } else { json!(branch) };

    let (rc_r, remote, _) = git(&["remote", "get-url", "origin"], folder).await;
    let remote_https = if rc_r == 0 {
        Some(ssh_to_https(remote.trim()))
    } else {
        None
    };

    // Default integration branch (origin/HEAD → main/master fallback).
    let base = detect_default_branch(folder).await;

    let (mut plus, mut minus) = (0i64, 0i64);
    if let Some(b) = &base {
        let (rc_d, num, _) =
            git(&["diff", "--numstat", &format!("{b}...HEAD")], folder).await;
        if rc_d == 0 {
            for line in num.lines() {
                let mut it = line.split_whitespace();
                if let (Some(p), Some(m)) = (it.next(), it.next()) {
                    plus += p.parse::<i64>().unwrap_or(0);
                    minus += m.parse::<i64>().unwrap_or(0);
                }
            }
        }
    }

    json!({
        "branch": branch_v,
        "baseBranch": base.map(Value::String).unwrap_or(Value::Null),
        "plus": plus,
        "minus": minus,
        "remoteHttpsUrl": remote_https.map(Value::String).unwrap_or(Value::Null),
    })
}

pub async fn has_gh_cli() -> Value {
    let cwd = std::env::current_dir().unwrap_or_else(|_| ".".into());
    let (rc_v, ver, _) =
        run("gh", &["--version"], &cwd, Duration::from_secs(5)).await;
    if rc_v != 0 {
        return json!({ "ok": false });
    }
    let version = ver.lines().next().unwrap_or("").to_string();
    // Probe auth status; non-zero rc means signed out.
    let (rc_a, _o, err) = gh(&["auth", "status"], &cwd).await;
    let authed = rc_a == 0;
    let login = if authed {
        // `gh api user --jq .login` — cheap login probe.
        let (rc_u, name, _) = gh(&["api", "user", "--jq", ".login"], &cwd).await;
        if rc_u == 0 {
            Some(name.trim().to_string())
        } else {
            None
        }
    } else {
        None
    };
    json!({
        "ok": true, "version": version,
        "authed": authed,
        "ghLogin": login.map(Value::String).unwrap_or(Value::Null),
        "error": if authed { Value::Null } else { json!(err.trim()) },
    })
}

pub async fn list_branches(folder: &Path) -> Value {
    let (rc1, local, _) = git(&["for-each-ref", "--format=%(refname:short)", "refs/heads"], folder).await;
    let (rc2, remote, _) = git(
        &["for-each-ref", "--format=%(refname:short)", "refs/remotes"],
        folder,
    )
    .await;
    if rc1 != 0 || rc2 != 0 {
        return json!({ "error": "not a git repository" });
    }
    let split = |s: String| -> Vec<String> {
        s.lines()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .collect()
    };
    json!({ "local": split(local), "remote": split(remote) })
}

pub async fn checkout(folder: &Path, branch: &str, force: bool) -> Value {
    let mut args: Vec<&str> = vec!["checkout"];
    if force {
        args.push("-f");
    }
    args.push(branch);
    let (rc, _o, err) = git(&args, folder).await;
    if rc == 0 {
        json!({ "ok": true })
    } else {
        json!({ "ok": false, "error": err.trim() })
    }
}

pub async fn commit(folder: &Path, message: &str) -> Value {
    let (rc_a, _, _) = git(&["add", "."], folder).await;
    if rc_a != 0 {
        return json!({ "ok": false, "error": "git add failed" });
    }
    let (rc, out, err) = git(&["commit", "-m", message], folder).await;
    if rc == 0 {
        json!({ "ok": true, "out": out.trim() })
    } else {
        json!({ "ok": false, "error": err.trim() })
    }
}

pub async fn push(folder: &Path) -> Value {
    let (rc, out, err) = git(&["push"], folder).await;
    if rc == 0 {
        json!({ "ok": true, "out": out.trim() })
    } else {
        json!({ "ok": false, "error": err.trim() })
    }
}

pub async fn ensure_repo(
    folder: &Path,
    name: Option<&str>,
    email: Option<&str>,
) -> Value {
    let path = folder.to_string_lossy().to_string();
    // Delegate to fleet-backend's faithful auto-init (init -b main +
    // identity seed + .gitignore + initial commit).
    let _ = fleet_backend::services::worktree::ensure_git_repo(&path).await;
    // Apply any explicit identity overrides on top.
    if let Some(n) = name {
        if !n.is_empty() {
            let _ = git(&["config", "user.name", n], folder).await;
        }
    }
    if let Some(e) = email {
        if !e.is_empty() {
            let _ = git(&["config", "user.email", e], folder).await;
        }
    }
    if fleet_backend::services::worktree::is_git_repo(&path).await {
        json!({ "ok": true })
    } else {
        json!({ "ok": false, "error": "failed to init repo" })
    }
}

pub async fn pull_latest(folder: &Path, base: &str) -> Value {
    let (rc1, _o, err1) = git(&["fetch", "origin"], folder).await;
    if rc1 != 0 {
        return json!({ "ok": false, "error": format!("fetch: {}", err1.trim()) });
    }
    let (rc2, _o, err2) = git(&["pull", "--ff-only", "origin", base], folder).await;
    if rc2 == 0 {
        json!({ "ok": true })
    } else {
        json!({ "ok": false, "error": err2.trim() })
    }
}

pub async fn diff_summary(folder: &Path, base: &str) -> Value {
    let base_ref = format!("origin/{base}");
    let range = format!("{base_ref}...HEAD");
    let (rc, out, err) = git(&["diff", "--numstat", &range], folder).await;
    if rc != 0 {
        return json!({ "ok": false, "error": err.trim() });
    }
    let lines: Vec<Value> = out
        .lines()
        .filter_map(|l| {
            let mut it = l.split_whitespace();
            let p = it.next()?;
            let m = it.next()?;
            let f = it.next()?;
            Some(json!({
                "file": f,
                "plus": p.parse::<i64>().unwrap_or(0),
                "minus": m.parse::<i64>().unwrap_or(0),
            }))
        })
        .collect();
    json!({
        "baseRef": base_ref,
        "headRef": "HEAD",
        "diffLines": lines,
    })
}

pub async fn open_pr(folder: &Path) -> Value {
    let (rc, remote, _) = git(&["remote", "get-url", "origin"], folder).await;
    if rc != 0 {
        return json!({ "ok": false, "error": "no origin remote" });
    }
    let mut url = ssh_to_https(remote.trim());
    if let Some(stripped) = url.strip_suffix(".git") {
        url = stripped.to_string();
    }
    let target = format!("{url}/pulls");
    match ::open::that(&target) {
        Ok(_) => json!({ "ok": true, "url": target }),
        Err(e) => json!({ "ok": false, "error": e.to_string() }),
    }
}

pub async fn create_pr(
    folder: &Path,
    title: &str,
    body: Option<&str>,
    base: Option<&str>,
    draft: bool,
) -> Value {
    let mut args: Vec<String> = vec!["pr".into(), "create".into()];
    args.push("--title".into());
    args.push(title.into());
    args.push("--body".into());
    args.push(body.unwrap_or("").into());
    if let Some(b) = base {
        args.push("--base".into());
        args.push(b.into());
    }
    if draft {
        args.push("--draft".into());
    }
    let argv: Vec<&str> = args.iter().map(String::as_str).collect();
    let (rc, out, err) = gh(&argv, folder).await;
    if rc != 0 {
        return json!({ "ok": false, "error": err.trim() });
    }
    let url = out
        .lines()
        .last()
        .map(str::trim)
        .filter(|s| s.starts_with("http"))
        .unwrap_or("")
        .to_string();
    let pr_number = parse_pr_number(&url);
    json!({ "ok": true, "prNumber": pr_number, "prUrl": url })
}

pub async fn get_pr_status(folder: &Path, pr_number: Option<u64>) -> Value {
    // `gh pr view [<n>] --json ...` returns the structured fields the
    // renderer's PR dialog displays.
    let mut argv: Vec<String> = vec!["pr".into(), "view".into()];
    if let Some(n) = pr_number {
        argv.push(n.to_string());
    }
    argv.push("--json".into());
    argv.push(
        "number,url,state,mergeable,isDraft,baseRefName,headRefName,\
         statusCheckRollup,commentsCount"
            .into(),
    );
    let argv_ref: Vec<&str> = argv.iter().map(String::as_str).collect();
    let (rc, out, err) = gh(&argv_ref, folder).await;
    if rc != 0 {
        return json!({ "ok": false, "error": err.trim() });
    }
    match serde_json::from_str::<Value>(out.trim()) {
        Ok(pr) => json!({ "ok": true, "pr": pr }),
        Err(e) => json!({ "ok": false, "error": format!("parse: {e}") }),
    }
}

pub async fn merge_pr(folder: &Path, pr_number: u64, method: &str) -> Value {
    let flag = match method {
        "rebase" => "--rebase",
        "squash" => "--squash",
        _ => "--merge",
    };
    let n = pr_number.to_string();
    let (rc, _o, err) = gh(
        &["pr", "merge", &n, flag, "--delete-branch"],
        folder,
    )
    .await;
    if rc == 0 {
        json!({ "ok": true })
    } else {
        json!({ "ok": false, "error": err.trim() })
    }
}

/// `https://github.com/foo/bar/pull/42` → Some(42); anything else → None.
fn parse_pr_number(url: &str) -> Option<u64> {
    url.rsplit_once("/pull/")
        .and_then(|(_, rest)| rest.split('/').next())
        .and_then(|n| n.parse::<u64>().ok())
}

async fn detect_default_branch(folder: &Path) -> Option<String> {
    let (rc, out, _) = git(
        &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
        folder,
    )
    .await;
    if rc == 0 && !out.trim().is_empty() {
        let v = out.trim();
        return Some(v.split_once('/').map(|(_, b)| b.to_string()).unwrap_or_else(|| v.to_string()));
    }
    for c in ["main", "master"] {
        let (rc2, _, _) = git(
            &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{c}")],
            folder,
        )
        .await;
        if rc2 == 0 {
            return Some(c.into());
        }
    }
    None
}

/// `git fetch origin` + checkout base + ff-pull + return to original branch
/// (parity with main.cjs's syncMain — refreshes the local base branch
/// without leaving the user stranded on it).
pub async fn sync_main(folder: &Path, base: &str) -> Value {
    let prev = current_branch_str(folder).await.unwrap_or_else(|| "HEAD".to_string());
    let (rcf, _o, errf) = git(&["fetch", "origin"], folder).await;
    if rcf != 0 {
        return json!({ "ok": false, "error": format!("fetch: {}", errf.trim()) });
    }
    let (rcc, _o, errc) = git(&["checkout", base], folder).await;
    if rcc != 0 {
        return json!({ "ok": false, "error": format!("checkout {base}: {}", errc.trim()) });
    }
    let (rcp, _o, errp) = git(&["pull", "--ff-only", "origin", base], folder).await;
    if rcp != 0 {
        let _ = git(&["checkout", &prev], folder).await; // restore
        return json!({ "ok": false, "error": format!("pull --ff-only: {}", errp.trim()) });
    }
    let _ = git(&["checkout", &prev], folder).await;
    json!({ "ok": true, "base": base, "prevBranch": prev })
}

/// Carve a new feature branch from `base` (parity with carveNextRound).
pub async fn carve_next_round(folder: &Path, branch: &str, base: &str) -> Value {
    let (rc, _o, err) = git(&["checkout", "-b", branch, base], folder).await;
    if rc == 0 {
        json!({ "ok": true, "branch": branch, "base": base })
    } else {
        json!({ "ok": false, "error": err.trim() })
    }
}

/// Detect common pre-PR issues (parity with preflightCheck). Reports but
/// does not fix; the renderer surfaces fixes through `applyPreflightFix`
/// (Phase 2 follow-up).
pub async fn preflight_check(folder: &Path) -> Value {
    let mut issues: Vec<Value> = Vec::new();
    let path = folder.to_string_lossy().to_string();
    if !fleet_backend::services::worktree::is_git_repo(&path).await {
        issues.push(json!({
            "type": "not-a-repo",
            "message": "Not a git repository.",
            "suggestion": "Run gitEnsureRepo to initialize."
        }));
        return json!({ "ok": false, "issues": issues });
    }
    let (rc_top, root, _) = git(&["rev-parse", "--show-toplevel"], folder).await;
    if rc_top == 0 {
        let g = std::path::Path::new(root.trim()).join(".git");
        if g.join("REBASE_HEAD").exists()
            || g.join("rebase-merge").is_dir()
            || g.join("rebase-apply").is_dir()
        {
            issues.push(json!({
                "type": "mid-rebase",
                "message": "Repository is in the middle of a rebase.",
                "suggestion": "Run `git rebase --continue` or `git rebase --abort`."
            }));
        }
        if g.join("MERGE_HEAD").exists() {
            issues.push(json!({
                "type": "mid-merge",
                "message": "Repository is in the middle of a merge.",
                "suggestion": "Run `git merge --continue` or `git merge --abort`."
            }));
        }
    }
    if current_branch_str(folder).await.is_none() {
        issues.push(json!({
            "type": "detached-head",
            "message": "HEAD is detached.",
            "suggestion": "Check out a branch before creating a PR."
        }));
    }
    let (rc_h, _o, _e) = git(&["rev-parse", "HEAD"], folder).await;
    if rc_h != 0 {
        issues.push(json!({
            "type": "nested-no-commits",
            "message": "No commits in this repository yet.",
            "suggestion": "Commit at least one file before creating a PR."
        }));
    }
    json!({ "ok": issues.is_empty(), "issues": issues })
}

async fn current_branch_str(folder: &Path) -> Option<String> {
    let (rc, out, _) = git(&["rev-parse", "--abbrev-ref", "HEAD"], folder).await;
    let v = out.trim().to_string();
    if rc != 0 || v.is_empty() || v == "HEAD" { None } else { Some(v) }
}

/// `git@github.com:foo/bar.git` → `https://github.com/foo/bar.git` (parity
/// with the Electron `gitContextHandlers` shape; HTTPS already passes through).
fn ssh_to_https(url: &str) -> String {
    let u = url.trim();
    if let Some(rest) = u.strip_prefix("git@") {
        if let Some((host, path)) = rest.split_once(':') {
            return format!("https://{host}/{path}");
        }
    }
    u.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git_available() -> bool {
        std::process::Command::new("git")
            .arg("--version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    async fn fresh_repo(p: &Path) {
        let _ = git(&["init", "-b", "main"], p).await;
        let _ = git(&["config", "user.email", "t@x"], p).await;
        let _ = git(&["config", "user.name", "T"], p).await;
        let _ = git(&["commit", "-m", "init", "--allow-empty"], p).await;
    }

    #[test]
    fn parse_pr_number_from_url() {
        assert_eq!(
            parse_pr_number("https://github.com/foo/bar/pull/42"),
            Some(42)
        );
        assert_eq!(
            parse_pr_number("https://github.com/foo/bar/pull/42/files"),
            Some(42)
        );
        assert_eq!(parse_pr_number("https://github.com/foo/bar"), None);
        assert_eq!(parse_pr_number(""), None);
    }

    #[test]
    fn ssh_to_https_rewrites_git_url() {
        assert_eq!(
            ssh_to_https("git@github.com:foo/bar.git"),
            "https://github.com/foo/bar.git"
        );
        assert_eq!(
            ssh_to_https("https://github.com/foo/bar.git"),
            "https://github.com/foo/bar.git"
        );
    }

    #[tokio::test]
    async fn get_context_returns_main_and_zero_diff_on_clean_repo() {
        if !git_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        fresh_repo(tmp.path()).await;
        let v = get_context(tmp.path()).await;
        assert_eq!(v["branch"], "main");
        assert_eq!(v["plus"], 0);
        assert_eq!(v["minus"], 0);
        assert!(v.get("error").is_none());
    }

    #[tokio::test]
    async fn list_branches_returns_main_after_init() {
        if !git_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        fresh_repo(tmp.path()).await;
        let v = list_branches(tmp.path()).await;
        let local: Vec<String> = v["local"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| x.as_str().unwrap().to_string())
            .collect();
        assert!(local.iter().any(|b| b == "main"));
    }

    #[tokio::test]
    async fn preflight_flags_no_commits_on_fresh_init() {
        if !git_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        // Skip if ancestor repo would mask our state.
        if fleet_backend::services::worktree::is_git_repo(
            &tmp.path().to_string_lossy(),
        )
        .await
        {
            return;
        }
        let _ = git(&["init", "-b", "main"], tmp.path()).await;
        let v = preflight_check(tmp.path()).await;
        assert_eq!(v["ok"], false);
        let kinds: Vec<&str> = v["issues"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| x["type"].as_str().unwrap())
            .collect();
        assert!(kinds.iter().any(|k| *k == "nested-no-commits"));
    }

    #[tokio::test]
    async fn carve_next_round_creates_branch_from_base() {
        if !git_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        fresh_repo(tmp.path()).await;
        let v = carve_next_round(tmp.path(), "fleet/x-y", "main").await;
        assert_eq!(v["ok"], true);
        assert_eq!(v["branch"], "fleet/x-y");
        assert_eq!(current_branch_str(tmp.path()).await.as_deref(), Some("fleet/x-y"));
    }

    #[tokio::test]
    async fn ensure_repo_on_empty_dir_creates_repo() {
        if !git_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        // Some Windows/CI envs have a `.git` at $HOME or above %TEMP%,
        // making the tempdir already "inside" a repo — ensure_repo then
        // (correctly) skips init. Skip the assertion in that case.
        let path = tmp.path().to_string_lossy().to_string();
        if fleet_backend::services::worktree::is_git_repo(&path).await {
            return;
        }
        let v = ensure_repo(tmp.path(), Some("T"), Some("t@x")).await;
        assert_eq!(v["ok"], true);
        let (rc, head, _) = git(&["rev-parse", "--abbrev-ref", "HEAD"], tmp.path()).await;
        assert_eq!(rc, 0);
        assert_eq!(head.trim(), "main");
    }

    #[tokio::test]
    async fn diff_summary_without_remote_returns_error_envelope() {
        if !git_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        fresh_repo(tmp.path()).await;
        let v = diff_summary(tmp.path(), "main").await;
        // No `origin/main` ref → faithful error envelope.
        assert_eq!(v["ok"], false);
        assert!(v.get("error").is_some());
    }

    #[tokio::test]
    async fn commit_then_push_no_remote_surfaces_error() {
        if !git_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        fresh_repo(tmp.path()).await;
        std::fs::write(tmp.path().join("x.txt"), "hello").unwrap();
        let v = commit(tmp.path(), "add x").await;
        assert_eq!(v["ok"], true);
        // No remote → push reports error (faithful: ok:false, error).
        let p = push(tmp.path()).await;
        assert_eq!(p["ok"], false);
        assert!(p.get("error").is_some());
    }
}
