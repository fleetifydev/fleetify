//! GitHub REST PR creation — link-path replacement for `gh pr create`.
//!
//! Faithful port of `electron/github-rest.cjs`. Called by
//! `shell::git::create_pr` when the `gh` CLI isn't available and a
//! GitHub link exists in the keychain (`shell::github_link::get_link`).
//! Token comes from `github_link::get_link()` — never crosses IPC.
//!
//! Public entrypoint: `create_pr_via_link(folder, link, opts)`.

use std::path::Path;
use std::time::Duration;

use serde::Deserialize;
use serde_json::{json, Value};

use super::git::run;

const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

fn fail(code: &str, msg: &str) -> Value {
    json!({ "ok": false, "code": code, "error": msg })
}

#[derive(Debug, Clone)]
pub struct Origin {
    pub host: String,
    pub owner: String,
    pub repo: String,
}

/// Parse a remote URL into (host, owner, repo). Supports both
/// `https://github.com/<owner>/<repo>[.git]` and
/// `git@github.com:<owner>/<repo>[.git]`.
pub fn parse_origin(url: &str) -> Option<Origin> {
    let trimmed = url.trim().trim_end_matches('/');
    // https form
    if let Some(rest) = trimmed
        .strip_prefix("https://")
        .or_else(|| trimmed.strip_prefix("http://"))
    {
        let (host, path) = rest.split_once('/')?;
        let parts: Vec<&str> = path.split('/').collect();
        if parts.len() >= 2 {
            let owner = parts[0].to_string();
            let repo = parts[1].trim_end_matches(".git").to_string();
            return Some(Origin {
                host: host.to_string(),
                owner,
                repo,
            });
        }
        return None;
    }
    // ssh form
    if let Some(rest) = trimmed.strip_prefix("git@") {
        let (host, path) = rest.split_once(':')?;
        let parts: Vec<&str> = path.split('/').collect();
        if parts.len() >= 2 {
            let owner = parts[0].to_string();
            let repo = parts[1].trim_end_matches(".git").to_string();
            return Some(Origin {
                host: host.to_string(),
                owner,
                repo,
            });
        }
    }
    None
}

/// `https://x-access-token:<token>@<host>/<owner>/<repo>.git` for an
/// ephemeral push URL. Never persisted to .git/config.
pub fn token_injected_url(origin: &Origin, token: &str) -> String {
    format!(
        "https://x-access-token:{token}@{host}/{owner}/{repo}.git",
        host = origin.host,
        owner = origin.owner,
        repo = origin.repo
    )
}

/// Cross-platform basename sanitiser. Strips non-[A-Za-z0-9._-] chars,
/// caps at 100 chars, falls back to "fleet-project".
pub fn sanitize_repo_name(folder_path: &str) -> String {
    let input = folder_path.replace('\\', "/");
    let base = input.rsplit('/').next().unwrap_or(folder_path).trim();
    let cleaned: String = base
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect();
    // Strip leading + trailing hyphens.
    let trimmed = cleaned.trim_matches('-');
    let capped: String = trimmed.chars().take(100).collect();
    if capped.is_empty() {
        "fleet-project".to_string()
    } else {
        capped
    }
}

/// `fleet/<slug>-<8hex>` — matches the backend's session-start carve
/// shape so reviewers see the same branch convention regardless of
/// where the carve happened.
pub fn generate_feature_branch_name(title: &str) -> String {
    let slug: String = title
        .to_lowercase()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c
            } else {
                '-'
            }
        })
        .collect();
    let collapsed = collapse_hyphens(&slug);
    let trimmed = collapsed.trim_matches('-');
    let capped: String = trimmed.chars().take(32).collect();
    let slug = if capped.is_empty() {
        "fleet".to_string()
    } else {
        capped
    };
    use rand::RngCore;
    let mut buf = [0u8; 4];
    rand::thread_rng().fill_bytes(&mut buf);
    let id: String = buf.iter().map(|b| format!("{b:02x}")).collect();
    format!("fleet/{slug}-{id}")
}

fn collapse_hyphens(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut prev_hyphen = false;
    for c in s.chars() {
        if c == '-' {
            if !prev_hyphen {
                out.push('-');
            }
            prev_hyphen = true;
        } else {
            out.push(c);
            prev_hyphen = false;
        }
    }
    out
}

async fn detect_default_branch(folder: &Path) -> Option<String> {
    let (rc, out, _) = run(
        "git",
        &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
        folder,
        Duration::from_secs(5),
    )
    .await;
    if rc == 0 && !out.trim().is_empty() {
        let line = out.trim();
        if let Some((_, tail)) = line.split_once('/') {
            return Some(tail.to_string());
        }
        return Some(line.to_string());
    }
    for cand in ["main", "master"] {
        let (rc, _, _) = run(
            "git",
            &[
                "rev-parse",
                "--verify",
                "--quiet",
                &format!("refs/heads/{cand}"),
            ],
            folder,
            Duration::from_secs(5),
        )
        .await;
        if rc == 0 {
            return Some(cand.to_string());
        }
    }
    None
}

async fn add_origin_remote(folder: &Path, owner: &str, repo: &str) -> Value {
    let url = format!("https://github.com/{owner}/{repo}.git");
    let (rc, _, err) = run(
        "git",
        &["remote", "add", "origin", &url],
        folder,
        Duration::from_secs(10),
    )
    .await;
    if rc == 0 {
        return json!({ "ok": true, "url": url });
    }
    if err.to_lowercase().contains("already exists") {
        let (rc, out, _) = run(
            "git",
            &["remote", "get-url", "origin"],
            folder,
            Duration::from_secs(5),
        )
        .await;
        if rc == 0 && !out.trim().is_empty() {
            return json!({ "ok": true, "url": out.trim() });
        }
    }
    fail("ORIGIN_ADD_FAILED", err.trim())
}

async fn auth_headers(token: &str) -> reqwest::header::HeaderMap {
    let mut h = reqwest::header::HeaderMap::new();
    h.insert("Authorization", format!("Bearer {token}").parse().unwrap());
    h.insert("Accept", "application/vnd.github+json".parse().unwrap());
    h.insert("X-GitHub-Api-Version", "2022-11-28".parse().unwrap());
    h.insert(
        "User-Agent",
        format!("Fleetify-Desktop/{APP_VERSION}").parse().unwrap(),
    );
    h
}

#[derive(Deserialize)]
struct CreatedRepo {
    full_name: String,
    html_url: String,
}

async fn create_user_repo(token: &str, base_name: &str) -> Value {
    let client = reqwest::Client::new();
    let headers = auth_headers(token).await;
    for i in 1..=9 {
        let candidate = if i == 1 {
            base_name.to_string()
        } else {
            format!("{base_name}-{i}")
        };
        let res = client
            .post("https://api.github.com/user/repos")
            .headers(headers.clone())
            .header("Content-Type", "application/json")
            .json(&json!({
                "name": candidate,
                "private": true,
                "auto_init": false,
                "has_issues": false,
                "has_projects": false,
                "has_wiki": false,
            }))
            .send()
            .await;
        let r = match res {
            Ok(r) => r,
            Err(e) => return fail("NETWORK", &e.to_string()),
        };
        let status = r.status().as_u16();
        if status == 201 {
            let body: CreatedRepo = match r.json().await {
                Ok(b) => b,
                Err(_) => return fail("UNKNOWN", "GitHub 201 but malformed body."),
            };
            let parts: Vec<&str> = body.full_name.splitn(2, '/').collect();
            if parts.len() != 2 {
                return fail("UNKNOWN", "GitHub 201 full_name not <owner>/<repo>.");
            }
            return json!({
                "ok": true,
                "owner": parts[0],
                "repo": parts[1],
                "htmlUrl": body.html_url,
                "repoCreated": true,
            });
        }
        if status == 422 {
            continue; // name taken — try with suffix
        }
        if status == 401 {
            return fail("AUTH_EXPIRED", "GitHub link expired.");
        }
        if status == 403 {
            return fail(
                "REPO_CREATE_FORBIDDEN",
                "Fleetify's GitHub App can't create repos on its own. \
                 Install gh CLI or create the repo on github.com first.",
            );
        }
        if status >= 500 {
            return fail("GITHUB_DOWN", &format!("GitHub returned {status}."));
        }
        return fail("UNKNOWN", &format!("GitHub returned {status} on repo create."));
    }
    fail("NAME_TAKEN", "Tried 9 suffixed names, all taken.")
}

async fn fetch_existing_pr(token: &str, origin: &Origin, branch: &str) -> Option<(i64, String)> {
    let url = format!(
        "https://api.github.com/repos/{}/{}/pulls?head={}&state=open&per_page=1",
        origin.owner,
        origin.repo,
        urlencoding_minimal(&format!("{}:{}", origin.owner, branch))
    );
    let r = reqwest::Client::new()
        .get(&url)
        .headers(auth_headers(token).await)
        .send()
        .await
        .ok()?;
    if !r.status().is_success() {
        return None;
    }
    let arr: Value = r.json().await.ok()?;
    let first = arr.as_array()?.first()?;
    let number = first.get("number")?.as_i64()?;
    let html_url = first.get("html_url")?.as_str()?.to_string();
    Some((number, html_url))
}

fn urlencoding_minimal(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        let safe = matches!(b, b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~');
        if safe {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{:02X}", b));
        }
    }
    out
}

async fn call_pr(
    token: &str,
    origin: &Origin,
    title: &str,
    body: &str,
    branch: &str,
    base: &str,
    draft: bool,
) -> Value {
    let res = reqwest::Client::new()
        .post(&format!(
            "https://api.github.com/repos/{}/{}/pulls",
            origin.owner, origin.repo
        ))
        .headers(auth_headers(token).await)
        .header("Content-Type", "application/json")
        .json(&json!({
            "title": title,
            "body": body,
            "head": branch,
            "base": base,
            "draft": draft,
        }))
        .send()
        .await;
    let r = match res {
        Ok(r) => r,
        Err(e) => return fail("NETWORK", &e.to_string()),
    };
    let status = r.status();
    if status.as_u16() == 201 {
        let body: Value = r.json().await.unwrap_or(Value::Null);
        let number = body.get("number").and_then(|v| v.as_i64());
        let html_url = body
            .get("html_url")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        return json!({ "ok": true, "prNumber": number, "prUrl": html_url });
    }
    if status.as_u16() == 401 {
        return fail("AUTH_EXPIRED", "GitHub link expired.");
    }
    if status.as_u16() == 404 {
        return fail("REPO_NOT_INSTALLED", "Repo not accessible via this token.");
    }
    if status.as_u16() == 403 {
        return fail("PUSH_FORBIDDEN", "GitHub returned 403.");
    }
    if status.as_u16() == 422 {
        let body: Value = r.json().await.unwrap_or(Value::Null);
        let errors = body
            .get("errors")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|e| e.get("message").and_then(|m| m.as_str()))
                    .collect::<Vec<_>>()
                    .join(" | ")
            })
            .unwrap_or_default();
        let lo = errors.to_lowercase();
        if lo.contains("already exists") {
            return fail("PR_EXISTS", &errors);
        }
        if lo.contains("no commits") {
            return fail("NO_COMMITS", &errors);
        }
        return fail("VALIDATION", &errors);
    }
    if status.as_u16() >= 500 {
        return fail("GITHUB_DOWN", &format!("GitHub returned {}.", status.as_u16()));
    }
    fail("UNKNOWN", &format!("GitHub returned {}.", status.as_u16()))
}

/// Main entrypoint for the link path. Faithful port of
/// `electron/github-rest.cjs::createPRViaLink`.
pub async fn create_pr_via_link(
    folder: &Path,
    token: &str,
    title: &str,
    body: &str,
    base: Option<&str>,
    draft: bool,
) -> Value {
    let folder_str = folder.to_string_lossy().to_string();

    // 1. Origin: parse existing or create the GitHub repo + add remote.
    let (rc, remote_out, _) = run(
        "git",
        &["remote", "get-url", "origin"],
        folder,
        Duration::from_secs(5),
    )
    .await;
    let (origin, repo_created) = if rc == 0 && !remote_out.trim().is_empty() {
        let Some(o) = parse_origin(remote_out.trim()) else {
            return fail("ORIGIN_PARSE_FAILED", "Couldn't parse origin URL.");
        };
        if o.host.to_lowercase() != "github.com" {
            return fail("UNSUPPORTED_HOST", "Only github.com is supported.");
        }
        (o, false)
    } else {
        let base_name = sanitize_repo_name(&folder_str);
        let created = create_user_repo(token, &base_name).await;
        if created.get("ok").and_then(|v| v.as_bool()) != Some(true) {
            return created;
        }
        let owner = created.get("owner").and_then(|v| v.as_str()).unwrap_or("");
        let repo = created.get("repo").and_then(|v| v.as_str()).unwrap_or("");
        let added = add_origin_remote(folder, owner, repo).await;
        if added.get("ok").and_then(|v| v.as_bool()) != Some(true) {
            return added;
        }
        (
            Origin {
                host: "github.com".into(),
                owner: owner.into(),
                repo: repo.into(),
            },
            true,
        )
    };

    // 2. Resolve current branch.
    let (rc, branch_out, err) = run(
        "git",
        &["rev-parse", "--abbrev-ref", "HEAD"],
        folder,
        Duration::from_secs(5),
    )
    .await;
    if rc != 0 {
        return fail("NO_BRANCH", err.trim());
    }
    let mut branch = branch_out.trim().to_string();
    if branch == "HEAD" {
        return fail("DETACHED_HEAD", "HEAD is detached — checkout a branch first.");
    }

    // 3. Auto-carve when on the default branch.
    let default_branch = detect_default_branch(folder).await;
    let mut carved_from_default: Option<String> = None;
    if let Some(db) = default_branch.as_deref() {
        if branch == db {
            let new_branch = generate_feature_branch_name(title);
            let (rc, _, err) = run(
                "git",
                &["checkout", "-b", &new_branch],
                folder,
                Duration::from_secs(10),
            )
            .await;
            if rc != 0 {
                return fail("CARVE_FAILED", err.trim());
            }
            carved_from_default = Some(db.to_string());
            branch = new_branch;
        }
    }

    // 4. Push with token-injected URL. Includes base ref when we just
    //    carved or bootstrapped — same logic as Python.
    let push_url = token_injected_url(&origin, token);
    let mut push_args: Vec<String> = vec!["push".into(), push_url.clone()];
    if repo_created || carved_from_default.is_some() {
        let base_ref = base
            .map(String::from)
            .or_else(|| carved_from_default.clone())
            .or_else(|| default_branch.clone());
        if let Some(br) = base_ref {
            let mut base_spec: Option<String> = None;
            if repo_created && carved_from_default.is_some() {
                let (rc, root_out, _) = run(
                    "git",
                    &["rev-list", "--max-parents=0", "HEAD"],
                    folder,
                    Duration::from_secs(10),
                )
                .await;
                if rc == 0 {
                    let root_sha = root_out
                        .lines()
                        .next()
                        .map(str::trim)
                        .unwrap_or("")
                        .to_string();
                    if !root_sha.is_empty() {
                        base_spec = Some(format!("{root_sha}:refs/heads/{br}"));
                    }
                }
            }
            push_args.push(base_spec.unwrap_or_else(|| format!("refs/heads/{br}:{br}")));
        }
    }
    push_args.push(format!("HEAD:{branch}"));
    // -c credential.helper= disables GCM so the token-injected URL
    // stays ephemeral.
    let mut full_args: Vec<String> = vec!["-c".into(), "credential.helper=".into()];
    full_args.extend(push_args);
    let argv: Vec<&str> = full_args.iter().map(String::as_str).collect();
    let (rc, _, err) = run("git", &argv, folder, Duration::from_secs(60)).await;
    if rc != 0 {
        let msg = err.replace(&push_url, "https://x-access-token:***@…");
        return fail("PUSH_REJECTED", msg.trim());
    }

    // 5. POST /repos/<o>/<r>/pulls.
    let base_resolved = base
        .map(String::from)
        .or(default_branch)
        .unwrap_or_else(|| "main".to_string());
    let pr = call_pr(token, &origin, title, body, &branch, &base_resolved, draft).await;

    // 6. Handle PR-already-exists by fetching the existing one.
    if pr.get("code").and_then(|v| v.as_str()) == Some("PR_EXISTS") {
        if let Some((num, url)) = fetch_existing_pr(token, &origin, &branch).await {
            return json!({
                "ok": true,
                "prNumber": num,
                "prUrl": url,
                "existed": true,
                "repoCreated": repo_created,
            });
        }
    }

    if pr.get("ok").and_then(|v| v.as_bool()) == Some(true) && repo_created {
        let mut out = pr.clone();
        if let Some(o) = out.as_object_mut() {
            o.insert("repoCreated".into(), Value::Bool(true));
            o.insert(
                "repoUrl".into(),
                Value::String(format!(
                    "https://github.com/{}/{}",
                    origin.owner, origin.repo
                )),
            );
        }
        return out;
    }
    pr
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_origin_https_and_ssh() {
        let a = parse_origin("https://github.com/foo/bar.git").unwrap();
        assert_eq!(a.host, "github.com");
        assert_eq!(a.owner, "foo");
        assert_eq!(a.repo, "bar");

        let b = parse_origin("git@github.com:foo/bar.git").unwrap();
        assert_eq!(b.host, "github.com");
        assert_eq!(b.owner, "foo");
        assert_eq!(b.repo, "bar");

        // Without .git suffix.
        let c = parse_origin("https://github.com/foo/bar").unwrap();
        assert_eq!(c.repo, "bar");

        // Garbage.
        assert!(parse_origin("not-a-url").is_none());
    }

    #[test]
    fn sanitize_repo_name_strips_special_chars() {
        assert_eq!(sanitize_repo_name("/Users/jack/My Project!"), "My-Project");
        assert_eq!(sanitize_repo_name("C:\\dev\\foo bar"), "foo-bar");
        assert_eq!(sanitize_repo_name(""), "fleet-project");
        assert_eq!(sanitize_repo_name("---"), "fleet-project");
    }

    #[test]
    fn generate_feature_branch_name_shape() {
        let n = generate_feature_branch_name("Refactor auth module");
        assert!(n.starts_with("fleet/refactor-auth-module-"));
        // 8 hex chars suffix.
        assert!(n.split('-').next_back().unwrap().chars().all(|c| c.is_ascii_hexdigit()));

        // Empty title falls back to "fleet".
        let n2 = generate_feature_branch_name("");
        assert!(n2.starts_with("fleet/fleet-"));
    }

    #[test]
    fn token_injected_url_includes_token() {
        let u = token_injected_url(
            &Origin {
                host: "github.com".into(),
                owner: "foo".into(),
                repo: "bar".into(),
            },
            "ghu_secret",
        );
        assert_eq!(
            u,
            "https://x-access-token:ghu_secret@github.com/foo/bar.git"
        );
    }
}
