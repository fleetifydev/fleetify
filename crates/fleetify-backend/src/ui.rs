//! The release UI: the built renderer files the shell embeds in the binary,
//! served by the backend on its own origin under a Content-Security-Policy
//! it computes itself.
//!
//! The shell hands [`crate::serve`] a [`UiAssets`] (`ServeOptions::ui`)
//! that answers exactly the embedded files (`shell::ui_files`). `http::app`
//! makes it the router's fallback:
//!
//! - `GET` or `HEAD` of `/` is index.html, and of any other embedded file's
//!   path that file. Anything else is an empty 404: no index.html in place
//!   of a missing file, under `/api/` or anywhere else. Other methods get
//!   405.
//! - Every answer carries the policy ([`content_security_policy`]),
//!   `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`.
//!   The hashed files under `/assets/` may be cached for a year; everything
//!   else, index.html first, is revalidated.
//!
//! Browsers send what the policy blocks to [`CSP_REPORT_PATH`], which needs
//! no API token (`access::decide`), and each report becomes one warning on
//! the `fleetify.csp` target.
//!
//! Tauri's own policy (`app.security.csp`) is off: it applies only to the
//! `tauri://` protocol, which the app doesn't load, and it would rewrite
//! index.html with per-request nonces and hashes the page doesn't need, as
//! it has no inline scripts.

use std::sync::Arc;

use axum::body::Bytes;
use axum::http::{header, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};

use crate::services::telemetry::posthog::DEFAULT_HOST;

/// One embedded UI file.
pub struct UiAsset {
    pub bytes: Vec<u8>,
    pub mime_type: String,
}

/// The shell's lookup of an embedded file by request path.
type Lookup = dyn Fn(&str) -> Option<UiAsset> + Send + Sync;

/// The embedded UI files, behind the shell's lookup.
#[derive(Clone)]
pub struct UiAssets(Arc<Lookup>);

impl UiAssets {
    /// `get` answers a request path (see [`UiAssets::get`]).
    pub fn new(get: impl Fn(&str) -> Option<UiAsset> + Send + Sync + 'static) -> Self {
        Self(Arc::new(get))
    }

    /// The file a request path names: `/` means index.html. `None` when the
    /// path is not an embedded file.
    pub fn get(&self, request_path: &str) -> Option<UiAsset> {
        (self.0)(request_path)
    }
}

/// Where browsers send CSP violation reports (the policy's `report-uri`).
pub const CSP_REPORT_PATH: &str = "/api/csp-report";

/// The largest report body accepted; a larger one gets 413.
pub(crate) const CSP_REPORT_MAX_BYTES: usize = 16 * 1024;

/// How long the hashed files under `/assets/` may be cached: a year, and
/// they never change under their name.
const IMMUTABLE: &str = "public, max-age=31536000, immutable";
/// Everything else, index.html first, is revalidated.
const NO_CACHE: &str = "no-cache";

/// The origin product analytics sends to, for the policy's `connect-src`:
/// `scheme://host[:port]` of `raw`, the PostHog host the renderer was built
/// with. A missing, empty or unusable value (not an http or https URL) is
/// [`DEFAULT_HOST`], as it is for the renderer (`src/lib/posthog.ts`).
pub fn posthog_origin(raw: Option<&str>) -> String {
    raw.and_then(|raw| url::Url::parse(raw).ok())
        .filter(|url| matches!(url.scheme(), "http" | "https"))
        .map(|url| url.origin().ascii_serialization())
        .unwrap_or_else(|| DEFAULT_HOST.to_string())
}

/// The Content-Security-Policy the UI files are served with, for the
/// backend bound to `port` and analytics sent to `posthog_origin`.
pub fn content_security_policy(port: u16, posthog_origin: &str) -> String {
    [
        "default-src 'self'".to_string(),
        // 'wasm-unsafe-eval': shiki compiles its Oniguruma WebAssembly. It
        // allows WebAssembly only, not eval.
        "script-src 'self' 'wasm-unsafe-eval'".to_string(),
        // 'unsafe-inline': React's style attributes, and the <style>
        // elements sonner, xterm and KaTeX add.
        "style-src 'self' 'unsafe-inline'".to_string(),
        "img-src 'self' data: https:".to_string(),
        "font-src 'self' data:".to_string(),
        // ipc: and http://ipc.localhost: Tauri's IPC. One blocked IPC fetch
        // moves the page to postMessage for the rest of its life. The
        // sockets go to the backend's own port.
        format!(
            "connect-src 'self' ipc: http://ipc.localhost ws://127.0.0.1:{port} {posthog_origin}"
        ),
        "media-src 'self' https:".to_string(),
        // The Preview pane frames local dev servers.
        "frame-src http://localhost:* http://127.0.0.1:* https://localhost:* https://127.0.0.1:*"
            .to_string(),
        "worker-src 'none'".to_string(),
        "object-src 'none'".to_string(),
        "base-uri 'none'".to_string(),
        "form-action 'none'".to_string(),
        "frame-ancestors 'none'".to_string(),
        format!("report-uri {CSP_REPORT_PATH}"),
    ]
    .join("; ")
}

/// The router's fallback when it serves the UI: the files, and the policy
/// header they go out with.
#[derive(Clone)]
pub(crate) struct UiFiles {
    assets: UiAssets,
    csp: HeaderValue,
}

impl UiFiles {
    /// The files in `assets`, under the policy for `port`, the port the
    /// backend bound.
    pub(crate) fn new(assets: UiAssets, port: u16) -> Self {
        // Read when the backend is compiled, because Vite bakes the same
        // variable into the renderer when it builds it: the release workflow
        // must set both builds' VITE_POSTHOG_HOST from the same repository
        // variable, or analytics is sent to an origin the policy blocks.
        let posthog = posthog_origin(option_env!("VITE_POSTHOG_HOST"));
        let csp = content_security_policy(port, &posthog);
        Self {
            assets,
            // A port and an ASCII origin (`Url::origin`) in a fixed string.
            csp: HeaderValue::try_from(csp).expect("the policy is a valid header value"),
        }
    }

    /// The answer to `method` on `path`, the request's path.
    pub(crate) fn respond(&self, method: &Method, path: &str) -> Response {
        let mut response = if method != Method::GET && method != Method::HEAD {
            (
                StatusCode::METHOD_NOT_ALLOWED,
                [(header::ALLOW, HeaderValue::from_static("GET, HEAD"))],
            )
                .into_response()
        } else {
            match self.assets.get(path) {
                Some(asset) => {
                    let content_type = HeaderValue::try_from(asset.mime_type)
                        .unwrap_or(HeaderValue::from_static("application/octet-stream"));
                    let cache = if path.starts_with("/assets/") {
                        IMMUTABLE
                    } else {
                        NO_CACHE
                    };
                    (
                        [
                            (header::CONTENT_TYPE, content_type),
                            (header::CACHE_CONTROL, HeaderValue::from_static(cache)),
                        ],
                        asset.bytes,
                    )
                        .into_response()
                }
                // Empty: no index.html in place of a missing file.
                None => StatusCode::NOT_FOUND.into_response(),
            }
        };
        let headers = response.headers_mut();
        headers.insert(header::CONTENT_SECURITY_POLICY, self.csp.clone());
        headers.insert(
            header::X_CONTENT_TYPE_OPTIONS,
            HeaderValue::from_static("nosniff"),
        );
        headers.insert(
            header::REFERRER_POLICY,
            HeaderValue::from_static("no-referrer"),
        );
        headers
            .entry(header::CACHE_CONTROL)
            .or_insert(HeaderValue::from_static(NO_CACHE));
        response
    }
}

/// `POST` [`CSP_REPORT_PATH`]: a browser's report of something the policy
/// blocked. It is logged and answered 204 whatever the body holds; the route
/// refuses a body over [`CSP_REPORT_MAX_BYTES`] with 413 before this runs.
pub(crate) async fn csp_report(body: Bytes) -> StatusCode {
    let (directive, blocked) = violation(&body);
    tracing::warn!(
        target: "fleetify.csp",
        directive = directive.as_str(),
        blocked = blocked.as_str(),
        "content security policy violation"
    );
    StatusCode::NO_CONTENT
}

/// The directive a report (`{"csp-report": {…}}`, what `report-uri` sends)
/// says was violated, and what was blocked, reduced by [`blocked_source`].
/// What the body doesn't say is `"unknown"`.
fn violation(body: &[u8]) -> (String, String) {
    let report: Option<serde_json::Value> = serde_json::from_slice(body).ok();
    let report = report.as_ref().and_then(|report| report.get("csp-report"));
    let field = |name: &str| report.and_then(|report| report.get(name)?.as_str());
    let directive = field("effective-directive")
        .or_else(|| field("violated-directive"))
        .and_then(directive_name)
        .unwrap_or("unknown");
    let blocked = field("blocked-uri").map_or_else(|| "unknown".to_string(), blocked_source);
    (directive.to_string(), blocked)
}

/// A directive's name, the first word of `raw`, when it looks like one:
/// lowercase letters and dashes.
fn directive_name(raw: &str) -> Option<&str> {
    let name = raw.split_whitespace().next()?;
    let looks_like_one =
        name.len() <= 40 && name.bytes().all(|b| b.is_ascii_lowercase() || b == b'-');
    looks_like_one.then_some(name)
}

/// A report's `blocked-uri` without its path or query: `scheme://host[:port]`
/// for a URL, the scheme alone for one without a host (`data`, `blob`), and
/// a keyword (`inline`, `eval`, …) as it is. Anything else is `"unknown"`.
fn blocked_source(raw: &str) -> String {
    if let Ok(url) = url::Url::parse(raw) {
        return match url.host_str().filter(|host| !host.is_empty()) {
            Some(host) => match url.port() {
                Some(port) => format!("{}://{host}:{port}", url.scheme()),
                None => format!("{}://{host}", url.scheme()),
            },
            None => url.scheme().to_string(),
        };
    }
    let keyword = !raw.is_empty()
        && raw.len() <= 40
        && raw.bytes().all(|b| b.is_ascii_lowercase() || b == b'-');
    if keyword {
        raw.to_string()
    } else {
        "unknown".to_string()
    }
}

#[cfg(test)]
mod tests {
    use std::collections::{BTreeMap, BTreeSet, HashMap};

    use axum::body::Body;
    use axum::extract::DefaultBodyLimit;
    use axum::http::{header, Request};
    use axum::routing::post;
    use axum::Router;
    use tower::ServiceExt;

    use super::*;
    use crate::test_support::LogCapture;

    /// The default PostHog origin: PostHog Cloud's EU region.
    const EU: &str = "https://eu.i.posthog.com";

    /// A policy as directive → sources. A directive named twice fails.
    fn directives(policy: &str) -> BTreeMap<String, BTreeSet<String>> {
        let mut map = BTreeMap::new();
        for directive in policy.split(';').map(str::trim).filter(|d| !d.is_empty()) {
            let mut words = directive.split_whitespace();
            let name = words.next().unwrap_or_default().to_string();
            let sources = words.map(str::to_string).collect::<BTreeSet<_>>();
            assert!(
                map.insert(name.clone(), sources).is_none(),
                "{name} is named twice: {policy}"
            );
        }
        map
    }

    fn table(rows: &[(&str, &[&str])]) -> BTreeMap<String, BTreeSet<String>> {
        rows.iter()
            .map(|(name, sources)| {
                let sources = sources.iter().map(|s| s.to_string()).collect();
                (name.to_string(), sources)
            })
            .collect()
    }

    #[test]
    fn the_policy_has_exactly_the_directives_the_app_needs() {
        let policy = content_security_policy(8765, EU);
        let want = table(&[
            ("default-src", &["'self'"]),
            ("script-src", &["'self'", "'wasm-unsafe-eval'"]),
            ("style-src", &["'self'", "'unsafe-inline'"]),
            ("img-src", &["'self'", "data:", "https:"]),
            ("font-src", &["'self'", "data:"]),
            (
                "connect-src",
                &[
                    "'self'",
                    "ipc:",
                    "http://ipc.localhost",
                    "ws://127.0.0.1:8765",
                    "https://eu.i.posthog.com",
                ],
            ),
            ("media-src", &["'self'", "https:"]),
            (
                "frame-src",
                &[
                    "http://localhost:*",
                    "http://127.0.0.1:*",
                    "https://localhost:*",
                    "https://127.0.0.1:*",
                ],
            ),
            ("worker-src", &["'none'"]),
            ("object-src", &["'none'"]),
            ("base-uri", &["'none'"]),
            ("form-action", &["'none'"]),
            ("frame-ancestors", &["'none'"]),
            ("report-uri", &["/api/csp-report"]),
        ]);
        assert_eq!(directives(&policy), want, "{policy}");
    }

    #[test]
    fn the_policy_allows_neither_eval_nor_inline_scripts() {
        let policy = directives(&content_security_policy(8765, EU));
        // A whole source token: 'wasm-unsafe-eval' (shiki's WASM) only lets
        // the page compile WebAssembly, and it is required.
        for (name, sources) in &policy {
            assert!(
                !sources.contains("'unsafe-eval'"),
                "{name} allows 'unsafe-eval'"
            );
        }
        let script = policy.get("script-src").expect("a script-src");
        assert!(!script.contains("'unsafe-inline'"), "{script:?}");
        let connect = policy.get("connect-src").expect("a connect-src");
        assert!(connect.contains("ws://127.0.0.1:8765"), "{connect:?}");
        assert!(connect.contains(EU), "{connect:?}");
    }

    #[test]
    fn the_sockets_follow_the_bound_port_and_analytics_its_origin() {
        let policy = directives(&content_security_policy(8899, "https://x.example:8443"));
        let connect = policy.get("connect-src").expect("a connect-src");
        assert!(connect.contains("ws://127.0.0.1:8899"), "{connect:?}");
        assert!(!connect.contains("ws://127.0.0.1:8765"), "{connect:?}");
        assert!(connect.contains("https://x.example:8443"), "{connect:?}");
        assert!(!connect.contains(EU), "{connect:?}");
    }

    #[test]
    fn the_posthog_origin_is_scheme_host_and_port_or_else_the_default() {
        assert_eq!(posthog_origin(None), EU);
        assert_eq!(posthog_origin(Some("https://eu.i.posthog.com/")), EU);
        assert_eq!(
            posthog_origin(Some("https://x.example:8443/p")),
            "https://x.example:8443"
        );
        assert_eq!(posthog_origin(Some("not a url")), EU);
        // Unset at build time looks the same as empty to Vite.
        assert_eq!(posthog_origin(Some("")), EU);
        // A scheme posthog-js can't send to.
        assert_eq!(posthog_origin(Some("ftp://x.example/")), EU);
        // The default port is left out, as a browser's origin leaves it.
        assert_eq!(
            posthog_origin(Some("https://x.example:443/batch?k=v")),
            "https://x.example"
        );
    }

    #[test]
    fn a_blocked_url_is_reduced_to_its_origin_and_a_keyword_kept() {
        assert_eq!(
            blocked_source("https://evil.example/x.js?token=abc"),
            "https://evil.example"
        );
        assert_eq!(
            blocked_source("http://127.0.0.1:5173/src/main.tsx"),
            "http://127.0.0.1:5173"
        );
        assert_eq!(
            blocked_source("wss://evil.example:9000/socket"),
            "wss://evil.example:9000"
        );
        for keyword in ["inline", "eval", "data", "blob", "wasm-eval"] {
            assert_eq!(blocked_source(keyword), keyword);
        }
        // A URL without a host is its scheme.
        assert_eq!(blocked_source("data:image/png;base64,AAAA"), "data");
        assert_eq!(blocked_source("blob:http://127.0.0.1:8765/1234"), "blob");
        // Anything else says nothing.
        assert_eq!(blocked_source(""), "unknown");
        assert_eq!(blocked_source("not a url, nor a keyword"), "unknown");
    }

    #[test]
    fn a_report_names_its_directive_and_what_was_blocked() {
        let report = br#"{"csp-report":{
            "document-uri":"http://127.0.0.1:8765/",
            "effective-directive":"script-src-elem",
            "violated-directive":"script-src 'self' 'wasm-unsafe-eval'",
            "blocked-uri":"https://evil.example/x.js?token=abc"}}"#;
        assert_eq!(
            violation(report),
            ("script-src-elem".into(), "https://evil.example".into())
        );
        // Without effective-directive: the name violated-directive starts with.
        let report = br#"{"csp-report":{
            "violated-directive":"style-src 'self' 'unsafe-inline'",
            "blocked-uri":"inline"}}"#;
        assert_eq!(violation(report), ("style-src".into(), "inline".into()));
        // Whatever else a body holds.
        for body in [&b""[..], b"not json", b"[]", b"{}", br#"{"csp-report":7}"#] {
            assert_eq!(
                violation(body),
                ("unknown".into(), "unknown".into()),
                "{}",
                String::from_utf8_lossy(body)
            );
        }
        // A directive name is lowercase letters and dashes.
        let report =
            br#"{"csp-report":{"effective-directive":"X\nforged line","blocked-uri":"eval"}}"#;
        assert_eq!(violation(report), ("unknown".into(), "eval".into()));
    }

    /// The report route as `http::app` mounts it.
    fn report_route() -> Router {
        Router::new().route(
            CSP_REPORT_PATH,
            post(csp_report).layer(DefaultBodyLimit::max(CSP_REPORT_MAX_BYTES)),
        )
    }

    fn report(body: impl Into<Body>) -> Request<Body> {
        Request::post(CSP_REPORT_PATH)
            .header(header::CONTENT_TYPE, "application/csp-report")
            .body(body.into())
            .unwrap()
    }

    #[tokio::test]
    async fn a_report_is_logged_with_the_directive_and_origin_and_answered_204() {
        let logs = LogCapture::start();
        let body = r#"{"csp-report":{"document-uri":"http://127.0.0.1:8765/","effective-directive":"connect-src","blocked-uri":"https://evil.example/collect?token=SECRET"}}"#;
        let resp = report_route().oneshot(report(body)).await.unwrap();
        let text = logs.text();

        assert_eq!(resp.status(), StatusCode::NO_CONTENT);
        assert!(text.contains("WARN fleetify.csp:"), "{text}");
        assert!(text.contains(r#"directive="connect-src""#), "{text}");
        assert!(text.contains(r#"blocked="https://evil.example""#), "{text}");
        assert!(!text.contains("SECRET"), "the query was logged: {text}");
        assert!(!text.contains("/collect"), "the path was logged: {text}");
    }

    #[tokio::test]
    async fn a_report_body_over_16_kib_gets_413() {
        // The report at the limit is logged. Without a subscriber of its
        // own, this thread could register the log line's callsite as never
        // enabled while the test above runs on another thread, and that
        // test would see no line.
        let _logs = LogCapture::start();
        let at_limit = report_route()
            .oneshot(report(vec![b' '; CSP_REPORT_MAX_BYTES]))
            .await
            .unwrap();
        assert_eq!(at_limit.status(), StatusCode::NO_CONTENT);
        let over = report_route()
            .oneshot(report(vec![b' '; CSP_REPORT_MAX_BYTES + 1]))
            .await
            .unwrap();
        assert_eq!(over.status(), StatusCode::PAYLOAD_TOO_LARGE);
    }

    /// UI files keyed by request path.
    fn ui(files: &[(&'static str, &'static str, &'static str)]) -> UiFiles {
        let files: HashMap<_, _> = files
            .iter()
            .map(|(path, body, mime)| (*path, (*body, *mime)))
            .collect();
        let assets = UiAssets::new(move |path| {
            files.get(path).map(|(body, mime)| UiAsset {
                bytes: body.as_bytes().to_vec(),
                mime_type: mime.to_string(),
            })
        });
        UiFiles::new(assets, 8765)
    }

    fn header_of(resp: &Response, name: header::HeaderName) -> &str {
        resp.headers()
            .get(name)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
    }

    /// The three headers every UI response carries: the policy for the
    /// bound port (8765 here), and two more.
    fn assert_security_headers(resp: &Response) {
        let csp = header_of(resp, header::CONTENT_SECURITY_POLICY);
        assert!(csp.contains("default-src 'self'"), "{csp:?}");
        assert_eq!(
            csp,
            content_security_policy(8765, &posthog_origin(option_env!("VITE_POSTHOG_HOST")))
        );
        assert_eq!(header_of(resp, header::X_CONTENT_TYPE_OPTIONS), "nosniff");
        assert_eq!(header_of(resp, header::REFERRER_POLICY), "no-referrer");
    }

    #[test]
    fn the_index_and_root_files_are_revalidated_and_assets_cached_for_a_year() {
        let ui = ui(&[
            ("/", "<!doctype html>", "text/html"),
            ("/favicon.svg", "<svg/>", "image/svg+xml"),
            ("/assets/app-1a2b.js", "export {}", "text/javascript"),
        ]);
        for (path, cache, mime) in [
            ("/", "no-cache", "text/html"),
            ("/favicon.svg", "no-cache", "image/svg+xml"),
            (
                "/assets/app-1a2b.js",
                "public, max-age=31536000, immutable",
                "text/javascript",
            ),
        ] {
            let resp = ui.respond(&Method::GET, path);
            assert_eq!(resp.status(), StatusCode::OK, "{path}");
            assert_eq!(header_of(&resp, header::CACHE_CONTROL), cache, "{path}");
            assert_eq!(header_of(&resp, header::CONTENT_TYPE), mime, "{path}");
            assert_security_headers(&resp);
        }
    }

    #[test]
    fn a_missing_file_is_an_empty_404_and_another_method_a_405() {
        let ui = ui(&[("/", "<!doctype html>", "text/html")]);
        let missing = ui.respond(&Method::GET, "/assets/missing.js");
        assert_eq!(missing.status(), StatusCode::NOT_FOUND);
        assert!(missing.headers().get(header::CONTENT_TYPE).is_none());
        assert_eq!(header_of(&missing, header::CACHE_CONTROL), "no-cache");
        assert_security_headers(&missing);

        for method in [Method::POST, Method::PUT, Method::DELETE, Method::OPTIONS] {
            let refused = ui.respond(&method, "/");
            assert_eq!(refused.status(), StatusCode::METHOD_NOT_ALLOWED, "{method}");
            assert_eq!(header_of(&refused, header::ALLOW), "GET, HEAD", "{method}");
            assert_security_headers(&refused);
        }
    }
}
