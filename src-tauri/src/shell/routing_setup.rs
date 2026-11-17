//! Compose the embedded backend's `RoutingSetup` from on-disk config
//! (`fleet.config.json`) and the per-user keychain. Called once from the
//! Tauri setup hook before `fleetify_backend::serve_with_routing_setup`
//! so external routers (Not Diamond, Weave, LiteLLM) are registered with
//! the orchestrator at boot.
//!
//! Also re-used by every `routers_*` IPC mutation: after writing config
//! plus keychain the IPC handler rebuilds the `RoutingSetup` from disk
//! and POSTs it to the running backend at `/api/internal/routing/reload`
//! so the change takes effect immediately rather than waiting for the
//! next app restart.

use std::path::Path;

use fleetify_backend::services::routing::setup::{ResolvedRouterCredential, RoutingSetup};

use crate::shell::config;

/// Build the `RoutingSetup` from on-disk config under `app_data_dir`,
/// resolving each connected router's secret via the per-user keychain.
/// `user_id` is the OIDC `sub` (or the no-auth stub when running with
/// `FLEETIFY_NOAUTH=1`); when `None`, external routers stay un-resolved
/// — the master toggle / active selections are still honoured so the
/// backend can degrade to builtin / none-proxy cleanly.
pub fn build(app_data_dir: &Path, user_id: Option<&str>) -> RoutingSetup {
    let cfg = config::load_config_from(app_data_dir);
    let routing = config::routing_from(&cfg);

    let mut setup = RoutingSetup {
        enabled: routing.enabled,
        active_decision_router: routing.active_decision_router.clone(),
        active_proxy_gateway: routing.active_proxy_gateway.clone(),
        ..Default::default()
    };

    let Some(uid) = user_id else {
        // No signed-in user → can't resolve secrets. Return setup with
        // toggles + active ids preserved; the backend will fall back to
        // builtin / none-proxy for anything not registered.
        return setup;
    };

    for (id, conn) in routing.connected_routers.iter() {
        if !conn.connected {
            continue;
        }
        // builtin / none-proxy are always-present in the orchestrator —
        // never resolved here. Filter them out before keychain lookup so
        // we don't surface confusing "NO_SECRET" logs for the immortal
        // defaults.
        if id == "builtin" || id == "none-proxy" {
            continue;
        }
        let api_key = match crate::shell::routers_link::read_secret(id, uid) {
            Ok(Some(s)) => s,
            Ok(None) => {
                tracing::warn!(
                    target: "fleet-shell",
                    router_id = %id,
                    "routing setup: connected router has no keychain entry; skipping"
                );
                continue;
            }
            Err(e) => {
                tracing::warn!(
                    target: "fleet-shell",
                    router_id = %id,
                    error = %e,
                    "routing setup: keychain read failed; skipping"
                );
                continue;
            }
        };
        let base_url = conn
            .metadata
            .get("base_url")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        setup.resolved.insert(
            id.clone(),
            ResolvedRouterCredential {
                id: id.clone(),
                api_key,
                base_url,
            },
        );
    }

    setup
}

/// Rebuild the setup from disk and POST it to the running backend's
/// `/api/internal/routing/reload` endpoint. Called after each `routers_*`
/// IPC mutation so the live orchestrator picks up new credentials /
/// active selections without an app restart.
///
/// Fire-and-forget: failures are logged but never propagated to the IPC
/// caller. The config + keychain are already updated regardless, so the
/// next backend boot will pick up the change even if this round-trip
/// fails (e.g. a transient I/O hiccup).
///
/// The router keys go only to the app's own backend, once it has reported
/// its bind (`backend_ready::bound_port`); before that nothing is sent.
pub async fn reload_backend(app: &tauri::AppHandle) {
    use tauri::Manager;

    let Some(port) = crate::shell::backend_ready::bound_port() else {
        tracing::warn!(
            target: "fleet-shell",
            "routing reload: the app's backend hasn't reported its bind; not sending keys"
        );
        return;
    };
    let Ok(dir) = app.path().app_data_dir() else {
        tracing::warn!(target: "fleet-shell", "routing reload: app_data_dir unavailable");
        return;
    };
    let uid = crate::shell::auth::get_user_id().await;
    let setup = build(&dir, uid.as_deref());

    let secret = match std::env::var("FLEETIFY_INTERNAL_SECRET") {
        Ok(s) => s,
        Err(_) => {
            tracing::warn!(
                target: "fleet-shell",
                "routing reload: FLEETIFY_INTERNAL_SECRET not set — backend may not be ready yet"
            );
            return;
        }
    };
    let url = crate::shell::backend_ready::backend_url(port, "/api/internal/routing/reload");

    // Never through a proxy: these are the router keys (fleetify_core::loopback).
    let client = match fleetify_core::loopback::http_client_builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
    {
        Ok(client) => client,
        Err(e) => {
            tracing::warn!(
                target: "fleet-shell",
                error = %e,
                "routing reload: couldn't build the HTTP client; not sending keys"
            );
            return;
        }
    };
    match client
        .post(&url)
        .header("X-Fleet-Internal", &secret)
        .json(&setup)
        .send()
        .await
    {
        Ok(resp) if resp.status().is_success() => {
            tracing::info!(
                target: "fleet-shell",
                resolved = setup.resolved.len(),
                active_decision = %setup.active_decision_router,
                "routing reload: backend acked"
            );
        }
        Ok(resp) => {
            tracing::warn!(
                target: "fleet-shell",
                status = %resp.status(),
                "routing reload: backend returned non-2xx"
            );
        }
        Err(e) => {
            tracing::warn!(
                target: "fleet-shell",
                error = %e,
                "routing reload: POST failed (config + keychain still updated; next boot will pick up the change)"
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn empty_dir_yields_default_setup() {
        let tmp = tempfile::tempdir().unwrap();
        let s = build(tmp.path(), Some("uid"));
        assert!(!s.enabled);
        assert_eq!(s.active_decision_router, "builtin");
        assert_eq!(s.active_proxy_gateway, "none-proxy");
        assert!(s.resolved.is_empty());
    }

    #[test]
    fn config_without_user_skips_secret_resolution() {
        let tmp = tempfile::tempdir().unwrap();
        let cfg = json!({
            "routing": {
                "enabled": true,
                "active_decision_router": "notdiamond",
                "active_proxy_gateway": "none-proxy",
                "connected_routers": {
                    "notdiamond": { "connected": true, "metadata": {} }
                }
            }
        });
        config::save_config_to(tmp.path(), &cfg).unwrap();
        let s = build(tmp.path(), None);
        assert!(s.enabled);
        assert_eq!(s.active_decision_router, "notdiamond");
        // No user → keychain skipped → resolved map stays empty.
        assert!(s.resolved.is_empty());
    }

    #[test]
    fn disconnected_routers_are_skipped() {
        let tmp = tempfile::tempdir().unwrap();
        let cfg = json!({
            "routing": {
                "enabled": false,
                "active_decision_router": "builtin",
                "active_proxy_gateway": "none-proxy",
                "connected_routers": {
                    "notdiamond": { "connected": false, "metadata": {} }
                }
            }
        });
        config::save_config_to(tmp.path(), &cfg).unwrap();
        let s = build(tmp.path(), Some("uid"));
        assert!(s.resolved.is_empty());
    }

    #[test]
    fn builtin_and_none_proxy_skipped_even_when_present() {
        let tmp = tempfile::tempdir().unwrap();
        let cfg = json!({
            "routing": {
                "enabled": true,
                "active_decision_router": "builtin",
                "active_proxy_gateway": "none-proxy",
                "connected_routers": {
                    "builtin":    { "connected": true, "metadata": {} },
                    "none-proxy": { "connected": true, "metadata": {} }
                }
            }
        });
        config::save_config_to(tmp.path(), &cfg).unwrap();
        let s = build(tmp.path(), Some("uid"));
        // Neither immortal default ends up in resolved (would be wasted
        // keychain reads / spurious warnings).
        assert!(!s.resolved.contains_key("builtin"));
        assert!(!s.resolved.contains_key("none-proxy"));
    }
}
