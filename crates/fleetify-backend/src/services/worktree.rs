//! Faithful port of `app/services/worktree.py`. Per-session git
//! worktree/branch helper used by `session_manager::attach_git_setup`.
//! Auto-init for non-repo folders, language-aware `.gitignore`,
//! `fleet/<slug>-<short-id>` branch convention.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use regex::Regex;
use tokio::process::Command;

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

async fn git(args: &[&str], cwd: &str) -> (i32, String, String) {
    let out = Command::new("git")
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
/// keep current-HEAD behaviour so their local work isn't bypassed.
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

fn ensure_worktrees_ignored(folder: &Path) {
    let gi = folder.join(".gitignore");
    if !gi.exists() {
        return;
    }
    let Ok(existing) = std::fs::read_to_string(&gi) else {
        return;
    };
    let target = WORKTREES_DIRNAME.trim_end_matches('/');
    for line in existing.lines() {
        let stripped = line.trim().trim_end_matches('/');
        if stripped == target {
            return;
        }
    }
    let mut body = if existing.ends_with('\n') {
        existing
    } else {
        existing + "\n"
    };
    body.push_str(&format!("\n# Fleetify\n{WORKTREES_DIRNAME}/\n"));
    let _ = std::fs::write(&gi, body);
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

pub async fn ensure_worktree(
    project_path: &str,
    session_id: &str,
    label: Option<&str>,
    base_branch: Option<&str>,
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

    let base = match base_branch {
        Some(b) => b.to_string(),
        None => resolve_base(project_path).await?,
    };

    let wt_str = wt_dir.to_string_lossy().to_string();
    let cwd = repo_root.to_string_lossy().to_string();
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
        std::process::Command::new("git")
            .arg("--version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    #[test]
    fn compute_branch_name_shape() {
        let b = compute_branch_name(Some("Auth Fix!"), "abcdef1234567890");
        assert_eq!(b, "fleet/Auth-Fix-abcdef12");
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
}
