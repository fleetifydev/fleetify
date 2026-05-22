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

use std::collections::BTreeMap;

use serde_json::{json, Map, Value};

use crate::services::{mcp_registry, mcp_secrets};

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

/// Produce the canonical `Map<name, config>` for one spawn:
/// every user-registry entry (with OAuth bearer spliced for http/sse)
/// plus the gated fleet built-ins. The map is ordered by user
/// entries first (BTreeMap order from the registry), then built-ins
/// in `builtin_names_for` order.
pub fn build_merged_map(
    session_id: &str,
    is_staff: bool,
    agent_template: Option<&str>,
) -> BTreeMap<String, Value> {
    let mut out: BTreeMap<String, Value> = BTreeMap::new();
    for (name, cfg) in mcp_registry::list_all() {
        let secret = mcp_secrets::get(&name);
        match splice_oauth(&name, &cfg, secret.as_ref(), session_id) {
            Ok(spliced) => {
                out.insert(name, spliced);
            }
            Err(reason) => {
                tracing::warn!(
                    target: "mcp_dispatch",
                    mcp = %name,
                    %session_id,
                    is_staff,
                    "skipping malformed user MCP entry: {reason}"
                );
            }
        }
    }
    for name in builtin_names_for(is_staff, agent_template) {
        if let Some(cfg) = builtin_mcp_config(name, session_id) {
            out.insert(name.to_string(), cfg);
        }
    }
    out
}

/// Splice OAuth bearer (when present) into the `headers` of an
/// http/sse MCP server config, and (for `fleet_*` stdio entries) the
/// FLEETIFY env trio. Stdio entries from the user registry are left
/// untouched. Returns Err with a short reason when the entry shape
/// is broken so the caller can log a per-server skip without
/// dropping the rest of the map. Verbatim port of the Claude bridge's
/// `splice_server_config` so behaviour is identical for the user-
/// facing registry no matter which CLI is consuming it.
fn splice_oauth(name: &str, cfg: &Value, secret: Option<&mcp_secrets::McpSecret>, session_id: &str) -> Result<Value, String> {
    let obj = cfg
        .as_object()
        .ok_or_else(|| "config is not a JSON object".to_string())?;
    let mut spliced = obj.clone();
    let kind: String = spliced
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    if kind == "stdio" && name.starts_with("fleet_") {
        let mut env = spliced
            .get("env")
            .and_then(|e| e.as_object())
            .cloned()
            .unwrap_or_default();
        env.entry("FLEETIFY_SESSION_ID".to_string())
            .or_insert_with(|| Value::String(session_id.to_string()));
        if let Ok(secret) = std::env::var("FLEETIFY_INTERNAL_SECRET") {
            env.entry("FLEETIFY_INTERNAL_SECRET".to_string())
                .or_insert_with(|| Value::String(secret));
        }
        env.entry("FLEETIFY_BACKEND_URL".to_string()).or_insert_with(|| {
            Value::String(
                std::env::var("FLEETIFY_BACKEND_URL")
                    .unwrap_or_else(|_| "http://127.0.0.1:8765".into()),
            )
        });
        spliced.insert("env".to_string(), Value::Object(env));
    }

    if matches!(kind.as_str(), "http" | "sse") {
        if let Some(secret) = secret {
            if let Some(tok) = &secret.access_token {
                let token_type = secret
                    .extra
                    .get("token_type")
                    .and_then(|v| v.as_str())
                    .map(|s| {
                        if s.eq_ignore_ascii_case("bearer") {
                            "Bearer".to_string()
                        } else {
                            s.to_string()
                        }
                    })
                    .unwrap_or_else(|| "Bearer".to_string());
                let mut headers = spliced
                    .get("headers")
                    .and_then(|h| h.as_object())
                    .cloned()
                    .unwrap_or_default();
                headers.insert(
                    "Authorization".into(),
                    Value::String(format!("{token_type} {tok}")),
                );
                spliced.insert("headers".into(), Value::Object(headers));
            }
        }
    }
    Ok(Value::Object(spliced))
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

    #[test]
    fn merged_map_includes_user_registry_and_builtins() {
        let tmp = tempfile::tempdir().unwrap();
        let _g = crate::test_support::home_lock()
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        std::env::set_var("HOME", tmp.path());
        std::env::set_var("USERPROFILE", tmp.path());
        // Reset registry state for this test.
        let _ = std::fs::remove_file(mcp_registry::registry_path());

        mcp_registry::add(
            "github",
            json!({"type": "http", "url": "https://example/mcp"}),
        )
        .unwrap();

        let merged = build_merged_map("sess-7", /*is_staff*/ false, /*template*/ None);
        let names: Vec<&str> = merged.keys().map(String::as_str).collect();
        // User entry first; then built-ins.
        assert!(names.contains(&"github"));
        assert!(names.contains(&"fleet_memory"));
        assert!(names.contains(&"fleet_dispatch"));
        assert!(!names.contains(&"fleet_reveng"));
    }

    #[test]
    fn merged_map_splices_bearer_into_http_headers() {
        let tmp = tempfile::tempdir().unwrap();
        let _g = crate::test_support::home_lock()
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        std::env::set_var("HOME", tmp.path());
        std::env::set_var("USERPROFILE", tmp.path());
        let _ = std::fs::remove_file(mcp_registry::registry_path());

        mcp_registry::add(
            "notion",
            json!({"type": "http", "url": "https://mcp.notion.so"}),
        )
        .unwrap();
        mcp_secrets::set(
            "notion",
            &mcp_secrets::McpSecret {
                access_token: Some("ya29.X".into()),
                ..Default::default()
            },
        )
        .unwrap();

        let merged = build_merged_map("sess-1", false, None);
        let notion = merged.get("notion").unwrap();
        assert_eq!(
            notion["headers"]["Authorization"].as_str().unwrap(),
            "Bearer ya29.X"
        );
        // Cleanup so neighbouring tests don't see this secret.
        mcp_secrets::delete("notion");
    }

    #[test]
    fn merged_map_skips_malformed_entries_and_keeps_valid_ones() {
        let tmp = tempfile::tempdir().unwrap();
        let _g = crate::test_support::home_lock()
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        std::env::set_var("HOME", tmp.path());
        std::env::set_var("USERPROFILE", tmp.path());
        let _ = std::fs::remove_file(mcp_registry::registry_path());

        // Malformed: stored as a JSON array, not an object — splice_oauth
        // should return Err and the entry should be skipped without
        // affecting the rest of the map.
        mcp_registry::add("broken", json!([1, 2, 3])).unwrap();
        mcp_registry::add(
            "good",
            json!({"type": "http", "url": "https://x"}),
        )
        .unwrap();

        let merged = build_merged_map("sess-2", false, None);
        assert!(!merged.contains_key("broken"), "malformed entry should be dropped");
        assert!(merged.contains_key("good"), "valid entry should survive");
        assert!(merged.contains_key("fleet_memory"), "builtins still mount");
    }

    #[test]
    fn splice_does_not_overwrite_user_supplied_fleet_env_values() {
        let tmp = tempfile::tempdir().unwrap();
        let _g = crate::test_support::home_lock()
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        std::env::set_var("HOME", tmp.path());
        std::env::set_var("USERPROFILE", tmp.path());
        let _ = std::fs::remove_file(mcp_registry::registry_path());

        // User registers a stdio MCP whose name starts with `fleet_` and
        // sets FLEETIFY_SESSION_ID explicitly — splice must NOT overwrite.
        mcp_registry::add(
            "fleet_custom",
            json!({
                "type": "stdio",
                "command": "/my/binary",
                "args": [],
                "env": { "FLEETIFY_SESSION_ID": "user-override" }
            }),
        )
        .unwrap();

        let merged = build_merged_map("session-from-call", false, None);
        assert_eq!(
            merged["fleet_custom"]["env"]["FLEETIFY_SESSION_ID"],
            "user-override"
        );
        // FLEETIFY_BACKEND_URL was NOT user-supplied; should be filled in.
        assert!(merged["fleet_custom"]["env"]["FLEETIFY_BACKEND_URL"].is_string());
    }
}
