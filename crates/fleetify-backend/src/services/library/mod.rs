//! Library — user-authored content (prompts/skills/commands/hooks/templates)
//! stored under `~/.fleetify/library/`, separate from the plugin system.
//!
//! Unlike marketplace plugins (which materialize as a side-effect of install
//! and appear in `GET /plugins`), library items are a first-class, Library-only
//! concept: created/edited/deleted by the user, never surfaced as plugins.
//! Materialization reuses the per-component writers in
//! `services::plugins::materializers` so authored skills/commands/prompts land
//! in exactly the same on-disk locations a plugin's would.

pub mod enumerate;
pub mod materialize;
pub mod store;
pub mod types;
