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

use std::collections::HashMap;

use serde_json::json;
use tauri::Manager;

use crate::shell::{auth, config, providers_link};

pub async fn reload_backend(app: &tauri::AppHandle) {
    let port = std::env::var("FLEETIFY_BACKEND_PORT").unwrap_or_else(|_| "8765".into());
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

    let url = format!("http://127.0.0.1:{port}/api/internal/providers/reload");
    let payload = json!({ "keys": keys, "cloudflare_account_id": cloudflare_account_id });
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .unwrap_or_default();
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

/// Boot-time hydration: hydrate PROVIDER_KEYS *and* prime the
/// HttpHealthCache so the first chat turn doesn't see a "No API key"
/// error and Settings → Models doesn't flash a "Testing…" state.
///
/// Fire-and-forget. If the backend isn't listening yet, the inner
/// HTTP calls fail and log — the next user-driven IPC will rerun
/// reload_backend, and the user can hit Test in Settings to refresh
/// health manually. No retry loop: the boot path stays simple.
pub async fn warm_providers_at_boot(app: &tauri::AppHandle) {
    // 1) hydrate PROVIDER_KEYS from the keychain.
    reload_backend(app).await;

    // 2) hit /api/internal/providers/warm-health to fan-out health
    //    probes against every keyed provider.
    let port = std::env::var("FLEETIFY_BACKEND_PORT").unwrap_or_else(|_| "8765".into());
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
    let url = format!("http://127.0.0.1:{port}/api/internal/providers/warm-health");
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
