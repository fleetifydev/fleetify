//! One-shot startup migrations for the Tauri shell. Today: lift plaintext
//! API keys out of `fleet.config.json#apiKeys` into the OS keychain so a
//! lost laptop or a leaked sync folder doesn't ship the user's keys with
//! it.
//!
//! Idempotent by construction:
//!   - Re-running with `apiKeys` already empty is a no-op.
//!   - Partial failures (one provider's keychain write returns an error,
//!     e.g. Linux without secret-service) leave the `apiKeys` block intact
//!     so the next boot retries; only a fully-clean run strips it.
//!   - Keys that successfully made it to the keychain on an earlier boot
//!     get silently re-written to the same value on retry — `set_password`
//!     overwrites, so the second write is harmless.
//!
//! All branches are best-effort: a broken config file, missing
//! `app_data_dir`, or unavailable keychain backend should NEVER crash the
//! app or block the rest of `setup()`. Failures land in `tracing` instead.

use tauri::Manager;

use crate::shell::{auth, config, providers_link};

/// Outcome from a single migration pass. Pure data — the public
/// wrapper turns this into tracing log lines, the unit test asserts on
/// the fields directly.
#[derive(Debug, Default)]
pub struct MigrationOutcome {
    /// Number of keys successfully written to the keychain this pass.
    pub migrated: usize,
    /// Provider ids whose keychain write failed (will be retried next
    /// boot because `apiKeys` is kept).
    pub failed: Vec<String>,
    /// `true` when every key landed and `apiKeys` was removed from cfg.
    pub stripped_apikeys: bool,
}

/// Pure config-mutating core of the migration — no AppHandle, no
/// keychain backend, no I/O. Caller supplies the `store_fn` closure
/// so tests can swap in a fake.
///
/// Mutates `cfg` in place: marks each migrated provider as connected
/// and (when every write succeeded) removes the `apiKeys` block.
pub fn migrate_api_keys_pure(
    cfg: &mut serde_json::Value,
    uid: &str,
    mut store_fn: impl FnMut(&str, &str, &str) -> Result<(), String>,
) -> MigrationOutcome {
    let mut out = MigrationOutcome::default();
    let api_keys: serde_json::Map<String, serde_json::Value> =
        match cfg.get("apiKeys").and_then(|v| v.as_object()).cloned() {
            Some(m) if !m.is_empty() => m,
            _ => return out,
        };
    let mut connected_updates: Vec<String> = Vec::new();
    for (provider_id, value) in api_keys.iter() {
        let Some(secret) = value.as_str() else {
            continue;
        };
        if secret.is_empty() {
            continue;
        }
        match store_fn(provider_id, uid, secret) {
            Ok(()) => {
                out.migrated += 1;
                connected_updates.push(provider_id.clone());
            }
            Err(_) => out.failed.push(provider_id.clone()),
        }
    }
    if !connected_updates.is_empty() {
        let mut providers = config::providers_from(cfg);
        for id in &connected_updates {
            providers.connected.insert(id.clone(), true);
        }
        config::providers_set(cfg, &providers);
    }
    if out.failed.is_empty() && out.migrated > 0 {
        if let Some(obj) = cfg.as_object_mut() {
            obj.remove("apiKeys");
        }
        out.stripped_apikeys = true;
    }
    out
}

/// Walk `cfg.apiKeys = { provider_id: "raw-key" }`, write each entry to
/// the keychain under `Fleetify-Provider-<id>`, mark
/// `cfg.providers.connected[id] = true`, and strip the JSON block when
/// every write succeeded.
pub async fn migrate_api_keys_to_keychain(app: &tauri::AppHandle) {
    let Ok(dir) = app.path().app_data_dir() else {
        tracing::warn!(
            target: "fleetify::migration",
            "api_keys migration: app_data_dir unavailable; skipping"
        );
        return;
    };
    let mut cfg = config::load_config_from(&dir);

    let api_key_count = cfg
        .get("apiKeys")
        .and_then(|v| v.as_object())
        .map(|m| m.len())
        .unwrap_or(0);
    if api_key_count == 0 {
        return;
    }

    let Some(uid) = auth::get_user_id().await else {
        tracing::warn!(
            target: "fleetify::migration",
            count = api_key_count,
            "api_keys migration: no signed-in user; deferring (will retry next boot)"
        );
        return;
    };

    let outcome = migrate_api_keys_pure(&mut cfg, &uid, |id, account, secret| {
        providers_link::store_secret(id, account, secret)
    });

    if outcome.stripped_apikeys {
        tracing::info!(
            target: "fleetify::migration",
            count = outcome.migrated,
            "api_keys migration: complete — keychain populated, JSON block removed"
        );
    } else if !outcome.failed.is_empty() {
        tracing::warn!(
            target: "fleetify::migration",
            migrated = outcome.migrated,
            failed = outcome.failed.len(),
            failed_ids = ?outcome.failed,
            "api_keys migration: partial — apiKeys retained for retry"
        );
    }

    if let Err(e) = config::save_config_to(&dir, &cfg) {
        tracing::warn!(
            target: "fleetify::migration",
            error = %e,
            "api_keys migration: failed to save updated config"
        );
    }

    // Hydrate the backend key cache so the freshly-migrated keys are
    // usable on the very next chat turn, not after the next restart.
    // Race-tolerant: providers_setup::reload_backend logs + skips when
    // the backend's not listening yet, which happens during the
    // startup window between serve() spawning and the listener
    // binding. The reload that fires on the first Settings mutation
    // (or the next reload trigger) will catch up.
    crate::shell::providers_setup::reload_backend(app).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::HashMap;
    use std::sync::Mutex;

    fn fake_store(
        sink: &Mutex<HashMap<String, String>>,
    ) -> impl FnMut(&str, &str, &str) -> Result<(), String> + '_ {
        move |id, _account, secret| {
            sink.lock()
                .unwrap()
                .insert(id.to_string(), secret.to_string());
            Ok(())
        }
    }

    #[test]
    fn no_apikeys_block_is_a_noop() {
        let mut cfg = json!({ "theme": "dark" });
        let sink: Mutex<HashMap<String, String>> = Mutex::new(HashMap::new());
        let out = migrate_api_keys_pure(&mut cfg, "uid", fake_store(&sink));
        assert_eq!(out.migrated, 0);
        assert!(out.failed.is_empty());
        assert!(!out.stripped_apikeys);
        assert_eq!(cfg, json!({ "theme": "dark" }));
        assert!(sink.lock().unwrap().is_empty());
    }

    #[test]
    fn empty_apikeys_block_is_a_noop() {
        let mut cfg = json!({ "apiKeys": {} });
        let sink: Mutex<HashMap<String, String>> = Mutex::new(HashMap::new());
        let out = migrate_api_keys_pure(&mut cfg, "uid", fake_store(&sink));
        assert_eq!(out.migrated, 0);
        assert!(!out.stripped_apikeys);
    }

    #[test]
    fn full_success_writes_keys_marks_connected_strips_block() {
        let mut cfg = json!({
            "theme": "dark",
            "apiKeys": {
                "openai": "sk-openai-123",
                "perplexity": "pplx-456"
            }
        });
        let sink: Mutex<HashMap<String, String>> = Mutex::new(HashMap::new());
        let out = migrate_api_keys_pure(&mut cfg, "uid", fake_store(&sink));

        assert_eq!(out.migrated, 2);
        assert!(out.failed.is_empty());
        assert!(out.stripped_apikeys);

        // apiKeys block is gone, theme survives.
        assert!(cfg.get("apiKeys").is_none());
        assert_eq!(cfg["theme"], "dark");
        // providers.connected populated.
        let providers = config::providers_from(&cfg);
        assert_eq!(providers.connected.get("openai"), Some(&true));
        assert_eq!(providers.connected.get("perplexity"), Some(&true));
        // Keychain (the fake) saw both writes.
        let written = sink.lock().unwrap();
        assert_eq!(
            written.get("openai").map(String::as_str),
            Some("sk-openai-123")
        );
        assert_eq!(
            written.get("perplexity").map(String::as_str),
            Some("pplx-456"),
        );
    }

    #[test]
    fn partial_failure_keeps_apikeys_for_retry() {
        let mut cfg = json!({
            "apiKeys": {
                "openai": "sk-ok",
                "deepseek": "sk-fail"
            }
        });
        // Fake store fails only for "deepseek".
        let sink: Mutex<HashMap<String, String>> = Mutex::new(HashMap::new());
        let store_fn = |id: &str, _: &str, secret: &str| {
            if id == "deepseek" {
                Err("backend unavailable".to_string())
            } else {
                sink.lock().unwrap().insert(id.into(), secret.into());
                Ok(())
            }
        };
        let out = migrate_api_keys_pure(&mut cfg, "uid", store_fn);

        assert_eq!(out.migrated, 1);
        assert_eq!(out.failed, vec!["deepseek".to_string()]);
        assert!(!out.stripped_apikeys);
        // apiKeys block is RETAINED so the next boot can retry.
        assert!(cfg.get("apiKeys").is_some());
        // The successful one IS marked connected even though we kept the block.
        let providers = config::providers_from(&cfg);
        assert_eq!(providers.connected.get("openai"), Some(&true));
        // The failed one is NOT marked connected.
        assert!(providers.connected.get("deepseek").is_none_or(|v| !v));
    }

    #[test]
    fn non_string_entries_skipped_silently() {
        let mut cfg = json!({
            "apiKeys": {
                "openai": "sk-real",
                "weird":  null,
                "weird2": 42
            }
        });
        let sink: Mutex<HashMap<String, String>> = Mutex::new(HashMap::new());
        let out = migrate_api_keys_pure(&mut cfg, "uid", fake_store(&sink));
        // Only the valid string entry counts toward migrated.
        assert_eq!(out.migrated, 1);
        assert!(out.failed.is_empty());
        assert!(out.stripped_apikeys);
        let written = sink.lock().unwrap();
        assert_eq!(written.len(), 1);
        assert!(written.contains_key("openai"));
    }

    #[test]
    fn empty_string_value_skipped() {
        let mut cfg = json!({ "apiKeys": { "openai": "" } });
        let sink: Mutex<HashMap<String, String>> = Mutex::new(HashMap::new());
        let out = migrate_api_keys_pure(&mut cfg, "uid", fake_store(&sink));
        assert_eq!(out.migrated, 0);
        // No writes → block is NOT stripped (stripped_apikeys requires
        // at least one successful write).
        assert!(!out.stripped_apikeys);
    }
}
