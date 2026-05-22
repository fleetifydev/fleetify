//! Faithful port of `app/routers/groups.py`. CRUD on the `groups` table
//! (no per-user scope — original is global; the React sidebar's group
//! tree relies on this exact shape).

use axum::extract::{Path, State};
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::models::session::{Group, GroupCreate};
use crate::routers::{ApiError, AppState};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/groups", get(list_groups).post(create_group))
        .route("/groups/{*path}", axum::routing::delete(delete_group))
}

async fn list_groups(State(st): State<AppState>) -> Result<Json<Vec<Group>>, ApiError> {
    let rows = sqlx::query_as::<_, Group>("SELECT * FROM groups ORDER BY order_idx")
        .fetch_all(&st.auth.pool)
        .await?;
    Ok(Json(rows))
}

#[derive(Deserialize)]
struct GroupBody {
    path: String,
    name: String,
    #[serde(default)]
    parent_path: Option<String>,
}

async fn create_group(
    State(st): State<AppState>,
    Json(b): Json<GroupBody>,
) -> Result<Json<Group>, ApiError> {
    let exists: Option<(String,)> = sqlx::query_as("SELECT path FROM groups WHERE path = ?")
        .bind(&b.path)
        .fetch_optional(&st.auth.pool)
        .await?;
    if exists.is_some() {
        return Err(ApiError::Conflict(
            json!({ "detail": "Group already exists" }),
        ));
    }
    sqlx::query(
        "INSERT INTO groups (path, name, parent_path, order_idx) \
         VALUES (?, ?, ?, 0)",
    )
    .bind(&b.path)
    .bind(&b.name)
    .bind(&b.parent_path)
    .execute(&st.auth.pool)
    .await?;
    let row = sqlx::query_as::<_, Group>("SELECT * FROM groups WHERE path = ?")
        .bind(&b.path)
        .fetch_one(&st.auth.pool)
        .await?;
    Ok(Json(row))
}

async fn delete_group(
    State(st): State<AppState>,
    Path(path): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let res = sqlx::query("DELETE FROM groups WHERE path = ?")
        .bind(&path)
        .execute(&st.auth.pool)
        .await?;
    if res.rows_affected() == 0 {
        return Err(ApiError::NotFound("Group not found".into()));
    }
    Ok(Json(json!({ "ok": true })))
}

// `GroupCreate` is referenced by the imports — keep the symbol so future
// re-uses don't accidentally drift from the wire shape.
#[allow(dead_code)]
fn _shape_check(_: GroupCreate) {}
