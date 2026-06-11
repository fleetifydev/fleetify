//! Unified agent-template resolution. An `agent_template` id on a session can
//! come from three sources, resolved in this order:
//!   1. **builtins** — first-party personas in `builtin_templates`.
//!   2. **plugin templates** — `~/.fleetify/plugins/<id>/templates/*.json`.
//!   3. **library templates** — user-authored `kind == template` items.
//!
//! `resolve()` returns the owned persona the chat bridges + MCP mounting read;
//! `list_all_specs()` returns the full list as `TemplateSpec` (the wire shape
//! the renderer's NewAgentDialog + Routines consume via `/api/runtime/templates`).

use serde::{Deserialize, Serialize};

use crate::services::builtin_templates::{self, BuiltinTemplate};
use crate::services::library::store;
use crate::services::library::types::LibraryKind;

/// Owned persona resolved from any template source.
pub struct ResolvedTemplate {
    pub system_prompt: String,
    pub extra_mcp_servers: Vec<String>,
    pub default_permission_mode: String,
}

/// Wire descriptor for a template — the Rust mirror of the renderer's
/// `PluginTemplate` interface (`new-agent-dialog.tsx`). `plugin` tags the
/// origin: `"builtin"`, a plugin name, or `"library"`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TemplateSpec {
    pub name: String,
    pub title: String,
    pub description: String,
    pub preferred_tier: String,
    pub permission_mode: String,
    pub system_prompt: String,
    pub providers: Vec<String>,
    pub mcp_servers: Vec<String>,
    pub plugin: String,
    pub tags: Vec<String>,
}

/// Resolve a template id to its persona. Returns `None` for unknown/empty ids
/// so callers fall back to a generic session.
pub fn resolve(id: Option<&str>) -> Option<ResolvedTemplate> {
    let id = id.map(str::trim).filter(|s| !s.is_empty())?;
    if let Some(b) = builtin_templates::get(Some(id)) {
        return Some(ResolvedTemplate {
            system_prompt: b.system_prompt.to_string(),
            extra_mcp_servers: b.extra_mcp_servers.iter().map(|s| s.to_string()).collect(),
            default_permission_mode: b.default_permission_mode.to_string(),
        });
    }
    dynamic_specs()
        .into_iter()
        .find(|t| t.name == id)
        .map(|t| ResolvedTemplate {
            system_prompt: t.system_prompt,
            extra_mcp_servers: t.mcp_servers,
            default_permission_mode: t.permission_mode,
        })
}

/// Every template as a wire spec: builtins (mapped) + plugin + library.
pub fn list_all_specs() -> Vec<TemplateSpec> {
    let mut out: Vec<TemplateSpec> = builtin_templates::list_all()
        .iter()
        .map(builtin_to_spec)
        .collect();
    out.extend(dynamic_specs());
    out
}

fn builtin_to_spec(b: &BuiltinTemplate) -> TemplateSpec {
    TemplateSpec {
        name: b.id.to_string(),
        title: b.title.to_string(),
        description: b.description.to_string(),
        preferred_tier: "most_capable".to_string(),
        permission_mode: b.default_permission_mode.to_string(),
        system_prompt: b.system_prompt.to_string(),
        providers: vec!["claude".to_string()],
        mcp_servers: b.extra_mcp_servers.iter().map(|s| s.to_string()).collect(),
        plugin: "builtin".to_string(),
        tags: vec![],
    }
}

/// Plugin + library templates (everything that isn't a compiled-in builtin).
fn dynamic_specs() -> Vec<TemplateSpec> {
    let mut out = Vec::new();

    // Library templates (kind == template): the item's `system_prompt.md`
    // payload is the prompt; the rest of the spec comes from item metadata.
    for item in store::list(Some(LibraryKind::Template)) {
        let system_prompt =
            std::fs::read_to_string(store::item_dir(&item.id).join("system_prompt.md"))
                .unwrap_or_default();
        out.push(TemplateSpec {
            name: item.slug.clone(),
            title: item.name.clone(),
            description: item.description.clone().unwrap_or_default(),
            preferred_tier: "most_capable".to_string(),
            permission_mode: "default".to_string(),
            system_prompt,
            providers: if item.providers.is_empty() {
                vec!["claude".to_string()]
            } else {
                item.providers.clone()
            },
            mcp_servers: Vec::new(),
            plugin: "library".to_string(),
            tags: Vec::new(),
        });
    }

    // Plugin templates: each installed plugin's `templates/*.json` is a full
    // `TemplateSpec` (parsed as-is; malformed files are skipped).
    let plugins = fleetify_core::fleetify_home().join("plugins");
    if let Ok(rd) = std::fs::read_dir(&plugins) {
        for ent in rd.flatten() {
            let tdir = ent.path().join("templates");
            let Ok(trd) = std::fs::read_dir(&tdir) else {
                continue;
            };
            for t in trd.flatten() {
                let p = t.path();
                if p.extension().and_then(|e| e.to_str()) != Some("json") {
                    continue;
                }
                if let Ok(txt) = std::fs::read_to_string(&p) {
                    if let Ok(spec) = serde_json::from_str::<TemplateSpec>(&txt) {
                        out.push(spec);
                    }
                }
            }
        }
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::library::types::{LibraryItem, Materialized};
    use std::path::Path;
    use tempfile::tempdir;

    fn with_fleetify_home<R>(home: &Path, f: impl FnOnce() -> R) -> R {
        let _g = crate::test_support::home_lock()
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let saved: Vec<(&str, Option<String>)> = ["HOME", "USERPROFILE", "FLEETIFY_HOME"]
            .iter()
            .map(|k| (*k, std::env::var(k).ok()))
            .collect();
        std::env::set_var("HOME", home);
        std::env::set_var("USERPROFILE", home);
        std::env::set_var("FLEETIFY_HOME", home.join(".fleetify"));
        let r = f();
        for (k, v) in saved {
            match v {
                Some(val) => std::env::set_var(k, val),
                None => std::env::remove_var(k),
            }
        }
        r
    }

    #[test]
    fn resolve_and_list_include_builtin() {
        let tmp = tempdir().unwrap();
        with_fleetify_home(&tmp.path().join("home"), || {
            let r = resolve(Some("reverse_engineering")).expect("builtin resolves");
            assert!(r
                .system_prompt
                .starts_with("You are a web reverse-engineering"));
            assert_eq!(r.extra_mcp_servers, vec!["fleet_reveng".to_string()]);

            let specs = list_all_specs();
            let b = specs
                .iter()
                .find(|s| s.name == "reverse_engineering")
                .unwrap();
            assert_eq!(b.plugin, "builtin");
            assert_eq!(b.mcp_servers, vec!["fleet_reveng".to_string()]);
            assert_eq!(b.permission_mode, "acceptEdits");
        });
    }

    #[test]
    fn library_template_resolves_by_slug_and_lists() {
        let tmp = tempdir().unwrap();
        with_fleetify_home(&tmp.path().join("home"), || {
            // Author a library template item: meta.json + system_prompt.md.
            let item = LibraryItem {
                id: "t1".to_string(),
                kind: LibraryKind::Template,
                name: "Code Reviewer".to_string(),
                slug: "code-reviewer".to_string(),
                description: Some("reviews diffs".to_string()),
                providers: vec!["claude".to_string()],
                materialized: Vec::<Materialized>::new(),
                hook_merge: Vec::new(),
                created_at: "t0".to_string(),
                updated_at: "t0".to_string(),
            };
            store::save(&item).unwrap();
            std::fs::write(
                store::item_dir("t1").join("system_prompt.md"),
                b"You are a meticulous code reviewer.",
            )
            .unwrap();

            let r = resolve(Some("code-reviewer")).expect("library template resolves");
            assert_eq!(r.system_prompt, "You are a meticulous code reviewer.");

            let specs = list_all_specs();
            let lib = specs.iter().find(|s| s.name == "code-reviewer").unwrap();
            assert_eq!(lib.plugin, "library");
            assert_eq!(lib.title, "Code Reviewer");
            assert_eq!(lib.providers, vec!["claude".to_string()]);
            // Builtins still present alongside.
            assert!(specs.iter().any(|s| s.name == "reverse_engineering"));
        });
    }
}
