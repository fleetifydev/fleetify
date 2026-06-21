//! `/api/user/memory` — CRUD for the user's personal memory (what Fleet knows
//! about them across all projects). Every query is scoped by the authenticated
//! `user.id` via the `AuthUser` extractor.

use axum::extract::{Path, Query, State};
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::auth::AuthUser;
use crate::routers::{ApiError, AppState};
use crate::services::user_memory;

pub fn router() -> Router<AppState> {
    Router::new().route(
        "/user/memory",
        get(list_memory).post(create_memory),
    )
    .route(
        "/user/memory/{id}",
        axum::routing::patch(update_memory).delete(delete_memory),
    )
}

#[derive(Deserialize)]
struct ListQuery {
    limit: Option<i64>,
}

async fn list_memory(
    State(st): State<AppState>,
    AuthUser(user): AuthUser,
    Query(q): Query<ListQuery>,
) -> Result<Json<Value>, ApiError> {
    let limit = q.limit.unwrap_or(200).clamp(1, 500);
    let rows = user_memory::list(&st.auth.pool, &user.id, limit)
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?;
    Ok(Json(json!(rows)))
}

#[derive(Deserialize)]
struct MemCreate {
    title: String,
    content: String,
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    importance: Option<i64>,
}

async fn create_memory(
    State(st): State<AppState>,
    AuthUser(user): AuthUser,
    Json(b): Json<MemCreate>,
) -> Result<Json<Value>, ApiError> {
    if b.title.trim().is_empty() || b.content.trim().is_empty() {
        return Err(ApiError::BadRequest(
            "title and content are required".into(),
        ));
    }
    let row = user_memory::create(
        &st.auth.pool,
        &user.id,
        b.kind.as_deref().unwrap_or("fact"),
        &b.title,
        &b.content,
        b.importance.unwrap_or(4),
        "explicit",
    )
    .await
    .map_err(|e| ApiError::Internal(e.to_string()))?;
    Ok(Json(json!(row)))
}

#[derive(Deserialize)]
struct MemUpdate {
    title: Option<String>,
    content: Option<String>,
    kind: Option<String>,
    importance: Option<i64>,
}

async fn update_memory(
    State(st): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<String>,
    Json(b): Json<MemUpdate>,
) -> Result<Json<Value>, ApiError> {
    let row = user_memory::update(
        &st.auth.pool,
        &user.id,
        &id,
        b.kind.as_deref(),
        b.title.as_deref(),
        b.content.as_deref(),
        b.importance,
    )
    .await
    .map_err(|e| ApiError::Internal(e.to_string()))?
    .ok_or_else(|| ApiError::NotFound("Memory item not found".into()))?;
    Ok(Json(json!(row)))
}

async fn delete_memory(
    State(st): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let ok = user_memory::delete(&st.auth.pool, &user.id, &id)
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?;
    if !ok {
        return Err(ApiError::NotFound("Memory item not found".into()));
    }
    Ok(Json(json!({ "ok": true })))
}
