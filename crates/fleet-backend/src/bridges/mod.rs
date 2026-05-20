//! Agent bridges. Phase 1d: ClaudeBridge (subprocess `claude
//! --output-format stream-json`). Gemini/Codex/OpenAI/SDK bridges are
//! Phase 2 (spec II.6). The normalized `BridgeEvent` is the exact wire
//! shape the `/ws/sessions` handler forwards (unchanged React client).

pub mod acp;
pub mod claude;
pub mod codex;
pub mod codex_client;
pub mod gemini;
pub mod openai;

use std::sync::Arc;

/// Tool-dispatch wrapper used by the `/ws/sessions` send flow (parity
/// with chat.py picking ClaudeBridge / SdkBridge / OpenAIBridge / Gemini
/// / Codex by `session.tool`). Gemini + Codex are honest deferred stubs
/// (Phase 2 follow-up) that emit a clear "not implemented" + done.
#[derive(Clone)]
pub enum AnyBridge {
    Claude(Arc<claude::ClaudeBridge>),
    OpenAI(Arc<openai::OpenAIBridge>),
    Gemini(Arc<gemini::GeminiBridge>),
    Codex(Arc<codex::CodexBridge>),
}

impl AnyBridge {
    pub async fn send_message(
        &self,
        msg: &str,
    ) -> anyhow::Result<tokio::sync::mpsc::Receiver<BridgeEvent>> {
        match self {
            AnyBridge::Claude(b) => b.send_message(msg).await,
            AnyBridge::OpenAI(b) => b.send_message(msg).await,
            AnyBridge::Gemini(b) => b.send_message(msg).await,
            AnyBridge::Codex(b) => b.send_message(msg).await,
        }
    }
    pub async fn abort(&self) {
        match self {
            AnyBridge::Claude(b) => b.abort().await,
            AnyBridge::OpenAI(b) => b.abort().await,
            AnyBridge::Gemini(b) => b.abort().await,
            AnyBridge::Codex(b) => b.abort().await,
        }
    }
    /// claude_session_id (if the agent emitted one in `init`). For
    /// non-Claude bridges this is `None` — no resumable session.
    pub fn claude_session_id(&self) -> Option<String> {
        match self {
            AnyBridge::Claude(b) => b.claude_session_id.clone(),
            _ => None,
        }
    }
}

use serde_json::{json, Value};

/// Normalized event (parity with `ClaudeBridgeEvent`). `to_json()` is the
/// exact `{type, …}` envelope sent over the chat WebSocket.
#[derive(Debug, Clone, PartialEq)]
pub enum BridgeEvent {
    Status { status: String },
    Init { session_id: String, claude_session_id: Option<String>, model: String, tools_count: usize },
    MessageDelta { text: String },
    Thinking { text: String },
    ToolStart { tool_id: String, name: String, input: Value },
    ToolUpdate { tool_id: String, input: Value },
    ToolEnd { tool_id: String, output: String, is_error: bool },
    Cost { usage: Value, cost_usd: f64, model: String },
    Error { error: String },
    CompactBoundary { compact_metadata: Value },
}

impl BridgeEvent {
    pub fn to_json(&self) -> Value {
        match self {
            BridgeEvent::Status { status } => json!({"type": "status", "status": status}),
            BridgeEvent::Init { session_id, claude_session_id, model, tools_count } => json!({
                "type": "init", "session_id": session_id,
                "claude_session_id": claude_session_id, "model": model,
                "tools_count": tools_count
            }),
            BridgeEvent::MessageDelta { text } => {
                json!({"type": "message_delta", "delta": {"type": "text", "text": text}})
            }
            BridgeEvent::Thinking { text } => json!({"type": "thinking", "text": text}),
            BridgeEvent::ToolStart { tool_id, name, input } => {
                json!({"type": "tool_start", "tool_id": tool_id, "name": name, "input": input})
            }
            BridgeEvent::ToolUpdate { tool_id, input } => {
                json!({"type": "tool_update", "tool_id": tool_id, "input": input})
            }
            BridgeEvent::ToolEnd { tool_id, output, is_error } => json!({
                "type": "tool_end", "tool_id": tool_id, "output": output, "is_error": is_error
            }),
            BridgeEvent::Cost { usage, cost_usd, model } => {
                json!({"type": "cost", "usage": usage, "cost_usd": cost_usd, "model": model})
            }
            BridgeEvent::Error { error } => json!({"type": "error", "error": error}),
            BridgeEvent::CompactBoundary { compact_metadata } => {
                json!({"type": "compact_boundary", "compact_metadata": compact_metadata})
            }
        }
    }
}
