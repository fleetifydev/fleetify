//! Process-wide admission control for dispatched agent CLI turns.
//!
//! Fleetify can fan out an arbitrary number of dispatched / spawned /
//! delegated agents from a single staff turn or a Fleet "delegate a goal"
//! action. Each agent launches a provider CLI (claude / codex / gemini) — a
//! 150–400 MB Node/V8 process. With no cap, ~20 of them start in the same
//! instant and OOM / thrash a 2–4 GB machine (see optimization/stability
//! findings S1/S7).
//!
//! This module gates every *dispatched* turn (`run_dispatched_task_internal`)
//! behind one global semaphore, so at most `max_concurrent_agents` heavy CLI
//! turns run simultaneously and the rest queue. The user's own FOREGROUND
//! turn (`run_send_flow`) is intentionally NOT gated — direct interaction must
//! stay responsive.
//!
//! Sizing: `FLEETIFY_MAX_CONCURRENT_AGENTS` env override, else a CPU-count
//! proxy clamped to a conservative [2, 6] so a low-RAM box never admits more
//! heavy CLIs than it can hold. Tune it down (e.g. `=3`) on a 2 GB machine or
//! up on a workstation.

use std::sync::LazyLock;
use std::time::Duration;

use tokio::sync::{Semaphore, SemaphorePermit};

/// Max time a queued turn waits for a slot before proceeding anyway
/// (fail-open). This is a deadlock-breaker, not a normal path: turns free
/// their permit in seconds-to-minutes, so this only fires in a pathological
/// backlog — and there, degrading to un-throttled beats hanging the agent
/// forever. Matches the spirit of the existing per-run turn timeout.
const ACQUIRE_TIMEOUT: Duration = Duration::from_secs(600);

/// Default cap when the env override is unset. CPU count is a rough capacity
/// proxy; the clamp keeps it small enough for the low-RAM target regardless of
/// core count.
fn default_max_concurrent() -> usize {
    std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .clamp(2, 6)
}

fn max_concurrent_agents() -> usize {
    std::env::var("FLEETIFY_MAX_CONCURRENT_AGENTS")
        .ok()
        .and_then(|v| v.trim().parse::<usize>().ok())
        .filter(|n| *n >= 1)
        .unwrap_or_else(default_max_concurrent)
}

static ADMISSION: LazyLock<Semaphore> = LazyLock::new(|| {
    let n = max_concurrent_agents();
    tracing::info!(
        target: "fleetify::admission",
        max_concurrent_agents = n,
        "agent admission control armed"
    );
    Semaphore::new(n)
});

/// Acquire a permit for one dispatched agent turn. Hold the returned guard for
/// the duration of the CLI turn; dropping it (when the turn's function returns)
/// frees the slot for the next queued turn.
///
/// Returns `None` (fail-open — no throttle) if the wait exceeds
/// [`ACQUIRE_TIMEOUT`] or the semaphore is ever closed, so a turn can never be
/// blocked forever on admission.
pub async fn acquire_agent_permit() -> Option<SemaphorePermit<'static>> {
    match tokio::time::timeout(ACQUIRE_TIMEOUT, ADMISSION.acquire()).await {
        Ok(Ok(permit)) => Some(permit),
        Ok(Err(_closed)) => None,
        Err(_elapsed) => {
            tracing::warn!(
                target: "fleetify::admission",
                timeout_secs = ACQUIRE_TIMEOUT.as_secs(),
                "admission wait timed out; proceeding without a permit (fail-open)"
            );
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_cap_is_clamped() {
        let n = default_max_concurrent();
        assert!((2..=6).contains(&n), "default cap {n} out of [2,6]");
    }

    #[tokio::test]
    async fn permit_is_acquired_and_released_on_drop() {
        // The global semaphore has >=2 permits, so two sequential acquires
        // both succeed and dropping frees the slot.
        let p1 = acquire_agent_permit().await;
        assert!(p1.is_some());
        drop(p1);
        let p2 = acquire_agent_permit().await;
        assert!(p2.is_some());
    }
}
