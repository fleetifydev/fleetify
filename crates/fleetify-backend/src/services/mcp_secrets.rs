//! MCP server secrets store. Backs OAuth credentials with an atomic
//! JSON file at `FLEETIFY_HOME/mcp_secrets.json`, mirroring
//! `mcp_registry.rs` exactly. Tokens survive restarts and never cross
//! IPC to the renderer — `routers/mcp` reads them via this module
//! before materialising the MCP server config for spawn-time.
//!
//! The public `get`/`set`/`delete`/`list` signatures are unchanged, so
//! all callers (`mcp_dispatch::splice_oauth`/`splice_for_probe`,
//! `mcp_auth::callback`, `auth_signout`) are untouched.

use std::collections::BTreeMap;
use std::collections::HashMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::Value;

const FILE: &str = "mcp_secrets.json";

fn secrets_path() -> PathBuf {
    fleetify_core::fleetify_home().join(FILE)
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct McpSecret {
    pub access_token: Option<String>,
    pub refresh_token: Option<String>,
    pub expires_at: Option<i64>,
    #[serde(default, flatten)]
    pub extra: HashMap<String, Value>,
}

type Store = BTreeMap<String, McpSecret>;

fn load() -> Store {
    match std::fs::read_to_string(secrets_path()) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => Store::default(),
    }
}

fn save(store: &Store) -> Result<(), String> {
    let dir = fleetify_core::fleetify_home();
    let _ = std::fs::create_dir_all(&dir);
    let p = secrets_path();
    let tmp = p.with_extension("tmp");
    std::fs::write(
        &tmp,
        serde_json::to_string_pretty(store).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &p).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

/// Read the stored secret for an MCP server, if any.
pub fn get(server_name: &str) -> Option<McpSecret> {
    load().remove(server_name)
}

/// Persist a secret blob for an MCP server (overwrites prior value).
pub fn set(server_name: &str, secret: &McpSecret) -> Result<(), String> {
    let mut store = load();
    store.insert(server_name.to_string(), secret.clone());
    save(&store)
}

pub fn delete(server_name: &str) {
    let mut store = load();
    if store.remove(server_name).is_some() {
        let _ = save(&store);
    }
}

/// `(name, secret)` for every MCP server with a stored secret. Used by
/// `_registry_to_acp_servers` / `_registry_to_cli_args` to splice
/// bearer tokens into per-spawn MCP configs.
pub fn list() -> Vec<(String, McpSecret)> {
    load().into_iter().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn with_home<F: FnOnce()>(tmp: &std::path::Path, f: F) {
        let _g = crate::test_support::home_lock()
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        std::env::set_var("HOME", tmp);
        std::env::set_var("USERPROFILE", tmp);
        // Clear FLEETIFY_HOME so fleetify_home() resolves via HOME.
        std::env::remove_var("FLEETIFY_HOME");
        f();
    }

    #[test]
    fn set_get_delete_round_trip() {
        let tmp = tempfile::tempdir().unwrap();
        with_home(tmp.path(), || {
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
        });
    }

    #[test]
    fn extra_fields_preserved_via_flatten() {
        let tmp = tempfile::tempdir().unwrap();
        with_home(tmp.path(), || {
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
            assert_eq!(
                got.extra.get("token_type"),
                Some(&serde_json::json!("Bearer"))
            );
            assert_eq!(
                got.extra.get("scope"),
                Some(&serde_json::json!("read:user"))
            );
        });
    }

    #[test]
    fn list_returns_all_stored_secrets() {
        let tmp = tempfile::tempdir().unwrap();
        with_home(tmp.path(), || {
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
        });
    }

    #[test]
    fn secret_persists_to_disk_under_fleetify_home() {
        let tmp = tempfile::tempdir().unwrap();
        with_home(tmp.path(), || {
            set(
                "persisted",
                &McpSecret {
                    access_token: Some("zzz".into()),
                    ..Default::default()
                },
            )
            .unwrap();
            let path = fleetify_core::fleetify_home().join("mcp_secrets.json");
            let on_disk = std::fs::read_to_string(&path).unwrap();
            assert!(on_disk.contains("persisted"));
            assert!(on_disk.contains("zzz"));
            assert_eq!(
                get("persisted").unwrap().access_token.as_deref(),
                Some("zzz")
            );
        });
    }
}
