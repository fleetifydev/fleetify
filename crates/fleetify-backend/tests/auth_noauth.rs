//! `FLEETIFY_NOAUTH=1` end-to-end: protected `/api/sessions` should answer
//! 200 without any Bearer header when the flag is on, because the
//! `AuthUser` extractor short-circuits to a stub "John Doe" user.
//!
//! Set the env var BEFORE `serve()` boots so the predicate's OnceLock
//! latches `true`. Tests in this file share the same process; all of them
//! want the flag on.

use std::net::SocketAddr;

use fleetify_backend::access::ApiToken;
use fleetify_backend::ServeOptions;

fn enable_noauth() {
    std::env::set_var("FLEETIFY_NOAUTH", "1");
    // Point JWKS at a dead address — the bypass must NOT touch it. If the
    // backend ever reaches out, the request fails fast instead of hanging.
    std::env::set_var("FLEETIFY_ISSUER", "http://127.0.0.1:1");
    std::env::set_var("FLEETIFY_AUDIENCE", "http://127.0.0.1:8765");
    std::env::set_var("FLEET_DB_URL", "sqlite::memory:");
}

#[tokio::test]
async fn protected_route_skips_bearer_when_noauth_enabled() {
    enable_noauth();
    assert!(
        fleetify_backend::auth::is_no_auth(),
        "predicate should latch true after env var set"
    );

    let addr: SocketAddr = "127.0.0.1:0".parse().unwrap();
    let handle = fleetify_backend::serve(addr, ServeOptions::api_only(ApiToken::generate()))
        .await
        .expect("serve");
    let base = format!("http://{}", handle.local_addr());

    // No Authorization header — would normally 401 NotAuthenticated.
    let resp = reqwest::Client::new()
        .get(format!("{base}/api/sessions"))
        .send()
        .await
        .unwrap();
    assert_eq!(
        resp.status(),
        reqwest::StatusCode::OK,
        "no-auth bypass should return 200 without a bearer; body = {}",
        resp.text().await.unwrap_or_default()
    );

    let sessions: serde_json::Value = reqwest::Client::new()
        .get(format!("{base}/api/sessions"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(sessions.is_array(), "expected an array, got {sessions}");
    assert_eq!(
        sessions.as_array().unwrap().len(),
        0,
        "fresh in-memory DB should have no sessions"
    );
}

#[tokio::test]
async fn release_build_ignores_env_var() {
    // `is_no_auth()` is gated on `cfg!(debug_assertions)`. `cargo test`
    // runs the dev profile by default (debug_assertions = true), so this
    // test only meaningfully asserts the dev-profile branch — but
    // verifying the predicate path here documents the gate's existence
    // and catches accidental flips of the cfg guard.
    enable_noauth();
    let expected = cfg!(debug_assertions);
    assert_eq!(
        fleetify_backend::auth::is_no_auth(),
        expected,
        "is_no_auth() must mirror cfg!(debug_assertions) when FLEETIFY_NOAUTH=1"
    );
}
