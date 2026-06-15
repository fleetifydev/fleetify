//! `/api/runtime/*` — plugin-runtime read endpoints. Phase-4 stubs:
//! templates / commands / skills / workflows from installed plugins,
//! all empty until the plugin foundation (manifest parser + materialized
//! components) lands.

use axum::extract::Query;
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;
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
/// Query for `/runtime/commands`. `tool` selects the provider-smart skill
/// payload; the composer also sends `session_id`/`project_path`, which serde
/// ignores here.
#[derive(Deserialize)]
struct CommandsQuery {
    tool: Option<String>,
}

async fn commands(Query(q): Query<CommandsQuery>) -> Json<Value> {
    let items = crate::services::command_catalog::list_commands(q.tool.as_deref());
    Json(serde_json::to_value(items).unwrap_or_else(|_| json!([])))
}
async fn skills() -> Json<Value> {
    Json(json!([]))
}
async fn workflows() -> Json<Value> {
    Json(json!([]))
}
