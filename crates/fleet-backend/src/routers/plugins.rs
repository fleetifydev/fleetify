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

#[derive(serde::Deserialize, Default)]
struct InstallBody {
    #[serde(default)]
    repo_url: String,
}

async fn list_installed() -> Json<Value> {
    // Scan ~/.fleetify/plugins/ for installed plugins and parse each
    // .fleetify-plugin/plugin.json. Best-effort: anything that fails
    // to parse logs + is omitted from the list so a single bad plugin
    // doesn't make the whole Library tab go 500.
    use crate::services::plugins::manifest;
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| ".".into());
    let plugins_dir = std::path::PathBuf::from(home)
        .join(".fleetify")
        .join("plugins");
    let Ok(rd) = std::fs::read_dir(&plugins_dir) else {
        return Json(Value::Array(Vec::new()));
    };
    let mut out: Vec<Value> = Vec::new();
    for entry in rd.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        match manifest::parse_plugin(&path) {
            Ok(m) => {
                // Renderer's installed-list shape: pluginManifest +
                // install_id (use the install dir name) + on-disk path.
                let install_id = entry
                    .file_name()
                    .to_string_lossy()
                    .to_string();
                let mut v = serde_json::to_value(&m).unwrap_or(Value::Null);
                if let Some(obj) = v.as_object_mut() {
                    obj.insert("install_id".into(), Value::String(install_id));
                    obj.insert(
                        "install_path".into(),
                        Value::String(path.to_string_lossy().into_owned()),
                    );
                    obj.insert("enabled".into(), Value::Bool(true));
                    obj.insert("scope".into(), Value::String("user".into()));
                }
                out.push(v);
            }
            Err(e) => {
                // Dropped to debug — old test artifacts (echo-tester,
                // runtime-test, …) under ~/.fleetify/plugins/ that
                // never had a manifest aren't errors, just clutter.
                // Real install failures surface during install_from_git
                // with a typed error envelope.
                tracing::debug!(
                    target: "plugins",
                    "skipping {}: {e}",
                    path.display()
                );
            }
        }
    }
    Json(Value::Array(out))
}
async fn install_unsupported() -> Json<Value> {
    Json(deferred("install"))
}
async fn install(Json(b): Json<InstallBody>) -> Json<Value> {
    if b.repo_url.trim().is_empty() {
        return Json(json!({ "ok": false, "error": "repo_url is required" }));
    }
    Json(crate::services::plugins::installer::install_and_envelope(b.repo_url.trim()).await)
}
async fn uninstall(Path(id): Path<String>) -> Json<Value> {
    match crate::services::plugins::installer::uninstall(&id) {
        Ok(_) => Json(json!({ "ok": true })),
        Err(e) => Json(json!({ "ok": false, "error": e.to_string() })),
    }
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
