//! Event extraction layer — the ONLY path from local agent loop to
//! cloud. Faithful subset of `services/telemetry/emitters.py`.
//!
//! Each `emit_*` function:
//!   1. Truncates user-supplied strings to wire-safe lengths.
//!   2. Generates a client-assigned UUID v4 to identify the event.
//!   3. While cloud sync is on (`cloud_gate`), persists the event's
//!      `cloud_view` via `outbox::enqueue`.
//!   4. Pulses `event_available` so the WS client flushes the new event
//!      immediately instead of waiting on its poll cadence.
//!
//! Privacy tier for the cloud: session titles and project folder names
//! allowed; never activity summaries, full paths, prompt / file content
//! or command stdio.

use std::path::Path;
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

/// The copy of a payload the Fleetify cloud gets. Drops
/// `activity_summary` (agent shell commands, file paths, URLs, search
/// queries, sub-agent prompts, todo text), which the dashboard never
/// shows. Cuts `project_path` to its last component: the full path
/// carries the OS user name, and the dashboard shows only a short label.
/// The home folder itself becomes `~`, since its own name is usually the
/// OS user name. A path with no component left (empty, `null`, not a
/// string) becomes `null`; a payload without the key stays without it.
/// Every other key is unchanged.
pub(crate) fn cloud_view(payload: &Value) -> Value {
    cloud_view_for_home(payload, &fleetify_core::user_home())
}

/// `cloud_view` against a given home folder.
fn cloud_view_for_home(payload: &Value, home: &Path) -> Value {
    let mut view = payload.clone();
    if let Some(fields) = view.as_object_mut() {
        fields.remove("activity_summary");
        if let Some(path) = fields.get_mut("project_path") {
            *path = match path.as_str() {
                Some(p) if is_home_folder(p, home, cfg!(windows)) => Value::from("~"),
                p => project_folder(p).map_or(Value::Null, Value::from),
            };
        }
    }
    view
}

/// Whether `path` is the home folder itself, trailing separators ignored.
/// On Windows (`windows`) case doesn't count and `/` matches `\`, as in the
/// file system.
fn is_home_folder(path: &str, home: &Path, windows: bool) -> bool {
    let normalise = |p: &str| {
        let p = p.trim_end_matches(['/', '\\']);
        if windows {
            p.replace('\\', "/").to_lowercase()
        } else {
            p.to_string()
        }
    };
    let path = normalise(path);
    !path.is_empty() && path == normalise(&home.to_string_lossy())
}

/// Last component of a path, split on `/` and `\` alike, trailing
/// separators ignored. `None` when nothing is left.
fn project_folder(path: Option<&str>) -> Option<&str> {
    path?
        .trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .next()
        .filter(|folder| !folder.is_empty())
}

async fn enqueue_payload(payload: Value) -> Result<()> {
    // No-auth dev mode: never enqueue. The WS client and heartbeat loop
    // are also skipped at startup, so without this guard the outbox
    // would grow unbounded with no consumer.
    if crate::auth::is_no_auth() {
        return Ok(());
    }
    let cloud = if super::cloud_enabled() {
        enqueue_for_cloud(&payload).await
    } else {
        Ok(())
    };
    // Fan out to the PostHog sink whatever the cloud gate says: it has its
    // own consent gate, and its mapper hashes the full project path and
    // drops summaries, so it gets the original payload. No-op when its
    // gate is closed or POSTHOG_API_KEY is unset.
    super::posthog::enqueue_if_enabled(&payload).await;
    cloud
}

async fn enqueue_for_cloud(payload: &Value) -> Result<()> {
    let event_id = uuid::Uuid::new_v4().to_string();
    outbox::enqueue(&event_id, &cloud_view(payload)).await?;
    if !super::cloud_enabled() {
        // Sync was turned off while this row was being written, and the
        // purge may have run before it landed. Drop it so nothing stays
        // queued.
        outbox::mark_acked(&event_id).await?;
        return Ok(());
    }
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
    // The model catalog this device is actually serving. A staged rollout can't
    // be operated blind — without a version distribution across the fleet you
    // can't tell a release that reached 5% of devices from one that reached
    // everybody, and you can't spot a slice stuck on an old snapshot. Both
    // fields are absent until the first successful pointer probe (offline
    // first-run), which is itself the signal "this device has never reached the
    // catalog". Carries no content — just an identity the cloud published.
    let catalog = crate::routers::providers::active_catalog_version().await;
    enqueue_payload(json!({
        "kind": "device_heartbeat",
        "occurred_at": iso_utc(occurred_at),
        "catalog_commit": catalog.commit,
        "catalog_tag": catalog.tag,
        // Our staged-rollout slice, so the cloud can tell which catalog we
        // SHOULD be on without re-deriving the hash server-side — two
        // implementations of it in two languages would eventually disagree and
        // push devices into the wrong slice.
        "catalog_bucket": crate::routers::providers::device_rollout_bucket(),
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

// `agent_key` + the three `payload_for_*` helpers below are kept in
// place for when the cloud telemetry ingest learns the new event kinds
// (`routing_decision`, `routing_failure`, `router_health_change`) and we
// switch the public emit_* functions back to the `enqueue_payload`
// path. Right now those emit_* live-call `tracing` to avoid the NACK
// loop, so the helpers look dead to clippy.
#[allow(dead_code)]
fn agent_key(a: AgentKind) -> &'static str {
    match a {
        AgentKind::Claude => "claude-code",
        AgentKind::OpenAI => "openai",
        AgentKind::Gemini => "gemini-api",
        AgentKind::Codex => "codex-cli",
        AgentKind::Kimi => "kimi-code",
        AgentKind::GitHubCopilot => "github-copilot",
    }
}

/// Build the JSON payload for a `routing_decision` event. Pure: no side
/// effects, no privacy guard — `emit_routing_decision` wraps this with
/// `enqueue_payload`.
#[allow(dead_code)]
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
///
/// **Local-only.** The cloud telemetry ingest currently rejects this
/// `kind` ("Invalid option: expected one of session_start | session_stop |
/// cost | status_change | activity | device_heartbeat") and the outbox
/// would otherwise retry the NACK'd event on every flush — turning the
/// log into an infinite loop. Until the cloud schema picks up the new
/// kinds, we record the decision via `tracing` (always available, no
/// retry loop) and store it in the local `routing_decisions` SQLite
/// table for in-app analytics. The function signature stays unchanged
/// so callers don't need updates when the cloud path lands later.
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
    _candidates: &[(AgentKind, String)],
    _occurred_at: DateTime<Utc>,
) -> Result<()> {
    tracing::info!(
        target: "fleetify.routing",
        decision_id = %decision_id,
        task_flow = ?task_flow,
        task_ref = ?task_ref,
        router_source = %router_source,
        agent = ?selected_agent,
        model = %selected_model,
        latency_ms = latency_ms,
        fallback_used = fallback_used,
        primary_router_if_fallback = ?primary_router_if_fallback,
        rationale = %trunc(Some(rationale), RATIONALE_MAX).unwrap_or_default(),
        "routing decision"
    );
    Ok(())
}

#[allow(dead_code)]
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
/// **Local-only** — see `emit_routing_decision` for the rationale.
pub async fn emit_routing_failure(
    router_id: &str,
    failure_kind: RoutingFailureKind,
    fell_back_to: Option<&str>,
    user_visible: bool,
    latency_ms: u64,
    error_message: &str,
    _occurred_at: DateTime<Utc>,
) -> Result<()> {
    tracing::warn!(
        target: "fleetify.routing",
        router_id = %router_id,
        failure_kind = failure_kind.as_str(),
        fell_back_to = ?fell_back_to,
        user_visible = user_visible,
        latency_ms = latency_ms,
        error_message = %trunc(Some(error_message), ERROR_MAX).unwrap_or_default(),
        "routing failure"
    );
    Ok(())
}

#[allow(dead_code)]
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
/// liveness states. **Local-only** — see `emit_routing_decision`.
pub async fn emit_router_health_change(
    router_id: &str,
    from: HealthState,
    to: HealthState,
    _occurred_at: DateTime<Utc>,
) -> Result<()> {
    tracing::info!(
        target: "fleetify.routing",
        router_id = %router_id,
        from = from.as_str(),
        to = to.as_str(),
        "router health change"
    );
    Ok(())
}

// ─── Provider / agent telemetry ───
//
// Wire surface: `emit_provider_test_connection` / `emit_provider_connected` /
// `emit_provider_disconnected` / `emit_agent_detected`. The Fleetify cloud
// telemetry ingest doesn't recognise these `kind`s yet, so we route via
// `tracing` (always available, no outbox retry loop) AND fan out directly
// to the PostHog sink — bypassing `enqueue_payload` / the Fleetify outbox
// because PostHog has no schema-side rejection, so it's safe to enqueue
// without risking a NACK loop on the cloud side.

/// Settings → Models "Test Connection" result. Captures latency + the
/// failure-mode bucket so we can spot patterns like "DeepSeek auth fails
/// the most" without sending the user's key anywhere.
pub async fn emit_provider_test_connection(
    provider_id: &str,
    ok: bool,
    code: Option<&str>,
    latency_ms: Option<u64>,
) {
    tracing::info!(
        target: "fleetify.providers",
        provider = %provider_id,
        ok = ok,
        code = ?code,
        latency_ms = ?latency_ms,
        "provider test connection"
    );
    super::posthog::enqueue_if_enabled(&json!({
        "kind": "provider_test_connection",
        "provider": provider_id,
        "ok": ok,
        "code": code,
        "latency_ms": latency_ms,
        "occurred_at": iso_utc(Utc::now()),
    }))
    .await;
}

/// User saved a key for a provider in Settings → Models. Fires AFTER
/// the keychain write + config update succeed.
pub async fn emit_provider_connected(provider_id: &str) {
    tracing::info!(
        target: "fleetify.providers",
        provider = %provider_id,
        "provider connected"
    );
    super::posthog::enqueue_if_enabled(&json!({
        "kind": "provider_connected",
        "provider": provider_id,
        "occurred_at": iso_utc(Utc::now()),
    }))
    .await;
}

/// User clicked Disconnect on a provider tile. Mirrors the connected
/// event so dashboards can pair them up by `provider`.
pub async fn emit_provider_disconnected(provider_id: &str) {
    tracing::info!(
        target: "fleetify.providers",
        provider = %provider_id,
        "provider disconnected"
    );
    super::posthog::enqueue_if_enabled(&json!({
        "kind": "provider_disconnected",
        "provider": provider_id,
        "occurred_at": iso_utc(Utc::now()),
    }))
    .await;
}

/// `/api/agents/scan` observation. Lets us see how often "installed
/// but not authenticated" shows up in the wild — likely an onboarding
/// friction point that wants a better login UX.
pub async fn emit_agent_detected(agent_id: &str, installed: bool, authenticated: bool) {
    tracing::info!(
        target: "fleetify.providers",
        agent = %agent_id,
        installed = installed,
        authenticated = authenticated,
        "agent detected"
    );
    super::posthog::enqueue_if_enabled(&json!({
        "kind": "agent_detected",
        "agent": agent_id,
        "installed": installed,
        "authenticated": authenticated,
        "occurred_at": iso_utc(Utc::now()),
    }))
    .await;
}

/// Backend lifecycle. Fired once at server boot AFTER posthog::init so
/// the very first event in a session captures version + OS. Routed
/// directly to PostHog (the Fleetify cloud schema doesn't know this
/// kind) so it doesn't NACK in the existing outbox.
pub async fn emit_app_started(version: &str, platform: &str) {
    tracing::info!(
        target: "fleetify.lifecycle",
        version = version,
        platform = platform,
        "app started"
    );
    super::posthog::enqueue_if_enabled(&json!({
        "kind": "app_started",
        "version": version,
        "platform": platform,
        "occurred_at": iso_utc(Utc::now()),
    }))
    .await;
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
mod cloud_sync_tests {
    use super::*;
    use crate::services::telemetry::cloud_gate::test_support::GateGuard;
    use crate::services::telemetry::set_cloud_enabled;

    async fn pending_for(session_id: &str) -> Vec<Value> {
        outbox::peek_pending(1_000)
            .await
            .unwrap()
            .into_iter()
            .map(|(_, p)| p)
            .filter(|p| p["local_session_id"] == session_id)
            .collect()
    }

    #[test]
    fn cloud_view_drops_activity_summary_and_keeps_only_the_project_folder() {
        let activity = json!({
            "kind": "activity",
            "activity_kind": "bash",
            "activity_summary": "export TOKEN=x",
        });
        let v = cloud_view(&activity);
        assert!(v.get("activity_summary").is_none(), "summary sent: {v}");
        assert_eq!(v["activity_kind"], "bash");
        assert_eq!(v["kind"], "activity");

        let folder =
            |path: Value| cloud_view(&json!({ "project_path": path }))["project_path"].clone();
        assert_eq!(folder(json!("/home/u/work/fleetify")), json!("fleetify"));
        assert_eq!(folder(json!("/home/u/work/fleetify/")), json!("fleetify"));
        assert_eq!(folder(json!("C:\\Users\\u\\proj")), json!("proj"));
        assert_eq!(folder(json!("")), Value::Null);
        assert_eq!(folder(Value::Null), Value::Null);

        // The home folder itself goes out as `~`: its name is usually the
        // OS user name, and the Fleet hub's own session runs there.
        let label = |path: Value| {
            cloud_view_for_home(&json!({ "project_path": path }), Path::new("/home/u"))
                ["project_path"]
                .clone()
        };
        assert_eq!(label(json!("/home/u")), json!("~"));
        assert_eq!(label(json!("/home/u/")), json!("~"));
        // Folders under home keep their names, even one named like the user.
        assert_eq!(label(json!("/home/u/work/fleetify")), json!("fleetify"));
        assert_eq!(label(json!("/home/u/u")), json!("u"));
        // Only the home folder itself: not a sibling that starts the same.
        assert_eq!(label(json!("/home/user")), json!("user"));
        assert_eq!(label(json!("")), Value::Null);
        // Case and separator style count off Windows, not on it.
        assert!(!is_home_folder("/home/U", Path::new("/home/u"), false));
        assert!(is_home_folder(
            "C:\\Users\\U\\",
            Path::new("c:\\users\\u"),
            true
        ));
        assert!(is_home_folder(
            "C:/Users/U",
            Path::new("C:\\Users\\U"),
            true
        ));
        assert!(!is_home_folder(
            "C:\\Users\\U\\proj",
            Path::new("C:\\Users\\U"),
            true
        ));
        assert!(!is_home_folder("", Path::new(""), false));
        // `cloud_view` compares against the real home folder.
        let home = fleetify_core::user_home();
        assert_eq!(folder(json!(home.to_string_lossy())), json!("~"));

        let start = json!({
            "kind": "session_start",
            "local_session_id": "s1",
            "tool": "claude-code",
            "model": "claude-sonnet-4-6",
            "status": "running",
            "session_title": "Fix the flaky build",
            "project_path": "/home/u/work/fleetify",
            "occurred_at": "2026-11-17T10:00:00+00:00",
        });
        let v = cloud_view(&start);
        for key in [
            "kind",
            "local_session_id",
            "tool",
            "model",
            "status",
            "session_title",
            "occurred_at",
        ] {
            assert_eq!(v[key], start[key], "{key} changed");
        }
        assert_eq!(
            v.as_object().unwrap().len(),
            start.as_object().unwrap().len(),
            "keys added or lost: {v}"
        );
    }

    #[tokio::test]
    async fn enqueue_skips_the_cloud_outbox_while_the_gate_is_closed() {
        let _g = outbox::tests::TEST_LOCK.lock().await;
        outbox::tests::ensure_inited().await;
        let _gate = GateGuard::new();

        set_cloud_enabled(false).await;
        let before = outbox::count().await.unwrap();
        emit_status_change("s-gate-closed", "running", Utc::now())
            .await
            .unwrap();
        assert_eq!(
            outbox::count().await.unwrap(),
            before,
            "a closed gate must not queue cloud events"
        );

        set_cloud_enabled(true).await;
        emit_status_change("s-gate-open", "running", Utc::now())
            .await
            .unwrap();
        // Count this test's row rather than the whole table: other modules'
        // tests may emit while the gate is open here.
        assert_eq!(
            pending_for("s-gate-open").await.len(),
            1,
            "an open gate queues the event once"
        );
        assert!(outbox::count().await.unwrap() > before);
    }

    #[tokio::test]
    async fn cloud_outbox_rows_never_contain_activity_summaries() {
        let _g = outbox::tests::TEST_LOCK.lock().await;
        outbox::tests::ensure_inited().await;
        let _gate = GateGuard::new();

        set_cloud_enabled(true).await;
        emit_activity("s-summary", "command", Some("rm -rf secret"), Utc::now())
            .await
            .unwrap();

        let rows = pending_for("s-summary").await;
        assert_eq!(rows.len(), 1, "the activity event was queued");
        assert_eq!(rows[0]["activity_kind"], "command");
        assert!(
            rows[0].get("activity_summary").is_none(),
            "summary queued for the cloud: {}",
            rows[0]
        );
    }
}

#[cfg(test)]
mod routing_emitter_tests {
    use super::*;
    use crate::services::telemetry::cloud_gate::test_support::GateGuard;
    use crate::services::telemetry::set_cloud_enabled;
    use chrono::TimeZone;

    fn ts() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 5, 22, 12, 0, 0).unwrap()
    }

    // These tests share the process-wide POOL OnceLock and the cloud-sync
    // gate with the outbox and gate tests, so they take the same lock
    // (`outbox::tests::TEST_LOCK`): a `reset()` or a gate flip in one test
    // must not race another's assertions.
    use super::outbox::tests::TEST_LOCK;

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
        assert_eq!(p["agent"], "claude-code");
        assert_eq!(p["model"], "claude-sonnet-4-6");
        assert_eq!(p["rationale"], "test rationale");
        assert_eq!(p["latency_ms"], 42);
        assert_eq!(p["fallback_used"], false);
        assert!(p["primary_router_if_fallback"].is_null());
        assert_eq!(p["candidates"][0]["agent"], "claude-code");
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
        // Open the cloud gate so the event still reaches the outbox write.
        let _gate = GateGuard::new();
        set_cloud_enabled(true).await;
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
        // Open the cloud gate so the event still reaches the outbox write.
        let _gate = GateGuard::new();
        set_cloud_enabled(true).await;
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
