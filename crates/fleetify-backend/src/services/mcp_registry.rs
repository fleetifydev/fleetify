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
pub const FLEET_BUILTIN_NAMES: &[&str] = &["fleet_memory", "fleet_dispatch", "fleet_reveng"];

// `services::mcp_dispatch::builtin_mcp_config` now owns the basename→binary
// mapping. Older versions exposed `builtin_basename` here for
// `ensure_fleet_builtins` to seed the registry; both have been
// retired (builtins are spawn-time-only) but the constant + the
// resolve_builtin_path helper below stay because integration tests +
// the bridges still rely on them.

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

/// One-shot migration: strip any `"builtin": true` rows from a
/// pre-existing `~/.fleetify/mcp_servers.json`. Older builds
/// auto-seeded the 3 Fleet MCPs into the user registry, which
/// polluted the renderer's MCP list with entries the user can't
/// remove. The current bridge splices builtins in-process per spawn
/// (matching sdk_bridge.py), so any persisted builtin row is stale.
/// Idempotent + no-op on a clean registry.
pub fn purge_legacy_builtin_seeds() {
    let mut doc = load();
    let before = doc.mcp_servers.len();
    doc.mcp_servers.retain(|name, cfg| {
        // Drop rows that look like our old auto-seed AND match a known
        // builtin name. A user manually adding a stdio entry with the
        // same name (custom binary path) shouldn't get nuked — we
        // require both the `builtin: true` marker AND the name match.
        let is_builtin_seed = cfg
            .get("builtin")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        if is_builtin_seed && FLEET_BUILTIN_NAMES.contains(&name.as_str()) {
            return false;
        }
        true
    });
    if doc.mcp_servers.len() != before {
        tracing::info!(
            target: "fleetify-backend",
            removed = before - doc.mcp_servers.len(),
            "purging legacy builtin MCP seed rows from user registry",
        );
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
            add(
                "local",
                json!({"type":"stdio","command":"node","args":["a.js"]}),
            )
            .unwrap();
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
    fn purge_legacy_builtin_seeds_removes_only_builtin_marked_rows() {
        let _g = crate::test_support::home_lock()
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("HOME", tmp.path());
        std::env::set_var("USERPROFILE", tmp.path());

        // Seed a registry that mimics what an older build wrote: the
        // 3 fleet builtins with `builtin: true`, plus a user-added
        // server with the same `fleet_memory` name but no marker
        // (custom binary path), plus a totally unrelated user entry.
        // The migration should ONLY drop the marker-bearing builtin
        // rows — user customisations must survive.
        let mut doc = load();
        for n in FLEET_BUILTIN_NAMES {
            doc.mcp_servers.insert(
                (*n).to_string(),
                json!({
                    "type": "stdio",
                    "command": format!("fleet-{n}-mcp"),
                    "args": [],
                    "env": {},
                    "builtin": true,
                }),
            );
        }
        // Same name as a builtin, but NO `builtin: true` marker → user
        // pointed at a custom binary; must be preserved.
        doc.mcp_servers.insert(
            "fleet_custom".to_string(),
            json!({
                "type": "stdio",
                "command": "/custom/path/mcp",
                "args": ["--debug"],
                "env": {},
            }),
        );
        // Totally unrelated http MCP — must be preserved.
        doc.mcp_servers.insert(
            "github".to_string(),
            json!({"type":"http","url":"https://example/mcp"}),
        );
        save(&doc).unwrap();

        purge_legacy_builtin_seeds();
        let all = list_all();
        for n in FLEET_BUILTIN_NAMES {
            assert!(!all.contains_key(*n), "{n} should have been purged");
        }
        assert!(all.contains_key("fleet_custom"), "user MCP must survive");
        assert!(all.contains_key("github"), "unrelated MCP must survive");

        // Idempotent: second call is a no-op (and doesn't error).
        purge_legacy_builtin_seeds();
        let all2 = list_all();
        assert_eq!(all2.len(), all.len());
    }
}
