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
        .route(
            "/marketplace/sources/{id}",
            axum::routing::delete(delete_source),
        )
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

const OFFICIAL_SOURCE_REPO: &str = "https://github.com/fleetifydev/marketplace";
const OFFICIAL_SOURCE_NAME: &str = "Fleetify Official";
const OFFICIAL_SOURCE_DESC: &str = "Curated plugins by the Fleetify team.";

/// Seed the Fleetify Official marketplace for `user_id` if it isn't
/// present. Adopts a stale row pre-marked is_official=false. Faithful
/// with the Python `ensure_official_source`.
async fn ensure_official_source(pool: &sqlx::SqlitePool, user_id: &str) -> Result<(), sqlx::Error> {
    let existing: Option<(String, i64)> = sqlx::query_as(
        "SELECT id, is_official FROM marketplace_sources \
         WHERE user_id = ? AND repo_url = ?",
    )
    .bind(user_id)
    .bind(OFFICIAL_SOURCE_REPO)
    .fetch_optional(pool)
    .await?;
    if let Some((sid, is_off)) = existing {
        if is_off == 0 {
            sqlx::query(
                "UPDATE marketplace_sources SET is_official = 1, name = ?, description = ? \
                 WHERE id = ?",
            )
            .bind(OFFICIAL_SOURCE_NAME)
            .bind(OFFICIAL_SOURCE_DESC)
            .bind(&sid)
            .execute(pool)
            .await?;
        }
        return Ok(());
    }
    let new_id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();
    // UNIQUE(user_id, repo_url) — INSERT OR IGNORE handles the
    // concurrent-seed race (two requests racing on first sign-in).
    sqlx::query(
        "INSERT OR IGNORE INTO marketplace_sources \
         (id, user_id, name, description, repo_url, is_official, enabled, added_at) \
         VALUES (?, ?, ?, ?, ?, 1, 1, ?)",
    )
    .bind(&new_id)
    .bind(user_id)
    .bind(OFFICIAL_SOURCE_NAME)
    .bind(OFFICIAL_SOURCE_DESC)
    .bind(OFFICIAL_SOURCE_REPO)
    .bind(&now)
    .execute(pool)
    .await?;
    Ok(())
}

type MarketplaceSourceRow = (String, String, Option<String>, String, i64, i64, String);

async fn sources(
    State(st): State<AppState>,
    AuthUser(user): AuthUser,
) -> Result<Json<Value>, ApiError> {
    // Seed the Fleetify Official source on first hit so a brand-new user
    // doesn't see an empty Marketplace tab.
    let _ = ensure_official_source(&st.auth.pool, &user.id).await;
    // Most-recently-added first so a freshly-added source surfaces at
    // the top of the renderer's source list without further sorting.
    let rows: Vec<MarketplaceSourceRow> = sqlx::query_as(
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
        sqlx::query("UPDATE marketplace_sources SET description = ? WHERE id = ? AND user_id = ?")
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
    // Force-refetch the source's marketplace.json (or fall back to a
    // single-plugin manifest) via raw.githubusercontent.com. Caller
    // doesn't see the resulting listings here — they pull them via
    // /marketplace/plugins (which also reads the same 1h disk cache).
    let row: Option<(String,)> =
        sqlx::query_as("SELECT repo_url FROM marketplace_sources WHERE id = ? AND user_id = ?")
            .bind(&id)
            .bind(&user.id)
            .fetch_optional(&st.auth.pool)
            .await?;
    let Some((repo_url,)) = row else {
        return Err(ApiError::NotFound(format!("source {id} not found")));
    };
    use crate::services::plugins::marketplace_fetch;
    match marketplace_fetch::load_source(&id, &repo_url, /* force */ true).await {
        Ok(entries) => Ok(Json(json!({
            "ok": true,
            "refreshed_at": chrono::Utc::now().to_rfc3339(),
            "plugin_count": entries.len(),
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
    use crate::services::plugins::marketplace_fetch;
    // Same fresh-user seed as the sources endpoint — if the renderer
    // hits /plugins before /sources, we still get the official rows.
    let _ = ensure_official_source(&st.auth.pool, &user.id).await;
    let rows: Vec<(String, String, String, i64)> = sqlx::query_as(
        "SELECT id, name, repo_url, is_official FROM marketplace_sources \
         WHERE user_id = ? AND enabled = 1",
    )
    .bind(&user.id)
    .fetch_all(&st.auth.pool)
    .await?;
    tracing::info!(
        target: "fleetify.marketplace",
        "/catalog → {} enabled source(s) for user={}",
        rows.len(), user.id
    );

    // Concurrently load every enabled source. Failures don't kill the
    // whole catalog — a single bad source returns an empty list and we
    // surface the others.
    let futs: Vec<_> = rows
        .into_iter()
        .map(|(sid, sname, repo, is_official)| async move {
            let entries = marketplace_fetch::load_source(&sid, &repo, false)
                .await
                .unwrap_or_default();
            (sid, sname, is_official, entries)
        })
        .collect();
    let results = futures_util::future::join_all(futs).await;

    let mut out: Vec<Value> = Vec::new();
    for (sid, sname, is_official, entries) in results {
        for entry in entries {
            let Some(m) = entry.manifest.as_ref() else {
                continue;
            };
            let manifest_value = serde_json::to_value(m).unwrap_or(Value::Null);
            out.push(json!({
                "source_id": sid,
                "source_name": sname,
                "source_is_official": is_official != 0,
                "path": entry.path,
                "featured": entry.featured,
                "manifest": manifest_value,
                // Convenience flattened fields the renderer's card grid reads
                // directly to avoid deep manifest.* paths everywhere.
                "name": m.name,
                "display_name": m.display_name,
                "version": m.version,
                "description": m.description,
                "tags": m.tags,
                "provides": m.provides,
                "icon": m.icon,
            }));
        }
    }
    Ok(Json(Value::Array(out)))
}

async fn catalog_plugin_detail(
    State(st): State<AppState>,
    AuthUser(user): AuthUser,
    Path((source_id, plugin_path)): Path<(String, String)>,
) -> Result<Json<Value>, ApiError> {
    let row: Option<(String,)> =
        sqlx::query_as("SELECT repo_url FROM marketplace_sources WHERE id = ? AND user_id = ?")
            .bind(&source_id)
            .bind(&user.id)
            .fetch_optional(&st.auth.pool)
            .await?;
    let Some((repo_url,)) = row else {
        return Err(ApiError::NotFound(format!("source {source_id} not found")));
    };
    if plugin_path.contains("..") || plugin_path.starts_with('/') {
        return Err(ApiError::BadRequest("invalid plugin_path".into()));
    }
    use crate::services::plugins::marketplace_fetch;
    let entries = marketplace_fetch::load_source(&source_id, &repo_url, false)
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?;
    let entry = entries
        .into_iter()
        .find(|e| e.path == plugin_path)
        .ok_or_else(|| {
            ApiError::NotFound(format!(
                "plugin '{plugin_path}' not found in source {source_id}"
            ))
        })?;
    let manifest = entry
        .manifest
        .ok_or_else(|| ApiError::Internal("plugin manifest unavailable".into()))?;
    Ok(Json(serde_json::to_value(manifest).unwrap_or(Value::Null)))
}
