//! `/api/mcp/*` — list/add/update/delete MCP servers backed by
//! services::mcp_registry, plus the probe + OAuth flow. Per-server status
//! is served from the boot-warmed `mcp_status` cache so the Settings page
//! and composer show real connection state on first open without firing a
//! probe fan-out on every mount.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::routers::AppState;
use crate::services::mcp_prober::McpStatus;
use crate::services::{mcp_registry, mcp_status};

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

/// The "never probed" status object (grey "Unknown" in the UI), used when
/// the cache has no entry yet for a server (just added, or the boot warm
/// hasn't reached it).
fn unknown_status(name: &str) -> Value {
    json!({
        "name": name,
        "status": serde_json::to_value(McpStatus::Unknown).unwrap(),
        "tool_count": 0,
        "tools": [],
        "error": null,
        "auth_hint": null,
        "probed_at": null
    })
}

/// One `{ name, config, status }` row. `status` comes from the boot-warmed
/// status cache so the renderer paints real state without firing its own
/// probe; absent entries fall back to "unknown".
fn row(name: &str, config: &Value) -> Value {
    let status = mcp_status::cached(name)
        .map(|r| serde_json::to_value(r).unwrap_or_else(|_| unknown_status(name)))
        .unwrap_or_else(|| unknown_status(name));
    json!({ "name": name, "config": config, "status": status })
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

async fn update_server(Path(name): Path<String>, Json(b): Json<UpdateBody>) -> impl IntoResponse {
    match mcp_registry::update(&name, b.config.clone()) {
        // Evict the cached status: the config just changed, so the old probe
        // result no longer describes it. The row falls back to "unknown"
        // until the next probe/warm — the honest "re-probe me" signal.
        Ok(_) => {
            mcp_status::forget(&name);
            Json(row(&name, &b.config)).into_response()
        }
        Err(e) => (StatusCode::NOT_FOUND, Json(json!({ "detail": e }))).into_response(),
    }
}

async fn delete_server(Path(name): Path<String>) -> impl IntoResponse {
    match mcp_registry::remove(&name) {
        Ok(_) => {
            mcp_status::forget(&name);
            StatusCode::NO_CONTENT.into_response()
        }
        Err(e) => (StatusCode::NOT_FOUND, Json(json!({ "detail": e }))).into_response(),
    }
}

async fn probe_server(Path(name): Path<String>) -> Json<Value> {
    let r = mcp_status::probe_and_cache(&name).await;
    Json(serde_json::to_value(r).unwrap_or(Value::Null))
}

async fn probe_all() -> Json<Value> {
    let names: Vec<String> = mcp_registry::list_all().into_keys().collect();
    let futs = names.into_iter().map(|n| async move {
        let r = mcp_status::probe_and_cache(&n).await;
        (n, serde_json::to_value(r).unwrap_or(Value::Null))
    });
    let results = futures_util::future::join_all(futs).await;
    let mut out = serde_json::Map::new();
    for (n, v) in results {
        out.insert(n, v);
    }
    Json(Value::Object(out))
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

async fn auth_start(Path(name): Path<String>) -> Json<Value> {
    let Some(cfg) = mcp_registry::get(&name) else {
        return Json(json!({
            "ok": false,
            "error": format!("no MCP server named {name:?}")
        }));
    };
    match crate::services::mcp_auth::start(&name, &cfg).await {
        Ok(url) => Json(json!({ "ok": true, "authorize_url": url })),
        Err(e) => Json(json!({ "ok": false, "error": e.to_string() })),
    }
}

#[derive(serde::Deserialize)]
struct CallbackQ {
    #[serde(default)]
    code: Option<String>,
    #[serde(default)]
    state: Option<String>,
}

async fn auth_callback(axum::extract::Query(q): axum::extract::Query<CallbackQ>) -> Json<Value> {
    let code = q.code.unwrap_or_default();
    let state = q.state.unwrap_or_default();
    if code.is_empty() || state.is_empty() {
        return Json(json!({ "ok": false, "error": "code + state are required" }));
    }
    match crate::services::mcp_auth::callback(&code, &state).await {
        Ok(name) => Json(json!({ "ok": true, "server": name })),
        Err(e) => Json(json!({ "ok": false, "error": e.to_string() })),
    }
}

async fn auth_signout(Path(name): Path<String>) -> Json<Value> {
    let was = crate::services::mcp_secrets::get(&name).is_some();
    crate::services::mcp_auth::signout(&name);
    json!({ "ok": true, "was_authenticated": was }).into()
}
