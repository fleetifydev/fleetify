//! Plugin icons, inlined as `data:` URIs.
//!
//! Manifests point `icon` at a remote image, almost always the Iconify API.
//! The renderer used to hand that URL straight to an `<img>`, which means the
//! WebView fetched it. Iconify's CDN answers WebKitGTK (the Linux WebView) with
//! a Cloudflare 403 block page: a browser-looking User-Agent on a non-browser
//! TLS stack trips its bot rule. Every card then rendered an empty tile.
//!
//! The backend's own HTTP client is not blocked, so it fetches the image and
//! rewrites `icon` to a `data:` URI (already allowed by the CSP's `img-src`).
//! The WebView makes no third-party request at all, and icons survive offline.
//!
//! Everything here is best-effort: any failure leaves `icon` untouched.

use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use base64::Engine;
use sha2::{Digest, Sha256};

use super::types::PluginManifest;

/// Icons are tiny; anything bigger is not an icon.
const MAX_ICON_BYTES: usize = 256 * 1024;
const FETCH_TIMEOUT: Duration = Duration::from_secs(8);
/// Icons change far less often than the catalog that references them.
const CACHE_TTL: Duration = Duration::from_secs(7 * 24 * 3600);

const ALLOWED_MIME: &[&str] = &[
    "image/svg+xml",
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/gif",
];

fn cache_dir() -> PathBuf {
    fleetify_core::fleetify_home()
        .join("marketplace-cache")
        .join("icons")
}

/// The URL to fetch for a manifest `icon`, or `None` when it must be left
/// alone: already inline, not https, or pointed somewhere a third-party
/// manifest has no business sending the backend (credentials, IP literals,
/// local names).
pub fn fetch_target(icon: &str) -> Option<reqwest::Url> {
    let url = reqwest::Url::parse(icon.trim()).ok()?;
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    let host = url.host_str()?.to_ascii_lowercase();
    // IP literals are refused outright; names are vetted again after DNS.
    if host
        .trim_matches(|c| c == '[' || c == ']')
        .parse::<IpAddr>()
        .is_ok()
    {
        return None;
    }
    const LOCAL_SUFFIXES: &[&str] = &[".localhost", ".local", ".internal", ".lan", ".home.arpa"];
    if host == "localhost"
        || !host.contains('.')
        || LOCAL_SUFFIXES.iter().any(|s| host.ends_with(s))
    {
        return None;
    }
    Some(url)
}

/// False for every address a public icon host could not legitimately resolve
/// to. Manifests are third-party input, so the backend must not be steerable
/// at the user's own machine or network.
pub fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            let cgnat = o[0] == 100 && (o[1] & 0xc0) == 64; // 100.64.0.0/10
            !(v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_broadcast()
                || v4.is_multicast()
                || v4.is_documentation()
                || cgnat)
        }
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_public_ip(IpAddr::V4(v4));
            }
            let head = v6.segments()[0];
            let unique_local = (head & 0xfe00) == 0xfc00; // fc00::/7
            let link_local = (head & 0xffc0) == 0xfe80; // fe80::/10
            !(v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                || unique_local
                || link_local)
        }
    }
}

/// Encode a fetched body as a `data:` URI, or `None` when it is not an
/// acceptable image. The content type is what rejects a 200-with-HTML block
/// page as firmly as it rejects a 403.
pub fn to_data_uri(content_type: &str, body: &[u8]) -> Option<String> {
    let mime = content_type.split(';').next()?.trim().to_ascii_lowercase();
    if !ALLOWED_MIME.contains(&mime.as_str()) || body.is_empty() || body.len() > MAX_ICON_BYTES {
        return None;
    }
    let b64 = base64::engine::general_purpose::STANDARD.encode(body);
    Some(format!("data:{mime};base64,{b64}"))
}

fn cache_path(dir: &Path, url: &str) -> PathBuf {
    let digest = Sha256::digest(url.as_bytes());
    dir.join(format!("{digest:x}.txt"))
}

pub fn read_cached(dir: &Path, url: &str, ttl: Duration) -> Option<String> {
    let path = cache_path(dir, url);
    let modified = std::fs::metadata(&path).ok()?.modified().ok()?;
    let age = SystemTime::now()
        .duration_since(modified)
        .unwrap_or_default();
    if age >= ttl {
        return None;
    }
    let uri = std::fs::read_to_string(&path).ok()?;
    uri.starts_with("data:image/").then_some(uri)
}

pub fn write_cached(dir: &Path, url: &str, data_uri: &str) {
    if std::fs::create_dir_all(dir).is_err() {
        return;
    }
    let path = cache_path(dir, url);
    let tmp = path.with_extension("tmp");
    if std::fs::write(&tmp, data_uri).is_ok() {
        let _ = std::fs::rename(&tmp, &path);
    }
}

/// Fetch one icon and encode it. Split from [`fetch_target`] so the transport
/// rules can be exercised against a local server.
pub async fn fetch_data_uri(client: &reqwest::Client, url: reqwest::Url) -> Option<String> {
    let mut resp = client.get(url).send().await.ok()?;
    if !resp.status().is_success()
        || resp
            .content_length()
            .is_some_and(|n| n > MAX_ICON_BYTES as u64)
    {
        return None;
    }
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)?
        .to_str()
        .ok()?
        .to_string();
    // Read with a running cap: Content-Length is optional and can lie.
    let mut body = Vec::new();
    while let Some(chunk) = resp.chunk().await.ok()? {
        body.extend_from_slice(&chunk);
        if body.len() > MAX_ICON_BYTES {
            return None;
        }
    }
    to_data_uri(&content_type, &body)
}

/// Every address the host resolves to must be public. Closes the gap
/// [`fetch_target`] cannot: a harmless-looking name pointing at 127.0.0.1.
async fn resolves_publicly(url: &reqwest::Url) -> bool {
    let Some(host) = url.host_str() else {
        return false;
    };
    let Ok(addrs) = tokio::net::lookup_host((host, 443)).await else {
        return false;
    };
    let addrs: Vec<_> = addrs.collect();
    !addrs.is_empty() && addrs.iter().all(|a| is_public_ip(a.ip()))
}

async fn inline_one(client: &reqwest::Client, dir: &Path, icon: &str) -> Option<String> {
    let url = fetch_target(icon)?;
    if let Some(hit) = read_cached(dir, url.as_str(), CACHE_TTL) {
        return Some(hit);
    }
    let fetched = if resolves_publicly(&url).await {
        fetch_data_uri(client, url.clone()).await
    } else {
        None
    };
    match fetched {
        Some(uri) => {
            write_cached(dir, url.as_str(), &uri);
            Some(uri)
        }
        // Offline or the host is down: an expired copy still beats a blank tile.
        None => read_cached(dir, url.as_str(), Duration::MAX),
    }
}

/// Rewrite every fetchable `icon` in `manifests` to a `data:` URI, in place.
pub async fn inline_all(manifests: &mut [&mut PluginManifest]) {
    inline_all_in(&cache_dir(), manifests).await;
}

async fn inline_all_in(dir: &Path, manifests: &mut [&mut PluginManifest]) {
    let Ok(client) = reqwest::Client::builder()
        .timeout(FETCH_TIMEOUT)
        .user_agent("Fleet-Marketplace/0.1")
        // A redirect could land anywhere; an icon that needs one stays a URL.
        .redirect(reqwest::redirect::Policy::none())
        .build()
    else {
        return;
    };
    let jobs = manifests.iter().enumerate().filter_map(|(i, m)| {
        let icon = m.icon.clone()?;
        let client = &client;
        Some(async move { (i, inline_one(client, dir, &icon).await) })
    });
    for (i, uri) in futures_util::future::join_all(jobs).await {
        if let (Some(uri), Some(m)) = (uri, manifests.get_mut(i)) {
            m.icon = Some(uri);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    const SVG: &[u8] = br#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>"#;

    #[test]
    fn fetch_target_accepts_a_public_https_icon() {
        let u = fetch_target("https://api.iconify.design/logos:asana-icon.svg").unwrap();
        assert_eq!(u.host_str(), Some("api.iconify.design"));
    }

    #[test]
    fn fetch_target_leaves_inline_and_non_https_icons_alone() {
        assert!(fetch_target("data:image/svg+xml;base64,AAAA").is_none());
        assert!(fetch_target("http://api.iconify.design/logos:aws.svg").is_none());
        assert!(fetch_target("icons/logo.svg").is_none());
        assert!(fetch_target("").is_none());
    }

    #[test]
    fn fetch_target_refuses_hosts_a_manifest_should_not_reach() {
        for bad in [
            "https://127.0.0.1/icon.svg",
            "https://10.0.0.5/icon.svg",
            "https://[::1]/icon.svg",
            "https://localhost/icon.svg",
            "https://LOCALHOST:8765/icon.svg",
            "https://printer.local/icon.svg",
            "https://db.internal/icon.svg",
            "https://user:pw@api.iconify.design/x.svg",
        ] {
            assert!(fetch_target(bad).is_none(), "{bad} should be refused");
        }
    }

    #[test]
    fn is_public_ip_rejects_local_and_private_ranges() {
        for bad in [
            "127.0.0.1",
            "10.1.2.3",
            "172.16.0.1",
            "192.168.1.1",
            "169.254.169.254",
            "100.64.0.1",
            "0.0.0.0",
            "::1",
            "::",
            "fc00::1",
            "fe80::1",
            "::ffff:127.0.0.1",
        ] {
            assert!(
                !is_public_ip(bad.parse().unwrap()),
                "{bad} should not be public"
            );
        }
        for ok in ["1.1.1.1", "104.26.12.30", "2606:4700::1111"] {
            assert!(is_public_ip(ok.parse().unwrap()), "{ok} should be public");
        }
    }

    #[test]
    fn to_data_uri_encodes_an_svg() {
        let uri = to_data_uri("image/svg+xml; charset=utf-8", SVG).unwrap();
        let b64 = uri.strip_prefix("data:image/svg+xml;base64,").unwrap();
        let back = base64::engine::general_purpose::STANDARD
            .decode(b64)
            .unwrap();
        assert_eq!(back, SVG);
    }

    #[test]
    fn to_data_uri_rejects_the_cloudflare_block_page_and_other_non_images() {
        // What the WebView actually received: `403 text/html`. A proxy that
        // returns the same page with a 200 must be rejected just as firmly.
        assert!(to_data_uri("text/html; charset=UTF-8", b"<html>blocked</html>").is_none());
        assert!(to_data_uri("application/json", b"{}").is_none());
        assert!(to_data_uri("", SVG).is_none());
    }

    #[test]
    fn to_data_uri_rejects_empty_and_oversized_bodies() {
        assert!(to_data_uri("image/png", b"").is_none());
        assert!(to_data_uri("image/png", &vec![0u8; MAX_ICON_BYTES + 1]).is_none());
        assert!(to_data_uri("image/png", &vec![0u8; MAX_ICON_BYTES]).is_some());
    }

    #[test]
    fn cache_round_trips_and_expires() {
        let dir = tempfile::tempdir().unwrap();
        let url = "https://api.iconify.design/logos:aws.svg";
        assert!(read_cached(dir.path(), url, CACHE_TTL).is_none());
        write_cached(dir.path(), url, "data:image/png;base64,AAAA");
        assert_eq!(
            read_cached(dir.path(), url, CACHE_TTL).as_deref(),
            Some("data:image/png;base64,AAAA")
        );
        // Another URL never sees this entry.
        assert!(read_cached(
            dir.path(),
            "https://api.iconify.design/logos:gcp.svg",
            CACHE_TTL
        )
        .is_none());
        // A zero TTL means everything is already stale.
        assert!(read_cached(dir.path(), url, Duration::ZERO).is_none());
    }

    /// Live network. Proves the premise of this module end to end: the
    /// backend's client is NOT blocked by the CDN that blocks the WebView.
    /// Run with `cargo test -p fleetify-backend --lib icons -- --ignored`.
    #[tokio::test]
    #[ignore = "hits api.iconify.design"]
    async fn live_iconify_icon_is_inlined() {
        let cache = tempfile::tempdir().unwrap();
        let mut m: PluginManifest = serde_json::from_value(serde_json::json!({
            "name": "asana", "version": "1.0.0", "providers": ["claude"], "declares": {},
            "icon": "https://api.iconify.design/logos:asana-icon.svg",
        }))
        .unwrap();
        inline_all_in(cache.path(), &mut [&mut m]).await;
        let icon = m.icon.unwrap();
        assert!(
            icon.starts_with("data:image/svg+xml;base64,"),
            "got {icon:.80}"
        );
        if let Ok(out) = std::env::var("ICON_PROBE_OUT") {
            std::fs::write(out, icon).unwrap();
        }
    }

    #[tokio::test]
    async fn fetch_data_uri_inlines_an_image_response() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/logo.svg"))
            .respond_with(ResponseTemplate::new(200).set_body_raw(SVG, "image/svg+xml"))
            .mount(&server)
            .await;
        let url = reqwest::Url::parse(&format!("{}/logo.svg", server.uri())).unwrap();
        let uri = fetch_data_uri(&reqwest::Client::new(), url).await.unwrap();
        assert!(uri.starts_with("data:image/svg+xml;base64,"));
    }

    #[tokio::test]
    async fn fetch_data_uri_gives_up_on_a_block_page() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/blocked.svg"))
            .respond_with(
                ResponseTemplate::new(403).set_body_raw("<html>blocked</html>", "text/html"),
            )
            .mount(&server)
            .await;
        let url = reqwest::Url::parse(&format!("{}/blocked.svg", server.uri())).unwrap();
        assert!(fetch_data_uri(&reqwest::Client::new(), url).await.is_none());
    }
}
