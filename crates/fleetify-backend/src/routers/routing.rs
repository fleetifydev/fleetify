//! `/api/routing/*` — read-only routing surface for the Fleet right
//! sidebar. `GET /api/routing/summary` snapshots the orchestrator's live
//! state and aggregates `routing_decisions` over a trailing 24 h window.
//! Read-only by design: the Auto/Routers boundary (docs/ROUTING.md §4)
//! is never touched from here.

use axum::extract::State;
use axum::routing::get;
use axum::{Json, Router};
use serde_json::{json, Value};
use sqlx::{Row, SqlitePool};

use crate::auth::AuthUser;
use crate::routers::{ApiError, AppState};
use crate::services::routing::orchestrator::RoutingStatus;

const WINDOW_SECS: i64 = 86_400;

pub fn router() -> Router<AppState> {
    Router::new().route("/routing/summary", get(summary))
}

/// `GET /api/routing/summary` — thin wrapper: real clock + caller
/// identity + live orchestrator snapshot into `summary_payload`.
async fn summary(
    State(st): State<AppState>,
    AuthUser(user): AuthUser,
) -> Result<Json<serde_json::Value>, ApiError> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let payload = summary_payload(&st.auth.pool, st.routing.status(), &user.id, now)
        .await
        .map_err(ApiError::from)?;
    Ok(Json(payload))
}

/// Aggregation core, split from the axum handler so tests can call it
/// with a seeded pool and a fixed `now_secs`.
///
/// Ownership scoping: chat-flow rows (`task_ref` = session id) are
/// LEFT JOINed against `sessions` and kept only when a session row was
/// actually matched (`s.id IS NOT NULL`) AND it belongs to `user_id` — or
/// has a NULL `user_id`, which (matching the sessions-router convention,
/// see `routers/sessions.rs`) counts as claimable by/belonging to the
/// caller. The `s.id IS NOT NULL` guard matters because it's a LEFT JOIN:
/// without it, an orphaned decision (`task_ref` pointing at a
/// hard-deleted session — `hard_delete_session` in `routers/sessions.rs`
/// deletes the session row but not its `routing_decisions`) would also
/// produce `s.user_id IS NULL` and leak into every caller's totals/recent.
/// Dispatch rows (`task_ref` = dispatch task id, no session to join) are
/// included as-is — on this single-user local backend they are the
/// caller's own dispatches.
async fn summary_payload(
    pool: &SqlitePool,
    status: RoutingStatus,
    user_id: &str,
    now_secs: i64,
) -> Result<Value, sqlx::Error> {
    let cutoff = now_secs - WINDOW_SECS;

    let agg = sqlx::query(
        "SELECT COUNT(*) AS decisions, \
                COALESCE(SUM(rd.fallback_used), 0) AS fallbacks, \
                CAST(COALESCE(AVG(rd.latency_ms), 0) AS INTEGER) AS avg_latency_ms, \
                MAX(rd.ts) AS last_ts \
         FROM routing_decisions rd \
         LEFT JOIN sessions s ON rd.task_flow = 'chat' AND rd.task_ref = s.id \
         WHERE rd.ts >= ? AND (rd.task_flow != 'chat' OR (s.id IS NOT NULL AND (s.user_id = ? OR s.user_id IS NULL)))",
    )
    .bind(cutoff)
    .bind(user_id)
    .fetch_one(pool)
    .await?;
    let decisions: i64 = agg.try_get("decisions")?;
    let fallbacks: i64 = agg.try_get("fallbacks")?;
    let avg_latency_ms: i64 = agg.try_get("avg_latency_ms")?;
    let last_ts: Option<i64> = agg.try_get("last_ts")?;

    let recent_rows = sqlx::query(
        "SELECT rd.ts, rd.agent, rd.model, rd.source, rd.fallback_used, rd.task_flow \
         FROM routing_decisions rd \
         LEFT JOIN sessions s ON rd.task_flow = 'chat' AND rd.task_ref = s.id \
         WHERE rd.ts >= ? AND (rd.task_flow != 'chat' OR (s.id IS NOT NULL AND (s.user_id = ? OR s.user_id IS NULL))) \
         ORDER BY rd.ts DESC LIMIT 5",
    )
    .bind(cutoff)
    .bind(user_id)
    .fetch_all(pool)
    .await?;
    let recent: Vec<Value> = recent_rows
        .iter()
        .map(|r| {
            Ok(json!({
                "ts": r.try_get::<i64, _>("ts")?,
                "agent": r.try_get::<String, _>("agent")?,
                "model": r.try_get::<String, _>("model")?,
                "source": r.try_get::<String, _>("source")?,
                "fallback_used": r.try_get::<i64, _>("fallback_used")? != 0,
                "task_flow": r.try_get::<String, _>("task_flow")?,
            }))
        })
        .collect::<Result<_, sqlx::Error>>()?;

    let routed_session_ids: Vec<String> = sqlx::query_scalar(
        "SELECT DISTINCT rd.task_ref \
         FROM routing_decisions rd \
         JOIN sessions s ON rd.task_ref = s.id \
         WHERE rd.task_flow = 'chat' AND rd.ts >= ? AND (s.user_id = ? OR s.user_id IS NULL)",
    )
    .bind(cutoff)
    .bind(user_id)
    .fetch_all(pool)
    .await?;

    Ok(json!({
        "enabled": status.enabled,
        "active_decision_router": {
            "id": status.decision_id, "display_name": status.decision_name,
        },
        "active_proxy_gateway": {
            "id": status.proxy_id, "display_name": status.proxy_name,
        },
        "totals_24h": {
            "decisions": decisions,
            "fallbacks": fallbacks,
            "avg_latency_ms": avg_latency_ms,
            "last_decision_ts": last_ts,
        },
        "last_decision": recent.first().cloned().unwrap_or(Value::Null),
        "recent": recent,
        "routed_session_ids": routed_session_ids,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::routing::persist::insert_routing_decision;

    const NOW: i64 = 1_800_000_000;

    fn empty_status() -> RoutingStatus {
        RoutingStatus {
            enabled: false,
            decision_id: "builtin".into(),
            decision_name: "Built-in".into(),
            proxy_id: "none-proxy".into(),
            proxy_name: "None / Direct".into(),
        }
    }

    async fn seed_session(pool: &SqlitePool, id: &str, user_id: &str) {
        sqlx::query(
            "INSERT INTO sessions (id, title, tool, command, created_at, user_id) \
             VALUES (?, 'T', 'claude-code', '', '2026-08-07T00:00:00Z', ?)",
        )
        .bind(id)
        .bind(user_id)
        .execute(pool)
        .await
        .expect("seed session");
    }

    /// Seeds a session with a NULL `user_id` — mirrors sessions created
    /// before per-user ownership was introduced. Per the sessions-router
    /// convention, these are claimable-by/count as the caller's.
    async fn seed_session_no_user(pool: &SqlitePool, id: &str) {
        sqlx::query(
            "INSERT INTO sessions (id, title, tool, command, created_at, user_id) \
             VALUES (?, 'T', 'claude-code', '', '2026-08-07T00:00:00Z', ?)",
        )
        .bind(id)
        .bind(Option::<String>::None)
        .execute(pool)
        .await
        .expect("seed session (no user)");
    }

    #[allow(clippy::too_many_arguments)]
    async fn seed_decision(
        pool: &SqlitePool,
        id: &str,
        ts: i64,
        task_flow: &str,
        task_ref: &str,
        source: &str,
        fallback: bool,
        latency_ms: i64,
    ) {
        insert_routing_decision(
            pool,
            id,
            task_flow,
            Some(task_ref),
            "claude-code",
            "claude-sonnet-4-6",
            source,
            "test",
            latency_ms,
            fallback,
            None,
            "[]",
            ts,
        )
        .await
        .expect("seed decision");
    }

    #[tokio::test]
    async fn empty_db_returns_zeroes_and_nulls() {
        let pool = crate::db::init_pool("sqlite::memory:").await.unwrap();
        let v = summary_payload(&pool, empty_status(), "user-a", NOW)
            .await
            .unwrap();
        assert_eq!(v["enabled"], false);
        assert_eq!(v["active_decision_router"]["id"], "builtin");
        assert_eq!(v["totals_24h"]["decisions"], 0);
        assert_eq!(v["totals_24h"]["fallbacks"], 0);
        assert!(v["totals_24h"]["last_decision_ts"].is_null());
        assert!(v["last_decision"].is_null());
        assert_eq!(v["recent"].as_array().unwrap().len(), 0);
        assert_eq!(v["routed_session_ids"].as_array().unwrap().len(), 0);
    }

    #[tokio::test]
    async fn window_scoping_and_aggregates() {
        let pool = crate::db::init_pool("sqlite::memory:").await.unwrap();
        seed_session(&pool, "sa", "user-a").await;
        seed_session(&pool, "sb", "user-b").await;
        // NULL user_id — pre-ownership session; counts as the caller's,
        // matching the sessions-router `(user_id = ? OR user_id IS NULL)`
        // convention.
        seed_session_no_user(&pool, "sc").await;

        // In-window, user A's session, notdiamond, 300 ms.
        seed_decision(
            &pool,
            "d1",
            NOW - 100,
            "chat",
            "sa",
            "notdiamond",
            false,
            300,
        )
        .await;
        // OUTSIDE the 24 h window — must be excluded.
        seed_decision(
            &pool,
            "d2",
            NOW - 90_000,
            "chat",
            "sa",
            "notdiamond",
            false,
            900,
        )
        .await;
        // In-window but user B's session — must be excluded for user A.
        seed_decision(&pool, "d3", NOW - 50, "chat", "sb", "builtin", false, 100).await;
        // In-window dispatch row (task_ref is a task id, not a session) —
        // included, and it is the newest so it is last_decision.
        seed_decision(
            &pool,
            "d4",
            NOW - 10,
            "dispatch",
            "task-1",
            "builtin",
            true,
            500,
        )
        .await;
        // In-window, NULL-user session — must be included for user A.
        seed_decision(
            &pool,
            "d5",
            NOW - 15,
            "chat",
            "sc",
            "notdiamond",
            false,
            400,
        )
        .await;
        // In-window chat decision whose task_ref matches NO session row
        // (orphaned — e.g. the session was hard-deleted but its
        // routing_decisions rows weren't cascaded). The LEFT JOIN also
        // produces s.user_id IS NULL for this row, so without the
        // s.id IS NOT NULL existence guard it would incorrectly leak
        // into every caller's totals/recent. Must be excluded.
        seed_decision(
            &pool,
            "d6",
            NOW - 5,
            "chat",
            "ghost-session",
            "builtin",
            false,
            100,
        )
        .await;

        let v = summary_payload(&pool, empty_status(), "user-a", NOW)
            .await
            .unwrap();
        assert_eq!(
            v["totals_24h"]["decisions"], 3,
            "d1 + d4 + d5 (d6 orphaned, excluded)"
        );
        assert_eq!(v["totals_24h"]["fallbacks"], 1, "only d4 fell back");
        assert_eq!(v["totals_24h"]["avg_latency_ms"], 400, "(300+500+400)/3");
        assert_eq!(v["totals_24h"]["last_decision_ts"], NOW - 10);
        assert_eq!(v["last_decision"]["task_flow"], "dispatch");
        assert_eq!(v["last_decision"]["fallback_used"], true);
        let recent = v["recent"].as_array().unwrap();
        assert_eq!(recent.len(), 3);
        assert_eq!(recent[0]["ts"], NOW - 10);
        assert_eq!(recent[1]["ts"], NOW - 15);
        assert_eq!(recent[2]["ts"], NOW - 100);
        let routed = v["routed_session_ids"].as_array().unwrap();
        assert_eq!(routed.len(), 2);
        let routed_strs: Vec<&str> = routed.iter().map(|x| x.as_str().unwrap()).collect();
        assert!(routed_strs.contains(&"sa"));
        assert!(routed_strs.contains(&"sc"));
    }
}
