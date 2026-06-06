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
        let out = Command::new(bin).args(args).current_dir(cwd).output().await;
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

/// Resolve `git` to an absolute path. Used as a fallback by `has_git`
/// when the bare `Command::new("git")` spawn fails (host PATH stripped,
/// per-user install, scoop / choco shim, …). Walks PATH+PATHEXT first,
/// then a per-OS list of common install locations including per-user
/// directories that GUI-launched apps often miss.
pub fn resolve_git() -> Option<std::path::PathBuf> {
    use std::path::PathBuf;

    let pathexts: Vec<String> = if cfg!(windows) {
        // PATHEXT order matters: `.EXE` first so we land on git.exe
        // even on hosts where PATHEXT lists `.COM` ahead of it.
        let raw = std::env::var("PATHEXT").unwrap_or_else(|_| ".EXE;.CMD;.BAT;.COM".into());
        let mut out: Vec<String> = raw
            .split(';')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();
        // Ensure `.EXE` is in the list even if PATHEXT was overridden
        // to something exotic — Git for Windows always ships git.exe.
        if !out.iter().any(|e| e.eq_ignore_ascii_case(".exe")) {
            out.insert(0, ".EXE".into());
        }
        out
    } else {
        // Unix: no extension append needed; one pass with the empty
        // suffix covers `/usr/bin/git`, `/opt/homebrew/bin/git`, etc.
        vec![String::new()]
    };

    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            for ext in &pathexts {
                let candidate = dir.join(format!("git{ext}"));
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
    }

    // OS-specific fallbacks for common install locations the host
    // PATH might not cover (per-user installs, package managers that
    // don't auto-PATH, GUI launches with stripped PATH on macOS, …).
    let fallbacks: Vec<std::path::PathBuf> = if cfg!(target_os = "macos") {
        vec![
            "/opt/homebrew/bin/git".into(),
            "/usr/local/bin/git".into(),
            "/usr/bin/git".into(),
            "/Library/Developer/CommandLineTools/usr/bin/git".into(),
            "/Applications/Xcode.app/Contents/Developer/usr/bin/git".into(),
        ]
    } else if cfg!(target_os = "linux") {
        vec![
            "/usr/bin/git".into(),
            "/usr/local/bin/git".into(),
            "/snap/bin/git".into(),
            "/opt/local/bin/git".into(),
        ]
    } else if cfg!(windows) {
        let mut list: Vec<std::path::PathBuf> = vec![
            // Git for Windows — default all-users install.
            r"C:\Program Files\Git\cmd\git.exe".into(),
            r"C:\Program Files\Git\bin\git.exe".into(),
            r"C:\Program Files\Git\mingw64\bin\git.exe".into(),
            r"C:\Program Files (x86)\Git\cmd\git.exe".into(),
            r"C:\Program Files (x86)\Git\bin\git.exe".into(),
        ];
        // Per-user installer ("current user only" option in the
        // Git for Windows wizard, or winget's user scope).
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            list.push(PathBuf::from(format!(r"{local}\Programs\Git\cmd\git.exe")));
            list.push(PathBuf::from(format!(r"{local}\Programs\Git\bin\git.exe")));
        }
        // Scoop — both the shim and the actual binary.
        if let Ok(home) = std::env::var("USERPROFILE") {
            list.push(PathBuf::from(format!(r"{home}\scoop\shims\git.exe")));
            list.push(PathBuf::from(format!(
                r"{home}\scoop\apps\git\current\cmd\git.exe"
            )));
            list.push(PathBuf::from(format!(
                r"{home}\scoop\apps\git\current\bin\git.exe"
            )));
        }
        // Chocolatey — `choco install git` puts a shim in this dir.
        list.push(r"C:\ProgramData\chocolatey\bin\git.exe".into());
        // GitHub Desktop bundles its own git.
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            list.push(PathBuf::from(format!(
                r"{local}\GitHubDesktop\app-current\resources\app\git\cmd\git.exe"
            )));
        }
        list
    } else {
        vec![]
    };
    fallbacks.into_iter().find(|p| p.is_file())
}

pub async fn has_git() -> Value {
    let cwd = std::env::current_dir().unwrap_or_else(|_| ".".into());

    // Tier 1 — let the OS resolve `git` via its native PATH lookup.
    // On Windows, Rust's `Command::new` auto-appends `.exe`; on Unix,
    // `execvp` searches PATH. This is the simplest, broadest check
    // and catches every host where git is on the active PATH.
    let (rc, ver, _) = run("git", &["--version"], &cwd, Duration::from_secs(5)).await;
    if rc == 0 {
        return json!({
            "ok": true,
            "version": ver.lines().next().unwrap_or("").trim(),
            "path": "git",
        });
    }

    // Tier 2 — manual PATH+PATHEXT walk + common install dirs. Catches
    // the cases Rust's auto-resolve misses: scoop's `git.cmd` shim,
    // per-user installs not on PATH, GitHub Desktop's bundled git,
    // macOS GUI launches without `/opt/homebrew/bin`, etc.
    if let Some(bin) = resolve_git() {
        let bin_str = bin.to_str().unwrap_or("git");
        let (rc, ver, _) = run(bin_str, &["--version"], &cwd, Duration::from_secs(5)).await;
        if rc == 0 {
            return json!({
                "ok": true,
                "version": ver.lines().next().unwrap_or("").trim(),
                "path": bin_str,
            });
        }
    }

    // Tier 3 — ask the OS itself. `where` on Windows / `which` on
    // Unix walks PATH using the host's authoritative rules and
    // understands shims (scoop, choco, Cygwin, …) better than any
    // hand-rolled walk can. The first line of output is the winning
    // candidate.
    let probe_bin = if cfg!(windows) { "where" } else { "which" };
    let (rc, out, _) = run(probe_bin, &["git"], &cwd, Duration::from_secs(3)).await;
    if rc == 0 {
        if let Some(first) = out.lines().next().map(str::trim).filter(|s| !s.is_empty()) {
            let (rc2, ver, _) = run(first, &["--version"], &cwd, Duration::from_secs(5)).await;
            if rc2 == 0 {
                return json!({
                    "ok": true,
                    "version": ver.lines().next().unwrap_or("").trim(),
                    "path": first,
                });
            }
        }
    }

    json!({ "ok": false })
}

/// Resolve the `gh` binary to an absolute path so every spawn (sync via
/// `run` / async via `gh` / PTY-driven from `ipc::gh_auth_login_capture`)
/// behaves the same across Windows / macOS / Linux:
///   * **Windows** — `CreateProcess` only auto-appends `.exe`; iterate
///     `PATHEXT` so scoop / winget / choco `.cmd` shims still resolve.
///   * **macOS**   — GUI-launched apps (Finder, Dock, Tauri bundle) get a
///     stripped PATH that omits `/opt/homebrew/bin` (Apple Silicon) and
///     `/usr/local/bin` (Intel Homebrew). Fall back to those dirs.
///   * **Linux**   — desktop-entry / systemd launches frequently miss
///     `/snap/bin`; the fallback covers Snap-installed gh as well.
///
/// Returns `None` when gh isn't found anywhere we know to look — callers
/// surface a friendly install hint instead of spawning a 127 exit.
/// True when the gh CLI is installed AND authenticated. Used by the host
/// router (`git_host`) to decide whether the gh backend is usable.
pub async fn gh_is_ready(folder: &Path) -> bool {
    if resolve_gh().is_none() {
        return false;
    }
    let (rc, _, _) = run("gh", &["auth", "status"], folder, Duration::from_secs(5)).await;
    rc == 0
}

pub fn resolve_gh() -> Option<std::path::PathBuf> {
    use std::path::PathBuf;

    let pathexts: Vec<String> = if cfg!(windows) {
        std::env::var("PATHEXT")
            .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into())
            .split(';')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect()
    } else {
        vec![String::new()]
    };

    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            for ext in &pathexts {
                let candidate = dir.join(format!("gh{ext}"));
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
    }

    let fallbacks: &[&str] = if cfg!(target_os = "macos") {
        &["/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh"]
    } else if cfg!(target_os = "linux") {
        &["/usr/bin/gh", "/usr/local/bin/gh", "/snap/bin/gh"]
    } else if cfg!(windows) {
        &[
            r"C:\Program Files\GitHub CLI\gh.exe",
            r"C:\Program Files (x86)\GitHub CLI\gh.exe",
        ]
    } else {
        &[]
    };
    for f in fallbacks {
        let p = PathBuf::from(f);
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

/// Resolved gh path as `String` for callers that just need an argv[0].
/// Falls back to the bare name (relying on host PATH) when resolution
/// fails — preserves the previous behaviour for environments where the
/// scanner can't see gh but the process spawn somehow still does.
fn gh_bin() -> String {
    resolve_gh()
        .and_then(|p| p.to_str().map(String::from))
        .unwrap_or_else(|| "gh".into())
}

async fn gh(args: &[&str], cwd: &Path) -> (i32, String, String) {
    // If the user authed via "Connect with GitHub" (the Fleetify OAuth
    // broker), their token is in the keychain — inject it as GH_TOKEN
    // so `gh` uses it instead of (or in addition to) its own login.
    // gh respects GH_TOKEN with higher priority than its keyring, so
    // every PR / repo / merge call goes through the chosen auth path
    // automatically:
    //   • OAuth picked  → keychain payload present → GH_TOKEN set → gh authed.
    //   • CLI picked    → no payload → no env var → gh uses its own auth.
    //   • Skip / unset  → same as CLI; mid-flow picker still pops on Create PR.
    let token: Option<String> = crate::shell::github_link::get_link().await.and_then(|l| {
        l.get("access_token")
            .and_then(|v| v.as_str())
            .map(String::from)
    });

    let mut cmd = tokio::process::Command::new(gh_bin());
    cmd.args(args).current_dir(cwd);
    if let Some(t) = token {
        cmd.env("GH_TOKEN", t);
    }
    let fut = async {
        match cmd.output().await {
            Ok(o) => (
                o.status.code().unwrap_or(-1),
                String::from_utf8_lossy(&o.stdout).to_string(),
                String::from_utf8_lossy(&o.stderr).to_string(),
            ),
            Err(e) => (-1, String::new(), e.to_string()),
        }
    };
    match tokio::time::timeout(Duration::from_secs(20), fut).await {
        Ok(r) => r,
        Err(_) => (-1, String::new(), "gh timed out".to_string()),
    }
}

/// Run `gh repo list` for the authenticated user, JSON-shaped to match
/// the renderer's `GhRepo`. Auth is whatever `gh()` resolves — the OAuth
/// keychain token (injected as `GH_TOKEN`) or gh's own login. Returns
/// `(rc, stdout, stderr)`; rc != 0 means gh failed (often unauthed).
/// Requires the gh binary — callers gate on `resolve_gh()`.
pub async fn gh_repo_list() -> (i32, String, String) {
    let cwd = std::env::current_dir().unwrap_or_else(|_| ".".into());
    gh(
        &[
            "repo",
            "list",
            "--limit",
            "100",
            "--json",
            "nameWithOwner,description,url,sshUrl,isPrivate,updatedAt",
        ],
        &cwd,
    )
    .await
}

/// The authenticated `gh` CLI's GitHub token (`gh auth token`), or `None` when
/// gh is absent / not signed in. Used to authenticate private HTTPS clones when
/// the user authed via `gh` rather than the Fleetify OAuth link.
pub async fn gh_auth_token() -> Option<String> {
    resolve_gh()?;
    let cwd = std::env::current_dir().unwrap_or_else(|_| ".".into());
    let (rc, out, _err) = gh(&["auth", "token"], &cwd).await;
    if rc != 0 {
        return None;
    }
    let tok = out.trim().to_string();
    if tok.is_empty() {
        None
    } else {
        Some(tok)
    }
}

pub async fn get_context(folder: &Path) -> Value {
    let (rc_b, branch, _) = git(&["rev-parse", "--abbrev-ref", "HEAD"], folder).await;
    if rc_b != 0 {
        return json!({ "error": "not a git repository" });
    }
    let branch = branch.trim();
    let branch_v: Value = if branch.is_empty() || branch == "HEAD" {
        Value::Null
    } else {
        json!(branch)
    };

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
        let (rc_d, num, _) = git(&["diff", "--numstat", &format!("{b}...HEAD")], folder).await;
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
    // Bail early if our resolver can't find gh anywhere — covers macOS
    // GUI launches where PATH is stripped of Homebrew dirs.
    if resolve_gh().is_none() {
        return json!({ "ok": false });
    }
    let bin = gh_bin();
    let (rc_v, ver, _) = run(&bin, &["--version"], &cwd, Duration::from_secs(5)).await;
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
    let (rc1, local, _) = git(
        &["for-each-ref", "--format=%(refname:short)", "refs/heads"],
        folder,
    )
    .await;
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

pub async fn ensure_repo(folder: &Path, name: Option<&str>, email: Option<&str>) -> Value {
    let path = folder.to_string_lossy().to_string();
    // Delegate to fleet-backend's faithful auto-init (init -b main +
    // identity seed + .gitignore + initial commit).
    let _ = fleetify_backend::services::worktree::ensure_git_repo(&path).await;
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
    if fleetify_backend::services::worktree::is_git_repo(&path).await {
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

// ── Fleetify attribution helpers ─────────────────────────────────
const FLEETIFY_CO_AUTHOR: &str = "Co-Authored-By: Fleetify <fleetifydev@gmail.com>";
const FLEETIFY_PR_FOOTER: &str = "\n\n---\nCreated with [Fleetify](https://fleetify.dev)";

fn with_fleetify_trailer(message: &str) -> String {
    let trimmed = message.trim_end();
    if trimmed.contains("Fleetify <fleetifydev@gmail.com>") {
        return trimmed.to_string();
    }
    format!("{trimmed}\n\n{FLEETIFY_CO_AUTHOR}")
}

fn with_fleetify_footer(body: &str) -> String {
    let trimmed = body.trim_end();
    if trimmed.contains("fleetify.dev") || trimmed.contains("github.com/fleetifyai") {
        return trimmed.to_string();
    }
    format!("{trimmed}{FLEETIFY_PR_FOOTER}")
}

/// Pull the signed-in user's name + email from `gh api /user` so the
/// dispatcher's commits are attributed to them. Falls back to a
/// generic placeholder when gh isn't authed (`init` still needs SOME
/// identity to commit).
async fn resolve_git_identity(folder: &Path) -> (String, String) {
    let fallback = ("Fleet User".to_string(), "fleet@fleetify.dev".to_string());
    let (rc, out, _) = gh(&["api", "/user"], folder).await;
    if rc == 0 && !out.is_empty() {
        if let Ok(u) = serde_json::from_str::<Value>(out.trim()) {
            let login = u
                .get("login")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            let name = u
                .get("name")
                .and_then(|v| v.as_str())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| {
                    if !login.is_empty() {
                        login.clone()
                    } else {
                        fallback.0.clone()
                    }
                });
            let email = u
                .get("email")
                .and_then(|v| v.as_str())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| {
                    if !login.is_empty() {
                        format!("{login}@users.noreply.github.com")
                    } else {
                        fallback.1.clone()
                    }
                });
            return (name, email);
        }
    }
    fallback
}

/// Conservative .gitignore — only writes when the folder has none.
/// Same pattern set as the Python `gitignore_template.writeGitignoreIfMissing`.
fn write_gitignore_if_missing(folder: &Path) -> bool {
    let path = folder.join(".gitignore");
    if path.exists() {
        return false;
    }
    let body = "# Auto-generated by Fleetify on first commit.\n\
                # Drop anything below before committing if you actually want it in git.\n\
                \n\
                # OS\n.DS_Store\nThumbs.db\n\n\
                # Editors\n.vscode/\n.idea/\n*.swp\n\n\
                # Node\nnode_modules/\nnpm-debug.log*\n\n\
                # Python\n__pycache__/\n*.pyc\n.venv/\nvenv/\n.pytest_cache/\n\n\
                # Build outputs\ndist/\nbuild/\ntarget/\n.next/\n.nuxt/\n.turbo/\n\n\
                # Env\n.env\n.env.local\n.env.*.local\n";
    std::fs::write(&path, body).is_ok()
}

/// Orchestrator (faithful with `git:createPR` in electron/main.cjs):
///   1. Probe `gh --version` + `gh auth status` → gh path.
///   2. Else check `shell::github_link::get_link()` → REST link path.
///   3. Else NO_AUTH.
// `method` honours the caller's preferred auth path: "gh" / "cli" → only
// gh CLI, "oauth" / "link" → only the Fleetify OAuth link, None → legacy
// gh-first / link-fallback. The renderer feeds this from
// `localStorage["fleet:github-auth-method"]` so the onboarding choice is
// honoured exactly — picking "Use GitHub CLI" never silently routes
// through OAuth, and vice versa.
// 8 args is one over the default 7; refactor to a struct is out of scope for this cleanup.
#[allow(clippy::too_many_arguments)]
pub async fn create_pr(
    folder: &Path,
    title: &str,
    body: Option<&str>,
    base: Option<&str>,
    draft: bool,
    feature_branch: Option<&str>,
    tool: Option<&str>,
    method: Option<&str>,
) -> Value {
    let want_gh = matches!(method, Some("gh") | Some("cli"));
    let want_oauth = matches!(method, Some("oauth") | Some("link"));

    // Probe both auth states once — both paths need them, and the
    // probes are cheap (1 process spawn + 1 keyring read).
    let gh_authed = async {
        let (rc, _, _) = run("gh", &["--version"], folder, Duration::from_secs(3)).await;
        if rc != 0 {
            return false;
        }
        let (rc, _, _) = run("gh", &["auth", "status"], folder, Duration::from_secs(5)).await;
        rc == 0
    }
    .await;
    let link = super::github_link::get_link().await;
    let oauth_token = link
        .as_ref()
        .and_then(|l| l.get("access_token").and_then(|v| v.as_str()))
        .map(String::from);

    // Caller asked for a specific method — honour it strictly. If the
    // requested method has no live auth, error with a code the renderer
    // can route into the mid-flow picker.
    if want_gh {
        if !gh_authed {
            return json!({
                "ok": false,
                "code": "GH_NOT_AUTHED",
                "error": "GitHub CLI isn't signed in. Run `gh auth login` or switch to GitHub OAuth."
            });
        }
        tracing::info!(target: "createPR", "dispatch-gh (requested)");
        return create_pr_via_gh(folder, title, body, base, draft, feature_branch, tool).await;
    }
    if want_oauth {
        let Some(token) = oauth_token else {
            return json!({
                "ok": false,
                "code": "OAUTH_NOT_LINKED",
                "error": "No GitHub OAuth link on this machine. Connect with GitHub or switch to the CLI."
            });
        };
        tracing::info!(target: "createPR", "dispatch-link (requested)");
        let preflight = ensure_repo_for_link(folder, title, base, feature_branch, tool).await;
        if let Some(err) = preflight {
            return err;
        }
        return super::github_pr::create_pr_via_link(
            folder,
            &token,
            title,
            body.unwrap_or(""),
            base,
            draft,
        )
        .await;
    }

    // No preference — legacy gh-first then link fallback.
    if gh_authed {
        tracing::info!(target: "createPR", "dispatch-gh (fallback)");
        return create_pr_via_gh(folder, title, body, base, draft, feature_branch, tool).await;
    }
    if let Some(token) = oauth_token {
        tracing::info!(target: "createPR", "dispatch-link (fallback)");
        let preflight = ensure_repo_for_link(folder, title, base, feature_branch, tool).await;
        if let Some(err) = preflight {
            return err;
        }
        return super::github_pr::create_pr_via_link(
            folder,
            &token,
            title,
            body.unwrap_or(""),
            base,
            draft,
        )
        .await;
    }
    tracing::info!(target: "createPR", "no-auth");
    json!({
        "ok": false,
        "code": "NO_AUTH",
        "error": "No GitHub authentication available. Connect GitHub in Settings → Integrations or install the gh CLI."
    })
}

/// Pre-flight a folder before the link-path REST flow: `git init`,
/// identity seed, initial commit (when no HEAD), feature-branch
/// carve, and auto-commit of dirty working tree. Same pattern as
/// the gh path's bootstrap steps. Returns Some(error-Value) on
/// failure, None on success.
async fn ensure_repo_for_link(
    folder: &Path,
    title: &str,
    base: Option<&str>,
    feature_branch: Option<&str>,
    tool: Option<&str>,
) -> Option<Value> {
    let _ = (title, base);
    if !folder.exists() {
        return Some(json!({
            "ok": false,
            "code": "NO_FOLDER",
            "error": format!("folder doesn't exist: {}", folder.display())
        }));
    }
    // git init when missing.
    if !folder.join(".git").exists() {
        let (rc, _, err) = run(
            "git",
            &["init", "-b", "main"],
            folder,
            Duration::from_secs(15),
        )
        .await;
        if rc != 0 {
            // legacy fallback
            let (rc2, _, err2) = run("git", &["init"], folder, Duration::from_secs(15)).await;
            if rc2 != 0 {
                return Some(json!({
                    "ok": false, "code": "INIT_FAILED",
                    "error": format!("git init: {}", if err.trim().is_empty() { err2.trim() } else { err.trim() })
                }));
            }
        }
        write_gitignore_if_missing(folder);
    }
    // identity seed (idempotent).
    let (name_rc, name_out, _) = run(
        "git",
        &["config", "--get", "user.name"],
        folder,
        Duration::from_secs(5),
    )
    .await;
    let (email_rc, email_out, _) = run(
        "git",
        &["config", "--get", "user.email"],
        folder,
        Duration::from_secs(5),
    )
    .await;
    if name_rc != 0 || name_out.trim().is_empty() || email_rc != 0 || email_out.trim().is_empty() {
        let (ident_name, ident_email) = resolve_git_identity(folder).await;
        if name_rc != 0 || name_out.trim().is_empty() {
            let _ = run(
                "git",
                &["config", "user.name", &ident_name],
                folder,
                Duration::from_secs(5),
            )
            .await;
        }
        if email_rc != 0 || email_out.trim().is_empty() {
            let _ = run(
                "git",
                &["config", "user.email", &ident_email],
                folder,
                Duration::from_secs(5),
            )
            .await;
        }
    }
    // Initial commit if no HEAD. When a feature branch is requested we
    // do the same baseline-split the gh path does: empty commit on main,
    // carve the feature branch off it, then snapshot everything onto the
    // feature branch. Without the split, deferred-init sessions (no .git
    // at session-create time per `attach_git_setup`) would land every
    // file on main and the carved branch would diff as empty against it
    // — producing a PR with no changes.
    let (head_rc, _, _) = run(
        "git",
        &["rev-parse", "--verify", "HEAD"],
        folder,
        Duration::from_secs(5),
    )
    .await;
    if head_rc != 0 {
        // Pin HEAD to refs/heads/main BEFORE any commit so a host's
        // `init.defaultBranch=master` doesn't bake the baseline onto a
        // branch the rest of the flow doesn't know about.
        let _ = run(
            "git",
            &["symbolic-ref", "HEAD", "refs/heads/main"],
            folder,
            Duration::from_secs(5),
        )
        .await;
        if let Some(fb) = feature_branch {
            // Baseline on main carries ONLY the .gitignore so the PR diff is the
            // real work, not gitignore noise. The feature branch (carved next)
            // captures everything else; the dirty-commit step below writes a
            // conventional AI message. Parity with create_pr_via_gh. The
            // `--allow-empty` covers a repo with no .gitignore to stage.
            let _ = run(
                "git",
                &["add", ".gitignore"],
                folder,
                Duration::from_secs(10),
            )
            .await;
            let baseline_msg = with_fleetify_trailer("chore: initialize repository");
            let (rc, _, err) = run(
                "git",
                &["commit", "--allow-empty", "-m", &baseline_msg],
                folder,
                Duration::from_secs(30),
            )
            .await;
            if rc != 0 {
                return Some(json!({
                    "ok": false, "code": "INITIAL_COMMIT_FAILED",
                    "error": err.trim()
                }));
            }
            let (rc, _, err) = run(
                "git",
                &["checkout", "-B", fb],
                folder,
                Duration::from_secs(10),
            )
            .await;
            if rc != 0 {
                return Some(json!({
                    "ok": false, "code": "CARVE_FAILED",
                    "error": err.trim()
                }));
            }
            // Work files stay UNCOMMITTED on the feature branch → committed with
            // a conventional AI message by the dirty-commit step below (no more
            // static "Initial commit" / `--allow-empty` churn).
        } else {
            // No feature branch: stage the .gitignore as a chore baseline on the
            // current (main) branch; the dirty-commit step commits the rest with
            // a conventional message.
            let _ = run(
                "git",
                &["add", ".gitignore"],
                folder,
                Duration::from_secs(10),
            )
            .await;
            let baseline_msg = with_fleetify_trailer("chore: initialize repository");
            let (rc, _, err) = run(
                "git",
                &["commit", "--allow-empty", "-m", &baseline_msg],
                folder,
                Duration::from_secs(30),
            )
            .await;
            if rc != 0 {
                return Some(json!({
                    "ok": false, "code": "INITIAL_COMMIT_FAILED",
                    "error": err.trim()
                }));
            }
        }
    } else if let Some(fb) = feature_branch {
        // Repo already has commits — carve only when we're not on it.
        let (rc, cur_out, _) = run(
            "git",
            &["rev-parse", "--abbrev-ref", "HEAD"],
            folder,
            Duration::from_secs(5),
        )
        .await;
        if rc == 0 && cur_out.trim() != fb {
            let (rc, _, err) = run(
                "git",
                &["checkout", "-B", fb],
                folder,
                Duration::from_secs(10),
            )
            .await;
            if rc != 0 {
                return Some(json!({
                    "ok": false, "code": "CARVE_FAILED",
                    "error": err.trim()
                }));
            }
        }
    }
    // Auto-commit dirty working tree (same AI message as gh path).
    let (_, dirty_out, _) = run(
        "git",
        &["status", "--porcelain"],
        folder,
        Duration::from_secs(10),
    )
    .await;
    if !dirty_out.trim().is_empty() {
        let (rc, _, err) = run("git", &["add", "-A"], folder, Duration::from_secs(120)).await;
        if rc != 0 {
            return Some(json!({
                "ok": false, "code": "ADD_FAILED",
                "error": err.trim()
            }));
        }
        let msg_val = super::ai_git::generate_commit_message(
            folder.to_string_lossy().into_owned(),
            tool.map(String::from),
            false,
        )
        .await;
        let msg = msg_val
            .get("message")
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .unwrap_or_else(|| "Working session updates".to_string());
        let commit_msg = with_fleetify_trailer(&msg);
        let (rc, _, err) = run(
            "git",
            &["commit", "-m", &commit_msg],
            folder,
            Duration::from_secs(60),
        )
        .await;
        if rc != 0 {
            return Some(json!({
                "ok": false, "code": "COMMIT_FAILED",
                "error": err.trim()
            }));
        }
    }
    None
}

/// Full faithful port of `createPRViaGh` from main.cjs. Validates and
/// initialises the repo, carves the feature branch, auto-commits any
/// pending changes with an AI-generated message, ensures an `origin`
/// remote (creating a GitHub repo when missing), pushes, runs the AI
/// PR-summary fallback when body is empty, and finally invokes
/// `gh pr create`. Every step gets a trace line in the error message
/// and a tracing breadcrumb so the user can diagnose without log
/// spelunking.
pub async fn create_pr_via_gh(
    folder: &Path,
    title: &str,
    body: Option<&str>,
    base: Option<&str>,
    draft: bool,
    feature_branch: Option<&str>,
    tool: Option<&str>,
) -> Value {
    const HANDLER_VERSION: &str = "rust-v1-2026-05-20";
    if title.trim().is_empty() {
        return json!({
            "ok": false, "code": "NO_TITLE",
            "error": format!("[{HANDLER_VERSION}] title required")
        });
    }
    if !folder.exists() {
        return json!({
            "ok": false, "code": "NO_FOLDER",
            "error": format!("[{HANDLER_VERSION}] folder doesn't exist: {}", folder.display())
        });
    }

    let mut trace: Vec<String> = Vec::new();
    let mut note = |label: &str, ok: bool, detail: &str| {
        let trimmed: String = detail.chars().take(200).collect();
        let line = if trimmed.is_empty() {
            format!("{} · {label}", if ok { "ok" } else { "FAIL" })
        } else {
            format!("{} · {label} · {trimmed}", if ok { "ok" } else { "FAIL" })
        };
        tracing::info!(target: "createPR/gh", "{line}");
        trace.push(line);
    };
    let step_fail = |label: &str, msg: &str, trace: &[String]| -> Value {
        json!({
            "ok": false,
            "code": "GH_STEP_FAILED",
            "error": format!(
                "[{HANDLER_VERSION}] {label}: {msg}\n\nTrace:\n{}",
                trace.join("\n")
            ),
        })
    };

    note("folder", true, &folder.display().to_string());

    // 1. git init (if needed) + write .gitignore template.
    let owns_repo = folder.join(".git").exists();
    note(
        "owns-repo",
        true,
        if owns_repo {
            "yes"
        } else {
            "no — will git init"
        },
    );
    if !owns_repo {
        let (rc, out, err) = run(
            "git",
            &["init", "-b", "main"],
            folder,
            Duration::from_secs(15),
        )
        .await;
        note(
            "git init -b main",
            rc == 0,
            if rc == 0 { out.trim() } else { err.trim() },
        );
        if rc != 0 {
            // Fall back to legacy `git init` for older versions that
            // don't support -b.
            let (rc2, _, err2) = run("git", &["init"], folder, Duration::from_secs(15)).await;
            note("git init (legacy)", rc2 == 0, err2.trim());
            if rc2 != 0 {
                return step_fail("git init", err2.trim(), &trace);
            }
            // Force the default branch to "main" so subsequent steps
            // can assume that name.
            let (cur_rc, cur_out, _) = run(
                "git",
                &["symbolic-ref", "--short", "HEAD"],
                folder,
                Duration::from_secs(5),
            )
            .await;
            if cur_rc == 0 && cur_out.trim() != "main" {
                let _ = run(
                    "git",
                    &["branch", "-m", cur_out.trim(), "main"],
                    folder,
                    Duration::from_secs(5),
                )
                .await;
            }
        }
        let wrote = write_gitignore_if_missing(folder);
        note(
            ".gitignore",
            true,
            if wrote { "created" } else { "exists, skipped" },
        );
    }

    // 2. Seed git identity when missing.
    let (name_rc, name_out, _) = run(
        "git",
        &["config", "--get", "user.name"],
        folder,
        Duration::from_secs(5),
    )
    .await;
    let (email_rc, email_out, _) = run(
        "git",
        &["config", "--get", "user.email"],
        folder,
        Duration::from_secs(5),
    )
    .await;
    if name_rc != 0 || name_out.trim().is_empty() || email_rc != 0 || email_out.trim().is_empty() {
        let (ident_name, ident_email) = resolve_git_identity(folder).await;
        if name_rc != 0 || name_out.trim().is_empty() {
            let _ = run(
                "git",
                &["config", "user.name", &ident_name],
                folder,
                Duration::from_secs(5),
            )
            .await;
            note("seed user.name", true, &ident_name);
        }
        if email_rc != 0 || email_out.trim().is_empty() {
            let _ = run(
                "git",
                &["config", "user.email", &ident_email],
                folder,
                Duration::from_secs(5),
            )
            .await;
            note("seed user.email", true, &ident_email);
        }
    }

    // 3. Initial commit if HEAD doesn't exist.
    let (head_rc, _, _) = run(
        "git",
        &["rev-parse", "--verify", "HEAD"],
        folder,
        Duration::from_secs(5),
    )
    .await;
    let had_head = head_rc == 0;
    note(
        "rev-parse HEAD",
        true,
        if had_head { "exists" } else { "missing" },
    );
    if !had_head {
        // Force HEAD onto refs/heads/main BEFORE the baseline commit.
        // Pre-existing `.git` folders inherit the user's
        // `init.defaultBranch` config — commonly `master` on older
        // installs — and our `git commit` would land the baseline on
        // that branch. `git push --all` then ships `master` to the
        // freshly created GitHub repo as the default branch, and
        // `gh pr create --base main` 404s with "Base ref must be a
        // branch". Re-pointing HEAD on an empty repo costs nothing
        // and makes the rest of the flow assume `main`, matching the
        // fresh-init branch we already pass to `git init -b main`.
        let (sr_rc, _, sr_err) = run(
            "git",
            &["symbolic-ref", "HEAD", "refs/heads/main"],
            folder,
            Duration::from_secs(5),
        )
        .await;
        note(
            "symbolic-ref HEAD → main",
            sr_rc == 0,
            if sr_rc == 0 { "ok" } else { sr_err.trim() },
        );
        if let Some(fb) = feature_branch {
            // Baseline on main carries ONLY the .gitignore so the PR diff is
            // the actual work, not gitignore noise. The feature branch (carved
            // next) then captures everything else. `--allow-empty` covers a
            // repo with no .gitignore to stage.
            let _ = run(
                "git",
                &["add", ".gitignore"],
                folder,
                Duration::from_secs(10),
            )
            .await;
            let baseline_msg = with_fleetify_trailer("chore: initialize repository");
            let (rc, _, err) = run(
                "git",
                &["commit", "--allow-empty", "-m", &baseline_msg],
                folder,
                Duration::from_secs(30),
            )
            .await;
            note("baseline commit (main)", rc == 0, err.trim());
            if rc != 0 {
                return step_fail("baseline commit", err.trim(), &trace);
            }
            let (rc, _, err) = run(
                "git",
                &["checkout", "-B", fb],
                folder,
                Duration::from_secs(10),
            )
            .await;
            note(&format!("checkout -B {fb}"), rc == 0, err.trim());
            if rc != 0 {
                return step_fail(&format!("checkout -B {fb}"), err.trim(), &trace);
            }
            // The work files stay UNCOMMITTED on the feature branch — the
            // auto-commit step below commits them with a conventional AI
            // message (so a fresh repo's first PR reads `feat: …` rather than a
            // static "Initial commit").
        } else {
            let (_, _, _) = run("git", &["add", "-A"], folder, Duration::from_secs(120)).await;
            let init_msg = with_fleetify_trailer("Initial commit");
            let (rc, _, err) = run(
                "git",
                &["commit", "--allow-empty", "-m", &init_msg],
                folder,
                Duration::from_secs(30),
            )
            .await;
            note("initial commit", rc == 0, err.trim());
            if rc != 0 {
                return step_fail("initial commit", err.trim(), &trace);
            }
        }
    } else if let Some(fb) = feature_branch {
        // Does a remote exist yet? Decides whether this is the repo's FIRST PR
        // (local-only history → re-baseline so the PR has a diff) or an
        // established repo (carve the feature branch off the current HEAD).
        let (origin_rc, _, _) = run(
            "git",
            &["remote", "get-url", "origin"],
            folder,
            Duration::from_secs(5),
        )
        .await;
        if origin_rc != 0 {
            // FIRST PR for a local-only repo. The work is committed on `main`
            // (or pending in the tree), so a branch carved off HEAD would equal
            // main → "No commits between". Re-baseline: `main` carries ONLY the
            // .gitignore; the feature branch then captures ALL the content as
            // the work. File CONTENT is preserved in the working tree — only the
            // purely-local commit history is rebuilt.
            let (rc, _, err) = run(
                "git",
                &["checkout", "--orphan", "__fleet_base__"],
                folder,
                Duration::from_secs(10),
            )
            .await;
            note("orphan base", rc == 0, err.trim());
            if rc != 0 {
                return step_fail("orphan base", err.trim(), &trace);
            }
            // Unstage everything the orphan carried over, then keep only the
            // .gitignore for the baseline commit on main.
            let _ = run(
                "git",
                &["rm", "-rf", "--cached", "."],
                folder,
                Duration::from_secs(60),
            )
            .await;
            let _ = run(
                "git",
                &["add", ".gitignore"],
                folder,
                Duration::from_secs(10),
            )
            .await;
            let baseline_msg = with_fleetify_trailer("chore: initialize repository");
            let (rc, _, err) = run(
                "git",
                &["commit", "--allow-empty", "-m", &baseline_msg],
                folder,
                Duration::from_secs(30),
            )
            .await;
            note("baseline commit (main)", rc == 0, err.trim());
            if rc != 0 {
                return step_fail("baseline commit", err.trim(), &trace);
            }
            // Force the baseline to become `main` (replacing the old local main).
            let (rc, _, err) = run(
                "git",
                &["branch", "-M", "main"],
                folder,
                Duration::from_secs(10),
            )
            .await;
            note("git branch -M main", rc == 0, err.trim());
            if rc != 0 {
                return step_fail("branch -M main", err.trim(), &trace);
            }
            // Carve the feature branch off the baseline; the work files are now
            // untracked → the auto-commit step below commits them.
            let (rc, _, err) = run(
                "git",
                &["checkout", "-b", fb],
                folder,
                Duration::from_secs(10),
            )
            .await;
            note(&format!("checkout -b {fb}"), rc == 0, err.trim());
            if rc != 0 {
                return step_fail(&format!("checkout -b {fb}"), err.trim(), &trace);
            }
        } else {
            // Established repo — carve off HEAD only when not already on it.
            let (rc, cur_out, _) = run(
                "git",
                &["rev-parse", "--abbrev-ref", "HEAD"],
                folder,
                Duration::from_secs(5),
            )
            .await;
            let cur = cur_out.trim().to_string();
            note("current branch", rc == 0, &cur);
            if rc == 0 && cur != fb {
                let (rc, _, err) = run(
                    "git",
                    &["checkout", "-B", fb],
                    folder,
                    Duration::from_secs(10),
                )
                .await;
                note(&format!("checkout -B {fb}"), rc == 0, err.trim());
                if rc != 0 {
                    return step_fail(&format!("checkout -B {fb}"), err.trim(), &trace);
                }
            }
        }
    }

    // 4. Auto-commit pending working-tree changes.
    let (_, dirty_out, _) = run(
        "git",
        &["status", "--porcelain"],
        folder,
        Duration::from_secs(10),
    )
    .await;
    let is_dirty = !dirty_out.trim().is_empty();
    if is_dirty {
        let n = dirty_out.lines().count();
        note("working tree dirty", true, &format!("{n} entries"));
        let (rc, _, err) = run("git", &["add", "-A"], folder, Duration::from_secs(120)).await;
        note("git add -A (pre-push)", rc == 0, err.trim());
        if rc != 0 {
            return step_fail("git add", err.trim(), &trace);
        }
        // AI-generated commit message via shell::ai_git. Falls back to
        // a static description when claude/codex/gemini CLIs aren't
        // available — never blocks the PR on a missing CLI.
        let is_initial = !owns_repo && !had_head;
        let msg = match super::ai_git::generate_commit_message(
            folder.to_string_lossy().into_owned(),
            tool.map(String::from),
            is_initial,
        )
        .await
        .get("message")
        .and_then(|v| v.as_str())
        {
            Some(m) if !m.trim().is_empty() => m.to_string(),
            _ => "Working session updates".to_string(),
        };
        note("commit message", true, &msg);
        let commit_msg = with_fleetify_trailer(&msg);
        let (rc, _, err) = run(
            "git",
            &["commit", "-m", &commit_msg],
            folder,
            Duration::from_secs(60),
        )
        .await;
        note("auto-commit", rc == 0, err.trim());
        if rc != 0 {
            return step_fail("auto-commit", err.trim(), &trace);
        }
    } else {
        note("working tree clean", true, "nothing to auto-commit");
    }

    // 4b. Bail BEFORE touching the remote when the feature branch has no
    // commits ahead of `main` — nothing to PR. Returning here avoids leaving a
    // freshly-created GitHub repo + a stuck `origin` behind on an empty diff.
    if let Some(fb) = feature_branch {
        let (rc, ahead, _) = run(
            "git",
            &["rev-list", "--count", &format!("main..{fb}")],
            folder,
            Duration::from_secs(10),
        )
        .await;
        if rc == 0 && ahead.trim() == "0" {
            note("no diff", false, "branch has no commits ahead of main");
            return json!({
                "ok": false,
                "code": "NO_DIFF",
                "error": "No changes to open a pull request — the session has no edits to commit. Make some changes first, then try again."
            });
        }
    }

    // 5. Ensure `origin` remote — create the GitHub repo on the fly
    //    when missing.
    let (probe_rc, probe_out, probe_err) = run(
        "git",
        &["remote", "get-url", "origin"],
        folder,
        Duration::from_secs(5),
    )
    .await;
    let has_remote = probe_rc == 0 && !probe_out.trim().is_empty();
    note(
        "probe origin",
        has_remote,
        if has_remote {
            probe_out.trim()
        } else {
            probe_err.trim()
        },
    );
    if !has_remote {
        // Derive a repo name from the folder basename — clamp to a
        // safe charset + length.
        let basename = folder
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("fleet-project");
        let mut repo_name: String = basename
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' {
                    c
                } else {
                    '-'
                }
            })
            .collect();
        if repo_name.len() > 80 {
            repo_name.truncate(80);
        }
        if repo_name.is_empty() {
            repo_name = "fleet-project".into();
        }
        // Avoid colliding with a repo the user already owns: `gh repo view
        // <name>` returns rc==0 when it exists. Append -1, -2, … until free,
        // so a second "test_a" project opens "test_a-1" instead of failing on
        // (or silently reusing) the existing repo.
        {
            let base_name = repo_name.clone();
            let mut attempt = 0u32;
            loop {
                let (view_rc, _, _) = gh(&["repo", "view", &repo_name], folder).await;
                if view_rc != 0 {
                    break; // doesn't exist → free to create
                }
                attempt += 1;
                if attempt > 30 {
                    break; // safety: let gh repo create surface any leftover collision
                }
                repo_name = format!("{base_name}-{attempt}");
            }
        }
        note("repo name", true, &repo_name);
        let (rc, out, err) = gh(
            &[
                "repo",
                "create",
                &repo_name,
                "--source",
                ".",
                "--private",
                "--remote",
                "origin",
            ],
            folder,
        )
        .await;
        note(
            "gh repo create",
            rc == 0,
            if rc == 0 { out.trim() } else { err.trim() },
        );
        if rc != 0 {
            return step_fail(
                "gh repo create",
                if err.trim().is_empty() {
                    "Couldn't create the GitHub repo automatically. Run `gh auth status` to verify you're signed in."
                } else {
                    err.trim()
                },
                &trace,
            );
        }
        let (rc, out, err) = run(
            "git",
            &["push", "-u", "origin", "--all"],
            folder,
            Duration::from_secs(120),
        )
        .await;
        note(
            "push --all",
            rc == 0,
            if rc == 0 { out.trim() } else { err.trim() },
        );
        if rc != 0 {
            return step_fail("git push --all", err.trim(), &trace);
        }
    } else {
        let (rc, _, err) = run(
            "git",
            &["push", "-u", "origin", "HEAD"],
            folder,
            Duration::from_secs(60),
        )
        .await;
        note("push HEAD", rc == 0, err.trim());
        if rc != 0 {
            return step_fail("git push", err.trim(), &trace);
        }
    }

    // 5b. Upfront PR existence probe. `gh pr view --json number,url,state`
    // resolves the PR for the current branch — if one exists and is
    // open, we skip the 12-25s AI summary + the noisy "FAIL · gh pr
    // create" recovery branch and return `existed:true` straight away.
    // The renderer's optimistic Merge flip handles the rest.
    {
        let (rc_view, out_view, _) =
            gh(&["pr", "view", "--json", "number,url,state"], folder).await;
        if rc_view == 0 {
            if let Ok(v) = serde_json::from_str::<Value>(out_view.trim()) {
                let num = v.get("number").and_then(|x| x.as_i64());
                let state = v.get("state").and_then(|x| x.as_str()).unwrap_or("");
                let url = v
                    .get("url")
                    .and_then(|x| x.as_str())
                    .map(String::from)
                    .unwrap_or_default();
                if let Some(n) = num {
                    if state.eq_ignore_ascii_case("OPEN") {
                        note(
                            "existed PR (pre-check)",
                            true,
                            &format!("#{n} — already open, skipping create"),
                        );
                        return json!({
                            "ok": true, "prNumber": n, "prUrl": url, "existed": true
                        });
                    }
                }
            }
        }
    }

    // 6. AI-generate PR title/body when body is empty.
    let mut final_title = title.to_string();
    let mut final_body = body.unwrap_or("").to_string();
    if final_body.is_empty() && tool.is_some() {
        let summary = super::ai_git::generate_pr_summary(
            folder.to_string_lossy().into_owned(),
            base.map(String::from),
            tool.map(String::from),
        )
        .await;
        if summary.get("ok").and_then(|v| v.as_bool()) == Some(true) {
            if let Some(t) = summary.get("title").and_then(|v| v.as_str()) {
                if !t.is_empty() {
                    final_title = t.to_string();
                }
            }
            if let Some(b) = summary.get("body").and_then(|v| v.as_str()) {
                if !b.is_empty() {
                    final_body = b.to_string();
                }
            }
            note(
                "ai PR summary",
                true,
                &format!(
                    "title={}c body={}c",
                    final_title.chars().count(),
                    final_body.chars().count()
                ),
            );
        } else {
            note(
                "ai PR summary",
                false,
                summary
                    .get("error")
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown"),
            );
        }
    }

    let body_with_footer = with_fleetify_footer(&final_body);

    // 7. gh pr create.
    let mut args: Vec<String> = vec![
        "pr".into(),
        "create".into(),
        "--title".into(),
        final_title.clone(),
        "--body".into(),
        body_with_footer.clone(),
    ];
    if let Some(b) = base {
        args.push("--base".into());
        args.push(b.into());
    }
    if draft {
        args.push("--draft".into());
    }
    let argv: Vec<&str> = args.iter().map(String::as_str).collect();
    let (rc, out, err) = gh(&argv, folder).await;
    note(
        "gh pr create",
        rc == 0,
        if rc == 0 { out.trim() } else { err.trim() },
    );
    if rc != 0 {
        // Parse a "PR already exists" hint out of stderr.
        let combined = format!("{err}\n{out}");
        if let Some(cap) = combined.find("/pull/") {
            let after = &combined[cap..];
            let end = after
                .find(|c: char| !c.is_ascii_digit() && c != '/' && c != 'l' && c != 'u' && c != 'p')
                .unwrap_or(after.len());
            let pr_path = &after[..end];
            if let Some(num_str) = pr_path.strip_prefix("/pull/") {
                let num_str: String = num_str.chars().take_while(|c| c.is_ascii_digit()).collect();
                if let Ok(num) = num_str.parse::<i64>() {
                    // Find the full URL containing this segment.
                    let url = combined
                        .lines()
                        .find_map(|l| {
                            if l.contains(&format!("/pull/{num}")) {
                                Some(l.trim().to_string())
                            } else {
                                None
                            }
                        })
                        .unwrap_or_default();
                    // Tag the trace so the recovery is visible — the
                    // "FAIL · gh pr create" line above made this case
                    // look broken even when the renderer ultimately
                    // flips to Merge.
                    note(
                        "existed PR",
                        true,
                        &format!("#{num} — already open, recovered"),
                    );
                    return json!({
                        "ok": true, "prNumber": num, "prUrl": url, "existed": true
                    });
                }
            }
        }
        // No diff between head and base — GitHub refuses an empty PR. Map the
        // raw GraphQL "No commits between …" error to a clear, actionable one.
        if combined.contains("No commits between") {
            note("no diff", false, "branch has no commits ahead of base");
            return json!({
                "ok": false,
                "code": "NO_DIFF",
                "error": "No changes to open a pull request — this branch has no commits ahead of the base. Make some edits in the session (or commit pending changes), then try again."
            });
        }
        return json!({
            "ok": false,
            "code": "GH_FAILED",
            "error": format!(
                "[{HANDLER_VERSION}] gh pr create: {}\n\nTrace:\n{}",
                if err.trim().is_empty() { "gh pr create failed" } else { err.trim() },
                trace.join("\n")
            ),
        });
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

/// `gh pr list --json number,state,headRefName --limit N`. Lets the
/// BranchPickerMenu show "PR #N · OPEN/MERGED" badges per local
/// branch without paying for one `gh pr view` per row.
pub async fn list_prs(folder: &Path, limit: u32) -> Value {
    let limit_str = limit.to_string();
    let argv: Vec<&str> = vec![
        "pr",
        "list",
        "--state",
        "all",
        "--limit",
        &limit_str,
        "--json",
        "number,state,headRefName,isDraft,mergeable",
    ];
    let (rc, out, err) = gh(&argv, folder).await;
    if rc != 0 {
        return json!({ "ok": false, "error": err.trim() });
    }
    match serde_json::from_str::<Value>(out.trim()) {
        Ok(v) => json!({ "ok": true, "prs": v }),
        Err(e) => json!({ "ok": false, "error": format!("parse: {e}") }),
    }
}

pub async fn get_pr_status(folder: &Path, pr_number: Option<u64>) -> Value {
    // `gh pr view <n>` is deterministic when we already know the
    // number. `gh pr view` WITHOUT a number relies on gh's branch
    // resolution / default-repo heuristic and was observed to be
    // flaky in this app's workflow — sometimes returning empty even
    // when a PR clearly exists for the current branch. The poll's
    // null path then overwrote the BranchStrip's pr state and the
    // strip flickered Create PR ↔ Merge every 15s.
    //
    // For the no-number case we switch to `gh pr list --head <branch>`
    // which filters by head ref explicitly. That's deterministic and
    // doesn't depend on gh's default-repo config. We pick the open
    // PR (preferring OPEN > MERGED > CLOSED) and re-fetch its full
    // shape via `gh pr view <number>` so the renderer still gets the
    // same `checks` summary.
    let field_set = "number,url,state,mergeable,isDraft,baseRefName,headRefName,\
                     statusCheckRollup,commentsCount";
    let resolved_number: Option<u64> = match pr_number {
        Some(n) => Some(n),
        None => {
            let Some(branch) = current_branch_str(folder).await else {
                return json!({ "ok": false, "error": "no current branch" });
            };
            let (rc_l, out_l, err_l) = gh(
                &[
                    "pr",
                    "list",
                    "--head",
                    &branch,
                    "--state",
                    "all",
                    "--limit",
                    "10",
                    "--json",
                    "number,state",
                ],
                folder,
            )
            .await;
            if rc_l != 0 {
                // gh failed — could be transient (network, rate limit,
                // default-repo not set, etc.). Report as a real error so
                // the renderer can hold the current pr state instead of
                // mistakenly clearing it. Earlier this returned
                // `ok:true, pr:null` which the poll treated as "PR was
                // deleted" → Create PR/Merge flicker every 15s.
                return json!({
                    "ok": false,
                    "error": format!("gh pr list --head failed: {}", err_l.trim()),
                });
            }
            let arr: Value = serde_json::from_str(out_l.trim()).unwrap_or(Value::Null);
            let prs = arr.as_array().cloned().unwrap_or_default();
            if prs.is_empty() {
                // gh succeeded AND returned an empty list — branch
                // genuinely has no PR. Safe to clear pr state.
                return json!({ "ok": true, "pr": Value::Null });
            }
            // Prefer OPEN; fall back to whatever's freshest in the list
            // (gh returns newest first).
            prs.iter()
                .find(|p| {
                    p.get("state")
                        .and_then(|v| v.as_str())
                        .is_some_and(|s| s.eq_ignore_ascii_case("OPEN"))
                })
                .or_else(|| prs.first())
                .and_then(|p| p.get("number").and_then(|v| v.as_u64()))
        }
    };
    let Some(n) = resolved_number else {
        return json!({ "ok": true, "pr": Value::Null });
    };
    let n_str = n.to_string();
    let argv: Vec<&str> = vec!["pr", "view", &n_str, "--json", field_set];
    let (rc, out, err) = gh(&argv, folder).await;
    if rc != 0 {
        return json!({ "ok": false, "error": err.trim() });
    }
    let raw: Value = match serde_json::from_str(out.trim()) {
        Ok(v) => v,
        Err(e) => return json!({ "ok": false, "error": format!("parse: {e}") }),
    };
    let Some(number) = raw.get("number").and_then(|v| v.as_i64()) else {
        return json!({ "ok": false, "error": "missing pr.number" });
    };

    // Aggregate statusCheckRollup → counters. Mirrors summarizePR in
    // frontend/electron/main.cjs:1690 so the renderer's Merge gate
    // (`pr.checks.failing > 0`, `pr.checks.pending > 0`) keeps working.
    let mut passing = 0u32;
    let mut failing = 0u32;
    let mut pending = 0u32;
    let rollup: &[Value] = raw
        .get("statusCheckRollup")
        .and_then(|v| v.as_array())
        .map(|v| v.as_slice())
        .unwrap_or(&[]);
    for c in rollup {
        let status = c
            .get("status")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_uppercase();
        let concl = c
            .get("conclusion")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_uppercase();
        if status == "COMPLETED" {
            match concl.as_str() {
                "SUCCESS" => passing += 1,
                "FAILURE" | "TIMED_OUT" | "CANCELLED" => failing += 1,
                _ => pending += 1, // skipped / neutral / action_required
            }
        } else {
            pending += 1; // queued / in_progress
        }
    }

    let pr = json!({
        "number": number,
        "url": raw.get("url"),
        "state": raw.get("state"),
        "mergeable": raw.get("mergeable"),
        "isDraft": raw.get("isDraft").and_then(|v| v.as_bool()).unwrap_or(false),
        "baseRefName": raw.get("baseRefName"),
        "headRefName": raw.get("headRefName"),
        "checks": {
            "passing": passing,
            "failing": failing,
            "pending": pending,
            "total": rollup.len(),
        },
        "commentsCount": raw.get("commentsCount").and_then(|v| v.as_i64()).unwrap_or(0),
    });
    json!({ "ok": true, "pr": pr })
}

/// `gh pr ready <number>` — flips a draft PR to "ready for review".
/// Used by the BranchStrip's Merge handler so a single click can
/// undraft + squash-merge in sequence.
///
/// Idempotent: `gh` exits non-zero when the PR is already ready, so we
/// treat that stderr ("already ... ready for review") as success.
/// Lets `onMerge` call this unconditionally without caring whether
/// the local `pr.isDraft` flag is fresh or stale.
pub async fn pr_ready(folder: &Path, pr_number: u64) -> Value {
    let n = pr_number.to_string();
    let (rc, _o, err) = gh(&["pr", "ready", &n], folder).await;
    if rc == 0 {
        return json!({ "ok": true });
    }
    let e = err.trim();
    let lower = e.to_lowercase();
    if lower.contains("ready for review") || lower.contains("already") {
        return json!({ "ok": true, "noop": true });
    }
    json!({ "ok": false, "error": e })
}

pub async fn merge_pr(folder: &Path, pr_number: u64, method: &str) -> Value {
    let flag = match method {
        "rebase" => "--rebase",
        "squash" => "--squash",
        _ => "--merge",
    };
    let n = pr_number.to_string();
    let (rc, _o, err) = gh(&["pr", "merge", &n, flag, "--delete-branch"], folder).await;
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
    // 1. User-set per-repo override (`git config fleetify.baseBranch`) —
    //    the "Create new main branch" picker action writes this so the
    //    UI / Create-PR / branch carve all converge on the chosen base
    //    without touching the actual remote `HEAD` ref or collaborators'
    //    clones. Only honour it when the branch still exists locally.
    let (rc, out, _) = git(&["config", "--get", "fleetify.baseBranch"], folder).await;
    if rc == 0 && !out.trim().is_empty() {
        let candidate = out.trim().to_string();
        let (rc_v, _, _) = git(
            &[
                "rev-parse",
                "--verify",
                "--quiet",
                &format!("refs/heads/{candidate}"),
            ],
            folder,
        )
        .await;
        if rc_v == 0 {
            return Some(candidate);
        }
    }
    // 2. Server-declared default via origin/HEAD.
    let (rc, out, _) = git(
        &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
        folder,
    )
    .await;
    if rc == 0 && !out.trim().is_empty() {
        let v = out.trim();
        return Some(
            v.split_once('/')
                .map(|(_, b)| b.to_string())
                .unwrap_or_else(|| v.to_string()),
        );
    }
    // 3. Local fallbacks.
    for c in ["main", "master"] {
        let (rc2, _, _) = git(
            &[
                "rev-parse",
                "--verify",
                "--quiet",
                &format!("refs/heads/{c}"),
            ],
            folder,
        )
        .await;
        if rc2 == 0 {
            return Some(c.into());
        }
    }
    None
}

/// Create (or reuse) a branch and pin it as this clone's logical base
/// via `git config fleetify.baseBranch`. Drives the "Create new main
/// branch" picker action: nondestructive — does not push, rename, or
/// touch `refs/remotes/origin/HEAD`, so collaborators / the GitHub
/// repo's default branch stay exactly as they were.
///
/// • If `new_branch` already exists, just promote it.
/// • Otherwise carve it from the currently-detected base (or `HEAD`
///   if there isn't one yet — a fresh repo with no remote).
pub async fn set_base_branch(folder: &Path, new_branch: &str) -> Value {
    let trimmed = new_branch.trim();
    if trimmed.is_empty() {
        return json!({ "ok": false, "error": "branch name is required" });
    }
    // Cheap sanity gate: git ref-name rules forbid spaces, control
    // chars, leading dashes, and a few punctuation runs. Reject the
    // obvious garbage here so the user gets a clear message instead
    // of git's tersewall ("fatal: 'foo bar' is not a valid branch name").
    if trimmed.contains(|c: char| c.is_whitespace() || c.is_control())
        || trimmed.starts_with('-')
        || trimmed.contains("..")
        || trimmed.contains('~')
        || trimmed.contains('^')
        || trimmed.contains(':')
        || trimmed.contains('?')
        || trimmed.contains('*')
        || trimmed.contains('[')
        || trimmed.contains('\\')
        || trimmed.ends_with('/')
        || trimmed.ends_with(".lock")
    {
        return json!({
            "ok": false,
            "error": format!("'{trimmed}' isn't a valid git branch name")
        });
    }

    let (rc_exists, _, _) = git(
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("refs/heads/{trimmed}"),
        ],
        folder,
    )
    .await;
    if rc_exists != 0 {
        // Carve from the currently-detected base, or HEAD as a last
        // resort. Falling back to HEAD covers the "fresh init, no remote,
        // no main yet" case — gives the user *something* to branch off.
        let from = detect_default_branch(folder)
            .await
            .unwrap_or_else(|| "HEAD".to_string());
        let (rc, _, err) = git(&["branch", trimmed, &from], folder).await;
        if rc != 0 {
            return json!({
                "ok": false,
                "error": format!("git branch {trimmed} {from}: {}", err.trim())
            });
        }
    }
    let (rc_cfg, _, err) = git(&["config", "fleetify.baseBranch", trimmed], folder).await;
    if rc_cfg != 0 {
        return json!({
            "ok": false,
            "error": format!("git config fleetify.baseBranch: {}", err.trim())
        });
    }
    json!({ "ok": true, "base": trimmed })
}

/// `git fetch origin` + checkout base + ff-pull + return to original branch
/// (parity with main.cjs's syncMain — refreshes the local base branch
/// without leaving the user stranded on it).
pub async fn sync_main(folder: &Path, base: &str) -> Value {
    let prev = current_branch_str(folder)
        .await
        .unwrap_or_else(|| "HEAD".to_string());
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

/// Carve a new feature branch from `base`. Best-effort fetches the
/// latest `origin/<base>` first so the new branch starts at the freshest
/// commit instead of a stale local base — equivalent semantically to
/// "merge main into the new branch" without needing the local base to
/// be clean or fast-forward-able. Falls back to the local base when
/// origin is missing / offline / the fetch fails. `--no-track` keeps
/// the feature branch from latching onto origin/main and pulling main
/// commits on a later `git pull`.
pub async fn carve_next_round(folder: &Path, branch: &str, base: &str) -> Value {
    // Try to refresh the base from origin. Failure is non-fatal — `origin`
    // may not exist yet (fresh repo, no remote), the fetch may time out,
    // or the user may be offline. We just decide downstream whether to
    // carve from origin/<base> (if rev-parse confirms the ref landed) or
    // fall back to local <base>.
    let _ = git(&["fetch", "origin", base], folder).await;
    let (rc_ref, _, _) = git(
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("refs/remotes/origin/{base}"),
        ],
        folder,
    )
    .await;
    let fetched_remote = rc_ref == 0;
    let from = if fetched_remote {
        format!("origin/{base}")
    } else {
        base.to_string()
    };

    let (rc, _o, err) = git(&["checkout", "--no-track", "-b", branch, &from], folder).await;
    if rc == 0 {
        json!({
            "ok": true,
            "branch": branch,
            "base": base,
            "fetchedRemote": fetched_remote,
        })
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
    if !fleetify_backend::services::worktree::is_git_repo(&path).await {
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

pub(crate) async fn current_branch_str(folder: &Path) -> Option<String> {
    let (rc, out, _) = git(&["rev-parse", "--abbrev-ref", "HEAD"], folder).await;
    let v = out.trim().to_string();
    if rc != 0 || v.is_empty() || v == "HEAD" {
        None
    } else {
        Some(v)
    }
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
        if fleetify_backend::services::worktree::is_git_repo(&tmp.path().to_string_lossy()).await {
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
        assert!(kinds.contains(&"nested-no-commits"));
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
        assert_eq!(
            current_branch_str(tmp.path()).await.as_deref(),
            Some("fleet/x-y")
        );
    }

    #[tokio::test]
    async fn link_bootstrap_puts_gitignore_on_main_as_chore() {
        if !git_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        // Skip if an ancestor repo would mask our fresh-init state.
        if fleetify_backend::services::worktree::is_git_repo(&tmp.path().to_string_lossy()).await {
            return;
        }
        let res = ensure_repo_for_link(
            tmp.path(),
            "My Feature",
            Some("main"),
            Some("fleet/x-ab12"),
            None,
        )
        .await;
        assert!(res.is_none(), "bootstrap should succeed: {res:?}");
        // .gitignore is committed on MAIN with a conventional `chore:` subject.
        let (_, subj, _) = git(
            &["log", "main", "-1", "--format=%s", "--", ".gitignore"],
            tmp.path(),
        )
        .await;
        assert!(
            subj.to_lowercase().contains("chore"),
            "gitignore commit on main must be conventional: {subj:?}"
        );
        // .gitignore lives on main's tree (not only the feature branch).
        let (_, tree_main, _) = git(&["ls-tree", "--name-only", "main"], tmp.path()).await;
        assert!(
            tree_main.contains(".gitignore"),
            ".gitignore must be on main: {tree_main:?}"
        );
        // The session ended on the carved feature branch.
        assert_eq!(
            current_branch_str(tmp.path()).await.as_deref(),
            Some("fleet/x-ab12")
        );
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
        if fleetify_backend::services::worktree::is_git_repo(&path).await {
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
