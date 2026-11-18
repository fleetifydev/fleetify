//! The access guard over the real `serve()` stack: the backend answers only
//! requests addressed to its own host (`127.0.0.1:<port>` or
//! `localhost:<port>`), on every path, and sends no CORS headers.

mod common;

use std::net::SocketAddr;
use std::time::Duration;

use common::TestServer;
use fleetify_backend::access::ApiToken;
use fleetify_backend::ServeOptions;

fn in_memory_db() {
    std::env::set_var("FLEET_DB_URL", "sqlite::memory:");
}

async fn start() -> TestServer {
    in_memory_db();
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

/// Send `request` over a plain TCP connection and return the raw response.
async fn raw_exchange(addr: SocketAddr, request: &str) -> String {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let exchange = async {
        let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut response = Vec::new();
        stream.read_to_end(&mut response).await.unwrap();
        response
    };
    let response = tokio::time::timeout(Duration::from_secs(10), exchange)
        .await
        .expect("the server closes an HTTP/1.0 connection after its response");
    String::from_utf8_lossy(&response).into_owned()
}

#[tokio::test]
async fn healthz_answers_on_its_own_address() {
    let server = start().await;
    let resp = server
        .client()
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
    assert!(
        resp.headers().get("access-control-allow-origin").is_none(),
        "CORS headers sent: {:?}",
        resp.headers()
    );
}

/// The guard is the outermost layer, so the static-file fallback is behind
/// it too: the UI is served to its own address and refused to any other.
#[tokio::test]
async fn the_ui_files_are_behind_the_host_check() {
    in_memory_db();
    let ui = tempfile::tempdir().unwrap();
    std::fs::write(ui.path().join("index.html"), "<!doctype html>FLEET-UI").unwrap();
    let server = TestServer::start_with(ServeOptions {
        static_dir: Some(ui.path().to_path_buf()),
        ..ServeOptions::api_only(ApiToken::generate())
    })
    .await;

    let served = server.client().get(server.url("/")).send().await.unwrap();
    assert_eq!(served.status(), 200);
    assert!(served.text().await.unwrap().contains("FLEET-UI"));

    let evil = format!("evil.example:{}", server.port());
    let refused = get_with_host(&server, "/", &evil).await;
    assert_eq!(refused.status(), 403);
    assert_eq!(refused.text().await.unwrap(), "forbidden");
    let refused = get_with_host(&server, "/index.html", &evil).await;
    assert_eq!(refused.status(), 403);
}
