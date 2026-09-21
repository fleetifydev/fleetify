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

/// The MAIN repo working-tree root for `folder`. For a linked git worktree
/// this is the PRIMARY checkout (resolved via the shared common git dir),
/// never the worktree — repo-level bootstrap (gh repo create, repo naming,
/// origin setup) must target it, because a worktree's `.git` is a file pointer
/// that `gh repo create --source` rejects. For a normal checkout it returns
/// `folder` unchanged.
pub async fn main_worktree_root(folder: &Path) -> std::path::PathBuf {
    let (rc, out, _) = git(
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        folder,
    )
    .await;
    if rc == 0 {
        let common = out.trim();
        if !common.is_empty() {
            if let Some(parent) = std::path::Path::new(common).parent() {
                if !parent.as_os_str().is_empty() {
                    return parent.to_path_buf();
                }
            }
        }
    }
    folder.to_path_buf()
}

/// True when `folder` is a LINKED git worktree (its `.git` is a file pointer)
/// rather than a primary checkout (`.git` is a directory). Used to skip
/// post-merge local base-checkout/branch-delete that fails in a worktree
/// because the base branch is checked out in the main repo.
pub fn is_linked_worktree(folder: &Path) -> bool {
    folder.join(".git").is_file()
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

/// List every repo the authenticated user can reach — repos they own,
/// repos they collaborate on, AND repos in their organizations — as the raw
/// GitHub REST `/user/repos` JSON array.
///
/// We deliberately do NOT use `gh repo list`: with no `<owner>` argument it
/// only returns repos *owned by the authenticated account* and silently
/// drops every organization repo, so org members never saw their org repos
/// in the picker. The REST endpoint with an explicit `affiliation` filter
/// returns all three classes in one call. Auth is whatever `gh()` resolves —
/// the OAuth keychain token (injected as `GH_TOKEN`) or gh's own login.
///
/// Returns `(rc, stdout, stderr)`; rc != 0 means gh failed (often unauthed).
/// The stdout uses REST field names (`full_name`, `html_url`, …) — the caller
/// maps them into the renderer's `GhRepo` shape via `parse_gh_api_repos`.
/// Requires the gh binary — callers gate on `resolve_gh()`.
pub async fn gh_repo_list() -> (i32, String, String) {
    let cwd = std::env::current_dir().unwrap_or_else(|_| ".".into());
    gh(
        &[
            "api",
            "user/repos?affiliation=owner,collaborator,organization_member&sort=updated&per_page=100",
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

/// Parse `git rev-list --left-right --count <base>...origin/<base>` output
/// ("<ahead>\t<behind>") into the number of commits the local base branch is
/// BEHIND its remote — but ONLY when a pure fast-forward is possible (no
/// local-only commits ahead). Returns 0 when the base is diverged (ahead > 0,
/// where `git pull --ff-only` would reject the sync, so the UI must not offer
/// it) or on any parse failure. Pure (no git/IO) so it unit-tests directly.
fn behind_if_fast_forward(left_right: &str) -> i64 {
    let mut it = left_right.split_whitespace();
    let ahead = it.next().and_then(|s| s.parse::<i64>().ok()).unwrap_or(0);
    let behind = it.next().and_then(|s| s.parse::<i64>().ok()).unwrap_or(0);
    if ahead == 0 {
        behind
    } else {
        0
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

    // How far the local base branch is behind its remote tracking branch. This
    // is the honest signal for offering a "Sync <base>" action (replacing the
    // old proxy of "your PR is MERGED"). Computed fetch-free against the
    // last-known `origin/<base>` — the renderer refreshes it with an on-focus
    // fetch — and only when a pure fast-forward is possible (see
    // `behind_if_fast_forward`), so we never advertise a sync `--ff-only` would
    // reject. Uses the DETECTED base name; never assumes "main".
    let mut base_behind: i64 = 0;
    if let Some(b) = &base {
        let (rc_lr, lr, _) = git(
            &[
                "rev-list",
                "--left-right",
                "--count",
                &format!("{b}...origin/{b}"),
            ],
            folder,
        )
        .await;
        if rc_lr == 0 {
            base_behind = behind_if_fast_forward(&lr);
        }
    }

    json!({
        "branch": branch_v,
        "baseBranch": base.map(Value::String).unwrap_or(Value::Null),
        "plus": plus,
        "minus": minus,
        "baseBehind": base_behind,
        "remoteHttpsUrl": remote_https.map(Value::String).unwrap_or(Value::Null),
    })
}

/// Lightweight live diff for the hover preview: the current branch plus the
/// UNCOMMITTED working-tree change count (`git diff HEAD --numstat`, staged +
/// unstaged). Two git calls run concurrently, so it stays cheap enough to poll
/// at a tight interval — unlike the full `get_context`, which also resolves the
/// remote, the default branch, and the committed base...HEAD diff.
pub async fn working_diff(folder: &Path) -> Value {
    let (branch_res, diff_res) = tokio::join!(
        git(&["rev-parse", "--abbrev-ref", "HEAD"], folder),
        git(&["diff", "HEAD", "--numstat"], folder),
    );

    let (rc_b, branch, _) = branch_res;
    let branch_v = if rc_b != 0 {
        Value::Null
    } else {
        let b = branch.trim();
        if b.is_empty() || b == "HEAD" {
            Value::Null
        } else {
            json!(b)
        }
    };

    let (rc_w, wnum, _) = diff_res;
    let (mut plus, mut minus) = (0i64, 0i64);
    if rc_w == 0 {
        for line in wnum.lines() {
            let mut it = line.split_whitespace();
            if let (Some(p), Some(m)) = (it.next(), it.next()) {
                plus += p.parse::<i64>().unwrap_or(0);
                minus += m.parse::<i64>().unwrap_or(0);
            }
        }
    }

    json!({ "branch": branch_v, "plus": plus, "minus": minus })
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
    // `%(symref)` is emitted alongside the name so symbolic refs can be
    // dropped below. `refs/remotes/<remote>/HEAD` is the one that matters:
    // `%(refname:short)` shortens it to the BARE remote name ("origin"),
    // which is not a branch and cannot be checked out into one.
    let (rc2, remote, _) = git(
        &[
            "for-each-ref",
            "--format=%(refname:short)%09%(symref)",
            "refs/remotes",
        ],
        folder,
    )
    .await;
    if rc1 != 0 || rc2 != 0 {
        return json!({ "error": "not a git repository" });
    }
    // The branch HEAD is on. Empty on a detached HEAD (rc still 0), which
    // maps to null so the renderer can fall back sensibly. This key was
    // simply never emitted before — every consumer modelled `current` and
    // permanently received null, so the branch chip showed "—" for every
    // repo that was in fact sitting on main.
    let (rc3, cur, _) = git(&["branch", "--show-current"], folder).await;
    let current = cur.trim().to_string();
    let split = |s: String| -> Vec<String> {
        s.lines()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .collect()
    };
    // Remote refs carry a trailing tab + symref target. A non-empty target
    // means the ref is a pointer (origin/HEAD -> origin/main), not a branch,
    // so it never belongs in a list the branch picker offers to check out.
    let split_remote = |s: String| -> Vec<String> {
        s.lines()
            .filter_map(|l| {
                let mut parts = l.splitn(2, '\t');
                let name = parts.next().unwrap_or("").trim();
                let symref = parts.next().unwrap_or("").trim();
                if name.is_empty() || !symref.is_empty() {
                    None
                } else {
                    Some(name.to_string())
                }
            })
            .collect()
    };
    json!({
        "local": split(local),
        "remote": split_remote(remote),
        "current": if rc3 == 0 && !current.is_empty() { json!(current) } else { json!(null) },
    })
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

/// The NOAUTH dev stub identity (see [`crate::shell::auth`]): a synthetic
/// "John Doe <john.doe@fleetify.local>" the desktop UI signs in as when
/// `FLEETIFY_NOAUTH=1`. It is NOT a real committer and must never reach a
/// repo's git config — otherwise every commit made in that working tree
/// (the snapshot-before-archive in `sidebar.tsx`, agent commits, and the
/// developer's own commits) is attributed to "John Doe". GitHub's
/// squash-merge then folds that author into a phantom `Co-authored-by:`
/// trailer, which is why merged PRs showed "3 people".
const NOAUTH_STUB_EMAIL: &str = "john.doe@fleetify.local";

pub async fn ensure_repo(folder: &Path, name: Option<&str>, email: Option<&str>) -> Value {
    let path = folder.to_string_lossy().to_string();

    // Snapshot the repo's *local* committer identity BEFORE auto-init can
    // seed a placeholder. A non-empty value here means the repo already
    // carries an identity of its own that we must never overwrite. (Global
    // scope is excluded on purpose: a global identity is a fine fallback
    // and isn't ours to replace at the repo level.)
    let had_name = !git(&["config", "--local", "--get", "user.name"], folder)
        .await
        .1
        .trim()
        .is_empty();
    let had_email = !git(&["config", "--local", "--get", "user.email"], folder)
        .await
        .1
        .trim()
        .is_empty();

    // Delegate to fleet-backend's faithful auto-init (init -b main +
    // identity seed + .gitignore + initial commit).
    let _ = fleetify_backend::services::worktree::ensure_git_repo(&path).await;

    // Apply the caller's identity ONLY to seed a repo that had no local
    // identity of its own, and NEVER write the NOAUTH "John Doe" stub —
    // the two rules that keep "John Doe" out of real commit history.
    let is_noauth_stub = matches!(
        email.map(str::trim),
        Some(e) if e.eq_ignore_ascii_case(NOAUTH_STUB_EMAIL)
    );
    if !is_noauth_stub {
        if !had_name {
            if let Some(n) = name.map(str::trim).filter(|n| !n.is_empty()) {
                let _ = git(&["config", "user.name", n], folder).await;
            }
        }
        if !had_email {
            if let Some(e) = email.map(str::trim).filter(|e| !e.is_empty()) {
                let _ = git(&["config", "user.email", e], folder).await;
            }
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

/// Browser target for "Open PR": the exact `/pull/<n>` page when the
/// caller knows the PR number, the repo's `/pulls` list as the last
/// resort (no PR exists yet, or resolution failed).
fn pr_page_url(repo_url: &str, pr_number: Option<i64>) -> String {
    match pr_number {
        Some(n) => format!("{repo_url}/pull/{n}"),
        None => format!("{repo_url}/pulls"),
    }
}

pub async fn open_pr(folder: &Path, pr_number: Option<i64>) -> Value {
    let (rc, remote, _) = git(&["remote", "get-url", "origin"], folder).await;
    if rc != 0 {
        return json!({ "ok": false, "error": "no origin remote" });
    }
    let mut url = ssh_to_https(remote.trim());
    if let Some(stripped) = url.strip_suffix(".git") {
        url = stripped.to_string();
    }
    // Callers that know the PR number (BranchStrip's Open buttons, the
    // PR dialog) land on the exact /pull/<n> page. Number-less callers
    // (Cmd+Shift+G shortcut, legacy paths) get one `gh pr view` attempt
    // to resolve the current branch's PR before the /pulls fallback.
    let target = if pr_number.is_some() {
        pr_page_url(&url, pr_number)
    } else {
        let (grc, gout, _) = gh(&["pr", "view", "--json", "url", "-q", ".url"], folder).await;
        let resolved = gout.trim();
        if grc == 0 && resolved.starts_with("http") {
            resolved.to_string()
        } else {
            pr_page_url(&url, None)
        }
    };
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
                # Env\n.env\n.env.local\n.env.*.local\n\n\
                # Fleetify\n.fleetify-worktrees/\n";
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
    //
    // Make sure Fleetify's own worktree dir is ignored FIRST. `git add -A`
    // below stages everything it can see, and in a repo that never had a
    // `.gitignore` that included `.fleetify-worktrees/<session id>` — an
    // embedded git repository — so the user's PR shipped a gitlink pointing at
    // a local path ("warning: adding embedded git repository"). The ignore has
    // to land on the MAIN checkout, which is where the dir lives: for a
    // worktree session `folder` is the worktree itself.
    let ignore_root = main_worktree_root(folder).await;
    fleetify_backend::services::worktree::ensure_worktrees_ignored(&ignore_root);

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
        // Repo-level bootstrap (repo name + `gh repo create` + origin) must
        // target the MAIN checkout, never a linked worktree — a worktree's
        // `.git` is a file pointer that `gh repo create --source` rejects, and
        // its basename is a UUID, not the project name. Branch/commit/push
        // below stay on `folder` (the worktree); origin is shared via the
        // common `.git`, so the push from the worktree still works. No-op for
        // a normal checkout (bootstrap_dir == folder).
        let bootstrap_dir = main_worktree_root(folder).await;
        // Derive a repo name from the bootstrap-dir basename — clamp to a
        // safe charset + length.
        let basename = bootstrap_dir
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
                let (view_rc, _, _) = gh(&["repo", "view", &repo_name], &bootstrap_dir).await;
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
            &bootstrap_dir,
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

/// Build the `gh pr list` argv for the repo-wide OPEN-PR store (`pr-store.ts` —
/// the Merge-box cross-PR switcher + branch-picker badges). State is **open**,
/// NOT `all`: the store only ever DISPLAYS open PRs (`openPrs`), and `--state
/// all` spends the `--limit` budget on closed/merged PRs first (gh sorts
/// newest-created first), so in a repo with a long PR history the older OPEN
/// PRs fall outside the newest-N window and silently never reach the switcher
/// (e.g. with 200+ total PRs and `--limit 100`, open PR #2 is dropped). Mirrors
/// the REST path's `state=open` (`github_pr::build_list_prs_request`).
fn list_prs_argv(limit_str: &str) -> Vec<&str> {
    vec![
        "pr",
        "list",
        "--state",
        "open",
        "--limit",
        limit_str,
        "--json",
        "number,state,headRefName,isDraft,mergeable",
    ]
}

/// `gh pr list --state open --limit N`. Feeds the repo-wide open-PR store so the
/// Merge-box switcher + branch-picker badges see EVERY open PR, not just the
/// newest N across all states (which silently dropped older open PRs).
pub async fn list_prs(folder: &Path, limit: u32) -> Value {
    let limit_str = limit.to_string();
    let argv = list_prs_argv(&limit_str);
    let (rc, out, err) = gh(&argv, folder).await;
    if rc != 0 {
        return json!({ "ok": false, "error": err.trim() });
    }
    match serde_json::from_str::<Value>(out.trim()) {
        Ok(v) => json!({ "ok": true, "prs": v }),
        Err(e) => json!({ "ok": false, "error": format!("parse: {e}") }),
    }
}

/// `--json` field set for `gh pr view` in [`get_pr_status`].
///
/// Every entry MUST be a valid `gh pr view --json` field name. The issue-comment
/// field is `comments` (an array) — NOT `commentsCount`, which is a
/// renderer-OUTPUT name only. Requesting `commentsCount` makes `gh pr view`
/// exit non-zero with `Unknown JSON field: "commentsCount"`, so EVERY status
/// poll returned `ok:false` and the BranchStrip's Merge button stayed pinned on
/// "Loading PR status…" for anyone on the gh-CLI auth path (the REST/OAuth path
/// was unaffected). The count is derived from `comments.len()` in the mapping
/// below. Keep this in sync with `map_pr_status` (REST) which sources the count
/// from the pull object's numeric `comments`.
const PR_VIEW_FIELDS: &str =
    "number,url,state,mergeable,mergeStateStatus,isDraft,baseRefName,headRefName,\
                              statusCheckRollup,comments";

/// Strip a trailing `?query` / `#fragment` from a URL path segment.
fn trim_id_segment(s: &str) -> &str {
    s.split(['?', '#']).next().unwrap_or(s)
}

/// Parse a GitHub Actions check details URL of the shape
/// `…/actions/runs/<run_id>/job/<job_id>` into `(run_id, job_id)`. Any URL that
/// doesn't match (legacy commit statuses, third-party CI targets, malformed) →
/// `(None, None)` — such checks aren't rerunnable via the Actions API.
pub(crate) fn parse_actions_run_job(url: &str) -> (Option<u64>, Option<u64>) {
    const MARKER: &str = "/actions/runs/";
    let Some(idx) = url.find(MARKER) else {
        return (None, None);
    };
    let mut parts = url[idx + MARKER.len()..].split('/');
    let run_id = parts
        .next()
        .and_then(|s| trim_id_segment(s).parse::<u64>().ok());
    let job_id = match parts.next() {
        Some("job") | Some("jobs") => parts
            .next()
            .and_then(|s| trim_id_segment(s).parse::<u64>().ok()),
        _ => None,
    };
    (run_id, job_id)
}

/// Order-preserving u64 de-dupe (coalesces per-job run ids before the bulk
/// `rerun-failed-jobs` fan-out).
pub(crate) fn dedupe_ids(ids: &[u64]) -> Vec<u64> {
    let mut out = Vec::with_capacity(ids.len());
    for &id in ids {
        if !out.contains(&id) {
            out.push(id);
        }
    }
    out
}

/// Classify a `gh api` re-run failure into our `{ok:false,code}` shape.
fn gh_rerun_err(err: &str) -> Value {
    let lo = err.to_lowercase();
    if lo.contains("403") || lo.contains("forbidden") || lo.contains("not accessible") {
        json!({ "ok": false, "code": "ACTIONS_FORBIDDEN",
                "error": "GitHub denied the re-run (insufficient Actions permissions)." })
    } else if lo.contains("404") || lo.contains("not found") {
        json!({ "ok": false, "code": "NOT_FOUND",
                "error": "Workflow run or job not found — it may have expired." })
    } else {
        json!({ "ok": false, "code": "GH", "error": err.trim() })
    }
}

/// gh path: re-run one failed Actions job. `gh api` fills {owner}/{repo} from
/// the repo at `folder`.
pub async fn rerun_check_job(folder: &Path, job_id: u64) -> Value {
    let path = format!("repos/{{owner}}/{{repo}}/actions/jobs/{job_id}/rerun");
    let (rc, _out, err) = gh(&["api", "-X", "POST", path.as_str()], folder).await;
    if rc == 0 {
        json!({ "ok": true, "rerun": 1 })
    } else {
        gh_rerun_err(&err)
    }
}

/// gh path: re-run the failed jobs of each distinct workflow run.
pub async fn rerun_failed_checks(folder: &Path, run_ids: &[u64]) -> Value {
    let mut ok = 0u32;
    let mut last_err: Option<Value> = None;
    for run_id in dedupe_ids(run_ids) {
        let path = format!("repos/{{owner}}/{{repo}}/actions/runs/{run_id}/rerun-failed-jobs");
        let (rc, _out, err) = gh(&["api", "-X", "POST", path.as_str()], folder).await;
        if rc == 0 {
            ok += 1;
        } else {
            last_err = Some(gh_rerun_err(&err));
        }
    }
    if ok > 0 {
        json!({ "ok": true, "rerun": ok })
    } else {
        last_err.unwrap_or_else(
            || json!({ "ok": false, "code": "NO_RUNS", "error": "no rerunnable workflow runs" }),
        )
    }
}

/// Normalize a checks array — gh's `statusCheckRollup` OR REST's `check_runs` —
/// into the renderer's `checks` object: aggregate counts plus a per-check
/// `runs[]` (`{name,status,conclusion,bucket,url}`) that drives the CI ring +
/// details popover. One pass handles three item shapes:
///   • gh CheckRun      — name / status / conclusion / detailsUrl
///   • gh StatusContext  — context / state / targetUrl  (`__typename == "StatusContext"`)
///   • REST check_run   — name / status / conclusion / html_url
/// `bucket` ∈ {passing, failing, pending} is the icon/ring-color driver and the
/// source of the counts (so the ring + popover never disagree).
pub(crate) fn normalize_check_runs(items: &[Value]) -> Value {
    let (mut passing, mut failing, mut pending) = (0u32, 0u32, 0u32);
    let mut runs = Vec::with_capacity(items.len());
    for c in items {
        let is_status_ctx = c.get("__typename").and_then(|v| v.as_str()) == Some("StatusContext");
        let name = c
            .get("name")
            .and_then(|v| v.as_str())
            .or_else(|| c.get("context").and_then(|v| v.as_str()))
            .unwrap_or("check")
            .to_string();
        let url = c
            .get("detailsUrl")
            .and_then(|v| v.as_str())
            .or_else(|| c.get("targetUrl").and_then(|v| v.as_str()))
            .or_else(|| c.get("html_url").and_then(|v| v.as_str()))
            .map(str::to_string);
        let (bucket, status, conclusion): (&str, String, Option<String>) = if is_status_ctx {
            let state = c
                .get("state")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_uppercase();
            let bucket = match state.as_str() {
                "SUCCESS" => "passing",
                "FAILURE" | "ERROR" => "failing",
                _ => "pending", // PENDING / EXPECTED
            };
            (bucket, "COMPLETED".to_string(), Some(state))
        } else {
            let status = c
                .get("status")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_uppercase();
            let concl = c
                .get("conclusion")
                .and_then(|v| v.as_str())
                .map(|s| s.to_uppercase());
            // Bucket by conclusion: it is only set once a run completes, so its
            // presence means "done" regardless of the `status` string (gh sends
            // status+conclusion; the renderer/tests may send conclusion alone).
            // No conclusion yet ⇒ still pending (queued / in_progress).
            let bucket = match concl.as_deref() {
                Some("SUCCESS") | Some("NEUTRAL") | Some("SKIPPED") => "passing",
                Some("FAILURE")
                | Some("TIMED_OUT")
                | Some("CANCELLED")
                | Some("STARTUP_FAILURE")
                | Some("ACTION_REQUIRED") => "failing",
                _ => "pending",
            };
            (bucket, status, concl)
        };
        let (run_id, job_id) = match url.as_deref() {
            Some(u) => parse_actions_run_job(u),
            None => (None, None),
        };
        let rerunnable = job_id.is_some();
        match bucket {
            "passing" => passing += 1,
            "failing" => failing += 1,
            _ => pending += 1,
        }
        runs.push(json!({
            "name": name,
            "status": status,
            "conclusion": conclusion,
            "bucket": bucket,
            "url": url,
            "runId": run_id,
            "jobId": job_id,
            "rerunnable": rerunnable,
        }));
    }
    json!({
        "passing": passing,
        "failing": failing,
        "pending": pending,
        "total": items.len(),
        "runs": runs,
    })
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
    let field_set = PR_VIEW_FIELDS;
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

    // statusCheckRollup → counts + per-check runs[] (CI ring + popover).
    // mergeStateStatus carries GitHub's branch-protection-aware merge state
    // (BLOCKED/BEHIND/CLEAN/UNSTABLE/…) so the Merge gate reflects TRUE
    // mergeability, not just our own check counts.
    let rollup: &[Value] = raw
        .get("statusCheckRollup")
        .and_then(|v| v.as_array())
        .map(|v| v.as_slice())
        .unwrap_or(&[]);
    let checks = normalize_check_runs(rollup);

    let pr = json!({
        "number": number,
        "url": raw.get("url"),
        "state": raw.get("state"),
        "mergeable": raw.get("mergeable"),
        "mergeStateStatus": raw.get("mergeStateStatus"),
        "isDraft": raw.get("isDraft").and_then(|v| v.as_bool()).unwrap_or(false),
        "baseRefName": raw.get("baseRefName"),
        "headRefName": raw.get("headRefName"),
        "checks": checks,
        "commentsCount": raw.get("comments").and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0),
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
        tracing::info!(target: "merge/gh", "ok · gh pr ready · #{n}");
        return json!({ "ok": true });
    }
    let e = err.trim();
    let lower = e.to_lowercase();
    if lower.contains("ready for review") || lower.contains("already") {
        tracing::info!(target: "merge/gh", "ok · gh pr ready · #{n} (already ready)");
        return json!({ "ok": true, "noop": true });
    }
    tracing::info!(target: "merge/gh", "FAIL · gh pr ready · #{n} · {e}");
    json!({ "ok": false, "error": e })
}

pub async fn merge_pr(folder: &Path, pr_number: u64, method: &str) -> Value {
    let flag = match method {
        "rebase" => "--rebase",
        "squash" => "--squash",
        _ => "--merge",
    };
    let n = pr_number.to_string();
    let worktree = is_linked_worktree(folder);
    let mut args: Vec<&str> = vec!["pr", "merge", n.as_str(), flag];
    if !worktree {
        args.push("--delete-branch");
    }
    tracing::info!(
        target: "merge/gh",
        "ok · merge · #{n} {flag}{}",
        if worktree {
            " (worktree → no --delete-branch; next-round cleans up)"
        } else {
            " --delete-branch"
        }
    );
    let (rc, _o, err) = gh(&args, folder).await;
    if rc == 0 {
        tracing::info!(target: "merge/gh", "ok · gh pr merge · merged #{n}");
        json!({ "ok": true })
    } else {
        tracing::info!(target: "merge/gh", "FAIL · gh pr merge · {}", err.trim());
        json!({ "ok": false, "error": err.trim() })
    }
}

/// True when a remote-branch delete failed only because the ref was already
/// gone — the desired end state, so treat it as success (idempotent).
pub fn remote_delete_is_noop(stderr: &str) -> bool {
    let s = stderr.to_lowercase();
    s.contains("remote ref does not exist") || s.contains("couldn't find remote ref")
}

/// Delete a remote branch for gh / credential-helper users. Plain `git push
/// origin --delete` (gh configures git's credential helper at `gh auth
/// login`). Idempotent: an already-deleted ref is success.
pub async fn delete_remote_branch_gh(folder: &Path, branch: &str) -> Value {
    if branch.trim().is_empty() {
        return json!({ "ok": true, "noop": true });
    }
    let (rc, _o, err) = git(&["push", "origin", "--delete", branch], folder).await;
    if rc == 0 || remote_delete_is_noop(&err) {
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

/// Best-effort `git fetch origin <base>` (fetch-only, NO checkout) so the
/// renderer's `baseBehind` indicator reflects the latest remote without the
/// heavier `sync_main` (which checks out + pulls). Drives the on-focus refresh
/// behind the standalone "Sync <base>" action. Failure is reported but
/// non-fatal — an offline / no-remote repo just leaves baseBehind unchanged.
pub async fn fetch_base(folder: &Path, base: &str) -> Value {
    let (rc, _o, err) = git(&["fetch", "origin", base], folder).await;
    if rc != 0 {
        return json!({ "ok": false, "error": err.trim() });
    }
    json!({ "ok": true })
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

    #[test]
    fn parse_actions_run_job_extracts_ids() {
        assert_eq!(
            parse_actions_run_job("https://github.com/o/r/actions/runs/123/job/456"),
            (Some(123), Some(456))
        );
        // trailing query is stripped
        assert_eq!(
            parse_actions_run_job(
                "https://github.com/o/r/actions/runs/12/job/34?check_suite_focus=true"
            ),
            (Some(12), Some(34))
        );
        // run page without a job segment → run only
        assert_eq!(
            parse_actions_run_job("https://github.com/o/r/actions/runs/99"),
            (Some(99), None)
        );
        // non-Actions target (legacy status / third-party CI) → nothing
        assert_eq!(
            parse_actions_run_job("https://circleci.com/gh/o/r/42"),
            (None, None)
        );
        assert_eq!(parse_actions_run_job("garbage"), (None, None));
    }

    #[test]
    fn dedupe_ids_keeps_first_order() {
        assert_eq!(dedupe_ids(&[3, 1, 3, 2, 1]), vec![3, 1, 2]);
        assert_eq!(dedupe_ids(&[]), Vec::<u64>::new());
    }

    #[test]
    fn gh_rerun_err_classifies() {
        assert_eq!(
            gh_rerun_err("HTTP 403: Resource not accessible by integration")["code"],
            "ACTIONS_FORBIDDEN"
        );
        assert_eq!(
            gh_rerun_err("gh: Not Found (HTTP 404)")["code"],
            "NOT_FOUND"
        );
        assert_eq!(gh_rerun_err("some other failure")["code"], "GH");
    }

    #[test]
    fn normalize_check_runs_marks_actions_checks_rerunnable() {
        let items = vec![
            json!({"name":"build","status":"completed","conclusion":"failure",
                   "detailsUrl":"https://github.com/o/r/actions/runs/100/job/200"}),
            json!({"__typename":"StatusContext","context":"ci/circle","state":"FAILURE",
                   "targetUrl":"https://circleci.com/x"}),
        ];
        let c = normalize_check_runs(&items);
        let runs = c["runs"].as_array().unwrap();
        assert_eq!(runs[0]["runId"], 100);
        assert_eq!(runs[0]["jobId"], 200);
        assert_eq!(runs[0]["rerunnable"], true);
        // legacy StatusContext is never rerunnable
        assert_eq!(runs[1]["rerunnable"], false);
        assert_eq!(runs[1]["jobId"], serde_json::Value::Null);
    }

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

    /// Regression: opening a session while signed in as the NOAUTH
    /// "John Doe" stub used to overwrite the repo's real committer
    /// identity via `ensure_repo`, so every later commit — and the
    /// `Co-authored-by` GitHub aggregates on squash-merge — was attributed
    /// to John Doe. `ensure_repo` must leave an existing identity alone.
    #[tokio::test]
    async fn ensure_repo_never_overwrites_existing_identity_with_noauth_stub() {
        if !git_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("proj");
        std::fs::create_dir_all(&repo).unwrap();
        fresh_repo(&repo).await; // local identity: T <t@x>

        let _ = ensure_repo(&repo, Some("John Doe"), Some(NOAUTH_STUB_EMAIL)).await;

        let (_, name, _) = git(&["config", "--local", "--get", "user.name"], &repo).await;
        let (_, email, _) = git(&["config", "--local", "--get", "user.email"], &repo).await;
        assert_eq!(name.trim(), "T", "must not clobber the real committer name");
        assert_eq!(
            email.trim(),
            "t@x",
            "must not clobber the real committer email"
        );
    }

    /// The stub must never be *seeded* either: a fresh repo opened under
    /// NOAUTH falls back to the backend's "Fleet User" placeholder, never
    /// "john.doe@fleetify.local".
    #[tokio::test]
    async fn ensure_repo_never_seeds_noauth_stub_into_fresh_repo() {
        if !git_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("proj");
        std::fs::create_dir_all(&repo).unwrap();

        let _ = ensure_repo(&repo, Some("John Doe"), Some(NOAUTH_STUB_EMAIL)).await;

        let (_, email, _) = git(&["config", "--local", "--get", "user.email"], &repo).await;
        assert_ne!(
            email.trim(),
            NOAUTH_STUB_EMAIL,
            "the NOAUTH stub identity must never reach git config"
        );
    }

    /// Happy path stays intact: a real signed-in identity still seeds a
    /// fresh repo that has no identity of its own.
    #[tokio::test]
    async fn ensure_repo_seeds_real_identity_into_fresh_repo() {
        if !git_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("proj");
        std::fs::create_dir_all(&repo).unwrap();

        let _ = ensure_repo(&repo, Some("Ada Lovelace"), Some("ada@example.com")).await;

        let (_, email, _) = git(&["config", "--local", "--get", "user.email"], &repo).await;
        assert_eq!(email.trim(), "ada@example.com");
    }

    #[test]
    fn list_prs_argv_fetches_open_not_all_state() {
        // Regression: the open-PR store (pr-store.ts) displays open PRs only, so
        // the gh fetch must use `--state open`. `--state all` spent the `--limit`
        // budget on closed/merged PRs first (gh sorts newest-created first), so
        // with a long PR history older OPEN PRs (e.g. #2/#69 behind 200+ total
        // PRs) fell outside the newest-N window and never reached the switcher.
        let argv = list_prs_argv("100");
        let i = argv
            .iter()
            .position(|a| *a == "--state")
            .expect("has --state");
        assert_eq!(argv[i + 1], "open", "must fetch open PRs, not all states");
        let j = argv
            .iter()
            .position(|a| *a == "--limit")
            .expect("has --limit");
        assert_eq!(argv[j + 1], "100");
        assert!(
            argv.iter().any(|a| a.contains("isDraft")),
            "keeps the json field set"
        );
    }

    #[test]
    fn pr_view_fields_use_valid_gh_field_names() {
        // Regression: `gh pr view --json …,commentsCount` is rejected by gh with
        // `Unknown JSON field: "commentsCount"` (commentsCount is a
        // renderer-OUTPUT name, not a gh field). That made get_pr_status exit
        // non-zero → ok:false on EVERY poll, pinning the BranchStrip Merge
        // button on "Loading PR status…" for the gh-CLI auth path (REST was
        // fine). The gh field is `comments` (an array); the count is derived
        // from its length in the status mapping.
        let fields: Vec<&str> = PR_VIEW_FIELDS.split(',').map(str::trim).collect();
        assert!(
            fields.contains(&"comments"),
            "gh pr view needs the `comments` array field (count = .len()); got: {PR_VIEW_FIELDS}"
        );
        assert!(
            !fields.contains(&"commentsCount"),
            "`commentsCount` is NOT a valid `gh pr view` field — gh exits non-zero on it"
        );
        // Fields the status mapping + Merge gate depend on must stay present.
        // `mergeStateStatus` drives the branch-protection-aware merge gate.
        for required in [
            "number",
            "state",
            "mergeable",
            "mergeStateStatus",
            "isDraft",
            "statusCheckRollup",
        ] {
            assert!(
                fields.contains(&required),
                "missing required gh field `{required}` in {PR_VIEW_FIELDS}"
            );
        }
    }

    #[test]
    fn normalize_check_runs_buckets_all_shapes() {
        let items = vec![
            // gh CheckRun — success → passing
            json!({ "__typename": "CheckRun", "name": "build", "status": "COMPLETED",
                    "conclusion": "SUCCESS", "detailsUrl": "https://gh/build" }),
            // gh CheckRun — failure → failing
            json!({ "__typename": "CheckRun", "name": "lint", "status": "COMPLETED",
                    "conclusion": "FAILURE", "detailsUrl": "https://gh/lint" }),
            // gh CheckRun — still running → pending
            json!({ "__typename": "CheckRun", "name": "test", "status": "IN_PROGRESS",
                    "conclusion": null, "detailsUrl": "https://gh/test" }),
            // gh StatusContext — legacy status, pending state
            json!({ "__typename": "StatusContext", "context": "ci/legacy",
                    "state": "PENDING", "targetUrl": "https://gh/legacy" }),
            // REST check_run shape — html_url + lowercase, neutral → passing
            json!({ "name": "codeql", "status": "completed", "conclusion": "neutral",
                    "html_url": "https://gh/codeql" }),
        ];
        let c = normalize_check_runs(&items);
        assert_eq!(c["passing"], 2, "success + neutral");
        assert_eq!(c["failing"], 1, "failure");
        assert_eq!(c["pending"], 2, "in_progress + legacy pending");
        assert_eq!(c["total"], 5);
        let runs = c["runs"].as_array().unwrap();
        assert_eq!(runs.len(), 5);
        // StatusContext maps context→name, state→conclusion, targetUrl→url.
        assert_eq!(runs[3]["name"], "ci/legacy");
        assert_eq!(runs[3]["bucket"], "pending");
        assert_eq!(runs[3]["url"], "https://gh/legacy");
        // REST html_url is picked up as the run url; bucket from conclusion.
        assert_eq!(runs[4]["url"], "https://gh/codeql");
        assert_eq!(runs[4]["bucket"], "passing");
        // Empty input → zeroed counts, empty runs (no checks / no CI).
        let empty = normalize_check_runs(&[]);
        assert_eq!(empty["total"], 0);
        assert_eq!(empty["runs"].as_array().unwrap().len(), 0);
    }

    #[tokio::test]
    async fn main_worktree_root_resolves_primary_checkout_from_worktree() {
        if !git_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let main_repo = tmp.path().join("main");
        std::fs::create_dir_all(&main_repo).unwrap();
        fresh_repo(&main_repo).await;

        // Carve a linked worktree whose `.git` is a file pointer.
        let wt = main_repo.join(".fleetify-worktrees").join("sid");
        let (rc, _, err) = git(
            &[
                "worktree",
                "add",
                "-b",
                "feat/x",
                &wt.to_string_lossy(),
                "main",
            ],
            &main_repo,
        )
        .await;
        assert_eq!(rc, 0, "worktree add failed: {err}");

        // From the worktree, the bootstrap root must be the PRIMARY checkout.
        let resolved = main_worktree_root(&wt).await;
        assert_eq!(
            std::fs::canonicalize(&resolved).unwrap(),
            std::fs::canonicalize(&main_repo).unwrap(),
            "worktree should resolve to the main checkout, not itself"
        );

        // From a normal checkout, it's the repo itself (no-op).
        let resolved_main = main_worktree_root(&main_repo).await;
        assert_eq!(
            std::fs::canonicalize(&resolved_main).unwrap(),
            std::fs::canonicalize(&main_repo).unwrap(),
            "normal checkout should return itself unchanged"
        );
    }

    #[tokio::test]
    async fn is_linked_worktree_distinguishes_worktree_from_primary_checkout() {
        if !git_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let main_repo = tmp.path().join("main");
        std::fs::create_dir_all(&main_repo).unwrap();
        fresh_repo(&main_repo).await;

        // Carve a linked worktree whose `.git` is a FILE pointer (not a dir).
        let wt = main_repo.join(".fleetify-worktrees").join("sid");
        let (rc, _, err) = git(
            &[
                "worktree",
                "add",
                "-b",
                "feat/x",
                &wt.to_string_lossy(),
                "main",
            ],
            &main_repo,
        )
        .await;
        assert_eq!(rc, 0, "worktree add failed: {err}");

        assert!(
            is_linked_worktree(&wt),
            "a linked worktree (.git is a file) must be detected as linked"
        );
        assert!(
            !is_linked_worktree(&main_repo),
            "the primary checkout (.git is a directory) must NOT be linked"
        );
    }

    #[test]
    fn remote_delete_noop_recognizes_already_gone() {
        assert!(remote_delete_is_noop(
            "error: unable to delete 'x': remote ref does not exist"
        ));
        assert!(remote_delete_is_noop("remote ref does not exist"));
        assert!(remote_delete_is_noop(
            "fatal: couldn't find remote ref refs/heads/x"
        ));
        assert!(!remote_delete_is_noop("fatal: Authentication failed"));
        assert!(!remote_delete_is_noop(
            "error: failed to push some refs: permission denied"
        ));
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
    fn pr_page_url_targets_exact_pr_or_pulls_list() {
        assert_eq!(
            pr_page_url("https://github.com/foo/bar", Some(1)),
            "https://github.com/foo/bar/pull/1"
        );
        assert_eq!(
            pr_page_url("https://github.com/foo/bar", None),
            "https://github.com/foo/bar/pulls"
        );
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
        // No remote on a fresh repo → origin/<base> is unknown → behind is 0
        // (and the field is always present so the renderer can read it).
        assert_eq!(v["baseBehind"], 0);
        assert!(v.get("error").is_none());
    }

    #[test]
    fn behind_if_fast_forward_counts_only_when_pure_ff() {
        // "<ahead>\t<behind>" from `rev-list --left-right --count base...origin/base`.
        assert_eq!(behind_if_fast_forward("0\t3"), 3); // behind 3, ff possible
        assert_eq!(behind_if_fast_forward("0\t0"), 0); // up to date
        assert_eq!(behind_if_fast_forward("0\t1"), 1); // behind 1
                                                       // Diverged: local base has its own commits → `pull --ff-only` would
                                                       // reject, so we must NOT advertise a sync (report 0, not the behind).
        assert_eq!(behind_if_fast_forward("2\t3"), 0);
        assert_eq!(behind_if_fast_forward("5\t0"), 0); // ahead only, nothing to sync
                                                       // Parse failures / malformed output collapse to 0 (never panics).
        assert_eq!(behind_if_fast_forward(""), 0);
        assert_eq!(behind_if_fast_forward("0"), 0); // missing behind column
        assert_eq!(behind_if_fast_forward("garbage"), 0);
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

    /// Regression: `refs/remotes/<remote>/HEAD` is a SYMBOLIC ref, and
    /// `%(refname:short)` shortens it to the bare remote name ("origin").
    /// It used to sail through into `remote`, so the branch picker rendered
    /// a row called "origin" — and clicking it ran `git checkout origin`,
    /// which SUCCEEDS into a detached HEAD and strands the session's
    /// worktree off its branch. Every clone has that symref, so this hit
    /// the common path.
    #[tokio::test]
    async fn list_branches_drops_the_remote_head_symref() {
        if !git_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let origin = tmp.path().join("origin");
        let clone = tmp.path().join("clone");
        std::fs::create_dir_all(&origin).unwrap();
        fresh_repo(&origin).await;
        let (rc, _, _) = git(
            &["clone", &origin.to_string_lossy(), &clone.to_string_lossy()],
            tmp.path(),
        )
        .await;
        if rc != 0 {
            return; // clone unavailable in this sandbox — nothing to assert
        }

        let v = list_branches(&clone).await;
        let remote: Vec<String> = v["remote"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| x.as_str().unwrap().to_string())
            .collect();

        // The symref is gone...
        assert!(
            !remote.iter().any(|b| b == "origin"),
            "bare remote name leaked into the branch list: {remote:?}"
        );
        // ...but the real remote-tracking branch is still there.
        assert!(
            remote.iter().any(|b| b == "origin/main"),
            "real remote branch missing: {remote:?}"
        );
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
