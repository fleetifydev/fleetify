//! PostHog product-analytics sink. Parallel to the existing Fleetify
//! cloud telemetry pipeline:
//!   - Different vendor (PostHog Cloud, not fleetify.dev).
//!   - Different transport (HTTPS POST batches, not WebSocket).
//!   - Different opt-in semantics (default OFF, explicit consent).
//!   - Different outbox file (`posthog-outbox.sqlite`) so it never
//!     interferes with the Fleetify outbox.
//!
//! Three-tier gating, fail-closed:
//!   1. Key: a project key when `init()` runs ([`project_key`]):
//!      `POSTHOG_API_KEY` from the process env (set in the shell, or in
//!      debug builds loaded from `.env` by `dotenvy` at the top of
//!      `serve`), else the one compiled in from `POSTHOG_API_KEY` at build
//!      time, which CI release builds get from the repository variable.
//!      Neither → `init` is a no-op, `enqueue_if_enabled` short-circuits.
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

/// The project key compiled in from `POSTHOG_API_KEY` at build time.
/// CI release builds get it from the repository variable: a public,
/// write-only `phc_` key, safe to embed in shipped binaries.
const COMPILED_KEY: Option<&str> = option_env!("POSTHOG_API_KEY");

// Only a public project key may ship in the binary: any other key in the
// build environment, such as a personal API key (`phx_…`), fails the build.
const _: () = assert!(
    may_compile_in(COMPILED_KEY),
    "POSTHOG_API_KEY at build time must be a public PostHog project key (phc_...)"
);

/// Whether `key` may be compiled in: none, an empty one, or a public
/// project key, which starts with `phc_`.
const fn may_compile_in(key: Option<&str>) -> bool {
    match key {
        None => true,
        Some(key) => key.is_empty() || starts_with(key.as_bytes(), b"phc_"),
    }
}

/// Whether `bytes` starts with `prefix`, in a `const fn`.
const fn starts_with(bytes: &[u8], prefix: &[u8]) -> bool {
    if bytes.len() < prefix.len() {
        return false;
    }
    let mut i = 0;
    while i < prefix.len() {
        if bytes[i] != prefix[i] {
            return false;
        }
        i += 1;
    }
    true
}

/// The host compiled in from `POSTHOG_HOST` at build time.
const COMPILED_HOST: Option<&str> = option_env!("POSTHOG_HOST");

/// The runtime value when set and non-empty, else the compiled-in one when
/// non-empty.
pub(crate) fn first_non_empty(runtime: Option<String>, compiled: Option<&str>) -> Option<String> {
    runtime.filter(|value| !value.is_empty()).or_else(|| {
        compiled
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    })
}

/// PostHog project key (write-only / public, safe to embed in shipped
/// binaries): `POSTHOG_API_KEY` from the process environment at call
/// time, else the one compiled in (`COMPILED_KEY`). `None` → entire
/// module is a no-op. In debug builds `dotenvy` populates the env from
/// `.env` at server startup, so a single workspace-root `.env` covers dev
/// without a wrapper shell script.
pub fn project_key() -> Option<String> {
    first_non_empty(std::env::var("POSTHOG_API_KEY").ok(), COMPILED_KEY)
}

/// The default PostHog host: PostHog Cloud's EU region. The renderer
/// keeps the same default in `src/lib/posthog.ts`.
pub const DEFAULT_HOST: &str = "https://eu.i.posthog.com";

/// PostHog host: `POSTHOG_HOST` from the process environment at call
/// time, else the one compiled in (`COMPILED_HOST`), else
/// [`DEFAULT_HOST`]; an empty value counts as unset. A project in
/// PostHog's US region, or a self-hosted instance, sets `POSTHOG_HOST`
/// to its own URL.
pub fn host() -> String {
    first_non_empty(std::env::var("POSTHOG_HOST").ok(), COMPILED_HOST)
        .unwrap_or_else(|| DEFAULT_HOST.to_string())
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

/// Initialise the outbox + spawn the worker. No-op without a project
/// key ([`project_key`]): `POSTHOG_API_KEY` unset in the process env at
/// this call, and at build time.
pub async fn init() -> anyhow::Result<()> {
    let Some(key) = project_key() else {
        tracing::info!(
            target: "fleetify.posthog",
            "POSTHOG_API_KEY set neither in env nor at build time; posthog sink disabled"
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
/// Returns silently when the runtime gate is closed or there is no
/// project key ([`project_key`]).
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
    fn runtime_value_wins_then_the_compiled_one() {
        let s = |v: &str| Some(v.to_string());
        assert_eq!(first_non_empty(s("a"), Some("b")), s("a"));
        assert_eq!(first_non_empty(s("a"), None), s("a"));
        // A release build started without the variable: the compiled value.
        assert_eq!(first_non_empty(None, Some("b")), s("b"));
        // Empty counts as unset, at run time and at build time.
        assert_eq!(first_non_empty(s(""), Some("b")), s("b"));
        assert_eq!(first_non_empty(s(""), Some("")), None);
        assert_eq!(first_non_empty(None, Some("")), None);
        assert_eq!(first_non_empty(None, None), None);
    }

    #[test]
    fn only_a_public_project_key_may_be_compiled_in() {
        assert!(may_compile_in(None));
        assert!(may_compile_in(Some("")));
        assert!(may_compile_in(Some("phc_abc123")));
        // A personal API key (phx_), or anything else, fails the build.
        for key in ["phx_abc123", "phc", "PHC_abc123", " phc_abc123", "abc_phc_"] {
            assert!(!may_compile_in(Some(key)), "{key:?}");
        }
        // The key this build compiled in passed the same check.
        assert!(may_compile_in(COMPILED_KEY));
    }

    #[test]
    fn host_defaults_to_eu() {
        // POSTHOG_HOST is process-wide: change it only under the crate's
        // env lock, and put back whatever was there before asserting.
        let _g = crate::test_support::home_lock()
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let prev = std::env::var_os("POSTHOG_HOST");
        std::env::remove_var("POSTHOG_HOST");
        let unset = host();
        std::env::set_var("POSTHOG_HOST", "");
        let empty = host();
        match prev {
            Some(v) => std::env::set_var("POSTHOG_HOST", v),
            None => std::env::remove_var("POSTHOG_HOST"),
        }
        // A build made with POSTHOG_HOST set falls back to that host.
        let want = COMPILED_HOST
            .filter(|h| !h.is_empty())
            .unwrap_or(DEFAULT_HOST);
        assert_eq!(unset, want);
        assert_eq!(empty, want);
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
