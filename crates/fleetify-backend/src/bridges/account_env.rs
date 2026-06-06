//! Attach a CLI account's resolved env vars to a spawned subprocess.
//!
//! The env set is resolved once per turn by
//! [`crate::services::accounts::resolve_env`] — either `CLAUDE_CONFIG_DIR=<dir>`
//! (config-dir agents like claude/codex) or a full HOME/XDG/AppData bundle
//! (HOME-isolation agents). These helpers just apply that set to the two kinds
//! of command builder the bridges use: `tokio::process::Command` (most CLI
//! agents) and `portable_pty::CommandBuilder` (antigravity's PTY).

/// Attach the resolved account env vars to a tokio Command. An empty slice
/// (the System account) is a no-op.
pub fn apply_to_command(cmd: &mut tokio::process::Command, env: &[(String, String)]) {
    for (k, v) in env {
        cmd.env(k, v);
    }
}

/// Attach the resolved account env vars to a portable-pty CommandBuilder. An
/// empty slice (the System account) is a no-op.
pub fn apply_to_pty(cmd: &mut portable_pty::CommandBuilder, env: &[(String, String)]) {
    for (k, v) in env {
        cmd.env(k, v);
    }
}
