//! The `fleet-memory-mcp` sidecar's way into the backend, over the real
//! `serve()` stack with the API token required, as a release build always
//! has it. The sidecar holds the internal secret and its session id but
//! never the token, which only the app window gets: `/api/internal/memory`
//! asks for no token, and what the sidecar saves there is the session
//! memory the window reads.
//!
//! Its own test binary: the environment it sets is process-wide.

mod common;

use std::sync::OnceLock;

use common::TestServer;
use serde_json::{json, Value};

/// No identity provider (`FLEETIFY_NOAUTH=1`), but the API token checked
/// all the same (`FLEETIFY_REQUIRE_API_TOKEN=1`); an in-memory database, a
/// home of its own and no helper polling.
fn test_env() {
    static HOME: OnceLock<tempfile::TempDir> = OnceLock::new();
    let home = HOME.get_or_init(|| tempfile::tempdir().unwrap());
    std::env::set_var("FLEETIFY_NOAUTH", "1");
    std::env::set_var("FLEETIFY_REQUIRE_API_TOKEN", "1");
    // The no-auth user needs no issuer; a dead one fails fast if reached.
    std::env::set_var("FLEETIFY_ISSUER", "http://127.0.0.1:1");
    std::env::set_var("FLEETIFY_AUDIENCE", "http://127.0.0.1:8765");
    std::env::set_var("FLEET_DB_URL", "sqlite::memory:");
    std::env::set_var("FLEETIFY_HOME", home.path());
    std::env::set_var("FLEETIFY_CLAUDE_BG_AUTODETECT", "0");
}

#[tokio::test]
async fn the_memory_sidecar_reaches_its_sessions_memory_without_the_api_token() {
    test_env();
    let server = TestServer::start().await;
    let window = server.client();
    let sidecar = server.client_without_token();
    let secret = std::env::var("FLEETIFY_INTERNAL_SECRET").expect("serve() sets the secret");

    // A session, made the way the window makes one.
    let created = window
        .post(server.url("/api/sessions"))
        .json(&json!({ "title": "worker", "project_path": std::env::temp_dir() }))
        .send()
        .await
        .unwrap();
    assert_eq!(created.status(), 200, "create the session");
    let session: Value = created.json().await.unwrap();
    let id = session["id"].as_str().expect("a session id").to_string();

    // What the sidecar sent before: the window's route, without the token.
    let resp = sidecar
        .get(server.url(&format!("/api/sessions/{id}/memory")))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 403, "the guard refuses the window's route");

    // remember
    let resp = sidecar
        .post(server.url("/api/internal/memory"))
        .header("X-Fleet-Internal", &secret)
        .json(&json!({
            "caller_session_id": id,
            "title": "Run the gates first",
            "content": "CI runs fmt, clippy and the tests on every PR.",
            "kind": "learning",
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200, "remember");

    // recall
    let resp = sidecar
        .get(server.url("/api/internal/memory"))
        .query(&[("caller_session_id", id.as_str()), ("limit", "10")])
        .header("X-Fleet-Internal", &secret)
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200, "recall");
    let recalled: Value = resp.json().await.unwrap();
    assert_eq!(recalled.as_array().map(Vec::len), Some(1), "{recalled}");
    assert_eq!(recalled[0]["title"], "Run the gates first");
    assert_eq!(recalled[0]["kind"], "learning");

    // The window sees the note in the session's memory.
    let resp = window
        .get(server.url(&format!("/api/sessions/{id}/memory")))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200, "the window reads the session's memory");
    let notes: Value = resp.json().await.unwrap();
    assert_eq!(notes.as_array().map(Vec::len), Some(1), "{notes}");
    assert_eq!(notes[0]["id"], recalled[0]["id"]);
    assert_eq!(notes[0]["created_by"], "agent");
}
