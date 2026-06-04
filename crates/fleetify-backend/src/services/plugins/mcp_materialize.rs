//! Materialize a plugin's MCP servers into the shared user registry
//! (`~/.fleetify/mcp_servers.json`). This is the ONLY write needed for MCP:
//! the per-bridge emitters in `mcp_dispatch` fan the registry out to every
//! agent at spawn (Claude `--mcp-config`, ACP `session/new`, Codex `-c`
//! flags, agy's `mcp_config.json`, the SDK list), so a plugin's servers
//! reach all MCP-capable providers without any per-provider work.
//!
//! `${secret:KEY}` placeholders in the plugin's `mcp.json` are resolved
//! from the install-time secret map (a missing key is left literal so the
//! gap is visible, never silently blanked).

use std::collections::BTreeMap;
use std::path::Path;

use serde_json::Value;

#[derive(Debug, Default, Clone, serde::Serialize)]
pub struct McpResult {
    /// Registry server names this plugin added (for cleanup on uninstall).
    pub added: Vec<String>,
    /// Names skipped because a server of that name already existed (we
    /// never clobber a user's or another plugin's entry).
    pub skipped: Vec<String>,
}

/// Read `<install>/mcp.json`, resolve `${secret:KEY}` with `secrets`, and
/// add each server to the registry. Best-effort + non-clobbering.
pub fn materialize_mcp(install_path: &Path, secrets: &BTreeMap<String, String>) -> McpResult {
    let mut res = McpResult::default();
    let Some(servers) = read_plugin_mcp(install_path) else {
        return res;
    };
    for (name, mut cfg) in servers {
        resolve_secrets(&mut cfg, secrets);
        match crate::services::mcp_registry::add(&name, cfg) {
            Ok(()) => res.added.push(name),
            Err(_) => res.skipped.push(name),
        }
    }
    res
}

/// Remove the MCP servers a plugin declared. Re-reads the plugin's
/// `mcp.json` (still on disk at uninstall time) to know which names to drop.
pub fn unmaterialize_mcp(install_path: &Path) {
    if let Some(servers) = read_plugin_mcp(install_path) {
        for (name, _) in servers {
            let _ = crate::services::mcp_registry::remove(&name);
        }
    }
}

fn read_plugin_mcp(install_path: &Path) -> Option<Vec<(String, Value)>> {
    let raw = std::fs::read_to_string(install_path.join("mcp.json")).ok()?;
    let v: Value = serde_json::from_str(&raw).ok()?;
    let obj = v.get("mcpServers")?.as_object()?;
    Some(
        obj.iter()
            .map(|(k, val)| (k.clone(), val.clone()))
            .collect(),
    )
}

/// Recursively replace `${secret:KEY}` inside every string value.
fn resolve_secrets(v: &mut Value, secrets: &BTreeMap<String, String>) {
    match v {
        Value::String(s) => *s = expand_secret_str(s, secrets),
        Value::Array(a) => a.iter_mut().for_each(|x| resolve_secrets(x, secrets)),
        Value::Object(o) => o.values_mut().for_each(|x| resolve_secrets(x, secrets)),
        _ => {}
    }
}

/// Expand every `${secret:KEY}` in `s`. Unknown keys are left verbatim.
fn expand_secret_str(s: &str, secrets: &BTreeMap<String, String>) -> String {
    const OPEN: &str = "${secret:";
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(start) = rest.find(OPEN) {
        out.push_str(&rest[..start]);
        let after = &rest[start + OPEN.len()..];
        match after.find('}') {
            Some(end) => {
                let key = &after[..end];
                match secrets.get(key) {
                    Some(val) => out.push_str(val),
                    None => {
                        out.push_str(OPEN);
                        out.push_str(key);
                        out.push('}');
                    }
                }
                rest = &after[end + 1..];
            }
            None => {
                // Unterminated placeholder — emit literally and stop.
                out.push_str(OPEN);
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expand_resolves_known_keys_and_keeps_unknown() {
        let mut secrets = BTreeMap::new();
        secrets.insert("GITHUB_TOKEN".to_string(), "ghp_abc".to_string());
        assert_eq!(
            expand_secret_str("Bearer ${secret:GITHUB_TOKEN}", &secrets),
            "Bearer ghp_abc"
        );
        // Unknown key left literal (visible gap, not blanked).
        assert_eq!(
            expand_secret_str("${secret:MISSING}", &secrets),
            "${secret:MISSING}"
        );
        // No placeholder → unchanged.
        assert_eq!(expand_secret_str("plain", &secrets), "plain");
    }

    #[test]
    fn resolve_walks_nested_env() {
        let mut secrets = BTreeMap::new();
        secrets.insert("K".to_string(), "v".to_string());
        let mut cfg = serde_json::json!({
            "command": "npx",
            "env": { "TOKEN": "${secret:K}", "OTHER": "x" },
            "args": ["--token", "${secret:K}"]
        });
        resolve_secrets(&mut cfg, &secrets);
        assert_eq!(cfg["env"]["TOKEN"], "v");
        assert_eq!(cfg["env"]["OTHER"], "x");
        assert_eq!(cfg["args"][1], "v");
    }
}
