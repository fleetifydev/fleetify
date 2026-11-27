//! Keychain glue for API-provider secrets (OpenAI / DeepSeek / Grok /
//! NVIDIA NIM / Kimi / Gemini API / Perplexity, etc.).
//!
//! Service naming: "Fleetify-Provider-<provider_id>". Account: user's OIDC
//! sub (matches the routers_link / GitHub-link tile pattern). Secrets
//! never leave the Tauri main process — renderer hits IPC commands only.
//!
//! Mirrors `routers_link.rs` so the `providers_*` IPC commands stay the
//! same shape as `routers_*`. Two namespaces (Fleetify-Provider-* vs
//! Fleetify-Router-*) means migrating a previously-saved OpenAI key from
//! the router subsystem won't accidentally clobber a router secret with
//! the same id.

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard, OnceLock};

use keyring::Entry;

const SERVICE_PREFIX: &str = "Fleetify-Provider-";

fn entry_for(provider_id: &str, account: &str) -> keyring::Result<Entry> {
    Entry::new(&format!("{SERVICE_PREFIX}{provider_id}"), account)
}

/// What this process knows about one (provider, account) entry: whether it
/// holds a key, if known, and how many saves and deletes have gone to it.
#[derive(Default)]
struct Presence {
    known: Option<bool>,
    writes: u64,
}

fn presence() -> MutexGuard<'static, HashMap<(String, String), Presence>> {
    static PRESENCE: OnceLock<Mutex<HashMap<(String, String), Presence>>> = OnceLock::new();
    PRESENCE
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Records a save (`Some(true)`) or delete (`Some(false)`) of an entry; `None`
/// means one failed, which leaves the keychain's state unknown.
fn note_write(provider_id: &str, account: &str, present: Option<bool>) {
    let mut map = presence();
    let slot = map
        .entry((provider_id.to_owned(), account.to_owned()))
        .or_default();
    slot.writes += 1;
    slot.known = present;
}

/// Whether a key is saved for `provider_id` under `account`, without the
/// secret leaving the keychain.
///
/// `providers_list_catalog` asks this for every catalog provider on each
/// call, and each lookup is a keychain round trip: on Linux's Secret Service
/// about 5 ms in a release build and 30 in a debug one, so the whole catalog
/// took most of a second and held up New session and every message send.
/// The answer is remembered for the rest of the run, since a key only comes
/// and goes through `store_secret` and `delete_secret`, which keep it current.
/// A lookup that fails isn't remembered, so the next call asks again.
pub fn has_secret(provider_id: &str, account: &str) -> bool {
    has_secret_with(provider_id, account, || read_secret(provider_id, account))
}

/// [`has_secret`], with the keychain lookup passed in so a test can stand in
/// for it.
fn has_secret_with(
    provider_id: &str,
    account: &str,
    lookup: impl FnOnce() -> Result<Option<String>, String>,
) -> bool {
    let key = (provider_id.to_owned(), account.to_owned());
    let writes = match presence().get(&key) {
        Some(slot) => match slot.known {
            Some(present) => return present,
            None => slot.writes,
        },
        None => 0,
    };
    // The lookup runs without the lock held. A save or delete that lands
    // meanwhile has recorded the newer answer, so this one mustn't replace it.
    let Ok(found) = lookup() else {
        return false;
    };
    let present = found.is_some();
    let mut map = presence();
    let slot = map.entry(key).or_default();
    if slot.writes == writes {
        slot.known = Some(present);
    }
    present
}

/// Persist a provider API key. Caller owns the credential shape — for the
/// catalog providers this is just a bare API key string (no JSON wrapper),
/// since we don't need to round-trip additional metadata through the
/// keychain.
pub fn store_secret(provider_id: &str, account: &str, secret: &str) -> Result<(), String> {
    let e = entry_for(provider_id, account).map_err(|e| e.to_string())?;
    let saved = e.set_password(secret).map_err(|e| e.to_string());
    note_write(provider_id, account, saved.is_ok().then_some(true));
    saved
}

/// Retrieve a stored secret. Returns `Ok(None)` when no entry exists
/// (distinguished from genuine errors so callers can branch on the
/// "not connected yet" case without parsing error strings).
pub fn read_secret(provider_id: &str, account: &str) -> Result<Option<String>, String> {
    let e = entry_for(provider_id, account).map_err(|e| e.to_string())?;
    match e.get_password() {
        Ok(s) => Ok(Some(s)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Remove a stored secret. Treat "no entry" as success — disconnect
/// should be idempotent so the renderer can retry a failed disconnect
/// without surfacing a phantom error.
pub fn delete_secret(provider_id: &str, account: &str) -> Result<(), String> {
    let e = entry_for(provider_id, account).map_err(|e| e.to_string())?;
    let deleted = match e.delete_credential() {
        Ok(_) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    };
    note_write(provider_id, account, deleted.is_ok().then_some(false));
    deleted
}

#[cfg(test)]
mod tests {
    use super::*;

    /// CI keyring backends may not be wired up (Linux secret-service, etc).
    /// Skip rather than fail if the backend isn't available. We exercise
    /// the round-trip when we can.
    #[test]
    fn round_trip_when_backend_available() {
        let p = "test-provider-rt";
        let a = "test-account-rt";
        let s = "sk-rt-123";
        let r1 = store_secret(p, a, s);
        if r1.is_err() {
            eprintln!(
                "skipping keyring round-trip: backend unavailable ({:?})",
                r1
            );
            return;
        }
        let got = read_secret(p, a).expect("read");
        assert_eq!(got.as_deref(), Some(s));
        assert!(has_secret(p, a), "a save should show as a saved key");
        delete_secret(p, a).expect("delete");
        let after = read_secret(p, a).expect("read after delete");
        assert!(
            after.is_none(),
            "secret should be gone after delete, got {after:?}"
        );
        assert!(!has_secret(p, a), "a delete should show as no key");
    }

    #[test]
    fn read_returns_none_for_unknown_provider() {
        let r = read_secret("does-not-exist-provider-xyz", "no-such-account-xyz");
        match r {
            Ok(None) => {}
            Err(_) => eprintln!("skipping read-unknown: backend unavailable"),
            Ok(Some(_)) => panic!("unexpected secret on unknown provider"),
        }
    }

    // The presence tests below never touch the real keychain: the lookup is
    // passed in. Each one uses its own provider id, because the remembered
    // answers are process-wide and tests run in parallel.

    /// The lookup for a call whose answer must come from memory.
    fn no_lookup() -> Result<Option<String>, String> {
        panic!("asked the keychain for an answer it should have remembered")
    }

    #[test]
    fn a_lookup_is_remembered() {
        let (p, a) = ("test-presence-remembered", "acct");
        assert!(!has_secret_with(p, a, || Ok(None)));
        assert!(!has_secret_with(p, a, no_lookup));

        let (p, a) = ("test-presence-remembered-found", "acct");
        assert!(has_secret_with(p, a, || Ok(Some("sk".into()))));
        assert!(has_secret_with(p, a, no_lookup));
    }

    #[test]
    fn a_failed_lookup_is_not_remembered() {
        let (p, a) = ("test-presence-failed", "acct");
        assert!(!has_secret_with(p, a, || Err("keychain locked".into())));
        assert!(has_secret_with(p, a, || Ok(Some("sk".into()))));
    }

    #[test]
    fn a_save_or_delete_replaces_the_answer() {
        let (p, a) = ("test-presence-writes", "acct");
        assert!(!has_secret_with(p, a, || Ok(None)));
        note_write(p, a, Some(true));
        assert!(has_secret_with(p, a, no_lookup));
        note_write(p, a, Some(false));
        assert!(!has_secret_with(p, a, no_lookup));
        // A write that failed leaves the keychain's state unknown: ask again.
        note_write(p, a, None);
        assert!(has_secret_with(p, a, || Ok(Some("sk".into()))));
    }

    #[test]
    fn a_write_during_a_lookup_wins_over_it() {
        let (p, a) = ("test-presence-race", "acct");
        // The lookup read "no key", but a save landed before it finished:
        // the save's answer must stand.
        let read = has_secret_with(p, a, || {
            note_write(p, a, Some(true));
            Ok(None)
        });
        assert!(!read);
        assert!(has_secret_with(p, a, no_lookup));
    }

    #[test]
    fn answers_are_kept_per_account() {
        let p = "test-presence-accounts";
        assert!(has_secret_with(p, "alice", || Ok(Some("sk".into()))));
        assert!(!has_secret_with(p, "bob", || Ok(None)));
        assert!(has_secret_with(p, "alice", no_lookup));
    }

    #[test]
    fn delete_is_idempotent_for_missing_entry() {
        let p = "test-provider-del";
        let a = "test-account-del";
        let _ = delete_secret(p, a);
        let r2 = delete_secret(p, a);
        match r2 {
            Ok(()) => {}
            Err(_) => eprintln!("skipping idempotency: backend unavailable"),
        }
    }
}
