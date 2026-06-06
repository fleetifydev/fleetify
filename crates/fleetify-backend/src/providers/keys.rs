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

/// Legacy / System key per provider (the pre-multi-account single key, account
/// field = the user's OIDC sub). `get_key` and `get_key_for(_, None|"system")`
/// resolve here. Populated by [`set_keys`].
static PROVIDER_KEYS: LazyLock<RwLock<HashMap<String, String>>> =
    LazyLock::new(|| RwLock::new(HashMap::new()));

/// Labeled per-account keys, keyed by `"<provider_id>\0<account_id>"`.
/// Populated by [`set_account_keys`].
static ACCOUNT_KEYS: LazyLock<RwLock<HashMap<String, String>>> =
    LazyLock::new(|| RwLock::new(HashMap::new()));

/// provider_id → the account_id flagged as the provider's default (only when a
/// *labeled* account is the default; when System is default this is absent).
static DEFAULT_ACCOUNT: LazyLock<RwLock<HashMap<String, String>>> =
    LazyLock::new(|| RwLock::new(HashMap::new()));

/// A single labeled key as pushed from the shell's keychain walk.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct LabeledKey {
    pub provider_id: String,
    pub account_id: String,
    pub key: String,
    #[serde(default)]
    pub is_default: bool,
}

fn composite(provider_id: &str, account_id: &str) -> String {
    format!("{provider_id}\u{0}{account_id}")
}

/// Is this account id the System sentinel (explicit "use the legacy key")?
fn is_system_sentinel(account_id: &str) -> bool {
    account_id.is_empty() || account_id == "system"
}

fn account_lookup(provider_id: &str, account_id: &str) -> Option<String> {
    ACCOUNT_KEYS
        .read()
        .ok()?
        .get(&composite(provider_id, account_id))
        .cloned()
}

fn legacy_lookup(provider_id: &str) -> Option<String> {
    PROVIDER_KEYS.read().ok()?.get(provider_id).cloned()
}

/// The provider's default key: a labeled default account's key if one exists,
/// otherwise the legacy / System key.
fn default_then_legacy(provider_id: &str) -> Option<String> {
    if let Some(def) = DEFAULT_ACCOUNT
        .read()
        .ok()
        .and_then(|g| g.get(provider_id).cloned())
    {
        if let Some(k) = account_lookup(provider_id, &def) {
            return Some(k);
        }
    }
    legacy_lookup(provider_id)
}

/// Look up the user's API key for a provider, honoring its default account.
/// `None` means "no key on file" — bridges fall back to the legacy env-var
/// hint in `CATALOG` so existing `OPENAI_API_KEY=…` setups keep working.
pub fn get_key(provider_id: &str) -> Option<String> {
    get_key_for(provider_id, None)
}

/// Account-aware key lookup. Resolution:
///   * explicit System (`Some("system")`/`Some("")`) ⇒ the legacy key only;
///   * a specific account ⇒ that account's key, falling back to the provider
///     default then the legacy key;
///   * `None` (no preference) ⇒ the provider's default key.
pub fn get_key_for(provider_id: &str, account_id: Option<&str>) -> Option<String> {
    match account_id {
        Some(id) if is_system_sentinel(id) => legacy_lookup(provider_id),
        Some(id) => account_lookup(provider_id, id).or_else(|| default_then_legacy(provider_id)),
        None => default_then_legacy(provider_id),
    }
}

/// Replace the legacy / System key cache atomically. Called by the Tauri
/// shell's `providers_reload` IPC after walking the keychain.
pub fn set_keys(keys: HashMap<String, String>) {
    if let Ok(mut guard) = PROVIDER_KEYS.write() {
        *guard = keys;
    }
}

/// Replace the labeled per-account key cache + default map atomically.
pub fn set_account_keys(keys: Vec<LabeledKey>) {
    let mut map = HashMap::new();
    let mut defaults = HashMap::new();
    for lk in keys {
        if lk.is_default {
            defaults.insert(lk.provider_id.clone(), lk.account_id.clone());
        }
        map.insert(composite(&lk.provider_id, &lk.account_id), lk.key);
    }
    if let Ok(mut g) = ACCOUNT_KEYS.write() {
        *g = map;
    }
    if let Ok(mut g) = DEFAULT_ACCOUNT.write() {
        *g = defaults;
    }
}

/// Count of cached legacy keys. Used only by the reload endpoint's log line.
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
    if let Ok(mut g) = ACCOUNT_KEYS.write() {
        g.clear();
    }
    if let Ok(mut g) = DEFAULT_ACCOUNT.write() {
        g.clear();
    }
    if let Ok(mut g) = CLOUDFLARE_ACCOUNT_ID.write() {
        *g = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// These tests mutate process-global key caches, so they must not run
    /// concurrently. Each locks this before touching the statics.
    static TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn round_trip_get_after_set() {
        let _g = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
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
        let _g = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
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
    fn account_aware_resolution() {
        let _g = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        _reset_for_tests();
        // Legacy/System key for openai.
        let mut legacy = HashMap::new();
        legacy.insert("openai".into(), "sk-system".into());
        set_keys(legacy);
        // Two labeled accounts; acct-b is default.
        set_account_keys(vec![
            LabeledKey {
                provider_id: "openai".into(),
                account_id: "acct-a".into(),
                key: "sk-a".into(),
                is_default: false,
            },
            LabeledKey {
                provider_id: "openai".into(),
                account_id: "acct-b".into(),
                key: "sk-b".into(),
                is_default: true,
            },
        ]);
        // Explicit account wins.
        assert_eq!(
            get_key_for("openai", Some("acct-a")).as_deref(),
            Some("sk-a")
        );
        // Explicit System ⇒ legacy, ignoring the labeled default.
        assert_eq!(
            get_key_for("openai", Some("system")).as_deref(),
            Some("sk-system")
        );
        // No preference ⇒ the default labeled account.
        assert_eq!(get_key_for("openai", None).as_deref(), Some("sk-b"));
        assert_eq!(get_key("openai").as_deref(), Some("sk-b"));
        // Unknown specific account ⇒ falls back to default.
        assert_eq!(
            get_key_for("openai", Some("ghost")).as_deref(),
            Some("sk-b")
        );
    }

    #[test]
    fn cloudflare_account_id_round_trip() {
        let _g = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
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
