//! Integration coverage for the Fleet orchestration-bridge routes over the
//! real `serve()` stack with `FLEETIFY_NOAUTH` (so `AuthUser` resolves to the
//! stub user). Exercises the deterministic, no-Haiku paths:
//!   - `POST /api/fleet/delegate` with no Staff Agent session → 400.
//!   - `GET  /api/fleet/delegate/{unknown}` → 404.
//!
//! The `/api/fleet/plan` happy path is intentionally NOT exercised here: it
//! calls the Haiku planner (`claude --print`), which would be a real, paid,
//! non-deterministic LLM call on a dev machine that has the CLI installed. The
//! planner's own degradation + parsing is unit-tested in `services::auto_planner`.

use std::net::SocketAddr;

fn enable_noauth() {
    std::env::set_var("FLEETIFY_NOAUTH", "1");
    std::env::set_var("FLEETIFY_ISSUER", "http://127.0.0.1:1");
    std::env::set_var("FLEETIFY_AUDIENCE", "http://127.0.0.1:8765");
    std::env::set_var("FLEET_DB_URL", "sqlite::memory:");
}

#[tokio::test]
async fn delegate_without_staff_session_is_400() {
    enable_noauth();
    let addr: SocketAddr = "127.0.0.1:0".parse().unwrap();
    let handle = fleetify_backend::serve(addr, None).await.expect("serve");
    let base = format!("http://{}", handle.local_addr());

    let resp = reqwest::Client::new()
        .post(format!("{base}/api/fleet/delegate"))
        .json(&serde_json::json!({ "dispatches": [{ "target_id": "x", "task": "do y" }] }))
        .send()
        .await
        .unwrap();
    assert_eq!(
        resp.status(),
        reqwest::StatusCode::BAD_REQUEST,
        "no Staff Agent session → 400; body = {}",
        resp.text().await.unwrap_or_default()
    );
}

#[tokio::test]
async fn delegate_empty_dispatches_is_400() {
    enable_noauth();
    let addr: SocketAddr = "127.0.0.1:0".parse().unwrap();
    let handle = fleetify_backend::serve(addr, None).await.expect("serve");
    let base = format!("http://{}", handle.local_addr());

    let resp = reqwest::Client::new()
        .post(format!("{base}/api/fleet/delegate"))
        .json(&serde_json::json!({ "dispatches": [] }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), reqwest::StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn delegate_status_unknown_batch_is_404() {
    enable_noauth();
    let addr: SocketAddr = "127.0.0.1:0".parse().unwrap();
    let handle = fleetify_backend::serve(addr, None).await.expect("serve");
    let base = format!("http://{}", handle.local_addr());

    let resp = reqwest::Client::new()
        .get(format!("{base}/api/fleet/delegate/does-not-exist"))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), reqwest::StatusCode::NOT_FOUND);
}
