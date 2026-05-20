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

pub const TITLE_MAX: usize = 200;
pub const PATH_MAX: usize = 512;
pub const SUMMARY_MAX: usize = 256;

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
) -> Result<()> {
    enqueue_payload(json!({
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
    }))
    .await
}

pub async fn emit_status_change(
    session_id: &str,
    status: &str,
    when: DateTime<Utc>,
) -> Result<()> {
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
