//! Electron main-process equivalents. Phase 1b lands auth, bearer bridge,
//! and auth IPC; the remaining ~51 IPC commands (fs/git/pty/github/…) follow
//! in Phase 1c+.

pub mod ai_git;
pub mod auth;
pub mod bearer;
pub mod config;
pub mod git;
pub mod github_link;
pub mod github_pr;
pub mod head_watcher;
pub mod ipc;
pub mod logging;
pub mod pty;
pub mod routers_link;
pub mod routing_setup;
