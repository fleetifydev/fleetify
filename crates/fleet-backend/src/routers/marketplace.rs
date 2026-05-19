//! `/api/marketplace/*` — Phase-4 stubs (full marketplace = source repos,
//! catalog cache, plugin manifests is a large port; rendering empty here
//! lets the Marketplace tab open instead of 404'ing).

use axum::extract::Path;
use axum::routing::{get, patch, post};
use axum::{Json, Router};
use serde_json::{json, Value};

use crate::routers::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/marketplace/sources", get(sources).post(add_source))
        .route("/marketplace/sources/{id}", axum::routing::delete(delete_source))
        .route("/marketplace/sources/{id}", patch(patch_source))
        .route("/marketplace/sources/{id}/refresh", post(refresh_source))
        .route("/marketplace/plugins", get(catalog_plugins))
        .route(
            "/marketplace/plugins/{source}/{*path}",
            get(catalog_plugin_detail),
        )
}

fn deferred(name: &str) -> Value {
    json!({
        "ok": false,
        "error": format!("marketplace not implemented yet (Phase 4: {name})")
    })
}

async fn sources() -> Json<Value> {
    Json(json!([]))
}
async fn add_source() -> Json<Value> {
    Json(deferred("add_source"))
}
async fn delete_source(Path(_id): Path<String>) -> Json<Value> {
    Json(deferred("delete_source"))
}
async fn patch_source(Path(_id): Path<String>) -> Json<Value> {
    Json(json!({ "ok": true }))
}
async fn refresh_source(Path(_id): Path<String>) -> Json<Value> {
    Json(deferred("refresh"))
}
async fn catalog_plugins() -> Json<Value> {
    Json(json!([]))
}
async fn catalog_plugin_detail(Path((_s, _p)): Path<(String, String)>) -> Json<Value> {
    Json(deferred("plugin_detail"))
}
