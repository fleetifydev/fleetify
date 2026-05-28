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
        AgentKind::Kimi => "kimi",
        AgentKind::GitHubCopilot => "github-copilot",
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
        "kimi" => Some(AgentKind::Kimi),
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

/// Session routing snapshot — the pinned (agent, model) plus the
/// decision row's source + rationale joined in. Returned by the
/// `GET /api/sessions/:id/routing` endpoint so the chat header can
/// render a "Auto-routed → claude-sonnet-4-6" chip with the rationale
/// on hover. None of these fields is optional at the row level: the
/// row only exists when the session has been pinned AND a decision
/// row exists (LEFT JOIN allows the rationale-less case but we
/// require pinned_agent/pinned_model to be set on the session itself).
#[derive(Debug, Clone)]
pub struct SessionRoutingInfo {
    pub agent: String,
    pub model: String,
    /// `pinned` when the user manually overrode, otherwise the
    /// decision router id (`builtin`, `notdiamond`, `weave`, …).
    pub source: String,
    /// Human-readable explanation from the routing decision. Empty
    /// when the session has no `routing_decision_id` (manual pin
    /// path — the user clicked an agent in the picker).
    pub rationale: String,
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

/// JOIN `sessions` against `routing_decisions` to surface the rationale.
/// Returns `None` when the session has no `pinned_agent` (i.e. nothing has
/// been routed or manually pinned yet). When the decision row is missing
/// (e.g. legacy session with manual pin pre-routing), `source` falls back
/// to `"pinned"` and `rationale` to an empty string.
pub async fn load_session_routing(
    pool: &SqlitePool,
    session_id: &str,
) -> Option<SessionRoutingInfo> {
    // (pinned_agent, pinned_model, source, rationale) — all nullable because
    // the LEFT JOIN can produce NULLs for the decision-row columns. Pulled
    // into a `type` alias purely to keep clippy::type_complexity quiet.
    type Row = (
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
    );
    let row: Option<Row> = sqlx::query_as(
        "SELECT s.pinned_agent, s.pinned_model, rd.source, rd.rationale \
         FROM sessions s \
         LEFT JOIN routing_decisions rd ON s.routing_decision_id = rd.id \
         WHERE s.id = ? AND s.pinned_agent IS NOT NULL AND s.pinned_model IS NOT NULL",
    )
    .bind(session_id)
    .fetch_optional(pool)
    .await
    .ok()
    .flatten();
    match row {
        Some((Some(agent), Some(model), source, rationale)) => Some(SessionRoutingInfo {
            agent,
            model,
            source: source.unwrap_or_else(|| "pinned".into()),
            rationale: rationale.unwrap_or_default(),
        }),
        _ => None,
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

/// Per-turn routing decision. Three branches, evaluated in this order:
/// 1. Session has BOTH `pinned_agent` and `pinned_model` set → reuse them.
///    No `route()` call, no DB write. `decision_id` carries the session's
///    existing `routing_decision_id` if any. **This branch runs FIRST,
///    regardless of `routing.enabled()`** — toggling the master switch
///    OFF mid-session must not "unpin" an already-routed session, or the
///    user would see their agent/model swap to the manual fields under
///    them. The pin is per-session sticky; the master toggle only gates
///    *new* routing decisions.
/// 2. Orchestrator is disabled AND no pin → use the caller-supplied
///    `manual_tool` + `manual_model` (`session.tool` / `session.model_name`).
///    No DB write.
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
    // MUST be checked before `routing.enabled()`: a session pinned by an
    // earlier routed turn keeps its (agent, model) even if the user
    // toggles auto-routing OFF mid-session. Unit-tested by
    // `pin_survives_routing_disabled` below.
    //
    // Self-heal guard: when the user manually flips `session.tool`
    // through the picker, `update_session` refreshes the pin to match
    // (see routers/sessions.rs). Rows that predate that fix — or any
    // path that bypasses the PATCH (legacy data, direct SQL, future
    // bug) — can leave the pin's `agent` pointing at a DIFFERENT
    // bridge family than `session.tool`. Returning that stale pin
    // makes chat.rs build the bridge from session.tool but apply a
    // model from a different agent family (e.g. claude-sonnet-4-6 on
    // the Codex bridge), which Codex / Antigravity CLI silently
    // refuse (TOML-only model config). Treat any agent-mismatched pin
    // as missing so we fall through to Branch 2 (routing off ⇒ honor
    // manual_tool/manual_model) or Branch 3 (route fresh) and pin the
    // correct identity on the way out.
    if let (Some(agent_str), Some(model)) = (pin.agent.as_deref(), pin.model.as_deref()) {
        let agent = str_to_agent_kind(agent_str).unwrap_or(AgentKind::Claude);
        let manual_kind = str_to_agent_kind(manual_tool);
        if Some(agent) == manual_kind {
            return RoutingResolution {
                agent,
                model: model.to_string(),
                decision_id: pin.decision_id,
                freshly_routed: false,
                base_url_override: None,
                extra_headers: http::HeaderMap::new(),
            };
        }
        tracing::warn!(
            target: "fleet-backend",
            session_id = %session_id,
            pinned_agent = agent_str,
            session_tool = manual_tool,
            "routing: pin agent disagrees with session.tool — ignoring stale pin and re-resolving"
        );
    }

    // Branch 2: orchestrator master toggle off AND no pin → pass through
    // to the user's manual selection. (A pinned session does NOT reach
    // this branch — see comment on Branch 1.)
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
        AgentKind::Kimi => ProviderKind::OpenAICompatible,
        AgentKind::GitHubCopilot => ProviderKind::OpenAICompatible,
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

    #[tokio::test]
    async fn load_session_routing_joins_decision_row() {
        let pool = init_pool("sqlite::memory:").await.unwrap();
        sqlx::query(
            "INSERT INTO sessions (id, title, project_path, group_path, tool, command, status, \
             permission_mode, session_mode, pinned, order_idx, created_at, budget_used) \
             VALUES ('s-r1','t','/p','','claude','','idle','default','new',0,0,'2026-01-01',0.0)",
        )
        .execute(&pool)
        .await
        .unwrap();
        insert_routing_decision(
            &pool,
            "d-r1",
            "chat",
            Some("s-r1"),
            "claude",
            "claude-sonnet-4-6",
            "builtin",
            "balanced for general coding",
            12,
            false,
            None,
            "[]",
            1_700_000_010,
        )
        .await
        .unwrap();
        pin_session(&pool, "s-r1", "claude", "claude-sonnet-4-6", "d-r1")
            .await
            .unwrap();
        let info = load_session_routing(&pool, "s-r1").await.unwrap();
        assert_eq!(info.agent, "claude");
        assert_eq!(info.model, "claude-sonnet-4-6");
        assert_eq!(info.source, "builtin");
        assert_eq!(info.rationale, "balanced for general coding");
    }

    #[tokio::test]
    async fn load_session_routing_returns_none_when_unpinned() {
        let pool = init_pool("sqlite::memory:").await.unwrap();
        sqlx::query(
            "INSERT INTO sessions (id, title, project_path, group_path, tool, command, status, \
             permission_mode, session_mode, pinned, order_idx, created_at, budget_used) \
             VALUES ('s-r2','t','/p','','claude','','idle','default','new',0,0,'2026-01-01',0.0)",
        )
        .execute(&pool)
        .await
        .unwrap();
        assert!(load_session_routing(&pool, "s-r2").await.is_none());
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

    /// Regression: pinned session keeps its (agent, model) even when the
    /// master routing toggle is OFF — provided the pin's agent still
    /// agrees with `session.tool`. The pin check MUST run before the
    /// `routing.enabled()` check in `resolve_routing_for_turn`,
    /// otherwise toggling routing OFF mid-session would silently swap
    /// the user's model to whatever was in `manual_model`.
    #[tokio::test]
    async fn pin_survives_routing_disabled() {
        use crate::services::routing::traits::{TaskFlow, WorkspaceHints};
        let pool = init_pool("sqlite::memory:").await.unwrap();
        // Pin the session to claude-haiku-4-5; manual model is a
        // different claude tier so we can tell which branch fired.
        // Agent kind agrees (both claude) so the self-heal in Branch
        // 1 does NOT skip the pin.
        sqlx::query(
            "INSERT INTO sessions (id, title, project_path, group_path, tool, model_name, command, status, \
             permission_mode, session_mode, pinned, order_idx, created_at, budget_used) \
             VALUES ('s-pin','t','/p','','claude','claude-sonnet-4-6','','idle','default','new',0,0,'2026-01-01',0.0)",
        )
        .execute(&pool)
        .await
        .unwrap();
        insert_routing_decision(
            &pool,
            "d-pin",
            "chat",
            Some("s-pin"),
            "claude",
            "claude-haiku-4-5",
            "builtin",
            "rat",
            5,
            false,
            None,
            "[]",
            1_700_000_100,
        )
        .await
        .unwrap();
        pin_session(&pool, "s-pin", "claude", "claude-haiku-4-5", "d-pin")
            .await
            .unwrap();

        // Orchestrator with routing DISABLED.
        let orch = RoutingOrchestrator::with_empty_defaults(false);
        assert!(!orch.enabled());

        let task = RoutingTask {
            flow: TaskFlow::Chat {
                session_id: "s-pin".into(),
            },
            user_prompt: "hi".into(),
            conversation_history: None,
            workspace_context: WorkspaceHints::default(),
            user_hint: None,
            allowed_agents: vec![AgentKind::Claude],
            budget_remaining: None,
        };
        let res = resolve_routing_for_turn(
            &pool,
            &orch,
            "s-pin",
            "claude",                  // manual tool — agrees with pin's agent
            Some("claude-sonnet-4-6"), // manual model — must be IGNORED in favour of pin's model
            task,
        )
        .await;
        // Pin's model wins over manual_model, proving Branch 1 ran
        // before the `routing.enabled()` check.
        assert_eq!(res.agent, AgentKind::Claude);
        assert_eq!(res.model, "claude-haiku-4-5");
        assert_eq!(res.decision_id.as_deref(), Some("d-pin"));
        assert!(!res.freshly_routed);
    }

    /// Self-heal: when the pin's `agent` disagrees with `session.tool`
    /// (e.g. user picked Codex in the picker after the session was
    /// previously routed to Claude), Branch 1 must SKIP the stale pin
    /// and fall through so we don't dispatch a Claude-family model on
    /// the Codex bridge — the exact mismatch that triggered the
    /// "decision picked a different agent than session.tool" warning
    /// and Codex's "model_override not supported" stall.
    #[tokio::test]
    async fn pin_agent_mismatch_falls_through_to_manual() {
        use crate::services::routing::traits::{TaskFlow, WorkspaceHints};
        let pool = init_pool("sqlite::memory:").await.unwrap();
        // session.tool says Codex (the user's latest picker pick);
        // pin still has Claude from the first routed turn before the
        // user switched agents.
        sqlx::query(
            "INSERT INTO sessions (id, title, project_path, group_path, tool, model_name, command, status, \
             permission_mode, session_mode, pinned, order_idx, created_at, budget_used) \
             VALUES ('s-stale','t','/p','','codex','gpt-5.2','','idle','default','new',0,0,'2026-01-01',0.0)",
        )
        .execute(&pool)
        .await
        .unwrap();
        insert_routing_decision(
            &pool,
            "d-old",
            "chat",
            Some("s-stale"),
            "claude",
            "claude-sonnet-4-6",
            "builtin",
            "rat",
            5,
            false,
            None,
            "[]",
            1_700_000_100,
        )
        .await
        .unwrap();
        pin_session(&pool, "s-stale", "claude", "claude-sonnet-4-6", "d-old")
            .await
            .unwrap();

        // Routing disabled so Branch 2 (manual fallback) is the
        // expected destination after the self-heal skips Branch 1.
        let orch = RoutingOrchestrator::with_empty_defaults(false);
        let task = RoutingTask {
            flow: TaskFlow::Chat {
                session_id: "s-stale".into(),
            },
            user_prompt: "hi".into(),
            conversation_history: None,
            workspace_context: WorkspaceHints::default(),
            user_hint: None,
            allowed_agents: vec![AgentKind::Codex],
            budget_remaining: None,
        };
        let res = resolve_routing_for_turn(
            &pool,
            &orch,
            "s-stale",
            "codex",         // session.tool — disagrees with pin's agent
            Some("gpt-5.2"), // session.model_name
            task,
        )
        .await;
        // Self-heal must skip the stale (Claude, claude-sonnet-4-6)
        // pin and return the session's manual (Codex, gpt-5.2).
        assert_eq!(res.agent, AgentKind::Codex);
        assert_eq!(res.model, "gpt-5.2");
        assert!(res.decision_id.is_none());
        assert!(!res.freshly_routed);
    }
}
