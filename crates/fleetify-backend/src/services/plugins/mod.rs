//! Plugin foundation. Faithful subset of `services/plugins/*.py`.
//!
//! Phase-4 cut implemented:
//! - `types`: `PluginManifest` + `Declares` + `ProvidersDeclares` +
//!   `Author` + `SecretRequirement` + `MarketplaceManifest` with
//!   regex-validated `name` (kebab-case) + `version` (semver) +
//!   provider whitelist.
//! - `manifest`: read `.fleetify-plugin/plugin.json` or
//!   `marketplace.json` from a directory and parse into the typed
//!   model. `derive_provides()` computes the canonical "provides"
//!   list from declares (mcp / skills / commands / prompts / hooks /
//!   subagents / workflows) so the marketplace UI's filter chips
//!   render correctly.
//!
//! Deferred to follow-up commits:
//! - installer (clone + cache + materialize) — 870 LOC Python.
//! - materializers (claude / gemini / codex / fleetify) — each
//!   handles a target tool's specific file layout.
//! - registry (per-scope component registries + materialize_for_spawn).
//! - marketplace catalog.
//! - runtime (component_registry + per-tool dispatch hooks).

pub mod installer;
pub mod manifest;
pub mod marketplace_fetch;
pub mod materializers;
pub mod mcp_materialize;
pub mod providers;
pub mod state;
pub mod types;
