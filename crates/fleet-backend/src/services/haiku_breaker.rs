//! Haiku circuit breaker. Faithful port of `services/haiku_breaker.py`.
//!
//! Every meta-LLM call (task enricher, auto planner, query expander,
//! session summarizer, dump_session_memory) goes through Haiku. When
//! the Anthropic API is slow, rate-limited, or the user's API key is
//! missing, each call sits at its timeout (5–25s) before falling back.
//! Firing three @mention dispatches in a row eats 15+ seconds of dead
//! time before seeing anything.
//!
//! This breaker tracks consecutive failures across all meta callers.
//! After N consecutive failures, all meta calls instantly short-circuit
//! (return "unavailable") for a cooldown window. The circuit auto-
//! resets after the window so the system recovers when Haiku comes
//! back. State is in-process — restarts reset the breaker.

use std::sync::Mutex;
use std::time::{Duration, Instant};

const FAIL_THRESHOLD: u32 = 3;
const OPEN_DURATION: Duration = Duration::from_secs(60);

struct State {
    consecutive_failures: u32,
    opened_at: Option<Instant>,
}

fn breaker() -> &'static Mutex<State> {
    static B: std::sync::OnceLock<Mutex<State>> = std::sync::OnceLock::new();
    B.get_or_init(|| {
        Mutex::new(State {
            consecutive_failures: 0,
            opened_at: None,
        })
    })
}

/// Returns true when the breaker has been open for at least the
/// cooldown window — caller should reset state and let the next call
/// through ("half-open" probe).
fn should_half_open(opened_at: &Instant) -> bool {
    opened_at.elapsed() >= OPEN_DURATION
}

/// `false` when the breaker is open — callers should skip the LLM call
/// entirely and fall back to their non-LLM path immediately.
pub fn is_haiku_available() -> bool {
    let mut g = breaker().lock().unwrap();
    if let Some(opened) = g.opened_at {
        if should_half_open(&opened) {
            tracing::info!(target: "haiku_breaker", "haiku_breaker.half_open");
            g.opened_at = None;
            g.consecutive_failures = 0;
            return true;
        }
        return false;
    }
    true
}

pub fn record_haiku_success() {
    let mut g = breaker().lock().unwrap();
    if g.consecutive_failures > 0 || g.opened_at.is_some() {
        tracing::info!(target: "haiku_breaker", "haiku_breaker.recovered");
    }
    g.consecutive_failures = 0;
    g.opened_at = None;
}

pub fn record_haiku_failure() {
    let mut g = breaker().lock().unwrap();
    g.consecutive_failures += 1;
    if g.consecutive_failures >= FAIL_THRESHOLD && g.opened_at.is_none() {
        g.opened_at = Some(Instant::now());
        tracing::warn!(
            target: "haiku_breaker",
            "haiku_breaker.opened fails={} cooldown_secs={}",
            g.consecutive_failures,
            OPEN_DURATION.as_secs()
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reset() {
        let mut g = breaker().lock().unwrap();
        g.consecutive_failures = 0;
        g.opened_at = None;
    }

    #[test]
    fn three_failures_open_circuit_then_success_resets() {
        reset();
        assert!(is_haiku_available());
        record_haiku_failure();
        record_haiku_failure();
        // Still available after 2 failures.
        assert!(is_haiku_available());
        record_haiku_failure();
        // Open now.
        assert!(!is_haiku_available());
        // Recovery via record_success.
        record_haiku_success();
        assert!(is_haiku_available());
    }

    #[test]
    fn record_success_resets_failure_counter() {
        reset();
        record_haiku_failure();
        record_haiku_failure();
        record_haiku_success();
        assert!(is_haiku_available());
        record_haiku_failure();
        record_haiku_failure();
        // 2 more fails after reset is still under threshold.
        assert!(is_haiku_available());
    }
}
