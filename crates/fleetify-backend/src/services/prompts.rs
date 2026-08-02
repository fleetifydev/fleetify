//! Aggregates the user's reusable prompts — Library-authored prompt items plus
//! the prompt/command bodies shipped by installed plugins — into one flat list
//! the `/prompts` command can search and send. Read-only: the Library store and
//! the plugin trees remain the sources of truth.

use std::collections::BTreeSet;

use serde::Serialize;

use crate::services::library::store;
use crate::services::library::types::LibraryKind;
use crate::services::plugins::providers::{component_basename, COMPONENT_PROVIDERS};
use crate::services::provider_inspector::parse_frontmatter;

/// One sendable prompt. `slug` is the user-facing key for `/prompts <slug>`;
/// `body` is the text injected as a chat message.
#[derive(Debug, Clone, Serialize)]
pub struct PromptSummary {
    pub id: String,
    pub name: String,
    pub slug: String,
    pub description: Option<String>,
    /// "user" for Library-authored prompts, else the contributing plugin name.
    pub source: String,
    pub body: String,
}

/// Drop a leading `--- … ---` YAML frontmatter block, returning the body that
/// follows. No-op when there's no frontmatter.
fn strip_frontmatter(text: &str) -> String {
    let Some(body) = text.strip_prefix("---") else {
        return text.trim().to_string();
    };
    let Some(end) = body.find("\n---") else {
        return text.trim().to_string();
    };
    // `body[end..]` starts at the closing "\n---"; the prompt body is whatever
    // follows that delimiter line.
    let after_marker = &body[end + 1..];
    match after_marker.find('\n') {
        Some(nl) => after_marker[nl + 1..].trim_start().to_string(),
        None => String::new(),
    }
}

/// Library-authored prompts: metadata from the store, body read from the
/// materialized `<FLEETIFY_HOME>/prompts/<slug>.md`.
fn library_prompts(seen: &mut BTreeSet<String>, out: &mut Vec<PromptSummary>) {
    for item in store::list(Some(LibraryKind::Prompt)) {
        if !seen.insert(item.slug.clone()) {
            continue;
        }
        let path = fleetify_core::fleetify_home()
            .join("prompts")
            .join(format!("{}.md", item.slug));
        let body = std::fs::read_to_string(&path).unwrap_or_default();
        out.push(PromptSummary {
            id: item.id,
            name: item.name,
            slug: item.slug,
            description: item.description,
            source: "user".to_string(),
            body,
        });
    }
}

/// Plugin-shipped prompts/commands: each plugin's per-provider markdown
/// (`.codex/prompts/` for Codex, `.<provider>/commands/` otherwise), deduped by
/// file stem (a plugin ships the same body per provider).
fn plugin_prompts(seen: &mut BTreeSet<String>, out: &mut Vec<PromptSummary>) {
    let Ok(rd) = std::fs::read_dir(fleetify_core::fleetify_home().join("plugins")) else {
        return;
    };
    let mut plugin_dirs: Vec<_> = rd.flatten().map(|e| e.path()).collect();
    plugin_dirs.sort();
    for root in plugin_dirs {
        if !root.is_dir() {
            continue;
        }
        let plugin = match root.file_name().and_then(|s| s.to_str()) {
            Some(p) if !p.is_empty() => p.to_string(),
            _ => continue,
        };
        for p in COMPONENT_PROVIDERS {
            let sub = if *p == "codex-cli" {
                "prompts"
            } else {
                "commands"
            };
            // Plugins organise by VENDOR basename (`.claude/`, `.codex/`),
            // not by routing id — `component_basename` is the mapping, and
            // its doc comment warns this is structural, not a legacy alias.
            // Using `p` directly looked for `.claude-code/` / `.codex-cli/`,
            // which no plugin ships, so 7 of the 9 providers' commands were
            // invisible here while materialising correctly.
            let dir = root.join(format!(".{}", component_basename(p))).join(sub);
            let Ok(entries) = std::fs::read_dir(&dir) else {
                continue;
            };
            let mut files: Vec<_> = entries.flatten().map(|e| e.path()).collect();
            files.sort();
            for path in files {
                if path.extension().and_then(|e| e.to_str()) != Some("md") {
                    continue;
                }
                let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
                    continue;
                };
                if !seen.insert(stem.to_string()) {
                    continue;
                }
                let content = std::fs::read_to_string(&path).unwrap_or_default();
                let (_name, description) = parse_frontmatter(&content);
                out.push(PromptSummary {
                    id: format!("plugin:{plugin}:{stem}"),
                    name: stem.to_string(),
                    slug: stem.to_string(),
                    description,
                    source: plugin.clone(),
                    body: strip_frontmatter(&content),
                });
            }
        }
    }
}

/// Every prompt, Library first (so a user prompt shadows a plugin one on a slug
/// clash), then plugin prompts. Unique by slug.
pub fn list_prompts() -> Vec<PromptSummary> {
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    library_prompts(&mut seen, &mut out);
    plugin_prompts(&mut seen, &mut out);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    /// Run `f` with FLEETIFY_HOME pinned to `home`, under the shared env lock so
    /// we don't race other home-env tests. Mirrors `library::enumerate` tests.
    fn with_home<R>(home: &std::path::Path, f: impl FnOnce() -> R) -> R {
        let _g = crate::test_support::home_lock()
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let prev = std::env::var("FLEETIFY_HOME").ok();
        std::env::set_var("FLEETIFY_HOME", home);
        let r = f();
        match prev {
            Some(v) => std::env::set_var("FLEETIFY_HOME", v),
            None => std::env::remove_var("FLEETIFY_HOME"),
        }
        r
    }

    fn write_library_prompt(home: &std::path::Path, id: &str, slug: &str, name: &str, body: &str) {
        let dir = home.join("library/items").join(id);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("meta.json"),
            format!(
                r#"{{"id":"{id}","kind":"prompt","name":"{name}","slug":"{slug}","description":"d","providers":[],"materialized":[],"hook_merge":[],"created_at":"t0","updated_at":"t0"}}"#
            ),
        )
        .unwrap();
        let pdir = home.join("prompts");
        std::fs::create_dir_all(&pdir).unwrap();
        std::fs::write(pdir.join(format!("{slug}.md")), body).unwrap();
    }

    /// Write a plugin-shipped command/prompt into the VENDOR dotdir a real
    /// plugin actually uses (`.claude/commands`, `.codex/prompts`) — see
    /// `providers::component_basename`, which is the mapping from routing id
    /// to that dotdir.
    fn write_plugin_component(
        home: &std::path::Path,
        plugin: &str,
        vendor: &str,
        sub: &str,
        stem: &str,
        content: &str,
    ) {
        let dir = home
            .join("plugins")
            .join(plugin)
            .join(format!(".{vendor}"))
            .join(sub);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(format!("{stem}.md")), content).unwrap();
    }

    fn write_plugin_command(home: &std::path::Path, plugin: &str, stem: &str, content: &str) {
        write_plugin_component(home, plugin, "claude", "commands", stem, content);
    }

    #[test]
    fn strip_frontmatter_drops_yaml_header() {
        assert_eq!(
            strip_frontmatter("---\ndescription: x\n---\nHello"),
            "Hello"
        );
        assert_eq!(strip_frontmatter("No header here"), "No header here");
        assert_eq!(strip_frontmatter("---\nonly: meta\n---\n"), "");
    }

    #[test]
    fn library_prompt_is_listed_with_body() {
        let tmp = tempdir().unwrap();
        with_home(tmp.path(), || {
            write_library_prompt(tmp.path(), "id-greet", "greet", "Greeting", "Hello there");
            let list = list_prompts();
            let p = list.iter().find(|p| p.slug == "greet").unwrap();
            assert_eq!(p.name, "Greeting");
            assert_eq!(p.body, "Hello there");
            assert_eq!(p.source, "user");
        });
    }

    #[test]
    fn plugin_prompt_is_listed_and_frontmatter_stripped() {
        let tmp = tempdir().unwrap();
        with_home(tmp.path(), || {
            write_plugin_command(
                tmp.path(),
                "myplug",
                "deploy",
                "---\ndescription: ship it\n---\nRun the deploy.",
            );
            let list = list_prompts();
            let p = list.iter().find(|p| p.slug == "deploy").unwrap();
            assert_eq!(p.source, "myplug");
            assert_eq!(p.description.as_deref(), Some("ship it"));
            assert_eq!(p.body, "Run the deploy.");
            assert_eq!(p.id, "plugin:myplug:deploy");
        });
    }

    /// The vendor-basename mapping, not just the claude case. Listing used to
    /// join the routing id (`.codex-cli/`), a directory no plugin ships, so
    /// every suffix-renamed provider's commands were silently absent from the
    /// prompt list even though the materializer placed them correctly.
    #[test]
    fn plugin_prompts_are_found_under_the_vendor_dotdir_not_the_routing_id() {
        let tmp = tempdir().unwrap();
        with_home(tmp.path(), || {
            write_plugin_component(
                tmp.path(),
                "codexplug",
                "codex",
                "prompts",
                "shipit",
                "---\ndescription: ship\n---\nDo the thing.",
            );
            let list = list_prompts();
            let p = list
                .iter()
                .find(|p| p.slug == "shipit")
                .expect("a .codex/prompts command must be listed");
            assert_eq!(p.source, "codexplug");
            assert_eq!(p.id, "plugin:codexplug:shipit");
            assert_eq!(p.body, "Do the thing.");
        });
    }

    #[test]
    fn user_prompt_shadows_plugin_on_slug_clash() {
        let tmp = tempdir().unwrap();
        with_home(tmp.path(), || {
            write_library_prompt(tmp.path(), "id-dup", "dup", "Mine", "user body");
            write_plugin_command(tmp.path(), "p", "dup", "plugin body");
            let hits: Vec<_> = list_prompts()
                .into_iter()
                .filter(|p| p.slug == "dup")
                .collect();
            assert_eq!(hits.len(), 1);
            assert_eq!(hits[0].source, "user");
        });
    }

    #[test]
    fn empty_home_lists_nothing() {
        let tmp = tempdir().unwrap();
        with_home(tmp.path(), || {
            assert!(list_prompts().is_empty());
        });
    }
}
