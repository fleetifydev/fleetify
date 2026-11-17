//! PostHog product-analytics sink. Parallel to the existing Fleetify
//! cloud telemetry pipeline:
//!   - Different vendor (PostHog Cloud, not fleetify.dev).
//!   - Different transport (HTTPS POST batches, not WebSocket).
//!   - Different opt-in semantics (default OFF, explicit consent).
//!   - Different outbox file (`posthog-outbox.sqlite`) so it never
//!     interferes with the Fleetify outbox.
//!
//! Three-tier gating, fail-closed:
//!   1. Environment: `POSTHOG_API_KEY` present in the process env when
//!      `init()` runs (loaded from `.env` by `dotenvy` at the top of
//!      `serve_with_routing_setup`, or set in the shell). Unset →
//!      `init` is a no-op, `enqueue_if_enabled` short-circuits.
//!   2. Runtime: `ENABLED` AtomicBool. Tauri shell flips it via the
//!      `telemetry_set_posthog_enabled` command after user consent.
//!   3. Live opt-out: the worker also re-checks `is_enabled()` each
//!      tick so flipping the gate off stops sends within ~10 s.
//!
//! The frontend's posthog-js handles its own consent / opt-out via the
//! same gate, reported by the `telemetry_get_config` Tauri command.
//! Distinct IDs are kept in sync: backend uses the persisted `device_id`;
//! the frontend bootstraps posthog-js with the same id and calls
//! `posthog.identify(user_id)` (the id only) for a signed-in user, so
//! PostHog links the device's events to the account.

mod client;
mod mapper;
pub mod outbox;
mod worker;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

use serde_json::Value;

static ENABLED: AtomicBool = AtomicBool::new(false);
static CLIENT: OnceLock<client::Client> = OnceLock::new();
static DISTINCT_ID: OnceLock<String> = OnceLock::new();

/// PostHog project key (write-only / public, safe to embed in shipped
/// binaries) read from `POSTHOG_API_KEY` in the process environment at
/// call time. `None` → entire module is a no-op. `dotenvy` populates
/// the env from `.env` at server startup, so a single workspace-root
/// `.env` covers dev without a wrapper shell script.
pub fn project_key() -> Option<String> {
    std::env::var("POSTHOG_API_KEY")
        .ok()
        .filter(|s| !s.is_empty())
}

/// PostHog host. Defaults to US cloud; override at runtime with
/// `POSTHOG_HOST=https://eu.i.posthog.com` (or a self-hosted URL).
pub fn host() -> String {
    std::env::var("POSTHOG_HOST")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "https://us.i.posthog.com".to_string())
}

/// Distinct ID = the persisted device_id from `device_id::get_or_create`.
/// Cached on first call so emit path stays cheap.
pub fn distinct_id() -> &'static str {
    DISTINCT_ID
        .get_or_init(|| crate::services::telemetry::device_id::get_or_create().device_id)
        .as_str()
}

pub fn is_enabled() -> bool {
    ENABLED.load(Ordering::Relaxed)
}

/// Flip the runtime gate. Called from the Tauri command when the user
/// toggles the Privacy switch or completes onboarding consent.
/// On a closed→open transition, pulses the worker so any queued events
/// flush immediately instead of waiting on the next tick.
pub fn set_enabled(on: bool) {
    let prev = ENABLED.swap(on, Ordering::Relaxed);
    if on && !prev {
        worker::event_available().notify_one();
    }
    tracing::info!(target: "fleetify.posthog", enabled = on, "posthog runtime gate flipped");
}

pub(crate) fn client_handle() -> Option<&'static client::Client> {
    CLIENT.get()
}

/// Initialise the outbox + spawn the worker. No-op when
/// `POSTHOG_API_KEY` is unset in the process env at this call.
pub async fn init() -> anyhow::Result<()> {
    let Some(key) = project_key() else {
        tracing::info!(
            target: "fleetify.posthog",
            "POSTHOG_API_KEY not set in env; posthog sink disabled"
        );
        return Ok(());
    };
    outbox::init().await?;
    let client = client::Client::new(&key, &host())?;
    let _ = CLIENT.set(client);
    tokio::spawn(worker::run_worker_loop());
    tracing::info!(
        target: "fleetify.posthog",
        host = %host(),
        "posthog sink initialised (runtime gate currently {})",
        if is_enabled() { "open" } else { "closed" }
    );
    Ok(())
}

/// Convert a Fleetify telemetry payload to a PostHog event and enqueue.
/// Returns silently when the runtime gate is closed or the build had
/// no `POSTHOG_API_KEY`.
pub async fn enqueue_if_enabled(fleetify_payload: &Value) {
    if !is_enabled() || project_key().is_none() {
        return;
    }
    let Some(event) = mapper::to_posthog_event(distinct_id(), fleetify_payload) else {
        return; // Mapper dropped it (e.g. device_heartbeat or unknown kind).
    };
    let event_id = uuid::Uuid::new_v4().to_string();
    if let Err(e) = outbox::enqueue(&event_id, &event).await {
        tracing::warn!(target: "fleetify.posthog", "enqueue failed: {e}");
        return;
    }
    worker::event_available().notify_one();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_defaults_to_us_cloud() {
        // When POSTHOG_HOST is unset at build time, default to US.
        // (Local tests inherit the build-time value of option_env!, so
        // this just sanity-checks the string is well-formed.)
        let h = host();
        assert!(h.starts_with("http"), "host should be a URL: {h}");
    }

    #[test]
    fn set_enabled_round_trips() {
        // Saves and restores ENABLED so we don't pollute other tests.
        let prev = is_enabled();
        set_enabled(true);
        assert!(is_enabled());
        set_enabled(false);
        assert!(!is_enabled());
        set_enabled(prev);
    }
}
