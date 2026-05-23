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

use keyring::Entry;

const SERVICE_PREFIX: &str = "Fleetify-Provider-";

fn entry_for(provider_id: &str, account: &str) -> keyring::Result<Entry> {
    Entry::new(&format!("{SERVICE_PREFIX}{provider_id}"), account)
}

/// Persist a provider API key. Caller owns the credential shape — for the
/// catalog providers this is just a bare API key string (no JSON wrapper),
/// since we don't need to round-trip additional metadata through the
/// keychain.
pub fn store_secret(provider_id: &str, account: &str, secret: &str) -> Result<(), String> {
    let e = entry_for(provider_id, account).map_err(|e| e.to_string())?;
    e.set_password(secret).map_err(|e| e.to_string())
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
        delete_secret(p, a).expect("delete");
        let after = read_secret(p, a).expect("read after delete");
        assert!(
            after.is_none(),
            "secret should be gone after delete, got {after:?}"
        );
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
