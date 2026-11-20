//! The access guard over the real `serve()` stack: the backend answers only
//! requests addressed to its own host (`127.0.0.1:<port>` or
//! `localhost:<port>`), on every path, and sends no CORS headers. API
//! requests also need this run's token: in the `X-Fleetify-Token` header,
//! or, for a WebSocket upgrade or the status stream, in the `api_token`
//! query parameter.
//!
//! These tests never print a token: a URL with the token in its query is
//! left out of every failure message.

mod common;

use std::sync::OnceLock;

use common::{raw_exchange, TestServer};
use fleetify_backend::access::{ApiToken, API_TOKEN_HEADER, API_TOKEN_QUERY};
use fleetify_backend::ui::{UiAsset, UiAssets};
use fleetify_backend::ServeOptions;
use tokio_tungstenite::tungstenite::Error as WsError;

/// An in-memory database, a home of its own, no helper polling, and auth
/// on: `FLEETIFY_NOAUTH=1` would also turn off the token check these tests
/// are about.
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
    TestServer::start().await
}

/// `GET path` with `host` as the Host header.
async fn get_with_host(server: &TestServer, path: &str, host: &str) -> reqwest::Response {
    server
        .client()
        .get(server.url(path))
        .header(reqwest::header::HOST, host)
        .send()
        .await
        .unwrap()
}

/// The response's body is plain text, as the guard's 403 is.
fn assert_plain_text(resp: &reqwest::Response) {
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    assert!(
        content_type.starts_with("text/plain"),
        "content-type: {content_type:?}"
    );
}

#[tokio::test]
async fn healthz_answers_on_its_own_address_without_a_token() {
    let server = start().await;
    let resp = server
        .client_without_token()
        .get(server.url("/healthz"))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
}

#[tokio::test]
async fn another_host_gets_a_plain_text_403_on_every_path() {
    let server = start().await;
    let evil = format!("evil.example:{}", server.port());

    let resp = get_with_host(&server, "/healthz", &evil).await;
    assert_eq!(resp.status(), 403);
    assert_plain_text(&resp);
    assert_eq!(resp.text().await.unwrap(), "forbidden");

    // A path no route matches: the 404 is behind the check too.
    let own = format!("127.0.0.1:{}", server.port());
    let resp = get_with_host(&server, "/no-such-path", &own).await;
    assert_eq!(resp.status(), 404);
    let resp = get_with_host(&server, "/no-such-path", &evil).await;
    assert_eq!(resp.status(), 403);
}

#[tokio::test]
async fn localhost_on_the_bound_port_is_allowed() {
    let server = start().await;
    let host = format!("localhost:{}", server.port());
    let resp = get_with_host(&server, "/healthz", &host).await;
    assert_eq!(resp.status(), 200);
}

/// hyper accepts an HTTP/1.0 request without a Host header; the guard is
/// what refuses it (its plain-text body says so).
#[tokio::test]
async fn a_request_without_a_host_is_refused() {
    let server = start().await;
    let response = raw_exchange(server.addr(), "GET /healthz HTTP/1.0\r\n\r\n").await;
    let status_line = response.lines().next().unwrap_or_default();
    assert!(
        status_line.starts_with("HTTP/1.") && status_line.contains(" 403 "),
        "status line: {status_line}"
    );
    assert!(response.ends_with("\r\n\r\nforbidden"), "{response}");
}

#[tokio::test]
async fn a_cross_origin_preflight_gets_no_cors_headers() {
    let server = start().await;
    let resp = server
        .client()
        .request(reqwest::Method::OPTIONS, server.url("/api/groups"))
        .header("Origin", "http://localhost:3000")
        .header("Access-Control-Request-Method", "POST")
        .send()
        .await
        .unwrap();
    // It reached the router: the guard would have answered 403.
    assert_ne!(resp.status(), 403, "the guard refused the preflight");
    assert!(
        resp.headers().get("access-control-allow-origin").is_none(),
        "CORS headers sent: {:?}",
        resp.headers()
    );
}

/// The guard is the outermost layer, so the UI fallback is behind it too:
/// the UI is served to its own address, without a token, and refused to any
/// other.
#[tokio::test]
async fn the_ui_files_are_behind_the_host_check() {
    test_env();
    let index = UiAssets::new(|path| {
        (path == "/" || path == "/index.html").then(|| UiAsset {
            bytes: b"<!doctype html>FLEET-UI".to_vec(),
            mime_type: "text/html".into(),
        })
    });
    let server = TestServer::start_with(ServeOptions {
        ui: Some(index),
        ..ServeOptions::api_only(ApiToken::generate())
    })
    .await;

    let served = server
        .client_without_token()
        .get(server.url("/"))
        .send()
        .await
        .unwrap();
    assert_eq!(served.status(), 200);
    assert!(served.text().await.unwrap().contains("FLEET-UI"));

    let evil = format!("evil.example:{}", server.port());
    let refused = get_with_host(&server, "/", &evil).await;
    assert_eq!(refused.status(), 403);
    assert_eq!(refused.text().await.unwrap(), "forbidden");
    let refused = get_with_host(&server, "/index.html", &evil).await;
    assert_eq!(refused.status(), 403);
}

#[tokio::test]
async fn an_api_request_needs_the_token_header() {
    let server = start().await;
    let url = server.url("/api/groups");

    let without = server
        .client_without_token()
        .get(&url)
        .send()
        .await
        .unwrap();
    assert_eq!(without.status(), 403);
    assert_plain_text(&without);
    assert_eq!(without.text().await.unwrap(), "forbidden");

    let with = server.client().get(&url).send().await.unwrap();
    assert_eq!(with.status(), 200);

    let other = ApiToken::generate();
    let wrong = server
        .client_without_token()
        .get(&url)
        .header(API_TOKEN_HEADER, other.as_str())
        .send()
        .await
        .unwrap();
    assert_eq!(wrong.status(), 403);
}

#[tokio::test]
async fn the_status_stream_takes_the_token_in_its_query() {
    let server = start().await;
    let url = format!(
        "{}?{API_TOKEN_QUERY}={}",
        server.url("/events/status"),
        server.token.as_str()
    );

    let resp = server
        .client_without_token()
        .get(&url)
        .send()
        .await
        .map_err(|e| e.without_url())
        .unwrap();
    assert_eq!(resp.status(), 200);
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    assert!(
        content_type.starts_with("text/event-stream"),
        "content-type: {content_type:?}"
    );
    drop(resp);

    let without = server
        .client_without_token()
        .get(server.url("/events/status"))
        .send()
        .await
        .unwrap();
    assert_eq!(without.status(), 403);
}

/// What a failed handshake says, without its URL.
fn handshake_failure(e: &WsError) -> String {
    match e {
        WsError::Http(resp) => format!("HTTP {}", resp.status()),
        WsError::Io(io) => format!("I/O error: {io}"),
        _ => "a WebSocket protocol error".to_string(),
    }
}

#[tokio::test]
async fn a_socket_upgrade_takes_the_token_in_its_query() {
    let server = start().await;
    let socket_url = format!("ws://{}/ws/browser-url", server.addr());

    let with_token = format!("{socket_url}?{API_TOKEN_QUERY}={}", server.token.as_str());
    let (socket, response) = tokio_tungstenite::connect_async(with_token)
        .await
        .unwrap_or_else(|e| {
            panic!(
                "the upgrade with the token failed: {}",
                handshake_failure(&e)
            )
        });
    assert_eq!(response.status(), 101);
    drop(socket);

    match tokio_tungstenite::connect_async(socket_url).await {
        Err(WsError::Http(resp)) => assert_eq!(resp.status(), 403),
        Err(e) => panic!(
            "the upgrade without a token failed another way: {}",
            handshake_failure(&e)
        ),
        Ok(_) => panic!("the upgrade without a token was accepted"),
    }
}

/// The system browser's OAuth redirect can't carry the token; the handler
/// answers it (here: no `code` and `state`).
#[tokio::test]
async fn the_mcp_oauth_callback_needs_no_token() {
    let server = start().await;
    let resp = server
        .client_without_token()
        .get(server.url("/api/mcp/auth/callback"))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let body: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(body["ok"], false);
}

/// The internal routes need no token; their handlers check the internal
/// secret, so without it the answer is the handler's 403, not the guard's.
#[tokio::test]
async fn an_internal_route_needs_no_token_and_its_handler_checks_the_secret() {
    let server = start().await;
    let resp = server
        .client_without_token()
        .post(server.url("/api/internal/dispatch"))
        .json(&serde_json::json!({
            "caller_session_id": "caller",
            "agent": "worker",
            "task": "review the diff",
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 403);
    assert_eq!(resp.text().await.unwrap(), "internal-secret mismatch");
}
