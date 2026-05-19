//! `/api/ssh/*` — faithful endpoint shapes for the Remote tab; the full
//! ssh-binary integration (known_hosts parse, ssh -T probe, sftp listdir)
//! lands in Phase 3. The Python original wraps the `ssh` CLI; the Rust
//! port will follow the same pattern. For now: known-hosts → [],
//! test/list-dir → faithful "deferred" error envelopes so the renderer's
//! Remote panel renders empty instead of 404'ing.

use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::routers::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/ssh/known-hosts", get(known_hosts))
        .route("/ssh/test", post(test_target))
        .route("/ssh/list-dir", post(list_dir))
}

async fn known_hosts() -> Json<Value> {
    // Phase 3: parse ~/.ssh/config + ~/.ssh/known_hosts.
    Json(json!([]))
}

#[derive(Deserialize)]
struct SshTarget {
    #[allow(dead_code)]
    host: Option<String>,
    #[allow(dead_code)]
    user: Option<String>,
}

async fn test_target(Json(_t): Json<SshTarget>) -> Json<Value> {
    Json(json!({
        "ok": false,
        "error": "ssh connectivity test not implemented yet (Phase 3 follow-up)"
    }))
}

#[derive(Deserialize)]
struct ListDirReq {
    #[allow(dead_code)]
    target: Option<Value>,
    #[allow(dead_code)]
    path: Option<String>,
}

async fn list_dir(Json(_r): Json<ListDirReq>) -> Json<Value> {
    Json(json!({
        "ok": false,
        "entries": [],
        "error": "remote list-dir not implemented yet (Phase 3 follow-up)"
    }))
}
