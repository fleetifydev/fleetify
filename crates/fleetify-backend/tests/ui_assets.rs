//! The release UI over the real `serve()` stack, with a stand-in for the
//! files the shell embeds in the binary: the backend serves exactly those
//! files, each with the Content-Security-Policy and two more security
//! headers, and nothing else in their place. None of it needs the API
//! token, and neither do the CSP violation reports browsers send.

mod common;

use std::collections::HashMap;
use std::sync::OnceLock;

use common::{raw_exchange, TestServer};
use fleetify_backend::access::ApiToken;
use fleetify_backend::ui::{UiAsset, UiAssets, CSP_REPORT_PATH};
use fleetify_backend::ServeOptions;
use reqwest::header::{self, HeaderMap};

const INDEX_HTML: &str =
    r#"<!doctype html><title>Fleetify</title><script type="module" src="/assets/app.js"></script>"#;
const APP_JS: &str = "console.log('fleetify');";
const IMMUTABLE: &str = "public, max-age=31536000, immutable";

/// The stand-in: `index.html` and `assets/app.js`, keyed as a map would key
/// them. `/` is index.html; every other request path is its file's key with
/// a leading slash.
fn embedded_files() -> UiAssets {
    let files: HashMap<&str, (&str, &str)> = HashMap::from([
        ("index.html", (INDEX_HTML, "text/html")),
        ("assets/app.js", (APP_JS, "text/javascript")),
    ]);
    UiAssets::new(move |request_path| {
        let key = match request_path {
            "/" => "index.html",
            path => path.strip_prefix('/')?,
        };
        files.get(key).map(|(body, mime)| UiAsset {
            bytes: body.as_bytes().to_vec(),
            mime_type: mime.to_string(),
        })
    })
}

/// An in-memory database, a home of its own, no helper polling, and auth
/// on: `FLEETIFY_NOAUTH=1` would turn off the token check, and these tests
/// show what needs no token.
fn test_env() {
    static HOME: OnceLock<tempfile::TempDir> = OnceLock::new();
    let home = HOME.get_or_init(|| tempfile::tempdir().unwrap());
    std::env::set_var("FLEET_DB_URL", "sqlite::memory:");
    std::env::set_var("FLEETIFY_HOME", home.path());
    std::env::set_var("FLEETIFY_CLAUDE_BG_AUTODETECT", "0");
    std::env::remove_var("FLEETIFY_NOAUTH");
}

async fn start() -> TestServer {
    test_env();
    TestServer::start_with(ServeOptions {
        ui: Some(embedded_files()),
        ..ServeOptions::api_only(ApiToken::generate())
    })
    .await
}

fn header_of(headers: &HeaderMap, name: header::HeaderName) -> &str {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
}

/// The policy for this server's port, and the two other security headers.
fn assert_security_headers(server: &TestServer, headers: &HeaderMap) {
    let csp = header_of(headers, header::CONTENT_SECURITY_POLICY);
    assert!(csp.contains("default-src 'self'"), "{csp:?}");
    assert!(
        csp.contains(&format!("ws://127.0.0.1:{}", server.port())),
        "{csp:?}"
    );
    assert_eq!(
        header_of(headers, header::X_CONTENT_TYPE_OPTIONS),
        "nosniff"
    );
    assert_eq!(header_of(headers, header::REFERRER_POLICY), "no-referrer");
}

#[tokio::test]
async fn the_index_is_served_at_the_root_with_the_security_headers() {
    let server = start().await;
    let resp = server
        .client_without_token()
        .get(server.url("/"))
        .send()
        .await
        .unwrap();

    assert_eq!(resp.status(), 200);
    let headers = resp.headers().clone();
    assert!(
        header_of(&headers, header::CONTENT_TYPE).starts_with("text/html"),
        "{headers:?}"
    );
    assert_security_headers(&server, &headers);
    assert_eq!(header_of(&headers, header::CACHE_CONTROL), "no-cache");
    assert_eq!(resp.text().await.unwrap(), INDEX_HTML);
}

#[tokio::test]
async fn an_asset_is_served_with_an_immutable_cache_header() {
    let server = start().await;
    let resp = server
        .client_without_token()
        .get(server.url("/assets/app.js"))
        .send()
        .await
        .unwrap();

    assert_eq!(resp.status(), 200);
    let headers = resp.headers().clone();
    assert_eq!(header_of(&headers, header::CACHE_CONTROL), IMMUTABLE);
    assert_eq!(header_of(&headers, header::CONTENT_TYPE), "text/javascript");
    assert_security_headers(&server, &headers);
    assert_eq!(resp.text().await.unwrap(), APP_JS);
}

/// The response's status, and its body, which must not be HTML.
async fn not_html(resp: reqwest::Response) -> (u16, String) {
    let status = resp.status().as_u16();
    let content_type = header_of(resp.headers(), header::CONTENT_TYPE).to_string();
    assert!(!content_type.starts_with("text/html"), "{content_type}");
    (status, resp.text().await.unwrap())
}

#[tokio::test]
async fn a_path_that_is_not_an_embedded_file_is_an_empty_404() {
    let server = start().await;
    // No index.html in place of a missing file.
    for path in ["/assets/missing.js", "/index", "/assets/"] {
        let resp = server
            .client_without_token()
            .get(server.url(path))
            .send()
            .await
            .unwrap();
        assert_eq!(not_html(resp).await, (404, String::new()), "{path}");
    }
    // Nor for an API path no route matches. The guard asks API paths for
    // the token, so without it the answer is its 403.
    let resp = server
        .client()
        .get(server.url("/api/nope"))
        .send()
        .await
        .unwrap();
    assert_eq!(not_html(resp).await, (404, String::new()));
    let resp = server
        .client_without_token()
        .get(server.url("/api/nope"))
        .send()
        .await
        .unwrap();
    assert_eq!(not_html(resp).await, (403, "forbidden".to_string()));
}

#[tokio::test]
async fn head_gets_the_headers_without_the_body() {
    let server = start().await;
    let resp = server
        .client_without_token()
        .head(server.url("/"))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    assert_security_headers(&server, resp.headers());
    assert_eq!(
        header_of(resp.headers(), header::CONTENT_LENGTH),
        INDEX_HTML.len().to_string()
    );
    assert!(resp.bytes().await.unwrap().is_empty());

    // On the wire: nothing follows the headers.
    let raw = raw_exchange(
        server.addr(),
        &format!(
            "HEAD / HTTP/1.0\r\nHost: 127.0.0.1:{}\r\n\r\n",
            server.port()
        ),
    )
    .await;
    assert!(
        raw.starts_with("HTTP/1.0 200 ") || raw.starts_with("HTTP/1.1 200 "),
        "{raw}"
    );
    let (_, body) = raw.split_once("\r\n\r\n").expect("a full header block");
    assert_eq!(body, "", "{raw}");
}

/// A method other than GET and HEAD needs the token to get past the access
/// guard (it asks for one on anything but a read outside the API), and the
/// UI answers it 405.
#[tokio::test]
async fn another_method_gets_405() {
    let server = start().await;
    let resp = server.client().post(server.url("/")).send().await.unwrap();
    assert_eq!(resp.status(), 405);
    assert_eq!(header_of(resp.headers(), header::ALLOW), "GET, HEAD");

    let without_token = server
        .client_without_token()
        .post(server.url("/"))
        .send()
        .await
        .unwrap();
    assert_eq!(without_token.status(), 403);
}

/// What a browser sends for a blocked script, with `report-uri`.
const REPORT: &str = r#"{"csp-report":{"document-uri":"http://127.0.0.1/","effective-directive":"script-src-elem","blocked-uri":"https://evil.example/x.js"}}"#;

async fn post_report(server: &TestServer, body: Vec<u8>) -> reqwest::Response {
    server
        .client_without_token()
        .post(server.url(CSP_REPORT_PATH))
        .header(header::CONTENT_TYPE, "application/csp-report")
        .body(body)
        .send()
        .await
        .unwrap()
}

#[tokio::test]
async fn a_csp_report_needs_no_token_and_gets_204() {
    let server = start().await;
    let resp = post_report(&server, REPORT.as_bytes().to_vec()).await;
    assert_eq!(resp.status(), 204);
    // Whatever the body holds.
    let resp = post_report(&server, b"not a report".to_vec()).await;
    assert_eq!(resp.status(), 204);
}

#[tokio::test]
async fn a_csp_report_over_16_kib_gets_413() {
    let server = start().await;
    let resp = post_report(&server, vec![b' '; 20 * 1024]).await;
    assert_eq!(resp.status(), 413);
}
