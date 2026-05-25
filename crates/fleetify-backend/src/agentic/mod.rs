//! Agentic tool-use infrastructure for API providers.
//!
//! Bridges the gap between HTTP chat providers (Anthropic, OpenAI, Groq,
//! Google AI, ...) — which only respond with text out of the box — and
//! the Cursor-style "agent that can read your files and run commands"
//! experience. The CLI agents (claude, codex, agy, ...) inherit tools
//! from their host binaries; the SDK bridge inherits them from
//! `google-antigravity`'s built-in catalog. This module is for everyone
//! else.
//!
//! Architecture
//! ------------
//!
//! Shared core (provider-agnostic):
//!   - [`catalog`] — the 7-tool catalog (read_file, edit_file, write_file,
//!     list_dir, grep, glob, run_command). Names + shapes mirror Claude
//!     Code so the user's mental model carries across providers.
//!   - [`workspace::Workspace`] — wraps a session's `agent_cwd`. All file
//!     paths are canonicalised + contained under the workspace root;
//!     attempts to escape (../../etc/passwd) are rejected.
//!   - [`executor`] — pure execution of a single `ToolCall`. No model,
//!     no provider, no streaming — just "given a tool name + args,
//!     produce a result." Easy to unit-test in a tempdir.
//!   - [`permissions::Mode`] — `Chat` (read-only) or `Autonomous` (full).
//!     Determines whether write + shell tools are executed or refused.
//!
//! Provider integration (added incrementally — Anthropic, OpenAI-compat,
//! Google Gemini direct-HTTP) implements a thin `ToolAdapter` trait so
//! the agentic loop itself stays provider-agnostic. See sibling commits
//! once they land.

pub mod adapter;
pub mod catalog;
pub mod context;
pub mod events;
pub mod executor;
pub mod loop_runner;
pub mod permissions;
pub mod workspace;

pub use adapter::ToolAdapter;
pub use catalog::{catalog_v1, Tool};
pub use context::build_system_context;
pub use events::{AdapterHistory, TurnEvent, TurnOutcome};
pub use executor::{execute, ToolCall, ToolResult};
pub use loop_runner::{drive_agentic_loop, MAX_TURNS};
pub use permissions::{Disposition, Mode, PermissionGate, StaticGate};
pub use workspace::Workspace;
