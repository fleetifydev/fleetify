//! Keychain glue for router service secrets.
//!
//! Service naming: "Fleetify-Router-<router_id>". Account: user's OIDC sub
//! (matches the GitHub-link tile pattern). Secrets never leave the Tauri
//! main process — renderer hits IPC commands only (Task 19).

use keyring::Entry;

const SERVICE_PREFIX: &str = "Fleetify-Router-";

fn entry_for(router_id: &str, account: &str) -> keyring::Result<Entry> {
    Entry::new(&format!("{SERVICE_PREFIX}{router_id}"), account)
}

/// Persist a router secret (API key, JSON blob — caller decides shape).
pub fn store_secret(router_id: &str, account: &str, secret: &str) -> Result<(), String> {
    let e = entry_for(router_id, account).map_err(|e| e.to_string())?;
    e.set_password(secret).map_err(|e| e.to_string())
}

/// Retrieve a stored secret. Returns `Ok(None)` when no entry exists
/// (distinguished from genuine errors so callers can branch on the
/// "not connected yet" case).
pub fn read_secret(router_id: &str, account: &str) -> Result<Option<String>, String> {
    let e = entry_for(router_id, account).map_err(|e| e.to_string())?;
    match e.get_password() {
        Ok(s) => Ok(Some(s)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Remove a stored secret. Treat "no entry" as success — disconnect
/// should be idempotent.
pub fn delete_secret(router_id: &str, account: &str) -> Result<(), String> {
    let e = entry_for(router_id, account).map_err(|e| e.to_string())?;
    match e.delete_credential() {
        Ok(_) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// CI keyring backends may not be wired up (Linux secret-service, etc).
    /// Skip rather than fail if the backend isn't available. We exercise
    /// the round-trip when we can.
    #[test]
    fn round_trip_when_backend_available() {
        let r = "test-router-rt";
        let a = "test-account-rt";
        let s = "secret-rt-123";
        let r1 = store_secret(r, a, s);
        if r1.is_err() {
            eprintln!(
                "skipping keyring round-trip: backend unavailable ({:?})",
                r1
            );
            return;
        }
        let got = read_secret(r, a).expect("read");
        assert_eq!(got.as_deref(), Some(s));
        delete_secret(r, a).expect("delete");
        let after = read_secret(r, a).expect("read after delete");
        assert!(
            after.is_none(),
            "secret should be gone after delete, got {after:?}"
        );
    }

    #[test]
    fn read_returns_none_for_unknown_router() {
        let r = read_secret("does-not-exist-router-xyz", "no-such-account-xyz");
        // Either Ok(None) or backend-unavailable Err — both acceptable here.
        match r {
            Ok(None) => {}
            Err(_) => eprintln!("skipping read-unknown: backend unavailable"),
            Ok(Some(_)) => panic!("unexpected secret on unknown router"),
        }
    }

    #[test]
    fn delete_is_idempotent_for_missing_entry() {
        let r = "test-router-del";
        let a = "test-account-del";
        // Ensure clean state.
        let _ = delete_secret(r, a);
        // Second delete must not error (idempotent).
        let r2 = delete_secret(r, a);
        match r2 {
            Ok(()) => {}
            Err(_) => eprintln!("skipping idempotency: backend unavailable"),
        }
    }
}
