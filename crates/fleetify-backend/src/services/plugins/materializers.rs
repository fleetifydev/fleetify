//! Plugin materializers — write a plugin's per-provider components into
//! each target agent's config home so live sessions discover them.
//!
//! Covers **skills** (universal Agent-Skills format), **commands/prompts**
//! (Claude/Gemini/OpenCode commands, Codex prompts), and **sub-agents**
//! (Claude/OpenCode/agy `.md`, GitHub Copilot `.agent.md`). MCP servers are
//! handled separately by `mcp_materialize` (one shared registry, fanned out
//! per-bridge at spawn). Hooks land in the `hooks` settings merger.
//!
//! Two correctness rules this module enforces:
//!  1. **Namespaced, regex-valid ids.** Artifacts are named `<plugin>-<name>`
//!     (single hyphen, lowercase) — OpenCode/Cursor reject the legacy
//!     `plugin__name` (underscores) AND require the SKILL.md frontmatter
//!     `name` to equal the directory name, so we rewrite the frontmatter.
//!  2. **Fan-out from a canonical dir.** A plugin need not ship an identical
//!     `.{provider}/skills/` for all nine agents; if a provider's own dir is
//!     absent we materialize from the first dir the plugin DID ship (skills
//!     are byte-identical across agents).

use std::path::{Path, PathBuf};

use anyhow::Result;
use serde::{Deserialize, Serialize};

use super::providers::{self, COMPONENT_PROVIDERS};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct MaterializationResult {
    pub provider: String,
    pub paths: Vec<String>,
    #[serde(default)]
    pub skipped: Vec<String>,
}

/// Materialize the installed plugin for one provider. Reads the plugin's
/// `.{provider}/{skills,commands,agents}/` (with a canonical fan-out
/// fallback) and writes namespaced copies into the provider's config home.
/// Returns every path written so uninstall can reverse it.
pub fn materialize(
    plugin_name: &str,
    install_path: &Path,
    provider: &str,
) -> Result<MaterializationResult> {
    let mut r = MaterializationResult {
        provider: provider.to_string(),
        ..Default::default()
    };

    // ── Skills ── (universal; fan-out from any provider dir the plugin ships)
    if let Some(dst_root) = providers::skills_dir(provider) {
        if let Some(src) = component_source(install_path, provider, "skills") {
            materialize_skills(plugin_name, &src, &dst_root, &mut r)?;
        }
    }

    // ── Commands / prompts ── (only providers with a command surface)
    if let Some(dst) = providers::commands_dir(provider) {
        // Codex stores prompts; everyone else commands. Source is the
        // provider's own dir, else the canonical `.claude/commands`.
        let plugin_sub = if provider == "codex" {
            "prompts"
        } else {
            "commands"
        };
        let src = dir_if_exists(&install_path.join(format!(".{provider}")).join(plugin_sub))
            .or_else(|| dir_if_exists(&install_path.join(".claude").join("commands")));
        if let Some(src) = src {
            materialize_flat(plugin_name, &src, &dst, "md", &mut r)?;
        }
    }

    // ── Sub-agents ── (markdown agent file per agent)
    if let Some((dst, ext)) = providers::agents_dir(provider) {
        if let Some(src) = component_source(install_path, provider, "agents") {
            materialize_flat(plugin_name, &src, &dst, ext, &mut r)?;
        }
    }

    // ── Hooks ── (copy strategies only). The plugin ships provider-native
    // hook files under `.{provider}/hooks/`; we copy them into the agent's
    // standalone hook surface. Hooks are NOT fan-out (each agent's format
    // differs), so we read only the provider's own dir. Merge strategies
    // (Claude settings.json, Kimi config.toml, Cursor/agy hooks.json) write
    // into a user's live config and are the documented next step — see
    // `docs/MARKETPLACE.md`; no marketplace plugin ships hooks yet.
    let hooks_src = install_path.join(format!(".{provider}")).join("hooks");
    if hooks_src.is_dir() {
        if let Some(home) = providers::provider_home(provider) {
            match providers::hook_strategy(provider) {
                providers::HookStrategy::CopyJsonFile => {
                    copy_ext_files(plugin_name, &hooks_src, &home.join("hooks"), "json", &mut r)?;
                }
                providers::HookStrategy::CopyTsPlugin => {
                    copy_ext_files(plugin_name, &hooks_src, &home.join("plugins"), "ts", &mut r)?;
                }
                providers::HookStrategy::CopyDir => {
                    copy_named_subdirs(plugin_name, &hooks_src, &home.join("hooks"), &mut r)?;
                }
                providers::HookStrategy::MergeJson { .. }
                | providers::HookStrategy::MergeToml { .. }
                | providers::HookStrategy::Unsupported => {}
            }
        }
    }

    Ok(r)
}

/// Reverse a materialization by deleting every path it recorded.
pub fn unmaterialize(result: &MaterializationResult) -> Result<()> {
    for raw in &result.paths {
        let p = Path::new(raw);
        if p.is_dir() {
            let _ = std::fs::remove_dir_all(p);
        } else if p.is_file() {
            let _ = std::fs::remove_file(p);
        }
    }
    Ok(())
}

// ── component resolution ──────────────────────────────────────────────────

fn dir_if_exists(p: &Path) -> Option<PathBuf> {
    if p.is_dir() {
        Some(p.to_path_buf())
    } else {
        None
    }
}

/// The source dir for `subdir` (e.g. "skills") for `provider`: the provider's
/// own `.{provider}/{subdir}` if present, else the first existing
/// `.{p}/{subdir}` across the known providers (canonical fan-out). Lets a
/// plugin ship one `.claude/skills/…` and reach every agent.
fn component_source(install_path: &Path, provider: &str, subdir: &str) -> Option<PathBuf> {
    let own = install_path.join(format!(".{provider}")).join(subdir);
    if own.is_dir() {
        return Some(own);
    }
    COMPONENT_PROVIDERS
        .iter()
        .map(|p| install_path.join(format!(".{p}")).join(subdir))
        .find(|p| p.is_dir())
}

// ── skills ────────────────────────────────────────────────────────────────

fn materialize_skills(
    plugin: &str,
    src_root: &Path,
    dst_root: &Path,
    r: &mut MaterializationResult,
) -> Result<()> {
    std::fs::create_dir_all(dst_root)?;
    for ent in std::fs::read_dir(src_root)? {
        let ent = ent?;
        if !ent.file_type()?.is_dir() {
            continue;
        }
        let src = ent.path();
        // A skill MUST carry a SKILL.md; skip-and-record otherwise so one
        // malformed skill doesn't abort the whole materialization.
        if !src.join("SKILL.md").is_file() {
            r.skipped.push(src.to_string_lossy().into_owned());
            continue;
        }
        let skill = ent.file_name().to_string_lossy().to_string();
        let id = providers::namespaced_id(plugin, &skill);
        let target = dst_root.join(&id);
        copy_dir_recursive(&src, &target)?;
        // Rewrite SKILL.md `name` to equal the dir id — OpenCode/Cursor
        // require name == directory and forbid underscores.
        let _ = rewrite_skill_name(&target.join("SKILL.md"), &id);
        r.paths.push(target.to_string_lossy().into_owned());
    }
    Ok(())
}

/// Set (or insert) the YAML frontmatter `name:` of a SKILL.md to `new_name`,
/// preserving the rest. Handles: existing `name` line (replace, keep
/// indent), frontmatter without `name` (insert), and no frontmatter at all
/// (prepend a minimal block).
fn set_frontmatter_name(content: &str, new_name: &str) -> String {
    let name_line = format!("name: {new_name}");
    let lines: Vec<&str> = content.lines().collect();
    let has_fm = lines.first().map(|l| l.trim()) == Some("---");
    let close = if has_fm {
        lines
            .iter()
            .enumerate()
            .skip(1)
            .find(|(_, l)| l.trim() == "---")
            .map(|(i, _)| i)
    } else {
        None
    };
    let Some(close) = close else {
        return format!("---\n{name_line}\n---\n\n{content}");
    };
    let mut out: Vec<String> = Vec::with_capacity(lines.len() + 1);
    let mut replaced = false;
    for (i, l) in lines.iter().enumerate() {
        if i >= 1 && i < close && !replaced && l.trim_start().starts_with("name:") {
            let indent = &l[..l.len() - l.trim_start().len()];
            out.push(format!("{indent}{name_line}"));
            replaced = true;
        } else {
            out.push((*l).to_string());
        }
    }
    if !replaced {
        out.insert(1, name_line);
    }
    let mut s = out.join("\n");
    if content.ends_with('\n') {
        s.push('\n');
    }
    s
}

fn rewrite_skill_name(skill_md: &Path, new_name: &str) -> std::io::Result<()> {
    let content = std::fs::read_to_string(skill_md)?;
    std::fs::write(skill_md, set_frontmatter_name(&content, new_name))
}

// ── flat markdown (commands / prompts / agents) ────────────────────────────

/// Copy every `*.md` in `src` to `<dst>/<plugin>-<stem>.<ext>` (flattened,
/// namespaced). `ext` is "md" for commands/prompts/most agents, "agent.md"
/// for GitHub Copilot agents.
fn materialize_flat(
    plugin: &str,
    src: &Path,
    dst: &Path,
    ext: &str,
    r: &mut MaterializationResult,
) -> Result<()> {
    std::fs::create_dir_all(dst)?;
    for ent in std::fs::read_dir(src)? {
        let ent = ent?;
        let from = ent.path();
        if !from.is_file() {
            continue;
        }
        if from.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let stem = from
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        if stem.is_empty() {
            continue;
        }
        let id = providers::namespaced_id(plugin, &stem);
        let target = dst.join(format!("{id}.{ext}"));
        std::fs::copy(&from, &target)?;
        r.paths.push(target.to_string_lossy().into_owned());
    }
    Ok(())
}

/// Copy every `*.<ext>` in `src` to `<dst>/<plugin>-<stem>.<ext>` (used for
/// standalone hook files: Copilot `.json`, OpenCode `.ts`).
fn copy_ext_files(
    plugin: &str,
    src: &Path,
    dst: &Path,
    ext: &str,
    r: &mut MaterializationResult,
) -> Result<()> {
    std::fs::create_dir_all(dst)?;
    for ent in std::fs::read_dir(src)? {
        let ent = ent?;
        let from = ent.path();
        if !from.is_file() || from.extension().and_then(|e| e.to_str()) != Some(ext) {
            continue;
        }
        let Some(stem) = from.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        let id = providers::namespaced_id(plugin, stem);
        let target = dst.join(format!("{id}.{ext}"));
        std::fs::copy(&from, &target)?;
        r.paths.push(target.to_string_lossy().into_owned());
    }
    Ok(())
}

/// Copy every subdirectory of `src` to `<dst>/<plugin>-<name>/` (used for
/// Hermes hooks, each a `<name>/HOOK.yaml` + `handler.py` dir).
fn copy_named_subdirs(
    plugin: &str,
    src: &Path,
    dst: &Path,
    r: &mut MaterializationResult,
) -> Result<()> {
    std::fs::create_dir_all(dst)?;
    for ent in std::fs::read_dir(src)? {
        let ent = ent?;
        if !ent.file_type()?.is_dir() {
            continue;
        }
        let name = ent.file_name().to_string_lossy().to_string();
        let id = providers::namespaced_id(plugin, &name);
        let target = dst.join(&id);
        copy_dir_recursive(&ent.path(), &target)?;
        r.paths.push(target.to_string_lossy().into_owned());
    }
    Ok(())
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
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

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn with_home<R>(home: &Path, f: impl FnOnce() -> R) -> R {
        let _g = crate::test_support::home_lock()
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let key = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
        let prev = std::env::var(key).ok();
        std::env::set_var(key, home);
        // Hermes resolves its home from %LOCALAPPDATA% on Windows; pin it to
        // the fake home too so the test controls every provider's home dir.
        let prev_local = std::env::var("LOCALAPPDATA").ok();
        std::env::set_var("LOCALAPPDATA", home);
        let r = f();
        match prev_local {
            Some(v) => std::env::set_var("LOCALAPPDATA", v),
            None => std::env::remove_var("LOCALAPPDATA"),
        }
        match prev {
            Some(v) => std::env::set_var(key, v),
            None => std::env::remove_var(key),
        }
        r
    }

    #[test]
    fn set_frontmatter_name_handles_all_three_shapes() {
        // No frontmatter → prepend.
        let a = set_frontmatter_name("# Title\nbody", "p-foo");
        assert!(a.starts_with("---\nname: p-foo\n---\n"));
        // Frontmatter with a name → replace.
        let b = set_frontmatter_name("---\nname: foo\ndescription: d\n---\nbody", "p-foo");
        assert!(b.contains("name: p-foo"));
        assert!(!b.contains("name: foo\n"));
        assert!(b.contains("description: d"));
        // Frontmatter without a name → insert.
        let c = set_frontmatter_name("---\ndescription: d\n---\nbody", "p-foo");
        assert!(c.contains("name: p-foo"));
        assert!(c.contains("description: d"));
    }

    #[test]
    fn materialize_claude_skills_namespaces_and_rewrites_name() {
        let tmp = tempdir().unwrap();
        let install = tmp.path().join("install/my-plugin");
        let claude = install.join(".claude");
        std::fs::create_dir_all(claude.join("skills/cool-skill")).unwrap();
        std::fs::write(
            claude.join("skills/cool-skill/SKILL.md"),
            b"---\nname: cool-skill\ndescription: d\n---\n# cool",
        )
        .unwrap();
        std::fs::write(claude.join("skills/cool-skill/asset.txt"), b"x").unwrap();
        std::fs::create_dir_all(claude.join("commands")).unwrap();
        std::fs::write(claude.join("commands/run.md"), b"## /run").unwrap();
        // Bad skill: no SKILL.md → skipped.
        std::fs::create_dir_all(claude.join("skills/no-skill-md")).unwrap();
        std::fs::write(claude.join("skills/no-skill-md/README.md"), b"x").unwrap();

        let home = tmp.path().join("home");
        with_home(&home, || {
            let r = materialize("my-plugin", &install, "claude").unwrap();
            // Hyphen-namespaced (NOT my-plugin__cool-skill).
            let dst = home.join(".claude/skills/my-plugin-cool-skill");
            assert!(dst.is_dir());
            assert!(dst.join("asset.txt").is_file());
            // Frontmatter name rewritten to equal the dir id.
            let md = std::fs::read_to_string(dst.join("SKILL.md")).unwrap();
            assert!(md.contains("name: my-plugin-cool-skill"));
            assert!(md.contains("description: d"));
            // Command flattened + namespaced.
            assert!(home.join(".claude/commands/my-plugin-run.md").is_file());
            assert_eq!(r.skipped.len(), 1);
        });
    }

    #[test]
    fn skills_fan_out_to_provider_without_its_own_dir() {
        // Plugin ships ONLY .claude/skills — must still reach kimi + opencode.
        let tmp = tempdir().unwrap();
        let install = tmp.path().join("install/p");
        std::fs::create_dir_all(install.join(".claude/skills/s")).unwrap();
        std::fs::write(
            install.join(".claude/skills/s/SKILL.md"),
            b"---\nname: s\ndescription: d\n---\nbody",
        )
        .unwrap();

        let home = tmp.path().join("home");
        with_home(&home, || {
            materialize("p", &install, "kimi").unwrap();
            materialize("p", &install, "opencode").unwrap();
            assert!(home.join(".kimi/skills/p-s/SKILL.md").is_file());
            // OpenCode uses XDG ~/.config/opencode, not ~/.opencode.
            assert!(home.join(".config/opencode/skills/p-s/SKILL.md").is_file());
        });
    }

    #[test]
    fn codex_gets_prompts_copilot_gets_agent_md() {
        let tmp = tempdir().unwrap();
        let install = tmp.path().join("install/p");
        std::fs::create_dir_all(install.join(".codex/prompts")).unwrap();
        std::fs::write(install.join(".codex/prompts/audit.md"), b"# audit").unwrap();
        std::fs::create_dir_all(install.join(".github-copilot/agents")).unwrap();
        std::fs::write(
            install.join(".github-copilot/agents/rev.md"),
            b"---\ndescription: d\n---\nbody",
        )
        .unwrap();

        let home = tmp.path().join("home");
        with_home(&home, || {
            materialize("p", &install, "codex").unwrap();
            materialize("p", &install, "github-copilot").unwrap();
            assert!(home.join(".codex/prompts/p-audit.md").is_file());
            // Copilot's distinctive .agent.md extension.
            assert!(home.join(".copilot/agents/p-rev.agent.md").is_file());
        });
    }

    #[test]
    fn unmaterialize_removes_recorded_paths() {
        let tmp = tempdir().unwrap();
        let install = tmp.path().join("install/q");
        std::fs::create_dir_all(install.join(".gemini/commands")).unwrap();
        std::fs::write(install.join(".gemini/commands/x.md"), b"# x").unwrap();
        let home = tmp.path().join("home");
        with_home(&home, || {
            let r = materialize("q", &install, "gemini").unwrap();
            let written = home.join(".gemini/commands/q-x.md");
            assert!(written.is_file());
            unmaterialize(&r).unwrap();
            assert!(!written.exists());
        });
    }

    #[test]
    fn copy_hooks_for_copilot_opencode_hermes() {
        let tmp = tempdir().unwrap();
        let install = tmp.path().join("install/p");
        std::fs::create_dir_all(install.join(".github-copilot/hooks")).unwrap();
        std::fs::write(install.join(".github-copilot/hooks/log.json"), b"{}").unwrap();
        std::fs::create_dir_all(install.join(".opencode/hooks")).unwrap();
        std::fs::write(
            install.join(".opencode/hooks/guard.ts"),
            b"export const x = {}",
        )
        .unwrap();
        std::fs::create_dir_all(install.join(".hermes/hooks/audit")).unwrap();
        std::fs::write(
            install.join(".hermes/hooks/audit/HOOK.yaml"),
            b"name: audit",
        )
        .unwrap();

        let home = tmp.path().join("home");
        with_home(&home, || {
            materialize("p", &install, "github-copilot").unwrap();
            materialize("p", &install, "opencode").unwrap();
            materialize("p", &install, "hermes").unwrap();
            // Copilot → standalone json; OpenCode → plugins/*.ts; Hermes → dir.
            assert!(home.join(".copilot/hooks/p-log.json").is_file());
            assert!(home.join(".config/opencode/plugins/p-guard.ts").is_file());
            // Hermes home is OS-specific (%LOCALAPPDATA%\hermes on Windows) —
            // resolve it through the registry rather than hard-coding `.hermes`.
            let hermes = providers::provider_home("hermes").unwrap();
            assert!(hermes.join("hooks/p-audit/HOOK.yaml").is_file());
        });
    }
}
