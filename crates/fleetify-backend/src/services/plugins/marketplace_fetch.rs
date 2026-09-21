//! Marketplace catalog fetcher — read-only over GitHub raw URLs.
//! Faithful port of `services/plugins/marketplace.py` (subset that the
//! renderer's catalog consumes). One `marketplace.json` fetch per
//! source + lazy plugin-manifest fill on missing entries; 1 h disk
//! cache so repeated catalog calls are sub-millisecond.

use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, Result};
use serde_json::Value;

use super::types::{MarketplaceEntry, MarketplaceManifest, PluginManifest};

const CACHE_TTL: Duration = Duration::from_secs(3600);
const HTTP_TIMEOUT: Duration = Duration::from_secs(15);

fn cache_dir() -> PathBuf {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| ".".into());
    PathBuf::from(home)
        .join(".fleetify")
        .join("marketplace-cache")
}

/// `https://github.com/<owner>/<repo>` → `(<owner>, <repo>)` with the
/// same validation the Python `validate_github_repo_url` enforces:
/// HTTPS only, github.com only, no auth/query/fragment, owner +
/// repo charset-restricted, no `..`.
pub fn validate_github_repo_url(repo_url: &str) -> Result<(String, String)> {
    if repo_url.is_empty() {
        return Err(anyhow!("repo_url must be non-empty"));
    }
    let trimmed = repo_url.trim_end_matches('/');
    let rest = trimmed
        .strip_prefix("https://")
        .ok_or_else(|| anyhow!("only https URLs are accepted: {repo_url:?}"))?;
    if rest.contains('@') || rest.contains('?') || rest.contains('#') {
        return Err(anyhow!(
            "URL must not contain auth/query/fragment: {repo_url:?}"
        ));
    }
    let (host, path) = rest
        .split_once('/')
        .ok_or_else(|| anyhow!("github URL must be /<owner>/<repo>: {repo_url:?}"))?;
    if host.to_lowercase() != "github.com" {
        return Err(anyhow!("only github.com URLs are accepted: {repo_url:?}"));
    }
    let parts: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    if parts.len() != 2 {
        return Err(anyhow!("github URL must be /<owner>/<repo>: {repo_url:?}"));
    }
    let owner = parts[0].to_string();
    let repo = parts[1].trim_end_matches(".git").to_string();
    let ok_chars = |s: &str| {
        !s.is_empty()
            && s != "."
            && s != ".."
            && s.chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
    };
    if !ok_chars(&owner) {
        return Err(anyhow!("invalid github owner: {owner:?}"));
    }
    if !ok_chars(&repo) {
        return Err(anyhow!("invalid github repo: {repo:?}"));
    }
    Ok((owner, repo))
}

/// Resolve `https://github.com/<owner>/<repo>` + path → raw URL.
pub fn gh_raw_url(repo_url: &str, path: &str) -> Result<String> {
    let (owner, repo) = validate_github_repo_url(repo_url)?;
    Ok(format!(
        "https://raw.githubusercontent.com/{owner}/{repo}/HEAD/{path}"
    ))
}

async fn http_get_json(url: &str) -> Result<Option<Value>> {
    tracing::info!(target: "fleetify.marketplace", "→ GET {url}");
    let client = reqwest::Client::builder()
        .timeout(HTTP_TIMEOUT)
        .user_agent("Fleet-Marketplace/0.1")
        .build()?;
    let r = client.get(url).send().await?;
    let status = r.status();
    if status.as_u16() == 404 {
        tracing::info!(target: "fleetify.marketplace", "← 404 {url}");
        return Ok(None);
    }
    if !status.is_success() {
        let body = r.text().await.unwrap_or_default();
        tracing::warn!(
            target: "fleetify.marketplace",
            "← {status} {url} body={}",
            body.chars().take(500).collect::<String>()
        );
        return Err(anyhow!("GET {url} returned {}", status.as_u16()));
    }
    let body: Value = r.json().await?;
    tracing::info!(
        target: "fleetify.marketplace",
        "← 200 {url} (entries={})",
        body.get("plugins")
            .and_then(|v| v.as_array())
            .map(|a| a.len())
            .unwrap_or(0)
    );
    Ok(Some(body))
}

/// Best-effort fetch of a UTF-8 text asset (README.md / CHANGELOG.md)
/// from a source repo. Returns `None` on any failure — a missing or
/// unreadable doc must never fail the detail endpoint, it just means the
/// renderer falls back to the manifest description / "no changelog".
pub async fn fetch_raw_text(repo_url: &str, path: &str) -> Option<String> {
    let url = gh_raw_url(repo_url, path).ok()?;
    tracing::info!(target: "fleetify.marketplace", "→ GET (text) {url}");
    let client = reqwest::Client::builder()
        .timeout(HTTP_TIMEOUT)
        .user_agent("Fleet-Marketplace/0.1")
        .build()
        .ok()?;
    let r = client.get(&url).send().await.ok()?;
    if !r.status().is_success() {
        return None;
    }
    let body = r.text().await.ok()?;
    if body.trim().is_empty() {
        return None;
    }
    Some(body)
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn cached_file(source_id: &str) -> PathBuf {
    cache_dir().join(format!("{source_id}.json"))
}

fn read_cache(source_id: &str) -> Option<(u128, MarketplaceManifest)> {
    let path = cached_file(source_id);
    let meta = std::fs::metadata(&path).ok()?;
    let mtime = meta.modified().ok()?;
    let mtime_ms = mtime.duration_since(UNIX_EPOCH).ok()?.as_millis();
    let raw = std::fs::read_to_string(&path).ok()?;
    let mm: MarketplaceManifest = serde_json::from_str(&raw).ok()?;
    Some((mtime_ms, mm))
}

fn write_cache(source_id: &str, mm: &MarketplaceManifest) -> Result<()> {
    let _ = std::fs::create_dir_all(cache_dir());
    let path = cached_file(source_id);
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(mm)?)?;
    std::fs::rename(&tmp, &path)?;
    Ok(())
}

fn is_fresh(source_id: &str) -> bool {
    let Some((mtime_ms, _)) = read_cache(source_id) else {
        return false;
    };
    now_ms().saturating_sub(mtime_ms) < CACHE_TTL.as_millis()
}

/// Fetch a source's `marketplace.json` (with single-plugin repo
/// fallback) and fill in any missing per-entry manifests by fetching
/// `<path>/.fleetify-plugin/plugin.json`.
pub async fn fetch_source(repo_url: &str) -> Result<MarketplaceManifest> {
    // 1. marketplace.json at repo root.
    let mm_url = gh_raw_url(repo_url, "marketplace.json")?;
    if let Some(raw) = http_get_json(&mm_url).await? {
        let mut mm: MarketplaceManifest = serde_json::from_value(raw)
            .map_err(|e| anyhow!("marketplace.json parse failed: {e}"))?;
        fill_inline_manifests(repo_url, &mut mm).await;
        return Ok(mm);
    }
    // 2. Fallback: single-plugin repo (root .fleetify-plugin/plugin.json).
    let pm_url = gh_raw_url(repo_url, ".fleetify-plugin/plugin.json")?;
    let Some(raw) = http_get_json(&pm_url).await? else {
        return Err(anyhow!(
            "{repo_url} is not a Fleet marketplace or plugin (no marketplace.json or .fleetify-plugin/plugin.json)"
        ));
    };
    let manifest: PluginManifest =
        serde_json::from_value(raw).map_err(|e| anyhow!("plugin.json parse failed: {e}"))?;
    Ok(MarketplaceManifest {
        name: String::new(),
        description: String::new(),
        plugins: vec![MarketplaceEntry {
            path: String::new(),
            manifest: Some(manifest),
            featured: false,
            source: None,
            homepage: None,
            description: None,
            author: None,
            tags: Vec::new(),
        }],
    })
}

async fn fill_inline_manifests(repo_url: &str, mm: &mut MarketplaceManifest) {
    // Concurrently fetch every entry's plugin.json that wasn't inlined.
    let futs: Vec<_> = mm
        .plugins
        .iter()
        .enumerate()
        .filter(|(_, e)| e.manifest.is_none() && !e.path.is_empty())
        .map(|(i, e)| {
            let path = e.path.clone();
            let url = gh_raw_url(repo_url, &format!("{path}/.fleetify-plugin/plugin.json"));
            async move {
                let Ok(url) = url else { return (i, None) };
                let raw = http_get_json(&url).await.ok().flatten();
                let manifest = raw.and_then(|v| serde_json::from_value::<PluginManifest>(v).ok());
                (i, manifest)
            }
        })
        .collect();
    let filled = futures_util::future::join_all(futs).await;
    for (i, manifest) in filled {
        if let Some(m) = manifest {
            if let Some(entry) = mm.plugins.get_mut(i) {
                entry.manifest = Some(m);
            }
        }
    }
}

/// Load a source: serves fresh-cached when within TTL, otherwise
/// re-fetches + writes the cache. On fetch error, serves the stale
/// cache so the UI doesn't go blank on transient GitHub failures.
///
/// Icons are inlined on the way out rather than into the catalog cache, so
/// every path below (fresh, cached, stale) hands the renderer `data:` URIs.
pub async fn load_source(
    source_id: &str,
    repo_url: &str,
    force: bool,
) -> Result<Vec<MarketplaceEntry>> {
    let mut entries = load_source_entries(source_id, repo_url, force).await?;
    let mut manifests: Vec<&mut PluginManifest> = entries
        .iter_mut()
        .filter_map(|e| e.manifest.as_mut())
        .collect();
    super::icons::inline_all(&mut manifests).await;
    Ok(entries)
}

async fn load_source_entries(
    source_id: &str,
    repo_url: &str,
    force: bool,
) -> Result<Vec<MarketplaceEntry>> {
    if !force && is_fresh(source_id) {
        if let Some((_, mm)) = read_cache(source_id) {
            tracing::info!(
                target: "fleetify.marketplace",
                "{source_id}: cache hit ({} entries)", mm.plugins.len()
            );
            return Ok(mm.plugins);
        }
    }
    tracing::info!(
        target: "fleetify.marketplace",
        "{source_id}: fetching {repo_url} (force={force})"
    );
    match fetch_source(repo_url).await {
        Ok(mm) => {
            let n = mm.plugins.len();
            let _ = write_cache(source_id, &mm);
            tracing::info!(
                target: "fleetify.marketplace",
                "{source_id}: cached {n} entries"
            );
            Ok(mm.plugins)
        }
        Err(e) => {
            if let Some((_, mm)) = read_cache(source_id) {
                tracing::warn!(
                    target: "fleetify.marketplace",
                    "{source_id}: fetch failed ({e}); serving stale cache ({} entries)",
                    mm.plugins.len()
                );
                return Ok(mm.plugins);
            }
            tracing::warn!(
                target: "fleetify.marketplace",
                "{source_id}: fetch failed ({e}); no cache to fall back to"
            );
            Err(e)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_github_repo_url_happy() {
        assert_eq!(
            validate_github_repo_url("https://github.com/fleetifydev/marketplace").unwrap(),
            ("fleetifydev".into(), "marketplace".into())
        );
        // Trailing slash + .git suffix both stripped.
        assert_eq!(
            validate_github_repo_url("https://github.com/foo/bar.git/").unwrap(),
            ("foo".into(), "bar".into())
        );
    }

    #[test]
    fn validate_rejects_non_https_non_github() {
        assert!(validate_github_repo_url("http://github.com/a/b").is_err());
        assert!(validate_github_repo_url("https://gitlab.com/a/b").is_err());
        assert!(validate_github_repo_url("https://github.com/a").is_err());
        assert!(validate_github_repo_url("https://github.com/a/b/c").is_err());
        assert!(validate_github_repo_url("https://github.com/../b").is_err());
        assert!(validate_github_repo_url("").is_err());
    }

    #[test]
    fn gh_raw_url_resolves() {
        let u = gh_raw_url(
            "https://github.com/fleetifydev/marketplace",
            "marketplace.json",
        )
        .unwrap();
        assert_eq!(
            u,
            "https://raw.githubusercontent.com/fleetifydev/marketplace/HEAD/marketplace.json"
        );
    }
}
