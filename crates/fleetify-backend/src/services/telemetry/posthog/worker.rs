//! Background drain loop for the PostHog outbox.
//!
//! Driven by either:
//!   - A pulse on `event_available()` (fires when an event is enqueued
//!     or the runtime gate flips on)
//!   - A 10-second tick (catches missed pulses + retries failed batches)
//!
//! On each iteration:
//!   1. If the runtime gate is closed → idle.
//!   2. Drop poison-pill rows (attempt_count >= POISON_THRESHOLD).
//!   3. Drain up to MAX_PER_BATCH events from the outbox.
//!   4. POST to PostHog /batch and translate the outcome into outbox ops.
//!
//! The notify is its own static (not shared with the WS client) so a
//! Fleetify cloud event doesn't wake the PostHog worker for no reason
//! and vice versa.

use std::sync::OnceLock;
use std::time::Duration;

use tokio::sync::Notify;

use super::client::BatchOutcome;
use super::{client_handle, is_enabled, outbox};

const TICK: Duration = Duration::from_secs(10);
const MAX_PER_BATCH: i64 = 100;
const POISON_THRESHOLD: i64 = 10;

/// Pulse this when a new PostHog event is ready to send (or the runtime
/// gate is opened). Independent of `emitters::event_available` so the
/// two pipelines don't cross-wake.
pub fn event_available() -> &'static Notify {
    static N: OnceLock<Notify> = OnceLock::new();
    N.get_or_init(Notify::new)
}

pub async fn run_worker_loop() {
    loop {
        tokio::select! {
            _ = event_available().notified() => {}
            _ = tokio::time::sleep(TICK) => {}
        }
        if !is_enabled() {
            continue;
        }
        if let Err(e) = drain_once().await {
            tracing::warn!(target: "fleetify.posthog", "drain failed: {e}");
        }
    }
}

async fn drain_once() -> anyhow::Result<()> {
    let Some(client) = client_handle() else {
        return Ok(());
    };
    let dropped = outbox::drop_poison(POISON_THRESHOLD).await.unwrap_or(0);
    if dropped > 0 {
        tracing::warn!(
            target: "fleetify.posthog",
            "dropped {dropped} poison events (attempt_count >= {POISON_THRESHOLD})"
        );
    }
    let pending = outbox::peek_pending(MAX_PER_BATCH).await?;
    if pending.is_empty() {
        return Ok(());
    }
    let (ids, events): (Vec<String>, Vec<serde_json::Value>) = pending.into_iter().unzip();
    let count = ids.len();
    match client.send_batch(events).await {
        BatchOutcome::Acked => {
            outbox::mark_acked(&ids).await?;
            tracing::debug!(target: "fleetify.posthog", "acked {count} events");
        }
        BatchOutcome::Poison(msg) => {
            tracing::warn!(
                target: "fleetify.posthog",
                count,
                "posthog rejected batch (4xx): {msg}; dropping"
            );
            outbox::mark_acked(&ids).await?;
        }
        BatchOutcome::Retry(msg) => {
            tracing::warn!(
                target: "fleetify.posthog",
                count,
                "posthog transient failure: {msg}; will retry"
            );
            outbox::bump_attempts(&ids).await?;
        }
    }
    Ok(())
}
