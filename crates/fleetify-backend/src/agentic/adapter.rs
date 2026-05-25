//! `ToolAdapter` trait — the contract every HTTP bridge implements to
//! plug into the shared agentic loop.
//!
//! Three responsibilities per adapter (intentionally narrow — everything
//! else is shared infrastructure in `loop_runner`, `executor`,
//! `workspace`, `permissions`):
//!
//! 1. **Seed history** (`init_history`) — turn the system prompt + the
//!    user's first message into the provider's history shape.
//! 2. **Execute one turn** (`execute_turn`) — send the request, stream
//!    text/thinking deltas to the sink, return the consolidated
//!    `TurnOutcome` (text + tool_calls + usage) once the provider
//!    signals end-of-message.
//! 3. **Append to history** (`append_assistant`, `append_tool_results`) —
//!    fold the turn's output and the executor's results back into the
//!    provider-shape history so the next `execute_turn` carries the full
//!    conversation.
//!
//! What this trait deliberately does NOT do
//! ----------------------------------------
//!
//! - Decide when to stop. The loop driver checks `outcome.tool_calls`
//!   emptiness and the MAX_TURNS cap.
//! - Execute tools. The loop driver calls `super::execute` between turns.
//! - Enforce permissions. Permission check lives in the executor; the
//!   adapter doesn't see the mode.
//! - Build the system prompt. `super::context::build_system_context`
//!   does that; the adapter receives it as a string.
//!
//! Keeping the trait narrow is how we keep adapter implementations to a
//! few hundred lines each — the heavy lifting (workspace scoping,
//! sandboxing, permission enforcement, multi-turn orchestration) is
//! provider-agnostic and lives once in shared modules.

use anyhow::Result;
use tokio::sync::mpsc;

use super::catalog::Tool;
use super::events::{AdapterHistory, TurnEvent, TurnOutcome};
use super::executor::ToolResult;

#[async_trait::async_trait]
pub trait ToolAdapter: Send + Sync {
    /// Seed the adapter's history with the system prompt and the first
    /// user message. Called once per session at the start of the loop.
    fn init_history(&self, system_prompt: &str, user_message: &str) -> AdapterHistory;

    /// Send one turn to the provider. Stream incremental text/thinking
    /// deltas through `sink` as bytes arrive; return the consolidated
    /// `TurnOutcome` once the provider signals end-of-message.
    ///
    /// Failures: provider HTTP errors, SSE parse failures, or
    /// authentication problems all bubble as `Err`. The driver wraps the
    /// error in a `TurnEvent::Error` for the renderer.
    async fn execute_turn(
        &self,
        history: &AdapterHistory,
        catalog: &[Tool],
        sink: &mpsc::Sender<TurnEvent>,
    ) -> Result<TurnOutcome>;

    /// Append the assistant's response (text + tool calls) to history in
    /// the provider's shape. Called by the driver after `execute_turn`
    /// returns, before tool execution.
    ///
    /// Why before tool execution: providers want the assistant message
    /// referencing tool ids to appear BEFORE the corresponding tool
    /// result messages in the next turn's history.
    fn append_assistant(&self, history: &mut AdapterHistory, outcome: &TurnOutcome);

    /// Append tool execution results to history. Called by the driver
    /// after the executor runs all of this turn's tool calls, before the
    /// next `execute_turn`.
    fn append_tool_results(&self, history: &mut AdapterHistory, results: &[ToolResult]);
}
