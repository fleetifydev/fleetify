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
        .route("/plugins/{install_id}/update", post(update))
        .route("/plugins/{install_id}", patch(patch_install))
        .route("/plugins/{install_id}/enabled", post(set_enabled))
        .route("/plugins/{install_id}/scope", post(set_scope))
        .route(
            "/plugins/{install_id}/secrets",
            get(secrets_get).put(secrets_put),
        )
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
    // Parse first, then inline every icon in one concurrent pass — the
    // WebView cannot load the remote icon URLs itself (see `icons`).
    let mut parsed: Vec<_> = rd
        .flatten()
        .filter(|entry| entry.path().is_dir())
        .map(|entry| {
            let result = manifest::parse_plugin(&entry.path());
            (entry, result)
        })
        .collect();
    let mut manifests: Vec<_> = parsed
        .iter_mut()
        .filter_map(|(_, result)| result.as_mut().ok())
        .collect();
    crate::services::plugins::icons::inline_all(&mut manifests).await;

    let mut out: Vec<Value> = Vec::new();
    for (entry, result) in parsed {
        let path = entry.path();
        match result {
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
                    "auto_update": ps.auto_update,
                    "commit_sha": "",
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
/// Resolve the recorded marketplace source for an installed plugin.
/// Errors if the install dir is missing/escaping or the plugin has no
/// recorded provenance (e.g. a pre-provenance install) — there's no
/// `source_id` to look up a clone URL for, so an update is impossible.
fn update_source_for(id: &str) -> Result<(String, String), ApiError> {
    let _dir = install_dir(id)?; // path-escape + existence guard
    let ps = crate::services::plugins::state::get(id);
    let source_id = ps.source_id.ok_or_else(|| {
        ApiError::BadRequest(format!(
            "{id}: no marketplace source recorded — reinstall to enable updates"
        ))
    })?;
    Ok((source_id, ps.plugin_path.unwrap_or_default()))
}

async fn update(
    State(st): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    // Resolve the install's recorded provenance, then re-resolve the source
    // row to its clone URL — scoped to the caller, the same lookup `install`
    // uses. update_from_git then re-clones + re-materializes in place.
    let (source_id, plugin_path) = update_source_for(&id)?;
    let row: Option<(String,)> =
        sqlx::query_as("SELECT repo_url FROM marketplace_sources WHERE id = ? AND user_id = ?")
            .bind(&source_id)
            .bind(&user.id)
            .fetch_optional(&st.auth.pool)
            .await?;
    let Some((repo_url,)) = row else {
        return Err(ApiError::NotFound(format!("source {source_id} not found")));
    };
    let result = crate::services::plugins::installer::update_from_git(&id, &repo_url, &plugin_path)
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?;
    let version = result
        .manifest
        .get("version")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    Ok(Json(json!({
        "ok": true,
        "plugin_name": result.install_id,
        "version": version,
    })))
}
#[derive(Deserialize)]
struct PatchInstallBody {
    auto_update: Option<bool>,
}

async fn patch_install(Path(id): Path<String>, Json(b): Json<PatchInstallBody>) -> Json<Value> {
    if let Some(v) = b.auto_update {
        if let Err(e) = crate::services::plugins::state::set_auto_update(&id, v) {
            return Json(json!({ "ok": false, "error": e.to_string() }));
        }
    }
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

#[derive(Deserialize)]
struct SecretsBody {
    #[serde(default)]
    secrets: std::collections::BTreeMap<String, String>,
}

/// Resolve an install dir from an id, rejecting path-escape attempts and
/// missing installs. Returns the plugin dir under `<home>/plugins/<id>`.
fn install_dir(id: &str) -> Result<std::path::PathBuf, ApiError> {
    if id.is_empty() || id.contains('/') || id.contains('\\') || id.contains("..") {
        return Err(ApiError::BadRequest(format!("invalid plugin id {id:?}")));
    }
    let dir = fleetify_core::fleetify_home().join("plugins").join(id);
    if !dir.is_dir() {
        return Err(ApiError::NotFound(format!("plugin {id} not installed")));
    }
    Ok(dir)
}

/// Declared secrets enriched with set-status (NO values). Source of truth
/// for the editor.
fn secret_status_list(id: &str) -> Result<Value, ApiError> {
    use crate::services::plugins::{manifest, plugin_secrets};
    let dir = install_dir(id)?;
    let m = manifest::parse_plugin(&dir).map_err(|e| ApiError::Internal(e.to_string()))?;
    let keys: Vec<String> = m.requires_secrets.iter().map(|s| s.key.clone()).collect();
    let home = fleetify_core::fleetify_home();
    let set: std::collections::BTreeMap<String, bool> = plugin_secrets::status(&home, id, &keys)
        .into_iter()
        .collect();
    let items: Vec<Value> = m
        .requires_secrets
        .iter()
        .map(|s| {
            json!({
                "key": s.key,
                "label": s.label,
                "url": s.url,
                "set": set.get(&s.key).copied().unwrap_or(false),
            })
        })
        .collect();
    Ok(json!({ "secrets": items }))
}

async fn secrets_get(Path(id): Path<String>) -> Result<Json<Value>, ApiError> {
    Ok(Json(secret_status_list(&id)?))
}

async fn secrets_put(
    Path(id): Path<String>,
    Json(b): Json<SecretsBody>,
) -> Result<Json<Value>, ApiError> {
    use crate::services::plugins::{mcp_materialize, plugin_secrets};
    let dir = install_dir(&id)?;
    let home = fleetify_core::fleetify_home();
    plugin_secrets::merge(&home, &id, &b.secrets).map_err(ApiError::Internal)?;
    // Re-apply the full (updated) secret map into the registry so the
    // plugin's MCP servers pick up the new values on next spawn.
    mcp_materialize::rematerialize_mcp(&dir, &plugin_secrets::get(&home, &id));
    Ok(Json(secret_status_list(&id)?))
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

    fn write_install(home: &std::path::Path, id: &str, requires: &str) {
        let pdir = home.join("plugins").join(id).join(".fleetify-plugin");
        std::fs::create_dir_all(&pdir).unwrap();
        std::fs::write(
            pdir.join("plugin.json"),
            format!(
                r#"{{ "name": "{id}", "version": "0.1.0", "providers": ["claude-code"],
                    "requires_secrets": {requires}, "declares": {{ "mcp_servers": 0,
                    "templates": 0, "workflows": 0, "prompts": 0, "providers": {{}} }} }}"#
            ),
        )
        .unwrap();
    }

    #[test]
    fn secret_status_reports_set_without_values() {
        let _g = crate::test_support::home_lock()
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let dir = tempfile::tempdir().unwrap();
        std::env::set_var("FLEETIFY_HOME", dir.path());
        write_install(
            dir.path(),
            "p",
            r#"[{"key":"A","label":"Token A"},{"key":"B","label":"Token B"}]"#,
        );
        let v = secret_status_list("p").unwrap();
        let arr = v["secrets"].as_array().unwrap();
        assert_eq!(arr.len(), 2);
        assert_eq!(arr[0]["key"], "A");
        assert_eq!(arr[0]["set"], false);
        let mut patch = std::collections::BTreeMap::new();
        patch.insert("A".to_string(), "secret-val".to_string());
        crate::services::plugins::plugin_secrets::merge(dir.path(), "p", &patch).unwrap();
        let v = secret_status_list("p").unwrap();
        let arr = v["secrets"].as_array().unwrap();
        assert_eq!(arr[0]["set"], true);
        assert_eq!(arr[1]["set"], false);
        assert!(arr[0].get("value").is_none(), "must never return values");
        assert!(!serde_json::to_string(&v).unwrap().contains("secret-val"));
        std::env::remove_var("FLEETIFY_HOME");
    }

    #[test]
    fn install_dir_rejects_escape_and_missing() {
        let _g = crate::test_support::home_lock()
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let dir = tempfile::tempdir().unwrap();
        std::env::set_var("FLEETIFY_HOME", dir.path());
        assert!(matches!(install_dir("../x"), Err(ApiError::BadRequest(_))));
        assert!(matches!(install_dir("ghost"), Err(ApiError::NotFound(_))));
        std::env::remove_var("FLEETIFY_HOME");
    }

    #[test]
    fn update_rejects_install_without_source() {
        // An install with no recorded marketplace provenance can't be
        // updated — there's no source_id to resolve to a repo_url. The
        // helper must reject it with a 400, not silently proceed. (write_install
        // creates the dir + plugin.json but never writes a plugin_state.json
        // origin, so state::get(id).source_id == None.)
        let _g = crate::test_support::home_lock()
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let dir = tempfile::tempdir().unwrap();
        std::env::set_var("FLEETIFY_HOME", dir.path());
        write_install(dir.path(), "p", "[]");
        let err = update_source_for("p").unwrap_err();
        assert!(matches!(err, ApiError::BadRequest(_)));
        std::env::remove_var("FLEETIFY_HOME");
    }

    #[test]
    fn patch_install_persists_auto_update() {
        let _g = crate::test_support::home_lock()
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let dir = tempfile::tempdir().unwrap();
        std::env::set_var("FLEETIFY_HOME", dir.path());
        // default on
        assert!(crate::services::plugins::state::get("p").auto_update);
        crate::services::plugins::state::set_auto_update("p", false).unwrap();
        assert!(!crate::services::plugins::state::get("p").auto_update);
        std::env::remove_var("FLEETIFY_HOME");
    }

    #[test]
    fn list_installed_emits_auto_update_and_commit_sha() {
        let _g = crate::test_support::home_lock()
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let dir = tempfile::tempdir().unwrap();
        std::env::set_var("FLEETIFY_HOME", dir.path());
        write_install(dir.path(), "p", "[]");
        // Opt this install out of auto-update; the emitted JSON must reflect it.
        crate::services::plugins::state::set_auto_update("p", false).unwrap();

        // `list_installed` is async but does only synchronous fs work; drive it
        // on a current-thread runtime so we keep FLEETIFY_HOME isolated for the
        // whole read without holding the std Mutex guard across a `.await`.
        let Json(v) = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap()
            .block_on(list_installed());
        let arr = v.as_array().expect("list_installed returns a JSON array");
        let row = arr
            .iter()
            .find(|r| r["id"] == "p")
            .expect("installed plugin p present in list");
        assert_eq!(
            row["auto_update"], false,
            "auto_update opt-out must be emitted"
        );
        assert_eq!(row["commit_sha"], "", "commit_sha must be an empty string");

        std::env::remove_var("FLEETIFY_HOME");
    }
}
