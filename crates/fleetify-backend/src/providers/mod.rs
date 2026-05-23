//! Static, registry-driven catalog of API providers and CLI agents.
//!
//! Every HTTP provider tile in Settings → Models, every CLI agent tile in
//! Settings → Agents, and every entry in the chat composer's model picker
//! traces back to a single `ProviderSpec` here. Adding a new provider
//! becomes a one-file edit (append to `CATALOG`) rather than a multi-file
//! refactor across the renderer, IPC layer, and backend dispatch.
//!
//! The catalog is `'static` — no allocations, no I/O. Helpers return
//! borrows so the renderer's JSON serialization can copy out exactly the
//! fields it needs without forcing every consumer into the same shape.

pub mod catalog;
pub mod helpers;
pub mod keys;

pub use catalog::{
    AuthIndicator, AuthSpec, ModelSpec, ProviderExtras, ProviderKind, ProviderSpec, CATALOG,
};
pub use helpers::{find_agent, find_provider, list_api_providers, list_cli_agents};
