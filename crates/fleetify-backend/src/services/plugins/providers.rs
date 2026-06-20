//! Per-provider on-disk layout registry for plugin materialization.
//!
//! Single source of truth for WHERE each CLI agent reads its skills,
//! slash-commands, sub-agents, and hooks. The home dir is NOT always
//! `~/.{provider}` — OpenCode uses XDG `~/.config/opencode`, Antigravity
//! CLI uses `~/.gemini/antigravity-cli`, and Hermes keeps its data under
//! `%LOCALAPPDATA%\hermes` on Windows. These paths are verified against
//! each vendor's docs AND the app's own bridge/auth resolution — see
//! `docs/MARKETPLACE.md`.
//!
//! Skills are the one universal, drop-in-compatible component (every
//! agent reads `skills/<name>/SKILL.md` with `name`+`description`
//! frontmatter). Hooks and sub-agents are provider-specific in format and
//! location; this module classifies each so the materializer can pick the
//! right strategy.

use std::path::PathBuf;

/// Every CLI-agent provider whose plugin components can be materialized to
/// disk. `antigravity-sdk` is intentionally excluded — it has no on-disk
/// config home (it authenticates via `GEMINI_API_KEY`), so only its MCP
/// servers materialize (through the shared registry, not a home dir).
pub const COMPONENT_PROVIDERS: &[&str] = &[
    "claude-code",
    "codex-cli",
    "gemini-cli",
    "kimi-code",
    "opencode",
    "github-copilot",
    "cursor-cli",
    "hermes-agent",
    "antigravity-cli",
    "grok-build",
];

/// How a provider consumes lifecycle hooks. Drives the materializer's
/// per-provider strategy: a standalone file/dir we can copy, or a shared
/// config file we must carefully merge into (and un-merge on uninstall).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HookStrategy {
    /// Copy `<plugin>__<name>.json` into a standalone hooks dir
    /// (GitHub Copilot `~/.copilot/hooks/`).
    CopyJsonFile,
    /// Copy `<plugin>__<name>.ts` into a plugins dir (OpenCode
    /// `~/.config/opencode/plugins/` — hooks are JS/TS plugin modules).
    CopyTsPlugin,
    /// Copy a `<plugin>__<name>/` dir (Hermes `~/.hermes/hooks/<name>/`
    /// holding `HOOK.yaml` + `handler.py`).
    CopyDir,
    /// Merge namespaced entries into a shared JSON file's top-level
    /// `hooks` object (Claude `settings.json`, Cursor/agy `hooks.json`).
    MergeJson {
        file: &'static str,
        key: &'static str,
    },
    /// Merge namespaced `[[hooks]]` array entries into a shared TOML file
    /// (Kimi `config.toml`).
    MergeToml { file: &'static str },
    /// Provider has no documented hook surface — skip.
    Unsupported,
}

fn home() -> Option<PathBuf> {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()
        .map(PathBuf::from)
}

/// The config-home base directory a provider reads its components from.
/// `None` for providers without an on-disk home (e.g. `antigravity-sdk`)
/// or when neither `USERPROFILE` nor `HOME` is set.
pub fn provider_home(provider: &str) -> Option<PathBuf> {
    let h = home()?;
    let p = match provider {
        "claude-code" => h.join(".claude"),
        "codex-cli" => h.join(".codex"),
        "gemini-cli" => h.join(".gemini"),
        "kimi-code" => h.join(".kimi"),
        // XDG-style, even on Windows under %USERPROFILE% (per OpenCode docs).
        "opencode" => h.join(".config").join("opencode"),
        "github-copilot" => h.join(".copilot"),
        "cursor-cli" => h.join(".cursor"),
        "hermes-agent" => hermes_home(&h),
        // Antigravity CLI stages everything under the Gemini namespace.
        "antigravity-cli" => h.join(".gemini").join("antigravity-cli"),
        // Grok Build reads skills from `~/.grok/skills/` and instruction files
        // (the AGENTS.md family) from `~/.grok/` — xAI docs: "Skills, Plugins &
        // Marketplaces". Routing id is `grok-build`; vendor dotdir is `.grok`
        // (see `component_basename`).
        "grok-build" => h.join(".grok"),
        _ => return None,
    };
    Some(p)
}

/// The `.{basename}/` directory name a **plugin** uses to ship a provider's
/// components (e.g. `.codex/skills/`, `.claude/commands/`). Plugins organise by
/// the VENDOR name — the same name the real agent reads on disk — which for the
/// suffix-renamed CLI ids differs from the routing id (`codex-cli` → `.codex`).
/// This is the structural complement to `provider_home` (where the agent reads),
/// not a legacy-id alias. Identity for ids that were never suffixed
/// (`opencode`, `github-copilot`, `antigravity-sdk`).
pub fn component_basename(provider: &str) -> &str {
    match provider {
        "claude-code" => "claude",
        "codex-cli" => "codex",
        "gemini-cli" => "gemini",
        "kimi-code" => "kimi",
        "cursor-cli" => "cursor",
        "hermes-agent" => "hermes",
        "antigravity-cli" => "agy",
        // Routing id `grok-build` → vendor dotdir `.grok` (xAI ships skills under
        // `.grok/skills/`, matching the agent's on-disk read path).
        "grok-build" => "grok",
        other => other,
    }
}

/// Hermes keeps native data under `%LOCALAPPDATA%\hermes` on Windows,
/// `~/.hermes` elsewhere (WSL also uses `~/.hermes`).
fn hermes_home(h: &std::path::Path) -> PathBuf {
    #[cfg(windows)]
    {
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            return PathBuf::from(local).join("hermes");
        }
    }
    h.join(".hermes")
}

/// Where a provider discovers skills — the dir that holds
/// `<skill>/SKILL.md` subdirectories. Every component provider supports
/// skills (the universal Agent-Skills format), so this is `Some` for all
/// of `COMPONENT_PROVIDERS`.
pub fn skills_dir(provider: &str) -> Option<PathBuf> {
    Some(provider_home(provider)?.join("skills"))
}

/// The shared `~/.agents/skills/` location from the Agent-Skills open standard.
/// Codex (USER scope), Gemini, GitHub Copilot, Cursor and Kimi all read it, so
/// writing a skill here makes it discoverable cross-tool independent of each
/// agent's own home dir. `None` only when no home dir resolves.
pub fn agents_skills_dir() -> Option<PathBuf> {
    Some(home()?.join(".agents").join("skills"))
}

/// Where a provider reads slash-commands / prompts, if it has such a
/// surface. Claude / Gemini / OpenCode use `commands/<name>.md`; Codex
/// uses `prompts/<name>.md`. The rest expose commands only via skills
/// (`/skill-name`), so they return `None`.
pub fn commands_dir(provider: &str) -> Option<PathBuf> {
    let sub = match provider {
        "claude-code" | "gemini-cli" | "opencode" => "commands",
        "codex-cli" => "prompts",
        _ => return None,
    };
    Some(provider_home(provider)?.join(sub))
}

/// Where a provider reads markdown sub-agents, plus the file extension it
/// expects. Most agents use a plain `.md` in `<home>/agents/`; GitHub Copilot
/// uses the distinctive `.agent.md`. **Codex is excluded here** — its agents
/// are TOML, converted by the library subagent materializer rather than copied
/// verbatim like the plugin path does. Kimi and Hermes have no on-disk
/// per-agent file → `None`.
pub fn agents_dir(provider: &str) -> Option<(PathBuf, &'static str)> {
    let (sub, ext) = match provider {
        "claude-code" | "opencode" | "antigravity-cli" | "gemini-cli" | "cursor-cli" => {
            ("agents", "md")
        }
        "github-copilot" => ("agents", "agent.md"),
        _ => return None,
    };
    Some((provider_home(provider)?.join(sub), ext))
}

/// Cursor's per-rule directory (`~/.cursor/rules/`). Cursor is the one rules
/// provider that uses standalone `.mdc` files (with `description`/`alwaysApply`
/// frontmatter) instead of merging into a single root rule file.
pub fn cursor_rules_dir() -> Option<PathBuf> {
    Some(provider_home("cursor-cli")?.join("rules"))
}

/// Where a provider's handler scripts are copied. `base = None` ⇒ the user
/// home; `Some(folder)` ⇒ a project dir's vendor dotdir. Antigravity diverges
/// to the Gemini namespace (global `~/.gemini/config/hooks`, folder
/// `<folder>/.agents/hooks`). Copilot/OpenCode use their own dirs below.
pub fn hooks_dir(provider: &str, base: Option<&std::path::Path>) -> Option<PathBuf> {
    match base {
        None => match provider {
            "antigravity-cli" => Some(provider_home("gemini-cli")?.join("config").join("hooks")),
            _ => Some(provider_home(provider)?.join("hooks")),
        },
        Some(folder) => match provider {
            "antigravity-cli" => Some(folder.join(".agents").join("hooks")),
            _ => Some(
                folder
                    .join(format!(".{}", component_basename(provider)))
                    .join("hooks"),
            ),
        },
    }
}

/// The config file a Command-mode merge writes into, for the given scope. The
/// global path mirrors the old `hook_merge::hook_file`; the folder path is the
/// project vendor dotdir. `None` for providers handled outside the merge engine
/// (Copilot/OpenCode/Hermes).
pub fn hook_config_file(provider: &str, base: Option<&std::path::Path>) -> Option<PathBuf> {
    let (sub, file): (Option<&str>, &str) = match provider {
        "claude-code" | "gemini-cli" => (None, "settings.json"),
        "codex-cli" | "cursor-cli" => (None, "hooks.json"),
        "kimi-code" => (None, "config.toml"),
        "antigravity-cli" => (Some("config"), "hooks.json"),
        _ => return None,
    };
    let root = match base {
        None => match provider {
            "antigravity-cli" => provider_home("gemini-cli")?,
            _ => provider_home(provider)?,
        },
        Some(folder) => match provider {
            "antigravity-cli" => folder.join(".agents"),
            _ => folder.join(format!(".{}", component_basename(provider))),
        },
    };
    let mut p = root;
    // Global antigravity nests under `config/`; folder scope uses `.agents/` flat.
    if let (Some(seg), None) = (sub, base) {
        p = p.join(seg);
    }
    Some(p.join(file))
}

/// OpenCode plugin dir: `~/.config/opencode/plugin/` (global) or
/// `<folder>/.opencode/plugin/` (project). Singular `plugin` per OpenCode docs.
pub fn opencode_plugin_dir(base: Option<&std::path::Path>) -> Option<PathBuf> {
    match base {
        None => Some(provider_home("opencode")?.join("plugin")),
        Some(folder) => Some(folder.join(".opencode").join("plugin")),
    }
}

/// Copilot hooks dir: `~/.copilot/hooks/` (global) or `<folder>/.github/hooks/`.
pub fn copilot_hooks_dir(base: Option<&std::path::Path>) -> Option<PathBuf> {
    match base {
        None => Some(provider_home("github-copilot")?.join("hooks")),
        Some(folder) => Some(folder.join(".github").join("hooks")),
    }
}

/// The hook-materialization strategy for a provider.
pub fn hook_strategy(provider: &str) -> HookStrategy {
    match provider {
        "claude-code" => HookStrategy::MergeJson {
            file: "settings.json",
            key: "hooks",
        },
        "cursor-cli" | "antigravity-cli" => HookStrategy::MergeJson {
            file: "hooks.json",
            key: "hooks",
        },
        "kimi-code" => HookStrategy::MergeToml {
            file: "config.toml",
        },
        "github-copilot" => HookStrategy::CopyJsonFile,
        "opencode" => HookStrategy::CopyTsPlugin,
        "hermes-agent" => HookStrategy::CopyDir,
        _ => HookStrategy::Unsupported,
    }
}

/// Namespace a `<plugin>` + `<component>` into a single token that is a
/// valid skill/agent id on EVERY provider. OpenCode and Cursor require the
/// frontmatter `name` to equal the directory name AND match
/// `^[a-z0-9]+(-[a-z0-9]+)*$` (no underscores) — so the legacy `plugin__name`
/// double-underscore scheme is illegal there. We join with a single hyphen
/// and sanitize: lowercase, non-`[a-z0-9-]` → `-`, collapse runs, trim.
pub fn namespaced_id(plugin: &str, component: &str) -> String {
    let raw = format!("{plugin}-{component}");
    let mut out = String::with_capacity(raw.len());
    let mut prev_dash = false;
    for ch in raw.chars() {
        let c = ch.to_ascii_lowercase();
        let ok = c.is_ascii_lowercase() || c.is_ascii_digit();
        if ok {
            out.push(c);
            prev_dash = false;
        } else if !prev_dash {
            out.push('-');
            prev_dash = true;
        }
    }
    out.trim_matches('-').to_string()
}

/// The on-disk prefix used to detect a plugin's materialized artifacts for
/// cleanup. Kept distinct from `namespaced_id` because uninstall walks dirs
/// by prefix: every artifact this plugin writes starts with `<plugin>-`.
pub fn cleanup_prefix(plugin: &str) -> String {
    format!("{}-", namespaced_id(plugin, ""))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn namespaced_id_is_valid_on_strict_providers() {
        // No underscores; matches ^[a-z0-9]+(-[a-z0-9]+)*$.
        let id = namespaced_id("diff-summarizer", "diff-summarizer");
        assert_eq!(id, "diff-summarizer-diff-summarizer");
        assert!(is_agentskills_valid(&id));
        // Sanitization: uppercase + junk collapse to hyphen-clean.
        let id2 = namespaced_id("My_Plugin", "Cool Skill!");
        assert_eq!(id2, "my-plugin-cool-skill");
        assert!(is_agentskills_valid(&id2));
    }

    /// Mirror of OpenCode/Cursor's skill-name regex `^[a-z0-9]+(-[a-z0-9]+)*$`.
    fn is_agentskills_valid(s: &str) -> bool {
        !s.is_empty()
            && !s.starts_with('-')
            && !s.ends_with('-')
            && !s.contains("--")
            && s.bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    }

    /// Run `f` with HOME/USERPROFILE pinned, under the shared lock so we
    /// don't race other modules' env-mutating tests, then restore.
    fn with_home<R>(f: impl FnOnce() -> R) -> R {
        let _g = crate::test_support::home_lock()
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let key = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
        let prev = std::env::var(key).ok();
        std::env::set_var(key, "/tmp/fake-home-providers");
        let r = f();
        match prev {
            Some(v) => std::env::set_var(key, v),
            None => std::env::remove_var(key),
        }
        r
    }

    #[test]
    fn component_providers_all_resolve_a_skills_dir() {
        with_home(|| {
            for p in COMPONENT_PROVIDERS {
                assert!(skills_dir(p).is_some(), "{p} should have a skills dir");
            }
            // The SDK has no home → no skills dir.
            assert!(skills_dir("antigravity-sdk").is_none());
        });
    }

    #[test]
    fn opencode_and_agy_homes_are_not_naive_dot_provider() {
        with_home(|| {
            assert!(provider_home("opencode").unwrap().ends_with("opencode"));
            assert!(provider_home("opencode")
                .unwrap()
                .to_string_lossy()
                .contains(".config"));
            assert!(provider_home("antigravity-cli")
                .unwrap()
                .ends_with("antigravity-cli"));
        });
    }

    #[test]
    fn grok_build_materializes_to_dot_grok() {
        with_home(|| {
            // Routing id `grok-build` → on-disk vendor dir `.grok` (xAI docs:
            // skills live in `~/.grok/skills/`, instructions in `~/.grok/`).
            assert!(provider_home("grok-build").unwrap().ends_with(".grok"));
            assert_eq!(component_basename("grok-build"), "grok");
            assert!(skills_dir("grok-build").unwrap().ends_with(".grok/skills"));
            // Hooks are deferred — Grok's native `~/.grok/hooks/` definition
            // format is documented in-app only, so the strategy stays Unsupported
            // (Grok still reads Claude Code hooks via zero-config compatibility).
            assert_eq!(hook_strategy("grok-build"), HookStrategy::Unsupported);
        });
    }

    #[test]
    fn hook_strategy_classifies_merge_vs_copy() {
        assert!(matches!(
            hook_strategy("claude-code"),
            HookStrategy::MergeJson { .. }
        ));
        assert!(matches!(
            hook_strategy("kimi-code"),
            HookStrategy::MergeToml { .. }
        ));
        assert_eq!(hook_strategy("github-copilot"), HookStrategy::CopyJsonFile);
        assert_eq!(hook_strategy("opencode"), HookStrategy::CopyTsPlugin);
        assert_eq!(hook_strategy("hermes-agent"), HookStrategy::CopyDir);
        assert_eq!(hook_strategy("codex-cli"), HookStrategy::Unsupported);
    }

    #[test]
    fn hooks_dir_global_and_folder() {
        with_home(|| {
            let g = hooks_dir("claude-code", None).unwrap();
            assert!(g.ends_with(".claude/hooks"));
            let f = hooks_dir("claude-code", Some(std::path::Path::new("/proj"))).unwrap();
            assert!(f.ends_with(".claude/hooks"));
            assert!(f.to_string_lossy().contains("proj"));
            // antigravity global diverges to ~/.gemini/config/hooks.
            let a = hooks_dir("antigravity-cli", None).unwrap();
            assert!(a.to_string_lossy().contains(".gemini"));
            assert!(a.ends_with("config/hooks"));
        });
    }

    #[test]
    fn hook_config_file_paths() {
        with_home(|| {
            assert!(hook_config_file("gemini-cli", None)
                .unwrap()
                .ends_with(".gemini/settings.json"));
            assert!(hook_config_file("codex-cli", None)
                .unwrap()
                .ends_with(".codex/hooks.json"));
            assert!(hook_config_file("antigravity-cli", None)
                .unwrap()
                .ends_with(".gemini/config/hooks.json"));
            assert!(
                hook_config_file("claude-code", Some(std::path::Path::new("/p")))
                    .unwrap()
                    .ends_with(".claude/settings.json")
            );
            // Copilot/OpenCode aren't merge providers.
            assert!(hook_config_file("github-copilot", None).is_none());
        });
    }

    #[test]
    fn opencode_plugin_dir_is_singular() {
        with_home(|| {
            let d = opencode_plugin_dir(None).unwrap();
            assert!(d.ends_with("opencode/plugin"));
            assert!(copilot_hooks_dir(None).unwrap().ends_with(".copilot/hooks"));
        });
    }
}
