//! Loopback-only dispatch endpoint used by stdio MCP servers
//! (currently `fleet-dispatch-mcp`) to route a sub-task from one
//! fleet agent to another without going back to the user.
//!
//! Wire surface: `POST /api/internal/dispatch` with
//! `X-Fleet-Internal: <secret>` header (the secret is generated at
//! backend startup and injected into the MCP's env via
//! `ClaudeBridge::build_mcp_config`). JWT auth is skipped — the
//! secret is the only authenticator here, and the endpoint is
//! intentionally not in `/api` so missing config can't accidentally
//! expose it to a CORS-allowed renderer call.
//!
//! Faithful with the Python `dispatch_mcp.py` flow:
//!   1. Resolve `agent` (UUID or case-insensitive title) → session_id.
//!   2. Verify ownership (target.user_id == caller.user_id).
//!   3. Reject self-dispatch.
//!   4. Persist the task as a `user` message on the target.
//!   5. Spawn the target's bridge in the background (same path as
//!      the staff `[[DISPATCH:]]` token).
//!   6. Return `{ ok, target_session_id, task_dispatched }` to the MCP.

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::routing::post;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::models::session::Session;
use crate::routers::{ApiError, AppState};

pub fn router() -> Router<AppState> {
    // Mounted at `/api/internal` by `http::app`; this router just
    // adds the `/dispatch` leaf so the final path is
    // `POST /api/internal/dispatch`.
    Router::new().route("/dispatch", post(dispatch))
}

#[derive(Deserialize)]
struct DispatchBody {
    /// Caller session id (set from FLEETIFY_SESSION_ID on the MCP side).
    caller_session_id: String,
    /// Target agent — exact UUID or case-insensitive title.
    agent: String,
    /// Task body. The target sees it verbatim as a `user` message.
    task: String,
}

async fn dispatch(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(b): Json<DispatchBody>,
) -> Result<Json<Value>, ApiError> {
    // Auth: only the loopback secret. Constant-time string compare so a
    // timing attack against a known-prefix can't probe the secret.
    let presented = headers
        .get("x-fleet-internal")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if !constant_time_eq(presented.as_bytes(), st.internal_secret.as_bytes()) {
        return Err(ApiError::Forbidden("internal-secret mismatch".into()));
    }

    let caller = b.caller_session_id.trim();
    let agent_ref = b.agent.trim();
    let task = b.task.trim();
    if caller.is_empty() || agent_ref.is_empty() || task.is_empty() {
        return Err(ApiError::BadRequest(
            "caller_session_id, agent, and task are required".into(),
        ));
    }

    // Resolve caller for ownership scoping.
    let caller_row: Option<Session> =
        sqlx::query_as::<_, Session>("SELECT * FROM sessions WHERE id = ?")
            .bind(caller)
            .fetch_optional(&st.auth.pool)
            .await?;
    let Some(caller_row) = caller_row else {
        return Err(ApiError::NotFound(format!("caller session {caller} not found")));
    };

    // Resolve target by UUID first, then case-insensitive title. We
    // scope by the caller's user_id (when set) so a hallucinated id
    // can't route work to someone else's fleet.
    let lower_ref = agent_ref.to_lowercase();
    let candidates: Vec<Session> = match &caller_row.user_id {
        Some(uid) => sqlx::query_as::<_, Session>(
            "SELECT * FROM sessions WHERE user_id = ? AND archived_at IS NULL",
        )
        .bind(uid)
        .fetch_all(&st.auth.pool)
        .await?,
        None => sqlx::query_as::<_, Session>(
            "SELECT * FROM sessions WHERE archived_at IS NULL",
        )
        .fetch_all(&st.auth.pool)
        .await?,
    };
    let target = candidates.into_iter().find(|s| {
        s.id == agent_ref || s.title.to_lowercase() == lower_ref
    });
    let Some(target) = target else {
        return Err(ApiError::NotFound(format!("no session matches {agent_ref:?}")));
    };
    if target.id == caller {
        return Err(ApiError::BadRequest("cannot dispatch to self".into()));
    }

    // Persist the task on the target so the agent's own chat reads
    // like the user typed the task directly.
    let _ = sqlx::query(
        "INSERT INTO messages (id,session_id,role,content,cost_usd,timestamp) \
         VALUES (?,?,?,?,0.0,?)",
    )
    .bind(uuid::Uuid::new_v4().to_string())
    .bind(&target.id)
    .bind("user")
    .bind(json!([{"type":"text","text":task}]).to_string())
    .bind(chrono::Utc::now().to_rfc3339())
    .execute(&st.auth.pool)
    .await;

    // Spawn the target's bridge in the background. Same shape as the
    // staff [[DISPATCH:]] path so the result flows through the
    // SessionManager fanout + the dispatch_result system-message
    // backstop. The CALLER (not staff) is the "result destination"
    // here — when agent A dispatches to agent B, A's chat sees the
    // dispatch_result card.
    let pool = st.auth.pool.clone();
    let sm = st.sm;
    let caller_owned = caller.to_string();
    let target_owned = target.clone();
    let task_owned = task.to_string();
    let task_for_card = task.to_string();
    tokio::spawn(async move {
        crate::routers::chat::run_dispatched_task_internal(
            pool,
            sm,
            caller_owned,
            target_owned,
            task_owned,
            task_for_card,
        )
        .await;
    });

    Ok(Json(json!({
        "ok": true,
        "target_session_id": target.id,
        "task_dispatched": task,
    })))
}

/// Constant-time byte-slice equality. Tiny implementation — fine for
/// 32-byte secrets like the loopback token.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff: u8 = 0;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

#[allow(dead_code)]
fn _silence_unused_status_code(_: StatusCode) {}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::{AuthConfig, AuthState};
    use crate::db::init_pool;
    use axum::body::Body;
    use axum::http::Request;
    use std::sync::Arc;
    use tower::ServiceExt;

    async fn build_app(secret: &str) -> (axum::Router, sqlx::SqlitePool) {
        let pool = init_pool("sqlite::memory:").await.unwrap();
        // Insert two sessions owned by the same user so the ownership
        // scoping inside dispatch() resolves the target.
        for (id, title) in [
            ("aaaaaaaa-0000-0000-0000-000000000001", "Caller"),
            ("bbbbbbbb-0000-0000-0000-000000000002", "Backend Agent"),
        ] {
            sqlx::query(
                "INSERT INTO sessions \
                 (id,title,project_path,group_path,tool,command,status,\
                  use_worktree,permission_mode,session_mode,pinned,order_idx,\
                  budget_used,created_at,user_id) \
                 VALUES (?,?,?,'','claude','','idle',1,'default','new',0,0,0.0,?,?)",
            )
            .bind(id)
            .bind(title)
            .bind(format!("/tmp/{id}"))
            .bind(chrono::Utc::now().to_rfc3339())
            .bind("user-1")
            .execute(&pool)
            .await
            .unwrap();
        }
        let cfg = Arc::new(
            crate::config::AppConfig::load(None).expect("config/default.toml"),
        );
        let auth_cfg = Arc::new(AuthConfig::from_env());
        let jwks = crate::auth::default_jwks_cache(&auth_cfg.jwks_url);
        let state = AppState {
            auth: AuthState {
                pool: pool.clone(),
                cfg: auth_cfg,
                jwks,
            },
            app_cfg: cfg,
            sm: crate::session_manager::session_manager(),
            internal_secret: Arc::new(secret.to_string()),
        };
        let app = axum::Router::new()
            .nest("/api/internal", router())
            .with_state(state);
        (app, pool)
    }

    #[tokio::test]
    async fn dispatch_rejects_missing_or_wrong_secret() {
        let (app, _pool) = build_app("correct-secret").await;
        let req = Request::builder()
            .method("POST")
            .uri("/api/internal/dispatch")
            .header("content-type", "application/json")
            .body(Body::from(
                r#"{"caller_session_id":"aaaaaaaa-0000-0000-0000-000000000001",
                   "agent":"Backend Agent","task":"x"}"#,
            ))
            .unwrap();
        let resp = app.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), 403, "missing header must 403");

        let req = Request::builder()
            .method("POST")
            .uri("/api/internal/dispatch")
            .header("content-type", "application/json")
            .header("X-Fleet-Internal", "wrong")
            .body(Body::from(
                r#"{"caller_session_id":"aaaaaaaa-0000-0000-0000-000000000001",
                   "agent":"Backend Agent","task":"x"}"#,
            ))
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), 403, "wrong header must 403");
    }

    #[tokio::test]
    async fn dispatch_refuses_self_dispatch() {
        let (app, _pool) = build_app("s").await;
        let req = Request::builder()
            .method("POST")
            .uri("/api/internal/dispatch")
            .header("content-type", "application/json")
            .header("X-Fleet-Internal", "s")
            .body(Body::from(
                r#"{"caller_session_id":"aaaaaaaa-0000-0000-0000-000000000001",
                   "agent":"Caller","task":"loop"}"#,
            ))
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), 400);
    }

    #[tokio::test]
    async fn dispatch_persists_user_message_on_target_and_returns_session_id() {
        let (app, pool) = build_app("s").await;
        let req = Request::builder()
            .method("POST")
            .uri("/api/internal/dispatch")
            .header("content-type", "application/json")
            .header("X-Fleet-Internal", "s")
            .body(Body::from(
                r#"{"caller_session_id":"aaaaaaaa-0000-0000-0000-000000000001",
                   "agent":"Backend Agent","task":"do the thing"}"#,
            ))
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), 200);
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        let v: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(v["ok"], true);
        assert_eq!(v["target_session_id"], "bbbbbbbb-0000-0000-0000-000000000002");
        // User message landed on the target.
        let rows: Vec<(String, String)> = sqlx::query_as(
            "SELECT role, content FROM messages WHERE session_id = ?",
        )
        .bind("bbbbbbbb-0000-0000-0000-000000000002")
        .fetch_all(&pool)
        .await
        .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].0, "user");
        assert!(rows[0].1.contains("do the thing"));
    }

    #[tokio::test]
    async fn dispatch_returns_404_for_unknown_agent_ref() {
        let (app, _pool) = build_app("s").await;
        let req = Request::builder()
            .method("POST")
            .uri("/api/internal/dispatch")
            .header("content-type", "application/json")
            .header("X-Fleet-Internal", "s")
            .body(Body::from(
                r#"{"caller_session_id":"aaaaaaaa-0000-0000-0000-000000000001",
                   "agent":"NonexistentAgent","task":"x"}"#,
            ))
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), 404);
    }

    #[test]
    fn constant_time_eq_handles_length_mismatch_and_match() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"abcd"));
        assert!(constant_time_eq(b"", b""));
    }
}
