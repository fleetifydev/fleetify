//! Integration coverage for the per-turn routing helper that the chat
//! WebSocket handler delegates to (`services::routing::persist::
//! resolve_routing_for_turn`). Asserts the three branches against a real
//! in-memory SQLite pool.
//!
//! These exercise the helper in isolation rather than spinning up the
//! full WS handler — the bridge handshake requires subprocess wiring
//! that's heavier than what this layer needs to prove.

use std::sync::Arc;

use fleetify_backend::db::init_pool;
use fleetify_backend::services::routing::capability_matrix::CapabilityMatrix;
use fleetify_backend::services::routing::decision::builtin::BuiltInRouter;
use fleetify_backend::services::routing::decision::registry::DecisionRouterRegistry;
use fleetify_backend::services::routing::persist::{
    pin_session, resolve_routing_for_dispatch, resolve_routing_for_turn,
};
use fleetify_backend::services::routing::proxy::direct::DirectGateway;
use fleetify_backend::services::routing::proxy::registry::ProxyGatewayRegistry;
use fleetify_backend::services::routing::traits::{
    AgentKind, DecisionRouter, ProxyGateway, RoutingTask, TaskFlow, WorkspaceHints,
};
use fleetify_backend::services::routing::RoutingOrchestrator;
use parking_lot::RwLock;

fn matrix_with_claude() -> CapabilityMatrix {
    toml::from_str(
        r#"
[agents.claude-code]
supports_tool_use = true
supports_vision = true
max_context = 200000
mcp_support = true
default_model = "claude-sonnet-4-6"
tiers = ["claude-haiku-4-5", "claude-sonnet-4-6", "claude-opus-4-7"]
        "#,
    )
    .unwrap()
}

fn make_orchestrator(enabled: bool) -> Arc<RoutingOrchestrator> {
    let builtin: Arc<dyn DecisionRouter> = Arc::new(BuiltInRouter::new(matrix_with_claude()));
    let dr = Arc::new(RwLock::new(DecisionRouterRegistry::new(builtin)));
    let direct: Arc<dyn ProxyGateway> = Arc::new(DirectGateway);
    let pr = Arc::new(RwLock::new(ProxyGatewayRegistry::new(direct)));
    Arc::new(RoutingOrchestrator::new(dr, pr, enabled))
}

async fn seed_session(pool: &sqlx::SqlitePool, id: &str, tool: &str) {
    sqlx::query(
        "INSERT INTO sessions \
         (id,title,project_path,group_path,tool,command,status,use_worktree,\
          permission_mode,session_mode,pinned,order_idx,budget_used,created_at) \
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    )
    .bind(id)
    .bind("test")
    .bind("/tmp")
    .bind("")
    .bind(tool)
    .bind("")
    .bind("idle")
    .bind(true)
    .bind("default")
    .bind("new")
    .bind(false)
    .bind(0_i64)
    .bind(0.0_f64)
    .bind("2026-01-01")
    .execute(pool)
    .await
    .unwrap();
}

fn chat_task(session_id: &str, prompt: &str) -> RoutingTask {
    RoutingTask {
        flow: TaskFlow::Chat {
            session_id: session_id.into(),
        },
        user_prompt: prompt.into(),
        conversation_history: None,
        workspace_context: WorkspaceHints::default(),
        user_hint: None,
        allowed_agents: vec![AgentKind::Claude],
        budget_remaining: None,
    }
}

/// Brand-new session + routing enabled: the helper should write a row to
/// `routing_decisions`, update `sessions.pinned_agent` / `pinned_model`,
/// and return a `decision_id` plus `freshly_routed = true`.
#[tokio::test]
async fn new_session_with_routing_enabled_persists_decision_and_pins() {
    // Skip telemetry side effects so we don't depend on the outbox.
    std::env::set_var("FLEETIFY_NOAUTH", "1");

    let pool = init_pool("sqlite::memory:").await.unwrap();
    let routing = make_orchestrator(true);
    seed_session(&pool, "s-new", "claude-code").await;

    let task = chat_task("s-new", "Refactor this module please.");
    let r = resolve_routing_for_turn(
        &pool,
        &routing,
        "s-new",
        "claude-code",
        Some("claude-sonnet-4-6"),
        task,
    )
    .await;

    assert!(r.freshly_routed, "expected fresh routing on new session");
    assert_eq!(r.agent, AgentKind::Claude);
    assert!(!r.model.is_empty(), "model should come from matrix tiers");
    let decision_id = r.decision_id.clone().expect("decision_id required");

    // routing_decisions row exists.
    let (count, agent, model_persisted): (i64, String, String) =
        sqlx::query_as("SELECT COUNT(*) AS cnt, agent, model FROM routing_decisions WHERE id = ?")
            .bind(&decision_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(count, 1, "exactly one routing_decisions row");
    assert_eq!(agent, "claude-code");
    assert_eq!(model_persisted, r.model);

    // sessions row was pinned.
    let (pa, pm, rid): (Option<String>, Option<String>, Option<String>) = sqlx::query_as(
        "SELECT pinned_agent, pinned_model, routing_decision_id FROM sessions WHERE id = ?",
    )
    .bind("s-new")
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(pa.as_deref(), Some("claude-code"));
    assert_eq!(pm.as_deref(), Some(r.model.as_str()));
    assert_eq!(rid.as_deref(), Some(decision_id.as_str()));
}

/// Existing pin: the helper should reuse the stored (agent, model) and
/// NOT write a new row to routing_decisions.
#[tokio::test]
async fn existing_pinned_session_skips_routing() {
    std::env::set_var("FLEETIFY_NOAUTH", "1");

    let pool = init_pool("sqlite::memory:").await.unwrap();
    let routing = make_orchestrator(true);
    seed_session(&pool, "s-pinned", "claude-code").await;

    // Seed a decision row + pin the session against it. Mirrors what a
    // first turn would have written.
    fleetify_backend::services::routing::persist::insert_routing_decision(
        &pool,
        "prior-decision",
        "chat",
        Some("s-pinned"),
        "claude-code",
        "claude-haiku-4-5",
        "builtin",
        "first-turn rationale",
        12,
        false,
        None,
        "[]",
        1_700_000_000,
    )
    .await
    .unwrap();
    pin_session(
        &pool,
        "s-pinned",
        "claude-code",
        "claude-haiku-4-5",
        "prior-decision",
    )
    .await
    .unwrap();

    // Count rows BEFORE second turn.
    let before: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM routing_decisions")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(before, 1);

    let task = chat_task(
        "s-pinned",
        "Refactor module x. Long task that would route differently if unpinned.",
    );
    let r = resolve_routing_for_turn(
        &pool,
        &routing,
        "s-pinned",
        "claude-code",
        Some("claude-sonnet-4-6"),
        task,
    )
    .await;

    assert!(!r.freshly_routed, "pinned session must not re-route");
    assert_eq!(r.agent, AgentKind::Claude);
    assert_eq!(r.model, "claude-haiku-4-5");
    assert_eq!(r.decision_id.as_deref(), Some("prior-decision"));

    // No new rows in routing_decisions.
    let after: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM routing_decisions")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(after, 1, "no new routing decision should be written");
}

/// Routing disabled: helper returns the manual `session.tool` /
/// `model_name` values and writes nothing.
#[tokio::test]
async fn disabled_routing_uses_manual_fields() {
    std::env::set_var("FLEETIFY_NOAUTH", "1");

    let pool = init_pool("sqlite::memory:").await.unwrap();
    let routing = make_orchestrator(false);
    seed_session(&pool, "s-manual", "claude-code").await;

    let task = chat_task("s-manual", "do a thing");
    let r = resolve_routing_for_turn(
        &pool,
        &routing,
        "s-manual",
        "claude-code",
        Some("claude-sonnet-4-6"),
        task,
    )
    .await;

    assert!(!r.freshly_routed);
    assert_eq!(r.agent, AgentKind::Claude);
    assert_eq!(r.model, "claude-sonnet-4-6");
    assert!(r.decision_id.is_none());

    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM routing_decisions")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 0, "disabled router must not persist a decision");

    let (pa, pm): (Option<String>, Option<String>) =
        sqlx::query_as("SELECT pinned_agent, pinned_model FROM sessions WHERE id = ?")
            .bind("s-manual")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(pa.is_none());
    assert!(pm.is_none());
}

// ── Dispatch-flow coverage (Task 17) ──
//
// These exercise the sibling helper for /api/internal/dispatch (and the
// staff @mention / [[DISPATCH:]] paths). Layer-1 is fixed by the caller —
// dispatch picks a model tier, never a different agent — and dispatch
// never pins its session.

/// Routing enabled: dispatch flow writes a `routing_decisions` row tagged
/// `task_flow="dispatch"`, returns a non-empty model, and does NOT touch
/// `sessions.pinned_*` (dispatch sessions are short-lived).
#[tokio::test]
async fn dispatch_routing_records_decision_when_enabled() {
    std::env::set_var("FLEETIFY_NOAUTH", "1");

    let pool = init_pool("sqlite::memory:").await.unwrap();
    let routing = make_orchestrator(true);
    seed_session(&pool, "tgt-1", "claude-code").await;

    let before: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM routing_decisions")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(before, 0);

    let res = resolve_routing_for_dispatch(
        &pool,
        &routing,
        "tgt-1",                   // task_id surrogate
        "tgt-1",                   // target_session_id
        "claude-code",             // target_tool
        Some("claude-sonnet-4-6"), // target_model (the orchestrator overrides)
        "Refactor module foo. This is a long task that should be tiered.",
    )
    .await;

    assert_eq!(res.agent, AgentKind::Claude);
    assert!(!res.model.is_empty(), "router should pick a model tier");
    let decision_id = res
        .decision_id
        .clone()
        .expect("dispatch must return a decision id when routing is on");
    assert!(res.freshly_routed);

    // routing_decisions row exists and is flagged as dispatch.
    let (count, flow, task_ref): (i64, String, Option<String>) = sqlx::query_as(
        "SELECT COUNT(*) AS cnt, task_flow, task_ref FROM routing_decisions WHERE id = ?",
    )
    .bind(&decision_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(count, 1, "exactly one routing_decisions row");
    assert_eq!(flow, "dispatch");
    assert_eq!(task_ref.as_deref(), Some("tgt-1"));

    // Dispatch must NOT pin the target session — short-lived semantics.
    let (pa, pm, rid): (Option<String>, Option<String>, Option<String>) = sqlx::query_as(
        "SELECT pinned_agent, pinned_model, routing_decision_id FROM sessions WHERE id = ?",
    )
    .bind("tgt-1")
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(pa.is_none(), "dispatch must not pin agent");
    assert!(pm.is_none(), "dispatch must not pin model");
    assert!(rid.is_none(), "dispatch must not pin decision id");
}

/// Routing disabled: dispatch flow passes through verbatim — no DB writes,
/// resolution carries the target session's existing `model_name`.
#[tokio::test]
async fn dispatch_routing_skipped_when_disabled() {
    std::env::set_var("FLEETIFY_NOAUTH", "1");

    let pool = init_pool("sqlite::memory:").await.unwrap();
    let routing = make_orchestrator(false);
    seed_session(&pool, "tgt-2", "claude-code").await;

    let res = resolve_routing_for_dispatch(
        &pool,
        &routing,
        "tgt-2",
        "tgt-2",
        "claude-code",
        Some("claude-haiku-4-5"),
        "Disabled-router pass-through task",
    )
    .await;

    assert_eq!(res.agent, AgentKind::Claude);
    assert_eq!(
        res.model, "claude-haiku-4-5",
        "model must be the target's verbatim model_name"
    );
    assert!(res.decision_id.is_none());
    assert!(!res.freshly_routed);
    assert!(res.base_url_override.is_none());

    let after: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM routing_decisions")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(after, 0, "disabled router must not persist a decision");
}
