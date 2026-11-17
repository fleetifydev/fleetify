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
    /// Cloudflare account id for the `cloudflare-workers-ai` provider.
    /// Substituted into the account-scoped Workers AI base URL at dispatch
    /// (backend `cloudflare_base_url_from_cfg`). `None` ⇒ not connected; the
    /// renderer shows the "Connect" card. Not a secret (the token lives in
    /// the OS keychain), so it round-trips in `fleet.config.json`.
    #[serde(default)]
    pub cloudflare_account_id: Option<String>,
    /// Ollama Cloud base URL. `None` ⇒ falls back to `https://ollama.com`.
    /// Editable for forward-compat / self-hosted gateways. Not a secret (the
    /// key lives in the OS keychain), so it round-trips in fleet.config.json.
    #[serde(default)]
    pub ollama_cloud_base_url: Option<String>,
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

/// Whether the commits and pull requests the app makes credit Fleetify (a
/// `Co-Authored-By` trailer and a PR footer). Settings → General →
/// Attribution writes the flat `gitAttribution` key; absent or non-boolean
/// means on, the default.
pub fn git_attribution_from(cfg: &Value) -> bool {
    cfg.get("gitAttribution")
        .and_then(Value::as_bool)
        .unwrap_or(true)
}

/// The two telemetry consents, at `fleet.config.json::telemetry` (parallel
/// to `routing` / `providers`).
///
/// PostHog product analytics: default `posthog_enabled` is `false` —
/// flipped only by explicit user consent in the onboarding step or in
/// Settings → Privacy. `posthog_enabled_at` records the first opt-in
/// timestamp (Unix ms) so funnels can distinguish fresh consenters from
/// users who've been enabled for ages.
///
/// Fleetify cloud sync (the fleetify.dev dashboard): `cloud_sync_enabled`
/// is the saved switch — `None` until the user flips it; read it through
/// [`cloud_sync_from`], which also covers the legacy flag and the default.
/// `cloud_sync_enabled_at` records the first opt-in (Unix ms).
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct TelemetryConfig {
    #[serde(default)]
    pub posthog_enabled: bool,
    #[serde(default)]
    pub posthog_enabled_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cloud_sync_enabled: Option<bool>,
    #[serde(default)]
    pub cloud_sync_enabled_at: Option<i64>,
}

/// Whether Fleetify cloud sync is on for a user who never flipped the
/// switch. The owner's decision; nothing else may hard-code it.
pub const CLOUD_SYNC_DEFAULT: bool = false;

/// Whether Fleetify cloud sync is on. In order:
/// 1. `telemetry.cloud_sync_enabled`, when it is a bool;
/// 2. `false` when the legacy top-level `telemetryEnabled` is exactly
///    `false` — an explicit opt-out from the old switch still counts (its
///    `true` does not: that switch was never read and defaulted to on);
/// 3. [`CLOUD_SYNC_DEFAULT`].
pub fn cloud_sync_from(cfg: &Value) -> bool {
    if let Some(on) = cfg
        .get("telemetry")
        .and_then(|t| t.get("cloud_sync_enabled"))
        .and_then(Value::as_bool)
    {
        return on;
    }
    if cfg.get("telemetryEnabled").and_then(Value::as_bool) == Some(false) {
        return false;
    }
    CLOUD_SYNC_DEFAULT
}

pub fn telemetry_from(cfg: &Value) -> TelemetryConfig {
    cfg.get("telemetry")
        .and_then(|v| serde_json::from_value::<TelemetryConfig>(v.clone()).ok())
        .unwrap_or_default()
}

pub fn telemetry_set(cfg: &mut Value, telem: &TelemetryConfig) {
    let val = serde_json::to_value(telem).unwrap_or_else(|_| json!({}));
    match cfg {
        Value::Object(map) => {
            map.insert("telemetry".into(), val);
        }
        _ => {
            *cfg = json!({ "telemetry": val });
        }
    }
}

/// Save the Fleetify cloud sync switch in `dir`'s `fleet.config.json`:
/// read-merge-write `telemetry.cloud_sync_enabled`, stamping
/// `cloud_sync_enabled_at` on the first opt-in only (turning it off, or on
/// again later, keeps that time). `Err` carries a message fit for the user.
pub fn persist_cloud_choice(dir: &Path, enabled: bool) -> Result<(), String> {
    let mut cfg = load_config_from(dir);
    let was_enabled = cloud_sync_from(&cfg);
    let mut telem = telemetry_from(&cfg);
    telem.cloud_sync_enabled = Some(enabled);
    if enabled && !was_enabled && telem.cloud_sync_enabled_at.is_none() {
        telem.cloud_sync_enabled_at = Some(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0),
        );
    }
    telemetry_set(&mut cfg, &telem);
    save_config_to(dir, &cfg).map_err(|e| format!("Couldn't save the cloud sync setting: {e}"))
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
            enabled_agents: vec!["claude-code".into(), "kimi-code".into()],
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
        assert_eq!(back.enabled_agents, vec!["claude-code", "kimi-code"]);
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
    fn providers_config_round_trips_cloud_base_url() {
        let json =
            serde_json::json!({ "providers": { "ollama_cloud_base_url": "https://ollama.com" } });
        let p = providers_from(&json);
        assert_eq!(
            p.ollama_cloud_base_url.as_deref(),
            Some("https://ollama.com")
        );
        let def = ProvidersConfig::default();
        assert!(def.ollama_cloud_base_url.is_none());
    }

    #[test]
    fn providers_section_defaults_when_corrupt() {
        let cfg = json!({ "providers": "not an object" });
        let p = providers_from(&cfg);
        assert!(p.connected.is_empty());
        assert!(p.enabled_models.is_empty());
    }

    #[test]
    fn telemetry_section_round_trip() {
        let mut cfg = json!({});
        let t = TelemetryConfig {
            posthog_enabled: true,
            posthog_enabled_at: Some(1_700_000_000_000),
            ..Default::default()
        };
        telemetry_set(&mut cfg, &t);
        let back = telemetry_from(&cfg);
        assert!(back.posthog_enabled);
        assert_eq!(back.posthog_enabled_at, Some(1_700_000_000_000));
    }

    #[test]
    fn telemetry_section_defaults_when_missing() {
        let cfg = json!({ "theme": "dark" });
        let t = telemetry_from(&cfg);
        assert!(!t.posthog_enabled);
        assert!(t.posthog_enabled_at.is_none());
    }

    #[test]
    fn telemetry_section_defaults_when_corrupt() {
        let cfg = json!({ "telemetry": "not an object" });
        let t = telemetry_from(&cfg);
        assert!(!t.posthog_enabled);
    }

    #[test]
    fn telemetry_and_other_sections_coexist() {
        // The three top-level sections (routing, providers, telemetry)
        // must round-trip independently from the same Value.
        let mut cfg = json!({});
        let r = RoutingConfig {
            enabled: true,
            ..Default::default()
        };
        routing_set(&mut cfg, &r);
        let p = ProvidersConfig {
            enabled_agents: vec!["claude-code".into()],
            ..Default::default()
        };
        providers_set(&mut cfg, &p);
        let t = TelemetryConfig {
            posthog_enabled: true,
            posthog_enabled_at: Some(42),
            ..Default::default()
        };
        telemetry_set(&mut cfg, &t);

        assert!(routing_from(&cfg).enabled);
        assert_eq!(
            providers_from(&cfg).enabled_agents,
            vec!["claude-code".to_string()]
        );
        assert!(telemetry_from(&cfg).posthog_enabled);
        assert_eq!(telemetry_from(&cfg).posthog_enabled_at, Some(42));
    }

    #[test]
    fn cloud_sync_falls_back_to_the_default_when_unset_or_not_a_bool() {
        assert_eq!(cloud_sync_from(&json!({})), CLOUD_SYNC_DEFAULT);
        assert_eq!(cloud_sync_from(&Value::Null), CLOUD_SYNC_DEFAULT);
        assert_eq!(cloud_sync_from(&json!("on")), CLOUD_SYNC_DEFAULT);
        assert_eq!(
            cloud_sync_from(&json!({"telemetry": {"cloud_sync_enabled": null}})),
            CLOUD_SYNC_DEFAULT
        );
        assert_eq!(
            cloud_sync_from(&json!({"telemetry": {"cloud_sync_enabled": "true"}})),
            CLOUD_SYNC_DEFAULT
        );
    }

    #[test]
    fn cloud_sync_honours_the_saved_choice() {
        assert!(cloud_sync_from(
            &json!({"telemetry": {"cloud_sync_enabled": true}})
        ));
        assert!(!cloud_sync_from(
            &json!({"telemetry": {"cloud_sync_enabled": false}})
        ));
    }

    #[test]
    fn cloud_sync_honours_an_old_explicit_opt_out() {
        assert!(!cloud_sync_from(&json!({"telemetryEnabled": false})));
        // The old switch was never read and defaulted to on, so `true`
        // there is not a choice the user made.
        assert_eq!(
            cloud_sync_from(&json!({"telemetryEnabled": true})),
            CLOUD_SYNC_DEFAULT
        );
    }

    #[test]
    fn saved_cloud_sync_choice_wins_over_the_old_flag() {
        assert!(cloud_sync_from(&json!({
            "telemetry": {"cloud_sync_enabled": true},
            "telemetryEnabled": false
        })));
    }

    #[test]
    fn posthog_toggle_keeps_the_cloud_sync_choice() {
        // telemetry_set_posthog_enabled reads the telemetry section into
        // TelemetryConfig and writes the whole struct back.
        let mut cfg = json!({
            "telemetry": {"cloud_sync_enabled": true, "cloud_sync_enabled_at": 42}
        });
        let mut t = telemetry_from(&cfg);
        t.posthog_enabled = true;
        telemetry_set(&mut cfg, &t);
        assert_eq!(cfg["telemetry"]["cloud_sync_enabled"], json!(true));
        assert_eq!(cfg["telemetry"]["cloud_sync_enabled_at"], json!(42));
    }

    #[test]
    fn persisting_the_cloud_choice_writes_the_key() {
        let tmp = tempfile::tempdir().unwrap();
        save_config_to(tmp.path(), &json!({"theme": "dark"})).unwrap();

        persist_cloud_choice(tmp.path(), true).unwrap();
        let cfg = load_config_from(tmp.path());
        assert_eq!(cfg["telemetry"]["cloud_sync_enabled"], json!(true));
        assert!(
            cfg["telemetry"]["cloud_sync_enabled_at"].is_i64(),
            "first opt-in stamped: {cfg}"
        );
        assert_eq!(cfg["theme"], json!("dark"), "other settings kept");
        let first_opt_in = cfg["telemetry"]["cloud_sync_enabled_at"].clone();

        persist_cloud_choice(tmp.path(), false).unwrap();
        let cfg = load_config_from(tmp.path());
        assert_eq!(cfg["telemetry"]["cloud_sync_enabled"], json!(false));
        assert_eq!(cfg["telemetry"]["cloud_sync_enabled_at"], first_opt_in);

        // Opting in again keeps the first opt-in time.
        persist_cloud_choice(tmp.path(), true).unwrap();
        let cfg = load_config_from(tmp.path());
        assert_eq!(cfg["telemetry"]["cloud_sync_enabled"], json!(true));
        assert_eq!(cfg["telemetry"]["cloud_sync_enabled_at"], first_opt_in);
    }

    #[test]
    fn persisting_the_cloud_choice_reports_a_failed_save() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("a-file");
        std::fs::write(&file, "not a folder").unwrap();
        // The settings folder would have to live under a regular file.
        let err = persist_cloud_choice(&file.join("settings"), false).unwrap_err();
        assert!(
            err.starts_with("Couldn't save the cloud sync setting: "),
            "{err}"
        );
    }

    #[test]
    fn providers_round_trip_cloudflare_account_id() {
        let mut cfg = json!({});
        let p = ProvidersConfig {
            cloudflare_account_id: Some("acc_123".into()),
            ..ProvidersConfig::default()
        };
        providers_set(&mut cfg, &p);
        let back = providers_from(&cfg);
        assert_eq!(back.cloudflare_account_id.as_deref(), Some("acc_123"));
    }

    #[test]
    fn providers_default_cloudflare_account_id_is_none() {
        assert!(ProvidersConfig::default().cloudflare_account_id.is_none());
    }

    #[test]
    fn attribution_defaults_on() {
        assert!(git_attribution_from(&json!({})));
    }

    #[test]
    fn attribution_respects_false() {
        assert!(!git_attribution_from(&json!({"gitAttribution": false})));
    }

    #[test]
    fn attribution_ignores_non_boolean_values() {
        assert!(git_attribution_from(&json!({"gitAttribution": "false"})));
        assert!(git_attribution_from(&json!({"gitAttribution": 0})));
        assert!(git_attribution_from(&json!({"gitAttribution": null})));
    }

    #[test]
    fn attribution_opt_out_survives_save_and_reload() {
        let tmp = tempfile::tempdir().unwrap();
        save_config_to(
            tmp.path(),
            &json!({"theme": "dark", "gitAttribution": false}),
        )
        .unwrap();
        assert!(!git_attribution_from(&load_config_from(tmp.path())));
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
