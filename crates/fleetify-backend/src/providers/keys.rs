//! Process-wide cache of provider API keys, hydrated from the Tauri
//! shell's keychain reader at startup + after every Settings mutation.
//!
//! Bridges look up keys via `get_key(id)` at request time so a user
//! flipping their key in Settings → Models is picked up on the very
//! next chat turn, no backend restart required.
//!
//! Lives in the providers module rather than AppState because (a) it's
//! a singleton with no lifecycle dependencies, (b) keeping it out of
//! AppState saves us touching every test that constructs one, (c) the
//! reload endpoint is the only writer so contention is negligible.

use std::collections::HashMap;
use std::sync::{LazyLock, RwLock};

static PROVIDER_KEYS: LazyLock<RwLock<HashMap<String, String>>> =
    LazyLock::new(|| RwLock::new(HashMap::new()));

/// Look up the user's API key for a provider. `None` means "no key on
/// file" — bridges fall back to the legacy env-var hint defined in
/// `CATALOG` so existing `OPENAI_API_KEY=…` setups keep working.
pub fn get_key(provider_id: &str) -> Option<String> {
    PROVIDER_KEYS.read().ok()?.get(provider_id).cloned()
}

/// Replace the entire cache atomically. Called by the Tauri shell's
/// `providers_reload` IPC after walking the keychain.
pub fn set_keys(keys: HashMap<String, String>) {
    if let Ok(mut guard) = PROVIDER_KEYS.write() {
        *guard = keys;
    }
}

/// Count of cached keys. Used only by the reload endpoint's log line.
pub fn len() -> usize {
    PROVIDER_KEYS.read().map(|g| g.len()).unwrap_or(0)
}

/// Cloudflare Workers AI account id, pushed from the Tauri shell over the
/// same `/api/internal/providers/reload` path as the API keys (see
/// `providers_setup::reload_backend`). The chat dispatch layer substitutes
/// it into the account-scoped Workers AI base URL. Held here — not read from
/// a config file — so it works identically in dev and the packaged app
/// (where no `FLEETIFY_HOME` is set). `None` ⇒ not connected.
static CLOUDFLARE_ACCOUNT_ID: LazyLock<RwLock<Option<String>>> =
    LazyLock::new(|| RwLock::new(None));

/// Replace the cached Cloudflare account id. Empty / whitespace-only input
/// normalizes to `None` (treated as "not connected") so a cleared config
/// disables dispatch on the next reload.
pub fn set_cloudflare_account_id(id: Option<String>) {
    let normalized = id.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    if let Ok(mut g) = CLOUDFLARE_ACCOUNT_ID.write() {
        *g = normalized;
    }
}

/// The current Cloudflare account id, or `None` when not connected.
pub fn get_cloudflare_account_id() -> Option<String> {
    CLOUDFLARE_ACCOUNT_ID.read().ok().and_then(|g| g.clone())
}

#[cfg(test)]
pub fn _reset_for_tests() {
    if let Ok(mut g) = PROVIDER_KEYS.write() {
        g.clear();
    }
    if let Ok(mut g) = CLOUDFLARE_ACCOUNT_ID.write() {
        *g = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_get_after_set() {
        _reset_for_tests();
        let mut keys = HashMap::new();
        keys.insert("openai".into(), "sk-test-123".into());
        keys.insert("perplexity".into(), "pplx-456".into());
        set_keys(keys);
        assert_eq!(get_key("openai").as_deref(), Some("sk-test-123"));
        assert_eq!(get_key("perplexity").as_deref(), Some("pplx-456"));
        assert!(get_key("unknown").is_none());
    }

    #[test]
    fn set_replaces_full_map() {
        _reset_for_tests();
        let mut a = HashMap::new();
        a.insert("openai".into(), "k1".into());
        set_keys(a);
        let mut b = HashMap::new();
        b.insert("deepseek".into(), "k2".into());
        set_keys(b);
        // openai is gone — set replaces, doesn't merge.
        assert!(get_key("openai").is_none());
        assert_eq!(get_key("deepseek").as_deref(), Some("k2"));
    }

    #[test]
    fn cloudflare_account_id_round_trip() {
        _reset_for_tests();
        assert!(get_cloudflare_account_id().is_none());
        set_cloudflare_account_id(Some("acc_1".into()));
        assert_eq!(get_cloudflare_account_id().as_deref(), Some("acc_1"));
        // Whitespace / empty normalizes to None (disconnected).
        set_cloudflare_account_id(Some("   ".into()));
        assert!(get_cloudflare_account_id().is_none());
        // Explicit clear.
        set_cloudflare_account_id(Some("acc_2".into()));
        set_cloudflare_account_id(None);
        assert!(get_cloudflare_account_id().is_none());
    }
}
