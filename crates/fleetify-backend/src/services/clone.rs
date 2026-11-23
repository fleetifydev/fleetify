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

fn clones_root() -> PathBuf {
    fleetify_core::fleetify_home().join("clones")
}

/// The user's GitHub OAuth access token, pushed in-process by the Tauri shell
/// (it owns the keychain; the token never crosses to the renderer). Used to
/// clone PRIVATE github.com repos — without it, `git clone https://github.com/…`
/// of a private repo fails with "could not read Username … Device not
/// configured". `None` ⇒ unauthenticated clone (public repos / system creds).
static GITHUB_TOKEN: std::sync::RwLock<Option<String>> = std::sync::RwLock::new(None);

/// Set (or clear) the GitHub clone token. Called by the shell at startup and
/// after the user links / refreshes / disconnects GitHub.
pub fn set_github_token(token: Option<String>) {
    if let Ok(mut g) = GITHUB_TOKEN.write() {
        *g = token.filter(|t| !t.is_empty());
    }
}

/// Rewrite an `https://github.com/owner/repo[.git]` URL to embed the token as
/// `https://x-access-token:<token>@github.com/owner/repo.git` so the clone (and
/// later fetches via the stored remote) authenticate. Non-github / non-https /
/// already-credentialed URLs, or no token on file, are returned unchanged.
fn inject_github_token(url: &str) -> String {
    let token = match GITHUB_TOKEN.read().ok().and_then(|g| g.clone()) {
        Some(t) => t,
        None => return url.to_string(),
    };
    // Only plain https github.com URLs without existing credentials.
    let Some(rest) = url.strip_prefix("https://github.com/") else {
        return url.to_string();
    };
    if url.contains('@') {
        return url.to_string();
    }
    format!("https://x-access-token:{token}@github.com/{rest}")
}

/// Replace any embedded token in an error string so it never reaches logs / UI.
fn redact_token(text: &str) -> String {
    match GITHUB_TOKEN.read().ok().and_then(|g| g.clone()) {
        Some(t) if !t.is_empty() => text.replace(&t, "***"),
        _ => text.to_string(),
    }
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
    let mut cmd = fleetify_core::process::tokio_command("git");
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

/// Map a git URL to a stable, collision-free relative directory key
/// `<host>/<owner>/<repo>`. Falls back to the safe leaf name (via
/// `repo_name_from_url`) when host/owner can't be parsed, so the result
/// is never empty and never escapes the clones root.
///
/// Without this, `repo_name_from_url`'s bare-leaf key collides whenever
/// two different repos share a leaf name (`team-a/api` vs `team-b/api`),
/// which — now that clones are reused across sessions — would silently
/// attach the second session to the first's unrelated clone.
pub fn clone_dir_key(url: &str) -> String {
    let raw = url.trim().trim_end_matches('/');
    let raw = raw.strip_suffix(".git").unwrap_or(raw);

    // Normalise the three common forms to "<host>/<path>":
    //   https://host/owner/repo  ·  ssh://git@host/owner/repo
    //   git@host:owner/repo  (scp-like)
    let host_and_path: Option<(String, String)> = if let Some(rest) = raw
        .strip_prefix("https://")
        .or_else(|| raw.strip_prefix("http://"))
        .or_else(|| raw.strip_prefix("ssh://"))
    {
        let rest = rest.rsplit('@').next().unwrap_or(rest); // drop user@
        let mut it = rest.splitn(2, '/');
        match (it.next(), it.next()) {
            (Some(h), Some(p)) if !h.is_empty() && !p.is_empty() => {
                Some((h.to_string(), p.to_string()))
            }
            _ => None,
        }
    } else if let Some(rest) = raw.split_once('@').map(|(_, r)| r) {
        // scp-like: git@host:owner/repo
        rest.split_once(':').and_then(|(h, p)| {
            if h.is_empty() || p.is_empty() {
                None
            } else {
                Some((h.to_string(), p.trim_start_matches('/').to_string()))
            }
        })
    } else {
        None
    };

    match host_and_path {
        Some((host, path)) => {
            let safe_host = repo_name_re().replace_all(&host, "-");
            let safe_path: Vec<String> = path
                .split('/')
                .filter(|s| !s.is_empty())
                .map(|seg| repo_name_re().replace_all(seg, "-").to_string())
                .collect();
            if safe_path.is_empty() {
                repo_name_from_url(url)
            } else {
                format!("{}/{}", safe_host.trim_matches('-'), safe_path.join("/"))
            }
        }
        None => repo_name_from_url(url),
    }
}

/// Clone `url` into `~/.fleetify/clones/<host>/<owner>/<repo>/` or fetch
/// if already present. Returns `(absolute_path, current_branch)`.
/// A remote URL as the user gave it, trimmed. One that starts with `-`
/// would reach git as an option rather than a repository, so it's refused
/// before git runs; every call also ends git's options with `--`.
fn remote_url(url: &str) -> Result<&str, CloneError> {
    let url = url.trim();
    if url.is_empty() {
        return Err(CloneError::Failed("Empty URL".into()));
    }
    if url.starts_with('-') {
        return Err(CloneError::Failed(
            "A repository URL can't start with '-'".into(),
        ));
    }
    Ok(url)
}

/// `git clone`'s arguments: options, then `--`, then the URL and the folder.
fn clone_args<'a>(url: &'a str, branch: Option<&'a str>, path: &'a str) -> Vec<&'a str> {
    let mut args = vec!["-c", "credential.helper=", "clone", "--filter=blob:none"];
    if let Some(b) = branch {
        args.push("--branch");
        args.push(b);
    }
    args.extend(["--", url, path]);
    args
}

pub async fn clone_or_pull(
    url: &str,
    branch: Option<&str>,
) -> Result<(String, String), CloneError> {
    let url = remote_url(url)?;
    let key = clone_dir_key(url);
    let root = clones_root();
    let path = root.join(&key);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }

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
        // Authenticate private github.com clones with the Fleetify GitHub token
        // (no-op for public repos / non-github URLs). `-c credential.helper=`
        // disables Git Credential Manager so a non-interactive run fails fast
        // instead of blocking on a username prompt.
        let auth_url = inject_github_token(url);
        let args = clone_args(&auth_url, branch, &path_str);
        let (rc, _out, err) = git_cmd(&args, None, 300).await;
        if rc != 0 {
            // Best-effort cleanup so a partial clone doesn't block the next
            // attempt with the "not a git repository" branch above.
            if path.exists() {
                let _ = std::fs::remove_dir_all(&path);
            }
            // Redact the token if it leaked into the error text.
            let err = redact_token(&err);
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

/// Verify that `url` resolves to a reachable git remote — without actually
/// cloning. Runs `git ls-remote <url>` with a 20s timeout and
/// `GIT_TERMINAL_PROMPT=0` so a missing credential helper fails fast
/// instead of hanging the request. Auth (when present) still flows
/// through the system git credential helper, so private repos work
/// exactly like `git clone` does.
pub async fn check_accessible(url: &str) -> Result<(), CloneError> {
    let url = remote_url(url)?;
    let mut cmd = fleetify_core::process::tokio_command("git");
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    cmd.args(["ls-remote", "--", url]);
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    let output = tokio::time::timeout(std::time::Duration::from_secs(20), cmd.output()).await;
    match output {
        Err(_) => Err(CloneError::Failed("git ls-remote timed out".into())),
        Ok(Err(e)) => Err(CloneError::Failed(format!("git launch failed: {e}"))),
        Ok(Ok(o)) => {
            if o.status.success() {
                Ok(())
            } else {
                let err = String::from_utf8_lossy(&o.stderr).trim().to_string();
                Err(CloneError::Failed(if err.is_empty() {
                    format!("git ls-remote exited {}", o.status.code().unwrap_or(-1))
                } else {
                    err
                }))
            }
        }
    }
}

/// Remote branch inventory for a URL — read via `ls-remote` so the composer
/// can offer real branches BEFORE the deferred clone runs.
#[derive(Debug, PartialEq, serde::Serialize)]
pub struct RemoteBranches {
    /// The remote's HEAD target (its default branch), when advertised.
    pub default_branch: Option<String>,
    /// All `refs/heads/*` names, remote order preserved.
    pub branches: Vec<String>,
}

/// Parse `git ls-remote --symref <url> HEAD refs/heads/*` output.
/// Lines look like:
///   `ref: refs/heads/main\tHEAD`      (the symref → default branch)
///   `<sha>\tHEAD`
///   `<sha>\trefs/heads/main`
fn parse_ls_remote(out: &str) -> RemoteBranches {
    let mut default_branch = None;
    let mut branches = Vec::new();
    for line in out.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if let Some(rest) = line.strip_prefix("ref: ") {
            if let Some(target) = rest.split_whitespace().next() {
                if let Some(name) = target.strip_prefix("refs/heads/") {
                    default_branch = Some(name.to_string());
                }
            }
            continue;
        }
        if let Some(refname) = line.split_whitespace().nth(1) {
            if let Some(name) = refname.strip_prefix("refs/heads/") {
                if !branches.iter().any(|b| b == name) {
                    branches.push(name.to_string());
                }
            }
        }
    }
    RemoteBranches {
        default_branch,
        branches,
    }
}

/// List a remote's branches + default without cloning. Same auth path as the
/// clone itself (GitHub token injection for private repos, credential helper
/// disabled so a missing credential fails fast instead of prompting).
pub async fn list_remote_branches(url: &str) -> Result<RemoteBranches, CloneError> {
    let url = remote_url(url)?;
    let auth_url = inject_github_token(url);
    let mut cmd = fleetify_core::process::tokio_command("git");
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    cmd.args([
        "-c",
        "credential.helper=",
        "ls-remote",
        "--symref",
        "--",
        &auth_url,
        "HEAD",
        "refs/heads/*",
    ]);
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    let output = tokio::time::timeout(std::time::Duration::from_secs(20), cmd.output()).await;
    match output {
        Err(_) => Err(CloneError::Failed("git ls-remote timed out".into())),
        Ok(Err(e)) => Err(CloneError::Failed(format!("git launch failed: {e}"))),
        Ok(Ok(o)) => {
            if o.status.success() {
                Ok(parse_ls_remote(&String::from_utf8_lossy(&o.stdout)))
            } else {
                let err = String::from_utf8_lossy(&o.stderr).trim().to_string();
                Err(CloneError::Failed(redact_token(&if err.is_empty() {
                    format!("git ls-remote exited {}", o.status.code().unwrap_or(-1))
                } else {
                    err
                })))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_ls_remote_extracts_default_and_heads() {
        let out = "ref: refs/heads/main\tHEAD\n\
                   aaaa\tHEAD\n\
                   aaaa\trefs/heads/main\n\
                   bbbb\trefs/heads/develop\n\
                   cccc\trefs/heads/feature/x\n";
        let parsed = parse_ls_remote(out);
        assert_eq!(parsed.default_branch.as_deref(), Some("main"));
        assert_eq!(parsed.branches, vec!["main", "develop", "feature/x"]);
    }

    #[test]
    fn parse_ls_remote_tolerates_missing_symref_and_dupes() {
        let out = "aaaa\trefs/heads/main\naaaa\trefs/heads/main\nbbbb\tHEAD\n";
        let parsed = parse_ls_remote(out);
        assert_eq!(parsed.default_branch, None);
        assert_eq!(parsed.branches, vec!["main"]);
        assert_eq!(
            parse_ls_remote(""),
            RemoteBranches {
                default_branch: None,
                branches: vec![]
            }
        );
    }

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

    #[test]
    fn clone_dir_key_disambiguates_same_leaf_across_owners() {
        // The whole point: two different repos that share a leaf name must
        // NOT collide into one clone dir.
        let a = clone_dir_key("https://github.com/team-a/api.git");
        let b = clone_dir_key("https://github.com/team-b/api.git");
        assert_ne!(a, b);
        assert_eq!(a, "github.com/team-a/api");
        assert_eq!(b, "github.com/team-b/api");
    }

    #[test]
    fn clone_dir_key_handles_https_ssh_scp_and_no_dotgit() {
        assert_eq!(
            clone_dir_key("https://github.com/anthropics/sdk.git"),
            "github.com/anthropics/sdk"
        );
        assert_eq!(
            clone_dir_key("git@github.com:user/My.Repo.git"),
            "github.com/user/My.Repo"
        );
        assert_eq!(
            clone_dir_key("https://gitlab.com/group/sub/proj"),
            "gitlab.com/group/sub/proj"
        );
        // Trailing slash, no .git.
        assert_eq!(clone_dir_key("https://github.com/o/r/"), "github.com/o/r");
    }

    #[test]
    fn clone_dir_key_falls_back_to_leaf_when_unparseable() {
        // No host/owner discernible → fall back to the safe leaf name so we
        // never produce an empty or path-traversing key.
        assert_eq!(clone_dir_key("weird-name"), "weird-name");
        assert_eq!(clone_dir_key("/"), "repo");
    }

    #[test]
    fn remote_url_refuses_what_git_would_read_as_an_option() {
        for url in ["-uhelp", "--upload-pack=touch marker", "  -x  "] {
            let err = remote_url(url).expect_err(url);
            assert!(
                err.to_string().contains("can't start with '-'"),
                "{url}: {err}"
            );
        }
        assert!(remote_url("").is_err());
        assert!(remote_url("   ").is_err());
        assert_eq!(
            remote_url("  https://github.com/a/b  ").unwrap(),
            "https://github.com/a/b"
        );
        assert_eq!(
            remote_url("git@github.com:a/b.git").unwrap(),
            "git@github.com:a/b.git"
        );
    }

    #[test]
    fn clone_args_end_options_before_the_url() {
        let args = clone_args("https://github.com/a/b", Some("main"), "/tmp/b");
        let sep = args
            .iter()
            .position(|a| *a == "--")
            .expect("a -- separator");
        assert_eq!(&args[sep + 1..], ["https://github.com/a/b", "/tmp/b"]);
        assert!(
            args[..sep].contains(&"--branch"),
            "options stay before --: {args:?}"
        );
        let plain = clone_args("https://github.com/a/b", None, "/tmp/b");
        assert_eq!(
            &plain[plain.len() - 3..],
            ["--", "https://github.com/a/b", "/tmp/b"]
        );
    }

    #[tokio::test]
    async fn option_shaped_urls_never_reach_git() {
        for url in ["-uhelp", "--upload-pack=touch marker"] {
            let msg = |e: CloneError| e.to_string();
            assert!(msg(check_accessible(url).await.unwrap_err()).contains("can't start with '-'"));
            assert!(
                msg(list_remote_branches(url).await.unwrap_err()).contains("can't start with '-'")
            );
            assert!(
                msg(clone_or_pull(url, None).await.unwrap_err()).contains("can't start with '-'")
            );
        }
    }

    #[tokio::test]
    async fn check_accessible_rejects_empty_url() {
        let result = check_accessible("").await;
        assert!(result.is_err(), "expected empty URL to be rejected");
    }

    #[tokio::test]
    async fn check_accessible_rejects_whitespace_only_url() {
        let result = check_accessible("   ").await;
        assert!(
            result.is_err(),
            "expected whitespace-only URL to be rejected"
        );
    }
}
