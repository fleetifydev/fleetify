//! ManifestParser — disk → typed manifest with cross-checks against
//! actual files. Faithful subset of `services/plugins/manifest.py`.
//!
//! Plugin layout is provider-folder based: per-provider components
//! under `<plugin>/.<provider>/` (one of `.claude`, `.gemini`,
//! `.codex`). Cross-cutting components (`mcp.json`, `templates/`,
//! `workflows/`) live at the plugin root. Root-level `skills/`,
//! `commands/`, `prompts/`, `hooks/` directories are REJECTED — they
//! belonged to the pre-materializer layout and would silently shadow
//! the per-provider versions.

use std::path::{Path, PathBuf};

use super::types::{
    derive_provides, is_known_provider, is_valid_name, is_valid_semver, MarketplaceManifest,
    PluginManifest,
};

pub const PLUGIN_PATH: &str = ".fleetify-plugin/plugin.json";
pub const MARKETPLACE_PATH: &str = "marketplace.json";

/// Provider directory names that must be checked when present.
pub const PROVIDERS: &[&str] = &["claude", "gemini", "codex"];

/// Root-level directory names from the legacy layout that must NOT
/// appear in a current plugin (rejecting them at parse time keeps
/// plugins from getting half-materialized).
pub const LEGACY_ROOT_DIRS: &[&str] = &["skills", "commands", "prompts", "hooks"];

#[derive(Debug, Clone)]
pub struct ManifestIssue {
    pub field: String,
    pub message: String,
}

#[derive(Debug)]
pub struct ManifestInvalid {
    pub message: String,
    pub issues: Vec<ManifestIssue>,
}

impl std::fmt::Display for ManifestInvalid {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)?;
        for i in &self.issues {
            write!(f, "\n  - {}: {}", i.field, i.message)?;
        }
        Ok(())
    }
}
impl std::error::Error for ManifestInvalid {}

fn invalid(msg: impl Into<String>) -> ManifestInvalid {
    ManifestInvalid {
        message: msg.into(),
        issues: Vec::new(),
    }
}
fn invalid_with(msg: impl Into<String>, issues: Vec<ManifestIssue>) -> ManifestInvalid {
    ManifestInvalid {
        message: msg.into(),
        issues,
    }
}

pub fn is_plugin_repo(dir: &Path) -> bool {
    dir.join(PLUGIN_PATH).is_file()
}

pub fn is_marketplace_repo(dir: &Path) -> bool {
    dir.join(MARKETPLACE_PATH).is_file()
}

/// Parse `<dir>/.fleetify-plugin/plugin.json` into a typed manifest
/// with regex-validated name + version + provider whitelist, then
/// auto-derive `provides` from `declares` when it's missing.
pub fn parse_plugin(dir: &Path) -> Result<PluginManifest, ManifestInvalid> {
    let path = dir.join(PLUGIN_PATH);
    if !path.is_file() {
        return Err(invalid(format!(
            "{} is not a plugin (no {PLUGIN_PATH})",
            dir.display()
        )));
    }
    let raw = std::fs::read_to_string(&path)
        .map_err(|e| invalid(format!("read {}: {e}", path.display())))?;
    let mut m: PluginManifest = serde_json::from_str(&raw)
        .map_err(|e| invalid(format!("{PLUGIN_PATH}: invalid JSON — {e}")))?;

    // Validators (mirror the @field_validator + @model_validator in
    // PluginManifest exactly).
    let mut issues: Vec<ManifestIssue> = Vec::new();
    if !is_valid_name(&m.name) {
        issues.push(ManifestIssue {
            field: "name".into(),
            message: format!(
                "must match ^[a-z0-9][a-z0-9-]*$, got {:?}",
                m.name
            ),
        });
    }
    if !is_valid_semver(&m.version) {
        issues.push(ManifestIssue {
            field: "version".into(),
            message: format!("must be semver, got {:?}", m.version),
        });
    }
    if let Some(mfv) = m.min_fleetify_version.as_deref() {
        if !is_valid_semver(mfv) {
            issues.push(ManifestIssue {
                field: "min_fleetify_version".into(),
                message: format!("must be semver, got {mfv:?}"),
            });
        }
    }
    if m.providers.is_empty() {
        issues.push(ManifestIssue {
            field: "providers".into(),
            message: "must be a non-empty array".into(),
        });
    } else {
        for p in &m.providers {
            if !is_known_provider(p) {
                issues.push(ManifestIssue {
                    field: "providers".into(),
                    message: format!("unknown provider {p:?}"),
                });
            }
        }
    }

    // Reject legacy root directories so plugins migrate cleanly.
    for legacy in LEGACY_ROOT_DIRS {
        let p = dir.join(legacy);
        if p.is_dir() {
            issues.push(ManifestIssue {
                field: format!("<root>/{legacy}/"),
                message: format!(
                    "legacy root directory present — move under .<provider>/{legacy}/ (per-provider layout)"
                ),
            });
        }
    }

    if !issues.is_empty() {
        return Err(invalid_with(
            format!("{PLUGIN_PATH}: schema validation failed"),
            issues,
        ));
    }

    // Auto-derive provides if absent / empty.
    if m.provides.is_empty() {
        m.provides = derive_provides(&m.declares);
    }
    Ok(m)
}

pub fn parse_marketplace(dir: &Path) -> Result<MarketplaceManifest, ManifestInvalid> {
    let path = dir.join(MARKETPLACE_PATH);
    if !path.is_file() {
        return Err(invalid(format!(
            "{} has no {MARKETPLACE_PATH}",
            dir.display()
        )));
    }
    let raw = std::fs::read_to_string(&path)
        .map_err(|e| invalid(format!("read {}: {e}", path.display())))?;
    serde_json::from_str::<MarketplaceManifest>(&raw)
        .map_err(|e| invalid(format!("{MARKETPLACE_PATH}: invalid JSON — {e}")))
}

/// Provider directories actually present on disk. Used by the installer
/// to know which materializers to fire on a freshly-cloned plugin.
pub fn discover_provider_dirs(dir: &Path) -> Vec<PathBuf> {
    PROVIDERS
        .iter()
        .filter_map(|p| {
            let pd = dir.join(format!(".{p}"));
            if pd.is_dir() {
                Some(pd)
            } else {
                None
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn write_manifest(dir: &Path, body: &str) {
        let p = dir.join(".fleetify-plugin");
        std::fs::create_dir_all(&p).unwrap();
        std::fs::write(p.join("plugin.json"), body).unwrap();
    }

    #[test]
    fn parse_plugin_happy_path_auto_derives_provides() {
        let tmp = tempdir().unwrap();
        write_manifest(
            tmp.path(),
            r#"{
                "name": "my-plugin",
                "version": "1.0.0",
                "providers": ["claude"],
                "declares": { "mcp_servers": 1, "providers": { "claude": { "skills": 2 } } }
            }"#,
        );
        let m = parse_plugin(tmp.path()).unwrap();
        assert_eq!(m.name, "my-plugin");
        assert_eq!(m.version, "1.0.0");
        // Auto-derived (provides was absent).
        assert_eq!(m.provides, vec!["mcp".to_string(), "skills".into()]);
    }

    #[test]
    fn parse_plugin_rejects_bad_name_and_bad_version() {
        let tmp = tempdir().unwrap();
        write_manifest(
            tmp.path(),
            r#"{
                "name": "Bad_Name",
                "version": "v1.0.0",
                "providers": ["unknown"],
                "declares": {}
            }"#,
        );
        let err = parse_plugin(tmp.path()).unwrap_err();
        let fields: Vec<&str> = err.issues.iter().map(|i| i.field.as_str()).collect();
        assert!(fields.contains(&"name"));
        assert!(fields.contains(&"version"));
        assert!(fields.contains(&"providers"));
    }

    #[test]
    fn parse_plugin_rejects_legacy_root_dirs() {
        let tmp = tempdir().unwrap();
        write_manifest(
            tmp.path(),
            r#"{
                "name": "ok",
                "version": "1.0.0",
                "providers": ["claude"],
                "declares": {}
            }"#,
        );
        // Old layout artifact.
        std::fs::create_dir_all(tmp.path().join("commands")).unwrap();
        let err = parse_plugin(tmp.path()).unwrap_err();
        let fields: Vec<&str> = err.issues.iter().map(|i| i.field.as_str()).collect();
        assert!(fields.contains(&"<root>/commands/"));
    }

    #[test]
    fn parse_plugin_missing_dir_returns_clear_error() {
        let tmp = tempdir().unwrap();
        let err = parse_plugin(tmp.path()).unwrap_err();
        assert!(err.message.contains("is not a plugin"));
    }

    #[test]
    fn discover_provider_dirs_finds_existing_dot_provider_folders() {
        let tmp = tempdir().unwrap();
        std::fs::create_dir(tmp.path().join(".claude")).unwrap();
        std::fs::create_dir(tmp.path().join(".gemini")).unwrap();
        // No .codex — not all plugins target every provider.
        let dirs = discover_provider_dirs(tmp.path());
        assert_eq!(dirs.len(), 2);
        assert!(dirs.iter().any(|p| p.ends_with(".claude")));
        assert!(dirs.iter().any(|p| p.ends_with(".gemini")));
    }
}
