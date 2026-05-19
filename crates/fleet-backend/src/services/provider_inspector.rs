//! Faithful subset of `app/services/provider_inspector.py`: Claude skills
//! scanner over `~/.claude/skills/<name>/SKILL.md` (+ project-local
//! `<project>/.claude/skills/`). Gemini/Codex skills + hooks + commands
//! land as follow-up Phase 2/3 increments. Frontmatter parsing is the
//! minimal subset (name, description) sufficient for the renderer's
//! Skills tab; full YAML support is not required.

use std::path::{Path, PathBuf};

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct Skill {
    pub kind: &'static str, // "skill"
    pub provider: String,
    pub name: String,
    pub source_tier: &'static str, // "user" | "project"
    pub path: String,
    pub description: Option<String>,
}

/// Pull `name:` / `description:` out of a `--- ... ---` YAML frontmatter.
/// Returns `(None, None)` when the file has no frontmatter at all.
pub fn parse_frontmatter(text: &str) -> (Option<String>, Option<String>) {
    if !text.starts_with("---") {
        return (None, None);
    }
    let body = &text[3..];
    let Some(end) = body.find("\n---") else {
        return (None, None);
    };
    let yaml = &body[..end];
    let mut name = None;
    let mut desc = None;
    for line in yaml.lines() {
        let trimmed = line.trim();
        if let Some(v) = trimmed.strip_prefix("name:") {
            name = Some(strip_quotes(v));
        } else if let Some(v) = trimmed.strip_prefix("description:") {
            desc = Some(strip_quotes(v));
        }
    }
    (name, desc)
}

fn strip_quotes(s: &str) -> String {
    let t = s.trim();
    let t = t.trim_start_matches('"').trim_end_matches('"');
    t.trim_start_matches('\'').trim_end_matches('\'').to_string()
}

fn scan_root(root: &Path, provider: &str, tier: &'static str) -> Vec<Skill> {
    let Ok(rd) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut entries: Vec<PathBuf> = rd
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .collect();
    entries.sort();

    let mut out = Vec::new();
    for child in entries {
        if !child.is_dir() {
            continue;
        }
        let skill_md = child.join("SKILL.md");
        if !skill_md.is_file() {
            continue;
        }
        let text = std::fs::read_to_string(&skill_md).unwrap_or_default();
        let (fm_name, desc) = parse_frontmatter(&text);
        let dir_name = child
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();
        out.push(Skill {
            kind: "skill",
            provider: provider.to_string(),
            name: fm_name.unwrap_or(dir_name),
            source_tier: tier,
            path: child.to_string_lossy().to_string(),
            description: desc,
        });
    }
    out
}

/// User-tier `~/.claude/skills/` + (optional) project-tier
/// `<project>/.claude/skills/` (parity with `_skill_roots` for the
/// "claude" provider).
pub fn list_claude_skills(home: &Path, project: Option<&Path>) -> Vec<Skill> {
    let mut all = scan_root(&home.join(".claude").join("skills"), "claude", "user");
    if let Some(p) = project {
        all.extend(scan_root(&p.join(".claude").join("skills"), "claude", "project"));
    }
    all
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frontmatter_extracts_name_and_description() {
        let text =
            "---\nname: My Skill\ndescription: \"Does a thing\"\nother: ignore\n---\nbody";
        let (n, d) = parse_frontmatter(text);
        assert_eq!(n.as_deref(), Some("My Skill"));
        assert_eq!(d.as_deref(), Some("Does a thing"));
    }

    #[test]
    fn no_frontmatter_returns_none() {
        let (n, d) = parse_frontmatter("body only");
        assert!(n.is_none() && d.is_none());
    }

    #[test]
    fn list_claude_skills_user_and_project() {
        let tmp = tempfile::tempdir().unwrap();
        // user tier: <home>/.claude/skills/foo/SKILL.md
        let home = tmp.path().join("home");
        let proj = tmp.path().join("project");
        let u_skill = home.join(".claude/skills/foo");
        let p_skill = proj.join(".claude/skills/bar");
        std::fs::create_dir_all(&u_skill).unwrap();
        std::fs::create_dir_all(&p_skill).unwrap();
        std::fs::write(
            u_skill.join("SKILL.md"),
            "---\nname: foo-skill\ndescription: U\n---\n",
        )
        .unwrap();
        // bar/ has no frontmatter — name falls back to dir name.
        std::fs::write(p_skill.join("SKILL.md"), "body").unwrap();

        let items = list_claude_skills(&home, Some(&proj));
        assert_eq!(items.len(), 2);
        let foo = items.iter().find(|s| s.source_tier == "user").unwrap();
        assert_eq!(foo.name, "foo-skill");
        assert_eq!(foo.description.as_deref(), Some("U"));
        assert_eq!(foo.provider, "claude");
        let bar = items.iter().find(|s| s.source_tier == "project").unwrap();
        assert_eq!(bar.name, "bar"); // fallback to directory name
        assert!(bar.description.is_none());
    }
}
