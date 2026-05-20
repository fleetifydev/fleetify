//! Non-bridge services. Phase 2 lands worktree/clone + git/gh helpers.

pub mod activity_logger;
pub mod haiku_breaker;
pub mod mcp_registry;
pub mod mcp_secrets;
pub mod meta_cost;
pub mod migration;
pub mod plugins;
pub mod pricing;
pub mod provider_inspector;
pub mod recall_hook;
pub mod telemetry;
pub mod workflows;
pub mod worktree;
