//! Aggregates installed SKILLS (Library + plugin) and plugin COMMANDS into a
//! flat list of `/namespace:command` slash commands for the composer.
//!
//! Naming follows `/(namespace):(command)`: a standalone Library skill `xyz`
//! becomes `/xyz:xyz`; a plugin `xyz` that ships several skills/commands yields
//! `/xyz:abc`, `/xyz:def`, … (one per component).
//!
//! The `body` is provider-smart (decided from the session's `tool`): agents that
//! natively auto-discover materialized skills get a short directive ("Use the X
//! skill …"); the rest get the skill body injected as the prompt. Plugin
//! commands always send their own body. Read-only — the Library store and the
//! installed plugin trees remain the sources of truth.

use std::collections::BTreeSet;

use serde::Serialize;

use crate::services::library::store;
use crate::services::library::types::LibraryKind;
use crate::services::plugins::providers::{component_basename, COMPONENT_PROVIDERS};
use crate::services::provider_inspector::parse_frontmatter;

/// One composer slash command. `name` is `"namespace:command"`; the renderer
/// prepends `/`, yielding `/namespace:command`. `body` is the exact text to
/// send for the active provider; `args` lists `{{arg}}` names (empty for skills).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct CommandSummary {
    pub name: String,
    pub description: String,
    pub body: String,
    pub args: Vec<String>,
}

/// Agents that auto-discover materialized skills — a typed `/skill` directive is
/// enough. Everyone else needs the skill body injected as the prompt. Unknown /
/// missing tool → inject the body (always works).
fn native_skills(tool: &str) -> bool {
    matches!(
        tool,
        "claude-code" | "codex-cli" | "antigravity-cli" | "antigravity-sdk"
    )
}

/// Sanitize a namespace/command token to the shared slug shape `[a-z0-9-]`
/// (underscores are illegal across OpenCode/Cursor; see `providers::namespaced_id`).
fn slugify(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut prev_dash = false;
    for ch in s.chars().flat_map(|c| c.to_lowercase()) {
        if ch.is_ascii_alphanumeric() {
            out.push(ch);
            prev_dash = false;
        } else if !prev_dash {
            out.push('-');
            prev_dash = true;
        }
    }
    out.trim_matches('-').to_string()
}

/// Drop a leading `--- … ---` YAML frontmatter block, returning the body.
fn strip_frontmatter(text: &str) -> String {
    let Some(rest) = text.strip_prefix("---") else {
        return text.trim().to_string();
    };
    let Some(end) = rest.find("\n---") else {
        return text.trim().to_string();
    };
    let after = &rest[end + 1..];
    match after.find('\n') {
        Some(nl) => after[nl + 1..].trim_start().to_string(),
        None => String::new(),
    }
}

/// The text a `/namespace:skill` command sends for `tool`: a directive for
/// native-skill agents, else the skill body.
fn skill_body(
    tool: Option<&str>,
    label: &str,
    description: &Option<String>,
    skill_md: &str,
) -> String {
    let native = tool.map(native_skills).unwrap_or(false);
    if native {
        match description {
            Some(d) if !d.is_empty() => format!("Use the \"{label}\" skill — {d}"),
            _ => format!("Use the \"{label}\" skill."),
        }
    } else {
        strip_frontmatter(skill_md)
    }
}

fn push_unique(seen: &mut BTreeSet<String>, out: &mut Vec<CommandSummary>, c: CommandSummary) {
    if seen.insert(c.name.clone()) {
        out.push(c);
    }
}

/// Library SKILL items → `/slug:slug`.
fn library_skills(tool: Option<&str>, seen: &mut BTreeSet<String>, out: &mut Vec<CommandSummary>) {
    for item in store::list(Some(LibraryKind::Skill)) {
        let ns = slugify(&item.slug);
        if ns.is_empty() {
            continue;
        }
        let md = std::fs::read_to_string(store::item_dir(&item.id).join("skill").join("SKILL.md"))
            .unwrap_or_default();
        let body = skill_body(tool, &item.name, &item.description, &md);
        push_unique(
            seen,
            out,
            CommandSummary {
                name: format!("{ns}:{ns}"),
                description: item
                    .description
                    .clone()
                    .unwrap_or_else(|| item.name.clone()),
                body,
                args: Vec::new(),
            },
        );
    }
}

/// Plugin-shipped skills (`/plugin:skill`) + commands (`/plugin:command`).
/// Mirrors the materializer layout (`.<vendor>/skills/<name>/SKILL.md`,
/// `.<vendor>/commands/*.md`, Codex `prompts`), deduped across vendor copies.
fn plugin_components(
    tool: Option<&str>,
    seen: &mut BTreeSet<String>,
    out: &mut Vec<CommandSummary>,
) {
    let Ok(rd) = std::fs::read_dir(fleetify_core::fleetify_home().join("plugins")) else {
        return;
    };
    let mut plugin_dirs: Vec<_> = rd.flatten().map(|e| e.path()).collect();
    plugin_dirs.sort();

    let mut vendors: Vec<&str> = COMPONENT_PROVIDERS
        .iter()
        .map(|p| component_basename(p))
        .collect();
    vendors.sort_unstable();
    vendors.dedup();

    for root in plugin_dirs {
        if !root.is_dir() {
            continue;
        }
        let Some(ns) = root.file_name().and_then(|s| s.to_str()).map(slugify) else {
            continue;
        };
        if ns.is_empty() {
            continue;
        }

        for vendor in &vendors {
            // Skills: .<vendor>/skills/<name>/SKILL.md
            if let Ok(entries) = std::fs::read_dir(root.join(format!(".{vendor}")).join("skills")) {
                let mut dirs: Vec<_> = entries.flatten().map(|e| e.path()).collect();
                dirs.sort();
                for sd in dirs {
                    let Some(label) = sd.file_name().and_then(|s| s.to_str()) else {
                        continue;
                    };
                    let cmd = slugify(label);
                    let name = format!("{ns}:{cmd}");
                    if cmd.is_empty() || seen.contains(&name) {
                        continue;
                    }
                    let md = std::fs::read_to_string(sd.join("SKILL.md")).unwrap_or_default();
                    let (_n, description) = parse_frontmatter(&md);
                    let body = skill_body(tool, label, &description, &md);
                    push_unique(
                        seen,
                        out,
                        CommandSummary {
                            name,
                            description: description.unwrap_or_else(|| label.to_string()),
                            body,
                            args: Vec::new(),
                        },
                    );
                }
            }
            // Commands: .<vendor>/commands/*.md (Codex: prompts/*.md)
            let sub = if *vendor == "codex" {
                "prompts"
            } else {
                "commands"
            };
            if let Ok(entries) = std::fs::read_dir(root.join(format!(".{vendor}")).join(sub)) {
                let mut files: Vec<_> = entries.flatten().map(|e| e.path()).collect();
                files.sort();
                for path in files {
                    if path.extension().and_then(|e| e.to_str()) != Some("md") {
                        continue;
                    }
                    let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
                        continue;
                    };
                    let cmd = slugify(stem);
                    let name = format!("{ns}:{cmd}");
                    if cmd.is_empty() || seen.contains(&name) {
                        continue;
                    }
                    let content = std::fs::read_to_string(&path).unwrap_or_default();
                    let (_n, description) = parse_frontmatter(&content);
                    push_unique(
                        seen,
                        out,
                        CommandSummary {
                            name,
                            description: description.unwrap_or_else(|| stem.to_string()),
                            body: strip_frontmatter(&content),
                            args: Vec::new(),
                        },
                    );
                }
            }
        }
    }
}

/// Every installed skill/command as a `/namespace:command`, Library skills
/// first (so a user skill shadows a plugin one on a name clash).
pub fn list_commands(tool: Option<&str>) -> Vec<CommandSummary> {
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    library_skills(tool, &mut seen, &mut out);
    plugin_components(tool, &mut seen, &mut out);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

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

    fn write_library_skill(
        home: &std::path::Path,
        id: &str,
        slug: &str,
        name: &str,
        desc: &str,
        body: &str,
    ) {
        let dir = home.join("library/items").join(id);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("meta.json"),
            format!(
                r#"{{"id":"{id}","kind":"skill","name":"{name}","slug":"{slug}","description":"{desc}","providers":[],"materialized":[],"hook_merge":[],"created_at":"t0","updated_at":"t0"}}"#
            ),
        )
        .unwrap();
        let sdir = dir.join("skill");
        std::fs::create_dir_all(&sdir).unwrap();
        std::fs::write(sdir.join("SKILL.md"), body).unwrap();
    }

    fn write_plugin_skill(home: &std::path::Path, plugin: &str, name: &str, md: &str) {
        let dir = home
            .join("plugins")
            .join(plugin)
            .join(".claude/skills")
            .join(name);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("SKILL.md"), md).unwrap();
    }

    fn write_plugin_command(home: &std::path::Path, plugin: &str, stem: &str, content: &str) {
        let dir = home.join("plugins").join(plugin).join(".claude/commands");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(format!("{stem}.md")), content).unwrap();
    }

    #[test]
    fn library_skill_is_namespaced_slug_slug_with_body_for_non_native() {
        let tmp = tempdir().unwrap();
        with_home(tmp.path(), || {
            write_library_skill(
                tmp.path(),
                "id-rev",
                "reviewer",
                "Reviewer",
                "reviews code",
                "Do a review.",
            );
            let list = list_commands(Some("cursor-cli"));
            let c = list.iter().find(|c| c.name == "reviewer:reviewer").unwrap();
            assert_eq!(c.body, "Do a review.");
            assert_eq!(c.description, "reviews code");
        });
    }

    #[test]
    fn native_provider_gets_directive_not_body() {
        let tmp = tempdir().unwrap();
        with_home(tmp.path(), || {
            write_library_skill(
                tmp.path(),
                "id-rev",
                "reviewer",
                "Reviewer",
                "reviews code",
                "Long skill body",
            );
            let list = list_commands(Some("claude-code"));
            let c = list.iter().find(|c| c.name == "reviewer:reviewer").unwrap();
            assert!(c.body.contains("Use the"));
            assert!(c.body.contains("reviews code"));
            assert!(!c.body.contains("Long skill body"));
        });
    }

    #[test]
    fn plugin_skill_and_command_are_namespaced() {
        let tmp = tempdir().unwrap();
        with_home(tmp.path(), || {
            write_plugin_skill(
                tmp.path(),
                "xyz",
                "abc",
                "---\ndescription: does abc\n---\nabc body",
            );
            write_plugin_command(
                tmp.path(),
                "xyz",
                "deploy",
                "---\ndescription: ship it\n---\nRun the deploy.",
            );
            let list = list_commands(Some("cursor-cli"));
            assert!(list.iter().any(|c| c.name == "xyz:abc"));
            let dep = list.iter().find(|c| c.name == "xyz:deploy").unwrap();
            assert_eq!(dep.body, "Run the deploy.");
            assert_eq!(dep.description, "ship it");
        });
    }

    #[test]
    fn empty_home_lists_nothing() {
        let tmp = tempdir().unwrap();
        with_home(tmp.path(), || {
            assert!(list_commands(Some("claude-code")).is_empty());
        });
    }
}
