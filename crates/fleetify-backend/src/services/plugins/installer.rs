//! Plugin installer — git-clone + manifest-parse + canonical
//! placement under `<FLEETIFY_HOME>/plugins/<name>/`. Phase-4 minimum
//! viable subset of `services/plugins/installer.py`.
//!
//! What this covers:
//! - `install_from_git(repo_url, plugin_path, secrets)`: clones the repo
//!   to a temp dir, locates the plugin at `plugin_path` (empty = repo
//!   root), parses `.fleetify-plugin/plugin.json`, validates name +
//!   semver + provider whitelist, rejects legacy root dirs, computes the
//!   canonical install path, places the plugin's subtree, materializes
//!   per-provider components + MCP servers (resolving `${secret:KEY}`).
//!   Refuses overwrites — caller must uninstall first. The marketplace
//!   router resolves `source_id` → `repo_url` before calling this.
//! - `uninstall(install_id)`: rm -rf the install dir + unmaterialize.
//!   Idempotent.
//!
//! Deferred to follow-up commits:
//! - DB rows in plugin_installs / plugin_enablements (scope currently
//!   lives in `plugin_state.json` via `super::state`).
//! - Version pinning by tag / SHA (currently always tracks the
//!   default branch HEAD).

use std::path::PathBuf;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{manifest, mcp_materialize, providers};

#[derive(Debug, thiserror::Error)]
pub enum InstallError {
    #[error("clone failed: {0}")]
    Clone(String),
    #[error("manifest parse failed: {0}")]
    Manifest(String),
    #[error("plugin '{0}' already installed; uninstall first")]
    AlreadyInstalled(String),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("install path '{0}' resolves outside the plugins dir")]
    PathEscape(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstallResult {
    pub install_id: String,
    pub install_path: String,
    pub manifest: Value,
}

fn plugins_dir() -> PathBuf {
    fleetify_core::fleetify_home().join("plugins")
}

/// Clone `repo_url`, locate the plugin at `plugin_path` within the clone
/// (empty = the repo root, for a single-plugin repo), and place it at
/// `<FLEETIFY_HOME>/plugins/<manifest.name>/`. `install_id` matches the
/// on-disk dir name so subsequent endpoints can address the install by
/// name. `secrets` are forwarded to MCP materialization to resolve any
/// `${secret:KEY}` placeholders in the plugin's `mcp.json`.
pub async fn install_from_git(
    repo_url: &str,
    plugin_path: &str,
    secrets: &std::collections::BTreeMap<String, String>,
) -> Result<InstallResult, InstallError> {
    // 1. Clone to a temp dir under the plugins parent.
    let plugins = plugins_dir();
    std::fs::create_dir_all(&plugins)?;
    let tmp = plugins.join(format!(".staging-{}", uuid::Uuid::new_v4()));
    let clone_res = run_cmd(
        "git",
        &[
            "clone",
            "--depth",
            "1",
            "--single-branch",
            repo_url,
            tmp.to_str().unwrap(),
        ],
        None,
        Duration::from_secs(90),
    )
    .await;
    if !clone_res.ok {
        let _ = std::fs::remove_dir_all(&tmp);
        return Err(InstallError::Clone(format!(
            "git clone {repo_url} failed: {}",
            clone_res.stderr.trim()
        )));
    }

    // 2. Resolve the plugin root within the clone. A marketplace plugin
    //    lives in a subdir (`plugin_path`); a single-plugin repo carries
    //    its manifest at the clone root (`plugin_path` empty).
    let plugin_root = match plugin_subdir(&tmp, plugin_path) {
        Ok(p) => p,
        Err(e) => {
            let _ = std::fs::remove_dir_all(&tmp);
            return Err(e);
        }
    };

    // 3. Parse the manifest from the plugin root.
    let m = manifest::parse_plugin(&plugin_root).map_err(|e| {
        let _ = std::fs::remove_dir_all(&tmp);
        InstallError::Manifest(e.to_string())
    })?;

    // 4. Compute the install path. `name` is kebab-validated in
    //    parse_plugin (`^[a-z0-9][a-z0-9-]*$` — no `/`, `\`, `.`, `:`), so
    //    the join is always a direct child of `plugins`. Defense-in-depth:
    //    confirm that, but WITHOUT fs::canonicalize — on Windows canonicalize
    //    returns a `\\?\` verbatim-prefixed path the plain joined path lacks,
    //    so a `starts_with` against it rejected EVERY valid install.
    let install_path = plugins.join(&m.name);
    if !name_stays_in_dir(&plugins, &m.name) {
        let _ = std::fs::remove_dir_all(&tmp);
        return Err(InstallError::PathEscape(
            install_path.to_string_lossy().into_owned(),
        ));
    }
    if install_path.exists() {
        let _ = std::fs::remove_dir_all(&tmp);
        return Err(InstallError::AlreadyInstalled(m.name.clone()));
    }

    // 5. Place the plugin dir. A root install renames the whole clone
    //    (fast path). A subdir install copies just the plugin's subtree
    //    so the clone's `.git` and sibling plugins stay out of the
    //    install dir, then drops the clone.
    if plugin_path.is_empty() {
        // Atomic-ish move: rename tmp → install_path. fs::rename across
        // filesystems can fail on Linux; fall back to a recursive copy.
        if let Err(e) = std::fs::rename(&tmp, &install_path) {
            if e.kind() == std::io::ErrorKind::PermissionDenied
                || e.raw_os_error() == Some(18 /* EXDEV */)
            {
                // Cross-device rename — fall back to recursive copy + cleanup.
                copy_dir_recursive(&tmp, &install_path)?;
                let _ = std::fs::remove_dir_all(&tmp);
            } else {
                let _ = std::fs::remove_dir_all(&tmp);
                return Err(e.into());
            }
        }
    } else {
        let copy_res = copy_dir_recursive(&plugin_root, &install_path);
        let _ = std::fs::remove_dir_all(&tmp);
        copy_res?;
    }

    // Materialize per-provider components into ~/.claude/, ~/.gemini/,
    // ~/.codex/ for every provider the manifest declares. Best-effort —
    // a single provider's materialization failure (missing home dir,
    // permission error) logs + continues so the install still completes.
    let mut materialization: serde_json::Map<String, Value> = serde_json::Map::new();
    for provider in &m.providers {
        match super::materializers::materialize(&m.name, &install_path, provider) {
            Ok(r) => {
                materialization.insert(
                    provider.clone(),
                    serde_json::to_value(r).unwrap_or(Value::Null),
                );
            }
            Err(e) => {
                tracing::warn!(
                    target: "plugins.installer",
                    "materialize.{} failed for {}: {e}",
                    provider,
                    m.name
                );
            }
        }
    }

    // Materialize MCP servers into the shared registry — the per-bridge
    // emitters fan them out to every agent at spawn, so this one write
    // covers all MCP-capable providers. Install-time `secrets` resolve
    // `${secret:KEY}` placeholders in the plugin's mcp.json; a key the
    // user didn't supply stays literal (never blanked).
    let mcp_res = mcp_materialize::materialize_mcp(&install_path, secrets);

    let mut manifest_value = serde_json::to_value(&m).unwrap_or(Value::Null);
    if let Some(obj) = manifest_value.as_object_mut() {
        obj.insert("materialization".into(), Value::Object(materialization));
        obj.insert(
            "mcp".into(),
            serde_json::to_value(&mcp_res).unwrap_or(Value::Null),
        );
    }
    Ok(InstallResult {
        install_id: m.name.clone(),
        install_path: install_path.to_string_lossy().into_owned(),
        manifest: manifest_value,
    })
}

pub fn uninstall(install_id: &str) -> Result<(), InstallError> {
    // Refuse anything with a slash or `..` — `install_id` is the
    // plugin name which is kebab-validated, but the caller might send
    // garbage. Defense in depth.
    if install_id.is_empty()
        || install_id.contains('/')
        || install_id.contains('\\')
        || install_id.contains("..")
    {
        return Err(InstallError::PathEscape(install_id.into()));
    }
    let dir = plugins_dir().join(install_id);
    if !dir.exists() {
        return Ok(()); // idempotent
    }
    // Walk every materialized file BEFORE we remove the install dir
    // so we can clean up ~/.claude/skills/<install_id>__*, …
    // entries the user installed alongside this plugin.
    if let Ok(m) = super::manifest::parse_plugin(&dir) {
        for provider in &m.providers {
            // Walk each provider's config home for the `<plugin>-` prefix
            // and remove the artifacts this plugin materialized.
            unmaterialize_by_prefix(provider, install_id);
        }
    }
    // Drop this plugin's MCP servers from the shared registry (re-reads the
    // still-on-disk mcp.json to know which names it owns).
    mcp_materialize::unmaterialize_mcp(&dir);
    std::fs::remove_dir_all(&dir)?;
    Ok(())
}

/// Remove every materialized artifact whose name starts with the plugin's
/// `<plugin>-` prefix under the provider's config-home component dirs.
/// Uses the provider registry for the (per-OS, non-naive) home + subpaths.
fn unmaterialize_by_prefix(provider: &str, install_id: &str) {
    let Some(home) = providers::provider_home(provider) else {
        return; // antigravity-sdk / no home → nothing to clean
    };
    let prefix = providers::cleanup_prefix(install_id);
    // `plugins` covers OpenCode's `.ts` hook modules; `hooks` covers
    // Copilot `.json` + Hermes hook dirs.
    for subdir in [
        "skills", "commands", "prompts", "agents", "hooks", "plugins",
    ] {
        let d = home.join(subdir);
        let Ok(rd) = std::fs::read_dir(&d) else {
            continue;
        };
        for ent in rd.flatten() {
            let name = ent.file_name().to_string_lossy().to_string();
            if !name.starts_with(&prefix) {
                continue;
            }
            let p = ent.path();
            if p.is_dir() {
                let _ = std::fs::remove_dir_all(&p);
            } else if p.is_file() {
                let _ = std::fs::remove_file(&p);
            }
        }
    }
}

struct RunOutput {
    ok: bool,
    #[allow(dead_code)]
    stdout: String,
    stderr: String,
}

async fn run_cmd(
    bin: &str,
    args: &[&str],
    cwd: Option<&std::path::Path>,
    timeout: Duration,
) -> RunOutput {
    let mut cmd = tokio::process::Command::new(bin);
    cmd.args(args);
    if let Some(c) = cwd {
        cmd.current_dir(c);
    }
    let fut = cmd.output();
    match tokio::time::timeout(timeout, fut).await {
        Ok(Ok(o)) => RunOutput {
            ok: o.status.success(),
            stdout: String::from_utf8_lossy(&o.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&o.stderr).into_owned(),
        },
        Ok(Err(e)) => RunOutput {
            ok: false,
            stdout: String::new(),
            stderr: e.to_string(),
        },
        Err(_) => RunOutput {
            ok: false,
            stdout: String::new(),
            stderr: format!("{bin} timed out"),
        },
    }
}

fn copy_dir_recursive(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else {
            std::fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

/// Resolve a plugin's directory inside a freshly-cloned repo. An empty
/// `plugin_path` is the repo root (single-plugin repo); otherwise it's a
/// subdir within a marketplace source. Rejects traversal / absolute paths
/// so a hostile catalog entry can't point the install outside the clone.
fn plugin_subdir(clone: &std::path::Path, plugin_path: &str) -> Result<PathBuf, InstallError> {
    let trimmed = plugin_path.trim_matches('/');
    if trimmed.is_empty() {
        return Ok(clone.to_path_buf());
    }
    if trimmed.contains("..") || plugin_path.starts_with('/') || plugin_path.starts_with('\\') {
        return Err(InstallError::PathEscape(plugin_path.into()));
    }
    Ok(clone.join(trimmed))
}

/// True iff joining `name` onto `parent` yields a direct child of `parent`
/// — i.e. `name` introduced no path separator or `..`. The kebab-case name
/// validation in `parse_plugin` already guarantees this; this is the
/// defense-in-depth confirmation, deliberately avoiding `fs::canonicalize`
/// (whose Windows `\\?\` verbatim prefix made the old `starts_with` check
/// reject every install).
fn name_stays_in_dir(parent: &std::path::Path, name: &str) -> bool {
    parent.join(name).parent() == Some(parent)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn uninstall_rejects_traversal() {
        // `..` or `/` in install_id must error before any disk touch.
        let r = uninstall("../escape");
        assert!(matches!(r, Err(InstallError::PathEscape(_))));
        let r = uninstall("foo/bar");
        assert!(matches!(r, Err(InstallError::PathEscape(_))));
        let r = uninstall("");
        assert!(matches!(r, Err(InstallError::PathEscape(_))));
    }

    #[test]
    fn plugin_subdir_resolves_and_rejects_traversal() {
        let base = std::path::Path::new("/clone");
        // Empty path = repo root (single-plugin repo).
        assert_eq!(plugin_subdir(base, "").unwrap(), base.to_path_buf());
        assert_eq!(plugin_subdir(base, "/").unwrap(), base.to_path_buf());
        // A marketplace subdir joins under the clone.
        assert_eq!(
            plugin_subdir(base, "plugins/diff-summarizer").unwrap(),
            base.join("plugins/diff-summarizer")
        );
        // Traversal / absolute paths are refused before any disk touch.
        assert!(matches!(
            plugin_subdir(base, "../escape"),
            Err(InstallError::PathEscape(_))
        ));
        assert!(matches!(
            plugin_subdir(base, "a/../../b"),
            Err(InstallError::PathEscape(_))
        ));
        assert!(matches!(
            plugin_subdir(base, "/abs"),
            Err(InstallError::PathEscape(_))
        ));
    }

    #[test]
    fn name_stays_in_dir_accepts_kebab_rejects_separators() {
        let base = std::path::Path::new("/home/me/.fleetify/plugins");
        // Kebab-validated names install as a direct child — must pass.
        // (The old fs::canonicalize + starts_with check rejected these on
        // Windows because canonicalize prepends a `\\?\` verbatim prefix.)
        assert!(name_stays_in_dir(base, "neon"));
        assert!(name_stays_in_dir(base, "diff-summarizer"));
        // A separator or `..` would escape the plugins dir — must fail
        // (parse_plugin's name validation blocks these upstream too).
        assert!(!name_stays_in_dir(base, "a/b"));
        assert!(!name_stays_in_dir(base, "../escape"));
    }

    #[test]
    fn uninstall_missing_dir_is_idempotent_ok() {
        let r = uninstall("definitely-not-an-installed-plugin-xyzzy");
        assert!(r.is_ok());
    }

    #[test]
    fn copy_dir_recursive_round_trip() {
        let tmp = tempdir().unwrap();
        let a = tmp.path().join("a");
        let b = tmp.path().join("b");
        std::fs::create_dir_all(a.join("nested")).unwrap();
        std::fs::write(a.join("top.txt"), "T").unwrap();
        std::fs::write(a.join("nested/inner.txt"), "I").unwrap();
        copy_dir_recursive(&a, &b).unwrap();
        assert!(b.join("top.txt").is_file());
        assert!(b.join("nested/inner.txt").is_file());
        assert_eq!(std::fs::read_to_string(b.join("top.txt")).unwrap(), "T");
        assert_eq!(
            std::fs::read_to_string(b.join("nested/inner.txt")).unwrap(),
            "I"
        );
    }
}
