//! Simple JSON-backed plugin state store for MVP enable/scope tracking.
//! Lives at `~/.fleetify/plugin_state.json` — separate from the
//! `plugin_installs` / `plugin_enablements` DB tables which are
//! reserved for the full marketplace-integration foundation. The
//! renderer's Library tab toggles flip rows in this file; the
//! installer's per-provider materialization is a follow-up.
//!
//! File shape:
//! ```json
//! {
//!   "<install_id>": {
//!     "master_enabled": true,
//!     "scopes": [
//!       { "scope_type": "user", "scope_id": null, "enabled": true },
//!       { "scope_type": "session", "scope_id": "<uuid>", "enabled": true }
//!     ]
//!   }
//! }
//! ```
//! All writes go through atomic rename so a crash mid-write doesn't
//! corrupt the index.

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

const FILE: &str = "plugin_state.json";

fn fleetify_dir() -> PathBuf {
    fleetify_core::fleetify_home()
}

fn state_path() -> PathBuf {
    fleetify_dir().join(FILE)
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct ScopeEntry {
    pub scope_type: String,
    #[serde(default)]
    pub scope_id: Option<String>,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PluginState {
    #[serde(default = "default_true")]
    pub master_enabled: bool,
    /// Whether this plugin participates in the automatic update sweep.
    /// Defaults on — every plugin auto-updates unless the user opts out.
    #[serde(default = "default_true")]
    pub auto_update: bool,
    #[serde(default)]
    pub scopes: Vec<ScopeEntry>,
    /// Marketplace provenance recorded at install time so the Installed
    /// tab can route back to the plugin's detail page (and a future
    /// update can re-fetch from the right source). `None` for installs
    /// made before provenance tracking — the renderer falls back to a
    /// local-only detail view in that case.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plugin_path: Option<String>,
}

// Manual Default so master_enabled mirrors the serde `default_true` —
// a freshly-installed plugin shows up as enabled in the renderer
// without an explicit toggle round-trip.
impl Default for PluginState {
    fn default() -> Self {
        Self {
            master_enabled: true,
            auto_update: true,
            scopes: Vec::new(),
            source_id: None,
            plugin_path: None,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct StateDoc {
    #[serde(flatten)]
    pub plugins: BTreeMap<String, PluginState>,
}

pub fn load() -> StateDoc {
    match std::fs::read_to_string(state_path()) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => StateDoc::default(),
    }
}

pub fn save(doc: &StateDoc) -> std::io::Result<()> {
    let _ = std::fs::create_dir_all(fleetify_dir());
    let p = state_path();
    let tmp = p.with_extension("tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(doc).unwrap_or_default())?;
    std::fs::rename(&tmp, &p)
}

pub fn get(install_id: &str) -> PluginState {
    load().plugins.remove(install_id).unwrap_or_default()
}

pub fn set_master_enabled(install_id: &str, enabled: bool) -> std::io::Result<()> {
    let mut doc = load();
    let entry = doc.plugins.entry(install_id.to_string()).or_default();
    entry.master_enabled = enabled;
    save(&doc)
}

/// Opt a plugin in/out of the automatic update sweep.
pub fn set_auto_update(install_id: &str, auto_update: bool) -> std::io::Result<()> {
    let mut doc = load();
    let entry = doc.plugins.entry(install_id.to_string()).or_default();
    entry.auto_update = auto_update;
    save(&doc)
}

/// Record the marketplace source + subpath an install came from. An empty
/// `plugin_path` (single-plugin repo / root manifest) is stored as `None`.
pub fn set_origin(install_id: &str, source_id: &str, plugin_path: &str) -> std::io::Result<()> {
    let mut doc = load();
    let entry = doc.plugins.entry(install_id.to_string()).or_default();
    entry.source_id = Some(source_id.to_string());
    entry.plugin_path = if plugin_path.is_empty() {
        None
    } else {
        Some(plugin_path.to_string())
    };
    save(&doc)
}

/// Add or update a `(scope_type, scope_id)` row for a plugin. Replaces
/// any prior entry with the same scope key — the renderer toggles a
/// single scope on/off, not a list of duplicates.
pub fn upsert_scope(
    install_id: &str,
    scope_type: &str,
    scope_id: Option<&str>,
    enabled: bool,
) -> std::io::Result<()> {
    let mut doc = load();
    let entry = doc.plugins.entry(install_id.to_string()).or_default();
    let scope_id_owned = scope_id.map(String::from);
    let pos = entry
        .scopes
        .iter()
        .position(|s| s.scope_type == scope_type && s.scope_id == scope_id_owned);
    let new = ScopeEntry {
        scope_type: scope_type.to_string(),
        scope_id: scope_id_owned,
        enabled,
    };
    match pos {
        Some(i) => entry.scopes[i] = new,
        None => entry.scopes.push(new),
    }
    save(&doc)
}

/// Remove a scope row entirely (renderer's "unscope" action).
pub fn remove_scope(
    install_id: &str,
    scope_type: &str,
    scope_id: Option<&str>,
) -> std::io::Result<()> {
    let mut doc = load();
    let Some(entry) = doc.plugins.get_mut(install_id) else {
        return Ok(()); // nothing to remove → silent success
    };
    let scope_id_owned = scope_id.map(String::from);
    entry
        .scopes
        .retain(|s| !(s.scope_type == scope_type && s.scope_id == scope_id_owned));
    save(&doc)
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
        f();
    }

    #[test]
    fn empty_load_returns_default_doc() {
        let tmp = tempfile::tempdir().unwrap();
        with_home(tmp.path(), || {
            let doc = load();
            assert!(doc.plugins.is_empty());
        });
    }

    #[test]
    fn set_master_enabled_round_trip() {
        let tmp = tempfile::tempdir().unwrap();
        with_home(tmp.path(), || {
            set_master_enabled("plug-1", false).unwrap();
            assert!(!get("plug-1").master_enabled);
            set_master_enabled("plug-1", true).unwrap();
            assert!(get("plug-1").master_enabled);
        });
    }

    #[test]
    fn upsert_scope_replaces_same_key_and_remove_drops_it() {
        let tmp = tempfile::tempdir().unwrap();
        with_home(tmp.path(), || {
            upsert_scope("p", "user", None, true).unwrap();
            upsert_scope("p", "session", Some("s1"), true).unwrap();
            // Same (scope_type, scope_id) → replace, not duplicate.
            upsert_scope("p", "session", Some("s1"), false).unwrap();
            let s = get("p");
            assert_eq!(s.scopes.len(), 2);
            let sess = s.scopes.iter().find(|x| x.scope_type == "session").unwrap();
            assert!(!sess.enabled);
            remove_scope("p", "session", Some("s1")).unwrap();
            let s = get("p");
            assert_eq!(s.scopes.len(), 1);
            assert_eq!(s.scopes[0].scope_type, "user");
        });
    }

    #[test]
    fn unknown_install_id_get_returns_default_state() {
        let tmp = tempfile::tempdir().unwrap();
        with_home(tmp.path(), || {
            let s = get("never-installed");
            assert!(s.master_enabled); // default true
            assert!(s.scopes.is_empty());
            assert!(s.source_id.is_none());
            assert!(s.plugin_path.is_none());
        });
    }

    #[test]
    fn auto_update_defaults_true_and_round_trips() {
        let tmp = tempfile::tempdir().unwrap();
        with_home(tmp.path(), || {
            // A plugin with no state entry → default on.
            assert!(get("p").auto_update, "auto_update must default to true");
            // Opt out persists.
            set_auto_update("p", false).unwrap();
            assert!(!get("p").auto_update);
            set_auto_update("p", true).unwrap();
            assert!(get("p").auto_update);
        });
    }

    #[test]
    fn auto_update_absent_field_deserializes_true() {
        let tmp = tempfile::tempdir().unwrap();
        with_home(tmp.path(), || {
            // Simulate a pre-feature on-disk entry (no auto_update key).
            // master_enabled is deliberately `false` here: it differs from
            // PluginState::default()'s `true`, so the asserts below can only
            // pass if the entry was genuinely deserialized off disk. If the
            // `#[serde(default)]` on auto_update were missing, the whole doc
            // would fail to parse and `load()`'s unwrap_or_default() would
            // hand back an empty doc — `get("p")` would then return the
            // all-defaults state (master_enabled == true), tripping the
            // first assert. This keeps the test honest about what it proves.
            std::fs::create_dir_all(state_path().parent().unwrap()).unwrap();
            std::fs::write(
                state_path(),
                r#"{"p":{"master_enabled":false,"scopes":[]}}"#,
            )
            .unwrap();
            let s = get("p");
            assert!(
                !s.master_enabled,
                "on-disk entry must actually deserialize (not fall back to default doc)"
            );
            assert!(s.auto_update, "missing field must default true");
        });
    }

    #[test]
    fn set_origin_persists_source_and_subpath() {
        let tmp = tempfile::tempdir().unwrap();
        with_home(tmp.path(), || {
            set_origin("neon", "src-1", "neon").unwrap();
            let s = get("neon");
            assert_eq!(s.source_id.as_deref(), Some("src-1"));
            assert_eq!(s.plugin_path.as_deref(), Some("neon"));
            // Setting origin must not disturb existing scope/enable state.
            assert!(s.master_enabled);
            // Empty subpath (root-manifest repo) stores as None.
            set_origin("rootplug", "src-2", "").unwrap();
            assert!(get("rootplug").plugin_path.is_none());
            assert_eq!(get("rootplug").source_id.as_deref(), Some("src-2"));
        });
    }
}
