//! Orchestrate materialization of a library item to its target providers,
//! reusing the per-component writers in `services::plugins::materializers`.
//! Returns the `Materialized` records (paths written) to persist on the item;
//! deletion reverses them.

use std::path::{Path, PathBuf};

use anyhow::Result;
use serde::Deserialize;

use super::store;
use super::types::{
    HookMode, HookScope, HookSpec, LibraryItem, LibraryKind, Materialized, RuleFormat, RuleScope,
    RuleSpec,
};
use crate::services::plugins::hook_merge::{self, HookMergeRecord, NormalizedHook};
use crate::services::plugins::rule_merge::{self, RuleMergeRecord};
use crate::services::plugins::{hook_triggers, materializers, providers};

/// Everything a materialization produced: standalone file/dir artifacts
/// (skills/commands/prompts) plus merge-hook reversal records (Claude/Cursor/
/// agy/Kimi). Both are persisted on the item; deletion reverses both.
pub struct MaterializeOutcome {
    pub materialized: Vec<Materialized>,
    pub hook_merge: Vec<HookMergeRecord>,
    /// Reversal records for rules merged as a marked block into a provider's
    /// global rule file (CLAUDE.md / AGENTS.md / …).
    pub rule_merge: Vec<RuleMergeRecord>,
}

/// A legacy hook payload: `{ "event": "...", "matcher": "...", "command": "..." }`
/// (hooks authored before `HookSpec` was persisted on the item).
#[derive(Deserialize)]
struct LegacyHook {
    event: String,
    #[serde(default)]
    matcher: Option<String>,
    command: String,
}

/// Materialize `item`'s `payload` to each target provider. `payload` is the
/// on-disk payload location: a **dir** for skills (the `SKILL.md` + assets),
/// the `.md` **file** for commands/prompts, the `hook.json` **file** for hooks.
/// Prompts are provider-agnostic; templates are not materialized (read from the
/// store by the runtime templates endpoint).
pub fn materialize_item(item: &LibraryItem, payload: &Path) -> Result<MaterializeOutcome> {
    let mut materialized = Vec::new();
    let mut hooks = Vec::new();
    let mut rules = Vec::new();
    match item.kind {
        LibraryKind::Prompt => {
            let r = materializers::materialize_prompt_item(payload, &item.slug)?;
            push_paths(&mut materialized, &r.provider, r.paths);
        }
        LibraryKind::Skill => {
            // `description` is injected into SKILL.md frontmatter so the
            // materialized skill is valid against the Agent-Skills open
            // standard (Codex/OpenCode/Copilot require name + description).
            let desc = item.description.as_deref();
            for provider in &item.providers {
                let r = materializers::materialize_skill_item(payload, &item.slug, provider, desc)?;
                push_paths(&mut materialized, provider, r.paths);
            }
            // Also write the shared ~/.agents/skills/ copy (the interoperable
            // open-standard location read by Codex, Gemini, Copilot, Cursor and
            // Kimi) so the skill is discoverable cross-tool.
            let shared = materializers::materialize_skill_shared(payload, &item.slug, desc)?;
            push_paths(&mut materialized, &shared.provider, shared.paths);
        }
        LibraryKind::Hook => match &item.hook_spec {
            Some(spec) => materialize_hook_spec(item, spec, &mut materialized, &mut hooks)?,
            None => {
                // Legacy hooks: the hook.json payload holds {event,matcher,command}.
                let legacy: LegacyHook = serde_json::from_str(&std::fs::read_to_string(payload)?)?;
                for provider in &item.providers {
                    let nh = NormalizedHook {
                        event: &legacy.event,
                        matcher: legacy.matcher.as_deref(),
                        command: &legacy.command,
                    };
                    if let Some(rec) = hook_merge::materialize_hook_item(provider, &nh)? {
                        hooks.push(rec);
                    }
                }
            }
        },
        LibraryKind::Subagent => {
            // A delegate agent file per selected provider's `agents/` dir
            // (Codex gets a `.toml`); name + description ensured.
            let desc = item.description.as_deref();
            for provider in &item.providers {
                let r =
                    materializers::materialize_subagent_item(payload, &item.slug, provider, desc)?;
                push_paths(&mut materialized, provider, r.paths);
            }
        }
        LibraryKind::Rule => {
            // Dispatch by the rule's format/scope (rule_spec). A legacy rule
            // (rule_spec == None) defaults to a global "general" markdown merge.
            let desc = item.description.as_deref();
            let body = std::fs::read_to_string(payload)?;
            let spec = item.rule_spec.clone().unwrap_or_default();
            match spec.format {
                RuleFormat::General => {
                    // Markdown merge into each provider's rule file (home or folder).
                    for provider in &item.providers {
                        if let Some(rec) = merge_general_rule(provider, &item.slug, &body, &spec)? {
                            rules.push(rec);
                        }
                    }
                }
                RuleFormat::Cursor => {
                    // Standalone `.mdc` with rule-type frontmatter.
                    if let Some(dir) = cursor_rules_dir_for(&spec) {
                        let rule_type = spec.cursor_rule_type.unwrap_or_default();
                        let r = materializers::materialize_rule_cursor(
                            &dir,
                            &item.slug,
                            rule_type,
                            desc,
                            spec.globs.as_deref(),
                            &body,
                        )?;
                        push_paths(&mut materialized, &r.provider, r.paths);
                    }
                }
                RuleFormat::Copilot => {
                    // With globs + a folder → a `.github/instructions/*` path file
                    // (applyTo + description frontmatter); otherwise a plain merge
                    // into `copilot-instructions.md` (the description, when given,
                    // is prepended to the merged block since that file has no
                    // frontmatter).
                    let globs = spec.globs.as_deref().filter(|g| !g.trim().is_empty());
                    match (globs, folder_path(&spec)) {
                        (Some(globs), Some(folder)) => {
                            let github = folder.join(".github");
                            let r = materializers::materialize_rule_copilot_instructions(
                                &github, &item.slug, globs, desc, &body,
                            )?;
                            push_paths(&mut materialized, &r.provider, r.paths);
                        }
                        _ => {
                            let merged = prepend_description(desc, &body);
                            if let Some(rec) =
                                merge_general_rule("github-copilot", &item.slug, &merged, &spec)?
                            {
                                rules.push(rec);
                            }
                        }
                    }
                }
            }
        }
        // Templates are app-level metadata, surfaced via runtime templates.
        LibraryKind::Template => {}
    }
    Ok(MaterializeOutcome {
        materialized,
        hook_merge: hooks,
        rule_merge: rules,
    })
}

/// Reverse a materialization: delete standalone artifacts, un-merge hooks, and
/// strip merged rule blocks.
pub fn unmaterialize_item(
    materialized: &[Materialized],
    hook_records: &[HookMergeRecord],
    rule_records: &[RuleMergeRecord],
) {
    for m in materialized {
        let p = Path::new(&m.path);
        if p.is_dir() {
            let _ = std::fs::remove_dir_all(p);
        } else if p.is_file() {
            let _ = std::fs::remove_file(p);
        }
    }
    for rec in hook_records {
        let _ = hook_merge::unmaterialize_hook(rec);
    }
    for rec in rule_records {
        rule_merge::unmaterialize_rule(rec);
    }
}

/// The project folder for a folder-scoped hook, or `None` for global scope.
fn hook_folder(spec: &HookSpec) -> Option<PathBuf> {
    if spec.scope == HookScope::Folder {
        spec.folder
            .as_deref()
            .map(str::trim)
            .filter(|f| !f.is_empty())
            .map(PathBuf::from)
    } else {
        None
    }
}

/// Copy `src` → `dest`, creating parent dirs.
fn copy_into(src: &Path, dest: &Path) -> Result<()> {
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::copy(src, dest)?;
    Ok(())
}

/// Materialize a `HookSpec` to each target provider, dispatching by mode.
fn materialize_hook_spec(
    item: &LibraryItem,
    spec: &HookSpec,
    materialized: &mut Vec<Materialized>,
    hooks: &mut Vec<HookMergeRecord>,
) -> Result<()> {
    let item_dir = store::item_dir(&item.id);
    let folder = hook_folder(spec);
    match spec.mode {
        HookMode::Plugin => {
            for provider in &item.providers {
                if provider != "opencode" {
                    continue;
                }
                let Some(handler) = &spec.handler_file else {
                    continue;
                };
                let Some(dir) = providers::opencode_plugin_dir(folder.as_deref()) else {
                    continue;
                };
                let dest = dir.join(format!("{}.ts", item.slug));
                copy_into(&item_dir.join(handler), &dest)?;
                materialized.push(Materialized {
                    provider: provider.clone(),
                    path: dest.to_string_lossy().into_owned(),
                });
            }
        }
        HookMode::Gateway => {
            for provider in &item.providers {
                if provider != "hermes-agent" {
                    continue;
                }
                let Some(handler) = &spec.handler_file else {
                    continue;
                };
                if spec.events.is_empty() {
                    continue;
                }
                let Some(home) = providers::provider_home("hermes-agent") else {
                    continue;
                };
                let dir = home.join("hooks").join(&item.slug);
                std::fs::create_dir_all(&dir)?;
                std::fs::write(
                    dir.join("HOOK.yaml"),
                    gateway_manifest(&item.slug, item.description.as_deref(), &spec.events),
                )?;
                std::fs::copy(item_dir.join(handler), dir.join("handler.py"))?;
                materialized.push(Materialized {
                    provider: provider.clone(),
                    path: dir.to_string_lossy().into_owned(),
                });
            }
        }
        HookMode::Command => {
            let Some(trigger) = spec.trigger.as_deref() else {
                return Ok(());
            };
            for provider in &item.providers {
                let Some(native) = hook_triggers::native_event(trigger, provider) else {
                    continue;
                };
                // Resolve the command, copying the handler (if any) into the
                // provider's hooks dir and substituting ${file} with its path.
                let command = match &spec.handler_file {
                    Some(handler) => {
                        let Some(hdir) = providers::hooks_dir(provider, folder.as_deref()) else {
                            continue;
                        };
                        let dest = hdir.join(&item.slug).join(handler);
                        copy_into(&item_dir.join(handler), &dest)?;
                        materialized.push(Materialized {
                            provider: provider.clone(),
                            path: hdir.join(&item.slug).to_string_lossy().into_owned(),
                        });
                        spec.command
                            .clone()
                            .unwrap_or_default()
                            .replace("${file}", &dest.to_string_lossy())
                    }
                    None => spec.command.clone().unwrap_or_default(),
                };
                if command.trim().is_empty() {
                    continue;
                }
                if provider == "github-copilot" {
                    if let Some(path) = write_copilot_hook(
                        &item.slug,
                        native,
                        spec.matcher.as_deref(),
                        &command,
                        spec.timeout,
                        folder.as_deref(),
                    )? {
                        materialized.push(Materialized {
                            provider: provider.clone(),
                            path,
                        });
                    }
                } else {
                    let nh = NormalizedHook {
                        event: native,
                        matcher: spec.matcher.as_deref(),
                        command: &command,
                    };
                    if let Some(rec) =
                        hook_merge::materialize_hook_item_at(provider, &nh, folder.as_deref())?
                    {
                        hooks.push(rec);
                    }
                }
            }
        }
    }
    Ok(())
}

/// The Hermes gateway `HOOK.yaml` manifest (generated, not parsed).
fn gateway_manifest(slug: &str, description: Option<&str>, events: &[String]) -> String {
    let mut s = format!("name: {slug}\n");
    if let Some(d) = description.map(str::trim).filter(|d| !d.is_empty()) {
        s.push_str(&format!("description: {d}\n"));
    }
    s.push_str("events:\n");
    for e in events {
        s.push_str(&format!("  - {e}\n"));
    }
    s
}

/// Write a GitHub Copilot standalone hook file (`<slug>.json`). Global ⇒
/// `~/.copilot/hooks/`; folder ⇒ `<folder>/.github/hooks/`. Fleetify owns the
/// file (one per item), so this overwrites and is reversed by deleting it.
fn write_copilot_hook(
    slug: &str,
    event: &str,
    matcher: Option<&str>,
    command: &str,
    timeout: Option<u32>,
    folder: Option<&Path>,
) -> Result<Option<String>> {
    let Some(dir) = providers::copilot_hooks_dir(folder) else {
        return Ok(None);
    };
    std::fs::create_dir_all(&dir)?;
    let mut handler = serde_json::Map::new();
    handler.insert("type".into(), serde_json::json!("command"));
    handler.insert("command".into(), serde_json::json!(command));
    if let Some(m) = matcher.filter(|m| !m.is_empty()) {
        handler.insert("matcher".into(), serde_json::json!(m));
    }
    if let Some(t) = timeout {
        handler.insert("timeoutSec".into(), serde_json::json!(t));
    }
    let doc = serde_json::json!({
        "version": 1,
        "hooks": { event: [serde_json::Value::Object(handler)] }
    });
    let file = dir.join(format!("{slug}.json"));
    std::fs::write(&file, serde_json::to_string_pretty(&doc)?)?;
    Ok(Some(file.to_string_lossy().into_owned()))
}

fn push_paths(out: &mut Vec<Materialized>, provider: &str, paths: Vec<String>) {
    for path in paths {
        out.push(Materialized {
            provider: provider.to_string(),
            path,
        });
    }
}

/// The folder a folder-scoped rule writes into, or `None` for global scope.
fn folder_path(spec: &RuleSpec) -> Option<PathBuf> {
    if spec.scope == RuleScope::Folder {
        spec.folder
            .as_deref()
            .map(str::trim)
            .filter(|f| !f.is_empty())
            .map(PathBuf::from)
    } else {
        None
    }
}

/// Merge a general/markdown (or Copilot-plain) rule block into the provider's
/// rule file — the chosen folder's file for folder scope, else the home file.
fn merge_general_rule(
    provider: &str,
    slug: &str,
    body: &str,
    spec: &RuleSpec,
) -> Result<Option<RuleMergeRecord>> {
    match folder_path(spec) {
        Some(folder) => match rule_merge::project_rule_file(provider, &folder) {
            Some(file) => Ok(Some(rule_merge::write_block(provider, slug, body, &file)?)),
            None => Ok(None),
        },
        None => rule_merge::materialize_rule(provider, slug, body),
    }
}

/// The `.cursor/rules/` directory for a rule's scope — the chosen folder's for
/// folder scope, else the user-home `~/.cursor/rules/`.
fn cursor_rules_dir_for(spec: &RuleSpec) -> Option<PathBuf> {
    match folder_path(spec) {
        Some(folder) => Some(folder.join(".cursor").join("rules")),
        None => providers::cursor_rules_dir(),
    }
}

/// Prepend a non-empty `description` as a leading paragraph to a rule body —
/// used for the plain `copilot-instructions.md` merge, which has no frontmatter
/// slot for it.
fn prepend_description(description: Option<&str>, body: &str) -> String {
    match description.map(str::trim).filter(|d| !d.is_empty()) {
        Some(d) => format!("{d}\n\n{body}"),
        None => body.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::super::store;
    use super::super::types::{
        CursorRuleType, HookMode, HookSpec, LibraryItem, LibraryKind, RuleFormat, RuleScope,
        RuleSpec,
    };
    use super::*;
    use std::path::Path;
    use tempfile::tempdir;

    /// Pin HOME (provider homes) + FLEETIFY_HOME (library store + prompts) to a
    /// fake home, under the shared env lock so we don't race other tests.
    fn with_test_home<R>(home: &Path, f: impl FnOnce() -> R) -> R {
        let _g = crate::test_support::home_lock()
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        // Pin HOME + USERPROFILE (provider_home reads USERPROFILE first) +
        // FLEETIFY_HOME (the library store + prompts) — all to the fake home, so
        // a sibling test that leaked USERPROFILE can't redirect us elsewhere.
        let saved: Vec<(&str, Option<String>)> =
            ["HOME", "USERPROFILE", "FLEETIFY_HOME", "LOCALAPPDATA"]
                .iter()
                .map(|k| (*k, std::env::var(k).ok()))
                .collect();
        std::env::set_var("HOME", home);
        std::env::set_var("USERPROFILE", home);
        std::env::set_var("FLEETIFY_HOME", home.join(".fleetify"));
        // Hermes resolves its home via %LOCALAPPDATA%\hermes on Windows — pin it
        // so the gateway test writes under the fake home, not the real one.
        std::env::set_var("LOCALAPPDATA", home);
        let r = f();
        for (k, v) in saved {
            match v {
                Some(val) => std::env::set_var(k, val),
                None => std::env::remove_var(k),
            }
        }
        r
    }

    fn item(kind: LibraryKind, slug: &str, providers: &[&str]) -> LibraryItem {
        LibraryItem {
            id: format!("id-{slug}"),
            kind,
            name: slug.to_string(),
            slug: slug.to_string(),
            description: None,
            providers: providers.iter().map(|s| s.to_string()).collect(),
            materialized: vec![],
            hook_merge: vec![],
            rule_merge: vec![],
            rule_spec: None,
            hook_spec: None,
            created_at: "t0".into(),
            updated_at: "t0".into(),
        }
    }

    #[test]
    fn skill_item_round_trip_store_and_materialize() {
        let tmp = tempdir().unwrap();
        let home = tmp.path().join("home");
        with_test_home(&home, || {
            // Author a skill targeting claude + kimi.
            let it = item(
                LibraryKind::Skill,
                "my-skill",
                &["claude-code", "kimi-code"],
            );
            let payload = store::item_dir(&it.id).join("skill");
            std::fs::create_dir_all(&payload).unwrap();
            std::fs::write(
                payload.join("SKILL.md"),
                b"---\nname: x\ndescription: d\n---\nbody",
            )
            .unwrap();

            let mut it = it;
            let out = materialize_item(&it, &payload).unwrap();
            it.materialized = out.materialized;
            store::save(&it).unwrap();

            // Materialized into both providers' homes + the shared
            // ~/.agents/skills/ open-standard location.
            assert!(home.join(".claude/skills/my-skill/SKILL.md").is_file());
            assert!(home.join(".kimi/skills/my-skill/SKILL.md").is_file());
            assert!(home.join(".agents/skills/my-skill/SKILL.md").is_file());
            assert_eq!(it.materialized.len(), 3);

            // Store round-trips.
            let listed = store::list(Some(LibraryKind::Skill));
            assert_eq!(listed.len(), 1);
            assert_eq!(store::get(&it.id).unwrap().slug, "my-skill");
            assert!(store::slug_taken(LibraryKind::Skill, "my-skill", None));

            // Delete reverses on-disk + removes the record.
            unmaterialize_item(&it.materialized, &it.hook_merge, &it.rule_merge);
            store::delete_record(&it.id).unwrap();
            assert!(!home.join(".claude/skills/my-skill").exists());
            assert!(!home.join(".kimi/skills/my-skill").exists());
            assert!(!home.join(".agents/skills/my-skill").exists());
            assert!(store::get(&it.id).is_none());
            assert!(store::list(None).is_empty());
        });
    }

    #[test]
    fn prompt_item_is_provider_agnostic() {
        let tmp = tempdir().unwrap();
        let home = tmp.path().join("home");
        with_test_home(&home, || {
            let it = item(LibraryKind::Prompt, "greet", &[]);
            let payload = store::item_dir(&it.id).join("prompt.md");
            std::fs::create_dir_all(payload.parent().unwrap()).unwrap();
            std::fs::write(&payload, b"hello").unwrap();

            let out = materialize_item(&it, &payload).unwrap();
            assert!(home.join(".fleetify/prompts/greet.md").is_file());
            assert_eq!(out.materialized.len(), 1);
            assert_eq!(out.materialized[0].provider, "fleetify");
        });
    }

    #[test]
    fn hook_item_merges_per_provider_and_reverses() {
        let tmp = tempdir().unwrap();
        let home = tmp.path().join("home");
        with_test_home(&home, || {
            let it = item(LibraryKind::Hook, "fmt", &["claude-code", "kimi-code"]);
            let payload = store::item_dir(&it.id).join("hook.json");
            std::fs::create_dir_all(payload.parent().unwrap()).unwrap();
            std::fs::write(
                &payload,
                br#"{"event":"PostToolUse","matcher":"Edit","command":"fmt.sh"}"#,
            )
            .unwrap();

            let out = materialize_item(&it, &payload).unwrap();
            assert_eq!(out.hook_merge.len(), 2, "claude + kimi merged");
            assert!(home.join(".claude/settings.json").is_file());
            assert!(home.join(".kimi/config.toml").is_file());

            unmaterialize_item(&out.materialized, &out.hook_merge, &out.rule_merge);
            let v: serde_json::Value = serde_json::from_str(
                &std::fs::read_to_string(home.join(".claude/settings.json")).unwrap(),
            )
            .unwrap();
            assert!(v["hooks"].get("PostToolUse").is_none(), "hook un-merged");
        });
    }

    #[test]
    fn hook_spec_command_copies_handler_and_substitutes_file() {
        let tmp = tempdir().unwrap();
        let home = tmp.path().join("home");
        with_test_home(&home, || {
            let mut it = item(LibraryKind::Hook, "fmt", &["claude-code"]);
            it.hook_spec = Some(HookSpec {
                mode: HookMode::Command,
                trigger: Some("post_tool_use".into()),
                matcher: Some("Edit".into()),
                command: Some("python3 ${file}".into()),
                handler_file: Some("handler.py".into()),
                ..Default::default()
            });
            let dir = store::item_dir(&it.id);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("handler.py"), b"print('hi')").unwrap();

            let out = materialize_item(&it, &dir).unwrap();
            // Handler copied to ~/.claude/hooks/fmt/handler.py (separate joins
            // so the path is correct on Windows).
            let copied = home
                .join(".claude")
                .join("hooks")
                .join("fmt")
                .join("handler.py");
            assert!(copied.is_file(), "handler copied next to the config");
            assert!(out.materialized.iter().any(|m| m.path.contains("fmt")));
            // settings.json command has ${file} replaced with the absolute path.
            let v: serde_json::Value = serde_json::from_str(
                &std::fs::read_to_string(home.join(".claude").join("settings.json")).unwrap(),
            )
            .unwrap();
            let cmd = v["hooks"]["PostToolUse"][0]["hooks"][0]["command"]
                .as_str()
                .unwrap();
            assert!(cmd.starts_with("python3 "));
            assert!(cmd.contains("handler.py") && !cmd.contains("${file}"));

            unmaterialize_item(&out.materialized, &out.hook_merge, &out.rule_merge);
            assert!(!copied.exists(), "copied handler removed on reverse");
        });
    }

    #[test]
    fn hook_spec_plugin_copies_opencode_ts() {
        let tmp = tempdir().unwrap();
        let home = tmp.path().join("home");
        with_test_home(&home, || {
            let mut it = item(LibraryKind::Hook, "logger", &["opencode"]);
            it.hook_spec = Some(HookSpec {
                mode: HookMode::Plugin,
                handler_file: Some("plugin.ts".into()),
                ..Default::default()
            });
            let dir = store::item_dir(&it.id);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("plugin.ts"), b"export const x = 1;").unwrap();
            let out = materialize_item(&it, &dir).unwrap();
            let plugin = home
                .join(".config")
                .join("opencode")
                .join("plugin")
                .join("logger.ts");
            assert!(plugin.is_file());
            unmaterialize_item(&out.materialized, &out.hook_merge, &out.rule_merge);
            assert!(!plugin.exists());
        });
    }

    #[test]
    fn hook_spec_gateway_writes_hermes_dir() {
        let tmp = tempdir().unwrap();
        let home = tmp.path().join("home");
        with_test_home(&home, || {
            let mut it = item(LibraryKind::Hook, "audit", &["hermes-agent"]);
            it.description = Some("Logs activity".into());
            it.hook_spec = Some(HookSpec {
                mode: HookMode::Gateway,
                events: vec!["agent:start".into(), "agent:end".into()],
                handler_file: Some("handler.py".into()),
                ..Default::default()
            });
            let dir = store::item_dir(&it.id);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("handler.py"), b"async def handle(*a): pass").unwrap();
            let out = materialize_item(&it, &dir).unwrap();
            // Compute the dir via the same resolver the impl uses (Hermes home is
            // %LOCALAPPDATA%\hermes on Windows, ~/.hermes elsewhere).
            let hdir = crate::services::plugins::providers::provider_home("hermes-agent")
                .unwrap()
                .join("hooks")
                .join("audit");
            let yaml = std::fs::read_to_string(hdir.join("HOOK.yaml")).unwrap();
            assert!(yaml.contains("name: audit"));
            assert!(yaml.contains("- agent:start"));
            assert!(hdir.join("handler.py").is_file());
            unmaterialize_item(&out.materialized, &out.hook_merge, &out.rule_merge);
            assert!(!hdir.exists());
        });
    }

    #[test]
    fn subagent_item_materializes_per_provider_md_and_codex_toml() {
        let tmp = tempdir().unwrap();
        let home = tmp.path().join("home");
        with_test_home(&home, || {
            let mut it = item(
                LibraryKind::Subagent,
                "reviewer",
                &["claude-code", "codex-cli"],
            );
            it.description = Some("Reviews diffs for bugs".into());
            let payload = store::item_dir(&it.id).join("subagent.md");
            std::fs::create_dir_all(payload.parent().unwrap()).unwrap();
            std::fs::write(&payload, b"---\nname: x\n---\nYou are a code reviewer.").unwrap();

            let out = materialize_item(&it, &payload).unwrap();
            // Claude → agents/<slug>.md ; Codex → agents/<slug>.toml
            let claude_md = home.join(".claude/agents/reviewer.md");
            assert!(claude_md.is_file());
            let md = std::fs::read_to_string(&claude_md).unwrap();
            assert!(md.contains("name: reviewer"));
            assert!(md.contains("description: Reviews diffs for bugs"));

            let codex_toml = home.join(".codex/agents/reviewer.toml");
            assert!(codex_toml.is_file(), "codex agent must be .toml");
            let t: toml::Value =
                toml::from_str(&std::fs::read_to_string(&codex_toml).unwrap()).unwrap();
            assert_eq!(t.get("name").and_then(|v| v.as_str()), Some("reviewer"));
            assert!(t.get("developer_instructions").is_some());

            unmaterialize_item(&out.materialized, &out.hook_merge, &out.rule_merge);
            assert!(!claude_md.exists());
            assert!(!codex_toml.exists());
        });
    }

    /// Author a Rule item, write its `rule.md` payload, return (item, payload).
    fn rule(slug: &str, providers: &[&str], body: &str, spec: RuleSpec) -> (LibraryItem, PathBuf) {
        let mut it = item(LibraryKind::Rule, slug, providers);
        it.rule_spec = Some(spec);
        let payload = store::item_dir(&it.id).join("rule.md");
        std::fs::create_dir_all(payload.parent().unwrap()).unwrap();
        std::fs::write(&payload, body).unwrap();
        (it, payload)
    }

    #[test]
    fn general_rule_global_merges_home_file_and_strips() {
        let tmp = tempdir().unwrap();
        let home = tmp.path().join("home");
        with_test_home(&home, || {
            let (it, payload) = rule(
                "no-emoji",
                &["claude-code"],
                "Never use emoji.",
                RuleSpec::default(), // general + global
            );
            let out = materialize_item(&it, &payload).unwrap();
            assert_eq!(out.rule_merge.len(), 1);
            let claude_md = home.join(".claude/CLAUDE.md");
            assert!(std::fs::read_to_string(&claude_md)
                .unwrap()
                .contains("Never use emoji."));

            unmaterialize_item(&out.materialized, &out.hook_merge, &out.rule_merge);
            assert!(!std::fs::read_to_string(&claude_md)
                .unwrap()
                .contains("Never use emoji."));
        });
    }

    #[test]
    fn general_rule_folder_merges_project_file() {
        let tmp = tempdir().unwrap();
        let home = tmp.path().join("home");
        let proj = tmp.path().join("proj");
        std::fs::create_dir_all(&proj).unwrap();
        with_test_home(&home, || {
            let (it, payload) = rule(
                "tabs",
                &["codex-cli"],
                "Prefer tabs.",
                RuleSpec {
                    format: RuleFormat::General,
                    scope: RuleScope::Folder,
                    folder: Some(proj.to_string_lossy().into_owned()),
                    ..Default::default()
                },
            );
            let out = materialize_item(&it, &payload).unwrap();
            // Folder scope → <folder>/AGENTS.md (codex), NOT the home file.
            let agents = proj.join("AGENTS.md");
            assert!(std::fs::read_to_string(&agents)
                .unwrap()
                .contains("Prefer tabs."));
            assert!(!home.join(".codex/AGENTS.md").exists());

            unmaterialize_item(&out.materialized, &out.hook_merge, &out.rule_merge);
            assert!(!std::fs::read_to_string(&agents)
                .unwrap()
                .contains("Prefer tabs."));
        });
    }

    #[test]
    fn cursor_rule_frontmatter_per_type() {
        let tmp = tempdir().unwrap();
        let home = tmp.path().join("home");
        let proj = tmp.path().join("proj");
        std::fs::create_dir_all(&proj).unwrap();
        let folder = proj.to_string_lossy().into_owned();
        let cases = [
            // Always now also carries a description (written for every type).
            (
                CursorRuleType::Always,
                Some("Always-on coding standards"),
                None,
                "alwaysApply: true",
            ),
            (
                CursorRuleType::Intelligent,
                Some("Backend RPC conventions"),
                None,
                "description: Backend RPC conventions",
            ),
            (
                CursorRuleType::Specific,
                None,
                Some("src/**/*.ts"),
                "globs: src/**/*.ts",
            ),
            (CursorRuleType::Manual, None, None, "alwaysApply: false"),
        ];
        with_test_home(&home, || {
            for (i, (rt, desc, globs, expect)) in cases.iter().enumerate() {
                let slug = format!("cursor-rule-{i}");
                let mut it = item(LibraryKind::Rule, &slug, &["cursor-cli"]);
                it.description = desc.map(str::to_string);
                it.rule_spec = Some(RuleSpec {
                    format: RuleFormat::Cursor,
                    scope: RuleScope::Folder,
                    folder: Some(folder.clone()),
                    cursor_rule_type: Some(*rt),
                    globs: globs.map(str::to_string),
                });
                let payload = store::item_dir(&it.id).join("rule.md");
                std::fs::create_dir_all(payload.parent().unwrap()).unwrap();
                std::fs::write(&payload, b"The rule body.").unwrap();

                let out = materialize_item(&it, &payload).unwrap();
                let mdc = proj.join(".cursor/rules").join(format!("{slug}.mdc"));
                let txt = std::fs::read_to_string(&mdc).unwrap();
                assert!(
                    txt.contains(expect),
                    "{slug}: expected `{expect}` in\n{txt}"
                );
                assert!(txt.contains("The rule body."));
                // Description is written for EVERY rule type when provided.
                if let Some(d) = desc {
                    assert!(
                        txt.contains(&format!("description: {d}")),
                        "{slug}: description should be written for {rt:?}\n{txt}"
                    );
                }
                // Manual/Specific/Intelligent never emit alwaysApply: true.
                if !matches!(rt, CursorRuleType::Always) {
                    assert!(!txt.contains("alwaysApply: true"));
                }
                unmaterialize_item(&out.materialized, &out.hook_merge, &out.rule_merge);
                assert!(!mdc.exists());
            }
        });
    }

    #[test]
    fn copilot_rule_applyto_path_file_vs_plain() {
        let tmp = tempdir().unwrap();
        let home = tmp.path().join("home");
        let proj = tmp.path().join("proj");
        std::fs::create_dir_all(&proj).unwrap();
        let folder = proj.to_string_lossy().into_owned();
        with_test_home(&home, || {
            // With globs (folder) → .github/instructions/<slug>.instructions.md
            // (applyTo + description frontmatter).
            let (mut it, payload) = rule(
                "ts-rule",
                &["github-copilot"],
                "Use strict types.",
                RuleSpec {
                    format: RuleFormat::Copilot,
                    scope: RuleScope::Folder,
                    folder: Some(folder.clone()),
                    globs: Some("**/*.ts,**/*.tsx".into()),
                    ..Default::default()
                },
            );
            it.description = Some("Strict TS conventions".into());
            let out = materialize_item(&it, &payload).unwrap();
            let inst = proj.join(".github/instructions/ts-rule.instructions.md");
            let txt = std::fs::read_to_string(&inst).unwrap();
            assert!(txt.contains("applyTo: \"**/*.ts,**/*.tsx\""));
            assert!(txt.contains("description: Strict TS conventions"));
            assert!(txt.contains("Use strict types."));
            unmaterialize_item(&out.materialized, &out.hook_merge, &out.rule_merge);
            assert!(!inst.exists());

            // No globs (folder) → plain merged block in .github/copilot-instructions.md;
            // the description is prepended (no frontmatter slot on that file).
            let (mut it2, payload2) = rule(
                "plain-rule",
                &["github-copilot"],
                "Be concise.",
                RuleSpec {
                    format: RuleFormat::Copilot,
                    scope: RuleScope::Folder,
                    folder: Some(folder.clone()),
                    ..Default::default()
                },
            );
            it2.description = Some("House style".into());
            let out2 = materialize_item(&it2, &payload2).unwrap();
            assert_eq!(out2.rule_merge.len(), 1);
            let plain = proj.join(".github/copilot-instructions.md");
            let plain_txt = std::fs::read_to_string(&plain).unwrap();
            assert!(plain_txt.contains("House style"));
            assert!(plain_txt.contains("Be concise."));
        });
    }
}
