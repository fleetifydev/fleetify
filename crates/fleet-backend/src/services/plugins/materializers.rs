//! Plugin materializers — write per-provider components from an
//! installed plugin into the target tool's config dir so claude /
//! gemini / codex sessions actually see them.
//!
//! Phase-4 cut handles skills + commands (Claude / Gemini) +
//! prompts (Codex). Hooks materialization (which needs
//! settings.json merging across multiple plugins safely) lands in a
//! follow-up alongside the settings_merger port.

use std::path::{Path, PathBuf};

use anyhow::Result;
use serde::{Deserialize, Serialize};

/// Provider home dirs the materializer writes into. Faithful with
/// `_claude_home_for` / `_gemini_home_for` / `_codex_home_for`.
fn provider_home(provider: &str) -> Option<PathBuf> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()?;
    Some(PathBuf::from(home).join(format!(".{provider}")))
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct MaterializationResult {
    pub provider: String,
    pub paths: Vec<String>,
    #[serde(default)]
    pub skipped: Vec<String>,
}

/// Materialize the given installed plugin for `provider`. Provider must
/// be one of `"claude"`, `"gemini"`, `"codex"`. Returns the list of
/// paths actually written so unmaterialize can find them later.
pub fn materialize(
    plugin_name: &str,
    install_path: &Path,
    provider: &str,
) -> Result<MaterializationResult> {
    let mut r = MaterializationResult {
        provider: provider.to_string(),
        ..Default::default()
    };
    let Some(home) = provider_home(provider) else {
        return Ok(r);
    };
    let provider_src = install_path.join(format!(".{provider}"));
    if !provider_src.is_dir() {
        return Ok(r);
    }
    std::fs::create_dir_all(&home)?;

    // Skills: every <name>/SKILL.md becomes a sibling dir under
    // `<home>/skills/<plugin>__<name>/`. Same shape Claude/Gemini both
    // discover. Codex's `.codex/` doesn't ship skills today; we still
    // honour the directory if a plugin author drops one in.
    let skills_src = provider_src.join("skills");
    if skills_src.is_dir() {
        let skills_dst_root = home.join("skills");
        std::fs::create_dir_all(&skills_dst_root)?;
        for ent in std::fs::read_dir(&skills_src)? {
            let ent = ent?;
            if !ent.file_type()?.is_dir() {
                continue;
            }
            let src = ent.path();
            // A skill MUST have a SKILL.md at its root — caller's
            // responsibility to maintain that, but we skip + record
            // instead of erroring so one bad skill doesn't fail the
            // whole materialization.
            if !src.join("SKILL.md").is_file() {
                r.skipped.push(src.to_string_lossy().into_owned());
                continue;
            }
            let name = ent.file_name().to_string_lossy().to_string();
            let target = skills_dst_root.join(format!("{plugin_name}__{name}"));
            copy_dir_recursive(&src, &target)?;
            r.paths.push(target.to_string_lossy().into_owned());
        }
    }

    // Commands (Claude / Gemini): `<provider>/commands/<name>.md`
    // → flatten to `<home>/commands/<plugin>__<name>.md`. Gemini's
    // dir-grouping affects /help labels, not the invocation name, so
    // the flatten is fine for both.
    if matches!(provider, "claude" | "gemini") {
        let cmds_src = provider_src.join("commands");
        if cmds_src.is_dir() {
            let cmds_dst = home.join("commands");
            std::fs::create_dir_all(&cmds_dst)?;
            for ent in std::fs::read_dir(&cmds_src)? {
                let ent = ent?;
                let src = ent.path();
                if !src.is_file() {
                    continue;
                }
                if src.extension().and_then(|e| e.to_str()) != Some("md") {
                    continue;
                }
                let stem = src
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("")
                    .to_string();
                if stem.is_empty() {
                    continue;
                }
                let target = cmds_dst.join(format!("{plugin_name}__{stem}.md"));
                std::fs::copy(&src, &target)?;
                r.paths.push(target.to_string_lossy().into_owned());
            }
        }
    }

    // Prompts (Codex): `.codex/prompts/*.md` → `<home>/prompts/<plugin>__<name>.md`.
    if provider == "codex" {
        let prompts_src = provider_src.join("prompts");
        if prompts_src.is_dir() {
            let prompts_dst = home.join("prompts");
            std::fs::create_dir_all(&prompts_dst)?;
            for ent in std::fs::read_dir(&prompts_src)? {
                let ent = ent?;
                let src = ent.path();
                if !src.is_file() {
                    continue;
                }
                if src.extension().and_then(|e| e.to_str()) != Some("md") {
                    continue;
                }
                let stem = src
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("")
                    .to_string();
                if stem.is_empty() {
                    continue;
                }
                let target = prompts_dst.join(format!("{plugin_name}__{stem}.md"));
                std::fs::copy(&src, &target)?;
                r.paths.push(target.to_string_lossy().into_owned());
            }
        }
    }

    Ok(r)
}

/// Reverse a materialization. Quiet on missing paths — the source of
/// truth for cleanup is the `paths` list captured at materialize time.
pub fn unmaterialize(result: &MaterializationResult) -> Result<()> {
    for raw in &result.paths {
        let p = std::path::Path::new(raw);
        if p.is_dir() {
            let _ = std::fs::remove_dir_all(p);
        } else if p.is_file() {
            let _ = std::fs::remove_file(p);
        }
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
        // Tests run serially within the module — single shared env
        // override OK for in-module tests.
        let key = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
        let prev = std::env::var(key).ok();
        std::env::set_var(key, home);
        let r = f();
        match prev {
            Some(v) => std::env::set_var(key, v),
            None => std::env::remove_var(key),
        }
        r
    }

    #[test]
    fn materialize_claude_copies_skills_and_commands_with_prefix() {
        let tmp = tempdir().unwrap();
        let install = tmp.path().join("install/my-plugin");
        // Build the .claude/ tree.
        let claude = install.join(".claude");
        std::fs::create_dir_all(claude.join("skills/cool-skill")).unwrap();
        std::fs::write(claude.join("skills/cool-skill/SKILL.md"), b"# cool").unwrap();
        std::fs::write(claude.join("skills/cool-skill/asset.txt"), b"x").unwrap();
        std::fs::create_dir_all(claude.join("commands")).unwrap();
        std::fs::write(claude.join("commands/run.md"), b"## /run").unwrap();
        // Bad skill: no SKILL.md → should be skipped, not error.
        std::fs::create_dir_all(claude.join("skills/no-skill-md")).unwrap();
        std::fs::write(claude.join("skills/no-skill-md/README.md"), b"x").unwrap();

        let home = tmp.path().join("home");
        with_home(&home, || {
            let r = materialize("my-plugin", &install, "claude").unwrap();
            // Skill copied with plugin__ prefix.
            let dst_skill = home.join(".claude/skills/my-plugin__cool-skill");
            assert!(dst_skill.is_dir());
            assert!(dst_skill.join("SKILL.md").is_file());
            assert!(dst_skill.join("asset.txt").is_file());
            // Command flattened with plugin__ prefix.
            let dst_cmd = home.join(".claude/commands/my-plugin__run.md");
            assert!(dst_cmd.is_file());
            // Result tracks paths + skipped.
            assert!(r.paths.iter().any(|p| p.contains("my-plugin__cool-skill")));
            assert!(r.paths.iter().any(|p| p.contains("my-plugin__run.md")));
            assert_eq!(r.skipped.len(), 1);
            assert!(r.skipped[0].contains("no-skill-md"));
        });
    }

    #[test]
    fn materialize_codex_copies_prompts_not_commands() {
        let tmp = tempdir().unwrap();
        let install = tmp.path().join("install/p");
        let codex = install.join(".codex");
        std::fs::create_dir_all(codex.join("prompts")).unwrap();
        std::fs::write(codex.join("prompts/audit.md"), b"# audit prompt").unwrap();
        // Codex doesn't have commands — even if present, we skip.
        std::fs::create_dir_all(codex.join("commands")).unwrap();
        std::fs::write(codex.join("commands/run.md"), b"# nope").unwrap();

        let home = tmp.path().join("home");
        with_home(&home, || {
            let r = materialize("p", &install, "codex").unwrap();
            assert!(home.join(".codex/prompts/p__audit.md").is_file());
            // No commands materialized for codex.
            assert!(!home.join(".codex/commands/p__run.md").exists());
            assert!(r.paths.iter().any(|p| p.ends_with("p__audit.md")));
            assert!(!r.paths.iter().any(|p| p.contains("p__run.md")));
        });
    }

    #[test]
    fn unmaterialize_removes_paths_from_result() {
        let tmp = tempdir().unwrap();
        let install = tmp.path().join("install/q");
        let g = install.join(".gemini");
        std::fs::create_dir_all(g.join("commands")).unwrap();
        std::fs::write(g.join("commands/x.md"), b"# x").unwrap();

        let home = tmp.path().join("home");
        with_home(&home, || {
            let r = materialize("q", &install, "gemini").unwrap();
            let written = home.join(".gemini/commands/q__x.md");
            assert!(written.is_file());
            unmaterialize(&r).unwrap();
            assert!(!written.exists());
        });
    }
}
