//! Faithful port of `app/services/worktree.py`. Per-session git
//! worktree/branch helper used by `session_manager::attach_git_setup`.
//! Auto-init for non-repo folders, language-aware `.gitignore`,
//! `fleet/<slug>-<short-id>` branch convention.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use fleetify_core::process::tokio_command;
use regex::Regex;

pub const WORKTREES_DIRNAME: &str = ".fleetify-worktrees";

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct WorktreeError(pub String);

fn branch_safe() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"[^A-Za-z0-9._/-]+").unwrap())
}

fn slug(value: &str) -> String {
    let cleaned = branch_safe().replace_all(value, "-");
    let trimmed = cleaned.trim_matches(|c| c == '-' || c == '/');
    let s: String = trimmed.chars().take(48).collect();
    if s.is_empty() {
        "session".into()
    } else {
        s
    }
}

pub fn compute_branch_name(label: Option<&str>, session_id: &str) -> String {
    let id_short: String = session_id.chars().take(8).collect();
    format!("fleet/{}-{}", slug(label.unwrap_or(session_id)), id_short)
}

/// Read the round number off a branch's trailing `-r<N>` suffix.
/// Round-1 branches carry no suffix, so an absent/garbage suffix → 1.
pub fn parse_round(branch: &str) -> u32 {
    if let Some(idx) = branch.rfind("-r") {
        let tail = &branch[idx + 2..];
        if !tail.is_empty() && tail.bytes().all(|b| b.is_ascii_digit()) {
            if let Ok(n) = tail.parse::<u32>() {
                if n >= 1 {
                    return n;
                }
            }
        }
    }
    1
}

/// `fleet/<slug>-<sid8>` for round 1; `…-r<N>` for round N≥2.
pub fn compute_round_branch(label: Option<&str>, session_id: &str, round: u32) -> String {
    let base = compute_branch_name(label, session_id);
    if round <= 1 {
        base
    } else {
        format!("{base}-r{round}")
    }
}

async fn git(args: &[&str], cwd: &str) -> (i32, String, String) {
    let out = tokio_command("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .await;
    match out {
        Ok(o) => (
            o.status.code().unwrap_or(-1),
            String::from_utf8_lossy(&o.stdout).trim().to_string(),
            String::from_utf8_lossy(&o.stderr).trim().to_string(),
        ),
        Err(_) => (-1, String::new(), String::new()),
    }
}

pub async fn is_git_repo(path: &str) -> bool {
    let (rc, out, _) = git(&["rev-parse", "--is-inside-work-tree"], path).await;
    rc == 0 && out == "true"
}

/// Strict variant of `is_git_repo`: true only when the folder owns its
/// own `.git` (dir for a normal repo, file for a worktree checkout) at
/// the top level. `is_git_repo` returns true for ANY folder that lives
/// inside an ancestor repo (e.g. a fresh subfolder under `$HOME` when
/// `$HOME` is itself a git repo) — which makes `ensure_git_repo` skip
/// init even though the user explicitly picked this subfolder as their
/// workspace. The strict check lets us decide based on the user's
/// intent: this folder is the workspace, so it should be its own repo
/// root with its own `.fleetify-worktrees/` next to its own `.git`.
pub fn has_own_git(path: &str) -> bool {
    Path::new(path).join(".git").exists()
}

async fn current_branch(path: &str) -> Option<String> {
    let (rc, out, _) = git(&["rev-parse", "--abbrev-ref", "HEAD"], path).await;
    if rc != 0 || out.is_empty() || out == "HEAD" {
        None
    } else {
        Some(out)
    }
}

async fn detect_default_branch(path: &str) -> Option<String> {
    let (rc, out, _) = git(
        &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
        path,
    )
    .await;
    if rc == 0 && !out.is_empty() {
        return Some(
            out.split_once('/')
                .map(|(_, b)| b.to_string())
                .unwrap_or(out),
        );
    }
    for c in ["main", "master"] {
        let (rc2, _, _) = git(
            &[
                "rev-parse",
                "--verify",
                "--quiet",
                &format!("refs/heads/{c}"),
            ],
            path,
        )
        .await;
        if rc2 == 0 {
            return Some(c.into());
        }
    }
    None
}

/// Lexical "is `path` inside `root`?" check. `clone_or_pull` builds clone
/// paths by joining the clones root, so a plain prefix test is reliable
/// without `canonicalize` (which would also fail for not-yet-created
/// paths). Kept pure for unit testing.
fn is_under(path: &str, root: &Path) -> bool {
    Path::new(path).starts_with(root)
}

/// Resolve the base ref a new worktree branch is carved from.
///
/// Managed clones (under `<fleetify_home>/clones/`) are pristine mirrors —
/// Fleetify never commits to their default branch, and reuse only `fetch`es
/// (advancing `origin/<default>`, not local HEAD). So carve those off the
/// freshly-fetched `origin/<default>` to start current. User-picked folders
/// start from their default branch (main/master) too, so new sessions begin
/// on a clean main rather than whatever branch happens to be checked out.
async fn resolve_base(project_path: &str) -> Result<String, WorktreeError> {
    let clones_root = fleetify_core::fleetify_home().join("clones");
    if is_under(project_path, &clones_root) {
        if let Some(d) = detect_default_branch(project_path).await {
            let (rc_v, _, _) = git(
                &[
                    "rev-parse",
                    "--verify",
                    "--quiet",
                    &format!("refs/remotes/origin/{d}"),
                ],
                project_path,
            )
            .await;
            if rc_v == 0 {
                return Ok(format!("origin/{d}"));
            }
        }
    }

    // User-picked folders: base new sessions off the repo's DEFAULT branch
    // (main/master) rather than whatever branch is currently checked out, so
    // work always starts from a clean main. Prefer the local default branch,
    // fall back to its remote-tracking ref, then to HEAD when neither resolves
    // (detached HEAD, or a repo with no main/master at all).
    if let Some(d) = detect_default_branch(project_path).await {
        let (rc_l, _, _) = git(
            &[
                "rev-parse",
                "--verify",
                "--quiet",
                &format!("refs/heads/{d}"),
            ],
            project_path,
        )
        .await;
        if rc_l == 0 {
            return Ok(d);
        }
        let (rc_r, _, _) = git(
            &[
                "rev-parse",
                "--verify",
                "--quiet",
                &format!("refs/remotes/origin/{d}"),
            ],
            project_path,
        )
        .await;
        if rc_r == 0 {
            return Ok(format!("origin/{d}"));
        }
    }

    let (rc_h, head, err) = git(&["rev-parse", "--abbrev-ref", "HEAD"], project_path).await;
    if rc_h != 0 {
        return Err(WorktreeError(format!("could not resolve HEAD: {err}")));
    }
    Ok(if head.is_empty() { "HEAD".into() } else { head })
}

// ── .gitignore packs (parity, stable order) ────────────────────────
const BASE: &str =
    "# Generated by Fleetify on git init.\n\n# Editor / OS\n.DS_Store\nThumbs.db\n.idea/\n.vscode/\n*.swp\n*.swo\n\n# Env\n.env\n.env.local\n.env.*.local\n\n# Fleetify\n.fleetify-worktrees/\n";
const NODE: &str = "\n# Node\nnode_modules/\nnpm-debug.log*\nyarn-debug.log*\nyarn-error.log*\n.pnpm-debug.log*\ndist/\nbuild/\n.next/\n.nuxt/\n.cache/\n.turbo/\ncoverage/\n";
const PYTHON: &str = "\n# Python\n__pycache__/\n*.py[cod]\n*$py.class\n.venv/\nvenv/\nenv/\n.pytest_cache/\n.mypy_cache/\n.ruff_cache/\n*.egg-info/\n.coverage\nhtmlcov/\n";
const RUST: &str = "\n# Rust\ntarget/\n**/*.rs.bk\n";
const GO: &str = "\n# Go\nvendor/\n*.exe\n*.test\n*.out\n";
const JAVA: &str = "\n# Java / JVM\n*.class\ntarget/\nbuild/\n.gradle/\n*.jar\n*.war\n";

fn detect_kinds(folder: &Path) -> HashSet<&'static str> {
    let mut k = HashSet::new();
    let has = |p: &str| folder.join(p).exists();
    if has("package.json") {
        k.insert("node");
    }
    if has("pyproject.toml") || has("requirements.txt") || has("setup.py") || has("setup.cfg") {
        k.insert("python");
    }
    if has("Cargo.toml") {
        k.insert("rust");
    }
    if has("go.mod") {
        k.insert("go");
    }
    if has("pom.xml") || has("build.gradle") || has("build.gradle.kts") {
        k.insert("java");
    }
    k
}

pub fn gitignore_content(folder: &Path) -> String {
    let k = detect_kinds(folder);
    let mut s = String::from(BASE);
    for (name, pack) in [
        ("node", NODE),
        ("python", PYTHON),
        ("rust", RUST),
        ("go", GO),
        ("java", JAVA),
    ] {
        if k.contains(name) {
            s.push_str(pack);
        }
    }
    s
}

fn ensure_gitignore_initial(folder: &Path) {
    let gi = folder.join(".gitignore");
    if gi.exists() {
        return;
    }
    let _ = std::fs::write(&gi, gitignore_content(folder));
}

/// Make sure git ignores `.fleetify-worktrees/` for the repo rooted at
/// `folder`. Public because the Tauri shell's Create PR pipeline has to run
/// it too: that path does a `git add -A`, which is where an unignored
/// worktree dir gets staged as an embedded git repository.
pub fn ensure_worktrees_ignored(folder: &Path) {
    let target = WORKTREES_DIRNAME.trim_end_matches('/');
    let listed = |body: &str| {
        body.lines()
            .any(|l| l.trim().trim_end_matches('/') == target)
    };
    let append_to = |path: &Path, existing: String| {
        let mut body = if existing.is_empty() || existing.ends_with('\n') {
            existing
        } else {
            existing + "\n"
        };
        body.push_str(&format!("\n# Fleetify\n{WORKTREES_DIRNAME}/\n"));
        let _ = std::fs::write(path, body);
    };

    // Preferred home: the repo's own `.gitignore`, when it HAS one — the entry
    // is visible and travels with the repo.
    let gi = folder.join(".gitignore");
    if gi.exists() {
        if let Ok(existing) = std::fs::read_to_string(&gi) {
            if listed(&existing) {
                return;
            }
            append_to(&gi, existing);
            return;
        }
    }

    // No `.gitignore` at all (an existing repo that never needed one) — this
    // used to bail, leaving `.fleetify-worktrees/` untracked-but-not-ignored.
    // The next `git add -A` (Create PR runs one) then staged the session's
    // worktree as an EMBEDDED GIT REPOSITORY and committed a gitlink into the
    // user's PR. `.git/info/exclude` is the right home here: local-only, never
    // committed, and it doesn't conjure a `.gitignore` into a repo that has
    // deliberately gone without one.
    let git_dir = folder.join(".git");
    if !git_dir.is_dir() {
        return; // linked worktree (.git is a file) — the main checkout owns this
    }
    let info = git_dir.join("info");
    if std::fs::create_dir_all(&info).is_err() {
        return;
    }
    let exclude = info.join("exclude");
    let existing = std::fs::read_to_string(&exclude).unwrap_or_default();
    if listed(&existing) {
        return;
    }
    append_to(&exclude, existing);
}

pub async fn ensure_git_repo(project_path: &str) -> bool {
    // Strict ownership check (`<path>/.git` exists) rather than git's
    // own "are we inside SOME repo" probe. A folder nested inside an
    // ancestor repo (e.g. a fresh subfolder under `$HOME` when `$HOME`
    // itself is a git repo) would pass `is_git_repo` and skip init,
    // and `ensure_worktree`'s `rev-parse --show-toplevel` would then
    // create `.fleetify-worktrees/` in the ANCESTOR root — invisible
    // from the user's folder. The strict check forces a nested init
    // so the user's picked folder becomes its own repo root.
    if has_own_git(project_path) {
        return false;
    }
    let (rc, _, _) = git(&["init", "-b", "main"], project_path).await;
    if rc != 0 {
        let (rc2, _, _) = git(&["init"], project_path).await;
        if rc2 != 0 {
            return false;
        }
        let (rc_b, branch_out, _) = git(&["symbolic-ref", "--short", "HEAD"], project_path).await;
        if rc_b == 0 && !branch_out.is_empty() && branch_out != "main" {
            let _ = git(&["branch", "-m", &branch_out, "main"], project_path).await;
        }
    }
    // Seed user identity ONLY when local has none — never overwrite user config.
    let (rc_n, name_out, _) = git(&["config", "--get", "user.name"], project_path).await;
    if rc_n != 0 || name_out.is_empty() {
        let _ = git(&["config", "user.name", "Fleet User"], project_path).await;
    }
    let (rc_e, email_out, _) = git(&["config", "--get", "user.email"], project_path).await;
    if rc_e != 0 || email_out.is_empty() {
        let _ = git(
            &["config", "user.email", "fleet@fleetify.dev"],
            project_path,
        )
        .await;
    }
    ensure_gitignore_initial(Path::new(project_path));
    let _ = git(&["add", "."], project_path).await;
    let _ = git(
        &["commit", "-m", "Initial commit", "--allow-empty"],
        project_path,
    )
    .await;
    true
}

pub async fn ensure_session_branch(
    project_path: &str,
    session_id: &str,
    label: Option<&str>,
    base_branch: Option<&str>,
) -> Result<String, WorktreeError> {
    ensure_git_repo(project_path).await;
    if !is_git_repo(project_path).await {
        return Err(WorktreeError(format!(
            "{project_path:?} is not a git repository (auto-init failed)"
        )));
    }

    // Reuse user's current non-default branch (no explicit base).
    if base_branch.is_none() {
        let current = current_branch(project_path).await;
        let default = detect_default_branch(project_path).await;
        if let (Some(c), Some(d)) = (current, default) {
            if c != d {
                return Ok(c);
            }
        }
    }

    let branch = compute_branch_name(label, session_id);
    let (rc, _, _) = git(
        &["rev-parse", "--verify", &format!("refs/heads/{branch}")],
        project_path,
    )
    .await;
    if rc == 0 {
        let (rc_c, _, err) = git(&["checkout", &branch], project_path).await;
        if rc_c != 0 {
            return Err(WorktreeError(format!(
                "branch '{branch}' exists but checkout failed: {err}"
            )));
        }
        return Ok(branch);
    }

    let base = match base_branch {
        Some(b) => b.to_string(),
        None => {
            let (rc_h, head, err) = git(&["rev-parse", "--abbrev-ref", "HEAD"], project_path).await;
            if rc_h != 0 {
                return Err(WorktreeError(format!("could not resolve HEAD: {err}")));
            }
            if head.is_empty() {
                "HEAD".into()
            } else {
                head
            }
        }
    };

    let (rc, _, err) = git(&["checkout", "-b", &branch, &base], project_path).await;
    if rc != 0 {
        return Err(WorktreeError(format!(
            "git checkout -b {branch} {base} failed: {err}"
        )));
    }
    Ok(branch)
}

/// Tear down a session's git worktree at `<source>/.fleetify-worktrees/<id>/`.
/// `--force` because the user is explicitly deleting the session — any
/// uncommitted state in the worktree is going away with the session, and
/// without `--force` the call fails on a dirty checkout. Idempotent:
/// missing source repo / missing worktree both noop to `true`.
pub async fn remove_worktree(source_path: &str, worktree_path: &str) -> bool {
    if source_path.is_empty() || worktree_path.is_empty() {
        return true;
    }
    if !is_git_repo(source_path).await {
        // Source repo gone — nothing to ask git to clean up; the user
        // may have deleted the project folder manually.
        let _ = std::fs::remove_dir_all(worktree_path);
        return true;
    }
    let (rc, _, _) = git(
        &["worktree", "remove", "--force", worktree_path],
        source_path,
    )
    .await;
    if rc != 0 {
        // `git worktree remove` failed (worktree directory missing,
        // already pruned, locked, …). Fall back to a manual rm so the
        // session's bytes don't linger on disk, then ask git to clean
        // its own bookkeeping.
        let _ = std::fs::remove_dir_all(worktree_path);
        let _ = git(&["worktree", "prune"], source_path).await;
    }
    true
}

/// Delete a local branch (`git branch -D`). Idempotent at the call site:
/// returns true on success; a missing branch returns false but is harmless
/// to the caller (best-effort teardown).
pub async fn delete_local_branch(repo_root: &str, branch: &str) -> bool {
    if branch.is_empty() {
        return true;
    }
    let (rc, _, _) = git(&["branch", "-D", branch], repo_root).await;
    rc == 0
}

/// Carve the NEXT round's worktree: a fresh, pristine checkout at
/// `<repo_root>/.fleetify-worktrees/<session_id>-r<N>` on a new branch
/// `fleet/<slug>-<sid8>-r<N>`, off the freshest `origin/<base>` (local
/// `<base>` fallback when offline). Create-before-remove — the caller
/// removes the old worktree AFTER repointing the session. Pristine, so the
/// untracked-file collision that aborts an in-place `checkout -b` cannot
/// happen.
pub async fn carve_next_round_worktree(
    project_path: &str,
    session_id: &str,
    label: Option<&str>,
    current_branch: Option<&str>,
    base_branch: Option<&str>,
) -> Result<(String, String), WorktreeError> {
    ensure_git_repo(project_path).await;
    if !is_git_repo(project_path).await {
        return Err(WorktreeError(format!(
            "{project_path:?} is not a git repository"
        )));
    }
    let (rc, root_out, err) = git(&["rev-parse", "--show-toplevel"], project_path).await;
    if rc != 0 {
        return Err(WorktreeError(format!("git rev-parse failed: {err}")));
    }
    let repo_root = PathBuf::from(&root_out);
    let cwd = repo_root.to_string_lossy().to_string();
    ensure_worktrees_ignored(&repo_root);

    let base = match base_branch {
        Some(b) => b.to_string(),
        None => resolve_base(project_path).await?,
    };
    // Refresh origin/<base> so the new round starts current; failure is
    // non-fatal (offline / no remote) — we fall back to the local base.
    let _ = git(&["fetch", "origin", &base], &cwd).await;
    let from = {
        let (rc_ref, _, _) = git(
            &[
                "rev-parse",
                "--verify",
                "--quiet",
                &format!("refs/remotes/origin/{base}"),
            ],
            project_path,
        )
        .await;
        if rc_ref == 0 {
            format!("origin/{base}")
        } else {
            base.clone()
        }
    };

    let cur_round = current_branch.map(parse_round).unwrap_or(1);
    let mut n = cur_round + 1;
    let ceiling = cur_round + 100;
    loop {
        if n > ceiling {
            return Err(WorktreeError("could not find a free round slot".into()));
        }
        let new_dir = repo_root
            .join(WORKTREES_DIRNAME)
            .join(format!("{session_id}-r{n}"));
        let new_branch = compute_round_branch(label, session_id, n);
        let dir_taken = new_dir.exists();
        let (rc_b, _, _) = git(
            &[
                "rev-parse",
                "--verify",
                "--quiet",
                &format!("refs/heads/{new_branch}"),
            ],
            project_path,
        )
        .await;
        if dir_taken || rc_b == 0 {
            n += 1;
            continue;
        }
        if let Some(parent) = new_dir.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let wt_str = new_dir.to_string_lossy().to_string();
        let (rc_add, _, err_add) = git(
            &[
                "worktree",
                "add",
                "--no-track",
                "-b",
                &new_branch,
                &wt_str,
                &from,
            ],
            &cwd,
        )
        .await;
        if rc_add != 0 {
            return Err(WorktreeError(format!("git worktree add failed: {err_add}")));
        }
        return Ok((wt_str, new_branch));
    }
}

/// `checkout`: Git-mode branch pick. `Some(B)` → the worktree checks out B
/// itself (a local tracking branch is materialised from `origin/B` when the
/// pick is remote-only). When git refuses because B is already checked out in
/// the main clone (double-checkout), fall back to carving the auto `fleet/…`
/// branch BASED on B — same shape the no-pick path produces.
pub async fn ensure_worktree(
    project_path: &str,
    session_id: &str,
    label: Option<&str>,
    base_branch: Option<&str>,
    checkout: Option<&str>,
) -> Result<(String, String), WorktreeError> {
    ensure_git_repo(project_path).await;
    if !is_git_repo(project_path).await {
        return Err(WorktreeError(format!(
            "{project_path:?} is not a git repository (auto-init failed)"
        )));
    }

    let (rc, root_out, err) = git(&["rev-parse", "--show-toplevel"], project_path).await;
    if rc != 0 {
        return Err(WorktreeError(format!("git rev-parse failed: {err}")));
    }
    let repo_root = PathBuf::from(&root_out);

    // Refuse worktree off a $HOME-rooted repo when project_path is inside it
    // (mirrors the dotfiles-in-$HOME guard).
    if let (Ok(project), Ok(repo), Some(home)) = (
        std::fs::canonicalize(project_path),
        std::fs::canonicalize(&repo_root),
        dirs_home(),
    ) {
        if let Ok(home_c) = std::fs::canonicalize(&home) {
            if repo == home_c && project != home_c {
                return Err(WorktreeError(format!(
                    "Refusing worktree: {project_path:?} is inside the $HOME git repo. \
                     Pick a folder that is its own git repo to get isolated worktrees."
                )));
            }
        }
    }

    ensure_worktrees_ignored(&repo_root);

    let wt_dir = repo_root.join(WORKTREES_DIRNAME).join(session_id);
    let branch = compute_branch_name(label, session_id);

    if wt_dir.is_dir() {
        let (rc_l, list_out, _) = git(
            &["worktree", "list", "--porcelain"],
            repo_root.to_str().unwrap_or("."),
        )
        .await;
        if rc_l == 0 && list_out.contains(wt_dir.to_string_lossy().as_ref()) {
            return Ok((wt_dir.to_string_lossy().to_string(), branch));
        }
    }

    if let Some(p) = wt_dir.parent() {
        let _ = std::fs::create_dir_all(p);
    }

    let wt_str = wt_dir.to_string_lossy().to_string();
    let cwd = repo_root.to_string_lossy().to_string();

    // Git-mode direct checkout (see doc comment).
    if let Some(b) = checkout.map(str::trim).filter(|b| !b.is_empty()) {
        let (rc_show, _, _) =
            git(&["show-ref", "--verify", &format!("refs/heads/{b}")], &cwd).await;
        if rc_show != 0 {
            // Remote-only pick — materialise the local tracking branch.
            let _ = git(&["branch", "--track", b, &format!("origin/{b}")], &cwd).await;
        }
        let (rc_add, _, err_add) = git(&["worktree", "add", &wt_str, b], &cwd).await;
        if rc_add == 0 {
            return Ok((wt_str, b.to_string()));
        }
        let lerr = err_add.to_lowercase();
        if !(lerr.contains("already checked out") || lerr.contains("already used")) {
            return Err(WorktreeError(format!("git worktree add failed: {err_add}")));
        }
        tracing::info!(
            branch = b,
            fallback = %branch,
            "worktree.checkout_branch busy — carving fleet branch based on it"
        );
        let (rc_fb, _, err_fb) = git(&["worktree", "add", "-b", &branch, &wt_str, b], &cwd).await;
        if rc_fb != 0 {
            return Err(WorktreeError(format!("git worktree add failed: {err_fb}")));
        }
        return Ok((wt_str, branch));
    }

    let base = match base_branch {
        Some(b) => b.to_string(),
        None => resolve_base(project_path).await?,
    };

    let (rc, _, err) = git(&["worktree", "add", "-b", &branch, &wt_str, &base], &cwd).await;
    if rc != 0 {
        let lerr = err.to_lowercase();
        if lerr.contains("already exists") || lerr.contains("already used") {
            let (rc2, _, err2) = git(&["worktree", "add", &wt_str, &branch], &cwd).await;
            if rc2 != 0 {
                return Err(WorktreeError(format!(
                    "git worktree add failed: {}",
                    if err2.is_empty() { err } else { err2 }
                )));
            }
        } else {
            return Err(WorktreeError(format!("git worktree add failed: {err}")));
        }
    }

    Ok((wt_str, branch))
}

fn dirs_home() -> Option<PathBuf> {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()
        .map(PathBuf::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git_available() -> bool {
        fleetify_core::process::command("git")
            .arg("--version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    /// Regression: an EXISTING repo with no `.gitignore` got no ignore entry at
    /// all — `ensure_worktrees_ignored` bailed on the missing file. The next
    /// `git add -A` (Create PR runs one) then staged `.fleetify-worktrees/<id>`
    /// as an embedded git repository and committed a gitlink into the user's
    /// PR. Observed live: `ok · git add -A (pre-push) · warning: adding
    /// embedded git repository: .fleetify-worktrees/5f5db2e0-…`.
    #[test]
    fn worktrees_ignored_via_info_exclude_when_there_is_no_gitignore() {
        if !git_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path();
        assert!(fleetify_core::process::command("git")
            .args(["init", "-b", "main"])
            .current_dir(repo)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false));
        assert!(!repo.join(".gitignore").exists());

        ensure_worktrees_ignored(repo);

        // No `.gitignore` conjured into a repo that deliberately has none…
        assert!(!repo.join(".gitignore").exists());
        // …but git now ignores the dir all the same.
        let exclude = std::fs::read_to_string(repo.join(".git/info/exclude")).unwrap();
        assert!(
            exclude
                .lines()
                .any(|l| l.trim().trim_end_matches('/') == WORKTREES_DIRNAME),
            "info/exclude missing the entry: {exclude}"
        );

        // Idempotent — a second call must not duplicate the entry.
        ensure_worktrees_ignored(repo);
        let again = std::fs::read_to_string(repo.join(".git/info/exclude")).unwrap();
        assert_eq!(
            again.matches(WORKTREES_DIRNAME).count(),
            1,
            "entry duplicated: {again}"
        );
    }

    /// The point of the ignore: `git add -A` (which Create PR runs before it
    /// pushes) must not stage the session worktree as an embedded repo.
    #[test]
    fn git_add_all_skips_the_worktrees_dir_once_ignored() {
        if !git_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path();
        let run = |args: &[&str], cwd: &Path| {
            fleetify_core::process::command("git")
                .args(args)
                .current_dir(cwd)
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false)
        };
        if !run(&["init", "-b", "main"], repo) {
            return;
        }
        let _ = run(&["config", "user.email", "t@x"], repo);
        let _ = run(&["config", "user.name", "T"], repo);
        std::fs::write(
            repo.join("app.js"),
            "export const a = 1;
",
        )
        .unwrap();
        assert!(run(&["add", "-A"], repo) && run(&["commit", "-m", "init"], repo));

        // A session worktree: a nested repo, exactly what git turns into a gitlink.
        let wt = repo.join(WORKTREES_DIRNAME).join("sid-1");
        std::fs::create_dir_all(&wt).unwrap();
        assert!(run(&["init", "-b", "main"], &wt));
        std::fs::write(wt.join("scratch.txt"), "x").unwrap();

        ensure_worktrees_ignored(repo);
        assert!(run(&["add", "-A"], repo));

        let staged = fleetify_core::process::command("git")
            .args(["diff", "--cached", "--name-only"])
            .current_dir(repo)
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
            .unwrap_or_default();
        assert!(
            !staged.contains(WORKTREES_DIRNAME),
            "worktree dir was staged anyway: {staged}"
        );
    }

    /// When the repo DOES have a `.gitignore`, the entry still belongs there —
    /// visible and travelling with the repo — not in `info/exclude`.
    #[test]
    fn worktrees_ignored_appends_to_an_existing_gitignore() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path();
        std::fs::write(
            repo.join(".gitignore"),
            "node_modules/
",
        )
        .unwrap();

        ensure_worktrees_ignored(repo);

        let gi = std::fs::read_to_string(repo.join(".gitignore")).unwrap();
        assert!(
            gi.contains("node_modules/"),
            "clobbered existing rules: {gi}"
        );
        assert!(gi
            .lines()
            .any(|l| l.trim().trim_end_matches('/') == WORKTREES_DIRNAME));

        ensure_worktrees_ignored(repo);
        let again = std::fs::read_to_string(repo.join(".gitignore")).unwrap();
        assert_eq!(
            again.matches(WORKTREES_DIRNAME).count(),
            1,
            "duplicated: {again}"
        );
    }

    #[test]
    fn compute_branch_name_shape() {
        let b = compute_branch_name(Some("Auth Fix!"), "abcdef1234567890");
        assert_eq!(b, "fleet/Auth-Fix-abcdef12");
    }

    #[test]
    fn parse_round_reads_trailing_suffix() {
        assert_eq!(parse_round("fleet/auth-abcdef12"), 1); // no suffix → round 1
        assert_eq!(parse_round("fleet/auth-abcdef12-r2"), 2);
        assert_eq!(parse_round("fleet/auth-abcdef12-r17"), 17);
        assert_eq!(parse_round("fleet/my-repo-abcdef12"), 1); // "-r" inside slug, not a round
        assert_eq!(parse_round("fleet/foo-r5-abcdef12"), 1); // "-r5" not at the end
    }

    #[test]
    fn compute_round_branch_appends_only_for_round_2_plus() {
        let sid = "abcdef1234567890";
        assert_eq!(
            compute_round_branch(Some("auth"), sid, 1),
            "fleet/auth-abcdef12"
        );
        assert_eq!(
            compute_round_branch(Some("auth"), sid, 2),
            "fleet/auth-abcdef12-r2"
        );
        assert_eq!(
            compute_round_branch(Some("auth"), sid, 3),
            "fleet/auth-abcdef12-r3"
        );
    }

    #[test]
    fn is_under_detects_managed_clone_paths() {
        let root = Path::new("/home/u/.fleetify/clones");
        assert!(is_under("/home/u/.fleetify/clones/github.com/o/r", root));
        assert!(is_under(
            "/home/u/.fleetify/clones/github.com/o/r/sub",
            root
        ));
        // A user-picked folder that merely shares a name prefix is NOT under.
        assert!(!is_under("/home/u/projects/clones-app", root));
        assert!(!is_under("/home/u/work/api", root));
    }

    #[test]
    fn gitignore_polyglot_order() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("package.json"), "{}").unwrap();
        std::fs::write(tmp.path().join("Cargo.toml"), "[package]").unwrap();
        let s = gitignore_content(tmp.path());
        assert!(s.contains(".fleetify-worktrees/"));
        // Stable order: node before rust in the output.
        let i_node = s.find("# Node").unwrap();
        let i_rust = s.find("# Rust").unwrap();
        assert!(i_node < i_rust, "stable order broken");
        assert!(!s.contains("# Python"));
    }

    /// Force-init a clean isolated repo INSIDE `path`, regardless of any
    /// ancestor git repo (Windows tempdirs sometimes land under one).
    /// The nested `.git` shadows ancestors for queries inside `path`.
    async fn clean_repo(path: &str) {
        let _ = git(&["init", "-b", "main"], path).await;
        let _ = git(&["config", "user.email", "t@x"], path).await;
        let _ = git(&["config", "user.name", "T"], path).await;
        let _ = git(&["commit", "-m", "init", "--allow-empty"], path).await;
    }

    #[tokio::test]
    async fn ensure_git_repo_is_idempotent_and_writes_gitignore() {
        if !git_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().to_string_lossy().to_string();
        clean_repo(&p).await;
        assert!(is_git_repo(&p).await, "setup failed: not a repo after init");
        // Idempotent — second call must be a no-op (already a repo).
        assert!(!ensure_git_repo(&p).await);
        // HEAD resolves to main after our setup.
        let (rc, head, _) = git(&["rev-parse", "--abbrev-ref", "HEAD"], &p).await;
        assert_eq!(rc, 0);
        assert_eq!(head, "main");
        // gitignore_content includes the worktrees pack — generation is pure.
        let body = gitignore_content(tmp.path());
        assert!(body.contains(".fleetify-worktrees/"));
    }

    #[tokio::test]
    async fn ensure_session_branch_carves_and_is_idempotent() {
        if !git_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().to_string_lossy().to_string();
        clean_repo(&p).await;
        let sid = "abcdef1234567890";
        let b1 = ensure_session_branch(&p, sid, Some("auth"), None)
            .await
            .expect("carve");
        assert_eq!(b1, "fleet/auth-abcdef12");
        assert_eq!(
            current_branch(&p).await.as_deref(),
            Some("fleet/auth-abcdef12")
        );
        let b2 = ensure_session_branch(&p, sid, Some("auth"), None)
            .await
            .expect("idempotent");
        assert_eq!(b2, b1);
    }

    #[tokio::test]
    async fn carve_next_round_makes_a_pristine_sibling_worktree() {
        if !git_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().to_string_lossy().to_string();
        clean_repo(&p).await;
        let sid = "abcdef1234567890";
        // round 1
        let (wt1, b1) = ensure_worktree(&p, sid, Some("auth"), None, None)
            .await
            .expect("r1");
        assert!(std::path::Path::new(&wt1).is_dir());
        assert_eq!(b1, "fleet/auth-abcdef12");
        // a leftover UNTRACKED file in the round-1 worktree must NOT break the next round
        std::fs::write(std::path::Path::new(&wt1).join("scratch.txt"), "junk").unwrap();
        // round 2
        let (wt2, b2) = carve_next_round_worktree(&p, sid, Some("auth"), Some(&b1), None)
            .await
            .expect("r2");
        assert_eq!(b2, "fleet/auth-abcdef12-r2");
        assert!(wt2.ends_with(&format!("{sid}-r2")), "got {wt2}");
        assert!(std::path::Path::new(&wt2).is_dir());
        assert_ne!(wt1, wt2, "round 2 must be a NEW directory");
    }

    #[tokio::test]
    async fn worktree_checks_out_the_picked_branch_and_falls_back_on_collision() {
        if !git_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().to_string_lossy().to_string();
        clean_repo(&p).await;
        let _ = git(&["branch", "feature-x"], &p).await;
        // Picked branch is free → the worktree opens ON it (Git-mode pick).
        let (wt, b) = ensure_worktree(
            &p,
            "1111222233334444",
            Some("auth"),
            None,
            Some("feature-x"),
        )
        .await
        .expect("picked branch carve");
        assert_eq!(b, "feature-x");
        assert!(std::path::Path::new(&wt).is_dir());
        // Picked branch is checked out in the main clone (main) — git refuses
        // a double checkout, so we fall back to a fleet/… branch BASED on it.
        let (_wt2, b2) = ensure_worktree(&p, "5555666677778888", Some("auth"), None, Some("main"))
            .await
            .expect("collision fallback");
        assert_eq!(b2, "fleet/auth-55556666");
    }

    #[tokio::test]
    async fn delete_local_branch_is_idempotent() {
        if !git_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().to_string_lossy().to_string();
        clean_repo(&p).await;
        let _ = git(&["branch", "throwaway"], &p).await;
        assert!(delete_local_branch(&p, "throwaway").await);
        // second delete (already gone) is harmless
        let _ = delete_local_branch(&p, "throwaway").await;
        let (rc, _, _) = git(
            &["rev-parse", "--verify", "--quiet", "refs/heads/throwaway"],
            &p,
        )
        .await;
        assert_ne!(rc, 0, "branch should no longer exist");
    }
}
