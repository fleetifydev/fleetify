//! Faithful port of `app/routers/messages.py` — paginated history with
//! cursor `before` (timestamp strictly older), DESC+reverse → chronological,
//! ownership enforced (legacy user_id NULL accessible).

use axum::extract::{Path, Query, State};
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;

use crate::auth::AuthUser;
use crate::models::message::Message;
use crate::models::session::Session;
use crate::routers::{ApiError, AppState};

pub fn router() -> Router<AppState> {
    Router::new().route("/sessions/{id}/messages", get(get_messages))
}

#[derive(Deserialize)]
struct MsgQ {
    #[serde(default = "default_limit")]
    limit: i64,
    before: Option<String>,
}
fn default_limit() -> i64 {
    50
}

async fn get_messages(
    State(st): State<AppState>,
    AuthUser(user): AuthUser,
    Path(session_id): Path<String>,
    Query(q): Query<MsgQ>,
) -> Result<Json<Vec<Message>>, ApiError> {
    let session = sqlx::query_as::<_, Session>("SELECT * FROM sessions WHERE id = ?")
        .bind(&session_id)
        .fetch_optional(&st.auth.pool)
        .await?
        .ok_or_else(|| ApiError::NotFound("Session not found".into()))?;
    if let Some(uid) = &session.user_id {
        if uid != &user.id {
            return Err(ApiError::Forbidden("Forbidden".into()));
        }
    }
    let limit = q.limit.clamp(1, 200);

    let mut rows = if let Some(before) = q.before.as_deref() {
        sqlx::query_as::<_, Message>(
            "SELECT * FROM messages WHERE session_id = ? AND timestamp < ? \
             ORDER BY timestamp DESC LIMIT ?",
        )
        .bind(&session_id)
        .bind(before)
        .bind(limit)
        .fetch_all(&st.auth.pool)
        .await?
    } else {
        sqlx::query_as::<_, Message>(
            "SELECT * FROM messages WHERE session_id = ? \
             ORDER BY timestamp DESC LIMIT ?",
        )
        .bind(&session_id)
        .bind(limit)
        .fetch_all(&st.auth.pool)
        .await?
    };
    rows.reverse(); // chronological (oldest → newest)
    Ok(Json(rows))
}
