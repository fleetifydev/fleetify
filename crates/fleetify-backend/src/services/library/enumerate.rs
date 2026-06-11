//! Read-only enumeration of plugin-contributed items, so the Library lists can
//! show each installed plugin's individual skills/commands/templates alongside
//! the user's own authored items. These are synthetic, non-editable views over
//! the plugin source trees under `~/.fleetify/plugins/<id>/` — the plugin
//! remains the source of truth (edits happen via the marketplace, not here).

use std::collections::BTreeSet;
use std::path::Path;

use super::types::{LibraryItem, LibraryKind};
use crate::services::plugins::providers::COMPONENT_PROVIDERS;

/// `(plugin_name, item)` for every plugin-contributed item of `kind`. Skills
/// and commands fan out across provider dirs (deduped by name); templates come
/// from the plugin's `templates/*.json`. Prompts/hooks are not enumerated
/// (no stable cross-provider source view) — they still surface in the plugin
/// contributor counts.
pub fn plugin_items(kind: LibraryKind) -> Vec<(String, LibraryItem)> {
    let mut out = Vec::new();
    let plugins = fleetify_core::fleetify_home().join("plugins");
    let Ok(rd) = std::fs::read_dir(&plugins) else {
        return out;
    };
    for ent in rd.flatten() {
        let root = ent.path();
        if !root.is_dir() {
            continue;
        }
        let plugin = ent.file_name().to_string_lossy().into_owned();
        match kind {
            LibraryKind::Skill => collect_skill_dirs(&root, "skills", &plugin, &mut out),
            LibraryKind::Command => collect_command_files(&root, &plugin, &mut out),
            LibraryKind::Template => collect_templates(&root, &plugin, &mut out),
            LibraryKind::Prompt | LibraryKind::Hook => {}
        }
    }
    out
}

fn synthetic(kind: LibraryKind, plugin: &str, name: &str, providers: Vec<String>) -> LibraryItem {
    LibraryItem {
        id: format!("plugin:{plugin}:{name}"),
        kind,
        name: name.to_string(),
        slug: name.to_string(),
        description: None,
        providers,
        materialized: Vec::new(),
        hook_merge: Vec::new(),
        created_at: String::new(),
        updated_at: String::new(),
    }
}

/// Skill subdirs (each holding `SKILL.md`) across every `.<provider>/<sub>`,
/// deduped by name (a plugin ships byte-identical skills per provider).
fn collect_skill_dirs(root: &Path, sub: &str, plugin: &str, out: &mut Vec<(String, LibraryItem)>) {
    let mut seen = BTreeSet::new();
    for p in COMPONENT_PROVIDERS {
        let dir = root.join(format!(".{p}")).join(sub);
        let Ok(rd) = std::fs::read_dir(&dir) else {
            continue;
        };
        for ent in rd.flatten() {
            if !ent.path().join("SKILL.md").is_file() {
                continue;
            }
            let name = ent.file_name().to_string_lossy().into_owned();
            if seen.insert(name.clone()) {
                out.push((
                    plugin.to_string(),
                    synthetic(LibraryKind::Skill, plugin, &name, vec![]),
                ));
            }
        }
    }
}

/// `*.md` command/prompt files across each provider's command dir, deduped.
fn collect_command_files(root: &Path, plugin: &str, out: &mut Vec<(String, LibraryItem)>) {
    let mut seen = BTreeSet::new();
    for p in COMPONENT_PROVIDERS {
        let sub = if *p == "codex" { "prompts" } else { "commands" };
        let dir = root.join(format!(".{p}")).join(sub);
        let Ok(rd) = std::fs::read_dir(&dir) else {
            continue;
        };
        for ent in rd.flatten() {
            let path = ent.path();
            if path.extension().and_then(|e| e.to_str()) != Some("md") {
                continue;
            }
            let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            if seen.insert(stem.to_string()) {
                out.push((
                    plugin.to_string(),
                    synthetic(LibraryKind::Command, plugin, stem, vec![]),
                ));
            }
        }
    }
}

/// `templates/*.json` — read `name`/`title` if present, else the file stem.
fn collect_templates(root: &Path, plugin: &str, out: &mut Vec<(String, LibraryItem)>) {
    let Ok(rd) = std::fs::read_dir(root.join("templates")) else {
        return;
    };
    for ent in rd.flatten() {
        let path = ent.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let name = std::fs::read_to_string(&path)
            .ok()
            .and_then(|txt| serde_json::from_str::<serde_json::Value>(&txt).ok())
            .and_then(|v| v.get("name").and_then(|n| n.as_str()).map(str::to_string))
            .or_else(|| {
                path.file_stem()
                    .and_then(|s| s.to_str())
                    .map(str::to_string)
            })
            .unwrap_or_default();
        if !name.is_empty() {
            out.push((
                plugin.to_string(),
                synthetic(LibraryKind::Template, plugin, &name, vec![]),
            ));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn enumerates_plugin_skills_commands_templates() {
        let tmp = tempdir().unwrap();
        let _g = crate::test_support::home_lock()
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let prev = std::env::var("FLEETIFY_HOME").ok();
        std::env::set_var("FLEETIFY_HOME", tmp.path());

        let plug = tmp.path().join("plugins/cool");
        std::fs::create_dir_all(plug.join(".claude/skills/reviewer")).unwrap();
        std::fs::write(plug.join(".claude/skills/reviewer/SKILL.md"), b"x").unwrap();
        std::fs::create_dir_all(plug.join(".claude/commands")).unwrap();
        std::fs::write(plug.join(".claude/commands/deploy.md"), b"x").unwrap();
        std::fs::create_dir_all(plug.join("templates")).unwrap();
        std::fs::write(
            plug.join("templates/persona.json"),
            br#"{"name":"persona"}"#,
        )
        .unwrap();

        let skills = plugin_items(LibraryKind::Skill);
        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].0, "cool");
        assert_eq!(skills[0].1.slug, "reviewer");
        assert_eq!(plugin_items(LibraryKind::Command)[0].1.slug, "deploy");
        assert_eq!(plugin_items(LibraryKind::Template)[0].1.slug, "persona");
        assert!(plugin_items(LibraryKind::Prompt).is_empty());

        match prev {
            Some(v) => std::env::set_var("FLEETIFY_HOME", v),
            None => std::env::remove_var("FLEETIFY_HOME"),
        }
    }
}
