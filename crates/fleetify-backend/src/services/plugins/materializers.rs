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
use crate::services::library::types::CursorRuleType;

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
        let plugin_sub = if provider == "codex-cli" {
            "prompts"
        } else {
            "commands"
        };
        let vendor = providers::component_basename(provider);
        let src = dir_if_exists(&install_path.join(format!(".{vendor}")).join(plugin_sub))
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
    let hooks_src = install_path
        .join(format!(".{}", providers::component_basename(provider)))
        .join("hooks");
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

// ── library-authored single items ──────────────────────────────────────────
// Unlike plugin materialization, the bare `slug` IS the on-disk id (no
// `<plugin>-` namespacing) and the payload path is passed explicitly — the
// store layout is the library service's concern, not this module's. Cleanup
// reuses `unmaterialize` (deletes every recorded path).

/// Materialize a single library-authored prompt. Fleetify-native prompts are
/// provider-agnostic: one shared `~/.fleetify/prompts/<slug>.md` available to
/// every agent. `payload_md` is the authored prompt body file.
pub fn materialize_prompt_item(payload_md: &Path, slug: &str) -> Result<MaterializationResult> {
    let mut r = MaterializationResult {
        provider: "fleetify".to_string(),
        ..Default::default()
    };
    let dst_dir = fleetify_core::fleetify_home().join("prompts");
    std::fs::create_dir_all(&dst_dir)?;
    let target = dst_dir.join(format!("{slug}.md"));
    std::fs::copy(payload_md, &target)?;
    r.paths.push(target.to_string_lossy().into_owned());
    Ok(r)
}

/// Materialize a single library-authored skill into `provider`'s skills dir
/// as `<home>/skills/<slug>/`. `payload_dir` IS the skill directory (contains
/// `SKILL.md` + any assets). Returns `Ok` with no path written if the provider
/// has no skills home (never happens for the 9 component providers).
pub fn materialize_skill_item(
    payload_dir: &Path,
    slug: &str,
    provider: &str,
    description: Option<&str>,
) -> Result<MaterializationResult> {
    let mut r = MaterializationResult {
        provider: provider.to_string(),
        ..Default::default()
    };
    let Some(skills_root) = providers::skills_dir(provider) else {
        return Ok(r);
    };
    let target = skills_root.join(slug);
    copy_dir_recursive(payload_dir, &target)?;
    let _ = rewrite_skill_frontmatter(&target.join("SKILL.md"), slug, description);
    r.paths.push(target.to_string_lossy().into_owned());
    Ok(r)
}

/// Write a library-authored skill to the shared `~/.agents/skills/<slug>/`
/// open-standard location read by Codex, Gemini, Copilot, Cursor and Kimi, so
/// the skill is discoverable cross-tool regardless of which providers were
/// selected. Recorded under the synthetic provider id `"agents"` so deletion
/// reverses it like any other artifact.
pub fn materialize_skill_shared(
    payload_dir: &Path,
    slug: &str,
    description: Option<&str>,
) -> Result<MaterializationResult> {
    let mut r = MaterializationResult {
        provider: "agents".to_string(),
        ..Default::default()
    };
    let Some(root) = providers::agents_skills_dir() else {
        return Ok(r);
    };
    let target = root.join(slug);
    copy_dir_recursive(payload_dir, &target)?;
    let _ = rewrite_skill_frontmatter(&target.join("SKILL.md"), slug, description);
    r.paths.push(target.to_string_lossy().into_owned());
    Ok(r)
}

/// Materialize a library-authored **subagent** into `provider`'s `agents/` dir
/// as `<slug>.<ext>`. `payload_md` is the authored agent file (YAML frontmatter
/// plus a system-prompt body). The `.md`/`.agent.md` providers get the file with
/// `name`=slug + `description` ensured (same helper as skills); **Codex** gets a
/// standalone `.toml` (`name`/`description`/`developer_instructions`). Providers
/// without an agents dir (Kimi/Hermes) are a no-op.
pub fn materialize_subagent_item(
    payload_md: &Path,
    slug: &str,
    provider: &str,
    description: Option<&str>,
) -> Result<MaterializationResult> {
    let mut r = MaterializationResult {
        provider: provider.to_string(),
        ..Default::default()
    };
    if provider == "codex-cli" {
        let Some(home) = providers::provider_home("codex-cli") else {
            return Ok(r);
        };
        let dir = home.join("agents");
        std::fs::create_dir_all(&dir)?;
        let target = dir.join(format!("{slug}.toml"));
        write_codex_agent(payload_md, slug, description, &target)?;
        r.paths.push(target.to_string_lossy().into_owned());
        return Ok(r);
    }
    let Some((dir, ext)) = providers::agents_dir(provider) else {
        return Ok(r);
    };
    std::fs::create_dir_all(&dir)?;
    let target = dir.join(format!("{slug}.{ext}"));
    std::fs::copy(payload_md, &target)?;
    let _ = rewrite_skill_frontmatter(&target, slug, description);
    r.paths.push(target.to_string_lossy().into_owned());
    Ok(r)
}

/// Convert an authored agent markdown (frontmatter `name`/`description` + body)
/// into Codex's TOML agent format. The body becomes `developer_instructions`.
fn write_codex_agent(
    payload_md: &Path,
    slug: &str,
    description: Option<&str>,
    dst: &Path,
) -> Result<()> {
    let content = std::fs::read_to_string(payload_md)?;
    let (_name, fm_desc) = crate::services::provider_inspector::parse_frontmatter(&content);
    let body = strip_frontmatter(&content);
    let desc = description
        .map(str::to_string)
        .or(fm_desc)
        .unwrap_or_default();
    #[derive(serde::Serialize)]
    struct CodexAgent {
        name: String,
        #[serde(skip_serializing_if = "String::is_empty")]
        description: String,
        developer_instructions: String,
    }
    let toml_str = toml::to_string(&CodexAgent {
        name: slug.to_string(),
        description: desc,
        developer_instructions: body,
    })?;
    std::fs::write(dst, toml_str)?;
    Ok(())
}

/// Materialize a library-authored **Cursor rule** as a standalone `.mdc` in
/// `rules_dir` (a `<base>/.cursor/rules/` directory — home or a project folder).
/// The frontmatter is built from the Cursor rule type per cursor.com/docs/rules:
/// Always ⇒ `alwaysApply: true`; Apply Intelligently ⇒ `description:`; Apply to
/// Specific Files ⇒ `globs:`; Manual ⇒ neither. `authored` is the rule body (any
/// leading frontmatter is stripped). Recorded in `materialized`, removed on delete.
pub fn materialize_rule_cursor(
    rules_dir: &Path,
    slug: &str,
    rule_type: CursorRuleType,
    description: Option<&str>,
    globs: Option<&str>,
    authored: &str,
) -> Result<MaterializationResult> {
    let mut r = MaterializationResult {
        provider: "cursor-cli".to_string(),
        ..Default::default()
    };
    std::fs::create_dir_all(rules_dir)?;
    let body = strip_frontmatter(authored);
    let mdc = format!(
        "{}\n\n{}\n",
        cursor_frontmatter(rule_type, description, globs),
        body.trim_end()
    );
    let target = rules_dir.join(format!("{slug}.mdc"));
    std::fs::write(&target, mdc)?;
    r.paths.push(target.to_string_lossy().into_owned());
    Ok(r)
}

/// Build the `--- … ---` frontmatter for a Cursor `.mdc` from its rule type.
/// `description` is written (when provided) for **every** rule type — Cursor
/// only consults it for "Apply Intelligently", but it documents the rule on the
/// others. `globs`/`alwaysApply` follow the type per cursor.com/docs/rules.
fn cursor_frontmatter(
    rule_type: CursorRuleType,
    description: Option<&str>,
    globs: Option<&str>,
) -> String {
    let one_line = |s: &str| s.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut fm = String::from("---\n");
    if let Some(d) = description.filter(|d| !d.trim().is_empty()) {
        fm.push_str(&format!("description: {}\n", one_line(d)));
    }
    match rule_type {
        CursorRuleType::Always => fm.push_str("alwaysApply: true\n"),
        CursorRuleType::Specific => {
            if let Some(g) = globs.filter(|g| !g.trim().is_empty()) {
                fm.push_str(&format!("globs: {}\n", g.trim()));
            }
            fm.push_str("alwaysApply: false\n");
        }
        CursorRuleType::Intelligent | CursorRuleType::Manual => {
            fm.push_str("alwaysApply: false\n");
        }
    }
    fm.push_str("---");
    fm
}

/// Materialize a GitHub Copilot **path-specific** instructions file at
/// `<github_dir>/instructions/<slug>.instructions.md` with an `applyTo` glob
/// header (and an optional `description`). Used when a Copilot rule carries
/// globs (folder scope only — `applyTo` is repo-relative). Recorded in
/// `materialized`, removed on delete.
pub fn materialize_rule_copilot_instructions(
    github_dir: &Path,
    slug: &str,
    apply_to: &str,
    description: Option<&str>,
    authored: &str,
) -> Result<MaterializationResult> {
    let mut r = MaterializationResult {
        provider: "github-copilot".to_string(),
        ..Default::default()
    };
    let dir = github_dir.join("instructions");
    std::fs::create_dir_all(&dir)?;
    let body = strip_frontmatter(authored);
    let one_line = |s: &str| s.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut fm = format!("---\napplyTo: \"{}\"\n", apply_to.trim());
    if let Some(d) = description.filter(|d| !d.trim().is_empty()) {
        fm.push_str(&format!("description: {}\n", one_line(d)));
    }
    fm.push_str("---");
    let content = format!("{fm}\n\n{}\n", body.trim_end());
    let target = dir.join(format!("{slug}.instructions.md"));
    std::fs::write(&target, content)?;
    r.paths.push(target.to_string_lossy().into_owned());
    Ok(r)
}

/// Return the body after a leading `--- … ---` YAML frontmatter block, or the
/// whole text if there is none.
fn strip_frontmatter(text: &str) -> String {
    if let Some(rest) = text.strip_prefix("---") {
        if let Some(end) = rest.find("\n---") {
            let after = &rest[end + "\n---".len()..];
            return after.trim_start_matches(['\r', '\n']).to_string();
        }
    }
    text.to_string()
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
    let own = install_path
        .join(format!(".{}", providers::component_basename(provider)))
        .join(subdir);
    if own.is_dir() {
        return Some(own);
    }
    COMPONENT_PROVIDERS
        .iter()
        .map(|p| {
            install_path
                .join(format!(".{}", providers::component_basename(p)))
                .join(subdir)
        })
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

/// Like `set_frontmatter_name` but also guarantees a `description:` line — the
/// Agent-Skills open standard requires both `name` and `description`, and
/// Codex/OpenCode/Copilot reject a skill without a description. A description
/// already authored in the SKILL.md is kept; the library item's description is
/// only injected when none is present.
fn set_frontmatter_name_desc(content: &str, name: &str, description: Option<&str>) -> String {
    let withname = set_frontmatter_name(content, name);
    let Some(desc) = description.map(str::trim).filter(|d| !d.is_empty()) else {
        return withname;
    };
    let lines: Vec<&str> = withname.lines().collect();
    let Some(close) = lines
        .iter()
        .enumerate()
        .skip(1)
        .find(|(_, l)| l.trim() == "---")
        .map(|(i, _)| i)
    else {
        return withname;
    };
    // Keep a user-authored description if the frontmatter already has one.
    if lines[1..close]
        .iter()
        .any(|l| l.trim_start().starts_with("description:"))
    {
        return withname;
    }
    // Collapse to a one-line YAML scalar, capped at the 1024-char limit.
    let mut one_line = desc.split_whitespace().collect::<Vec<_>>().join(" ");
    if one_line.chars().count() > 1024 {
        one_line = one_line.chars().take(1024).collect();
    }
    let after_name = lines[1..close]
        .iter()
        .position(|l| l.trim_start().starts_with("name:"))
        .map(|p| p + 2) // +1 for the skipped open fence, +1 to land after `name:`
        .unwrap_or(1);
    let mut out: Vec<String> = lines.iter().map(|s| (*s).to_string()).collect();
    out.insert(after_name, format!("description: {one_line}"));
    let mut s = out.join("\n");
    if withname.ends_with('\n') {
        s.push('\n');
    }
    s
}

fn rewrite_skill_frontmatter(
    skill_md: &Path,
    name: &str,
    description: Option<&str>,
) -> std::io::Result<()> {
    let content = std::fs::read_to_string(skill_md)?;
    std::fs::write(
        skill_md,
        set_frontmatter_name_desc(&content, name, description),
    )
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
        // provider_home()/user_home() read USERPROFILE before HOME; pin it too
        // so a sibling test that leaked USERPROFILE can't redirect provider homes.
        let prev_up = std::env::var("USERPROFILE").ok();
        std::env::set_var("USERPROFILE", home);
        // Hermes resolves its home from %LOCALAPPDATA% on Windows; pin it to
        // the fake home too so the test controls every provider's home dir.
        let prev_local = std::env::var("LOCALAPPDATA").ok();
        std::env::set_var("LOCALAPPDATA", home);
        // Pin FLEETIFY_HOME so fleetify_home()-based writers (prompts) are
        // deterministic and isolated to the fake home.
        let prev_fleet = std::env::var("FLEETIFY_HOME").ok();
        std::env::set_var("FLEETIFY_HOME", home.join(".fleetify"));
        let r = f();
        match prev_fleet {
            Some(v) => std::env::set_var("FLEETIFY_HOME", v),
            None => std::env::remove_var("FLEETIFY_HOME"),
        }
        match prev_local {
            Some(v) => std::env::set_var("LOCALAPPDATA", v),
            None => std::env::remove_var("LOCALAPPDATA"),
        }
        match prev {
            Some(v) => std::env::set_var(key, v),
            None => std::env::remove_var(key),
        }
        match prev_up {
            Some(v) => std::env::set_var("USERPROFILE", v),
            None => std::env::remove_var("USERPROFILE"),
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
            let r = materialize("my-plugin", &install, "claude-code").unwrap();
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
            materialize("p", &install, "kimi-code").unwrap();
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
            materialize("p", &install, "codex-cli").unwrap();
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
            let r = materialize("q", &install, "gemini-cli").unwrap();
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
            materialize("p", &install, "hermes-agent").unwrap();
            // Copilot → standalone json; OpenCode → plugins/*.ts; Hermes → dir.
            assert!(home.join(".copilot/hooks/p-log.json").is_file());
            assert!(home.join(".config/opencode/plugins/p-guard.ts").is_file());
            // Hermes home is OS-specific (%LOCALAPPDATA%\hermes on Windows) —
            // resolve it through the registry rather than hard-coding `.hermes`.
            let hermes = providers::provider_home("hermes-agent").unwrap();
            assert!(hermes.join("hooks/p-audit/HOOK.yaml").is_file());
        });
    }

    #[test]
    fn materialize_prompt_item_writes_fleetify_prompt() {
        let tmp = tempdir().unwrap();
        let payload = tmp.path().join("payload.md");
        std::fs::write(
            &payload,
            b"---\ndescription: greet\n---\nSay hello to {{name}}.",
        )
        .unwrap();
        let home = tmp.path().join("home");
        with_home(&home, || {
            let r = materialize_prompt_item(&payload, "my-greeting").unwrap();
            let dst = home.join(".fleetify/prompts/my-greeting.md");
            assert!(dst.is_file(), "prompt should land in ~/.fleetify/prompts/");
            assert_eq!(
                std::fs::read_to_string(&dst).unwrap(),
                "---\ndescription: greet\n---\nSay hello to {{name}}."
            );
            // The written path is recorded for unmaterialize.
            assert_eq!(r.paths, vec![dst.to_string_lossy().into_owned()]);
            assert_eq!(r.provider, "fleetify");
        });
    }

    #[test]
    fn materialize_skill_item_copies_payload_and_rewrites_name() {
        let tmp = tempdir().unwrap();
        // Payload dir = the skill itself: SKILL.md + an asset.
        let payload = tmp.path().join("payload");
        std::fs::create_dir_all(&payload).unwrap();
        std::fs::write(
            payload.join("SKILL.md"),
            b"---\nname: whatever\ndescription: d\n---\n# body",
        )
        .unwrap();
        std::fs::write(payload.join("ref.txt"), b"x").unwrap();
        let home = tmp.path().join("home");
        with_home(&home, || {
            let r = materialize_skill_item(&payload, "my-skill", "claude-code", None).unwrap();
            let dst = home.join(".claude/skills/my-skill");
            assert!(dst.join("SKILL.md").is_file());
            assert!(dst.join("ref.txt").is_file(), "assets copied");
            // Bare slug is the dir id (NOT namespaced) and the frontmatter
            // name is rewritten to equal the dir.
            let md = std::fs::read_to_string(dst.join("SKILL.md")).unwrap();
            assert!(md.contains("name: my-skill"));
            assert!(!md.contains("name: whatever"));
            assert_eq!(r.paths, vec![dst.to_string_lossy().into_owned()]);
        });
    }

    #[test]
    fn materialize_skill_item_targets_each_providers_home() {
        let tmp = tempdir().unwrap();
        let payload = tmp.path().join("payload");
        std::fs::create_dir_all(&payload).unwrap();
        std::fs::write(
            payload.join("SKILL.md"),
            b"---\nname: s\ndescription: d\n---\nbody",
        )
        .unwrap();
        let home = tmp.path().join("home");
        with_home(&home, || {
            materialize_skill_item(&payload, "s", "opencode", None).unwrap();
            materialize_skill_item(&payload, "s", "kimi-code", None).unwrap();
            assert!(home.join(".config/opencode/skills/s/SKILL.md").is_file());
            assert!(home.join(".kimi/skills/s/SKILL.md").is_file());
        });
    }

    #[test]
    fn skill_item_injects_description_into_frontmatter() {
        let tmp = tempdir().unwrap();
        let payload = tmp.path().join("payload");
        std::fs::create_dir_all(&payload).unwrap();
        // Authored SKILL.md has a name but NO description.
        std::fs::write(payload.join("SKILL.md"), b"---\nname: x\n---\n# body").unwrap();
        let home = tmp.path().join("home");
        with_home(&home, || {
            materialize_skill_item(&payload, "my-skill", "claude-code", Some("Does a thing"))
                .unwrap();
            let md =
                std::fs::read_to_string(home.join(".claude/skills/my-skill/SKILL.md")).unwrap();
            assert!(md.contains("name: my-skill"));
            assert!(
                md.contains("description: Does a thing"),
                "item description injected when frontmatter lacks one:\n{md}"
            );
        });
    }

    #[test]
    fn skill_item_keeps_authored_description() {
        let tmp = tempdir().unwrap();
        let payload = tmp.path().join("payload");
        std::fs::create_dir_all(&payload).unwrap();
        std::fs::write(
            payload.join("SKILL.md"),
            b"---\nname: x\ndescription: authored\n---\nbody",
        )
        .unwrap();
        let home = tmp.path().join("home");
        with_home(&home, || {
            materialize_skill_item(&payload, "s", "claude-code", Some("item-level")).unwrap();
            let md = std::fs::read_to_string(home.join(".claude/skills/s/SKILL.md")).unwrap();
            assert!(md.contains("description: authored"));
            assert!(!md.contains("item-level"), "authored description preserved");
        });
    }

    #[test]
    fn skill_shared_writes_agents_dir() {
        let tmp = tempdir().unwrap();
        let payload = tmp.path().join("payload");
        std::fs::create_dir_all(&payload).unwrap();
        std::fs::write(payload.join("SKILL.md"), b"---\nname: x\n---\nbody").unwrap();
        let home = tmp.path().join("home");
        with_home(&home, || {
            let r = materialize_skill_shared(&payload, "shared-skill", Some("d")).unwrap();
            assert_eq!(r.provider, "agents");
            let dst = home.join(".agents/skills/shared-skill/SKILL.md");
            assert!(dst.is_file());
            assert!(std::fs::read_to_string(&dst)
                .unwrap()
                .contains("name: shared-skill"));
        });
    }

    #[test]
    fn unmaterialize_reverses_item_writers() {
        let tmp = tempdir().unwrap();
        // skill payload
        let skill = tmp.path().join("skill");
        std::fs::create_dir_all(&skill).unwrap();
        std::fs::write(
            skill.join("SKILL.md"),
            b"---\nname: s\ndescription: d\n---\nb",
        )
        .unwrap();
        let prompt = tmp.path().join("prompt.md");
        std::fs::write(&prompt, b"hello").unwrap();

        let home = tmp.path().join("home");
        with_home(&home, || {
            let rs = materialize_skill_item(&skill, "s", "claude-code", None).unwrap();
            let rp = materialize_prompt_item(&prompt, "p").unwrap();
            assert!(home.join(".claude/skills/s").is_dir());
            assert!(home.join(".fleetify/prompts/p.md").is_file());

            unmaterialize(&rs).unwrap();
            unmaterialize(&rp).unwrap();
            assert!(!home.join(".claude/skills/s").exists());
            assert!(!home.join(".fleetify/prompts/p.md").exists());
        });
    }
}
