//! `/api/plugins/*` — Phase-4 stubs. The full plugin foundation
//! (manifest parser, installer, registry DB rows, materializers,
//! component registries, runtime) is a substantial port (~3000 LOC
//! Python); here we surface every endpoint the renderer pings with
//! faithful-empty shapes + honest "not implemented" errors so the
//! Library / Marketplace / Settings pages render cleanly instead of
//! 404'ing while the real subsystem lands later.

use axum::extract::Path;
use axum::routing::{get, patch, post};
use axum::{Json, Router};
use serde_json::{json, Value};

use crate::routers::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/plugins", get(list_installed).post(install_unsupported))
        .route("/plugins/install", post(install))
        .route("/plugins/{install_id}/uninstall", post(uninstall))
        .route("/plugins/{install_id}/update/preview", get(update_preview))
        .route("/plugins/{install_id}/update", post(update))
        .route("/plugins/{install_id}", patch(patch_install))
        .route("/plugins/{install_id}/enabled", post(set_enabled))
        .route("/plugins/{install_id}/scope", post(set_scope))
}

fn deferred(name: &str) -> Value {
    json!({
        "ok": false,
        "error": format!("plugin foundation not implemented yet (Phase 4 follow-up: {name})")
    })
}

async fn list_installed() -> Json<Value> {
    Json(json!([]))
}
async fn install_unsupported() -> Json<Value> {
    Json(deferred("install"))
}
async fn install() -> Json<Value> {
    Json(deferred("install"))
}
async fn uninstall(Path(_id): Path<String>) -> Json<Value> {
    Json(deferred("uninstall"))
}
async fn update_preview(Path(_id): Path<String>) -> Json<Value> {
    Json(json!({
        "declares_changed": false,
        "secrets_changed": false,
        "version_changed": false
    }))
}
async fn update(Path(_id): Path<String>) -> Json<Value> {
    Json(deferred("update"))
}
async fn patch_install(Path(_id): Path<String>) -> Json<Value> {
    Json(json!({ "ok": true }))
}
async fn set_enabled(Path(_id): Path<String>) -> Json<Value> {
    Json(deferred("enable"))
}
async fn set_scope(Path(_id): Path<String>) -> Json<Value> {
    Json(deferred("scope"))
}
