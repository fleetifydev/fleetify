use crate::routers::ApiError;

/// Append one message (role + JSON content-blocks) to a session. Mirrors the
/// chat persistence INSERT; used by the studio generate route to record a
/// generation turn (no bridge/WS involved).
pub async fn persist_studio_message(
    pool: &sqlx::SqlitePool,
    session_id: &str,
    role: &str,
    content: &serde_json::Value,
    cost_usd: f64,
) -> Result<(), ApiError> {
    sqlx::query(
        "INSERT INTO messages (id,session_id,role,content,cost_usd,timestamp) VALUES (?,?,?,?,?,?)",
    )
    .bind(uuid::Uuid::new_v4().to_string())
    .bind(session_id)
    .bind(role)
    .bind(content.to_string())
    .bind(cost_usd)
    .bind(chrono::Utc::now().to_rfc3339())
    .execute(pool)
    .await
    .map_err(|e| ApiError::Internal(format!("persist message: {e}")))?;
    Ok(())
}
