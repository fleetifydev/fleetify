//! Global Fleet rules file (`<fleetify_home>/FLEET.md`). Edited from
//! Settings → Rules (router: `routers::fleet`); injected into the
//! staff/orchestrator system prompt by `services::staff_prompt`. Project
//! rules (CLAUDE.md/AGENTS.md) are a separate concern (`agentic::context`).

use std::path::{Path, PathBuf};

/// Max chars of FLEET.md spliced into the staff prompt, so a huge rules file
/// can't crowd out the dispatch protocol. Char-based (UTF-8 safe). Independent
/// of the README cap in `agentic::context` (that one is 5k, byte-based).
const RULES_BUDGET: usize = 8_000;

pub fn rules_path(home: &Path) -> PathBuf {
    home.join("FLEET.md")
}

/// Raw current contents for the editor (GET /api/fleet/rules). Missing or
/// unreadable file → empty string.
pub fn read_raw(home: &Path) -> String {
    std::fs::read_to_string(rules_path(home)).unwrap_or_default()
}

/// Trimmed, capped contents for prompt injection. `None` when the file is
/// absent, empty, or whitespace-only.
pub fn read_for_prompt(home: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(rules_path(home)).ok()?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.chars().count() > RULES_BUDGET {
        let capped: String = trimmed.chars().take(RULES_BUDGET).collect();
        Some(format!("{capped}\n[truncated at {RULES_BUDGET} chars]"))
    } else {
        Some(trimmed.to_string())
    }
}

/// Persist the editor's content. Empty/whitespace → delete the file so
/// "rules exist" cleanly means "has content". Creates the home dir as needed.
pub fn save(home: &Path, content: &str) -> std::io::Result<()> {
    let path = rules_path(home);
    if content.trim().is_empty() {
        match std::fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e),
        }
    } else {
        std::fs::create_dir_all(home)?;
        std::fs::write(&path, content)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn absent_file_reads_empty_and_none() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(read_raw(dir.path()), "");
        assert!(read_for_prompt(dir.path()).is_none());
    }

    #[test]
    fn save_then_read_roundtrips() {
        let dir = tempfile::tempdir().unwrap();
        save(dir.path(), "Be concise.").unwrap();
        assert_eq!(read_raw(dir.path()), "Be concise.");
        assert_eq!(read_for_prompt(dir.path()).as_deref(), Some("Be concise."));
    }

    #[test]
    fn whitespace_only_is_none_for_prompt() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(rules_path(dir.path()), "   \n\t ").unwrap();
        assert!(read_for_prompt(dir.path()).is_none());
    }

    #[test]
    fn empty_save_deletes_file() {
        let dir = tempfile::tempdir().unwrap();
        save(dir.path(), "rules").unwrap();
        assert!(rules_path(dir.path()).exists());
        save(dir.path(), "   ").unwrap();
        assert!(!rules_path(dir.path()).exists());
        save(dir.path(), "").unwrap(); // deleting an already-absent file is ok
    }

    #[test]
    fn oversize_is_truncated() {
        let dir = tempfile::tempdir().unwrap();
        let big = "a".repeat(RULES_BUDGET + 500);
        save(dir.path(), &big).unwrap();
        let got = read_for_prompt(dir.path()).unwrap();
        assert!(got.contains("[truncated at 8000 chars]"));
        assert!(got.chars().count() < big.chars().count());
    }
}
