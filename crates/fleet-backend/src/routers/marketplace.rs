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

async fn refresh_source(Path(_id): Path<String>) -> Json<Value> {
    // Clone+manifest-walk pipeline is Phase 4 follow-up; until then a
    // refresh is a no-op (the catalog endpoint is the only consumer
    // and it stays empty until the pipeline lands).
    Json(json!({ "ok": true, "refreshed_at": chrono::Utc::now().to_rfc3339() }))
}
async fn catalog_plugins() -> Json<Value> {
    Json(json!([]))
}
async fn catalog_plugin_detail(Path((_s, _p)): Path<(String, String)>) -> Json<Value> {
    Json(deferred("plugin_detail"))
}
