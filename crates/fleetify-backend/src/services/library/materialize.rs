//! Orchestrate materialization of a library item to its target providers,
//! reusing the per-component writers in `services::plugins::materializers`.
//! Returns the `Materialized` records (paths written) to persist on the item;
//! deletion reverses them.

use std::path::Path;

use anyhow::Result;
use serde::Deserialize;

use super::types::{LibraryItem, LibraryKind, Materialized};
use crate::services::plugins::hook_merge::{self, HookMergeRecord, NormalizedHook};
use crate::services::plugins::materializers;
use crate::services::plugins::rule_merge::{self, RuleMergeRecord};

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
            // Cursor gets a standalone `.mdc` file; every other provider gets a
            // marked block merged into its user-global rule file (reversible).
            let desc = item.description.as_deref();
            let body = std::fs::read_to_string(payload)?;
            for provider in &item.providers {
                if provider == "cursor" {
                    let r = materializers::materialize_rule_cursor(payload, &item.slug, desc)?;
                    push_paths(&mut materialized, &r.provider, r.paths);
                } else if let Some(rec) = rule_merge::materialize_rule(provider, &item.slug, &body)?
                {
                    rules.push(rec);
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

#[cfg(test)]
mod tests {
    use super::super::store;
    use super::super::types::{LibraryItem, LibraryKind};
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

    #[test]
    fn rule_item_merges_global_file_and_writes_cursor_mdc() {
        let tmp = tempdir().unwrap();
        let home = tmp.path().join("home");
        with_test_home(&home, || {
            let mut it = item(LibraryKind::Rule, "no-emoji", &["claude-code", "cursor"]);
            it.description = Some("Never use emoji".into());
            let payload = store::item_dir(&it.id).join("rule.md");
            std::fs::create_dir_all(payload.parent().unwrap()).unwrap();
            std::fs::write(&payload, b"Never use emoji in code or commits.").unwrap();

            let out = materialize_item(&it, &payload).unwrap();
            // Claude → marked block merged into ~/.claude/CLAUDE.md (rule_merge)
            assert_eq!(out.rule_merge.len(), 1);
            let claude_md = home.join(".claude/CLAUDE.md");
            assert!(claude_md.is_file());
            assert!(std::fs::read_to_string(&claude_md)
                .unwrap()
                .contains("Never use emoji"));
            // Cursor → standalone .mdc (materialized path)
            let mdc = home.join(".cursor/rules/no-emoji.mdc");
            assert!(mdc.is_file());
            let mdc_txt = std::fs::read_to_string(&mdc).unwrap();
            assert!(mdc_txt.contains("alwaysApply: true"));
            assert!(mdc_txt.contains("Never use emoji"));

            unmaterialize_item(&out.materialized, &out.hook_merge, &out.rule_merge);
            assert!(!mdc.exists());
            assert!(!std::fs::read_to_string(&claude_md)
                .unwrap()
                .contains("Never use emoji"));
        });
    }
}
