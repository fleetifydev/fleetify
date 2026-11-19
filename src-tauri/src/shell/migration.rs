//! One-shot startup migrations for the Tauri shell. Today: lift plaintext
//! API keys out of `fleet.config.json#apiKeys` into the OS keychain so a
//! lost laptop or a leaked sync folder doesn't ship the user's keys with
//! it.
//!
//! Idempotent by construction:
//!   - Re-running with `apiKeys` already empty is a no-op.
//!   - A key whose keychain write fails (e.g. Linux without secret-service)
//!     stays in `apiKeys`, so the next boot retries it. Each key that landed
//!     leaves the file, and the block goes once no key is left in it.
//!   - When the config can't be saved after the keychain writes, the keys
//!     stay in `apiKeys` and are written again on the next boot —
//!     `set_password` overwrites, so the second write is harmless.
//!
//! The keychain writes come first, with no config lock held; only then is
//! the config changed, under the lock and on the file as it is at that
//! point ([`config::update_config`]). A setting saved while the migration
//! waits, a telemetry opt-out included, is never written over.
//!
//! All branches are best-effort: a broken config file, missing
//! `app_data_dir`, or unavailable keychain backend should NEVER crash the
//! app or block the rest of `setup()`. Failures land in `tracing` instead.

use std::future::Future;
use std::path::Path;

use serde_json::Value;
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
    /// boot because their `apiKeys` entries are kept).
    pub failed: Vec<String>,
    /// `true` when no key was left in `apiKeys` and the block was removed
    /// from the file.
    pub stripped_apikeys: bool,
}

/// The keychain writes of one pass: each provider whose key landed, with
/// the key written, and the providers whose write failed. It holds keys,
/// so it has no `Debug` and is never logged.
#[derive(Default)]
struct KeychainWrites {
    migrated: Vec<(String, String)>,
    failed: Vec<String>,
}

impl KeychainWrites {
    /// The pass's outcome, given whether the config change removed the
    /// `apiKeys` block.
    fn outcome(&self, stripped_apikeys: bool) -> MigrationOutcome {
        MigrationOutcome {
            migrated: self.migrated.len(),
            failed: self.failed.clone(),
            stripped_apikeys,
        }
    }
}

/// Write each plaintext key in `cfg.apiKeys = { provider_id: "raw-key" }`
/// to the keychain through `store_fn` (provider id, account, key). Entries
/// that aren't a non-empty string are skipped. Touches no config file: the
/// caller supplies `store_fn`, so tests can swap in a fake.
fn store_api_keys(
    cfg: &Value,
    uid: &str,
    mut store_fn: impl FnMut(&str, &str, &str) -> Result<(), String>,
) -> KeychainWrites {
    let mut out = KeychainWrites::default();
    let Some(api_keys) = cfg.get("apiKeys").and_then(Value::as_object) else {
        return out;
    };
    for (provider_id, value) in api_keys {
        let Some(secret) = value.as_str().filter(|secret| !secret.is_empty()) else {
            continue;
        };
        match store_fn(provider_id, uid, secret) {
            Ok(()) => out.migrated.push((provider_id.clone(), secret.to_string())),
            Err(_) => out.failed.push(provider_id.clone()),
        }
    }
    out
}

/// The migration's change to the config as it is now, made under the
/// config lock: each provider whose key landed is marked connected, and its
/// `apiKeys` entry is removed if it still holds the key that was written
/// (one changed since stays, for the next boot to migrate). Once no key is
/// left in `apiKeys`, the block goes. With no key landed, nothing changes.
/// Returns whether the block was removed.
fn apply_migrated_keys(cfg: &mut Value, writes: &KeychainWrites) -> bool {
    if writes.migrated.is_empty() {
        return false;
    }
    let mut providers = config::providers_from(cfg);
    for (id, _) in &writes.migrated {
        providers.connected.insert(id.clone(), true);
    }
    config::providers_set(cfg, &providers);
    let Some(api_keys) = cfg.get_mut("apiKeys").and_then(Value::as_object_mut) else {
        return false;
    };
    for (id, secret) in &writes.migrated {
        if api_keys.get(id).and_then(Value::as_str) == Some(secret.as_str()) {
            api_keys.remove(id);
        }
    }
    let keys_left = api_keys
        .values()
        .any(|value| value.as_str().is_some_and(|secret| !secret.is_empty()));
    if keys_left {
        return false;
    }
    if let Some(obj) = cfg.as_object_mut() {
        obj.remove("apiKeys");
    }
    true
}

/// Walk `cfg.apiKeys = { provider_id: "raw-key" }`, write each entry to
/// the keychain under `Fleetify-Provider-<id>`, mark
/// `cfg.providers.connected[id] = true`, and remove each entry that landed.
pub async fn migrate_api_keys_to_keychain(app: &tauri::AppHandle) {
    let Ok(dir) = app.path().app_data_dir() else {
        tracing::warn!(
            target: "fleetify::migration",
            "api_keys migration: app_data_dir unavailable; skipping"
        );
        return;
    };
    let ran = migrate_api_keys_in(&dir, auth::get_user_id(), |id, account, secret| {
        providers_link::store_secret(id, account, secret)
    })
    .await;
    if ran.is_some() {
        // Hydrate the backend key cache so the freshly-migrated keys are
        // usable on the very next chat turn, not after the next restart.
        // Race-tolerant: providers_setup::reload_backend sends nothing until
        // the app's backend has reported its bind. When this runs first, the
        // boot warm-up after the bind reads the keychain, migrated keys
        // included; the next reload trigger catches anything later.
        crate::shell::providers_setup::reload_backend(app).await;
    }
}

/// One pass against `dir`: `user_id` resolves the signed-in user, and
/// `store_fn` writes one key to the keychain. The keys come from the config
/// as it is now; the user is awaited and the keychain written with no config
/// lock held, and only then does [`config::update_config`] apply
/// [`apply_migrated_keys`] to the file as it is at that point. The snapshot
/// read first is never written back. `None` when there was nothing to
/// migrate, or no user to migrate it for.
async fn migrate_api_keys_in(
    dir: &Path,
    user_id: impl Future<Output = Option<String>>,
    store_fn: impl FnMut(&str, &str, &str) -> Result<(), String>,
) -> Option<MigrationOutcome> {
    let snapshot = config::load_config_from(dir);

    let api_key_count = snapshot
        .get("apiKeys")
        .and_then(|v| v.as_object())
        .map(|m| m.len())
        .unwrap_or(0);
    if api_key_count == 0 {
        return None;
    }

    let Some(uid) = user_id.await else {
        tracing::warn!(
            target: "fleetify::migration",
            count = api_key_count,
            "api_keys migration: no signed-in user; deferring (will retry next boot)"
        );
        return None;
    };

    let writes = store_api_keys(&snapshot, &uid, store_fn);
    let stripped = if writes.migrated.is_empty() {
        // No key landed: nothing in the file changes.
        false
    } else {
        match config::update_config(dir, |cfg| apply_migrated_keys(cfg, &writes)) {
            Ok(stripped) => stripped,
            Err(e) => {
                tracing::warn!(
                    target: "fleetify::migration",
                    error = %e,
                    "api_keys migration: failed to save updated config"
                );
                false
            }
        }
    };
    let outcome = writes.outcome(stripped);

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
            "api_keys migration: partial — failed keys kept in apiKeys for retry"
        );
    }
    Some(outcome)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::HashMap;
    use std::sync::Mutex;

    /// Both halves of a pass, on one config in memory: the keychain writes,
    /// then the change the migration makes to the file under the lock.
    fn migrate_api_keys_pure(
        cfg: &mut Value,
        uid: &str,
        store_fn: impl FnMut(&str, &str, &str) -> Result<(), String>,
    ) -> MigrationOutcome {
        let writes = store_api_keys(cfg, uid, store_fn);
        let stripped = apply_migrated_keys(cfg, &writes);
        writes.outcome(stripped)
    }

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
        // Only the key that landed leaves the file; the failed one stays so
        // the next boot can retry it.
        assert_eq!(cfg["apiKeys"], json!({ "deepseek": "sk-fail" }));
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

    #[tokio::test]
    async fn an_opt_out_saved_while_the_migration_waits_survives_it() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        config::save_config_to(
            dir,
            &json!({ "theme": "dark", "apiKeys": { "openai": "sk-openai-123" } }),
        )
        .unwrap();

        // The user turns cloud sync off while the migration waits for the
        // signed-in user.
        let user_id = async {
            config::persist_cloud_choice(dir, false).unwrap();
            Some("uid".to_string())
        };
        let sink: Mutex<HashMap<String, String>> = Mutex::new(HashMap::new());
        let out = migrate_api_keys_in(dir, user_id, fake_store(&sink))
            .await
            .expect("there were keys to migrate");

        assert!(out.stripped_apikeys);
        let cfg = config::load_config_from(dir);
        assert_eq!(
            cfg["telemetry"]["cloud_sync_enabled"],
            json!(false),
            "{cfg}"
        );
        assert_eq!(
            cfg["providers"]["connected"]["openai"],
            json!(true),
            "{cfg}"
        );
        assert_eq!(cfg.get("apiKeys"), None, "{cfg}");
        assert_eq!(cfg["theme"], json!("dark"), "{cfg}");
    }

    #[tokio::test]
    async fn keys_saved_while_the_migration_runs_stay_for_the_next_launch() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        config::save_config_to(
            dir,
            &json!({ "apiKeys": { "openai": "sk-old", "deepseek": "sk-ds" } }),
        )
        .unwrap();

        // During the first keychain write, the setup screen saves a new key
        // for openai and a first one for perplexity.
        let sink: Mutex<HashMap<String, String>> = Mutex::new(HashMap::new());
        let mut first = true;
        let store = |id: &str, _: &str, secret: &str| -> Result<(), String> {
            if std::mem::take(&mut first) {
                config::update_config(dir, |cfg| {
                    cfg["apiKeys"]["openai"] = json!("sk-new");
                    cfg["apiKeys"]["perplexity"] = json!("pplx-456");
                })
                .unwrap();
            }
            sink.lock()
                .unwrap()
                .insert(id.to_string(), secret.to_string());
            Ok(())
        };
        let out = migrate_api_keys_in(dir, async { Some("uid".to_string()) }, store)
            .await
            .expect("there were keys to migrate");

        assert_eq!(out.migrated, 2);
        assert!(!out.stripped_apikeys, "keys are left for the next launch");
        let cfg = config::load_config_from(dir);
        // deepseek's entry still holds the key written, so it goes. openai's
        // changed after its old key was written, and perplexity's is new:
        // both stay, for the next launch to migrate.
        assert_eq!(
            cfg["apiKeys"],
            json!({ "openai": "sk-new", "perplexity": "pplx-456" }),
            "{cfg}"
        );
        assert_eq!(
            cfg["providers"]["connected"]["openai"],
            json!(true),
            "{cfg}"
        );
        assert_eq!(
            cfg["providers"]["connected"]["deepseek"],
            json!(true),
            "{cfg}"
        );
    }
}
