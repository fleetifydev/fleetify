//! `GET /api/prompts` — the flat, searchable prompt list backing the `/prompts`
//! command. Aggregation lives in `services::prompts`; this is thin wiring.

use axum::routing::get;
use axum::{Json, Router};
use serde_json::{json, Value};

use crate::routers::AppState;

pub fn router() -> Router<AppState> {
    Router::new().route("/prompts", get(list))
}

async fn list() -> Json<Value> {
    Json(
        serde_json::to_value(crate::services::prompts::list_prompts())
            .unwrap_or_else(|_| json!([])),
    )
}
