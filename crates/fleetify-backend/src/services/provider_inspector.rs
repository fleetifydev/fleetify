//! Faithful subset of `app/services/provider_inspector.py`: Claude skills
//! scanner over `~/.claude/skills/<name>/SKILL.md` (+ project-local
//! `<project>/.claude/skills/`). Codex skills + hooks + commands
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
    t.trim_start_matches('\'')
        .trim_end_matches('\'')
        .to_string()
}

fn scan_root(root: &Path, provider: &str, tier: &'static str) -> Vec<Skill> {
    let Ok(rd) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut entries: Vec<PathBuf> = rd.filter_map(|e| e.ok()).map(|e| e.path()).collect();
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
/// "claude-code" provider).
pub fn list_claude_skills(home: &Path, project: Option<&Path>) -> Vec<Skill> {
    let mut all = scan_root(&home.join(".claude").join("skills"), "claude-code", "user");
    if let Some(p) = project {
        all.extend(scan_root(
            &p.join(".claude").join("skills"),
            "claude-code",
            "project",
        ));
    }
    all
}

/// Per-provider skill directory matrix. Faithful with `_skill_roots`.
/// `provider` is "claude-code" | "codex-cli"; unknown values yield
/// an empty matrix.
fn skill_roots(
    provider: &str,
    home: &Path,
    project: Option<&Path>,
) -> Vec<(PathBuf, &'static str)> {
    let mut roots: Vec<(PathBuf, &'static str)> = Vec::new();
    match provider {
        "claude-code" => {
            roots.push((home.join(".claude").join("skills"), "user"));
            if let Some(p) = project {
                roots.push((p.join(".claude").join("skills"), "project"));
            }
        }
        "codex-cli" => {
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
pub fn list_skills_for_provider(provider: &str, home: &Path, project: Option<&Path>) -> Vec<Skill> {
    let mut all: Vec<Skill> = Vec::new();
    for (root, tier) in skill_roots(provider, home, project) {
        all.extend(scan_root(&root, provider, tier));
    }
    all
}

/// One row from `_flatten_hooks_block` — a hook is one handler within
/// a `{event:[{matcher,hooks:[…]}]}` block. Faithful with the Python
/// `ProviderItem` for hook items.
#[derive(Debug, Clone, Serialize)]
pub struct Hook {
    pub kind: &'static str, // "hook"
    pub provider: &'static str,
    pub name: String,
    pub source_tier: &'static str,
    pub path: String,
    pub event: String,
    pub matcher: Option<String>,
    /// Free-form handler payload — `command` for shell handlers,
    /// `url` for webhook handlers, `prompt` for LLM-prompt handlers.
    pub command: String,
    /// Hint to the renderer for icon / format selection ("json" |
    /// "toml"). Matches `ProviderItem.config_format`.
    pub config_format: &'static str,
    pub description: Option<String>,
}

/// Generic hooks-block flattener — handles both the nested
/// `[{matcher, hooks:[{command}]}]` and the flat `[{matcher, command}]`
/// shapes used in the wild. Faithful with Python `_flatten_hooks_block`.
fn flatten_hooks_block(
    block: &serde_json::Value,
    provider: &'static str,
    tier: &'static str,
    source_path: &Path,
    fmt: &'static str,
) -> Vec<Hook> {
    let Some(hooks) = block.as_object() else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for (event, groups) in hooks {
        let Some(arr) = groups.as_array() else {
            continue;
        };
        for group in arr {
            let Some(obj) = group.as_object() else {
                continue;
            };
            let matcher = obj
                .get("matcher")
                .and_then(|x| x.as_str())
                .map(String::from);
            // Shape 1: { matcher, hooks: [...] } — Claude convention.
            // Shape 2: { matcher, command } directly — older Codex configs.
            let handlers: Vec<&serde_json::Value> =
                if let Some(arr) = obj.get("hooks").and_then(|x| x.as_array()) {
                    arr.iter().collect()
                } else if obj.contains_key("command")
                    || obj.contains_key("url")
                    || obj.contains_key("prompt")
                {
                    vec![group]
                } else {
                    Vec::new()
                };
            for handler in handlers {
                let Some(h) = handler.as_object() else {
                    continue;
                };
                let command = h
                    .get("command")
                    .or_else(|| h.get("url"))
                    .or_else(|| h.get("prompt"))
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string();
                if command.is_empty() {
                    continue;
                }
                let name = match h.get("name").and_then(|x| x.as_str()) {
                    Some(n) => n.to_string(),
                    None => format!(
                        "{event}:{}",
                        matcher.as_deref().filter(|s| !s.is_empty()).unwrap_or("*")
                    ),
                };
                let desc_src = command.replace('\n', " ");
                let desc = if desc_src.chars().count() > 120 {
                    Some(format!(
                        "{}…",
                        desc_src.chars().take(120).collect::<String>()
                    ))
                } else if desc_src.is_empty() {
                    None
                } else {
                    Some(desc_src)
                };
                out.push(Hook {
                    kind: "hook",
                    provider,
                    name,
                    source_tier: tier,
                    path: source_path.to_string_lossy().into_owned(),
                    event: event.clone(),
                    matcher: matcher.clone(),
                    command,
                    config_format: fmt,
                    description: desc,
                });
            }
        }
    }
    out
}

/// Read a JSON settings file and flatten its top-level `hooks` block.
/// Empty result on missing-file / malformed-JSON / missing-`hooks` key.
fn scan_settings_hooks(path: &Path, provider: &'static str, tier: &'static str) -> Vec<Hook> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else {
        return Vec::new();
    };
    let Some(block) = v.get("hooks") else {
        return Vec::new();
    };
    flatten_hooks_block(block, provider, tier, path, "json")
}

/// Codex accepts hooks in either `hooks.json` or `[hooks]` of
/// `config.toml`; when both exist `hooks.json` wins. Faithful with
/// `_scan_codex_hooks`.
fn scan_codex_hooks(json_path: &Path, toml_path: &Path, tier: &'static str) -> Vec<Hook> {
    if json_path.is_file() {
        if let Ok(text) = std::fs::read_to_string(json_path) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
                // Codex accepts either {"hooks": {...}} or the bare
                // {...} at top level.
                let block = v.get("hooks").cloned().unwrap_or_else(|| v.clone());
                return flatten_hooks_block(&block, "codex-cli", tier, json_path, "json");
            }
        }
    }
    if toml_path.is_file() {
        if let Ok(text) = std::fs::read_to_string(toml_path) {
            if let Ok(v) = toml::from_str::<toml::Value>(&text) {
                let Some(hooks) = v.get("hooks") else {
                    return Vec::new();
                };
                // Round-trip TOML→JSON via serde_json so the JSON-based
                // flattener can reuse its logic.
                if let Ok(json_v) = serde_json::to_value(hooks) {
                    return flatten_hooks_block(&json_v, "codex-cli", tier, toml_path, "toml");
                }
            }
        }
    }
    Vec::new()
}

/// Claude hooks: `~/.claude/settings.json` + `<project>/.claude/settings.json`
/// + `<project>/.claude/settings.local.json` (project-local overrides).
pub fn list_claude_hooks(home: &Path, project: Option<&Path>) -> Vec<Hook> {
    let mut all = scan_settings_hooks(
        &home.join(".claude").join("settings.json"),
        "claude-code",
        "user",
    );
    if let Some(p) = project {
        all.extend(scan_settings_hooks(
            &p.join(".claude").join("settings.json"),
            "claude-code",
            "project",
        ));
        all.extend(scan_settings_hooks(
            &p.join(".claude").join("settings.local.json"),
            "claude-code",
            "project",
        ));
    }
    all
}

/// Codex hooks: `~/.codex/hooks.json` (preferred) or `~/.codex/config.toml`
/// `[hooks]` (fallback). Same precedence in the project tier.
pub fn list_codex_hooks(home: &Path, project: Option<&Path>) -> Vec<Hook> {
    let mut all = scan_codex_hooks(
        &home.join(".codex").join("hooks.json"),
        &home.join(".codex").join("config.toml"),
        "user",
    );
    if let Some(p) = project {
        all.extend(scan_codex_hooks(
            &p.join(".codex").join("hooks.json"),
            &p.join(".codex").join("config.toml"),
            "project",
        ));
    }
    all
}

/// Provider-aware hook scanner — same dispatch shape as
/// `list_skills_for_provider`. Unknown tools return [].
pub fn list_hooks_for_provider(provider: &str, home: &Path, project: Option<&Path>) -> Vec<Hook> {
    match provider {
        "claude-code" => list_claude_hooks(home, project),
        "codex-cli" => list_codex_hooks(home, project),
        _ => Vec::new(),
    }
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

/// Walk a markdown commands directory recursively (one level deep,
/// matching the renderer's `/git:commit` style). Subdirectories become
/// namespaces. `force_namespace` pins every emitted Command to the
/// same namespace string (Codex prompts use this — every entry is
/// `/prompts:<name>`). Faithful with `_scan_md_commands`.
fn scan_md_commands(
    root: &Path,
    provider: &'static str,
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
            push_md_command(
                &p,
                provider,
                tier,
                force_namespace.map(String::from),
                &mut out,
            );
        } else if p.is_dir() {
            let ns = force_namespace
                .map(String::from)
                .or_else(|| p.file_name().and_then(|s| s.to_str()).map(String::from));
            if let Ok(sub) = std::fs::read_dir(&p) {
                for sub_entry in sub.flatten() {
                    let sp = sub_entry.path();
                    if sp.is_file() && sp.extension().and_then(|s| s.to_str()) == Some("md") {
                        push_md_command(&sp, provider, tier, ns.clone(), &mut out);
                    }
                }
            }
        }
    }
    out
}

fn push_md_command(
    md_path: &Path,
    provider: &'static str,
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
        provider,
        name,
        source_tier: tier,
        path: md_path.to_string_lossy().into_owned(),
        namespace,
        description: desc,
    });
}

/// Claude commands: `~/.claude/commands/**/*.md` + project equivalent.
pub fn list_claude_commands(home: &Path, project: Option<&Path>) -> Vec<Command> {
    let mut all = scan_md_commands(
        &home.join(".claude").join("commands"),
        "claude-code",
        "user",
        None,
    );
    if let Some(p) = project {
        all.extend(scan_md_commands(
            &p.join(".claude").join("commands"),
            "claude-code",
            "project",
            None,
        ));
    }
    all
}

/// Codex prompts: `~/.codex/prompts/*.md` (flat — no project tier).
/// Always namespaced as `/prompts:<name>` so the renderer can group
/// them under the same "Commands / Prompts" tab as the other tools.
pub fn list_codex_commands(home: &Path) -> Vec<Command> {
    scan_md_commands(
        &home.join(".codex").join("prompts"),
        "codex-cli",
        "user",
        Some("prompts"),
    )
}

/// Provider-aware command/prompt scanner — claude → md commands,
/// codex → md prompts (always namespaced).
pub fn list_commands_for_provider(
    provider: &str,
    home: &Path,
    project: Option<&Path>,
) -> Vec<Command> {
    match provider {
        "claude-code" => list_claude_commands(home, project),
        "codex-cli" => list_codex_commands(home),
        _ => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frontmatter_extracts_name_and_description() {
        let text = "---\nname: My Skill\ndescription: \"Does a thing\"\nother: ignore\n---\nbody";
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
    fn list_skills_for_provider_covers_codex_roots() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");

        // Shared cross-tool dir: ~/.agents/skills/agent-skill.
        let a = home.join(".agents/skills/agent-skill");
        std::fs::create_dir_all(&a).unwrap();
        std::fs::write(a.join("SKILL.md"), "body").unwrap();

        // Codex: ~/.codex/skills/codex-x. (/etc/codex/skills not
        // writable in test — but list_skills_for_provider still tries
        // to scan it; that's fine, scan_root returns [] on missing.)
        let c = home.join(".codex/skills/codex-x");
        std::fs::create_dir_all(&c).unwrap();
        std::fs::write(c.join("SKILL.md"), "body").unwrap();
        let cx = list_skills_for_provider("codex-cli", &home, None);
        assert!(cx.iter().any(|s| s.name == "codex-x"));
        assert!(cx.iter().any(|s| s.name == "agent-skill"));
        assert!(cx.iter().all(|s| s.provider == "codex-cli"));
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
        let posts: Vec<&Hook> = items.iter().filter(|h| h.event == "PostToolUse").collect();
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
    fn list_codex_hooks_prefers_json_over_toml() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        std::fs::create_dir_all(home.join(".codex")).unwrap();
        std::fs::write(
            home.join(".codex/hooks.json"),
            r#"{"hooks":{"PostToolUse":[{"hooks":[{"command":"from-json"}]}]}}"#,
        )
        .unwrap();
        std::fs::write(
            home.join(".codex/config.toml"),
            r#"[hooks.PostToolUse]
                  command = "from-toml"
                "#,
        )
        .unwrap();
        let items = list_codex_hooks(&home, None);
        // hooks.json wins.
        assert!(items.iter().any(|h| h.command == "from-json"));
        assert!(!items.iter().any(|h| h.command == "from-toml"));
        assert_eq!(items[0].config_format, "json");
    }

    #[test]
    fn list_codex_hooks_falls_back_to_config_toml() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        std::fs::create_dir_all(home.join(".codex")).unwrap();
        // Only TOML present.
        std::fs::write(
            home.join(".codex/config.toml"),
            "[[hooks.PostToolUse]]\nmatcher = \"Bash\"\ncommand = \"echo done\"\n",
        )
        .unwrap();
        let items = list_codex_hooks(&home, None);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].command, "echo done");
        assert_eq!(items[0].config_format, "toml");
    }

    #[test]
    fn list_codex_commands_namespaces_everything_as_prompts() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        let cmd_root = home.join(".codex/prompts");
        std::fs::create_dir_all(&cmd_root).unwrap();
        std::fs::write(
            cmd_root.join("review.md"),
            "---\ndescription: review the diff\n---\nbody",
        )
        .unwrap();
        let cmds = list_codex_commands(&home);
        assert_eq!(cmds.len(), 1);
        assert_eq!(cmds[0].namespace.as_deref(), Some("prompts"));
        assert_eq!(cmds[0].name, "review");
        assert_eq!(cmds[0].provider, "codex-cli");
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
        assert_eq!(foo.provider, "claude-code");
        let bar = items.iter().find(|s| s.source_tier == "project").unwrap();
        assert_eq!(bar.name, "bar"); // fallback to directory name
        assert!(bar.description.is_none());
    }
}
