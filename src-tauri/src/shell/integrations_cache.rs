//! In-process cache for the slow integration probes (Settings →
//! Integrations). Today the only entry is the `gh` CLI probe, which
//! spawns three subprocesses (`gh --version`, `gh auth status`,
//! `gh api user --jq .login`) — enough wall-clock time that the tile
//! visibly flickers from a spinner to a final state when Settings opens.
//!
//! The boot path primes this cache in parallel with the providers
//! warm-up, so the first IPC `git_has_gh_cli` call after launch returns
//! instantly with the precomputed snapshot. Cache writes happen on:
//!   - boot via `prime_gh_cli()`
//!   - cold path inside `git_has_gh_cli` (when the boot prime hasn't
//!     landed yet by the time the renderer asks)
//!   - successful `gh_auth_login_capture` (which calls `invalidate`
//!     so the next read re-probes and sees the new auth state).
//!
//! Single-process state — `Mutex<Option<Value>>` is enough. None means
//! "no snapshot taken yet"; consumers fall back to a live probe.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::Value;

static GH_CLI_CACHE: Mutex<Option<Value>> = Mutex::new(None);

pub fn get_gh_cli() -> Option<Value> {
    GH_CLI_CACHE.lock().ok().and_then(|g| g.clone())
}

pub fn set_gh_cli(snapshot: Value) {
    if let Ok(mut g) = GH_CLI_CACHE.lock() {
        *g = Some(snapshot);
    }
}

pub fn invalidate_gh_cli() {
    if let Ok(mut g) = GH_CLI_CACHE.lock() {
        *g = None;
    }
}

// ── Auth-resolution cache (PR status/list hot path) ──────────────
//
// `git_host::resolve_auth_method`'s auto-detect branch spawns
// `gh auth status` to learn whether the gh CLI is usable. That probe
// is GLOBAL — `gh auth status` reads the cwd-independent global
// `hosts.yml`, and the OAuth link is a per-user keychain entry — so
// the auto-detected `AuthMethod` does not vary by repo folder and can
// be memoised process-wide. PR polling fires several times per ~10s
// window, so without a cache each poll re-pays the spawn.
//
// We cache the resolved method behind a short TTL so a stale result
// self-heals within `AUTH_TTL` even if an invalidation hook is missed,
// and we hard-invalidate on every auth-state change (gh login, OAuth
// connect/refresh/disconnect) so opt-in/opt-out is reflected at once.
// `None` (no usable auth) is intentionally NOT cached — a user who
// just signed in must see the new method on their very next poll
// rather than waiting out the TTL on a "no auth" answer.

const AUTH_TTL: Duration = Duration::from_secs(30);

static AUTH_METHOD_CACHE: Mutex<Option<(Instant, u8)>> = Mutex::new(None);

/// Read the cached auto-detected auth method if it's still within TTL.
/// `Some(code)` is the cached method discriminant (see
/// [`set_auth_method`]); `None` means cold or expired — the caller must
/// re-probe.
pub fn get_auth_method() -> Option<u8> {
    let mut g = AUTH_METHOD_CACHE.lock().ok()?;
    match *g {
        Some((at, code)) if at.elapsed() < AUTH_TTL => Some(code),
        Some(_) => {
            // Expired: drop it so we don't keep checking the clock.
            *g = None;
            None
        }
        None => None,
    }
}

/// Cache an auto-detected auth method (caller encodes the variant as a
/// small `u8` discriminant). Stamped with `Instant::now()` for the TTL.
pub fn set_auth_method(code: u8) {
    if let Ok(mut g) = AUTH_METHOD_CACHE.lock() {
        *g = Some((Instant::now(), code));
    }
}

/// Drop the cached auth method. Called from every auth-state-change site
/// (alongside [`invalidate_gh_cli`]) so a connect/disconnect is reflected
/// on the next PR poll instead of after the TTL.
pub fn invalidate_auth_method() {
    if let Ok(mut g) = AUTH_METHOD_CACHE.lock() {
        *g = None;
    }
}

/// Run the live probe and store the result. Boot calls this once after
/// the backend port is up; manual IPC paths can rerun it whenever they
/// want a forced refresh.
pub async fn prime_gh_cli() {
    let snapshot = crate::shell::git::has_gh_cli().await;
    set_gh_cli(snapshot);
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn round_trip_set_get_invalidate() {
        // Run serially: the cache is process-global, so independent
        // tests would race. We isolate by always invalidating first.
        invalidate_gh_cli();
        assert!(get_gh_cli().is_none(), "cold cache should be None");

        let snap = json!({ "ok": true, "version": "gh 2.0.0", "authed": false, "ghLogin": null });
        set_gh_cli(snap.clone());
        assert_eq!(get_gh_cli().as_ref(), Some(&snap));

        invalidate_gh_cli();
        assert!(get_gh_cli().is_none(), "invalidate should clear");
    }

    #[test]
    fn auth_method_round_trip_set_get_invalidate() {
        // Process-global cache: isolate by invalidating first.
        invalidate_auth_method();
        assert!(get_auth_method().is_none(), "cold cache should be None");

        set_auth_method(7);
        assert_eq!(get_auth_method(), Some(7), "fresh value within TTL");

        invalidate_auth_method();
        assert!(get_auth_method().is_none(), "invalidate should clear");
    }

    #[test]
    fn auth_method_expires_after_ttl() {
        // Stamp an entry older than the TTL and confirm it reads as cold.
        invalidate_auth_method();
        {
            let mut g = AUTH_METHOD_CACHE.lock().unwrap();
            *g = Some((Instant::now() - AUTH_TTL - Duration::from_secs(1), 3));
        }
        assert!(
            get_auth_method().is_none(),
            "entry older than TTL must read as expired"
        );
        invalidate_auth_method();
    }
}
