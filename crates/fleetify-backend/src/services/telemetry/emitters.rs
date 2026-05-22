//! Event extraction layer — the ONLY path from local agent loop to
//! cloud. Faithful subset of `services/telemetry/emitters.py`.
//!
//! Each `emit_*` function:
//!   1. Truncates user-supplied strings to wire-safe lengths.
//!   2. Generates a client-assigned UUID v4 to identify the event.
//!   3. Persists the event via `outbox::enqueue`.
//!   4. Pulses `event_available` so the (eventual) WS client flushes
//!      the new event immediately instead of waiting on its poll
//!      cadence.
//!
//! Privacy tier: titles + paths allowed, never prompt / file content /
//! command stdio.

use std::sync::OnceLock;

use anyhow::Result;
use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use tokio::sync::Notify;

use super::outbox;
use crate::services::routing::traits::{AgentKind, TaskFlow};

pub const TITLE_MAX: usize = 200;
pub const PATH_MAX: usize = 512;
pub const SUMMARY_MAX: usize = 256;
/// Truncation cap for routing rationale (privacy + outbox payload size).
pub const RATIONALE_MAX: usize = 200;
/// Truncation cap for router error messages.
pub const ERROR_MAX: usize = 500;

/// Signal the WS client (when it lands) that new events are ready. The
/// client awaits this and flushes whenever it fires.
pub fn event_available() -> &'static Notify {
    static N: OnceLock<Notify> = OnceLock::new();
    N.get_or_init(Notify::new)
}

fn trunc(s: Option<&str>, n: usize) -> Option<String> {
    s.map(|s| {
        if s.chars().count() <= n {
            s.to_string()
        } else {
            s.chars().take(n).collect()
        }
    })
}

fn iso_utc(dt: DateTime<Utc>) -> String {
    // Cloud's zod schema requires `z.iso.datetime({ offset: true })` —
    // chrono's `to_rfc3339()` already emits an offset (`Z` or `+00:00`).
    dt.to_rfc3339()
}

async fn enqueue_payload(payload: Value) -> Result<()> {
    // No-auth dev mode: never enqueue. The WS client and heartbeat loop
    // are also skipped at startup, so without this guard the outbox
    // would grow unbounded with no consumer.
    if crate::auth::is_no_auth() {
        return Ok(());
    }
    let event_id = uuid::Uuid::new_v4().to_string();
    outbox::enqueue(&event_id, &payload).await?;
    tracing::info!(
        target: "fleetify.telemetry.emit",
        "telemetry: enqueued kind={} id={} session={}",
        payload.get("kind").and_then(|v| v.as_str()).unwrap_or(""),
        event_id,
        payload
            .get("local_session_id")
            .and_then(|v| v.as_str())
            .unwrap_or(""),
    );
    event_available().notify_waiters();
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub async fn emit_session_start(
    session_id: &str,
    tool: &str,
    model: Option<&str>,
    status: &str,
    title: Option<&str>,
    project_path: Option<&str>,
    started_at: DateTime<Utc>,
) -> Result<()> {
    enqueue_payload(json!({
        "kind": "session_start",
        "local_session_id": session_id,
        "tool": tool,
        "model": model,
        "status": status,
        "session_title": trunc(title, TITLE_MAX),
        "project_path": trunc(project_path, PATH_MAX),
        "occurred_at": iso_utc(started_at),
    }))
    .await
}

pub async fn emit_session_stop(
    session_id: &str,
    tool: &str,
    stopped_at: DateTime<Utc>,
) -> Result<()> {
    enqueue_payload(json!({
        "kind": "session_stop",
        "local_session_id": session_id,
        "tool": tool,
        "status": "stopped",
        "occurred_at": iso_utc(stopped_at),
    }))
    .await
}

#[allow(clippy::too_many_arguments)]
pub async fn emit_cost(
    session_id: &str,
    model: &str,
    input_tokens: i64,
    output_tokens: i64,
    cache_read: i64,
    cache_write: i64,
    cost_usd: f64,
    timestamp: DateTime<Utc>,
    routing_decision_id: Option<&str>,
) -> Result<()> {
    let mut payload = json!({
        "kind": "cost",
        "local_session_id": session_id,
        "model": model,
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "cache_read": cache_read,
        "cache_write": cache_write,
        // String for numeric precision — backend stores as NUMERIC(20,8).
        "cost_usd": format!("{cost_usd:.6}"),
        "occurred_at": iso_utc(timestamp),
    });
    if let Some(id) = routing_decision_id {
        payload
            .as_object_mut()
            .expect("payload constructed via json!({...}) is always an object")
            .insert("routing_decision_id".into(), json!(id));
    }
    enqueue_payload(payload).await
}

pub async fn emit_status_change(session_id: &str, status: &str, when: DateTime<Utc>) -> Result<()> {
    enqueue_payload(json!({
        "kind": "status_change",
        "local_session_id": session_id,
        "status": status,
        "occurred_at": iso_utc(when),
    }))
    .await
}

pub async fn emit_activity(
    session_id: &str,
    activity_kind: &str,
    summary: Option<&str>,
    ts: DateTime<Utc>,
) -> Result<()> {
    enqueue_payload(json!({
        "kind": "activity",
        "local_session_id": session_id,
        "activity_kind": activity_kind,
        "activity_summary": trunc(summary, SUMMARY_MAX),
        "occurred_at": iso_utc(ts),
    }))
    .await
}

pub async fn emit_heartbeat(occurred_at: DateTime<Utc>) -> Result<()> {
    enqueue_payload(json!({
        "kind": "device_heartbeat",
        "occurred_at": iso_utc(occurred_at),
    }))
    .await
}

/// Categorised router failure cause — kept narrow so the cloud can chart
/// trends without churning on free-form strings.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RoutingFailureKind {
    Timeout,
    Network,
    Upstream,
    InvalidResponse,
    NotConfigured,
    Auth,
}

impl RoutingFailureKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Timeout => "timeout",
            Self::Network => "network",
            Self::Upstream => "upstream",
            Self::InvalidResponse => "invalid_response",
            Self::NotConfigured => "not_configured",
            Self::Auth => "auth",
        }
    }
}

/// Router liveness states surfaced to cloud telemetry; transitions emit a
/// `router_health_change` event.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HealthState {
    Healthy,
    Degraded,
    Unreachable,
}

impl HealthState {
    fn as_str(self) -> &'static str {
        match self {
            Self::Healthy => "healthy",
            Self::Degraded => "degraded",
            Self::Unreachable => "unreachable",
        }
    }
}

fn agent_key(a: AgentKind) -> &'static str {
    match a {
        AgentKind::Claude => "claude",
        AgentKind::OpenAI => "openai",
        AgentKind::Gemini => "gemini",
        AgentKind::Codex => "codex",
    }
}

/// Build the JSON payload for a `routing_decision` event. Pure: no side
/// effects, no privacy guard — `emit_routing_decision` wraps this with
/// `enqueue_payload`.
#[allow(clippy::too_many_arguments)]
fn payload_for_routing_decision(
    decision_id: &str,
    task_flow: &TaskFlow,
    task_ref: Option<&str>,
    router_source: &str,
    selected_agent: AgentKind,
    selected_model: &str,
    rationale: &str,
    latency_ms: u64,
    fallback_used: bool,
    primary_router_if_fallback: Option<&str>,
    candidates: &[(AgentKind, String)],
    occurred_at: DateTime<Utc>,
) -> Value {
    let flow = match task_flow {
        TaskFlow::Chat { .. } => "chat",
        TaskFlow::Dispatch { .. } => "dispatch",
    };
    let candidates_json: Vec<Value> = candidates
        .iter()
        .map(|(a, m)| json!({ "agent": agent_key(*a), "model": m }))
        .collect();
    json!({
        "kind": "routing_decision",
        "decision_id": decision_id,
        "task_flow": flow,
        "task_ref": task_ref,
        "router_source": router_source,
        "agent": agent_key(selected_agent),
        "model": selected_model,
        "rationale": trunc(Some(rationale), RATIONALE_MAX),
        "latency_ms": latency_ms,
        "fallback_used": fallback_used,
        "primary_router_if_fallback": primary_router_if_fallback,
        "candidates": candidates_json,
        "occurred_at": iso_utc(occurred_at),
    })
}

/// Emit a `routing_decision` event: which router picked which agent/model,
/// why, how fast, and whether a fallback was used.
#[allow(clippy::too_many_arguments)]
pub async fn emit_routing_decision(
    decision_id: &str,
    task_flow: &TaskFlow,
    task_ref: Option<&str>,
    router_source: &str,
    selected_agent: AgentKind,
    selected_model: &str,
    rationale: &str,
    latency_ms: u64,
    fallback_used: bool,
    primary_router_if_fallback: Option<&str>,
    candidates: &[(AgentKind, String)],
    occurred_at: DateTime<Utc>,
) -> Result<()> {
    let payload = payload_for_routing_decision(
        decision_id,
        task_flow,
        task_ref,
        router_source,
        selected_agent,
        selected_model,
        rationale,
        latency_ms,
        fallback_used,
        primary_router_if_fallback,
        candidates,
        occurred_at,
    );
    enqueue_payload(payload).await
}

fn payload_for_routing_failure(
    router_id: &str,
    failure_kind: RoutingFailureKind,
    fell_back_to: Option<&str>,
    user_visible: bool,
    latency_ms: u64,
    error_message: &str,
    occurred_at: DateTime<Utc>,
) -> Value {
    json!({
        "kind": "routing_failure",
        "router_id": router_id,
        "failure_kind": failure_kind.as_str(),
        "fell_back_to": fell_back_to,
        "user_visible": user_visible,
        "latency_ms": latency_ms,
        "error_message": trunc(Some(error_message), ERROR_MAX),
        "occurred_at": iso_utc(occurred_at),
    })
}

/// Emit a `routing_failure` event when a router errors or times out.
pub async fn emit_routing_failure(
    router_id: &str,
    failure_kind: RoutingFailureKind,
    fell_back_to: Option<&str>,
    user_visible: bool,
    latency_ms: u64,
    error_message: &str,
    occurred_at: DateTime<Utc>,
) -> Result<()> {
    enqueue_payload(payload_for_routing_failure(
        router_id,
        failure_kind,
        fell_back_to,
        user_visible,
        latency_ms,
        error_message,
        occurred_at,
    ))
    .await
}

fn payload_for_router_health_change(
    router_id: &str,
    from: HealthState,
    to: HealthState,
    occurred_at: DateTime<Utc>,
) -> Value {
    json!({
        "kind": "router_health_change",
        "router_id": router_id,
        "from": from.as_str(),
        "to": to.as_str(),
        "occurred_at": iso_utc(occurred_at),
    })
}

/// Emit a `router_health_change` event when a router transitions between
/// liveness states (healthy / degraded / unreachable).
pub async fn emit_router_health_change(
    router_id: &str,
    from: HealthState,
    to: HealthState,
    occurred_at: DateTime<Utc>,
) -> Result<()> {
    enqueue_payload(payload_for_router_health_change(
        router_id,
        from,
        to,
        occurred_at,
    ))
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trunc_caps_strings_at_n_chars() {
        assert_eq!(trunc(Some("hello"), 3), Some("hel".to_string()));
        assert_eq!(trunc(Some("hi"), 3), Some("hi".to_string()));
        assert_eq!(trunc(None, 10), None);
    }

    #[test]
    fn iso_utc_emits_offset_per_cloud_schema() {
        let dt = DateTime::<Utc>::from_timestamp(1_700_000_000, 0).unwrap();
        let s = iso_utc(dt);
        // Must contain offset (`Z` or `+00:00`) for the cloud's zod schema.
        assert!(s.ends_with("+00:00") || s.ends_with('Z'), "got {s}");
    }
}

#[cfg(test)]
mod routing_emitter_tests {
    use super::*;
    use chrono::TimeZone;
    use tokio::sync::Mutex;

    fn ts() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 5, 22, 12, 0, 0).unwrap()
    }

    // Same rationale as `outbox::tests::TEST_LOCK` — these tests share a
    // process-wide POOL OnceLock; serialise them through a tokio Mutex so
    // a `reset()` in one test doesn't race another's assertions.
    static TEST_LOCK: Mutex<()> = Mutex::const_new(());

    async fn ensure_outbox_inited() {
        let dir = tempfile::tempdir().unwrap();
        let _ = outbox::init_at(dir.path().join("ob.sqlite")).await;
        let _ = outbox::reset().await;
        // POOL holds the sqlite file open; leak `dir` so its Drop doesn't
        // try to delete the file mid-test.
        std::mem::forget(dir);
    }

    #[test]
    fn payload_routing_decision_shape_matches_schema() {
        let cands = vec![(AgentKind::Claude, "claude-haiku-4-5".to_string())];
        let flow = TaskFlow::Chat {
            session_id: "s1".into(),
        };
        let p = payload_for_routing_decision(
            "d-1",
            &flow,
            Some("s1"),
            "builtin",
            AgentKind::Claude,
            "claude-sonnet-4-6",
            "test rationale",
            42,
            false,
            None,
            &cands,
            ts(),
        );
        assert_eq!(p["kind"], "routing_decision");
        assert_eq!(p["decision_id"], "d-1");
        assert_eq!(p["task_flow"], "chat");
        assert_eq!(p["task_ref"], "s1");
        assert_eq!(p["router_source"], "builtin");
        assert_eq!(p["agent"], "claude");
        assert_eq!(p["model"], "claude-sonnet-4-6");
        assert_eq!(p["rationale"], "test rationale");
        assert_eq!(p["latency_ms"], 42);
        assert_eq!(p["fallback_used"], false);
        assert!(p["primary_router_if_fallback"].is_null());
        assert_eq!(p["candidates"][0]["agent"], "claude");
        assert_eq!(p["candidates"][0]["model"], "claude-haiku-4-5");
    }

    #[test]
    fn payload_routing_decision_truncates_rationale() {
        let long = "x".repeat(RATIONALE_MAX + 50);
        let flow = TaskFlow::Dispatch {
            task_id: "t1".into(),
        };
        let p = payload_for_routing_decision(
            "d-2",
            &flow,
            Some("t1"),
            "notdiamond",
            AgentKind::OpenAI,
            "gpt-4o",
            &long,
            10,
            true,
            Some("builtin"),
            &[],
            ts(),
        );
        assert_eq!(p["task_flow"], "dispatch");
        assert_eq!(p["fallback_used"], true);
        assert_eq!(p["primary_router_if_fallback"], "builtin");
        assert_eq!(
            p["rationale"].as_str().unwrap().chars().count(),
            RATIONALE_MAX
        );
    }

    #[test]
    fn payload_routing_failure_shape_matches_schema() {
        let p = payload_for_routing_failure(
            "notdiamond",
            RoutingFailureKind::Timeout,
            Some("builtin"),
            false,
            2000,
            "deadline elapsed",
            ts(),
        );
        assert_eq!(p["kind"], "routing_failure");
        assert_eq!(p["router_id"], "notdiamond");
        assert_eq!(p["failure_kind"], "timeout");
        assert_eq!(p["fell_back_to"], "builtin");
        assert_eq!(p["user_visible"], false);
        assert_eq!(p["latency_ms"], 2000);
        assert_eq!(p["error_message"], "deadline elapsed");
    }

    #[test]
    fn payload_router_health_change_shape_matches_schema() {
        let p = payload_for_router_health_change(
            "notdiamond",
            HealthState::Healthy,
            HealthState::Degraded,
            ts(),
        );
        assert_eq!(p["kind"], "router_health_change");
        assert_eq!(p["router_id"], "notdiamond");
        assert_eq!(p["from"], "healthy");
        assert_eq!(p["to"], "degraded");
    }

    #[tokio::test]
    async fn routing_decision_does_not_panic_and_returns_ok() {
        let _g = TEST_LOCK.lock().await;
        ensure_outbox_inited().await;
        let cands = vec![(AgentKind::Claude, "claude-haiku-4-5".to_string())];
        let flow = TaskFlow::Chat {
            session_id: "s1".into(),
        };
        let r = emit_routing_decision(
            "d-1",
            &flow,
            Some("s1"),
            "builtin",
            AgentKind::Claude,
            "claude-sonnet-4-6",
            "test rationale",
            42,
            false,
            None,
            &cands,
            ts(),
        )
        .await;
        assert!(r.is_ok(), "emit_routing_decision failed: {r:?}");
    }

    #[tokio::test]
    async fn routing_failure_does_not_panic() {
        let _g = TEST_LOCK.lock().await;
        ensure_outbox_inited().await;
        let r = emit_routing_failure(
            "notdiamond",
            RoutingFailureKind::Timeout,
            Some("builtin"),
            false,
            2000,
            "deadline elapsed",
            ts(),
        )
        .await;
        assert!(r.is_ok(), "emit_routing_failure failed: {r:?}");
    }

    #[tokio::test]
    async fn router_health_change_does_not_panic() {
        let _g = TEST_LOCK.lock().await;
        ensure_outbox_inited().await;
        let r = emit_router_health_change(
            "notdiamond",
            HealthState::Healthy,
            HealthState::Degraded,
            ts(),
        )
        .await;
        assert!(r.is_ok(), "emit_router_health_change failed: {r:?}");
    }

    #[tokio::test]
    async fn cost_with_decision_id_does_not_panic() {
        let _g = TEST_LOCK.lock().await;
        ensure_outbox_inited().await;
        let r = emit_cost(
            "s1",
            "claude-sonnet-4-6",
            100,
            200,
            0,
            0,
            0.001234,
            ts(),
            Some("d-1"),
        )
        .await;
        assert!(r.is_ok(), "emit_cost(Some) failed: {r:?}");
    }

    #[tokio::test]
    async fn cost_without_decision_id_does_not_panic() {
        let _g = TEST_LOCK.lock().await;
        ensure_outbox_inited().await;
        let r = emit_cost(
            "s1",
            "claude-sonnet-4-6",
            100,
            200,
            0,
            0,
            0.001234,
            ts(),
            None,
        )
        .await;
        assert!(r.is_ok(), "emit_cost(None) failed: {r:?}");
    }
}
