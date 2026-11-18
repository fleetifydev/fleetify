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

use super::git::{run, without_credentials};

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
/// `git@github.com:<owner>/<repo>[.git]`. The credentials an https remote
/// can hold (`https://user:token@github.com/…`) are dropped first, so they
/// never end up in the host.
pub fn parse_origin(url: &str) -> Option<Origin> {
    let url = without_credentials(url.trim());
    let trimmed = url.trim_end_matches('/');
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
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
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
        // The existing origin can hold credentials (`https://user:token@…`);
        // the answer goes without them.
        if rc == 0 && !out.trim().is_empty() {
            return json!({ "ok": true, "url": without_credentials(out.trim()) });
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
        return fail(
            "UNKNOWN",
            &format!("GitHub returned {status} on repo create."),
        );
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
        .post(format!(
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
        return fail(
            "GITHUB_DOWN",
            &format!("GitHub returned {}.", status.as_u16()),
        );
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
        // Repo-level bootstrap (repo name + create_user_repo + origin) must
        // target the MAIN checkout, never a linked worktree — its basename is a
        // UUID, not the project name. Branch-resolve + push below stay on
        // `folder` (the worktree); origin is shared via the common `.git`. No-op
        // for a normal checkout (bootstrap_dir == folder).
        let bootstrap_dir = super::git::main_worktree_root(folder).await;
        let base_name = sanitize_repo_name(&bootstrap_dir.to_string_lossy());
        let created = create_user_repo(token, &base_name).await;
        if created.get("ok").and_then(|v| v.as_bool()) != Some(true) {
            return created;
        }
        let owner = created.get("owner").and_then(|v| v.as_str()).unwrap_or("");
        let repo = created.get("repo").and_then(|v| v.as_str()).unwrap_or("");
        let added = add_origin_remote(&bootstrap_dir, owner, repo).await;
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
        return fail(
            "DETACHED_HEAD",
            "HEAD is detached — checkout a branch first.",
        );
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

// ─── REST/GraphQL PR lifecycle (OAuth-path parity with the gh backend) ───
// Pure `build_*` request shapers (unit-tested, no network) + thin `*_rest`
// senders. Output field names mirror the renderer's PRStatus / PRSummary.

/// Resolve the repo's origin (owner/repo). None when there's no origin
/// remote yet (fresh local repo never pushed → no remote PRs exist).
pub async fn resolve_origin(folder: &Path) -> Option<Origin> {
    let (rc, out, _) = run(
        "git",
        &["remote", "get-url", "origin"],
        folder,
        Duration::from_secs(5),
    )
    .await;
    if rc != 0 {
        return None;
    }
    parse_origin(out.trim())
}

/// Pure: (method, URL) for listing OPEN PRs, newest first.
pub fn build_list_prs_request(o: &Origin, limit: u32) -> (&'static str, String) {
    (
        "GET",
        format!(
            "https://api.{host}/repos/{owner}/{repo}/pulls?state=open&per_page={limit}&sort=created&direction=desc",
            host = o.host,
            owner = o.owner,
            repo = o.repo,
        ),
    )
}

/// Map REST pull objects → the renderer's PRSummary field names.
fn normalize_pr_list(arr: &Value) -> Value {
    let items = arr.as_array().cloned().unwrap_or_default();
    let mapped: Vec<Value> = items
        .iter()
        .map(|p| {
            json!({
                "number": p.get("number").cloned().unwrap_or(Value::Null),
                "state": p.get("state").and_then(|v| v.as_str()).map(|s| s.to_uppercase()).unwrap_or_default(),
                "headRefName": p.get("head").and_then(|h| h.get("ref")).cloned().unwrap_or(Value::Null),
                "isDraft": p.get("draft").cloned().unwrap_or(Value::Bool(false)),
                "title": p.get("title").cloned().unwrap_or(Value::Null),
                "url": p.get("html_url").cloned().unwrap_or(Value::Null),
            })
        })
        .collect();
    Value::Array(mapped)
}

/// Sender: `{ ok, prs }` (parity with `git::list_prs`).
pub async fn list_prs_rest(folder: &Path, token: &str, limit: u32) -> Value {
    let Some(o) = resolve_origin(folder).await else {
        return json!({ "ok": true, "prs": [] });
    };
    let (_, url) = build_list_prs_request(&o, limit);
    let client = reqwest::Client::new();
    match client
        .get(&url)
        .headers(auth_headers(token).await)
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => match r.json::<Value>().await {
            Ok(arr) => json!({ "ok": true, "prs": normalize_pr_list(&arr) }),
            Err(e) => fail("PARSE", &format!("list pulls: {e}")),
        },
        Ok(r) => fail("HTTP", &format!("list pulls: {}", r.status())),
        Err(e) => fail("NET", &e.to_string()),
    }
}

pub fn build_pr_view_request(o: &Origin, n: u64) -> (&'static str, String) {
    (
        "GET",
        format!(
            "https://api.{}/repos/{}/{}/pulls/{n}",
            o.host, o.owner, o.repo
        ),
    )
}

pub fn build_check_runs_request(o: &Origin, sha: &str) -> (&'static str, String) {
    (
        "GET",
        format!(
            "https://api.{}/repos/{}/{}/commits/{sha}/check-runs",
            o.host, o.owner, o.repo
        ),
    )
}

/// Pure: combine a pull object + check-runs into the renderer's PRStatus shape.
pub fn map_pr_status(pull: &Value, checks: &Value) -> Value {
    let mergeable = match pull.get("mergeable") {
        Some(Value::Bool(true)) => "MERGEABLE",
        Some(Value::Bool(false)) => "CONFLICTING",
        _ => "UNKNOWN",
    };
    // REST `mergeable_state` (clean/blocked/behind/dirty/unstable/draft/…) is
    // GitHub's branch-protection-aware merge state — upper-cased to match the
    // gh path's `mergeStateStatus`, so the renderer's Merge gate behaves
    // identically across the OAuth/REST and gh-CLI auth backends.
    let merge_state = pull
        .get("mergeable_state")
        .and_then(|v| v.as_str())
        .map(|s| s.to_uppercase());
    // REST `/commits/{sha}/check-runs` shares the renderer `checks` shape via
    // the SAME normalizer the gh path uses (counts + per-check runs[]).
    let runs = checks
        .get("check_runs")
        .and_then(|v| v.as_array())
        .map(|v| v.as_slice())
        .unwrap_or(&[]);
    let checks_obj = super::git::normalize_check_runs(runs);
    json!({
        "number": pull.get("number").cloned().unwrap_or(Value::Null),
        "url": pull.get("html_url").cloned().unwrap_or(Value::Null),
        "state": pull.get("state").and_then(|v| v.as_str()).map(|s| s.to_uppercase()).unwrap_or_default(),
        "mergeable": mergeable,
        "mergeStateStatus": merge_state,
        "isDraft": pull.get("draft").cloned().unwrap_or(Value::Bool(false)),
        "baseRefName": pull.get("base").and_then(|b| b.get("ref")).cloned().unwrap_or(Value::Null),
        "headRefName": pull.get("head").and_then(|h| h.get("ref")).cloned().unwrap_or(Value::Null),
        "checks": checks_obj,
        "commentsCount": pull.get("comments").cloned().unwrap_or(json!(0)),
    })
}

/// Sender: `{ ok, pr }`. Resolves number via head ref when `pr_number` is None.
pub async fn get_pr_status_rest(folder: &Path, token: &str, pr_number: Option<u64>) -> Value {
    let Some(o) = resolve_origin(folder).await else {
        return json!({ "ok": true, "pr": null });
    };
    let client = reqwest::Client::new();
    let headers = auth_headers(token).await;
    let number = match pr_number {
        Some(n) => n,
        None => {
            let Some(branch) = super::git::current_branch_str(folder).await else {
                return json!({ "ok": true, "pr": null });
            };
            let url = format!(
                "https://api.{}/repos/{}/{}/pulls?state=open&head={}:{}",
                o.host, o.owner, o.repo, o.owner, branch
            );
            match client.get(&url).headers(headers.clone()).send().await {
                Ok(r) if r.status().is_success() => match r.json::<Value>().await {
                    Ok(a) => match a
                        .as_array()
                        .and_then(|v| v.first())
                        .and_then(|p| p.get("number"))
                        .and_then(|n| n.as_u64())
                    {
                        Some(n) => n,
                        None => return json!({ "ok": true, "pr": null }),
                    },
                    Err(e) => return fail("PARSE", &e.to_string()),
                },
                Ok(r) => return fail("HTTP", &format!("list head: {}", r.status())),
                Err(e) => return fail("NET", &e.to_string()),
            }
        }
    };
    let (_, view_url) = build_pr_view_request(&o, number);
    let pull = match client.get(&view_url).headers(headers.clone()).send().await {
        Ok(r) if r.status().is_success() => r.json::<Value>().await.unwrap_or(Value::Null),
        Ok(r) => return fail("HTTP", &format!("pull view: {}", r.status())),
        Err(e) => return fail("NET", &e.to_string()),
    };
    let sha = pull
        .get("head")
        .and_then(|h| h.get("sha"))
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let (_, checks_url) = build_check_runs_request(&o, &sha);
    let checks_json = match client.get(&checks_url).headers(headers).send().await {
        Ok(r) if r.status().is_success() => r
            .json::<Value>()
            .await
            .unwrap_or(json!({ "check_runs": [] })),
        _ => json!({ "check_runs": [] }),
    };
    json!({ "ok": true, "pr": map_pr_status(&pull, &checks_json) })
}

/// Pure: GraphQL mutation body to convert a draft PR to ready.
pub fn build_ready_graphql(pr_node_id: &str) -> Value {
    json!({
        "query": "mutation($id:ID!){ markPullRequestReadyForReview(input:{pullRequestId:$id}){ pullRequest { isDraft } } }",
        "variables": { "id": pr_node_id }
    })
}

/// Sender: fetch node_id (REST) then POST GraphQL. "already ready" → noop.
pub async fn pr_ready_rest(folder: &Path, token: &str, pr_number: u64) -> Value {
    let Some(o) = resolve_origin(folder).await else {
        return fail("NO_ORIGIN", "no origin remote");
    };
    let client = reqwest::Client::new();
    let headers = auth_headers(token).await;
    let (_, view_url) = build_pr_view_request(&o, pr_number);
    let pull = match client.get(&view_url).headers(headers.clone()).send().await {
        Ok(r) if r.status().is_success() => r.json::<Value>().await.unwrap_or(Value::Null),
        Ok(r) => return fail("HTTP", &format!("pull view: {}", r.status())),
        Err(e) => return fail("NET", &e.to_string()),
    };
    if pull.get("draft").and_then(|v| v.as_bool()) == Some(false) {
        return json!({ "ok": true, "noop": true });
    }
    let Some(node_id) = pull.get("node_id").and_then(|v| v.as_str()) else {
        return fail("NO_NODE_ID", "pull missing node_id");
    };
    let res = client
        .post(format!("https://api.{}/graphql", o.host))
        .headers(headers)
        .json(&build_ready_graphql(node_id))
        .send()
        .await;
    match res {
        Ok(r) if r.status().is_success() => json!({ "ok": true }),
        Ok(r) => fail("HTTP", &format!("graphql ready: {}", r.status())),
        Err(e) => fail("NET", &e.to_string()),
    }
}

pub fn build_merge_request(o: &Origin, n: u64, method: &str) -> (&'static str, String, Value) {
    let merge_method = match method {
        "squash" => "squash",
        "rebase" => "rebase",
        _ => "merge",
    };
    (
        "PUT",
        format!(
            "https://api.{}/repos/{}/{}/pulls/{n}/merge",
            o.host, o.owner, o.repo
        ),
        json!({ "merge_method": merge_method }),
    )
}

pub fn build_delete_ref_request(o: &Origin, branch: &str) -> (&'static str, String) {
    (
        "DELETE",
        format!(
            "https://api.{}/repos/{}/{}/git/refs/heads/{branch}",
            o.host, o.owner, o.repo
        ),
    )
}

/// Sender: squash-merge → delete remote branch → local cleanup (REST doesn't
/// switch the checkout, so checkout base + delete the local branch).
pub async fn merge_pr_rest(folder: &Path, token: &str, pr_number: u64, method: &str) -> Value {
    let worktree = super::git::is_linked_worktree(folder);
    let Some(o) = resolve_origin(folder).await else {
        return fail("NO_ORIGIN", "no origin remote");
    };
    let client = reqwest::Client::new();
    let headers = auth_headers(token).await;
    let (_, view_url) = build_pr_view_request(&o, pr_number);
    let pull = match client.get(&view_url).headers(headers.clone()).send().await {
        Ok(r) if r.status().is_success() => r.json::<Value>().await.unwrap_or(Value::Null),
        _ => Value::Null,
    };
    let head_ref = pull
        .get("head")
        .and_then(|h| h.get("ref"))
        .and_then(|v| v.as_str())
        .map(String::from);
    let base_ref = pull
        .get("base")
        .and_then(|b| b.get("ref"))
        .and_then(|v| v.as_str())
        .unwrap_or("main")
        .to_string();

    let (_, merge_url, merge_body) = build_merge_request(&o, pr_number, method);
    match client
        .put(&merge_url)
        .headers(headers.clone())
        .json(&merge_body)
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => {
            tracing::info!(target: "merge/rest", "ok · PUT merge · merged #{pr_number} ({method})");
        }
        Ok(r) => {
            let code = r.status();
            let txt = r.text().await.unwrap_or_default();
            tracing::info!(target: "merge/rest", "FAIL · PUT merge · #{pr_number} · {code}");
            return fail(
                "MERGE_BLOCKED",
                &format!("{code}: {}", txt.chars().take(200).collect::<String>()),
            );
        }
        Err(e) => {
            tracing::info!(target: "merge/rest", "FAIL · PUT merge · #{pr_number} · net {e}");
            return fail("NET", &e.to_string());
        }
    }
    if let Some(branch) = &head_ref {
        let (_, del_url) = build_delete_ref_request(&o, branch);
        let _ = client.delete(&del_url).headers(headers).send().await;
        tracing::info!(target: "merge/rest", "ok · DELETE ref · remote {branch}");
    }
    if worktree {
        // The next-round flow owns local cleanup (removes the worktree + git
        // branch -D). A local `git checkout <base>` here would fail anyway —
        // base is checked out in the main repo — so skip it entirely.
        tracing::info!(
            target: "merge/rest",
            "ok · skip local cleanup · #{pr_number} (worktree → next-round cleans up)"
        );
    } else {
        let _ = run(
            "git",
            &["checkout", &base_ref],
            folder,
            Duration::from_secs(20),
        )
        .await;
        if let Some(branch) = &head_ref {
            let _ = run(
                "git",
                &["branch", "-D", branch],
                folder,
                Duration::from_secs(10),
            )
            .await;
        }
        tracing::info!(target: "merge/rest", "ok · local cleanup · checkout {base_ref} + branch -D");
    }
    json!({ "ok": true })
}

/// Delete a remote branch via REST `DELETE /git/refs/heads/<branch>`.
/// Idempotent: 404/422 (ref already gone) is success.
pub async fn delete_remote_branch_rest(folder: &Path, token: &str, branch: &str) -> Value {
    if branch.trim().is_empty() {
        return json!({ "ok": true, "noop": true });
    }
    let Some(o) = resolve_origin(folder).await else {
        return fail("NO_ORIGIN", "no origin remote");
    };
    let client = reqwest::Client::new();
    let headers = auth_headers(token).await;
    let (_, del_url) = build_delete_ref_request(&o, branch);
    match client.delete(&del_url).headers(headers).send().await {
        Ok(r) if r.status().is_success() => json!({ "ok": true }),
        Ok(r) if r.status().as_u16() == 404 || r.status().as_u16() == 422 => {
            json!({ "ok": true, "noop": true })
        }
        Ok(r) => {
            let code = r.status();
            let txt = r.text().await.unwrap_or_default();
            fail(
                "DELETE_FAILED",
                &format!("{code}: {}", txt.chars().take(200).collect::<String>()),
            )
        }
        Err(e) => fail("NET", &e.to_string()),
    }
}

// ─── Actions check re-run (parity gh ↔ rest) ───

/// Pure: (method, URL) to re-run a single failed Actions job.
pub fn build_rerun_job_request(o: &Origin, job_id: u64) -> (&'static str, String) {
    (
        "POST",
        format!(
            "https://api.{}/repos/{}/{}/actions/jobs/{job_id}/rerun",
            o.host, o.owner, o.repo
        ),
    )
}

/// Pure: (method, URL) to re-run the failed jobs of a workflow run.
pub fn build_rerun_run_request(o: &Origin, run_id: u64) -> (&'static str, String) {
    (
        "POST",
        format!(
            "https://api.{}/repos/{}/{}/actions/runs/{run_id}/rerun-failed-jobs",
            o.host, o.owner, o.repo
        ),
    )
}

/// Map a re-run POST response into our `{ok}` / `{ok:false,code}` shape.
fn rerun_status_to_value(status: u16, body_txt: &str) -> Value {
    if (200..300).contains(&status) {
        return json!({ "ok": true });
    }
    match status {
        403 => fail(
            "ACTIONS_FORBIDDEN",
            "GitHub denied the re-run — this sign-in can't write Actions. \
             Use the gh CLI sign-in or grant the workflow scope.",
        ),
        404 => fail(
            "NOT_FOUND",
            "Workflow run or job not found — it may have expired.",
        ),
        _ => fail(
            "HTTP",
            &format!(
                "GitHub returned {status}. {}",
                body_txt.chars().take(160).collect::<String>()
            ),
        ),
    }
}

async fn post_rerun(
    client: &reqwest::Client,
    headers: reqwest::header::HeaderMap,
    url: &str,
) -> Value {
    match client.post(url).headers(headers).send().await {
        Ok(r) => {
            let status = r.status().as_u16();
            let txt = r.text().await.unwrap_or_default();
            rerun_status_to_value(status, &txt)
        }
        Err(e) => fail("NETWORK", &e.to_string()),
    }
}

/// Sender: re-run one failed Actions job. `{ ok, rerun:1 }` on success.
pub async fn rerun_check_job_rest(folder: &Path, token: &str, job_id: u64) -> Value {
    let Some(o) = resolve_origin(folder).await else {
        return fail("NO_ORIGIN", "no origin remote");
    };
    let (_, url) = build_rerun_job_request(&o, job_id);
    let v = post_rerun(&reqwest::Client::new(), auth_headers(token).await, &url).await;
    if v.get("ok").and_then(|b| b.as_bool()) == Some(true) {
        json!({ "ok": true, "rerun": 1 })
    } else {
        v
    }
}

/// Sender: re-run the failed jobs of each distinct workflow run. Succeeds if at
/// least one run was re-queued; returns the last error otherwise.
pub async fn rerun_failed_checks_rest(folder: &Path, token: &str, run_ids: &[u64]) -> Value {
    let Some(o) = resolve_origin(folder).await else {
        return fail("NO_ORIGIN", "no origin remote");
    };
    let client = reqwest::Client::new();
    let headers = auth_headers(token).await;
    let mut ok = 0u32;
    let mut last_err: Option<Value> = None;
    for run_id in super::git::dedupe_ids(run_ids) {
        let (_, url) = build_rerun_run_request(&o, run_id);
        let v = post_rerun(&client, headers.clone(), &url).await;
        if v.get("ok").and_then(|b| b.as_bool()) == Some(true) {
            ok += 1;
        } else {
            last_err = Some(v);
        }
    }
    if ok > 0 {
        json!({ "ok": true, "rerun": ok })
    } else {
        last_err.unwrap_or_else(|| fail("NO_RUNS", "no rerunnable workflow runs"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rerun_request_shapes() {
        assert_eq!(
            build_rerun_job_request(&origin(), 456),
            (
                "POST",
                "https://api.github.com/repos/acme/app/actions/jobs/456/rerun".to_string()
            )
        );
        assert_eq!(
            build_rerun_run_request(&origin(), 123),
            (
                "POST",
                "https://api.github.com/repos/acme/app/actions/runs/123/rerun-failed-jobs"
                    .to_string()
            )
        );
    }

    #[test]
    fn rerun_status_mapping() {
        assert_eq!(rerun_status_to_value(201, "")["ok"], true);
        assert_eq!(rerun_status_to_value(200, "")["ok"], true);
        assert_eq!(
            rerun_status_to_value(403, "no")["code"],
            "ACTIONS_FORBIDDEN"
        );
        assert_eq!(rerun_status_to_value(404, "gone")["code"], "NOT_FOUND");
        assert_eq!(rerun_status_to_value(500, "boom")["ok"], false);
    }

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
    fn parse_origin_drops_the_credentials_an_origin_url_can_hold() {
        // They used to end up in the host, which then wasn't github.com.
        let o = parse_origin("https://user:tok@github.com/o/r.git").unwrap();
        assert_eq!(o.host, "github.com");
        assert_eq!(o.owner, "o");
        assert_eq!(o.repo, "r");
    }

    #[tokio::test]
    async fn adding_origin_answers_an_existing_one_without_its_credentials() {
        let tmp = tempfile::tempdir().unwrap();
        let folder = tmp.path();
        let (rc, _, _) = run("git", &["init"], folder, Duration::from_secs(10)).await;
        if rc != 0 {
            return; // no usable git here
        }
        let origin = "https://u:t@github.com/o/r.git";
        let (rc, _, err) = run(
            "git",
            &["remote", "add", "origin", origin],
            folder,
            Duration::from_secs(10),
        )
        .await;
        assert_eq!(rc, 0, "git remote add: {err}");
        assert_eq!(
            add_origin_remote(folder, "o", "r").await,
            json!({ "ok": true, "url": "https://github.com/o/r.git" })
        );
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
        assert!(n
            .split('-')
            .next_back()
            .unwrap()
            .chars()
            .all(|c| c.is_ascii_hexdigit()));

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

    fn origin() -> Origin {
        Origin {
            host: "github.com".into(),
            owner: "acme".into(),
            repo: "app".into(),
        }
    }

    #[test]
    fn list_prs_request_shape() {
        let (method, url) = build_list_prs_request(&origin(), 100);
        assert_eq!(method, "GET");
        assert_eq!(
            url,
            "https://api.github.com/repos/acme/app/pulls?state=open&per_page=100&sort=created&direction=desc"
        );
    }

    #[test]
    fn pr_view_and_check_runs_request_shape() {
        assert_eq!(
            build_pr_view_request(&origin(), 98).1,
            "https://api.github.com/repos/acme/app/pulls/98"
        );
        assert_eq!(
            build_check_runs_request(&origin(), "abc123").1,
            "https://api.github.com/repos/acme/app/commits/abc123/check-runs"
        );
    }

    #[test]
    fn pr_status_maps_rest_fields() {
        let pull = json!({
            "number": 98, "html_url": "https://github.com/acme/app/pull/98",
            "state": "open", "draft": true, "mergeable": true,
            "base": {"ref":"main"}, "head": {"ref":"fleet/x","sha":"abc"}, "comments": 3
        });
        let checks = json!({"check_runs":[
            {"conclusion":"success"},{"conclusion":"failure"},{"status":"in_progress","conclusion":null}
        ]});
        let pr = map_pr_status(&pull, &checks);
        assert_eq!(pr["number"], 98);
        assert_eq!(pr["state"], "OPEN");
        assert_eq!(pr["isDraft"], true);
        assert_eq!(pr["mergeable"], "MERGEABLE");
        assert_eq!(pr["baseRefName"], "main");
        assert_eq!(pr["headRefName"], "fleet/x");
        assert_eq!(pr["checks"]["passing"], 1);
        assert_eq!(pr["checks"]["failing"], 1);
        assert_eq!(pr["checks"]["pending"], 1);
        assert_eq!(pr["checks"]["total"], 3);
        assert_eq!(pr["commentsCount"], 3);
    }

    #[test]
    fn ready_graphql_body_shape() {
        let body = build_ready_graphql("PR_node_abc");
        assert!(body["query"]
            .as_str()
            .unwrap()
            .contains("markPullRequestReadyForReview"));
        assert_eq!(body["variables"]["id"], "PR_node_abc");
    }

    #[test]
    fn merge_and_delete_ref_request_shape() {
        let (m, url, body) = build_merge_request(&origin(), 98, "squash");
        assert_eq!(m, "PUT");
        assert_eq!(url, "https://api.github.com/repos/acme/app/pulls/98/merge");
        assert_eq!(body["merge_method"], "squash");
        assert_eq!(
            build_merge_request(&origin(), 1, "bogus").2["merge_method"],
            "merge"
        );
        let (dm, durl) = build_delete_ref_request(&origin(), "fleet/x-ab12");
        assert_eq!(dm, "DELETE");
        assert_eq!(
            durl,
            "https://api.github.com/repos/acme/app/git/refs/heads/fleet/x-ab12"
        );
    }
}
