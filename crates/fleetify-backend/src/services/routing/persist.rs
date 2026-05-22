//! Tiny SQLite helpers for persisting routing decisions and pinning
//! sessions to a chosen (agent, model). Lives next to the orchestrator
//! so call sites don't pull a routing-specific writer out of the generic
//! `db.rs` namespace.
//!
//! Also exports [`resolve_routing_for_turn`] — the per-turn helper the
//! chat WebSocket handler invokes to fold the three branches (pinned /
//! disabled / routed) into a single `RoutingResolution`.

use std::sync::Arc;

use sqlx::SqlitePool;

use crate::services::routing::orchestrator::RoutingOrchestrator;
use crate::services::routing::traits::{
    AgentKind, DecisionSource, ProviderKind, RoutingTask, TaskFlow,
};

/// Insert a routing decision row. `ts` is Unix epoch seconds.
#[allow(clippy::too_many_arguments)]
pub async fn insert_routing_decision(
    pool: &SqlitePool,
    id: &str,
    task_flow: &str,
    task_ref: Option<&str>,
    agent: &str,
    model: &str,
    source: &str,
    rationale: &str,
    latency_ms: i64,
    fallback_used: bool,
    primary_router_if_fallback: Option<&str>,
    candidates_json: &str,
    ts: i64,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO routing_decisions \
         (id, ts, task_flow, task_ref, agent, model, source, rationale, \
          latency_ms, fallback_used, primary_router_if_fallback, candidates_json) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(id)
    .bind(ts)
    .bind(task_flow)
    .bind(task_ref)
    .bind(agent)
    .bind(model)
    .bind(source)
    .bind(rationale)
    .bind(latency_ms)
    .bind(if fallback_used { 1_i64 } else { 0_i64 })
    .bind(primary_router_if_fallback)
    .bind(candidates_json)
    .execute(pool)
    .await
    .map(|_| ())
}

/// Pin a session to (agent, model) and link the originating decision.
pub async fn pin_session(
    pool: &SqlitePool,
    session_id: &str,
    agent: &str,
    model: &str,
    decision_id: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE sessions \
         SET pinned_agent = ?, pinned_model = ?, routing_decision_id = ? \
         WHERE id = ?",
    )
    .bind(agent)
    .bind(model)
    .bind(decision_id)
    .bind(session_id)
    .execute(pool)
    .await
    .map(|_| ())
}

/// Map the routing `AgentKind` enum to the `session.tool` string we
/// persist (and that chat.rs's bridge dispatch expects). `Codex` shares
/// the OpenAI tool family in the existing chat router, but for the
/// `agent` column on routing_decisions we record the routing-level
/// identity so the analytics distinguish them.
pub fn agent_kind_to_str(a: crate::services::routing::traits::AgentKind) -> &'static str {
    use crate::services::routing::traits::AgentKind;
    match a {
        AgentKind::Claude => "claude",
        AgentKind::OpenAI => "openai",
        AgentKind::Gemini => "gemini",
        AgentKind::Codex => "codex",
    }
}

/// Inverse of [`agent_kind_to_str`]. Returns `None` for unrecognised
/// strings so the caller decides whether to fall back to a default.
pub fn str_to_agent_kind(s: &str) -> Option<crate::services::routing::traits::AgentKind> {
    use crate::services::routing::traits::AgentKind;
    match s {
        "claude" => Some(AgentKind::Claude),
        "openai" => Some(AgentKind::OpenAI),
        "gemini" => Some(AgentKind::Gemini),
        "codex" => Some(AgentKind::Codex),
        _ => None,
    }
}

/// Existing session pin record. All-None when nothing is pinned yet.
#[derive(Debug, Clone, Default)]
pub struct SessionPin {
    pub agent: Option<String>,
    pub model: Option<String>,
    pub decision_id: Option<String>,
}

/// Read the pinning columns for a session in a single query so we don't
/// have to extend the existing `Session` struct (which derives `FromRow`
/// against `SELECT *`). Returns the default (all-None) if the row is
/// missing — callers already validated ownership earlier in the flow.
pub async fn load_session_pin(pool: &SqlitePool, session_id: &str) -> SessionPin {
    let row: Option<(Option<String>, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT pinned_agent, pinned_model, routing_decision_id FROM sessions WHERE id = ?",
    )
    .bind(session_id)
    .fetch_optional(pool)
    .await
    .ok()
    .flatten();
    match row {
        Some((agent, model, decision_id)) => SessionPin {
            agent,
            model,
            decision_id,
        },
        None => SessionPin::default(),
    }
}

/// Outcome of [`resolve_routing_for_turn`] / [`resolve_routing_for_dispatch`].
/// Carries the (agent, model) the bridge should use plus the decision id to
/// attach to downstream telemetry (`emit_cost`'s `routing_decision_id`
/// argument).
#[derive(Debug, Clone)]
pub struct RoutingResolution {
    /// Agent we're operating as for this turn. Either the session's
    /// existing pin, the manual `session.tool` value, or the routing
    /// orchestrator's pick.
    pub agent: AgentKind,
    /// Model tier for this turn. Bridges receive this via
    /// `BridgeContext::model_override`.
    pub model: String,
    /// Routing decisions table id, if any. `None` when routing is
    /// disabled and the session has no prior decision.
    pub decision_id: Option<String>,
    /// Set when the resolution wrote a fresh row to `routing_decisions`
    /// AND pinned the session. Used in tests to assert side effects.
    pub freshly_routed: bool,
    /// Proxy gateway base URL override, if the active proxy gateway is
    /// not the direct gateway. Populated only by dispatch flow today —
    /// the chat-turn helper computes this separately because callers
    /// derive the provider family from the routed agent.
    pub base_url_override: Option<String>,
    /// Headers attached by the proxy gateway. Empty when `base_url_override`
    /// is `None`.
    pub extra_headers: http::HeaderMap,
}

/// Per-turn routing decision. Three branches:
/// 1. Session has BOTH `pinned_agent` and `pinned_model` set → reuse them.
///    No `route()` call, no DB write. `decision_id` carries the session's
///    existing `routing_decision_id` if any.
/// 2. Orchestrator is disabled → use the caller-supplied `manual_tool` +
///    `manual_model` (`session.tool` / `session.model_name`). No DB write.
/// 3. Orchestrator enabled and session has no pin → call `route()`, insert
///    a `routing_decisions` row, UPDATE the session's `pinned_*` columns,
///    emit a `routing_decision` telemetry event, return the new id.
///
/// `manual_tool` MUST be one of `"claude" | "openai" | "gemini" | "codex"`;
/// anything else falls through to `AgentKind::Claude` so we never crash on
/// a row with a bogus tool string (the chat handler already rejects unknown
/// tools earlier in the flow, so this is purely defensive).
pub async fn resolve_routing_for_turn(
    pool: &SqlitePool,
    routing: &Arc<RoutingOrchestrator>,
    session_id: &str,
    manual_tool: &str,
    manual_model: Option<&str>,
    task: RoutingTask,
) -> RoutingResolution {
    let pin = load_session_pin(pool, session_id).await;

    // Branch 1: existing pin — sticky for the session lifetime.
    if let (Some(agent_str), Some(model)) = (pin.agent.as_deref(), pin.model.as_deref()) {
        let agent = str_to_agent_kind(agent_str).unwrap_or(AgentKind::Claude);
        return RoutingResolution {
            agent,
            model: model.to_string(),
            decision_id: pin.decision_id,
            freshly_routed: false,
            base_url_override: None,
            extra_headers: http::HeaderMap::new(),
        };
    }

    // Branch 2: orchestrator master toggle off.
    if !routing.enabled() {
        let agent = str_to_agent_kind(manual_tool).unwrap_or(AgentKind::Claude);
        return RoutingResolution {
            agent,
            model: manual_model.unwrap_or_default().to_string(),
            decision_id: None,
            freshly_routed: false,
            base_url_override: None,
            extra_headers: http::HeaderMap::new(),
        };
    }

    // Branch 3: route now, persist, pin.
    let outcome = routing.route(&task, &[]).await;
    let decision_id = uuid::Uuid::new_v4().to_string();
    let agent_str = agent_kind_to_str(outcome.decision.agent);
    let source_str = decision_source_to_str(outcome.decision.source);
    let candidates: Vec<(AgentKind, String)> = outcome.decision.fallback_chain.clone();
    let candidates_json = serde_json::to_string(
        &candidates
            .iter()
            .map(|(a, m)| serde_json::json!({ "agent": agent_kind_to_str(*a), "model": m }))
            .collect::<Vec<_>>(),
    )
    .unwrap_or_else(|_| "[]".into());
    let now = chrono::Utc::now();
    let ts = now.timestamp();
    let (task_flow_str, task_ref) = match &task.flow {
        TaskFlow::Chat { session_id } => ("chat", Some(session_id.as_str())),
        TaskFlow::Dispatch { task_id } => ("dispatch", Some(task_id.as_str())),
    };

    if let Err(e) = insert_routing_decision(
        pool,
        &decision_id,
        task_flow_str,
        task_ref,
        agent_str,
        &outcome.decision.model,
        source_str,
        &outcome.decision.rationale,
        outcome.latency_ms as i64,
        outcome.fallback_used,
        outcome.primary_router_id.as_deref(),
        &candidates_json,
        ts,
    )
    .await
    {
        tracing::warn!(
            target: "fleet-backend",
            error = %e,
            "routing: failed to persist routing_decisions row"
        );
    }
    if let Err(e) = pin_session(
        pool,
        session_id,
        agent_str,
        &outcome.decision.model,
        &decision_id,
    )
    .await
    {
        tracing::warn!(
            target: "fleet-backend",
            error = %e,
            "routing: failed to pin session"
        );
    }

    // Telemetry emit — fire-and-forget. The outbox swallows errors when
    // not initialised (NOAUTH mode) so this is safe to call unconditionally.
    let _ = crate::services::telemetry::emit_routing_decision(
        &decision_id,
        &task.flow,
        task_ref,
        source_str,
        outcome.decision.agent,
        &outcome.decision.model,
        &outcome.decision.rationale,
        outcome.latency_ms,
        outcome.fallback_used,
        outcome.primary_router_id.as_deref(),
        &candidates,
        now,
    )
    .await;

    RoutingResolution {
        agent: outcome.decision.agent,
        model: outcome.decision.model,
        decision_id: Some(decision_id),
        freshly_routed: true,
        base_url_override: None,
        extra_headers: http::HeaderMap::new(),
    }
}

/// Map an `AgentKind` to its outbound `ProviderKind` for proxy gateway
/// lookups. Codex shares OpenAI's wire format, so it lands on the OpenAI
/// proxy entry. Exposed at the module level so the dispatch helper and
/// chat router can both translate without duplicating the match.
pub fn provider_kind_for(agent: AgentKind) -> ProviderKind {
    match agent {
        AgentKind::Claude => ProviderKind::Anthropic,
        AgentKind::OpenAI | AgentKind::Codex => ProviderKind::OpenAI,
        AgentKind::Gemini => ProviderKind::Google,
    }
}

/// Per-dispatch routing helper. Unlike the chat-turn variant, dispatch
/// flows do NOT carry session pins — each /api/internal/dispatch call
/// gets a fresh Layer-2 decision (model tier) bound to the
/// caller-selected agent identity.
///
/// When the orchestrator is disabled (or the target session's `tool`
/// string is unrecognised), this is a pure pass-through: returns the
/// target's existing tool + `model_name` verbatim, with no DB writes
/// and no telemetry emit. When enabled, it calls `orchestrator.route`,
/// inserts a `routing_decisions` row tagged `task_flow="dispatch"`,
/// fires off a routing_decision telemetry event, and resolves the
/// active proxy gateway's base URL + headers for the routed agent's
/// provider family.
///
/// `task_id` is recorded in the `task_ref` column of routing_decisions
/// so the analytics can pair the row with the dispatched task that
/// caused it.
#[allow(clippy::too_many_arguments)]
pub async fn resolve_routing_for_dispatch(
    pool: &SqlitePool,
    orch: &Arc<RoutingOrchestrator>,
    task_id: &str,
    _target_session_id: &str,
    target_tool: &str,
    target_model: Option<&str>,
    task_body: &str,
) -> RoutingResolution {
    use crate::services::routing::traits::{TaskFlow, WorkspaceHints};

    let target_agent = str_to_agent_kind(target_tool);

    // Disabled router OR unrecognised tool → pure pass-through. The
    // dispatched bridge will use the target session's configured
    // model_name and direct provider URLs.
    if !orch.enabled() || target_agent.is_none() {
        let agent = target_agent.unwrap_or(AgentKind::Claude);
        return RoutingResolution {
            agent,
            model: target_model.unwrap_or_default().to_string(),
            decision_id: None,
            freshly_routed: false,
            base_url_override: None,
            extra_headers: http::HeaderMap::new(),
        };
    }
    let agent = target_agent.unwrap();
    let routing_task = RoutingTask {
        flow: TaskFlow::Dispatch {
            task_id: task_id.to_string(),
        },
        user_prompt: task_body.to_string(),
        conversation_history: None,
        workspace_context: WorkspaceHints::default(),
        user_hint: None,
        allowed_agents: vec![agent],
        budget_remaining: None,
    };

    let outcome = orch.route(&routing_task, &[]).await;
    let decision_id = uuid::Uuid::new_v4().to_string();
    let agent_str = agent_kind_to_str(outcome.decision.agent);
    let source_str = decision_source_to_str(outcome.decision.source);
    let candidates: Vec<(AgentKind, String)> = outcome.decision.fallback_chain.clone();
    let candidates_json = serde_json::to_string(
        &candidates
            .iter()
            .map(|(a, m)| serde_json::json!({ "agent": agent_kind_to_str(*a), "model": m }))
            .collect::<Vec<_>>(),
    )
    .unwrap_or_else(|_| "[]".into());
    let now = chrono::Utc::now();
    let ts = now.timestamp();

    if let Err(e) = insert_routing_decision(
        pool,
        &decision_id,
        "dispatch",
        Some(task_id),
        agent_str,
        &outcome.decision.model,
        source_str,
        &outcome.decision.rationale,
        outcome.latency_ms as i64,
        outcome.fallback_used,
        outcome.primary_router_id.as_deref(),
        &candidates_json,
        ts,
    )
    .await
    {
        tracing::warn!(
            target: "fleet-backend",
            error = %e,
            "routing(dispatch): failed to persist routing_decisions row"
        );
    }

    // Fire-and-forget telemetry. NOAUTH/uninitialised outbox swallows.
    let _ = crate::services::telemetry::emit_routing_decision(
        &decision_id,
        &TaskFlow::Dispatch {
            task_id: task_id.to_string(),
        },
        Some(task_id),
        source_str,
        outcome.decision.agent,
        &outcome.decision.model,
        &outcome.decision.rationale,
        outcome.latency_ms,
        outcome.fallback_used,
        outcome.primary_router_id.as_deref(),
        &candidates,
        now,
    )
    .await;

    let (base_url_override, extra_headers) =
        match orch.proxy_for(provider_kind_for(outcome.decision.agent)) {
            Some((u, h)) => (Some(u), h),
            None => (None, http::HeaderMap::new()),
        };

    RoutingResolution {
        agent: outcome.decision.agent,
        model: outcome.decision.model,
        decision_id: Some(decision_id),
        freshly_routed: true,
        base_url_override,
        extra_headers,
    }
}

fn decision_source_to_str(s: DecisionSource) -> &'static str {
    match s {
        DecisionSource::BuiltIn => "builtin",
        DecisionSource::NotDiamond => "notdiamond",
        DecisionSource::Weave => "weave",
        DecisionSource::Inworld => "inworld",
        DecisionSource::Manual => "manual",
        DecisionSource::Pinned => "pinned",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_pool;

    #[tokio::test]
    async fn insert_then_query_routing_decision() {
        let pool = init_pool("sqlite::memory:").await.unwrap();
        insert_routing_decision(
            &pool,
            "d-1",
            "chat",
            Some("s1"),
            "claude",
            "claude-sonnet-4-6",
            "builtin",
            "test rationale",
            42,
            false,
            None,
            "[]",
            1_700_000_000,
        )
        .await
        .unwrap();
        let row: (String, String, String, i64, i64) = sqlx::query_as(
            "SELECT id, agent, model, latency_ms, fallback_used FROM routing_decisions WHERE id = ?",
        )
        .bind("d-1")
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(row.0, "d-1");
        assert_eq!(row.1, "claude");
        assert_eq!(row.2, "claude-sonnet-4-6");
        assert_eq!(row.3, 42);
        assert_eq!(row.4, 0);
    }

    #[tokio::test]
    async fn insert_with_fallback_used_persists_one() {
        let pool = init_pool("sqlite::memory:").await.unwrap();
        insert_routing_decision(
            &pool,
            "d-2",
            "dispatch",
            Some("t1"),
            "openai",
            "gpt-4o",
            "notdiamond",
            "rationale",
            1234,
            true,
            Some("notdiamond"),
            "[{\"agent\":\"openai\",\"model\":\"gpt-4o\"}]",
            1_700_000_001,
        )
        .await
        .unwrap();
        let (fallback, primary): (i64, Option<String>) = sqlx::query_as(
            "SELECT fallback_used, primary_router_if_fallback FROM routing_decisions WHERE id = ?",
        )
        .bind("d-2")
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(fallback, 1);
        assert_eq!(primary.as_deref(), Some("notdiamond"));
    }

    #[tokio::test]
    async fn pin_session_updates_columns() {
        let pool = init_pool("sqlite::memory:").await.unwrap();
        // Seed a minimal session row.
        sqlx::query(
            "INSERT INTO sessions (id, title, project_path, group_path, tool, command, status, \
             permission_mode, session_mode, pinned, order_idx, created_at, budget_used) \
             VALUES ('s1','t','/p','','claude','','idle','default','new',0,0,'2026-01-01',0.0)",
        )
        .execute(&pool)
        .await
        .unwrap();
        // Insert a decision row to satisfy the FK on routing_decision_id.
        insert_routing_decision(
            &pool,
            "d-3",
            "chat",
            Some("s1"),
            "claude",
            "claude-haiku-4-5",
            "builtin",
            "rat",
            7,
            false,
            None,
            "[]",
            1_700_000_002,
        )
        .await
        .unwrap();
        pin_session(&pool, "s1", "claude", "claude-haiku-4-5", "d-3")
            .await
            .unwrap();
        let row: (Option<String>, Option<String>, Option<String>) = sqlx::query_as(
            "SELECT pinned_agent, pinned_model, routing_decision_id FROM sessions WHERE id = ?",
        )
        .bind("s1")
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(row.0.as_deref(), Some("claude"));
        assert_eq!(row.1.as_deref(), Some("claude-haiku-4-5"));
        assert_eq!(row.2.as_deref(), Some("d-3"));
    }

    #[test]
    fn agent_kind_str_round_trip() {
        use crate::services::routing::traits::AgentKind;
        for a in [
            AgentKind::Claude,
            AgentKind::OpenAI,
            AgentKind::Gemini,
            AgentKind::Codex,
        ] {
            assert_eq!(str_to_agent_kind(agent_kind_to_str(a)), Some(a));
        }
        assert_eq!(str_to_agent_kind("bogus"), None);
    }
}
