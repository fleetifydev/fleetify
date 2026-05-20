//! `/api/marketplace/*` — Phase-4 cut. Source CRUD against the
//! `marketplace_sources` table is real; catalog (the cached listing
//! of every plugin across every enabled source) stays an honest stub
//! until the git-clone + manifest-walk pipeline lands.

use axum::extract::{Path, State};
use axum::routing::{get, patch, post};
use axum::{Json, Router};
use serde_json::{json, Value};

use crate::auth::AuthUser;
use crate::routers::{ApiError, AppState};

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

#[allow(dead_code)] // Retained for any new endpoints that haven't landed yet.
fn deferred(name: &str) -> Value {
    json!({
        "ok": false,
        "error": format!("marketplace not implemented yet (Phase 4: {name})")
    })
}

async fn sources(
    State(st): State<AppState>,
    AuthUser(user): AuthUser,
) -> Result<Json<Value>, ApiError> {
    // Most-recently-added first so a freshly-added source surfaces at
    // the top of the renderer's source list without further sorting.
    let rows: Vec<(String, String, Option<String>, String, i64, i64, String)> = sqlx::query_as(
        "SELECT id, name, description, repo_url, is_official, enabled, added_at \
         FROM marketplace_sources WHERE user_id = ? ORDER BY added_at DESC",
    )
    .bind(&user.id)
    .fetch_all(&st.auth.pool)
    .await?;
    let out: Vec<Value> = rows
        .into_iter()
        .map(|(id, name, desc, url, official, enabled, added)| {
            json!({
                "id": id,
                "name": name,
                "description": desc,
                "repo_url": url,
                "is_official": official != 0,
                "enabled": enabled != 0,
                "added_at": added,
            })
        })
        .collect();
    Ok(Json(Value::Array(out)))
}

#[derive(serde::Deserialize)]
struct AddSourceBody {
    name: String,
    repo_url: String,
    #[serde(default)]
    description: Option<String>,
}

async fn add_source(
    State(st): State<AppState>,
    AuthUser(user): AuthUser,
    Json(body): Json<AddSourceBody>,
) -> Result<Json<Value>, ApiError> {
    if body.name.trim().is_empty() {
        return Err(ApiError::BadRequest("name is required".into()));
    }
    if body.repo_url.trim().is_empty() {
        return Err(ApiError::BadRequest("repo_url is required".into()));
    }
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();
    // UNIQUE (user_id, repo_url) — surface a clean 409 if already added.
    let r = sqlx::query(
        "INSERT INTO marketplace_sources \
         (id, user_id, name, description, repo_url, is_official, enabled, added_at) \
         VALUES (?, ?, ?, ?, ?, 0, 1, ?)",
    )
    .bind(&id)
    .bind(&user.id)
    .bind(body.name.trim())
    .bind(body.description.as_deref())
    .bind(body.repo_url.trim())
    .bind(&now)
    .execute(&st.auth.pool)
    .await;
    if let Err(e) = r {
        let msg = e.to_string();
        if msg.contains("UNIQUE") || msg.contains("uq_msrc_user_url") {
            return Err(ApiError::Conflict(json!({
                "error": "source already added",
                "repo_url": body.repo_url,
            })));
        }
        return Err(ApiError::Internal(msg));
    }
    Ok(Json(json!({
        "id": id,
        "name": body.name,
        "repo_url": body.repo_url,
        "description": body.description,
        "is_official": false,
        "enabled": true,
        "added_at": now,
    })))
}

async fn delete_source(
    State(st): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let res = sqlx::query("DELETE FROM marketplace_sources WHERE id = ? AND user_id = ?")
        .bind(&id)
        .bind(&user.id)
        .execute(&st.auth.pool)
        .await?;
    if res.rows_affected() == 0 {
        return Err(ApiError::NotFound(format!("source {id} not found")));
    }
    Ok(Json(json!({ "ok": true })))
}

#[derive(serde::Deserialize, Default)]
struct PatchSourceBody {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    enabled: Option<bool>,
}

async fn patch_source(
    State(st): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<String>,
    Json(body): Json<PatchSourceBody>,
) -> Result<Json<Value>, ApiError> {
    if let Some(name) = body.name {
        sqlx::query("UPDATE marketplace_sources SET name = ? WHERE id = ? AND user_id = ?")
            .bind(name)
            .bind(&id)
            .bind(&user.id)
            .execute(&st.auth.pool)
            .await?;
    }
    if let Some(desc) = body.description {
        sqlx::query(
            "UPDATE marketplace_sources SET description = ? WHERE id = ? AND user_id = ?",
        )
        .bind(desc)
        .bind(&id)
        .bind(&user.id)
        .execute(&st.auth.pool)
        .await?;
    }
    if let Some(enabled) = body.enabled {
        sqlx::query("UPDATE marketplace_sources SET enabled = ? WHERE id = ? AND user_id = ?")
            .bind(if enabled { 1i64 } else { 0i64 })
            .bind(&id)
            .bind(&user.id)
            .execute(&st.auth.pool)
            .await?;
    }
    Ok(Json(json!({ "ok": true })))
}

async fn refresh_source(
    State(st): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    // Clone the source repo into the catalog cache and walk it for
    // marketplace.json / plugin.json manifests. Caller doesn't see
    // the resulting listings here — they pull them via
    // /marketplace/plugins.
    let row: Option<(String,)> = sqlx::query_as(
        "SELECT repo_url FROM marketplace_sources WHERE id = ? AND user_id = ?",
    )
    .bind(&id)
    .bind(&user.id)
    .fetch_optional(&st.auth.pool)
    .await?;
    let Some((repo_url,)) = row else {
        return Err(ApiError::NotFound(format!("source {id} not found")));
    };
    let dest = catalog_cache_dir().join(&id);
    let res = clone_or_pull(&repo_url, &dest).await;
    match res {
        Ok(_) => Ok(Json(json!({
            "ok": true,
            "refreshed_at": chrono::Utc::now().to_rfc3339(),
            "cache_path": dest.to_string_lossy(),
        }))),
        Err(e) => Ok(Json(json!({
            "ok": false,
            "error": format!("refresh failed: {e}"),
        }))),
    }
}
async fn catalog_plugins(
    State(st): State<AppState>,
    AuthUser(user): AuthUser,
) -> Result<Json<Value>, ApiError> {
    // Aggregate every enabled source's cached plugins. Each source's
    // clone lives at `<cache>/<source_id>/`; we walk it for either a
    // `marketplace.json` listing index or, when absent, treat the
    // repo itself as a single plugin.
    let rows: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT id, name, repo_url FROM marketplace_sources \
         WHERE user_id = ? AND enabled = 1",
    )
    .bind(&user.id)
    .fetch_all(&st.auth.pool)
    .await?;
    let cache = catalog_cache_dir();
    let mut out: Vec<Value> = Vec::new();
    for (sid, sname, _) in rows {
        let clone = cache.join(&sid);
        if !clone.is_dir() {
            // Source never refreshed → emit zero rows for it.
            continue;
        }
        use crate::services::plugins::manifest;
        if manifest::is_marketplace_repo(&clone) {
            if let Ok(mk) = manifest::parse_marketplace(&clone) {
                for entry in mk.plugins {
                    out.push(json!({
                        "source_id": sid,
                        "source_name": sname,
                        "name": entry.name,
                        "homepage": entry.homepage,
                        "description": entry.description,
                        "tags": entry.tags,
                        "author": entry.author,
                    }));
                }
                continue;
            }
        }
        // Fall back to "the repo itself IS the plugin" — common for
        // single-plugin git repos.
        if manifest::is_plugin_repo(&clone) {
            if let Ok(m) = manifest::parse_plugin(&clone) {
                let raw = serde_json::to_value(&m).unwrap_or(Value::Null);
                out.push(json!({
                    "source_id": sid,
                    "source_name": sname,
                    "name": m.name,
                    "version": m.version,
                    "display_name": m.display_name,
                    "description": m.description,
                    "tags": m.tags,
                    "provides": m.provides,
                    "manifest": raw,
                }));
            }
        }
    }
    Ok(Json(Value::Array(out)))
}

async fn catalog_plugin_detail(
    State(st): State<AppState>,
    AuthUser(user): AuthUser,
    Path((source_id, plugin_path)): Path<(String, String)>,
) -> Result<Json<Value>, ApiError> {
    let row: Option<(String,)> = sqlx::query_as(
        "SELECT id FROM marketplace_sources WHERE id = ? AND user_id = ?",
    )
    .bind(&source_id)
    .bind(&user.id)
    .fetch_optional(&st.auth.pool)
    .await?;
    if row.is_none() {
        return Err(ApiError::NotFound(format!("source {source_id} not found")));
    }
    // Reject traversal in the path segment.
    if plugin_path.contains("..") || plugin_path.starts_with('/') {
        return Err(ApiError::BadRequest("invalid plugin_path".into()));
    }
    let clone = catalog_cache_dir().join(&source_id);
    let plugin_dir = clone.join(&plugin_path);
    if !plugin_dir.is_dir() {
        return Err(ApiError::NotFound(format!(
            "plugin '{plugin_path}' not found in source {source_id}"
        )));
    }
    use crate::services::plugins::manifest;
    match manifest::parse_plugin(&plugin_dir) {
        Ok(m) => Ok(Json(serde_json::to_value(m).unwrap_or(Value::Null))),
        Err(e) => Err(ApiError::Internal(e.to_string())),
    }
}

fn catalog_cache_dir() -> std::path::PathBuf {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| ".".into());
    std::path::PathBuf::from(home)
        .join(".fleetify")
        .join("marketplace-cache")
}

/// Clone (when the dest doesn't exist) or pull (when it does). Best-
/// effort: any failure returns Err with the stderr trimmed.
async fn clone_or_pull(repo_url: &str, dest: &std::path::Path) -> Result<(), String> {
    use std::time::Duration;
    if dest.exists() {
        let out = tokio::time::timeout(
            Duration::from_secs(60),
            tokio::process::Command::new("git")
                .args(["pull", "--ff-only"])
                .current_dir(dest)
                .output(),
        )
        .await;
        match out {
            Ok(Ok(o)) if o.status.success() => Ok(()),
            Ok(Ok(o)) => Err(String::from_utf8_lossy(&o.stderr).trim().to_string()),
            Ok(Err(e)) => Err(e.to_string()),
            Err(_) => Err("git pull timed out".into()),
        }
    } else {
        if let Some(parent) = dest.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let out = tokio::time::timeout(
            Duration::from_secs(120),
            tokio::process::Command::new("git")
                .args([
                    "clone",
                    "--depth",
                    "1",
                    "--single-branch",
                    repo_url,
                    dest.to_str().unwrap_or(""),
                ])
                .output(),
        )
        .await;
        match out {
            Ok(Ok(o)) if o.status.success() => Ok(()),
            Ok(Ok(o)) => Err(String::from_utf8_lossy(&o.stderr).trim().to_string()),
            Ok(Err(e)) => Err(e.to_string()),
            Err(_) => Err("git clone timed out".into()),
        }
    }
}
