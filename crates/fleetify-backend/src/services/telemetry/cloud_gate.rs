//! Runtime gate for the Fleetify-cloud channel: the account-authenticated
//! WebSocket that feeds the user's fleetify.dev dashboard. Settings →
//! Privacy flips it through the shell's `telemetry_set_cloud_enabled`
//! command, and the shell restores the saved choice at startup.
//!
//! The gate starts closed, so nothing is queued or sent before the shell
//! has restored the user's choice. While it is closed:
//! - `emitters::enqueue_payload` writes nothing to the cloud outbox;
//! - `ws_client::run_ws_client_loop` fetches no bearer, requests no ticket
//!   and holds no socket;
//! - the outbox stays empty, because every close purges it.
//!
//! The PostHog sink has its own consent gate (`posthog::set_enabled`);
//! this one does not touch it.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

use tokio::sync::Notify;

use super::outbox;

static CLOUD_ENABLED: AtomicBool = AtomicBool::new(false);

pub fn cloud_enabled() -> bool {
    CLOUD_ENABLED.load(Ordering::SeqCst)
}

/// Turn cloud sync on or off: store the flag, purge the outbox when off,
/// then wake the WS loop so it connects or drops its socket.
///
/// Every `false` purges, not only an on→off change: the startup restore of
/// a closed gate also clears rows that older builds queued while the
/// channel was always on.
pub async fn set_cloud_enabled(on: bool) {
    CLOUD_ENABLED.store(on, Ordering::SeqCst);
    if !on {
        purge_outbox().await;
    }
    gate_changed().notify_waiters();
    tracing::info!(target: "fleetify.telemetry", enabled = on, "cloud sync gate set");
}

async fn purge_outbox() {
    if !outbox::is_initialised() {
        // No-auth dev mode or a failed init: nothing can have been queued.
        tracing::debug!(
            target: "fleetify.telemetry",
            "cloud sync off: outbox not open, nothing to purge"
        );
        return;
    }
    if let Err(e) = outbox::reset().await {
        tracing::warn!(
            target: "fleetify.telemetry",
            "cloud sync off: purging the outbox failed: {e}"
        );
    }
}

/// Pulsed with `notify_waiters()` after every gate change. A `notified()`
/// future receives that pulse from the moment it is created, so create it
/// before checking `cloud_enabled()`: a change landing between the check
/// and the await then still wakes the waiter.
pub(crate) fn gate_changed() -> &'static Notify {
    static N: OnceLock<Notify> = OnceLock::new();
    N.get_or_init(Notify::new)
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::*;

    /// Puts the gate back the way it was when the guard was made. It does
    /// so on drop, so also when the test panics: a failing test can't
    /// leave the gate open for the next one. A plain store, no purge.
    pub(crate) struct GateGuard(bool);

    impl GateGuard {
        pub(crate) fn new() -> Self {
            Self(cloud_enabled())
        }
    }

    impl Drop for GateGuard {
        fn drop(&mut self) {
            CLOUD_ENABLED.store(self.0, Ordering::SeqCst);
            gate_changed().notify_waiters();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::GateGuard;
    use super::*;
    use crate::services::telemetry::emitters;

    async fn pending_for(session_id: &str) -> usize {
        outbox::peek_pending(1_000)
            .await
            .unwrap()
            .iter()
            .filter(|(_, p)| p["local_session_id"] == session_id)
            .count()
    }

    #[tokio::test]
    async fn closing_the_gate_purges_pending_events() {
        let _g = outbox::tests::TEST_LOCK.lock().await;
        outbox::tests::ensure_inited().await;
        let _gate = GateGuard::new();

        set_cloud_enabled(true).await;
        let now = chrono::Utc::now();
        emitters::emit_status_change("s-purge", "running", now)
            .await
            .unwrap();
        emitters::emit_status_change("s-purge", "idle", now)
            .await
            .unwrap();
        assert_eq!(pending_for("s-purge").await, 2, "both events queued");

        set_cloud_enabled(false).await;
        assert_eq!(
            outbox::count().await.unwrap(),
            0,
            "turning sync off leaves nothing queued"
        );
    }
}
