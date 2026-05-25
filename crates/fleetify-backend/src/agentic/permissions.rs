//! Permission policy for the agentic loop. Determines whether each
//! tool call is auto-allowed, asked-of-the-user, or denied outright.
//!
//! Two surfaces in this module:
//!
//! - `Mode` — the user's chosen autonomy tier, derived from
//!   `session.permission_mode`. Maps each tool name to a `Disposition`:
//!   `AutoAllow` (run it now), `Ask` (route through the gate), or
//!   `Deny` (refuse outright — used for unknown tools).
//! - `PermissionGate` trait — what to do when `Mode::disposition`
//!   returns `Ask`. Two implementations ship: `StaticGate(bool)` for
//!   tests and headless dispatch, `InteractiveGate` (in
//!   `bridges/agentic_runner.rs`) for live UI flows that emit a
//!   `PermissionRequest` event to the renderer and await the user's
//!   click via a oneshot channel.
//!
//! v1 ships three modes mapped from `session.permission_mode`:
//!
//! - `Chat` ← `"default"` — read tools (read_file, list_dir, grep, glob)
//!   auto-allowed; write + shell denied. Default for every new HTTP-
//!   provider session: the agent ALWAYS gets workspace context (CWD,
//!   tree, README) injected into its system prompt and can READ freely,
//!   but can't apply changes. Model adapts to "I can suggest code but
//!   can't apply it" — useful for explaining or planning without side
//!   effects.
//!
//! - `AcceptEdits` ← `"acceptEdits"` — read + write tools auto-allowed
//!   (`edit_file`, `write_file`); shell still denied. Middle ground for
//!   "I trust the model with my files, not my shell".
//!
//! - `Autonomous` ← `"bypassPermissions"` — every tool auto-allowed
//!   including shell. The user takes responsibility; the renderer
//!   surfaces a Stop button so they can abort runaway loops.
//!
//! True ASK semantics — pop a per-tool approve/deny dialog instead of
//! denying outright — needs a bidirectional WS round-trip + dialog UI
//! component. That's a follow-up commit (or PR); this enum is shaped so
//! adding it is a fourth variant + a permission-prompt path in the
//! loop driver, not a cross-cutting refactor.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    /// Reads auto, writes + shell refused. Default for new sessions —
    /// the agent gets full workspace context but cannot apply changes
    /// until the user explicitly opts into a higher tier. Safe baseline.
    #[default]
    Chat,
    /// Reads + writes auto, shell refused. The user has accepted that
    /// edits will land without asking; only running arbitrary commands
    /// still needs explicit opt-in.
    AcceptEdits,
    /// Everything auto. Renderer should expose a Stop button.
    Autonomous,
}

/// What the loop should do with a tool call this turn. The executor
/// dispatches on this BEFORE doing any filesystem work, so AutoAllow
/// runs straight through, Ask routes through the gate, and Deny short-
/// circuits with a clean tool error the model can react to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Disposition {
    /// Mode says yes; run the tool immediately.
    AutoAllow,
    /// Mode says ask — the executor calls the gate. The gate's answer
    /// becomes Allow (proceed) or Deny (return a tool error the model
    /// can adapt to).
    Ask,
    /// Mode says no — tool isn't in the catalog. Different from Ask
    /// because no user click can resurrect an unknown tool.
    Deny,
}

impl Mode {
    /// Dispatch verdict for a tool name under this mode.
    pub fn disposition(&self, tool_name: &str) -> Disposition {
        let is_read = matches!(tool_name, "read_file" | "list_dir" | "grep" | "glob");
        let is_write = matches!(tool_name, "edit_file" | "write_file");
        let is_shell = tool_name == "run_command";
        if !is_read && !is_write && !is_shell {
            return Disposition::Deny;
        }
        match self {
            Mode::Autonomous => Disposition::AutoAllow,
            Mode::AcceptEdits if is_shell => Disposition::Ask,
            Mode::AcceptEdits => Disposition::AutoAllow,
            Mode::Chat if is_read => Disposition::AutoAllow,
            Mode::Chat => Disposition::Ask,
        }
    }

    /// True iff the tool runs unattended under this mode (no gate call
    /// needed). Convenience wrapper around `disposition`; left here so
    /// callers that don't need the Ask/Deny split stay terse.
    pub fn allows(&self, tool_name: &str) -> bool {
        matches!(self.disposition(tool_name), Disposition::AutoAllow)
    }
}

/// Async hook the executor invokes when `Mode::disposition` returns
/// `Ask`. Concrete impls in `StaticGate` (always allow / always deny —
/// used by tests and the legacy no-UI dispatch path) and
/// `InteractiveGate` (lives in `bridges/agentic_runner.rs`; emits a
/// `PermissionRequest` event and blocks until the user's reply comes
/// back through the bridge's pending map).
#[async_trait::async_trait]
pub trait PermissionGate: Send + Sync {
    /// Returns true if the tool may run, false to deny. Tool name +
    /// input are passed for logging / UI display, not for re-deciding —
    /// the gate doesn't second-guess `Mode::disposition`.
    async fn ask(&self, call_id: &str, tool_name: &str, input: &serde_json::Value) -> bool;
}

/// Fixed-decision gate. `StaticGate(true)` auto-approves every Ask
/// (effectively turns Chat / AcceptEdits into Autonomous); `false` denies
/// everything (model gets a tool error and adapts). Used by tests and
/// by sub-agent dispatch paths that don't have a UI to ask.
pub struct StaticGate(pub bool);

#[async_trait::async_trait]
impl PermissionGate for StaticGate {
    async fn ask(&self, _call_id: &str, _tool_name: &str, _input: &serde_json::Value) -> bool {
        self.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chat_allows_only_read_tools() {
        let m = Mode::Chat;
        assert!(m.allows("read_file"));
        assert!(m.allows("list_dir"));
        assert!(m.allows("grep"));
        assert!(m.allows("glob"));
        assert!(!m.allows("edit_file"));
        assert!(!m.allows("write_file"));
        assert!(!m.allows("run_command"));
    }

    #[test]
    fn accept_edits_allows_reads_and_writes_but_not_shell() {
        let m = Mode::AcceptEdits;
        // Reads and writes go through unattended.
        assert!(m.allows("read_file"));
        assert!(m.allows("list_dir"));
        assert!(m.allows("grep"));
        assert!(m.allows("glob"));
        assert!(m.allows("edit_file"));
        assert!(m.allows("write_file"));
        // Shell still requires the user to step up to Autonomous.
        assert!(!m.allows("run_command"));
    }

    #[test]
    fn autonomous_allows_every_catalog_tool() {
        let m = Mode::Autonomous;
        for tool in [
            "read_file",
            "edit_file",
            "write_file",
            "list_dir",
            "grep",
            "glob",
            "run_command",
        ] {
            assert!(m.allows(tool), "Autonomous should allow {tool}");
        }
    }

    #[test]
    fn unknown_tool_denied_under_every_mode() {
        // Disposition::Deny short-circuits any tool name not in the
        // catalog regardless of mode. Even Autonomous won't auto-allow
        // a name it doesn't recognise — the executor errors out before
        // touching the gate.
        for m in [Mode::Chat, Mode::AcceptEdits, Mode::Autonomous] {
            assert!(!m.allows("evil_tool"), "{m:?} should deny unknown tools");
            assert_eq!(m.disposition("evil_tool"), Disposition::Deny);
        }
    }

    #[test]
    fn default_is_chat_mode() {
        let m: Mode = Default::default();
        assert_eq!(m, Mode::Chat);
    }

    #[test]
    fn serde_round_trips_snake_case() {
        let json = serde_json::to_string(&Mode::Autonomous).unwrap();
        assert_eq!(json, "\"autonomous\"");
        let back: Mode = serde_json::from_str("\"chat\"").unwrap();
        assert_eq!(back, Mode::Chat);
    }

    #[test]
    fn disposition_classifies_each_tool_per_mode() {
        // Chat — only reads auto, writes/shell ask, unknown deny.
        assert_eq!(Mode::Chat.disposition("read_file"), Disposition::AutoAllow);
        assert_eq!(Mode::Chat.disposition("grep"), Disposition::AutoAllow);
        assert_eq!(Mode::Chat.disposition("edit_file"), Disposition::Ask);
        assert_eq!(Mode::Chat.disposition("write_file"), Disposition::Ask);
        assert_eq!(Mode::Chat.disposition("run_command"), Disposition::Ask);
        assert_eq!(Mode::Chat.disposition("frobnicate"), Disposition::Deny);

        // AcceptEdits — reads + writes auto, shell asks, unknown deny.
        assert_eq!(
            Mode::AcceptEdits.disposition("read_file"),
            Disposition::AutoAllow
        );
        assert_eq!(
            Mode::AcceptEdits.disposition("edit_file"),
            Disposition::AutoAllow
        );
        assert_eq!(
            Mode::AcceptEdits.disposition("write_file"),
            Disposition::AutoAllow
        );
        assert_eq!(
            Mode::AcceptEdits.disposition("run_command"),
            Disposition::Ask
        );
        assert_eq!(
            Mode::AcceptEdits.disposition("frobnicate"),
            Disposition::Deny
        );

        // Autonomous — everything in the catalog auto; unknown still deny.
        assert_eq!(
            Mode::Autonomous.disposition("read_file"),
            Disposition::AutoAllow
        );
        assert_eq!(
            Mode::Autonomous.disposition("run_command"),
            Disposition::AutoAllow
        );
        assert_eq!(
            Mode::Autonomous.disposition("frobnicate"),
            Disposition::Deny
        );
    }

    #[tokio::test]
    async fn static_gate_returns_its_fixed_decision() {
        let allow = StaticGate(true);
        let deny = StaticGate(false);
        assert!(allow.ask("c1", "edit_file", &serde_json::json!({})).await);
        assert!(!deny.ask("c1", "edit_file", &serde_json::json!({})).await);
    }
}
