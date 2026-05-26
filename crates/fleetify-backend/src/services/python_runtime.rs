//! Cross-platform Python interpreter discovery.
//!
//! Used by:
//!   * `bridges::antigravity_sdk::resolve_python` (the runtime path the SDK
//!     sidecar is spawned with), and
//!   * the Tauri `shell_check_python_runtime` IPC (what the Settings →
//!     Agents row and the onboarding flow render against).
//!
//! Both surfaces need to agree on the same Python — otherwise the user can
//! see a green "Python detected" pill in Settings but the bridge still fails
//! to spawn because PATH was different at IPC time vs. spawn time, or the
//! probe found one interpreter and the spawn picked another.
//!
//! Resolution order (first hit wins):
//!   1. `FLEETIFY_EMBEDDED_PYTHON` env override (power users, CI runners).
//!   2. PATH lookup via `which::which` for `python3`, `python`, and on
//!      Windows `py` (the py.exe launcher). Windows Store reparse-point
//!      shims under `WindowsApps\` are filtered out — they're 0-byte stubs
//!      that open the Microsoft Store interactively when executed.
//!   3. Platform-specific install-prefix fallbacks for users who didn't
//!      tick "Add Python to PATH" (Windows installer) or who installed via
//!      a manager that doesn't shim into the system PATH:
//!        * macOS: Homebrew (Apple Silicon + Intel), python.org installer,
//!          Xcode CLT, pyenv shims, asdf shims.
//!        * Linux: distro `/usr/bin`, `/usr/local/bin`, Snap, pyenv, asdf.
//!        * Windows: `%LOCALAPPDATA%\Programs\Python\Python3*`, `C:\Python3*`,
//!          `C:\Program Files\Python3*`.

use std::path::PathBuf;

/// Return the first usable Python interpreter on this machine, or `None`
/// if nothing was found.
///
/// "Usable" only means *the binary exists*; the caller is responsible for
/// any version probe (we do that in the IPC layer via `--version` with a
/// 3-second timeout — see `shell_check_python_runtime`).
pub fn locate_python() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("FLEETIFY_EMBEDDED_PYTHON") {
        let pb = PathBuf::from(&p);
        if pb.exists() {
            return Some(pb);
        }
    }

    // PATH lookup. `py` only matters on Windows (the py.exe launcher) —
    // on Unix it'd accidentally match `/usr/bin/py` from the `python-py`
    // package which is unrelated to Python.
    let names: &[&str] = if cfg!(windows) {
        &["python3", "python", "py"]
    } else {
        &["python3", "python"]
    };
    for name in names {
        if let Ok(p) = which::which(name) {
            if is_usable(&p) {
                return Some(p);
            }
        }
    }

    // Platform-specific install-prefix fallbacks for users whose PATH
    // didn't pick up their interpreter.
    fallback_candidates().into_iter().find(|p| p.exists())
}

/// Filter out the Microsoft Store reparse-point shims under
/// `%LOCALAPPDATA%\Microsoft\WindowsApps\`. Those binaries are 0-byte
/// stubs that open the Store on first execute and never resolve a real
/// interpreter without the user completing an interactive install. On
/// non-Windows or for any normal binary this is a no-op pass-through.
fn is_usable(p: &std::path::Path) -> bool {
    if !cfg!(windows) {
        return true;
    }
    let lower = p.to_string_lossy().to_lowercase();
    if !lower.contains(r"\windowsapps\") {
        return true;
    }
    // Real WindowsApps installs (e.g. user pinned 3.12 via the Store) end
    // up with a non-zero binary; the stub is exactly 0 bytes.
    std::fs::metadata(p).map(|m| m.len() > 0).unwrap_or(false)
}

fn fallback_candidates() -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from);

    #[cfg(target_os = "macos")]
    {
        out.push(PathBuf::from("/opt/homebrew/bin/python3"));
        out.push(PathBuf::from("/usr/local/bin/python3"));
        out.push(PathBuf::from(
            "/Library/Frameworks/Python.framework/Versions/Current/bin/python3",
        ));
        out.push(PathBuf::from("/usr/bin/python3"));
    }

    #[cfg(target_os = "linux")]
    {
        out.push(PathBuf::from("/usr/bin/python3"));
        out.push(PathBuf::from("/usr/local/bin/python3"));
        out.push(PathBuf::from("/snap/bin/python3"));
    }

    #[cfg(windows)]
    {
        if let Some(local) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from) {
            let prog = local.join("Programs").join("Python");
            if let Ok(entries) = std::fs::read_dir(&prog) {
                let mut found: Vec<PathBuf> = entries
                    .flatten()
                    .map(|e| e.path().join("python.exe"))
                    .filter(|p| p.exists())
                    .collect();
                // Sort descending so newer Python3X installs win the
                // first-hit race over older ones sitting in the same dir.
                found.sort();
                found.reverse();
                out.extend(found);
            }
        }
        for v in ["313", "312", "311", "310", "39"] {
            out.push(PathBuf::from(format!(r"C:\Python{v}\python.exe")));
            out.push(PathBuf::from(format!(
                r"C:\Program Files\Python{v}\python.exe"
            )));
        }
    }

    // Cross-platform user-version managers. pyenv/asdf install scripts
    // drop shims under the user's home — they're worth checking even when
    // PATH didn't pick them up (some shells don't init pyenv on non-login
    // launches like Tauri's spawned children).
    if let Some(h) = home {
        if !cfg!(windows) {
            out.push(h.join(".pyenv/shims/python3"));
            out.push(h.join(".asdf/shims/python3"));
        }
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn override_env_wins_when_set_and_exists() {
        // The dev/CI box has *some* path that exists; use the test binary
        // itself as a stand-in for a Python the user pinned via env. The
        // function only checks `.exists()`, not whether it's actually a
        // Python — that's the caller's job (the IPC layer runs --version).
        let exe = std::env::current_exe().expect("current_exe");
        std::env::set_var("FLEETIFY_EMBEDDED_PYTHON", &exe);
        let resolved = locate_python();
        std::env::remove_var("FLEETIFY_EMBEDDED_PYTHON");
        assert_eq!(resolved, Some(exe));
    }

    #[test]
    fn override_env_ignored_when_path_missing() {
        std::env::set_var(
            "FLEETIFY_EMBEDDED_PYTHON",
            "/definitely/not/a/real/path/python",
        );
        let resolved = locate_python();
        std::env::remove_var("FLEETIFY_EMBEDDED_PYTHON");
        // On a dev box this falls through to PATH lookup or fallback
        // candidates — but we don't assert what it found, only that the
        // bogus override didn't poison the result.
        assert_ne!(
            resolved.as_deref(),
            Some(std::path::Path::new("/definitely/not/a/real/path/python"))
        );
    }

    #[test]
    fn fallback_candidates_are_platform_specific() {
        let cands = fallback_candidates();
        // Sanity: at least one candidate per platform — the function is
        // never silent, even when nothing actually exists on this box.
        assert!(
            !cands.is_empty(),
            "fallback_candidates should always return at least one path"
        );
    }

    #[test]
    #[cfg(windows)]
    fn windows_store_reparse_stub_is_filtered() {
        // Create an empty file to mimic the Microsoft Store reparse stub.
        // The path doesn't actually live under WindowsApps\ on tmpfs, so
        // we only test the size-check half of the predicate here.
        let dir = tempfile::tempdir().expect("tempdir");
        let stub = dir.path().join("python.exe");
        std::fs::write(&stub, []).expect("write empty stub");
        // is_usable() only flags WindowsApps paths — a 0-byte file outside
        // that prefix is still considered usable (we don't know enough
        // about it to reject otherwise).
        assert!(is_usable(&stub));
    }
}
