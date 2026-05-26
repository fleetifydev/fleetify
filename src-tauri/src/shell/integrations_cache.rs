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
}
