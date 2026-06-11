//! Library item types — user-authored content (prompts/skills/commands/hooks/
//! templates) stored under `~/.fleetify/library/`, distinct from plugins.

use serde::{Deserialize, Serialize};

use crate::services::plugins::hook_merge::HookMergeRecord;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LibraryKind {
    Prompt,
    Skill,
    Command,
    Hook,
    Template,
}

impl LibraryKind {
    /// Parse the lowercase wire form (matches `#[serde(rename_all)]`).
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "prompt" => Some(Self::Prompt),
            "skill" => Some(Self::Skill),
            "command" => Some(Self::Command),
            "hook" => Some(Self::Hook),
            "template" => Some(Self::Template),
            _ => None,
        }
    }

    /// Whether this kind targets specific providers (skill/command/hook) vs.
    /// being provider-agnostic (prompt) or app-level metadata (template).
    pub fn is_provider_scoped(self) -> bool {
        matches!(self, Self::Skill | Self::Command | Self::Hook)
    }
}

/// One on-disk artifact a library item wrote, recorded so deletion can reverse
/// it precisely.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Materialized {
    pub provider: String,
    pub path: String,
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
        assert_eq!(LibraryKind::parse("nope"), None);
        assert!(LibraryKind::Command.is_provider_scoped());
        assert!(!LibraryKind::Prompt.is_provider_scoped());
        assert!(!LibraryKind::Template.is_provider_scoped());
    }
}
