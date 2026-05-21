//! `/api/plugins/*` — Phase-4 cut. install / uninstall use the real
//! installer foundation; enable / scope flip rows in a JSON-backed
//! state file (`~/.fleetify/plugin_state.json`) so the renderer's
//! Library tab toggles take effect end-to-end. Per-provider
//! materialization (writing into ~/.claude/, ~/.gemini/, ~/.codex/)
//! still rides on `services::plugins::materializers` and lands as
//! follow-up wiring once install/uninstall write DB rows.

use axum::extract::Path;
use axum::routing::{get, patch, post};
use axum::{Json, Router};
use serde::Deserialize;
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
    // doesn't make the whole Library tab go 500. The enabled flag +
    // scopes come from the plugin_state.json store (toggle persistence).
    //
    // Response shape matches the Python `list_installs` contract — the
    // manifest is NESTED under `manifest`, not flattened, because the
    // renderer's `PluginInstall` TS type reads `inst.manifest.declares.*`.
    // Flattening crashed the Library page on every entry.
    use crate::services::plugins::{manifest, state};
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
                let install_id = entry.file_name().to_string_lossy().to_string();
                let ps = state::get(&install_id);

                // Filesystem timestamps stand in for the DB-tracked
                // installed_at / last_updated_at the Python build used.
                let (installed_at, last_updated_at) = std::fs::metadata(&path)
                    .ok()
                    .map(|meta| {
                        let created = meta
                            .created()
                            .ok()
                            .map(chrono::DateTime::<chrono::Utc>::from);
                        let modified = meta
                            .modified()
                            .ok()
                            .map(chrono::DateTime::<chrono::Utc>::from);
                        (created, modified)
                    })
                    .unwrap_or((None, None));

                let plugin_name = m.name.clone();
                let version = m.version.clone();
                let manifest_v = serde_json::to_value(&m).unwrap_or(Value::Null);
                let enablements: Vec<Value> = ps
                    .scopes
                    .iter()
                    .map(|s| {
                        json!({
                            "scope_type": s.scope_type,
                            "scope_id": s.scope_id,
                            "enabled": s.enabled,
                        })
                    })
                    .collect();
                // Back-compat single-scope summary for callers that read
                // `scope` instead of iterating `enablements`.
                let scope_summary = ps
                    .scopes
                    .iter()
                    .find(|s| s.enabled)
                    .map(|s| s.scope_type.clone())
                    .unwrap_or_else(|| "user".to_string());

                out.push(json!({
                    "id": install_id,
                    "plugin_name": plugin_name,
                    "version": version,
                    "scope": scope_summary,
                    "master_enabled": ps.master_enabled,
                    "install_path": path.to_string_lossy(),
                    "installed_at": installed_at.as_ref().map(|t| t.to_rfc3339()),
                    "last_updated_at": last_updated_at.as_ref().map(|t| t.to_rfc3339()),
                    "manifest": manifest_v,
                    "enablements": enablements,
                }));
            }
            Err(e) => {
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
#[derive(Deserialize)]
struct EnabledBody {
    enabled: bool,
}

async fn set_enabled(
    Path(install_id): Path<String>,
    Json(b): Json<EnabledBody>,
) -> Json<Value> {
    match crate::services::plugins::state::set_master_enabled(&install_id, b.enabled) {
        Ok(_) => Json(json!({ "ok": true, "enabled": b.enabled })),
        Err(e) => Json(json!({ "ok": false, "error": e.to_string() })),
    }
}

#[derive(Deserialize)]
struct ScopeBody {
    scope_type: String,
    #[serde(default)]
    scope_id: Option<String>,
    #[serde(default = "default_true")]
    enabled: bool,
}
fn default_true() -> bool {
    true
}

async fn set_scope(
    Path(install_id): Path<String>,
    Json(b): Json<ScopeBody>,
) -> Json<Value> {
    let res = if b.enabled {
        crate::services::plugins::state::upsert_scope(
            &install_id,
            &b.scope_type,
            b.scope_id.as_deref(),
            true,
        )
    } else {
        crate::services::plugins::state::remove_scope(
            &install_id,
            &b.scope_type,
            b.scope_id.as_deref(),
        )
    };
    match res {
        Ok(_) => Json(json!({
            "ok": true,
            "scope_type": b.scope_type,
            "scope_id": b.scope_id,
            "enabled": b.enabled,
        })),
        Err(e) => Json(json!({ "ok": false, "error": e.to_string() })),
    }
}
