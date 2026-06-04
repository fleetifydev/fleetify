//! `/api/plugins/*` — Phase-4 cut. install / uninstall use the real
//! installer foundation; enable / scope flip rows in a JSON-backed
//! state file (`~/.fleetify/plugin_state.json`) so the renderer's
//! Library tab toggles take effect end-to-end. Per-provider
//! materialization (writing into ~/.claude/, ~/.gemini/, ~/.codex/)
//! still rides on `services::plugins::materializers` and lands as
//! follow-up wiring once install/uninstall write DB rows.

use axum::extract::{Path, State};
use axum::routing::{get, patch, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::auth::AuthUser;
use crate::routers::{ApiError, AppState};

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

#[derive(Deserialize)]
struct ScopeReq {
    scope_type: String,
    #[serde(default)]
    scope_id: Option<String>,
}

/// Marketplace install request from the renderer's InstallDialog. The
/// plugin is addressed by `(source_id, plugin_path)` — the source row
/// holds the clone URL, the path locates the plugin within it — NOT a raw
/// repo URL. `scope` is the first enablement to apply; `secrets` resolve
/// `${secret:KEY}` placeholders in the plugin's mcp.json.
#[derive(Deserialize)]
struct InstallBody {
    source_id: String,
    #[serde(default)]
    plugin_path: String,
    scope: ScopeReq,
    #[serde(default)]
    secrets: std::collections::BTreeMap<String, String>,
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
    // Resolve the plugins dir via the same FLEETIFY_HOME-aware helper the
    // installer writes through — a hardcoded ~/.fleetify here would hide
    // every install made by a dev:tauri:wt / FLEETIFY_HOME instance.
    let plugins_dir = fleetify_core::fleetify_home().join("plugins");
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
                    // Marketplace provenance (None for pre-provenance installs)
                    // so the Installed tab can route to the plugin's detail.
                    "source_id": ps.source_id,
                    "plugin_path": ps.plugin_path,
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
async fn install(
    State(st): State<AppState>,
    AuthUser(user): AuthUser,
    Json(b): Json<InstallBody>,
) -> Result<Json<Value>, ApiError> {
    use crate::services::plugins::{installer, state};

    // Resolve the source's clone URL, scoped to the caller — the same
    // lookup the marketplace detail endpoint uses.
    let row: Option<(String,)> =
        sqlx::query_as("SELECT repo_url FROM marketplace_sources WHERE id = ? AND user_id = ?")
            .bind(&b.source_id)
            .bind(&user.id)
            .fetch_optional(&st.auth.pool)
            .await?;
    let Some((repo_url,)) = row else {
        return Err(ApiError::NotFound(format!(
            "source {} not found",
            b.source_id
        )));
    };

    // Clone + place + materialize the specific plugin. Errors surface as
    // real HTTP codes so the renderer's install dialog shows them — the
    // old handler returned 200-with-`ok:false`, which the client read as a
    // silent success and closed the modal without installing anything.
    let result = installer::install_from_git(&repo_url, b.plugin_path.trim(), &b.secrets)
        .await
        .map_err(|e| match e {
            installer::InstallError::AlreadyInstalled(name) => ApiError::Conflict(json!({
                "error": format!("{name} is already installed"),
                "plugin": name,
            })),
            other => ApiError::Internal(other.to_string()),
        })?;

    // Record the chosen scope so the plugin lands enabled for it right
    // away (master_enabled defaults true). A persist hiccup is non-fatal —
    // the plugin is already on disk — so we log and still report success.
    let scope_id = b.scope.scope_id.as_deref().filter(|s| !s.is_empty());
    if let Err(e) = state::upsert_scope(&result.install_id, &b.scope.scope_type, scope_id, true) {
        tracing::warn!(
            target: "plugins",
            "install scope persist failed for {}: {e}",
            result.install_id
        );
    }
    // Record where it came from so the Installed tab can route back to the
    // plugin's marketplace detail (and a future update can re-fetch it).
    if let Err(e) = state::set_origin(&result.install_id, &b.source_id, b.plugin_path.trim()) {
        tracing::warn!(
            target: "plugins",
            "install origin persist failed for {}: {e}",
            result.install_id
        );
    }

    let version = result
        .manifest
        .get("version")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    Ok(Json(json!({
        "install_id": result.install_id,
        "plugin_name": result.install_id,
        "version": version,
        "install_path": result.install_path,
    })))
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

async fn set_enabled(Path(install_id): Path<String>, Json(b): Json<EnabledBody>) -> Json<Value> {
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

async fn set_scope(Path(install_id): Path<String>, Json(b): Json<ScopeBody>) -> Json<Value> {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn install_body_parses_marketplace_payload() {
        // The exact shape the renderer's InstallDialog POSTs. The old
        // handler read `{ repo_url }` and silently no-op'd on this body
        // (repo_url defaulted empty → "repo_url is required" at HTTP 200).
        let v = json!({
            "source_id": "s1",
            "plugin_path": "plugins/diff-summarizer",
            "scope": { "scope_type": "user", "scope_id": null },
            "secrets": { "GITHUB_TOKEN": "x" }
        });
        let b: InstallBody = serde_json::from_value(v).unwrap();
        assert_eq!(b.source_id, "s1");
        assert_eq!(b.plugin_path, "plugins/diff-summarizer");
        assert_eq!(b.scope.scope_type, "user");
        assert_eq!(b.scope.scope_id, None);
        assert_eq!(b.secrets.get("GITHUB_TOKEN").map(String::as_str), Some("x"));
    }

    #[test]
    fn install_body_defaults_optional_fields() {
        // Project scope, no secrets, omitted plugin_path (root repo).
        let v = json!({
            "source_id": "s2",
            "scope": { "scope_type": "project", "scope_id": "/home/me/proj" }
        });
        let b: InstallBody = serde_json::from_value(v).unwrap();
        assert_eq!(b.plugin_path, "");
        assert!(b.secrets.is_empty());
        assert_eq!(b.scope.scope_id.as_deref(), Some("/home/me/proj"));
    }

    #[test]
    fn install_body_requires_source_and_scope() {
        // Missing source_id or scope is a hard parse error — the contract
        // the renderer must satisfy, not a silently-defaulted field.
        assert!(serde_json::from_value::<InstallBody>(json!({
            "scope": { "scope_type": "user" }
        }))
        .is_err());
        assert!(serde_json::from_value::<InstallBody>(json!({ "source_id": "s1" })).is_err());
    }
}
