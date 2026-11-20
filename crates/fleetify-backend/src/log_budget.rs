//! A cap on the warning lines that incoming requests can make one log
//! target write.
//!
//! A [`LogBudget`] lets at most [`LogBudget::LINES`] lines through per
//! [`LogBudget::WINDOW_MS`]. The first event after a window ends opens the
//! next window and says how many events the last one held back, so the
//! caller can log one summary line in their place.

use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::Instant;

/// What [`LogBudget::admit`] answers for one event.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Admission {
    /// Whether to log this event.
    pub log: bool,
    /// How many events the window that just ended held back. Nonzero only
    /// on the first event of a new window; the caller logs one summary line
    /// for them before this event's line.
    pub suppressed: u32,
}

/// At most [`Self::LINES`] lines per [`Self::WINDOW_MS`], counted with two
/// atomics, so the request path takes no lock.
#[derive(Debug, Default)]
pub(crate) struct LogBudget {
    /// When the current window opened, on the caller's clock.
    window_start_ms: AtomicU64,
    /// The events counted in the current window, logged or not.
    events: AtomicU32,
}

impl LogBudget {
    /// The lines a window lets through.
    pub(crate) const LINES: u32 = 20;
    /// How long a window lasts.
    pub(crate) const WINDOW_MS: u64 = 60_000;

    /// Counts one event at `now_ms` ([`monotonic_ms`], or a test's clock).
    ///
    /// A window lasts [`Self::WINDOW_MS`] from the event that opens it: the
    /// first one at least that long after the current window opened. A new
    /// budget's first window opened at 0 on that clock.
    pub(crate) fn admit(&self, now_ms: u64) -> Admission {
        let start = self.window_start_ms.load(Ordering::Acquire);
        // Of two events that find the window over, the one that moves its
        // start opens the next window; the other is counted in it.
        if now_ms.saturating_sub(start) >= Self::WINDOW_MS
            && self
                .window_start_ms
                .compare_exchange(start, now_ms, Ordering::AcqRel, Ordering::Acquire)
                .is_ok()
        {
            let ended = self.events.swap(1, Ordering::AcqRel);
            return Admission {
                log: true,
                suppressed: ended.saturating_sub(Self::LINES),
            };
        }
        // A u32 can't wrap within one window: that takes over 70 million
        // events a second.
        let before = self.events.fetch_add(1, Ordering::AcqRel);
        Admission {
            log: before < Self::LINES,
            suppressed: 0,
        }
    }
}

/// Milliseconds since the first call, on a clock that never goes back.
pub(crate) fn monotonic_ms() -> u64 {
    static EPOCH: OnceLock<Instant> = OnceLock::new();
    let elapsed = EPOCH.get_or_init(Instant::now).elapsed().as_millis();
    u64::try_from(elapsed).unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A start time far enough from 0 that the first event opens a window.
    const T0: u64 = 10 * LogBudget::WINDOW_MS;

    fn logs(budget: &LogBudget, now_ms: u64) -> bool {
        budget.admit(now_ms).log
    }

    #[test]
    fn a_window_lets_20_lines_through_and_holds_back_the_rest() {
        let budget = LogBudget::default();
        for n in 1..=LogBudget::LINES {
            assert!(logs(&budget, T0), "event {n} was held back");
        }
        for _ in 0..5 {
            assert_eq!(
                budget.admit(T0 + LogBudget::WINDOW_MS - 1),
                Admission {
                    log: false,
                    suppressed: 0
                }
            );
        }
    }

    #[test]
    fn the_first_event_after_the_window_logs_and_counts_what_was_held_back() {
        let budget = LogBudget::default();
        for _ in 0..LogBudget::LINES + 3 {
            budget.admit(T0);
        }
        let next = T0 + LogBudget::WINDOW_MS;
        assert_eq!(
            budget.admit(next),
            Admission {
                log: true,
                suppressed: 3
            }
        );
        // That event opened a window of its own, with a full budget.
        for n in 2..=LogBudget::LINES {
            assert!(logs(&budget, next), "event {n} of the new window");
        }
        assert!(!logs(&budget, next + LogBudget::WINDOW_MS - 1));
    }

    #[test]
    fn a_window_that_held_nothing_back_ends_without_a_count() {
        let budget = LogBudget::default();
        assert!(logs(&budget, T0));
        assert_eq!(
            budget.admit(T0 + LogBudget::WINDOW_MS),
            Admission {
                log: true,
                suppressed: 0
            }
        );
    }

    #[test]
    fn the_clock_never_goes_back() {
        let first = monotonic_ms();
        assert!(monotonic_ms() >= first);
    }
}
