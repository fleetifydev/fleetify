//! Shared by the integration tests: the real backend, started with
//! `serve()` on an ephemeral loopback port, and HTTP clients for it. A
//! test file pulls it in with `mod common;`.
//!
//! It sets no environment variables: each test still sets the ones it needs
//! (`FLEET_DB_URL`, `FLEETIFY_NOAUTH`, …) before it starts a server, and the
//! ones `serve()` sets (`FLEETIFY_BACKEND_URL`, `FLEETIFY_INTERNAL_SECRET`)
//! are there once a start returns.

// Each test binary compiles its own copy and uses only some of it.
#![allow(dead_code)]

use std::net::SocketAddr;
use std::time::Duration;

use fleetify_backend::access::{ApiToken, API_TOKEN_HEADER};
use fleetify_backend::{ServeOptions, ServerHandle};

/// A running backend. Dropping it shuts the server down, so keep it alive
/// while the test sends requests.
pub struct TestServer {
    pub handle: ServerHandle,
    /// The token the server was started with.
    pub token: ApiToken,
}

impl TestServer {
    /// API only (no UI files, no external routers), with a new token.
    pub async fn start() -> Self {
        Self::start_with(ServeOptions::api_only(ApiToken::generate())).await
    }

    /// Started with `opts`, on `127.0.0.1:0`.
    pub async fn start_with(opts: ServeOptions) -> Self {
        let token = opts.api_token.clone();
        let addr: SocketAddr = "127.0.0.1:0".parse().unwrap();
        let handle = fleetify_backend::serve(addr, opts).await.expect("serve");
        Self { handle, token }
    }

    /// The address it bound.
    pub fn addr(&self) -> SocketAddr {
        self.handle.local_addr()
    }

    /// The port it bound.
    pub fn port(&self) -> u16 {
        self.addr().port()
    }

    /// `http://127.0.0.1:<port><path>`.
    pub fn url(&self, path: &str) -> String {
        format!("http://{}{path}", self.addr())
    }

    /// A client for this server. Every request it sends carries the
    /// server's token in `X-Fleetify-Token`, unless the request sets that
    /// header itself. The header is marked sensitive, so the client's debug
    /// output never shows it.
    pub fn client(&self) -> reqwest::Client {
        let mut token = reqwest::header::HeaderValue::from_str(self.token.as_str())
            .expect("a token is a valid header value");
        token.set_sensitive(true);
        let mut default_headers = reqwest::header::HeaderMap::new();
        default_headers.insert(API_TOKEN_HEADER, token);
        reqwest::Client::builder()
            .default_headers(default_headers)
            .build()
            .expect("build the test client")
    }

    /// A client that sends no token, for the checks that a request without
    /// one (or with a wrong one, set per request) is refused. reqwest can't
    /// drop a default header from one request, so this is a second client.
    pub fn client_without_token(&self) -> reqwest::Client {
        reqwest::Client::builder()
            .build()
            .expect("build the test client")
    }
}

/// Send `request` over a plain TCP connection to `addr` and return the raw
/// response. Meant for HTTP/1.0 requests, which the server answers and then
/// closes.
pub async fn raw_exchange(addr: SocketAddr, request: &str) -> String {
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
