//! Shared MCP materialization for all bridges. Single source of truth
//! for "what MCPs does this spawn see" — built-in fleet servers
//! (memory/dispatch/reveng), the user's registry, and OAuth-token
//! splicing.
//!
//! Three output flavours:
//!   * `to_claude_json(...)` — JSON object for claude's `--mcp-config <file>`
//!   * `to_codex_cli_args(...)` — flat `-c mcp_servers.<n>.X=<toml>` args
//!   * `to_acp_servers(...)` — JSON array for gemini's ACP `session/new`
//!
//! All three start from the same registry+builtins map; they only
//! differ in serialization. Built-in gating (fleet_dispatch for
//! non-staff, fleet_reveng for the reverse_engineering template)
//! mirrors `bridges::claude::ClaudeBridge::build_mcp_config`.

use serde_json::{json, Map, Value};

use crate::services::mcp_registry;

/// One Fleet built-in stdio MCP config blob. The basename → binary
/// mapping moved here so codex/gemini can use the same lookup that
/// ClaudeBridge used to own inline. Returns `None` when `name` is not
/// one of the three known builtins.
pub fn builtin_mcp_config(name: &str, session_id: &str) -> Option<Value> {
    let basename = match name {
        "fleet_memory" => "fleet-memory-mcp",
        "fleet_dispatch" => "fleet-dispatch-mcp",
        "fleet_reveng" => "fleet-reveng-mcp",
        _ => return None,
    };
    let command = mcp_registry::resolve_builtin_path(basename);
    let mut env = Map::new();
    env.insert(
        "FLEETIFY_SESSION_ID".into(),
        Value::String(session_id.to_string()),
    );
    if let Ok(secret) = std::env::var("FLEETIFY_INTERNAL_SECRET") {
        env.insert("FLEETIFY_INTERNAL_SECRET".into(), Value::String(secret));
    }
    env.insert(
        "FLEETIFY_BACKEND_URL".into(),
        Value::String(
            std::env::var("FLEETIFY_BACKEND_URL")
                .unwrap_or_else(|_| "http://127.0.0.1:8765".into()),
        ),
    );
    Some(json!({
        "type": "stdio",
        "command": command,
        "args": [],
        "env": Value::Object(env),
        "builtin": true,
    }))
}

/// Apply the same gating rules ClaudeBridge uses: `fleet_memory` always,
/// `fleet_dispatch` only when non-staff, `fleet_reveng` only when the
/// agent_template is "reverse_engineering".
pub fn builtin_names_for(is_staff: bool, agent_template: Option<&str>) -> Vec<&'static str> {
    let mut names = vec!["fleet_memory"];
    if !is_staff {
        names.push("fleet_dispatch");
    }
    if matches!(agent_template, Some("reverse_engineering")) {
        names.push("fleet_reveng");
    }
    names
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtin_names_gating() {
        assert_eq!(builtin_names_for(false, None), vec!["fleet_memory", "fleet_dispatch"]);
        assert_eq!(builtin_names_for(true, None), vec!["fleet_memory"]);
        assert_eq!(
            builtin_names_for(false, Some("reverse_engineering")),
            vec!["fleet_memory", "fleet_dispatch", "fleet_reveng"]
        );
        assert_eq!(
            builtin_names_for(true, Some("reverse_engineering")),
            vec!["fleet_memory", "fleet_reveng"]
        );
        // Unknown template ignored.
        assert_eq!(builtin_names_for(false, Some("other")), vec!["fleet_memory", "fleet_dispatch"]);
    }

    #[test]
    fn builtin_mcp_config_returns_stdio_shape_for_known_names() {
        let v = builtin_mcp_config("fleet_memory", "sess-1").unwrap();
        assert_eq!(v["type"], "stdio");
        assert_eq!(v["builtin"], true);
        assert_eq!(v["env"]["FLEETIFY_SESSION_ID"], "sess-1");
        assert!(v["command"].as_str().unwrap().contains("fleet-memory-mcp"));

        assert!(builtin_mcp_config("unknown", "x").is_none());
    }
}
