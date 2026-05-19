//! Electron main-process equivalents. Phase 1b lands auth + bearer bridge
//! + auth IPC; the remaining ~51 IPC commands (fs/git/pty/github/…) follow
//! in Phase 1c+.

pub mod auth;
pub mod bearer;
pub mod config;
pub mod git;
pub mod github_link;
pub mod head_watcher;
pub mod ipc;
pub mod pty;
