//! Minimal faithful port of `services/mcp_registry.py` — read/write
//! `~/.fleetify/mcp_servers.json` with shape `{"mcpServers": {<name>:
//! <cfg>}}` (Stdio/Http/Sse cfgs are stored as opaque JSON so any future
//! field added in the renderer round-trips through). OAuth-header splice +
//! materialize_for_spawn + scope filtering land in Phase 4 alongside the
//! MCP prober/auth services.

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::Value;

const FILE: &str = "mcp_servers.json";

fn home() -> PathBuf {
    let h = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| ".".into());
    PathBuf::from(h)
}

pub fn fleetify_dir() -> PathBuf {
    home().join(".fleetify")
}

pub fn registry_path() -> PathBuf {
    fleetify_dir().join(FILE)
}

#[derive(Default, Debug, Serialize, Deserialize)]
pub struct RegistryDoc {
    #[serde(rename = "mcpServers", default)]
    pub mcp_servers: BTreeMap<String, Value>,
}

pub fn load() -> RegistryDoc {
    match std::fs::read_to_string(registry_path()) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => RegistryDoc::default(),
    }
}

pub fn save(doc: &RegistryDoc) -> std::io::Result<()> {
    let _ = std::fs::create_dir_all(fleetify_dir());
    let p = registry_path();
    let tmp = p.with_extension("tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(doc).unwrap_or_default())?;
    std::fs::rename(&tmp, &p)
}

pub fn add(name: &str, config: Value) -> Result<(), String> {
    let mut doc = load();
    if doc.mcp_servers.contains_key(name) {
        return Err(format!("MCP server {name:?} already exists"));
    }
    doc.mcp_servers.insert(name.to_string(), config);
    save(&doc).map_err(|e| e.to_string())
}

pub fn update(name: &str, config: Value) -> Result<(), String> {
    let mut doc = load();
    if !doc.mcp_servers.contains_key(name) {
        return Err(format!("MCP server {name:?} not found"));
    }
    doc.mcp_servers.insert(name.to_string(), config);
    save(&doc).map_err(|e| e.to_string())
}

pub fn remove(name: &str) -> Result<(), String> {
    let mut doc = load();
    if doc.mcp_servers.remove(name).is_none() {
        return Err(format!("MCP server {name:?} not found"));
    }
    save(&doc).map_err(|e| e.to_string())
}

pub fn list_all() -> BTreeMap<String, Value> {
    load().mcp_servers
}

/// Lookup one server by name. None if absent.
pub fn get(name: &str) -> Option<Value> {
    load().mcp_servers.remove(name)
}

/// Fleet's 3 stdio MCP servers. Names match what
/// `app.services.{memory,dispatch,reveng}_mcp.py` registered in the
/// Python build — `mcp__fleet_memory__<tool>` namespaces stay
/// identical on the renderer side.
pub const FLEET_BUILTIN_NAMES: &[&str] =
    &["fleet_memory", "fleet_dispatch", "fleet_reveng"];

fn builtin_basename(name: &str) -> Option<&'static str> {
    match name {
        "fleet_memory" => Some("fleet-memory-mcp"),
        "fleet_dispatch" => Some("fleet-dispatch-mcp"),
        "fleet_reveng" => Some("fleet-reveng-mcp"),
        _ => None,
    }
}

/// Resolve a builtin MCP binary to an absolute path so claude/gemini/
/// codex CLIs can spawn it without depending on PATH. Resolution order:
///
///   1. Same directory as the running executable (Tauri-bundled prod
///      layout: `fleetify-app.exe` + `fleet-*-mcp.exe` side-by-side).
///   2. `target/debug` / `target/release` next to the running exe
///      (covered by step 1 in practice since Cargo emits all
///      workspace binaries to the same target dir).
///   3. `which::which()` — picks up `cargo install` placements and
///      PATH-globally-installed copies. Honors PATHEXT on Windows so
///      `.exe` shims resolve correctly (the same fix providers.rs
///      uses for the gemini/codex node `.cmd` shims).
///
/// Returns the bare basename as a last-resort fallback so a missing
/// binary still surfaces in logs as a spawn failure (rather than
/// silently being elided from the registry).
pub fn resolve_builtin_path(basename: &str) -> String {
    let exe_name = if cfg!(windows) {
        format!("{basename}.exe")
    } else {
        basename.to_string()
    };
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let candidate = dir.join(&exe_name);
            if candidate.exists() {
                return candidate.to_string_lossy().into_owned();
            }
        }
    }
    if let Ok(path) = which::which(basename) {
        return path.to_string_lossy().into_owned();
    }
    basename.to_string()
}

/// Ensure Fleet's 3 stdio MCP servers are present in the registry.
/// Idempotent: any name already registered (even by the user
/// pointing at a custom binary) is left alone. New entries resolve
/// the `fleet-<name>-mcp` binary to an absolute path via
/// `resolve_builtin_path` so the claude CLI can spawn it regardless
/// of PATH state.
pub fn ensure_fleet_builtins() {
    let mut doc = load();
    let mut changed = false;
    for name in FLEET_BUILTIN_NAMES {
        if doc.mcp_servers.contains_key(*name) {
            continue;
        }
        let Some(base) = builtin_basename(name) else {
            continue;
        };
        let command = resolve_builtin_path(base);
        doc.mcp_servers.insert(
            (*name).to_string(),
            serde_json::json!({
                "type": "stdio",
                "command": command,
                "args": [],
                "env": {},
                "builtin": true,
            }),
        );
        changed = true;
    }
    if changed {
        let _ = save(&doc);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn with_home<F: FnOnce()>(tmp: &std::path::Path, f: F) {
        // HOME / USERPROFILE are process-wide env vars; multiple
        // modules' tests mutate them. Serialise on a shared static
        // mutex so a sibling module's HOME swap doesn't poison our
        // load/save during the registry round-trip.
        let _g = crate::test_support::home_lock()
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        std::env::set_var("HOME", tmp);
        std::env::set_var("USERPROFILE", tmp);
        f();
    }

    #[test]
    fn add_update_remove_round_trip() {
        let tmp = tempfile::tempdir().unwrap();
        with_home(tmp.path(), || {
            assert!(list_all().is_empty());
            add("github", json!({"type":"http","url":"https://example/mcp"})).unwrap();
            add("local", json!({"type":"stdio","command":"node","args":["a.js"]})).unwrap();
            // Duplicate add → error.
            assert!(add("github", json!({"type":"http","url":"x"})).is_err());

            let all = list_all();
            assert_eq!(all.len(), 2);
            assert_eq!(all["github"]["type"], "http");

            update("github", json!({"type":"http","url":"https://new"})).unwrap();
            assert_eq!(load().mcp_servers["github"]["url"], "https://new");

            remove("github").unwrap();
            assert!(!load().mcp_servers.contains_key("github"));
            assert!(remove("github").is_err());
        });
    }

    #[test]
    fn ensure_fleet_builtins_is_idempotent_and_preserves_user_entries() {
        let _g = crate::test_support::home_lock()
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("HOME", tmp.path());
        std::env::set_var("USERPROFILE", tmp.path());

        // Empty registry → first call should add all 3.
        ensure_fleet_builtins();
        let all = list_all();
        for n in FLEET_BUILTIN_NAMES {
            assert!(all.contains_key(*n), "missing {n}");
            assert_eq!(all[*n]["type"], "stdio");
            assert_eq!(all[*n]["builtin"], true);
        }

        // User customises fleet_memory's command.
        let custom = json!({
            "type": "stdio",
            "command": "/custom/path/memory",
            "args": ["--debug"],
            "env": {}
        });
        let mut doc = load();
        doc.mcp_servers.insert("fleet_memory".into(), custom.clone());
        save(&doc).unwrap();

        // Second call should leave the user-customised entry alone.
        ensure_fleet_builtins();
        let all = list_all();
        assert_eq!(all["fleet_memory"]["command"], "/custom/path/memory");
        // Other two are resolved via `resolve_builtin_path` — in the test
        // env the binary may or may not exist next to the test runner;
        // check we still end with a non-empty command string that
        // either ends in the expected basename (resolved) or equals
        // the basename verbatim (fallback). The shape contract — a
        // string command for a stdio server — is what matters.
        for (name, base) in
            [("fleet_dispatch", "fleet-dispatch-mcp"), ("fleet_reveng", "fleet-reveng-mcp")]
        {
            let cmd = all[name]["command"]
                .as_str()
                .unwrap_or_else(|| panic!("{name} command must be a string"));
            assert!(!cmd.is_empty(), "{name} command must not be empty");
            let stem = std::path::Path::new(cmd)
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or(cmd);
            assert_eq!(stem, base, "{name} should resolve to {base}");
        }
    }
}
