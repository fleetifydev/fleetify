//! Library item types — user-authored content (prompts/skills/commands/hooks/
//! templates) stored under `~/.fleetify/library/`, distinct from plugins.

use serde::{Deserialize, Serialize};

use crate::services::plugins::hook_merge::HookMergeRecord;
use crate::services::plugins::rule_merge::RuleMergeRecord;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LibraryKind {
    Prompt,
    Skill,
    Hook,
    Template,
    /// A named delegate agent (`<provider>/agents/<slug>.md`, cross-tool
    /// Agent-Skills-style frontmatter; Codex gets a `.toml`).
    Subagent,
    /// Persistent project instructions merged into each provider's user-global
    /// rule file (CLAUDE.md / AGENTS.md / GEMINI.md, or Cursor's `.mdc`).
    Rule,
}

impl LibraryKind {
    /// Parse the lowercase wire form (matches `#[serde(rename_all)]`).
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "prompt" => Some(Self::Prompt),
            "skill" => Some(Self::Skill),
            "hook" => Some(Self::Hook),
            "template" => Some(Self::Template),
            "subagent" => Some(Self::Subagent),
            "rule" => Some(Self::Rule),
            _ => None,
        }
    }

    /// Whether this kind targets specific providers (skill/hook/subagent/rule)
    /// vs. being provider-agnostic (prompt) or app-level metadata (template).
    pub fn is_provider_scoped(self) -> bool {
        matches!(self, Self::Skill | Self::Hook | Self::Subagent | Self::Rule)
    }
}

/// One on-disk artifact a library item wrote, recorded so deletion can reverse
/// it precisely.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Materialized {
    pub provider: String,
    pub path: String,
}

/// Which rule "shape" (modal tab) produced a `Rule` item — each maps to a
/// distinct on-disk format and provider set.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum RuleFormat {
    /// Plain markdown merged into CLAUDE.md / GEMINI.md / AGENTS.md.
    #[default]
    General,
    /// Cursor `.mdc` with rule-type frontmatter.
    Cursor,
    /// GitHub Copilot — `copilot-instructions.md`, or a
    /// `.github/instructions/<slug>.instructions.md` path file with `applyTo`.
    Copilot,
}

/// Where a rule is written: the user-global home, or a chosen project folder.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum RuleScope {
    #[default]
    Global,
    Folder,
}

/// Cursor rule type → `.mdc` frontmatter (per cursor.com/docs/rules).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum CursorRuleType {
    /// `alwaysApply: true` — always included.
    #[default]
    Always,
    /// `description:` + `alwaysApply: false` — agent includes when relevant.
    Intelligent,
    /// `globs:` + `alwaysApply: false` — auto-attached on matching files.
    Specific,
    /// `alwaysApply: false`, no description/globs — only on `@`-mention.
    Manual,
}

/// Extra configuration for a `Rule` item: the format/scope and the
/// format-specific bits. `None` on an item ⇒ a legacy global "general" rule
/// (back-compat with rules authored before this field existed).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct RuleSpec {
    #[serde(default)]
    pub format: RuleFormat,
    #[serde(default)]
    pub scope: RuleScope,
    /// Absolute folder path when `scope == Folder`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folder: Option<String>,
    /// Cursor rule type (only when `format == Cursor`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor_rule_type: Option<CursorRuleType>,
    /// Glob patterns — Cursor "specific files" globs or Copilot `applyTo` (CSV).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub globs: Option<String>,
}

/// A user-authored library item. `slug` is the on-disk id (no plugin prefix);
/// `materialized` records every path written so delete is a clean reverse.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LibraryItem {
    pub id: String,
    pub kind: LibraryKind,
    pub name: String,
    pub slug: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default)]
    pub providers: Vec<String>,
    #[serde(default)]
    pub materialized: Vec<Materialized>,
    /// Reversal records for merge-strategy hooks (Claude/Cursor/agy/Kimi),
    /// which merge into a shared config rather than writing a standalone file.
    #[serde(default)]
    pub hook_merge: Vec<HookMergeRecord>,
    /// Reversal records for rules merged as a marked block into a provider's
    /// global rule file (CLAUDE.md / AGENTS.md / …). Cursor's `.mdc` is a
    /// standalone file recorded in `materialized` instead.
    #[serde(default)]
    pub rule_merge: Vec<RuleMergeRecord>,
    /// Extra rule configuration (format / scope / folder / cursor-type / globs).
    /// Only present on `Rule` items; `None` ⇒ a legacy global general rule.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rule_spec: Option<RuleSpec>,
    pub created_at: String,
    pub updated_at: String,
}

/// Slug rule shared with skill/command on-disk ids: `^[a-z0-9][a-z0-9-]*$`
/// (lowercase, digits, hyphens; no leading hyphen; no underscores — OpenCode/
/// Cursor reject those).
pub fn is_valid_slug(s: &str) -> bool {
    let mut chars = s.chars();
    match chars.next() {
        Some(c) if c.is_ascii_lowercase() || c.is_ascii_digit() => {}
        _ => return false,
    }
    s.chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slug_validation() {
        assert!(is_valid_slug("my-skill"));
        assert!(is_valid_slug("abc123"));
        assert!(!is_valid_slug("-leading"));
        assert!(!is_valid_slug("Upper"));
        assert!(!is_valid_slug("under_score"));
        assert!(!is_valid_slug(""));
    }

    #[test]
    fn kind_parse_and_scope() {
        assert_eq!(LibraryKind::parse("skill"), Some(LibraryKind::Skill));
        assert_eq!(LibraryKind::parse("command"), None);
        assert_eq!(LibraryKind::parse("nope"), None);
        assert_eq!(LibraryKind::parse("subagent"), Some(LibraryKind::Subagent));
        assert_eq!(LibraryKind::parse("rule"), Some(LibraryKind::Rule));
        assert!(LibraryKind::Hook.is_provider_scoped());
        assert!(LibraryKind::Subagent.is_provider_scoped());
        assert!(LibraryKind::Rule.is_provider_scoped());
        assert!(!LibraryKind::Prompt.is_provider_scoped());
        assert!(!LibraryKind::Template.is_provider_scoped());
    }
}
