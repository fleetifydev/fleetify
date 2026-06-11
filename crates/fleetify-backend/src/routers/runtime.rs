//! `/api/runtime/*` — plugin-runtime read endpoints. Phase-4 stubs:
//! templates / commands / skills / workflows from installed plugins,
//! all empty until the plugin foundation (manifest parser + materialized
//! components) lands.

use axum::routing::get;
use axum::{Json, Router};
use serde_json::{json, Value};

use crate::routers::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/runtime/templates", get(templates))
        .route("/runtime/commands", get(commands))
        .route("/runtime/skills", get(skills))
        .route("/runtime/workflows", get(workflows))
}

async fn templates() -> Json<Value> {
    Json(
        serde_json::to_value(crate::services::templates::list_all_specs())
            .unwrap_or_else(|_| json!([])),
    )
}
async fn commands() -> Json<Value> {
    Json(json!([]))
}
async fn skills() -> Json<Value> {
    Json(json!([]))
}
async fn workflows() -> Json<Value> {
    Json(json!([]))
}
