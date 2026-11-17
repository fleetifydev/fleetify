//! Shared, I/O-free domain types for the Fleetify backend + shell, and the
//! HTTP client builder for calls to the app's own loopback services
//! ([`loopback`]), shared with the MCP sidecars.

use std::path::{Path, PathBuf};

pub mod endpoints;
pub mod loopback;
pub mod text;

/// Backend wire-protocol version. Bumped only on breaking WS/REST changes.
pub const PROTOCOL_VERSION: u32 = 1;

/// `std::fs::canonicalize` returns Windows verbatim-prefixed paths
/// (`\\?\C:\…`). Several downstream tools (some ACP CLI agents, git,
/// the claude CLI on some node versions) treat these as malformed and
/// return cryptic errors — e.g. an ACP server that fails
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

/// User's home directory. `USERPROFILE` on Windows, `HOME` elsewhere,
/// falling back to `.` if neither is set. Use this for *external* CLI
/// homes (`.claude/`, `.codex/`, `.gemini/`) — the paths those tools own.
/// For Fleetify's own data dir, use `fleetify_home()` instead so the
/// FLEETIFY_HOME override is honoured.
pub fn user_home() -> PathBuf {
    let h = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| ".".into());
    PathBuf::from(h)
}

/// Root of Fleetify's per-installation data dir. Resolution:
///
///   1. `$FLEETIFY_HOME` if set and non-empty (full path, not appended
///      to `.fleetify`). Lets parallel installations / worktrees live
///      side-by-side without colliding on `telemetry-outbox.sqlite`,
///      `mcp_servers.json`, `plugins/`, `clones/`, etc.
///   2. Otherwise `<user_home>/.fleetify` (the historical layout).
///
/// Every call site that used to do `home().join(".fleetify")` should
/// switch to this helper so the override flows everywhere consistently.
pub fn fleetify_home() -> PathBuf {
    if let Ok(p) = std::env::var("FLEETIFY_HOME") {
        if !p.is_empty() {
            return PathBuf::from(p);
        }
    }
    user_home().join(".fleetify")
}

/// Resolve the base URL to probe a local Ollama daemon, OS-agnostically.
///
/// Priority: an explicit caller value (e.g. a configured `ollama_base_url`) >
/// the `OLLAMA_HOST` environment variable (Ollama's own convention) >
/// `http://127.0.0.1:11434`.
///
/// The default is the IPv4 literal `127.0.0.1`, deliberately NOT `localhost`:
/// Ollama binds `127.0.0.1:11434` by default, but on Windows and some macOS
/// setups `localhost` resolves to IPv6 `::1` first, so a `localhost` probe
/// reaches an address with no listener and reports the daemon down even when
/// it is up. `curl` papers over this with Happy Eyeballs (it races both
/// address families); a single-address HTTP client does not, so it must
/// target the family Ollama actually listens on. Using the literal makes
/// detection identical on Linux, macOS, and Windows.
pub fn resolve_ollama_base_url(explicit: Option<&str>, ollama_host: Option<&str>) -> String {
    let pick = explicit
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .or_else(|| ollama_host.map(str::trim).filter(|s| !s.is_empty()));
    match pick {
        Some(raw) => normalize_ollama_base(raw),
        None => "http://127.0.0.1:11434".to_string(),
    }
}

/// Normalize an Ollama host/URL into a `scheme://host:port` probe base.
/// Accepts the forms `OLLAMA_HOST` and stored configs use in the wild: a full
/// URL (`http://h:p`, returned as-is bar a trailing slash), `host:port`, a
/// bare `host` (default port 11434), or `:port` (default host). The bind-all
/// sentinel `0.0.0.0` is rewritten to loopback `127.0.0.1` — it is not a
/// dialable address.
fn normalize_ollama_base(raw: &str) -> String {
    let raw = raw.trim().trim_end_matches('/');
    if raw.starts_with("http://") || raw.starts_with("https://") {
        return raw.to_string();
    }
    let hostport = if let Some(port) = raw.strip_prefix(':') {
        format!("127.0.0.1:{port}")
    } else if raw.contains(':') {
        raw.to_string()
    } else {
        format!("{raw}:11434")
    };
    format!("http://{}", hostport.replacen("0.0.0.0", "127.0.0.1", 1))
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

    #[test]
    fn ollama_base_defaults_to_ipv4_loopback_not_localhost() {
        let got = resolve_ollama_base_url(None, None);
        assert_eq!(got, "http://127.0.0.1:11434");
        assert!(
            !got.contains("localhost"),
            "default must not depend on localhost resolution (IPv6 ::1 hazard): {got}"
        );
    }

    #[test]
    fn ollama_base_honors_explicit_full_url_and_trims_trailing_slash() {
        assert_eq!(
            resolve_ollama_base_url(Some("http://192.168.1.50:11434/"), None),
            "http://192.168.1.50:11434",
        );
    }

    #[test]
    fn ollama_base_explicit_wins_over_env() {
        assert_eq!(
            resolve_ollama_base_url(Some("http://10.0.0.2:11434"), Some("127.0.0.1:9999")),
            "http://10.0.0.2:11434",
        );
    }

    #[test]
    fn ollama_base_reads_ollama_host_env_forms() {
        // host:port
        assert_eq!(
            resolve_ollama_base_url(None, Some("127.0.0.1:11434")),
            "http://127.0.0.1:11434"
        );
        // bare host → default port
        assert_eq!(
            resolve_ollama_base_url(None, Some("my-ollama-box")),
            "http://my-ollama-box:11434"
        );
        // :port → default host
        assert_eq!(
            resolve_ollama_base_url(None, Some(":11500")),
            "http://127.0.0.1:11500"
        );
        // already a URL
        assert_eq!(
            resolve_ollama_base_url(None, Some("http://host:1234")),
            "http://host:1234"
        );
    }

    #[test]
    fn ollama_base_rewrites_bind_all_to_loopback() {
        // 0.0.0.0 is a bind sentinel, not a dialable address — probe loopback.
        assert_eq!(
            resolve_ollama_base_url(None, Some("0.0.0.0:11434")),
            "http://127.0.0.1:11434"
        );
    }

    #[test]
    fn ollama_base_ignores_blank_values() {
        assert_eq!(
            resolve_ollama_base_url(Some("   "), Some("")),
            "http://127.0.0.1:11434"
        );
    }
}
