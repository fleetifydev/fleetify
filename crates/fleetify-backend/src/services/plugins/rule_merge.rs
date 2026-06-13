//! Rule materialization: append a slug-fenced markdown block to a provider's
//! **user-global** rule file (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, …)
//! so a Library rule coexists with the user's own instructions and un-merges
//! precisely on delete. Cursor is NOT handled here — its rules are standalone
//! `~/.cursor/rules/<slug>.mdc` files written directly by the materializer.

use std::path::{Path, PathBuf};

use anyhow::Result;
use serde::{Deserialize, Serialize};

/// Reversal record: the file a rule block was appended to + the slug that
/// fences it. Delete strips exactly that block, leaving the rest of the file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RuleMergeRecord {
    pub provider: String,
    pub file: String,
    pub slug: String,
}

fn start_marker(slug: &str) -> String {
    format!("<!-- fleetify:rule:{slug} START -->")
}
fn end_marker(slug: &str) -> String {
    format!("<!-- fleetify:rule:{slug} END -->")
}

/// The user-global rule file a provider reads, or `None` for providers without
/// a single-file merge target (Cursor uses standalone `.mdc`; Hermes is
/// profile-identity, not project rules).
pub fn rule_file(provider: &str) -> Option<PathBuf> {
    let h = super::providers::provider_home(provider)?;
    let name = match provider {
        "claude-code" => "CLAUDE.md",
        "gemini-cli" => "GEMINI.md",
        "codex-cli" | "kimi-code" | "opencode" | "antigravity-cli" => "AGENTS.md",
        "github-copilot" => "copilot-instructions.md",
        _ => return None,
    };
    Some(h.join(name))
}

/// The rule file a provider reads from a **project / working directory** `dir`
/// (as opposed to the user-global home `rule_file`). Used for session-scoped
/// rules — the provider spawns in the session's working dir and reads these.
/// Copilot reads `.github/copilot-instructions.md`; `None` for providers with
/// no project rule-file convention (Cursor uses `.cursor/rules/*.mdc`, handled
/// by the materializer; Hermes has none).
pub fn project_rule_file(provider: &str, dir: &Path) -> Option<PathBuf> {
    let p = match provider {
        "claude-code" => dir.join("CLAUDE.md"),
        "gemini-cli" => dir.join("GEMINI.md"),
        "codex-cli" | "kimi-code" | "opencode" | "antigravity-cli" => dir.join("AGENTS.md"),
        "github-copilot" => dir.join(".github").join("copilot-instructions.md"),
        _ => return None,
    };
    Some(p)
}

/// Append the rule's marked block to `file` (idempotent — an existing block for
/// the same slug is replaced). Used for both the user-global merge and
/// session-scoped project files (caller passes the explicit `file`).
pub fn write_block(provider: &str, slug: &str, body: &str, file: &Path) -> Result<RuleMergeRecord> {
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let existing = std::fs::read_to_string(file).unwrap_or_default();
    let stripped = strip_block(&existing, slug);
    let block = format!(
        "{}\n{}\n{}",
        start_marker(slug),
        body.trim_end(),
        end_marker(slug)
    );
    let mut out = stripped.trim_end().to_string();
    if !out.is_empty() {
        out.push_str("\n\n");
    }
    out.push_str(&block);
    out.push('\n');
    std::fs::write(file, out)?;
    Ok(RuleMergeRecord {
        provider: provider.to_string(),
        file: file.to_string_lossy().into_owned(),
        slug: slug.to_string(),
    })
}

/// Merge a rule into `provider`'s user-global rule file. `None` when the
/// provider has no single-file target (e.g. Cursor).
pub fn materialize_rule(provider: &str, slug: &str, body: &str) -> Result<Option<RuleMergeRecord>> {
    let Some(file) = rule_file(provider) else {
        return Ok(None);
    };
    Ok(Some(write_block(provider, slug, body, &file)?))
}

/// Reverse a merge: strip the slug-fenced block from the recorded file, leaving
/// any other content intact.
pub fn unmaterialize_rule(rec: &RuleMergeRecord) {
    let p = Path::new(&rec.file);
    let Ok(existing) = std::fs::read_to_string(p) else {
        return;
    };
    let trimmed = strip_block(&existing, &rec.slug);
    let trimmed = trimmed.trim_end();
    // Leave the file in place (never delete the user's rule file) — write the
    // remaining content, or empty if our block was all it held.
    let _ = std::fs::write(
        p,
        if trimmed.is_empty() {
            String::new()
        } else {
            format!("{trimmed}\n")
        },
    );
}

/// Remove the `START … END` block for `slug` (inclusive of both markers and the
/// blank line that followed it). No-op when the block is absent.
fn strip_block(content: &str, slug: &str) -> String {
    let start = start_marker(slug);
    let end = end_marker(slug);
    let Some(s) = content.find(&start) else {
        return content.to_string();
    };
    let Some(e_rel) = content[s..].find(&end) else {
        return content.to_string();
    };
    let e = s + e_rel + end.len();
    let mut out = String::with_capacity(content.len());
    out.push_str(content[..s].trim_end_matches(['\r', '\n']));
    let tail = content[e..].trim_start_matches(['\r', '\n']);
    if !out.is_empty() && !tail.is_empty() {
        out.push_str("\n\n");
    }
    out.push_str(tail);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn write_then_strip_round_trips_and_preserves_user_content() {
        let tmp = tempdir().unwrap();
        let file = tmp.path().join("AGENTS.md");
        std::fs::write(&file, "# My own rules\n\nUse tabs.\n").unwrap();

        let rec = write_block("codex-cli", "no-emoji", "Never use emoji.", &file).unwrap();
        let after = std::fs::read_to_string(&file).unwrap();
        assert!(after.contains("# My own rules"));
        assert!(after.contains("Never use emoji."));
        assert!(after.contains("fleetify:rule:no-emoji START"));

        unmaterialize_rule(&rec);
        let reverted = std::fs::read_to_string(&file).unwrap();
        assert!(reverted.contains("# My own rules"));
        assert!(!reverted.contains("Never use emoji."));
        assert!(!reverted.contains("fleetify:rule"));
    }

    #[test]
    fn write_block_replaces_same_slug_idempotently() {
        let tmp = tempdir().unwrap();
        let file = tmp.path().join("CLAUDE.md");
        write_block("claude-code", "x", "first", &file).unwrap();
        write_block("claude-code", "x", "second", &file).unwrap();
        let after = std::fs::read_to_string(&file).unwrap();
        assert!(after.contains("second"));
        assert!(!after.contains("first"));
        assert_eq!(after.matches("fleetify:rule:x START").count(), 1);
    }

    #[test]
    fn rule_file_targets_per_provider() {
        // provider_home reads USERPROFILE/HOME; just assert the file name logic.
        std::env::set_var("USERPROFILE", "/tmp/fakehome");
        assert!(rule_file("claude-code").unwrap().ends_with("CLAUDE.md"));
        assert!(rule_file("gemini-cli").unwrap().ends_with("GEMINI.md"));
        assert!(rule_file("codex-cli").unwrap().ends_with("AGENTS.md"));
        assert!(rule_file("github-copilot")
            .unwrap()
            .ends_with("copilot-instructions.md"));
        assert!(rule_file("cursor-cli").is_none());
        assert!(rule_file("hermes-agent").is_none());
    }
}
