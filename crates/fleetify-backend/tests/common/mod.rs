//! Shared by the integration tests: the real backend, started with
//! `serve()` on an ephemeral loopback port. A test file pulls it in with
//! `mod common;`.
//!
//! It sets no environment variables: each test still sets the ones it needs
//! (`FLEET_DB_URL`, `FLEETIFY_NOAUTH`, …) before it starts a server, and the
//! ones `serve()` sets (`FLEETIFY_BACKEND_URL`, `FLEETIFY_INTERNAL_SECRET`)
//! are there once a start returns.

// Each test binary compiles its own copy and uses only some of it.
#![allow(dead_code)]

use std::net::SocketAddr;

use fleetify_backend::access::ApiToken;
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
}
