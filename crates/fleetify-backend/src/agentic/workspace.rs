//! Workspace = the directory the agent is allowed to read/write under.
//! Every file-touching tool call resolves its `path` through here; paths
//! that escape (`../../`, absolute paths outside the root, symlinks
//! pointing out) are rejected with a clear error.
//!
//! Why canonicalise
//! ----------------
//!
//! `std::path::Path::starts_with` works on lexical paths — it would let
//! `workspace/symlink-to-/etc` slip through if `symlink-to-/etc` was a
//! direct child of the workspace. `std::fs::canonicalize` follows
//! symlinks and resolves `..`, so containment is enforced against the
//! REAL physical location.
//!
//! The cost: `canonicalize` requires the path to EXIST. For tools that
//! create new files (`write_file`, `edit_file` on a freshly-created
//! ancestor), we canonicalise the deepest existing ancestor and re-join
//! the tail — same containment guarantee without needing the file to
//! exist yet.

use std::path::{Path, PathBuf};

use anyhow::{anyhow, Result};

#[derive(Debug, Clone)]
pub struct Workspace {
    /// Canonical absolute path of the workspace root. Set once at session
    /// start; every tool call resolves its `path` against this.
    root: PathBuf,
}

impl Workspace {
    /// Build a workspace from the session's agent_cwd. Fails if the dir
    /// doesn't exist (the caller — session creation — is responsible for
    /// making the directory).
    pub fn new(root: impl AsRef<Path>) -> Result<Self> {
        let root = root.as_ref();
        if !root.exists() {
            return Err(anyhow!("workspace root does not exist: {}", root.display()));
        }
        if !root.is_dir() {
            return Err(anyhow!(
                "workspace root is not a directory: {}",
                root.display()
            ));
        }
        let canonical = std::fs::canonicalize(root).map_err(|e| {
            anyhow!(
                "failed to canonicalize workspace root {}: {e}",
                root.display()
            )
        })?;
        Ok(Self { root: canonical })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Resolve an input path (relative or absolute) to a canonical path
    /// under the workspace root.
    ///
    /// For paths that don't yet exist (write_file creating a new file),
    /// the deepest existing ancestor is canonicalised and the tail is
    /// re-attached. Containment is still enforced against the resolved
    /// ancestor, so a symlink near the root can't be used as a stepping
    /// stone to write outside.
    pub fn resolve(&self, input: &str) -> Result<PathBuf> {
        let p = Path::new(input);
        let joined = if p.is_absolute() {
            p.to_path_buf()
        } else {
            self.root.join(p)
        };

        let (existing, tail) = split_existing_ancestor(&joined);
        let canonical_existing = std::fs::canonicalize(&existing)
            .map_err(|e| anyhow!("failed to canonicalize {}: {e}", existing.display()))?;
        let resolved = match tail {
            Some(t) => canonical_existing.join(t),
            None => canonical_existing,
        };

        if !resolved.starts_with(&self.root) {
            return Err(anyhow!(
                "path escapes workspace root: `{}` resolves to `{}` which is not under `{}`",
                input,
                resolved.display(),
                self.root.display()
            ));
        }
        Ok(resolved)
    }
}

/// Walk up from `p` until we find an ancestor that exists. Returns
/// `(existing_ancestor, tail_below_it_if_any)`. Used so we can canonicalise
/// the existing portion of a path that may have a non-existing tail.
fn split_existing_ancestor(p: &Path) -> (PathBuf, Option<PathBuf>) {
    let mut existing = p.to_path_buf();
    let mut tail_components: Vec<std::ffi::OsString> = Vec::new();
    while !existing.exists() {
        let Some(parent) = existing.parent().map(Path::to_path_buf) else {
            // Reached filesystem root with nothing existing — return
            // as-is; caller will get a clear canonicalize error.
            return (existing, None);
        };
        if let Some(file) = existing.file_name() {
            tail_components.push(file.to_owned());
        }
        existing = parent;
    }
    if tail_components.is_empty() {
        (existing, None)
    } else {
        tail_components.reverse();
        let tail: PathBuf = tail_components.iter().collect();
        (existing, Some(tail))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn new_rejects_nonexistent_root() {
        let err = Workspace::new("/nonexistent/path/to/nowhere").unwrap_err();
        assert!(err.to_string().contains("does not exist"));
    }

    #[test]
    fn new_rejects_file_as_root() {
        let dir = tempdir().unwrap();
        let f = dir.path().join("not-a-dir");
        std::fs::write(&f, "").unwrap();
        let err = Workspace::new(&f).unwrap_err();
        assert!(err.to_string().contains("not a directory"));
    }

    #[test]
    fn resolve_relative_lands_under_root() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join("hello.txt"), "hi").unwrap();
        let ws = Workspace::new(dir.path()).unwrap();
        let p = ws.resolve("hello.txt").unwrap();
        assert!(p.starts_with(ws.root()));
        assert_eq!(p.file_name().unwrap(), "hello.txt");
    }

    #[test]
    fn resolve_rejects_dotdot_escape() {
        let dir = tempdir().unwrap();
        std::fs::create_dir(dir.path().join("inner")).unwrap();
        let ws = Workspace::new(dir.path().join("inner")).unwrap();
        let err = ws.resolve("../../etc/passwd").unwrap_err();
        let msg = err.to_string();
        // Either we caught it at the containment check, or canonicalize
        // bailed earlier because the parent doesn't exist; both surface
        // a clear error.
        assert!(
            msg.contains("escapes workspace root") || msg.contains("failed to canonicalize"),
            "expected escape error, got: {msg}"
        );
    }

    #[test]
    fn resolve_rejects_absolute_outside_root() {
        let dir = tempdir().unwrap();
        let ws = Workspace::new(dir.path()).unwrap();
        // Use an absolute path that definitely exists on every OS but is
        // not under our tempdir. On POSIX `/` works; on Windows the OS
        // root drive does.
        let outside = if cfg!(windows) { "C:\\Windows" } else { "/" };
        let err = ws.resolve(outside).unwrap_err();
        assert!(err.to_string().contains("escapes workspace root"));
    }

    #[test]
    fn resolve_allows_nonexistent_descendant_for_create() {
        let dir = tempdir().unwrap();
        let ws = Workspace::new(dir.path()).unwrap();
        let p = ws.resolve("subdir/new-file.txt").unwrap();
        assert!(p.starts_with(ws.root()));
        assert_eq!(p.file_name().unwrap(), "new-file.txt");
    }

    #[test]
    fn resolve_idempotent_for_already_canonical_path() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), "x").unwrap();
        let ws = Workspace::new(dir.path()).unwrap();
        let first = ws.resolve("a.txt").unwrap();
        let second = ws.resolve(first.to_str().unwrap()).unwrap();
        assert_eq!(first, second);
    }

    #[test]
    fn resolve_dot_returns_root() {
        let dir = tempdir().unwrap();
        let ws = Workspace::new(dir.path()).unwrap();
        let p = ws.resolve(".").unwrap();
        assert_eq!(p, *ws.root());
    }
}
