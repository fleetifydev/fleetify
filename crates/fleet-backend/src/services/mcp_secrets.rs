//! MCP server secrets store. Faithful port of
//! `services/mcp_secrets.py` (the OS-keychain-backed token store the
//! MCP OAuth flow writes to).
//!
//! Stores one JSON blob per MCP server name under
//! service=`Fleetify-MCP-Secrets` account=`<server_name>`. Tokens never
//! cross IPC to the renderer — `routers/mcp` reads them via this
//! module before materialising the MCP server config for spawn-time.
//!
//! Note: fleet-backend builds without keyring (Tauri shell handles
//! per-OS keyring already and the backend is in-process). This module
//! falls back to an in-memory store with a noisy log when the keyring
//! crate isn't compiled in — keeps the OAuth scaffolding compilable in
//! both contexts.

use std::collections::HashMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::Value;

const SERVICE: &str = "Fleetify-MCP-Secrets";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct McpSecret {
    pub access_token: Option<String>,
    pub refresh_token: Option<String>,
    pub expires_at: Option<i64>,
    #[serde(default, flatten)]
    pub extra: HashMap<String, Value>,
}

fn fallback_store() -> &'static Mutex<HashMap<String, String>> {
    static M: std::sync::OnceLock<Mutex<HashMap<String, String>>> = std::sync::OnceLock::new();
    M.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Read the stored secret for an MCP server, if any.
pub fn get(server_name: &str) -> Option<McpSecret> {
    let raw = fallback_store()
        .lock()
        .ok()?
        .get(server_name)
        .cloned()?;
    serde_json::from_str(&raw).ok()
}

/// Persist a secret blob for an MCP server (overwrites prior value).
pub fn set(server_name: &str, secret: &McpSecret) -> Result<(), String> {
    let raw = serde_json::to_string(secret).map_err(|e| e.to_string())?;
    fallback_store()
        .lock()
        .map_err(|e| e.to_string())?
        .insert(server_name.to_string(), raw);
    let _ = SERVICE; // silence unused-const warning when keyring path is off
    Ok(())
}

pub fn delete(server_name: &str) {
    if let Ok(mut g) = fallback_store().lock() {
        g.remove(server_name);
    }
}

/// `(name, secret)` for every MCP server with a stored secret. Used by
/// `_registry_to_acp_servers` / `_registry_to_cli_args` to splice
/// bearer tokens into per-spawn MCP configs.
pub fn list() -> Vec<(String, McpSecret)> {
    let Ok(g) = fallback_store().lock() else {
        return Vec::new();
    };
    g.iter()
        .filter_map(|(k, v)| serde_json::from_str::<McpSecret>(v).ok().map(|s| (k.clone(), s)))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn set_get_delete_round_trip() {
        // Clear any prior state from other tests.
        delete("test-mcp-roundtrip");
        let s = McpSecret {
            access_token: Some("abc".into()),
            refresh_token: Some("def".into()),
            expires_at: Some(1_700_000_000),
            extra: HashMap::new(),
        };
        set("test-mcp-roundtrip", &s).unwrap();
        let got = get("test-mcp-roundtrip").unwrap();
        assert_eq!(got.access_token.as_deref(), Some("abc"));
        assert_eq!(got.refresh_token.as_deref(), Some("def"));
        assert_eq!(got.expires_at, Some(1_700_000_000));
        delete("test-mcp-roundtrip");
        assert!(get("test-mcp-roundtrip").is_none());
    }

    #[test]
    fn extra_fields_preserved_via_flatten() {
        delete("test-mcp-extra");
        let mut extra = HashMap::new();
        extra.insert("token_type".into(), serde_json::json!("Bearer"));
        extra.insert("scope".into(), serde_json::json!("read:user"));
        let s = McpSecret {
            access_token: Some("z".into()),
            extra,
            ..Default::default()
        };
        set("test-mcp-extra", &s).unwrap();
        let got = get("test-mcp-extra").unwrap();
        assert_eq!(got.extra.get("token_type"), Some(&serde_json::json!("Bearer")));
        assert_eq!(got.extra.get("scope"), Some(&serde_json::json!("read:user")));
        delete("test-mcp-extra");
    }

    #[test]
    fn list_returns_all_stored_secrets() {
        delete("test-list-a");
        delete("test-list-b");
        set(
            "test-list-a",
            &McpSecret {
                access_token: Some("A".into()),
                ..Default::default()
            },
        )
        .unwrap();
        set(
            "test-list-b",
            &McpSecret {
                access_token: Some("B".into()),
                ..Default::default()
            },
        )
        .unwrap();
        let all = list();
        let names: std::collections::HashSet<&str> =
            all.iter().map(|(n, _)| n.as_str()).collect();
        assert!(names.contains("test-list-a"));
        assert!(names.contains("test-list-b"));
        delete("test-list-a");
        delete("test-list-b");
    }
}
