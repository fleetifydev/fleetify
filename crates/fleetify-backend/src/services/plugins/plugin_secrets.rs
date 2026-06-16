//! Per-plugin secret store at `<fleetify_home>/plugin_secrets.json`,
//! keyed `plugin_id -> { KEY: value }`. Written at install, edited from
//! Settings → plugin Settings, pruned at uninstall. Re-applied into the
//! MCP registry by `mcp_materialize::rematerialize_mcp` so a plugin's
//! `${secret:KEY}` placeholders resolve. Values NEVER cross IPC to the
//! renderer (the secrets endpoint returns set-status only). Mirrors the
//! atomic-write + 0600 pattern of `services::mcp_secrets`.
//!
//! All functions take the home dir explicitly so they're unit-testable
//! without touching `$FLEETIFY_HOME`; callers pass
//! `&fleetify_core::fleetify_home()`.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

const FILE: &str = "plugin_secrets.json";

/// `plugin_id -> { KEY -> value }`
type Store = BTreeMap<String, BTreeMap<String, String>>;

fn store_path(home: &Path) -> PathBuf {
    home.join(FILE)
}

fn load(home: &Path) -> Store {
    match std::fs::read_to_string(store_path(home)) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => Store::default(),
    }
}

fn save(home: &Path, store: &Store) -> Result<(), String> {
    let _ = std::fs::create_dir_all(home);
    let p = store_path(home);
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

/// The plugin's stored secret map (empty if none).
pub fn get(home: &Path, plugin_id: &str) -> BTreeMap<String, String> {
    load(home).remove(plugin_id).unwrap_or_default()
}

/// Replace a plugin's whole secret map (used at install). A no-op write
/// of an empty map is skipped so we don't create empty entries.
pub fn set_all(home: &Path, plugin_id: &str, map: &BTreeMap<String, String>) -> Result<(), String> {
    if map.is_empty() {
        return Ok(());
    }
    let mut store = load(home);
    store.insert(plugin_id.to_string(), map.clone());
    save(home, &store)
}

/// Apply a partial `{KEY: value}` patch. An empty-string value REMOVES
/// that key (clear). If the plugin ends up with no keys, its entry is
/// dropped entirely.
pub fn merge(home: &Path, plugin_id: &str, patch: &BTreeMap<String, String>) -> Result<(), String> {
    let mut store = load(home);
    let entry = store.entry(plugin_id.to_string()).or_default();
    for (k, v) in patch {
        if v.is_empty() {
            entry.remove(k);
        } else {
            entry.insert(k.clone(), v.clone());
        }
    }
    if entry.is_empty() {
        store.remove(plugin_id);
    }
    save(home, &store)
}

/// For each declared key, whether a non-empty value is stored.
pub fn status(home: &Path, plugin_id: &str, declared_keys: &[String]) -> Vec<(String, bool)> {
    let map = get(home, plugin_id);
    declared_keys
        .iter()
        .map(|k| {
            (
                k.clone(),
                map.get(k).map(|v| !v.is_empty()).unwrap_or(false),
            )
        })
        .collect()
}

/// Drop a plugin's whole secret entry (uninstall).
pub fn delete(home: &Path, plugin_id: &str) {
    let mut store = load(home);
    if store.remove(plugin_id).is_some() {
        let _ = save(home, &store);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keys(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }
    fn map(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn absent_reads_empty() {
        let dir = tempfile::tempdir().unwrap();
        assert!(get(dir.path(), "p").is_empty());
        assert_eq!(
            status(dir.path(), "p", &keys(&["A"])),
            vec![("A".to_string(), false)]
        );
    }

    #[test]
    fn set_all_then_get_and_status() {
        let dir = tempfile::tempdir().unwrap();
        set_all(dir.path(), "p", &map(&[("A", "1"), ("B", "2")])).unwrap();
        assert_eq!(get(dir.path(), "p").get("A").map(String::as_str), Some("1"));
        assert_eq!(
            status(dir.path(), "p", &keys(&["A", "B", "C"])),
            vec![
                ("A".to_string(), true),
                ("B".to_string(), true),
                ("C".to_string(), false),
            ]
        );
    }

    #[test]
    fn set_all_empty_map_is_noop() {
        let dir = tempfile::tempdir().unwrap();
        set_all(dir.path(), "p", &BTreeMap::new()).unwrap();
        assert!(!store_path(dir.path()).exists());
    }

    #[test]
    fn merge_adds_updates_and_clears() {
        let dir = tempfile::tempdir().unwrap();
        set_all(dir.path(), "p", &map(&[("A", "1")])).unwrap();
        merge(dir.path(), "p", &map(&[("A", "9"), ("B", "2")])).unwrap();
        let m = get(dir.path(), "p");
        assert_eq!(m.get("A").map(String::as_str), Some("9"));
        assert_eq!(m.get("B").map(String::as_str), Some("2"));
        merge(dir.path(), "p", &map(&[("A", "")])).unwrap();
        assert!(!get(dir.path(), "p").contains_key("A"));
    }

    #[test]
    fn merge_clearing_last_key_drops_entry() {
        let dir = tempfile::tempdir().unwrap();
        set_all(dir.path(), "p", &map(&[("A", "1")])).unwrap();
        merge(dir.path(), "p", &map(&[("A", "")])).unwrap();
        assert!(get(dir.path(), "p").is_empty());
    }

    #[test]
    fn delete_drops_only_that_plugin() {
        let dir = tempfile::tempdir().unwrap();
        set_all(dir.path(), "p1", &map(&[("A", "1")])).unwrap();
        set_all(dir.path(), "p2", &map(&[("B", "2")])).unwrap();
        delete(dir.path(), "p1");
        assert!(get(dir.path(), "p1").is_empty());
        assert_eq!(
            get(dir.path(), "p2").get("B").map(String::as_str),
            Some("2")
        );
    }

    #[cfg(unix)]
    #[test]
    fn file_is_0600() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        set_all(dir.path(), "p", &map(&[("A", "1")])).unwrap();
        let mode = std::fs::metadata(store_path(dir.path()))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }
}
