//! Resolved router credentials passed from the Tauri shell into the
//! embedded backend at startup. The shell reads `fleet.config.json`
//! plus the per-user keychain, composes a `RoutingSetup`, and hands
//! it to `serve()` (in its `ServeOptions`) — keeping the backend Tauri-
//! agnostic while still allowing it to register external routers
//! (Not Diamond, Weave, LiteLLM) without round-tripping IPC at boot.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Resolved credentials for one external router, ready to register.
/// `base_url` falls back to the router's documented default when None.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResolvedRouterCredential {
    pub id: String,
    pub api_key: String,
    pub base_url: Option<String>,
}

/// Bundle of hydrated config the orchestrator needs at startup OR on a
/// live IPC-triggered reload.
///
/// Composed on the Tauri side from `fleet.config.json` + the user's
/// keychain entries, then either passed into `serve()` (in its
/// `ServeOptions`) at boot or POSTed to `/api/internal/routing/reload`
/// while the backend is already running. `enabled` is the master
/// "intelligent routing" toggle; the two `active_*` ids are the saved user
/// selections (default builtin / none-proxy when unset).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RoutingSetup {
    pub enabled: bool,
    pub active_decision_router: String,
    pub active_proxy_gateway: String,
    pub resolved: HashMap<String, ResolvedRouterCredential>,
}

impl RoutingSetup {
    /// Returns true when no external routers will be hydrated — useful
    /// for the boot-time log line that distinguishes fresh installs from
    /// configured ones.
    pub fn is_minimal(&self) -> bool {
        self.resolved.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_setup_is_disabled_with_defaults() {
        let s = RoutingSetup::default();
        assert!(!s.enabled);
        assert!(s.resolved.is_empty());
        assert!(s.active_decision_router.is_empty());
        assert!(s.active_proxy_gateway.is_empty());
        assert!(s.is_minimal());
    }

    #[test]
    fn is_minimal_flips_when_router_resolved() {
        let mut s = RoutingSetup::default();
        s.resolved.insert(
            "notdiamond".into(),
            ResolvedRouterCredential {
                id: "notdiamond".into(),
                api_key: "k".into(),
                base_url: None,
            },
        );
        assert!(!s.is_minimal());
    }

    #[test]
    fn resolved_credential_round_trip_fields() {
        let c = ResolvedRouterCredential {
            id: "weave".into(),
            api_key: "secret".into(),
            base_url: Some("https://example.test".into()),
        };
        assert_eq!(c.id, "weave");
        assert_eq!(c.api_key, "secret");
        assert_eq!(c.base_url.as_deref(), Some("https://example.test"));
    }
}
