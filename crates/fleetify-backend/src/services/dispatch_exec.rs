//! Shared dispatch *execution* core — the resolve + guard + spawn path used by
//! both the loopback `/api/internal/dispatch` endpoint and the Fleet Hub
//! delegation batches (`services::fleet_delegate`).
//!
//! NB: `services::dispatch` (no `_exec`) owns the `[[DISPATCH:…]]` *token
//! grammar*; this module owns the *execution*. Keep them separate.
//!
//! `dispatch_one` is a faithful extraction of the body of
//! `routers::internal::dispatch` (everything after the loopback-secret check):
//! resolve the target by UUID or case-insensitive title (ownership-scoped),
//! run the cycle + depth guards, persist the task as a `user` message on the
//! target, set the dispatch chain, and spawn the target's bridge via
//! `chat::run_dispatched_task_internal`. Behaviour parity with the original is
//! the acceptance bar — the existing `internal::tests` dispatch suite is the
//! regression net.

use serde::Serialize;
use tokio::task::JoinHandle;

use crate::models::session::Session;
use crate::routers::AppState;

/// What this task is — a target reference (UUID or title) plus the verbatim task.
pub struct DispatchSpec {
    pub agent_ref: String,
    pub task: String,
}

/// Terminal result of a single dispatched task, read back from the persisted
/// `dispatch_result` message after the run completes. Used by fleet_delegate to
/// record a batch dispatch's outcome without touching the dispatch engine.
#[derive(Debug, Clone, Serialize)]
pub struct DispatchOutcome {
    pub success: bool,
    pub summary: String,
}

/// Why a dispatch could not be started. Maps to `ApiError` at the internal
/// endpoint and to a `Failed` batch dispatch in fleet_delegate.
#[derive(Debug)]
pub enum DispatchError {
    CallerNotFound,
    TargetNotFound(String),
    SelfDispatch,
    Cycle(String),
    DepthExceeded(usize),
}

/// Resolve + guard + spawn a single dispatch. Returns the resolved target and
/// the `JoinHandle` of the spawned bridge run (which yields `()` — the outcome
/// is read back from the persisted `dispatch_result` via `read_dispatch_outcome`).
pub async fn dispatch_one(
    st: &AppState,
    caller_session_id: &str,
    spec: &DispatchSpec,
) -> Result<(Session, JoinHandle<()>), DispatchError> {
    let caller = caller_session_id.trim();
    let agent_ref = spec.agent_ref.trim();
    let task = spec.task.trim();

    // Resolve caller for ownership scoping.
    let caller_row: Option<Session> =
        sqlx::query_as::<_, Session>("SELECT * FROM sessions WHERE id = ?")
            .bind(caller)
            .fetch_optional(&st.auth.pool)
            .await
            .ok()
            .flatten();
    let Some(caller_row) = caller_row else {
        return Err(DispatchError::CallerNotFound);
    };

    // Resolve target by UUID first, then case-insensitive title — scoped to the
    // caller's user_id (when set) so a hallucinated id can't route work to
    // someone else's fleet.
    let lower_ref = agent_ref.to_lowercase();
    let candidates: Vec<Session> = match &caller_row.user_id {
        Some(uid) => sqlx::query_as::<_, Session>(
            "SELECT * FROM sessions WHERE user_id = ? AND archived_at IS NULL",
        )
        .bind(uid)
        .fetch_all(&st.auth.pool)
        .await
        .unwrap_or_default(),
        None => sqlx::query_as::<_, Session>("SELECT * FROM sessions WHERE archived_at IS NULL")
            .fetch_all(&st.auth.pool)
            .await
            .unwrap_or_default(),
    };
    let Some(target) = candidates
        .into_iter()
        .find(|s| s.id == agent_ref || s.title.to_lowercase() == lower_ref)
    else {
        return Err(DispatchError::TargetNotFound(agent_ref.to_string()));
    };
    if target.id == caller {
        return Err(DispatchError::SelfDispatch);
    }

    // ── Cycle + depth guard ── (verbatim from internal::dispatch)
    let caller_chain = st.sm.get_dispatch_chain(caller);
    if caller_chain.iter().any(|s| s == &target.id) {
        return Err(DispatchError::Cycle(format!(
            "target {} already in chain ({})",
            target.id,
            caller_chain.join(" → "),
        )));
    }
    if caller_chain.len() >= crate::session_manager::SessionManager::MAX_DISPATCH_CHAIN_DEPTH {
        return Err(DispatchError::DepthExceeded(caller_chain.len()));
    }

    // Persist the task on the target so its own chat reads like the user typed it.
    let _ = sqlx::query(
        "INSERT INTO messages (id,session_id,role,content,cost_usd,timestamp) \
         VALUES (?,?,?,?,0.0,?)",
    )
    .bind(uuid::Uuid::new_v4().to_string())
    .bind(&target.id)
    .bind("user")
    .bind(serde_json::json!([{"type":"text","text":task}]).to_string())
    .bind(chrono::Utc::now().to_rfc3339())
    .execute(&st.auth.pool)
    .await;

    // Chain we'll set on the target: caller's chain + caller's own id, so a
    // sub-dispatch the target issues carries the full ancestry.
    let mut target_chain = caller_chain;
    target_chain.push(caller.to_string());

    // Layer-2 routing for the dispatched task (model tier + proxy override).
    let routing_res = crate::services::routing::persist::resolve_routing_for_dispatch(
        &st.auth.pool,
        &st.routing,
        &target.id,
        &target.id,
        &target.tool,
        target.model_name.as_deref(),
        task,
    )
    .await;

    let pool = st.auth.pool.clone();
    let sm = st.sm;
    let caller_owned = caller.to_string();
    let target_owned = target.clone();
    let task_owned = task.to_string();
    let task_for_card = task.to_string();
    sm.set_dispatch_chain(&target.id, target_chain);
    let join = tokio::spawn(async move {
        crate::routers::chat::run_dispatched_task_internal(
            pool,
            sm,
            caller_owned,
            target_owned,
            task_owned,
            task_for_card,
            routing_res,
        )
        .await;
    });
    Ok((target, join))
}

/// Read the outcome of a completed dispatch from the persisted `dispatch_result`
/// system message on the caller (staff) session. Scans the most recent system
/// messages newest-first for a `dispatch_result` block whose `agent_id` matches
/// `target_id`. Returns `None` when no result was persisted (the two
/// provider-misconfig early-returns in `run_dispatched_task` go idle silently);
/// the caller treats `None` as a failure.
pub async fn read_dispatch_outcome(
    pool: &sqlx::SqlitePool,
    caller_sid: &str,
    target_id: &str,
) -> Option<DispatchOutcome> {
    let rows: Vec<(String,)> = sqlx::query_as(
        "SELECT content FROM messages WHERE session_id = ? AND role = 'system' \
         ORDER BY timestamp DESC LIMIT 30",
    )
    .bind(caller_sid)
    .fetch_all(pool)
    .await
    .ok()?;
    for (content,) in rows {
        let Ok(blocks) = serde_json::from_str::<serde_json::Value>(&content) else {
            continue;
        };
        let Some(arr) = blocks.as_array() else {
            continue;
        };
        for b in arr {
            if b.get("type").and_then(|v| v.as_str()) == Some("dispatch_result")
                && b.get("agent_id").and_then(|v| v.as_str()) == Some(target_id)
            {
                return Some(DispatchOutcome {
                    success: b.get("success").and_then(|v| v.as_bool()).unwrap_or(false),
                    summary: b
                        .get("summary")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                });
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_pool;

    async fn seed_session(pool: &sqlx::SqlitePool, id: &str, title: &str) {
        sqlx::query(
            "INSERT INTO sessions \
             (id,title,project_path,group_path,tool,command,status,\
              use_worktree,permission_mode,session_mode,pinned,order_idx,\
              budget_used,created_at,user_id) \
             VALUES (?,?,?,'','claude-code','','idle',0,'default','new',0,0,0.0,?,?)",
        )
        .bind(id)
        .bind(title)
        .bind(format!("/tmp/{id}"))
        .bind(chrono::Utc::now().to_rfc3339())
        .bind("user-1")
        .execute(pool)
        .await
        .unwrap();
    }

    async fn insert_dispatch_result(
        pool: &sqlx::SqlitePool,
        staff_sid: &str,
        agent_id: &str,
        success: bool,
        summary: &str,
    ) {
        let content = serde_json::json!([{
            "type": "dispatch_result",
            "agent_id": agent_id,
            "task": "do the thing",
            "success": success,
            "summary": summary,
        }])
        .to_string();
        sqlx::query(
            "INSERT INTO messages (id,session_id,role,content,cost_usd,timestamp) \
             VALUES (?,?,?,?,0.0,?)",
        )
        .bind(uuid::Uuid::new_v4().to_string())
        .bind(staff_sid)
        .bind("system")
        .bind(content)
        .bind(chrono::Utc::now().to_rfc3339())
        .execute(pool)
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn read_dispatch_outcome_reads_success_and_summary() {
        let pool = init_pool("sqlite::memory:").await.unwrap();
        seed_session(&pool, "staff-1", "Staff Agent").await;
        insert_dispatch_result(&pool, "staff-1", "target-2", true, "shipped it").await;
        let out = read_dispatch_outcome(&pool, "staff-1", "target-2")
            .await
            .unwrap();
        assert!(out.success);
        assert_eq!(out.summary, "shipped it");
    }

    #[tokio::test]
    async fn read_dispatch_outcome_none_when_no_result() {
        let pool = init_pool("sqlite::memory:").await.unwrap();
        seed_session(&pool, "staff-1", "Staff Agent").await;
        assert!(read_dispatch_outcome(&pool, "staff-1", "target-2")
            .await
            .is_none());
    }

    #[tokio::test]
    async fn read_dispatch_outcome_ignores_other_targets() {
        let pool = init_pool("sqlite::memory:").await.unwrap();
        seed_session(&pool, "staff-1", "Staff Agent").await;
        insert_dispatch_result(&pool, "staff-1", "someone-else", true, "nope").await;
        assert!(read_dispatch_outcome(&pool, "staff-1", "target-2")
            .await
            .is_none());
    }
}
