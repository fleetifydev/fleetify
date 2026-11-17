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
//!
//! A catalog load fetches each distinct icon URL once, a few at a time, and
//! waits at most `INLINE_BUDGET` for them. An icon still downloading then
//! keeps its URL (or an expired cached copy) for that load, and the download
//! goes on to fill the cache for the next one.
//!
//! Manifests are third-party input, so the fetch is fenced in. The client
//! dials only addresses `is_public_ip` accepts, vetted inside its own DNS
//! resolver so nothing is checked first and resolved again later. It never
//! uses a proxy and never follows a redirect, and a URL that just failed is
//! left alone for `FAILURE_TTL` instead of stalling every catalog load.
//!
//! One residual risk: a NAT64 network-specific prefix (RFC 6052) cannot be
//! told apart from ordinary global unicast, so on a network that translates
//! one, a name can still reach an internal IPv4 address through it.

use std::collections::HashMap;
use std::future::Future;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant, SystemTime};

use base64::Engine;
use parking_lot::Mutex;
use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use sha2::{Digest, Sha256};

use super::types::PluginManifest;

/// Icons are tiny; anything bigger is not an icon.
const MAX_ICON_BYTES: usize = 256 * 1024;
const FETCH_TIMEOUT: Duration = Duration::from_secs(8);
/// A lookup still unanswered by now is not worth the rest of `FETCH_TIMEOUT`.
const DNS_TIMEOUT: Duration = Duration::from_secs(3);
/// Icons change far less often than the catalog that references them.
const CACHE_TTL: Duration = Duration::from_secs(7 * 24 * 3600);
/// How long a URL whose fetch failed is skipped before it is tried again.
const FAILURE_TTL: Duration = Duration::from_secs(600);
/// Most icon fetches one catalog load runs at once.
const ICON_CONCURRENCY: usize = 8;
/// How long a catalog load waits for its icons. A fetch still running then
/// finishes in the background and fills the cache for the next load.
const INLINE_BUDGET: Duration = Duration::from_secs(3);

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
            let this_network = o[0] == 0; // 0.0.0.0/8, incl. 0.0.0.0
            let cgnat = o[0] == 100 && (o[1] & 0xc0) == 64; // 100.64.0.0/10
            let ietf_protocol = o[..3] == [192, 0, 0]; // 192.0.0.0/24
            let benchmarking = o[0] == 198 && (o[1] & 0xfe) == 18; // 198.18.0.0/15
            let reserved = o[0] >= 240; // 240.0.0.0/4, incl. 255.255.255.255
            !(v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_multicast()
                || v4.is_documentation()
                || this_network
                || cgnat
                || ietf_protocol
                || benchmarking
                || reserved)
        }
        IpAddr::V6(v6) => {
            if v6.is_loopback() || v6.is_unspecified() {
                return false;
            }
            // An address that carries an IPv4 one can end up at that IPv4
            // address, so the IPv4 address decides.
            if let Some(v4) = embedded_ipv4(v6) {
                return is_public_ip(IpAddr::V4(v4));
            }
            // Only global unicast can be a public host. Multicast, fc00::/7,
            // fe80::/10, fec0::/10 and every other special block fall
            // outside 2000::/3. Inside it, 2001::/23 and the documentation
            // ranges 2001:db8::/32 and 3fff::/20 are carved out.
            let s = v6.segments();
            let global_unicast = (s[0] & 0xe000) == 0x2000; // 2000::/3
            let ietf = s[0] == 0x2001 && s[1] < 0x0200; // 2001::/23
            let docs = (s[0] == 0x2001 && s[1] == 0x0db8) || (s[0] == 0x3fff && s[1] < 0x1000);
            global_unicast && !ietf && !docs
        }
    }
}

/// The IPv4 address inside an IPv4-compatible (`::a.b.c.d`), IPv4-mapped
/// (`::ffff:a.b.c.d`), 6to4 (`2002:aabb:ccdd::/48`) or NAT64
/// (`64:ff9b::a.b.c.d`) address.
fn embedded_ipv4(v6: Ipv6Addr) -> Option<Ipv4Addr> {
    let v4 = |hi: u16, lo: u16| Ipv4Addr::from((u32::from(hi) << 16) | u32::from(lo));
    match v6.segments() {
        [0x2002, hi, lo, ..] => Some(v4(hi, lo)),
        [0x64, 0xff9b, 0, 0, 0, 0, hi, lo] => Some(v4(hi, lo)),
        // The IPv4-compatible and the IPv4-mapped forms.
        _ => v6.to_ipv4(),
    }
}

/// `addrs` unchanged when every one is public, otherwise an error. All or
/// nothing: a name that answers with a private address next to public ones
/// is pointing somewhere it should not.
pub(crate) fn public_only(addrs: Vec<SocketAddr>) -> Result<Vec<SocketAddr>, &'static str> {
    if addrs.is_empty() {
        Err("the icon host has no addresses")
    } else if addrs.iter().all(|a| is_public_ip(a.ip())) {
        Ok(addrs)
    } else {
        Err("the icon host resolves to a non-public address")
    }
}

/// The icon client's DNS resolver. The connector dials exactly the addresses
/// returned here, all vetted by [`public_only`], so a name cannot pass a
/// check on one answer and then be dialled on another (DNS rebinding).
pub(crate) struct PublicOnlyResolver;

impl Resolve for PublicOnlyResolver {
    fn resolve(&self, name: Name) -> Resolving {
        let host = name.as_str().to_owned();
        Box::pin(async move {
            let found = tokio::time::timeout(DNS_TIMEOUT, tokio::net::lookup_host((host, 0)))
                .await
                .map_err(|_| "the icon host lookup timed out")??;
            let vetted = public_only(found.collect())?;
            Ok(Box::new(vetted.into_iter()) as Addrs)
        })
    }
}

/// The client for icon fetches. Only [`PublicOnlyResolver`] turns names into
/// addresses. There is no proxy, because a proxy would resolve the name
/// itself and dial whatever it found.
fn icon_client() -> Option<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(FETCH_TIMEOUT)
        .user_agent("Fleet-Marketplace/0.1")
        // A redirect could land anywhere; an icon that needs one stays a URL.
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .dns_resolver(Arc::new(PublicOnlyResolver))
        .build()
        .ok()
}

/// URLs whose last fetch failed, and when. A dead or slow icon host then
/// costs one `FETCH_TIMEOUT` per `ttl` instead of one per catalog load.
pub(crate) struct FailureCache {
    ttl: Duration,
    failed: Mutex<HashMap<String, Instant>>,
}

impl FailureCache {
    fn new(ttl: Duration) -> Self {
        Self {
            ttl,
            failed: Mutex::new(HashMap::new()),
        }
    }

    fn is_recent(&self, url: &str, now: Instant) -> bool {
        self.failed
            .lock()
            .get(url)
            .is_some_and(|&at| now.saturating_duration_since(at) < self.ttl)
    }

    fn record(&self, url: &str, now: Instant) {
        let mut failed = self.failed.lock();
        // Expired entries are dead weight: the map holds one TTL's worth.
        failed.retain(|_, at| now.saturating_duration_since(*at) < self.ttl);
        failed.insert(url.to_owned(), now);
    }
}

static FAILURES: LazyLock<FailureCache> = LazyLock::new(|| FailureCache::new(FAILURE_TTL));

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

/// Numbers this process's cache temp files. With the pid in the name too, no
/// two writes share a temp file, even across processes sharing a cache dir.
static TMP_COUNTER: AtomicU64 = AtomicU64::new(0);

pub fn write_cached(dir: &Path, url: &str, data_uri: &str) {
    if std::fs::create_dir_all(dir).is_err() {
        return;
    }
    let path = cache_path(dir, url);
    // Fill a temp file of this write's own, then rename it into place. With
    // one shared temp name, a writer could rename a file another writer was
    // still filling, and a reader would see it half-written.
    let n = TMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let tmp = path.with_extension(format!("{}.{n}.tmp", std::process::id()));
    if std::fs::write(&tmp, data_uri).is_err() || std::fs::rename(&tmp, &path).is_err() {
        let _ = std::fs::remove_file(&tmp);
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

/// Fetch one icon as a `data:` URI. A URL that failed within `FAILURE_TTL`
/// is not tried again: retrying it would make every catalog load wait out
/// the same failure.
async fn inline_one(client: reqwest::Client, url: reqwest::Url) -> Option<String> {
    if FAILURES.is_recent(url.as_str(), Instant::now()) {
        return None;
    }
    let uri = fetch_data_uri(&client, url.clone()).await;
    if uri.is_none() {
        FAILURES.record(url.as_str(), Instant::now());
    }
    uri
}

/// Rewrite every fetchable `icon` in `manifests` to a `data:` URI, in place.
pub async fn inline_all(manifests: &mut [&mut PluginManifest]) {
    inline_all_in(&cache_dir(), manifests).await;
}

async fn inline_all_in(dir: &Path, manifests: &mut [&mut PluginManifest]) {
    let Some(client) = icon_client() else {
        return;
    };
    inline_all_with(dir, manifests, |url| inline_one(client.clone(), url)).await;
}

/// [`inline_all_in`] with the fetch injected. `fetch` only ever sees a URL
/// that [`fetch_target`] accepted and that has no fresh copy in the cache.
///
/// Each distinct URL is fetched once, at most [`ICON_CONCURRENCY`] at a
/// time, and this returns when every fetch is done or [`INLINE_BUDGET`] has
/// passed. An icon whose fetch failed or is still running gets an expired
/// cached copy if there is one and otherwise stays its URL. The fetches run
/// on a task of their own, so those still running finish anyway and fill
/// the cache for the next load.
async fn inline_all_with<F, Fut>(dir: &Path, manifests: &mut [&mut PluginManifest], fetch: F)
where
    F: Fn(reqwest::Url) -> Fut,
    Fut: Future<Output = Option<String>> + Send + 'static,
{
    let mut shown_by: HashMap<reqwest::Url, Vec<usize>> = HashMap::new();
    for (i, m) in manifests.iter().enumerate() {
        if let Some(url) = m.icon.as_deref().and_then(fetch_target) {
            shown_by.entry(url).or_default().push(i);
        }
    }
    // Catalog order, so the first icons on the page are fetched first.
    let mut wanted: Vec<_> = shown_by.into_iter().collect();
    wanted.sort_unstable_by_key(|(_, at)| at[0]);

    let mut uris: Vec<_> = wanted
        .iter()
        .map(|(url, _)| read_cached(dir, url.as_str(), CACHE_TTL))
        .collect();
    let fetches: Vec<_> = wanted
        .iter()
        .enumerate()
        .filter(|&(k, _)| uris[k].is_none())
        .map(|(k, (url, _))| (k, url.clone(), fetch(url.clone())))
        .collect();
    if !fetches.is_empty() {
        let mut arrived = spawn_fetches(dir.to_path_buf(), fetches);
        let deadline = tokio::time::Instant::now() + INLINE_BUDGET;
        while let Ok(Some((k, uri))) = tokio::time::timeout_at(deadline, arrived.recv()).await {
            uris[k] = uri;
        }
    }
    for ((url, at), uri) in wanted.into_iter().zip(uris) {
        // Offline, down or slow: an expired copy still beats a blank tile.
        let Some(uri) = uri.or_else(|| read_cached(dir, url.as_str(), Duration::MAX)) else {
            continue;
        };
        for i in at {
            manifests[i].icon = Some(uri.clone());
        }
    }
}

/// Run `fetches` on a task of their own, [`ICON_CONCURRENCY`] at a time,
/// caching each icon as it arrives and reporting it, with its slot, on the
/// returned channel.
///
/// The task does not stop when the caller stops listening, so a slow icon
/// still lands in the cache. It ends when the last fetch does, and each real
/// fetch is bounded by `FETCH_TIMEOUT`. A runtime that shuts down drops the
/// task without polling it again, which cancels the fetches; a cache write
/// is synchronous and atomic, so none is left half-done.
fn spawn_fetches<Fut>(
    dir: PathBuf,
    fetches: Vec<(usize, reqwest::Url, Fut)>,
) -> tokio::sync::mpsc::UnboundedReceiver<(usize, Option<String>)>
where
    Fut: Future<Output = Option<String>> + Send + 'static,
{
    use futures_util::StreamExt;

    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    tokio::spawn(async move {
        let mut done = futures_util::stream::iter(fetches)
            .map(|(k, url, fetch)| async move { (k, url, fetch.await) })
            .buffer_unordered(ICON_CONCURRENCY);
        while let Some((k, url, uri)) = done.next().await {
            if let Some(uri) = &uri {
                write_cached(&dir, url.as_str(), uri);
            }
            // Fails only once the caller's budget has run out.
            let _ = tx.send((k, uri));
        }
    });
    rx
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
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
    fn is_public_ip_rejects_reserved_and_embedded_private_ranges() {
        for ip in [
            "0.1.2.3",
            "100.64.0.1",
            "192.0.0.8",
            "198.18.0.1",
            "198.19.255.255",
            "240.0.0.1",
            "255.255.255.255",
            "::127.0.0.1",
            "2002:7f00:1::1",
            "64:ff9b::a00:1",
            "fec0::1",
        ] {
            assert!(!is_public_ip(ip.parse().unwrap()), "{ip} must be rejected");
        }
        for ip in ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"] {
            assert!(is_public_ip(ip.parse().unwrap()), "{ip} must be allowed");
        }
    }

    #[test]
    fn is_public_ip_judges_an_embedded_ipv4_by_that_address() {
        // Each form once around public 8.8.10.0 and once around private
        // 10.0.0.1. The halves differ in class, so reading the wrong
        // segments flips the verdict.
        for (allowed, rejected) in [
            ("::8.8.10.0", "::10.0.0.1"),
            ("::ffff:8.8.10.0", "::ffff:10.0.0.1"),
            ("2002:808:a00::1", "2002:a00:1::1"),
            ("64:ff9b::808:a00", "64:ff9b::a00:1"),
        ] {
            assert!(
                is_public_ip(allowed.parse().unwrap()),
                "{allowed} must be allowed"
            );
            assert!(
                !is_public_ip(rejected.parse().unwrap()),
                "{rejected} must be rejected"
            );
        }
    }

    #[test]
    fn is_public_ip_treats_only_global_unicast_ipv6_as_public() {
        // Special-purpose IPv6 beyond the embedded-IPv4 forms: local-use and
        // out-of-/96 NAT64, SIIT, discard-only, 2001::/23 (Teredo,
        // benchmarking), documentation and SRv6.
        let rejected = [
            "64:ff9b:1::a00:1",
            "64:ff9b::1:a00:1",
            "::ffff:0:a00:1",
            "100::1",
            "100:0:0:1::1",
            "2001::1",
            "2001:2::1",
            "2001:db8::1",
            "3fff::1",
            "5f00::1",
        ];
        let judged_public: Vec<&str> = rejected
            .into_iter()
            .filter(|ip| is_public_ip(ip.parse().unwrap()))
            .collect();
        assert!(
            judged_public.is_empty(),
            "must be rejected: {judged_public:?}"
        );
        // 2001:4860:: sits just past 2001::/23: carving out the special
        // ranges must not swallow their public neighbours.
        for ip in ["2a00:1450::1", "2001:4860:4860::8888"] {
            assert!(is_public_ip(ip.parse().unwrap()), "{ip} must be allowed");
        }
    }

    #[test]
    fn public_only_is_all_or_nothing() {
        let p: SocketAddr = "8.8.8.8:0".parse().unwrap();
        let l: SocketAddr = "127.0.0.1:0".parse().unwrap();
        assert!(public_only(vec![]).is_err());
        assert!(public_only(vec![p, l]).is_err());
        assert_eq!(public_only(vec![p]).unwrap(), vec![p]);
    }

    #[tokio::test]
    async fn resolver_refuses_a_name_that_resolves_to_loopback() {
        let name: reqwest::dns::Name = "localhost".parse().unwrap();
        assert!(PublicOnlyResolver.resolve(name).await.is_err());
    }

    /// A local TCP listener that counts every connection and hangs up at
    /// once, so a fetch through it fails fast and each dial is observable.
    async fn hang_up_listener() -> (SocketAddr, Arc<AtomicUsize>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let dials = Arc::new(AtomicUsize::new(0));
        let seen = Arc::clone(&dials);
        tokio::spawn(async move {
            while let Ok((conn, _)) = listener.accept().await {
                seen.fetch_add(1, Ordering::SeqCst);
                drop(conn);
            }
        });
        (addr, dials)
    }

    /// The resolver is what the icon client's connector dials through, so a
    /// name that resolves to loopback never gets a connection at all.
    #[tokio::test]
    async fn icon_client_never_dials_a_name_that_resolves_to_loopback() {
        let (addr, dials) = hang_up_listener().await;
        let client = icon_client().unwrap();
        let sent = client
            .get(format!("https://localhost:{}/icon.svg", addr.port()))
            .send()
            .await;
        assert!(sent.is_err());
        assert_eq!(
            dials.load(Ordering::SeqCst),
            0,
            "a loopback address was dialled"
        );
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

    /// Writers racing on one URL must each put a whole file in place, so a
    /// reader sees one complete value or another, never a prefix or a mix.
    #[test]
    fn write_cached_concurrent_writers_never_expose_partial_files() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        let url = "https://api.iconify.design/logos:aws.svg";
        // A length and a filler of its own per writer, so a torn or
        // interleaved file cannot pass for any whole value.
        let values: Vec<String> = (0..16u8)
            .map(|i| {
                let fill = char::from(b'A' + i).to_string();
                let body = fill.repeat((usize::from(i) + 1) * 4096);
                format!("data:image/png;base64,{body}")
            })
            .collect();
        let writers_done = AtomicBool::new(false);
        let torn = std::thread::scope(|s| {
            let reader = s.spawn(|| loop {
                let finished = writers_done.load(Ordering::SeqCst);
                if let Some(got) = read_cached(dir, url, CACHE_TTL) {
                    if !values.contains(&got) {
                        return Some(got.len());
                    }
                }
                if finished {
                    return None;
                }
            });
            let writers: Vec<_> = values
                .iter()
                .map(|v| s.spawn(move || (0..50).for_each(|_| write_cached(dir, url, v))))
                .collect();
            for w in writers {
                w.join().unwrap();
            }
            writers_done.store(true, Ordering::SeqCst);
            reader.join().unwrap()
        });
        assert_eq!(torn, None, "a reader saw a torn file of that many bytes");
        assert!(values.contains(&read_cached(dir, url, CACHE_TTL).unwrap()));
        let left: Vec<_> = std::fs::read_dir(dir).unwrap().flatten().collect();
        assert_eq!(left.len(), 1, "temp files left behind: {left:?}");
    }

    /// Temp names are unique, so one a failed write leaves behind would never
    /// be reused: every failure would add a file.
    #[test]
    fn write_cached_removes_its_temp_file_when_the_rename_fails() {
        let tmp = tempfile::tempdir().unwrap();
        let url = "https://api.iconify.design/logos:aws.svg";
        // A directory where the cache file belongs, so the rename fails.
        std::fs::create_dir(cache_path(tmp.path(), url)).unwrap();
        write_cached(tmp.path(), url, "data:image/png;base64,AAAA");
        let left: Vec<_> = std::fs::read_dir(tmp.path()).unwrap().flatten().collect();
        assert_eq!(left.len(), 1, "temp files left behind: {left:?}");
    }

    #[test]
    fn failure_cache_suppresses_retries_within_ttl() {
        let c = FailureCache::new(Duration::from_secs(600));
        let t0 = Instant::now();
        c.record("https://x.test/i.png", t0);
        assert!(c.is_recent("https://x.test/i.png", t0 + Duration::from_secs(599)));
        assert!(!c.is_recent("https://x.test/i.png", t0 + Duration::from_secs(601)));
        assert!(!c.is_recent("https://y.test/i.png", t0));
    }

    /// One dead icon host must not cost every catalog load a fresh timeout.
    #[tokio::test]
    async fn inline_one_skips_the_network_for_a_recently_failed_url() {
        let (addr, dials) = hang_up_listener().await;
        let host = "failing-icons.example";
        // No proxy: an HTTPS_PROXY in the environment would bypass `resolve`.
        let client = reqwest::Client::builder()
            .no_proxy()
            .resolve(host, addr)
            .build()
            .unwrap();
        let icon = format!("https://{host}/logo.svg");
        let url = fetch_target(&icon).unwrap();
        let dir = tempfile::tempdir().unwrap();

        assert!(inline_one(client.clone(), url).await.is_none());
        assert_eq!(dials.load(Ordering::SeqCst), 1);
        assert!(FAILURES.is_recent(&icon, Instant::now()));

        // Within FAILURE_TTL the host is not dialled again, yet an expired
        // copy is still served rather than a blank tile.
        write_cached(dir.path(), &icon, "data:image/png;base64,AAAA");
        std::fs::File::options()
            .write(true)
            .open(cache_path(dir.path(), &icon))
            .unwrap()
            .set_modified(SystemTime::now() - CACHE_TTL - Duration::from_secs(60))
            .unwrap();
        let mut m = manifest("failing", &icon);
        inline_all_with(dir.path(), &mut [&mut m], |url| {
            inline_one(client.clone(), url)
        })
        .await;
        assert_eq!(m.icon.as_deref(), Some("data:image/png;base64,AAAA"));
        assert_eq!(dials.load(Ordering::SeqCst), 1);
    }

    fn manifest(name: &str, icon: &str) -> PluginManifest {
        serde_json::from_value(serde_json::json!({
            "name": name, "version": "1.0.0", "providers": ["claude"], "declares": {},
            "icon": icon,
        }))
        .unwrap()
    }

    #[tokio::test]
    async fn inline_all_fetches_each_url_once() {
        let dir = tempfile::tempdir().unwrap();
        let icon = "https://icons.example.com/shared.svg";
        let uri = to_data_uri("image/svg+xml", SVG).unwrap();
        let mut ms: Vec<_> = (0..3).map(|i| manifest(&format!("p{i}"), icon)).collect();
        let calls = AtomicUsize::new(0);
        let mut refs: Vec<_> = ms.iter_mut().collect();
        inline_all_with(dir.path(), &mut refs, |_| {
            calls.fetch_add(1, Ordering::SeqCst);
            let uri = uri.clone();
            async move { Some(uri) }
        })
        .await;
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        for m in &ms {
            assert_eq!(m.icon.as_deref(), Some(uri.as_str()));
        }
    }

    #[tokio::test]
    async fn inline_all_uses_a_fresh_cached_copy_without_fetching() {
        let dir = tempfile::tempdir().unwrap();
        let icon = "https://icons.example.com/cached.svg";
        write_cached(dir.path(), icon, "data:image/png;base64,AAAA");
        let mut m = manifest("cached", icon);
        let calls = AtomicUsize::new(0);
        inline_all_with(dir.path(), &mut [&mut m], |_| {
            calls.fetch_add(1, Ordering::SeqCst);
            async { None }
        })
        .await;
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert_eq!(m.icon.as_deref(), Some("data:image/png;base64,AAAA"));
    }

    /// The SSRF policy lives in `fetch_target`, ahead of any fetcher: an IP
    /// literal never reaches the resolver that would otherwise vet it.
    #[tokio::test]
    async fn inline_all_only_fetches_what_fetch_target_accepts() {
        let dir = tempfile::tempdir().unwrap();
        let inline = "data:image/png;base64,AAAA";
        let icons = [
            "https://icons.example.com/ok.svg",
            "http://icons.example.com/plain.svg",
            "https://10.0.0.1/i.png",
            "https://localhost/i.png",
            inline,
        ];
        let mut ms: Vec<_> = icons.iter().map(|icon| manifest("p", icon)).collect();
        let asked = Mutex::new(Vec::new());
        let mut refs: Vec<_> = ms.iter_mut().collect();
        inline_all_with(dir.path(), &mut refs, |url| {
            asked.lock().push(url.to_string());
            async { None }
        })
        .await;
        assert_eq!(*asked.lock(), ["https://icons.example.com/ok.svg"]);
        assert_eq!(ms[4].icon.as_deref(), Some(inline));
    }

    /// Tokio's clock is paused, so the fetcher sleeps and the budget runs
    /// out in virtual time: no real waiting, and nothing to race.
    #[tokio::test(start_paused = true)]
    async fn inline_all_returns_within_budget() {
        let dir = tempfile::tempdir().unwrap();
        let icon = "https://slow-icons.example/logo.svg";
        let mut m = manifest("slow", icon);
        let started = tokio::time::Instant::now();
        inline_all_with(dir.path(), &mut [&mut m], |_| async {
            tokio::time::sleep(Duration::from_secs(10)).await;
            to_data_uri("image/svg+xml", SVG)
        })
        .await;
        let waited = started.elapsed();
        assert!(waited < Duration::from_secs(4), "waited {waited:?}");
        assert!(waited >= INLINE_BUDGET, "gave up after only {waited:?}");
        assert_eq!(m.icon.as_deref(), Some(icon));
    }

    #[tokio::test(start_paused = true)]
    async fn inline_all_keeps_filling_the_cache_after_the_budget() {
        let dir = tempfile::tempdir().unwrap();
        let icon = "https://slow-icons.example/late.svg";
        let uri = to_data_uri("image/svg+xml", SVG).unwrap();
        let mut m = manifest("late", icon);
        inline_all_with(dir.path(), &mut [&mut m], |_| {
            let uri = uri.clone();
            async move {
                tokio::time::sleep(Duration::from_secs(10)).await;
                Some(uri)
            }
        })
        .await;
        assert_eq!(m.icon.as_deref(), Some(icon));
        assert_eq!(read_cached(dir.path(), icon, CACHE_TTL), None);

        // The fetch outlives the load that gave up on it, so the next load
        // finds the icon in the cache.
        tokio::time::sleep(Duration::from_secs(10)).await;
        assert_eq!(read_cached(dir.path(), icon, CACHE_TTL), Some(uri));
    }

    #[tokio::test(start_paused = true)]
    async fn inline_all_runs_at_most_icon_concurrency_fetches_at_once() {
        let dir = tempfile::tempdir().unwrap();
        let mut ms: Vec<_> = (0..ICON_CONCURRENCY + 2)
            .map(|i| format!("https://icons.example.com/{i}.svg"))
            .map(|icon| manifest("p", &icon))
            .collect();
        let in_flight = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let mut refs: Vec<_> = ms.iter_mut().collect();
        inline_all_with(dir.path(), &mut refs, |_| {
            let (in_flight, peak) = (Arc::clone(&in_flight), Arc::clone(&peak));
            async move {
                let now = in_flight.fetch_add(1, Ordering::SeqCst) + 1;
                peak.fetch_max(now, Ordering::SeqCst);
                tokio::time::sleep(Duration::from_secs(1)).await;
                in_flight.fetch_sub(1, Ordering::SeqCst);
                to_data_uri("image/svg+xml", SVG)
            }
        })
        .await;
        // In parallel but never past the cap. Two one-second rounds fit the
        // budget, so every icon arrives.
        assert_eq!(peak.load(Ordering::SeqCst), ICON_CONCURRENCY);
        for m in &ms {
            let icon = m.icon.as_deref().unwrap();
            assert!(icon.starts_with("data:image/svg+xml;"), "kept {icon}");
        }
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
