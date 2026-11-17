//! Hot-reload hook for the providers subsystem — sibling of
//! `routing_setup.rs`. After every `providers_*` IPC mutation (and once
//! at boot, after the migration runs), this walks `ProvidersConfig` +
//! the keychain to build a `{provider_id: api_key}` map and POSTs it to
//! the in-process backend's `/api/internal/providers/reload` endpoint.
//! The backend stores the keys in its process-wide cache so the next
//! chat turn picks them up — no restart needed.
//!
//! Fire-and-forget: failures land in tracing, never propagate to the
//! IPC caller. Config + keychain are the source of truth regardless, so
//! the next boot will rebuild the cache cleanly even if this fails.
//!
//! Keys go only to the app's own backend, once it has reported its bind
//! (`backend_ready::bound_port`): until then nothing is sent, not even the
//! request for its account list, whose answer decides which keychain
//! entries go out.

use std::collections::HashMap;

use serde_json::json;
use tauri::Manager;

use crate::shell::{auth, backend_ready, config, providers_link};

pub async fn reload_backend(app: &tauri::AppHandle) {
    let Some(port) = backend_ready::bound_port() else {
        tracing::warn!(
            target: "fleet-shell",
            "providers reload: the app's backend hasn't reported its bind; not sending keys"
        );
        return;
    };
    let secret = match std::env::var("FLEETIFY_INTERNAL_SECRET") {
        Ok(s) => s,
        Err(_) => {
            tracing::warn!(
                target: "fleet-shell",
                "providers reload: FLEETIFY_INTERNAL_SECRET not set — backend may not be ready yet"
            );
            return;
        }
    };

    // Build the {provider_id: api_key} payload from config + keychain.
    // Skip silently when the user isn't signed in (the cache stays
    // empty, bridges fall back to env-var hints from the catalog).
    let mut keys: HashMap<String, String> = HashMap::new();
    let mut cloudflare_account_id: Option<String> = None;
    if let Ok(dir) = app.path().app_data_dir() {
        let cfg = config::load_config_from(&dir);
        let providers_cfg = config::providers_from(&cfg);
        cloudflare_account_id = providers_cfg.cloudflare_account_id.clone();
        if let Some(uid) = auth::get_user_id().await {
            for (provider_id, connected) in providers_cfg.connected.iter() {
                if !connected {
                    continue;
                }
                match providers_link::read_secret(provider_id, &uid) {
                    Ok(Some(k)) => {
                        keys.insert(provider_id.clone(), k);
                    }
                    Ok(None) => {
                        // Marked connected but keychain is empty (e.g.
                        // user disconnected, mutation hadn't reached
                        // the keychain when we read). Skip — the next
                        // reload after the keychain write lands will
                        // pick it up.
                    }
                    Err(e) => {
                        tracing::warn!(
                            target: "fleet-shell",
                            provider_id = %provider_id,
                            error = %e,
                            "providers reload: keychain read failed; skipping this entry"
                        );
                    }
                }
            }
        }
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .unwrap_or_default();

    // Multi-account: enumerate HTTP provider accounts from the backend, read
    // each labeled key from the keychain, and push them as `account_keys`
    // alongside the legacy System keys above. CLI agents need nothing here —
    // their isolation is a HOME override resolved from the DB at dispatch.
    let account_keys = build_account_keys(&client, port, &secret).await;

    let url = backend_ready::backend_url(port, "/api/internal/providers/reload");
    let payload = json!({
        "keys": keys,
        "cloudflare_account_id": cloudflare_account_id,
        "account_keys": account_keys,
    });
    let key_count = keys.len();
    match client
        .post(&url)
        .header("X-Fleet-Internal", &secret)
        .json(&payload)
        .send()
        .await
    {
        Ok(resp) if resp.status().is_success() => {
            tracing::info!(
                target: "fleet-shell",
                key_count = key_count,
                "providers reload: backend acked"
            );
        }
        Ok(resp) => {
            tracing::warn!(
                target: "fleet-shell",
                status = %resp.status(),
                "providers reload: backend returned non-2xx"
            );
        }
        Err(e) => {
            tracing::warn!(
                target: "fleet-shell",
                error = %e,
                "providers reload: POST failed (config + keychain still updated; next boot will pick up the change)"
            );
        }
    }
}

/// Ask the backend which HTTP provider accounts exist, then read each one's
/// labeled key from the OS keychain. Returns the `account_keys` array the
/// reload endpoint folds into its per-account cache. Best-effort: any failure
/// (backend not ready, no accounts, keychain miss) yields an empty list so the
/// System keys still load.
async fn build_account_keys(
    client: &reqwest::Client,
    port: u16,
    secret: &str,
) -> Vec<serde_json::Value> {
    let url = backend_ready::backend_url(port, "/api/internal/accounts/http");
    let resp = match client
        .get(&url)
        .header("X-Fleet-Internal", secret)
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => r,
        _ => return Vec::new(),
    };
    let body: serde_json::Value = match resp.json().await {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    let Some(accounts) = body.get("accounts").and_then(|a| a.as_array()) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for acc in accounts {
        let (Some(provider_id), Some(account_id)) = (
            acc.get("provider_id").and_then(|v| v.as_str()),
            acc.get("account_id").and_then(|v| v.as_str()),
        ) else {
            continue;
        };
        let is_default = acc
            .get("is_default")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        // The labeled key is stored under `account = <account_id>` (System keys
        // use `account = <oidc-sub>`, handled by the legacy path above).
        if let Ok(Some(key)) = providers_link::read_secret(provider_id, account_id) {
            out.push(json!({
                "provider_id": provider_id,
                "account_id": account_id,
                "key": key,
                "is_default": is_default,
            }));
        }
    }
    out
}

/// Boot-time hydration: hydrate PROVIDER_KEYS *and* prime the
/// HttpHealthCache so the first chat turn doesn't see a "No API key"
/// error and Settings → Models doesn't flash a "Testing…" state.
///
/// Fire-and-forget. lib.rs runs it only once the backend has reported its
/// bind and answered its health route; without that it sends nothing
/// (`backend_ready::bound_port`). The next user-driven IPC reruns
/// reload_backend, and the user can hit Test in Settings to refresh health
/// manually. No retry loop: the boot path stays simple.
pub async fn warm_providers_at_boot(app: &tauri::AppHandle) {
    let Some(port) = backend_ready::bound_port() else {
        tracing::warn!(
            target: "fleet-shell",
            "warm-health: the app's backend hasn't reported its bind; not sending anything"
        );
        return;
    };

    // 1) hydrate PROVIDER_KEYS from the keychain.
    reload_backend(app).await;

    // 2) hit /api/internal/providers/warm-health to fan-out health
    //    probes against every keyed provider.
    let secret = match std::env::var("FLEETIFY_INTERNAL_SECRET") {
        Ok(s) => s,
        Err(_) => {
            tracing::warn!(
                target: "fleet-shell",
                "warm-health: FLEETIFY_INTERNAL_SECRET not set — skipping (next IPC will warm)"
            );
            return;
        }
    };
    let url = backend_ready::backend_url(port, "/api/internal/providers/warm-health");
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .unwrap_or_default();
    match client
        .post(&url)
        .header("X-Fleet-Internal", &secret)
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => {
            tracing::info!(target: "fleet-shell", "warm-health: backend acked");
        }
        Ok(r) => {
            tracing::warn!(
                target: "fleet-shell",
                status = %r.status(),
                "warm-health: backend returned non-2xx"
            );
        }
        Err(e) => {
            tracing::warn!(
                target: "fleet-shell",
                error = %e,
                "warm-health: POST failed (next manual Test will refresh)"
            );
        }
    }
}
