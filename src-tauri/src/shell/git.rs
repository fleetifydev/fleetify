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
