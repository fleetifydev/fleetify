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

/// Per-provider skill directory matrix. Faithful with `_skill_roots`.
/// `provider` is "claude" | "gemini" | "codex"; unknown values yield
/// an empty matrix.
fn skill_roots(
    provider: &str,
    home: &Path,
    project: Option<&Path>,
) -> Vec<(PathBuf, &'static str)> {
    let mut roots: Vec<(PathBuf, &'static str)> = Vec::new();
    match provider {
        "claude" => {
            roots.push((home.join(".claude").join("skills"), "user"));
            if let Some(p) = project {
                roots.push((p.join(".claude").join("skills"), "project"));
            }
        }
        "gemini" => {
            roots.push((home.join(".gemini").join("skills"), "user"));
            roots.push((home.join(".agents").join("skills"), "user"));
            if let Some(p) = project {
                roots.push((p.join(".gemini").join("skills"), "project"));
                roots.push((p.join(".agents").join("skills"), "project"));
            }
        }
        "codex" => {
            roots.push((home.join(".agents").join("skills"), "user"));
            roots.push((home.join(".codex").join("skills"), "user"));
            roots.push((PathBuf::from("/etc/codex/skills"), "system"));
            if let Some(p) = project {
                roots.push((p.join(".agents").join("skills"), "project"));
                roots.push((p.join(".codex").join("skills"), "project"));
            }
        }
        _ => {}
    }
    roots
}

/// Provider-aware skill scanner — drops in for the renderer's
/// /skills tab regardless of `session.tool`. Returns an empty list
/// for unknown providers (parity with Python returning [] in that
/// branch).
pub fn list_skills_for_provider(
    provider: &str,
    home: &Path,
    project: Option<&Path>,
) -> Vec<Skill> {
    let mut all: Vec<Skill> = Vec::new();
    for (root, tier) in skill_roots(provider, home, project) {
        all.extend(scan_root(&root, provider, tier));
    }
    all
}

/// One row from `_scan_settings_hooks` — a hook is a `{event, matcher,
/// command}` triplet pulled out of `~/.claude/settings.json`'s `hooks`
/// block. Event names are PreToolUse / PostToolUse / Notification etc.
#[derive(Debug, Clone, Serialize)]
pub struct Hook {
    pub kind: &'static str, // "hook"
    pub provider: &'static str,
    pub name: String,
    pub source_tier: &'static str,
    pub path: String,
    pub event: String,
    pub matcher: Option<String>,
    pub command: String,
}

/// Walk a Claude `settings.json` `hooks` object and flatten every
/// matcher's commands into one row each. Shape:
///   {"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"command":"..."}]}]}}
fn flatten_claude_hooks_block(
    settings_path: &Path,
    tier: &'static str,
) -> Vec<Hook> {
    let Ok(text) = std::fs::read_to_string(settings_path) else {
        return Vec::new();
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else {
        return Vec::new();
    };
    let Some(hooks) = v.get("hooks").and_then(|x| x.as_object()) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for (event, group) in hooks {
        let Some(arr) = group.as_array() else { continue };
        for entry in arr {
            let Some(obj) = entry.as_object() else { continue };
            let matcher = obj
                .get("matcher")
                .and_then(|x| x.as_str())
                .map(String::from);
            let Some(commands) = obj.get("hooks").and_then(|x| x.as_array()) else {
                continue;
            };
            for cmd in commands {
                let Some(c) = cmd.as_object() else { continue };
                let command = c
                    .get("command")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string();
                if command.is_empty() {
                    continue;
                }
                // Stable display name — matcher + event keeps two hooks
                // for the same event apart in the renderer's hooks tab.
                let name = match &matcher {
                    Some(m) => format!("{event}: {m}"),
                    None => event.clone(),
                };
                out.push(Hook {
                    kind: "hook",
                    provider: "claude",
                    name,
                    source_tier: tier,
                    path: settings_path.to_string_lossy().into_owned(),
                    event: event.clone(),
                    matcher: matcher.clone(),
                    command,
                });
            }
        }
    }
    out
}

/// Claude hooks: `~/.claude/settings.json` + `<project>/.claude/settings.json`
/// + `<project>/.claude/settings.local.json` (project-local overrides).
pub fn list_claude_hooks(home: &Path, project: Option<&Path>) -> Vec<Hook> {
    let mut all = flatten_claude_hooks_block(
        &home.join(".claude").join("settings.json"),
        "user",
    );
    if let Some(p) = project {
        all.extend(flatten_claude_hooks_block(
            &p.join(".claude").join("settings.json"),
            "project",
        ));
        all.extend(flatten_claude_hooks_block(
            &p.join(".claude").join("settings.local.json"),
            "project",
        ));
    }
    all
}

/// One row from `_scan_md_commands` — a slash command pulled out of
/// `<root>/<namespace>/<name>.md` with optional `description:`
/// frontmatter.
#[derive(Debug, Clone, Serialize)]
pub struct Command {
    pub kind: &'static str, // "command"
    pub provider: &'static str,
    pub name: String,
    pub source_tier: &'static str,
    pub path: String,
    pub namespace: Option<String>,
    pub description: Option<String>,
}

/// Walk a Claude commands directory recursively (one level deep,
/// matching the renderer's `/git:commit` style). Subdirectories become
/// namespaces. Faithful with `_scan_md_commands`.
fn scan_md_commands(
    root: &Path,
    tier: &'static str,
    force_namespace: Option<&'static str>,
) -> Vec<Command> {
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir(root) else {
        return out;
    };
    for entry in rd.flatten() {
        let p = entry.path();
        if p.is_file() && p.extension().and_then(|s| s.to_str()) == Some("md") {
            push_md_command(&p, tier, force_namespace.map(String::from), &mut out);
        } else if p.is_dir() {
            let ns = p
                .file_name()
                .and_then(|s| s.to_str())
                .map(String::from);
            if let Ok(sub) = std::fs::read_dir(&p) {
                for sub_entry in sub.flatten() {
                    let sp = sub_entry.path();
                    if sp.is_file()
                        && sp.extension().and_then(|s| s.to_str()) == Some("md")
                    {
                        push_md_command(&sp, tier, ns.clone(), &mut out);
                    }
                }
            }
        }
    }
    out
}

fn push_md_command(
    md_path: &Path,
    tier: &'static str,
    namespace: Option<String>,
    out: &mut Vec<Command>,
) {
    let text = std::fs::read_to_string(md_path).unwrap_or_default();
    let (_n, desc) = parse_frontmatter(&text);
    let name = md_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();
    if name.is_empty() {
        return;
    }
    out.push(Command {
        kind: "command",
        provider: "claude",
        name,
        source_tier: tier,
        path: md_path.to_string_lossy().into_owned(),
        namespace,
        description: desc,
    });
}

/// Claude commands: `~/.claude/commands/**/*.md` + project equivalent.
pub fn list_claude_commands(home: &Path, project: Option<&Path>) -> Vec<Command> {
    let mut all = scan_md_commands(&home.join(".claude").join("commands"), "user", None);
    if let Some(p) = project {
        all.extend(scan_md_commands(
            &p.join(".claude").join("commands"),
            "project",
            None,
        ));
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
    fn list_skills_for_provider_covers_gemini_and_codex_roots() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");

        // Gemini: ~/.gemini/skills/g-skill and ~/.agents/skills/agent-skill.
        let g = home.join(".gemini/skills/g-skill");
        let a = home.join(".agents/skills/agent-skill");
        std::fs::create_dir_all(&g).unwrap();
        std::fs::create_dir_all(&a).unwrap();
        std::fs::write(
            g.join("SKILL.md"),
            "---\nname: gemini-named\ndescription: g\n---\n",
        )
        .unwrap();
        std::fs::write(a.join("SKILL.md"), "body").unwrap();

        let items = list_skills_for_provider("gemini", &home, None);
        // Two roots → 2 skills.
        assert_eq!(items.len(), 2);
        // Provider field on both rows is "gemini" (matches Python).
        assert!(items.iter().all(|s| s.provider == "gemini"));
        assert!(items.iter().any(|s| s.name == "gemini-named"));
        assert!(items.iter().any(|s| s.name == "agent-skill"));

        // Codex: ~/.codex/skills/codex-x. (/etc/codex/skills not
        // writable in test — but list_skills_for_provider still tries
        // to scan it; that's fine, scan_root returns [] on missing.)
        let c = home.join(".codex/skills/codex-x");
        std::fs::create_dir_all(&c).unwrap();
        std::fs::write(c.join("SKILL.md"), "body").unwrap();
        let cx = list_skills_for_provider("codex", &home, None);
        assert!(cx.iter().any(|s| s.name == "codex-x"));
        assert!(cx.iter().any(|s| s.name == "agent-skill"));
    }

    #[test]
    fn list_skills_for_provider_unknown_returns_empty() {
        let tmp = tempfile::tempdir().unwrap();
        let items = list_skills_for_provider("openai", tmp.path(), None);
        assert!(items.is_empty());
    }

    #[test]
    fn list_claude_hooks_flattens_event_matcher_command_triplets() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        std::fs::create_dir_all(home.join(".claude")).unwrap();
        std::fs::write(
            home.join(".claude/settings.json"),
            r#"{"hooks":{"PreToolUse":[
                {"matcher":"Bash","hooks":[{"command":"fleet-permission-check"}]},
                {"matcher":"Edit","hooks":[
                    {"command":"./pre-edit.sh"},
                    {"command":"./pre-edit-2.sh"}
                ]}
            ],"PostToolUse":[{"hooks":[{"command":"./after.sh"}]}]}}"#,
        )
        .unwrap();
        let items = list_claude_hooks(&home, None);
        assert_eq!(items.len(), 4);
        let pre_bash = items
            .iter()
            .find(|h| h.event == "PreToolUse" && h.matcher.as_deref() == Some("Bash"))
            .unwrap();
        assert_eq!(pre_bash.command, "fleet-permission-check");
        assert_eq!(pre_bash.source_tier, "user");
        let posts: Vec<&Hook> = items
            .iter()
            .filter(|h| h.event == "PostToolUse")
            .collect();
        assert_eq!(posts.len(), 1);
        assert!(posts[0].matcher.is_none());
    }

    #[test]
    fn list_claude_hooks_returns_empty_when_settings_missing_or_malformed() {
        let tmp = tempfile::tempdir().unwrap();
        // Missing file entirely.
        assert!(list_claude_hooks(tmp.path(), None).is_empty());
        // Present but malformed JSON.
        let home = tmp.path().join("home2");
        std::fs::create_dir_all(home.join(".claude")).unwrap();
        std::fs::write(home.join(".claude/settings.json"), "not json").unwrap();
        assert!(list_claude_hooks(&home, None).is_empty());
        // Valid JSON without a `hooks` key.
        std::fs::write(home.join(".claude/settings.json"), r#"{"other":1}"#).unwrap();
        assert!(list_claude_hooks(&home, None).is_empty());
    }

    #[test]
    fn list_claude_commands_walks_one_level_of_namespaces() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        let cmd_root = home.join(".claude/commands");
        std::fs::create_dir_all(cmd_root.join("git")).unwrap();

        // /flat-command (no namespace).
        std::fs::write(
            cmd_root.join("ping.md"),
            "---\ndescription: pong\n---\nbody",
        )
        .unwrap();
        // /git:commit (namespace = "git").
        std::fs::write(
            cmd_root.join("git/commit.md"),
            "---\ndescription: nice commit\n---\nbody",
        )
        .unwrap();
        // Non-.md sibling — ignored.
        std::fs::write(cmd_root.join("readme.txt"), "ignore").unwrap();

        let cmds = list_claude_commands(&home, None);
        assert_eq!(cmds.len(), 2);
        let flat = cmds.iter().find(|c| c.name == "ping").unwrap();
        assert!(flat.namespace.is_none());
        assert_eq!(flat.description.as_deref(), Some("pong"));
        let ns = cmds.iter().find(|c| c.name == "commit").unwrap();
        assert_eq!(ns.namespace.as_deref(), Some("git"));
        assert_eq!(ns.description.as_deref(), Some("nice commit"));
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
