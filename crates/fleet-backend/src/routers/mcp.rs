//! `/api/mcp/*` — list/add/update/delete MCP servers backed by
//! services::mcp_registry. Probe + OAuth flow stay Phase-4-deferred
//! (the full MCPProber requires actually starting MCP servers and
//! parsing their list-tools output). Faithful row shape keeps the
//! Settings/MCP page wired without 404s.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::routers::AppState;
use crate::services::mcp_registry;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/mcp/servers", get(list_servers).post(add_server))
        .route(
            "/mcp/servers/{name}",
            axum::routing::put(update_server).delete(delete_server),
        )
        .route("/mcp/servers/{name}/probe", post(probe_server))
        .route("/mcp/probe-all", post(probe_all))
        .route("/mcp/config-path", get(config_path))
        .route("/mcp/open-config", post(open_config))
        .route("/mcp/servers/{name}/auth/start", post(auth_start))
        .route("/mcp/auth/callback", get(auth_callback))
        .route("/mcp/servers/{name}/auth/signout", post(auth_signout))
}

fn row(name: &str, config: &Value) -> Value {
    json!({
        "name": name,
        "config": config,
        "status": {
            "name": name,
            "status": "unknown",
            "tool_count": 0,
            "tools": [],
            "error": null,
            "auth_hint": null,
            "probed_at": null
        }
    })
}

async fn list_servers(State(_): State<AppState>) -> Json<Value> {
    let rows: Vec<Value> = mcp_registry::list_all()
        .iter()
        .map(|(n, c)| row(n, c))
        .collect();
    Json(Value::Array(rows))
}

#[derive(Deserialize)]
struct AddBody {
    name: String,
    config: Value,
}

async fn add_server(Json(b): Json<AddBody>) -> impl IntoResponse {
    match mcp_registry::add(&b.name, b.config.clone()) {
        Ok(_) => (StatusCode::CREATED, Json(row(&b.name, &b.config))).into_response(),
        Err(e) if e.contains("already exists") => {
            (StatusCode::CONFLICT, Json(json!({ "detail": e }))).into_response()
        }
        Err(e) => (StatusCode::BAD_REQUEST, Json(json!({ "detail": e }))).into_response(),
    }
}

#[derive(Deserialize)]
struct UpdateBody {
    config: Value,
}

async fn update_server(
    Path(name): Path<String>,
    Json(b): Json<UpdateBody>,
) -> impl IntoResponse {
    match mcp_registry::update(&name, b.config.clone()) {
        Ok(_) => Json(row(&name, &b.config)).into_response(),
        Err(e) => (StatusCode::NOT_FOUND, Json(json!({ "detail": e }))).into_response(),
    }
}

async fn delete_server(Path(name): Path<String>) -> impl IntoResponse {
    match mcp_registry::remove(&name) {
        Ok(_) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => (StatusCode::NOT_FOUND, Json(json!({ "detail": e }))).into_response(),
    }
}

async fn probe_server(Path(name): Path<String>) -> Json<Value> {
    // Phase 4: actually start the MCP server and list tools.
    Json(json!({
        "name": name, "status": "unknown", "tool_count": 0, "tools": [],
        "error": null, "auth_hint": null, "probed_at": null
    }))
}

async fn probe_all() -> Json<Value> {
    Json(json!({}))
}

async fn config_path() -> Json<Value> {
    Json(json!({ "path": mcp_registry::registry_path().to_string_lossy() }))
}

async fn open_config() -> Json<Value> {
    let p = mcp_registry::registry_path();
    match open::that(&p) {
        Ok(_) => Json(json!({ "ok": true })),
        Err(e) => Json(json!({ "ok": false, "error": e.to_string() })),
    }
}

async fn auth_start(Path(_n): Path<String>) -> Json<Value> {
    Json(json!({
        "ok": false,
        "error": "MCP OAuth not implemented yet (Phase 4 follow-up)"
    }))
}

async fn auth_callback() -> Json<Value> {
    Json(json!({ "ok": false, "error": "MCP OAuth not implemented yet (Phase 4)" }))
}

async fn auth_signout(Path(_n): Path<String>) -> Json<Value> {
    Json(json!({ "ok": true, "was_authenticated": false }))
}
