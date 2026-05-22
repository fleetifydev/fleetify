//! Faithful port of `app/services/clone.py`. Clones a git URL under
//! `~/.fleetify/clones/<repo>/` (or fetches if already present) and
//! returns the absolute path + current branch. The session toolbar's
//! source picker calls this when the user pastes a git URL instead of
//! browsing for a local folder.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use regex::Regex;

#[derive(Debug, thiserror::Error)]
pub enum CloneError {
    #[error("{0}")]
    Failed(String),
}

const CLONES_DIRNAME: &str = ".fleetify/clones";

fn home() -> PathBuf {
    PathBuf::from(
        std::env::var("USERPROFILE")
            .or_else(|_| std::env::var("HOME"))
            .unwrap_or_else(|_| ".".to_string()),
    )
}

fn clones_root() -> PathBuf {
    home().join(CLONES_DIRNAME)
}

fn repo_name_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"[^A-Za-z0-9._-]+").expect("REPO_NAME_RE"))
}

/// Pull a sane folder name out of a git URL — last path segment with
/// `.git` stripped, then any non-`[A-Za-z0-9._-]` char replaced with
/// `-`. Faithful with `_repo_name_from_url`.
pub fn repo_name_from_url(url: &str) -> String {
    let cleaned = url.trim().trim_end_matches('/');
    let cleaned = cleaned.strip_suffix(".git").unwrap_or(cleaned);
    let last = cleaned.rsplit(['/', ':']).next().unwrap_or("");
    let safe = repo_name_re().replace_all(last, "-");
    let trimmed = safe.trim_matches('-');
    if trimmed.is_empty() {
        "repo".to_string()
    } else {
        trimmed.to_string()
    }
}

/// Run `git <args>` with the given cwd, returning `(rc, stdout, stderr)`.
/// Times out at `timeout_secs` (defaults to 300s = 5 min, matching
/// Python's `_git` default).
pub async fn git_cmd(
    args: &[&str],
    cwd: Option<&Path>,
    timeout_secs: u64,
) -> (i32, String, String) {
    let mut cmd = tokio::process::Command::new("git");
    cmd.args(args);
    if let Some(c) = cwd {
        cmd.current_dir(c);
    }
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    let output =
        tokio::time::timeout(std::time::Duration::from_secs(timeout_secs), cmd.output()).await;
    match output {
        Err(_) => (-1, String::new(), "git command timed out".into()),
        Ok(Err(e)) => (-1, String::new(), e.to_string()),
        Ok(Ok(o)) => (
            o.status.code().unwrap_or(-1),
            String::from_utf8_lossy(&o.stdout).trim().to_string(),
            String::from_utf8_lossy(&o.stderr).trim().to_string(),
        ),
    }
}

/// Clone `url` into `~/.fleetify/clones/<repo>/` or fetch if already
/// present. Returns `(absolute_path, current_branch)`. Faithful with
/// `clone_or_pull`.
pub async fn clone_or_pull(
    url: &str,
    branch: Option<&str>,
) -> Result<(String, String), CloneError> {
    let url = url.trim();
    if url.is_empty() {
        return Err(CloneError::Failed("Empty URL".into()));
    }
    let repo = repo_name_from_url(url);
    let root = clones_root();
    let _ = std::fs::create_dir_all(&root);
    let path = root.join(&repo);

    if path.exists() {
        // Verify it's a real git repo (not a half-checked-out left-over).
        let (rc, _out, _err) =
            git_cmd(&["rev-parse", "--is-inside-work-tree"], Some(&path), 30).await;
        if rc != 0 {
            return Err(CloneError::Failed(format!(
                "Existing folder {} is not a git repository — delete it manually and retry",
                path.to_string_lossy()
            )));
        }
        // Best-effort fetch. A failed fetch (offline, auth changed)
        // still hands the path back — the user works with whatever
        // snapshot they already have. Matches Python behaviour.
        let (rc_f, _out, err) = git_cmd(&["fetch", "--all", "--prune"], Some(&path), 120).await;
        if rc_f != 0 {
            tracing::warn!(
                target: "clone",
                url = url,
                path = %path.to_string_lossy(),
                err = %err,
                "fetch failed (continuing with existing snapshot)"
            );
        }
    } else {
        let path_str = path.to_string_lossy().into_owned();
        let mut args: Vec<&str> = vec!["clone", "--filter=blob:none"];
        if let Some(b) = branch {
            args.push("--branch");
            args.push(b);
        }
        args.push(url);
        args.push(&path_str);
        let (rc, _out, err) = git_cmd(&args, None, 300).await;
        if rc != 0 {
            // Best-effort cleanup so a partial clone doesn't block the next
            // attempt with the "not a git repository" branch above.
            if path.exists() {
                let _ = std::fs::remove_dir_all(&path);
            }
            return Err(CloneError::Failed(if err.is_empty() {
                "git clone failed".into()
            } else {
                err
            }));
        }
    }

    let (rc_b, head_out, _) =
        git_cmd(&["rev-parse", "--abbrev-ref", "HEAD"], Some(&path), 30).await;
    let current_branch = if rc_b == 0 && !head_out.is_empty() {
        head_out
    } else {
        branch.unwrap_or("HEAD").to_string()
    };

    tracing::info!(
        target: "clone",
        url = url,
        path = %path.to_string_lossy(),
        branch = %current_branch,
        "clone ready"
    );
    Ok((path.to_string_lossy().into_owned(), current_branch))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repo_name_from_url_handles_https_ssh_and_no_dotgit() {
        assert_eq!(
            repo_name_from_url("https://github.com/anthropics/anthropic-sdk-python.git"),
            "anthropic-sdk-python"
        );
        assert_eq!(
            repo_name_from_url("git@github.com:user/My.Cool-Repo.git"),
            "My.Cool-Repo"
        );
        assert_eq!(
            repo_name_from_url("https://gitlab.com/group/sub/proj"),
            "proj"
        );
        // Edge: trailing slash + no .git.
        assert_eq!(repo_name_from_url("https://github.com/o/r/"), "r");
        // Edge: bare host as last segment — Python returns the host
        // verbatim because dots are safe. The function isn't trying
        // to detect "real" repos, just produce a sensible folder
        // name from what the user pasted.
        assert_eq!(repo_name_from_url("https://example.com/"), "example.com");
    }

    #[test]
    fn repo_name_from_url_falls_back_to_repo_when_segment_is_pure_garbage() {
        // Last "segment" is empty / all-unsafe chars → fallback "repo".
        assert_eq!(repo_name_from_url("/"), "repo");
        assert_eq!(repo_name_from_url(":"), "repo");
        assert_eq!(repo_name_from_url("---"), "repo");
    }

    #[test]
    fn repo_name_from_url_strips_unsafe_chars() {
        assert_eq!(
            repo_name_from_url("https://example.com/weird name!"),
            "weird-name"
        );
    }
}
