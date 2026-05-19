//! `/api/docker/*` — faithful endpoint shapes for the Docker panel.
//! Full Docker integration (probe daemon, `docker ps --format json`,
//! exec ls in container) lands in Phase 3. For now: /status reports
//! daemon unreachable, /containers → [], /list-dir → deferred error.

use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::routers::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/docker/status", get(status))
        .route("/docker/containers", get(containers))
        .route("/docker/list-dir", post(list_dir))
}

async fn status() -> Json<Value> {
    Json(json!({ "running": false, "error": "Docker probe not implemented yet (Phase 3)" }))
}

async fn containers() -> Json<Value> {
    Json(json!([]))
}

#[derive(Deserialize)]
struct ListDirReq {
    #[allow(dead_code)]
    container_id: Option<String>,
    #[allow(dead_code)]
    path: Option<String>,
}

async fn list_dir(Json(_r): Json<ListDirReq>) -> Json<Value> {
    Json(json!({
        "ok": false,
        "entries": [],
        "error": "container list-dir not implemented yet (Phase 3 follow-up)"
    }))
}
