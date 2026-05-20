//! Shared, I/O-free domain types for the Fleetify backend + shell.

use std::path::{Path, PathBuf};

/// Backend wire-protocol version. Bumped only on breaking WS/REST changes.
pub const PROTOCOL_VERSION: u32 = 1;

/// `std::fs::canonicalize` returns Windows verbatim-prefixed paths
/// (`\\?\C:\…`). Several downstream tools (the Gemini ACP server, git,
/// the claude CLI on some node versions) treat these as malformed and
/// return cryptic errors — verified for gemini-cli 0.42.0, which fails
/// `session/new` with `-32603 Internal error / EISDIR: illegal
/// operation on a directory, lstat 'C:'` when handed a `\\?\` path.
/// This helper strips that prefix when it's the only thing making the
/// path non-portable; the resulting path is identical to what the user
/// typed but absolute + symlink-resolved.
///
/// On non-Windows targets this is a thin alias for `canonicalize`.
pub fn canonicalize_no_verbatim(p: &Path) -> std::io::Result<PathBuf> {
    let resolved = std::fs::canonicalize(p)?;
    Ok(strip_verbatim_prefix(&resolved))
}

/// Like `canonicalize_no_verbatim` but never errors — falls back to the
/// input path when canonicalize fails (parity with existing call sites
/// that swallow the error to keep best-effort path normalization).
pub fn canonicalize_or_keep(p: &Path) -> PathBuf {
    canonicalize_no_verbatim(p).unwrap_or_else(|_| p.to_path_buf())
}

/// Strip the Windows verbatim (`\\?\`) and UNC verbatim
/// (`\\?\UNC\server\share` → `\\server\share`) prefixes from a path.
/// Idempotent and a no-op on non-Windows targets.
pub fn strip_verbatim_prefix(p: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        let s = p.to_string_lossy();
        if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{rest}"));
        }
        if let Some(rest) = s.strip_prefix(r"\\?\") {
            return PathBuf::from(rest.to_string());
        }
    }
    p.to_path_buf()
}

/// Top-level error shared across crates. Concrete variants are added per phase.
#[derive(Debug, thiserror::Error)]
pub enum FleetError {
    #[error("not found: {0}")]
    NotFound(String),
    #[error("unauthorized")]
    Unauthorized,
    #[error("{0}")]
    Other(String),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protocol_version_is_one() {
        assert_eq!(PROTOCOL_VERSION, 1);
    }

    #[test]
    fn fleet_error_displays() {
        assert_eq!(FleetError::NotFound("x".into()).to_string(), "not found: x");
        assert_eq!(FleetError::Unauthorized.to_string(), "unauthorized");
    }

    #[test]
    #[cfg(windows)]
    fn strip_verbatim_prefix_removes_windows_verbatim_and_unc() {
        assert_eq!(
            strip_verbatim_prefix(Path::new(r"\\?\C:\Users\loseu")),
            PathBuf::from(r"C:\Users\loseu"),
        );
        assert_eq!(
            strip_verbatim_prefix(Path::new(r"\\?\UNC\server\share\dir")),
            PathBuf::from(r"\\server\share\dir"),
        );
        // No-op when the prefix isn't present.
        assert_eq!(
            strip_verbatim_prefix(Path::new(r"C:\Users\loseu")),
            PathBuf::from(r"C:\Users\loseu"),
        );
        // Idempotent.
        let once = strip_verbatim_prefix(Path::new(r"\\?\C:\x"));
        assert_eq!(strip_verbatim_prefix(&once), once);
    }

    #[test]
    #[cfg(not(windows))]
    fn strip_verbatim_prefix_is_a_no_op_on_unix() {
        let p = Path::new("/home/loseu");
        assert_eq!(strip_verbatim_prefix(p), PathBuf::from("/home/loseu"));
    }

    #[test]
    fn canonicalize_or_keep_returns_input_when_path_is_missing() {
        let missing = Path::new("__does_not_exist_anywhere_94e9__");
        assert_eq!(canonicalize_or_keep(missing), missing.to_path_buf());
    }
}
