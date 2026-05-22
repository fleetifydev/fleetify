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
        let mut r = RoutingConfig::default();
        r.enabled = true;
        r.active_decision_router = "notdiamond".into();
        r.active_proxy_gateway = "weave".into();
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
}
