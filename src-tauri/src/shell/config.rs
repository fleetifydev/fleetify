//! Persisted app config — backs `window.electronAPI.getConfig` /
//! `setConfig`. Faithful in spirit to the Electron `electron-store`-style
//! JSON-on-disk used by the original.

use std::collections::HashMap;
use std::path::Path;

use serde_json::{json, Value};

const CONFIG_FILE: &str = "fleet.config.json";

/// Load JSON config; returns `{}` when the file doesn't exist or fails to
/// parse (parity with the Electron store's "no file = empty object").
pub fn load_config_from(path: &Path) -> Value {
    let file = path.join(CONFIG_FILE);
    match std::fs::read_to_string(&file) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_else(|_| json!({})),
        Err(_) => json!({}),
    }
}

/// Save JSON config atomically (write `.tmp` then rename, so a crash
/// mid-write doesn't corrupt the existing config file).
pub fn save_config_to(path: &Path, cfg: &Value) -> std::io::Result<()> {
    std::fs::create_dir_all(path)?;
    let file = path.join(CONFIG_FILE);
    let tmp = path.join(format!("{CONFIG_FILE}.tmp"));
    std::fs::write(&tmp, serde_json::to_string_pretty(cfg).unwrap_or_default())?;
    std::fs::rename(&tmp, &file)?;
    Ok(())
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct RoutingConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_decision_router")]
    pub active_decision_router: String,
    #[serde(default = "default_proxy_gateway")]
    pub active_proxy_gateway: String,
    #[serde(default)]
    pub connected_routers: HashMap<String, ConnectedRouter>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ConnectedRouter {
    pub connected: bool,
    #[serde(default)]
    pub metadata: serde_json::Value,
}

fn default_decision_router() -> String {
    "builtin".into()
}
fn default_proxy_gateway() -> String {
    "none-proxy".into()
}

impl Default for RoutingConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            active_decision_router: default_decision_router(),
            active_proxy_gateway: default_proxy_gateway(),
            connected_routers: HashMap::new(),
        }
    }
}

/// Read the `"routing"` section from a config Value, defaulting when absent or invalid.
pub fn routing_from(cfg: &Value) -> RoutingConfig {
    cfg.get("routing")
        .and_then(|v| serde_json::from_value::<RoutingConfig>(v.clone()).ok())
        .unwrap_or_default()
}

/// Replace the `"routing"` section in a config Value.
pub fn routing_set(cfg: &mut Value, routing: &RoutingConfig) {
    let val = serde_json::to_value(routing).unwrap_or_else(|_| json!({}));
    match cfg {
        Value::Object(map) => {
            map.insert("routing".into(), val);
        }
        _ => {
            *cfg = json!({ "routing": val });
        }
    }
}

/// Per-user provider state — which API providers the user has connected,
/// which models from each provider are enabled in the picker, plus the
/// Ollama base URL and the active CLI-agent shortlist.
///
/// Secrets do NOT live here — they're in the OS keychain under
/// `Fleetify-Provider-<id>`. This struct only carries non-secret state
/// (booleans, model id lists, the Ollama URL, the enabled-agents list)
/// so it can be JSON-serialized into `fleet.config.json` without
/// surfacing a credential on disk.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct ProvidersConfig {
    /// provider_id → connected. `true` means a keychain entry exists and
    /// the renderer should show a green pill. Disconnect clears the entry
    /// here AND in the keychain so the two stay in sync.
    #[serde(default)]
    pub connected: HashMap<String, bool>,
    /// provider_id → list of model ids enabled in the chat composer's
    /// picker. Empty list ⇒ provider's `default_models` are all enabled.
    /// Phase 2 wires the Settings UI; Phase 3's picker reads from here.
    #[serde(default)]
    pub enabled_models: HashMap<String, Vec<String>>,
    /// Ollama base URL. `None` ⇒ falls back to `http://localhost:11434`.
    /// User can point this at a LAN box (`http://192.168.1.50:11434`) so
    /// the desktop client uses a beefier remote rig for inference.
    #[serde(default)]
    pub ollama_base_url: Option<String>,
    /// Active CLI agents — the shortlist shown in Settings → Agents'
    /// "Active" section + the New Agent dialog. Onboarding writes the
    /// user's first picks here; Settings reads + edits.
    #[serde(default)]
    pub enabled_agents: Vec<String>,
}

/// Read the `"providers"` section from a config Value. Defaults when
/// absent OR when the existing section is malformed (parity with
/// `routing_from`'s defensive parse).
pub fn providers_from(cfg: &Value) -> ProvidersConfig {
    cfg.get("providers")
        .and_then(|v| serde_json::from_value::<ProvidersConfig>(v.clone()).ok())
        .unwrap_or_default()
}

/// Replace the `"providers"` section in a config Value.
pub fn providers_set(cfg: &mut Value, providers: &ProvidersConfig) {
    let val = serde_json::to_value(providers).unwrap_or_else(|_| json!({}));
    match cfg {
        Value::Object(map) => {
            map.insert("providers".into(), val);
        }
        _ => {
            *cfg = json!({ "providers": val });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn load_empty_when_missing() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(load_config_from(tmp.path()), json!({}));
    }

    #[test]
    fn roundtrip_save_then_load() {
        let tmp = tempfile::tempdir().unwrap();
        let v = json!({"theme":"dark","apiKeys":{"openai":"sk-test"}});
        save_config_to(tmp.path(), &v).unwrap();
        assert_eq!(load_config_from(tmp.path()), v);
    }

    #[test]
    fn corrupt_file_falls_back_to_empty() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join(CONFIG_FILE), "{not valid json").unwrap();
        assert_eq!(load_config_from(tmp.path()), json!({}));
    }

    #[test]
    fn routing_section_round_trip() {
        let mut cfg = json!({});
        let mut r = RoutingConfig {
            enabled: true,
            active_decision_router: "notdiamond".into(),
            active_proxy_gateway: "weave".into(),
            ..Default::default()
        };
        r.connected_routers.insert(
            "notdiamond".into(),
            ConnectedRouter {
                connected: true,
                metadata: json!({ "workspace_id": "ws_1" }),
            },
        );
        routing_set(&mut cfg, &r);

        let back = routing_from(&cfg);
        assert!(back.enabled);
        assert_eq!(back.active_decision_router, "notdiamond");
        assert_eq!(back.active_proxy_gateway, "weave");
        assert!(back.connected_routers.contains_key("notdiamond"));
        assert_eq!(
            back.connected_routers["notdiamond"].metadata,
            json!({ "workspace_id": "ws_1" })
        );
    }

    #[test]
    fn routing_section_defaults_when_missing() {
        let cfg = json!({ "theme": "dark" });
        let r = routing_from(&cfg);
        assert!(!r.enabled);
        assert_eq!(r.active_decision_router, "builtin");
        assert_eq!(r.active_proxy_gateway, "none-proxy");
        assert!(r.connected_routers.is_empty());
    }

    #[test]
    fn routing_section_defaults_when_corrupt() {
        let cfg = json!({ "routing": "not an object" });
        let r = routing_from(&cfg);
        assert!(!r.enabled);
        assert_eq!(r.active_decision_router, "builtin");
    }

    #[test]
    fn providers_section_round_trip() {
        let mut cfg = json!({});
        let mut p = ProvidersConfig {
            ollama_base_url: Some("http://192.168.1.50:11434".into()),
            enabled_agents: vec!["claude".into(), "kimi".into()],
            ..Default::default()
        };
        p.connected.insert("openai".into(), true);
        p.connected.insert("perplexity".into(), true);
        p.enabled_models
            .insert("openai".into(), vec!["o3".into(), "gpt-4o".into()]);

        providers_set(&mut cfg, &p);
        let back = providers_from(&cfg);
        assert_eq!(
            back.ollama_base_url.as_deref(),
            Some("http://192.168.1.50:11434")
        );
        assert_eq!(back.enabled_agents, vec!["claude", "kimi"]);
        assert_eq!(back.connected.get("openai"), Some(&true));
        assert_eq!(back.connected.get("perplexity"), Some(&true));
        assert_eq!(
            back.enabled_models.get("openai").map(Vec::as_slice),
            Some(["o3".to_string(), "gpt-4o".to_string()].as_slice())
        );
    }

    #[test]
    fn providers_section_defaults_when_missing() {
        let cfg = json!({ "theme": "dark" });
        let p = providers_from(&cfg);
        assert!(p.connected.is_empty());
        assert!(p.enabled_models.is_empty());
        assert!(p.ollama_base_url.is_none());
        assert!(p.enabled_agents.is_empty());
    }

    #[test]
    fn providers_section_defaults_when_corrupt() {
        let cfg = json!({ "providers": "not an object" });
        let p = providers_from(&cfg);
        assert!(p.connected.is_empty());
        assert!(p.enabled_models.is_empty());
    }

    #[test]
    fn providers_and_routing_coexist_in_same_config() {
        // Sanity check that the two sections don't clobber each other —
        // both round-trip cleanly out of the same Value.
        let mut cfg = json!({});
        let mut r = RoutingConfig {
            enabled: true,
            ..Default::default()
        };
        r.connected_routers.insert(
            "weave".into(),
            ConnectedRouter {
                connected: true,
                metadata: json!({}),
            },
        );
        routing_set(&mut cfg, &r);
        let mut p = ProvidersConfig::default();
        p.connected.insert("openai".into(), true);
        providers_set(&mut cfg, &p);

        let r_back = routing_from(&cfg);
        let p_back = providers_from(&cfg);
        assert!(r_back.enabled);
        assert_eq!(
            r_back.connected_routers.get("weave").map(|c| c.connected),
            Some(true)
        );
        assert_eq!(p_back.connected.get("openai"), Some(&true));
    }
}
