//! `/api/workflows/*` — Phase-4 stubs (full workflows::engine is its own
//! sequential step runner; here we let the Workflows page render empty
//! and refuse run/get-status with honest errors).

use axum::extract::Path;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{json, Value};

use crate::routers::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/workflows", get(list_workflows))
        .route("/workflows/{install_id}/{name}/run", post(run_workflow))
        .route("/workflows/runs/{run_id}", get(get_run))
}

async fn list_workflows() -> Json<Value> {
    Json(json!([]))
}
async fn run_workflow(Path((_id, _name)): Path<(String, String)>) -> Json<Value> {
    Json(json!({
        "ok": false,
        "error": "workflows engine not implemented yet (Phase 4)"
    }))
}
async fn get_run(Path(_run_id): Path<String>) -> Json<Value> {
    Json(json!({ "ok": false, "error": "no such run (workflows = Phase 4)" }))
}
