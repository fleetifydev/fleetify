//! Orchestrate materialization of a library item to its target providers,
//! reusing the per-component writers in `services::plugins::materializers`.
//! Returns the `Materialized` records (paths written) to persist on the item;
//! deletion reverses them.

use std::path::{Path, PathBuf};

use anyhow::Result;
use serde::Deserialize;

use super::types::{LibraryItem, LibraryKind, Materialized, RuleFormat, RuleScope, RuleSpec};
use crate::services::plugins::hook_merge::{self, HookMergeRecord, NormalizedHook};
use crate::services::plugins::rule_merge::{self, RuleMergeRecord};
use crate::services::plugins::{materializers, providers};

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

/// A hook authored in the form: `{ "event": "...", "matcher": "...", "command": "..." }`.
#[derive(Deserialize)]
struct HookSpec {
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
        LibraryKind::Hook => {
            let spec: HookSpec = serde_json::from_str(&std::fs::read_to_string(payload)?)?;
            for provider in &item.providers {
                let nh = NormalizedHook {
                    event: &spec.event,
                    matcher: spec.matcher.as_deref(),
                    command: &spec.command,
                };
                if let Some(rec) = hook_merge::materialize_hook_item(provider, &nh)? {
                    hooks.push(rec);
                }
            }
        }
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
        CursorRuleType, LibraryItem, LibraryKind, RuleFormat, RuleScope, RuleSpec,
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
            let it = item(LibraryKind::Skill, "my-skill", &["claude-code", "kimi"]);
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
            let it = item(LibraryKind::Hook, "fmt", &["claude-code", "kimi"]);
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
    fn subagent_item_materializes_per_provider_md_and_codex_toml() {
        let tmp = tempdir().unwrap();
        let home = tmp.path().join("home");
        with_test_home(&home, || {
            let mut it = item(LibraryKind::Subagent, "reviewer", &["claude-code", "codex"]);
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
                &["codex"],
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
                let mut it = item(LibraryKind::Rule, &slug, &["cursor"]);
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
