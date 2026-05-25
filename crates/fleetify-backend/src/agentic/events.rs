//! Events the agentic loop emits to the renderer (via each bridge's
//! existing WS event stream) and the per-turn outcome the adapter
//! returns to the loop driver.
//!
//! Why two surfaces
//! ----------------
//!
//! `TurnEvent` is fire-and-forget for the renderer — text deltas, tool
//! cards, errors. The adapter pushes these as bytes arrive on the SSE
//! stream. The renderer doesn't need a TurnOutcome.
//!
//! `TurnOutcome` is the structured "what did the model decide" the
//! loop driver needs to act on — text (for the next history entry),
//! tool calls (to execute), usage (for cost surfacing). The renderer
//! got the same information piecewise via TurnEvents; the driver gets
//! it consolidated.

use serde::Serialize;
use serde_json::Value;

use super::executor::{ToolCall, ToolResult};

/// Streaming events the agentic loop pushes through the bridge's mpsc
/// channel. The bridge maps each to the appropriate `BridgeEvent` so
/// existing renderer plumbing (delta accumulation, tool cards) works
/// without changes.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TurnEvent {
    /// Model emitted a text token. Renderer appends to the assistant bubble.
    TextDelta { text: String },
    /// Extended-thinking / reasoning token (Anthropic, OpenAI o-series).
    /// Renderer can show in a collapsed "thinking" panel.
    ThinkingDelta { text: String },
    /// Tool call about to execute. Renderer renders a placeholder card.
    ToolStart { call: ToolCall },
    /// Tool execution complete. Renderer fills in the card with `result`.
    ToolEnd { result: ToolResult },
    /// The executor's permission gate is asking the user to approve a
    /// tool call that the session's mode flagged as `Ask`. Renderer
    /// shows an inline approve/deny dialog tied to `call_id`; the user's
    /// click POSTs back to `/api/chat/permission_response` which
    /// unblocks the in-flight executor. `tool_name` + `input` are
    /// included so the dialog can summarise what's about to happen
    /// (e.g. "Write 312 bytes to README.md") without a second lookup.
    PermissionRequest {
        call_id: String,
        tool_name: String,
        input: serde_json::Value,
    },
    /// Token usage from the provider, if reported. Lets the bridge emit
    /// a Cost event for the existing usage UI.
    Usage {
        input_tokens: u64,
        output_tokens: u64,
    },
    /// Hard error — provider HTTP failure, parse error, max-turns hit.
    /// The driver returns shortly after sending this; sink will close.
    Error { message: String },
}

/// Outcome of one model turn — what the adapter parsed out of the SSE
/// stream once the provider signalled end-of-message.
#[derive(Debug, Clone)]
pub struct TurnOutcome {
    /// Concatenated text content (sum of all TextDelta) the model produced
    /// this turn. The adapter accumulates while streaming and returns the
    /// whole thing so the driver can record it in history.
    pub text: String,
    /// Tool calls the model emitted. Empty means "no more tools — model
    /// is done"; the driver terminates the loop.
    pub tool_calls: Vec<ToolCall>,
    /// `(input_tokens, output_tokens)` if the provider reported usage.
    pub usage: Option<(u64, u64)>,
}

/// Provider-shape conversation history. Opaque to the loop driver — the
/// adapter pushes into it via `append_assistant` / `append_tool_results`
/// and consumes it inside `execute_turn`. Both fields are JSON because
/// each provider stores its history in its own message shape; we don't
/// translate between them.
///
/// - Anthropic: `messages` holds `[{role: "user"|"assistant", content: [...]}]`,
///   `system` holds the top-level system string.
/// - OpenAI-compat: `messages` holds `[{role, content, tool_calls?}]` with
///   a `{role: "system"}` inserted at the head at request-build time.
/// - Gemini direct: `messages` holds `[{role: "user"|"model", parts: [...]}]`,
///   `system` is folded into `system_instruction` at request time.
#[derive(Debug, Clone, Default)]
pub struct AdapterHistory {
    pub messages: Vec<Value>,
    pub system: String,
}
