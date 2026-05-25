//! Agent bridges. Phase 1d: ClaudeBridge (subprocess `claude
//! --output-format stream-json`). Gemini/Codex/OpenAI/SDK bridges are
//! Phase 2 (spec II.6). The normalized `BridgeEvent` is the exact wire
//! shape the `/ws/sessions` handler forwards (unchanged React client).

pub mod acp;
pub mod agentic_runner;
pub mod antigravity;
pub mod antigravity_sdk;
pub mod claude;
pub mod codex;
pub mod codex_client;
pub mod gemini;
pub mod kimi;
pub mod openai;
pub mod openai_compat;
pub mod openai_compat_tools;
pub mod permission;
pub mod perplexity;

use std::sync::Arc;

use http::HeaderMap;

/// Per-request override for a bridge. When `None`/empty, the bridge uses
/// its own construction-time defaults (env vars, hardcoded URLs, etc.).
/// Populated by the routing orchestrator (Task 16) when intelligent
/// routing is active.
#[derive(Debug, Clone, Default)]
pub struct BridgeContext {
    /// Overrides the bridge's outbound HTTP base URL.
    /// HTTP bridges apply directly; CLI bridges translate to env vars
    /// (`OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL`, `GEMINI_API_BASE`).
    pub base_url_override: Option<String>,
    /// Extra headers attached to outbound requests. HTTP bridges merge
    /// these into their request builder; CLI bridges currently ignore
    /// (CLIs negotiate their own auth).
    pub extra_headers: HeaderMap,
    /// Overrides the bridge's model selection. HTTP bridges substitute
    /// into the request body; Claude CLI passes via `--model`. Codex/
    /// Gemini CLIs may not honour runtime model override — flag as a
    /// known limitation but don't block.
    pub model_override: Option<String>,
}

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
    /// Shared driver for every OpenAI-compatible cloud provider in the
    /// catalog (DeepSeek, Grok, NVIDIA NIM, Kimi-API, Gemini-API,
    /// Ollama, plus OpenAI itself going forward). Provider id lives on
    /// the inner bridge so we can preserve isolation in error messages
    /// + telemetry without N near-identical enum variants.
    OpenAICompat(Arc<openai_compat::OpenAICompatBridge>),
    /// Perplexity (Sonar) gets its own variant because it ALSO emits
    /// citations / search_results alongside the text delta — bridges
    /// see those as new `BridgeEvent`s, the renderer parks them under
    /// the assistant bubble.
    Perplexity(Arc<perplexity::PerplexityBridge>),
    /// Kimi Code CLI (placeholder — the registry / dispatch surface is
    /// wired but the actual ACP spawn is deferred until Moonshot
    /// publishes a stable protocol spec).
    Kimi(Arc<kimi::KimiBridge>),
    /// Antigravity (`agy`) CLI — Google's terminal coding agent.
    /// Headless `-p` mode with `--conversation <uuid>` resume; no
    /// streaming until upstream adds a `stream-json` mode.
    Antigravity(Arc<antigravity::AntigravityBridge>),
    /// Antigravity SDK — the Python `google-antigravity` package, driven
    /// from a sidecar process. Sibling of `Antigravity` above but with
    /// real per-turn model selection (`LocalAgentConfig(model=...)`)
    /// and API-key auth instead of the CLI's OAuth.
    AntigravitySdk(Arc<antigravity_sdk::AntigravitySdkBridge>),
    /// Provider-agnostic agentic runner. Wraps any `ToolAdapter`
    /// (OpenAI-compat today; Anthropic/Gemini-direct/others slot in
    /// without enum churn) and drives the shared `drive_agentic_loop`,
    /// translating `TurnEvent` → `BridgeEvent` so the WS handler stays
    /// untouched. Dispatched by `chat.rs` when the session opts into
    /// tool use via `permission_mode = "acceptEdits"` (Chat-mode tools)
    /// or `"bypassPermissions"` (Autonomous tools).
    Agentic(Arc<agentic_runner::AgenticBridgeRunner>),
}

impl AnyBridge {
    pub async fn send_message(
        &self,
        msg: &str,
        ctx: BridgeContext,
    ) -> anyhow::Result<tokio::sync::mpsc::Receiver<BridgeEvent>> {
        match self {
            AnyBridge::Claude(b) => b.send_message(msg, ctx).await,
            AnyBridge::OpenAI(b) => b.send_message(msg, ctx).await,
            AnyBridge::Gemini(b) => b.send_message(msg, ctx).await,
            AnyBridge::Codex(b) => b.send_message(msg, ctx).await,
            AnyBridge::OpenAICompat(b) => b.send_message(msg, ctx).await,
            AnyBridge::Perplexity(b) => b.send_message(msg, ctx).await,
            AnyBridge::Kimi(b) => b.send_message(msg, ctx).await,
            AnyBridge::Antigravity(b) => b.send_message(msg, ctx).await,
            AnyBridge::AntigravitySdk(b) => b.send_message(msg, ctx).await,
            AnyBridge::Agentic(b) => b.send_message(msg, ctx).await,
        }
    }
    pub async fn abort(&self) {
        match self {
            AnyBridge::Claude(b) => b.abort().await,
            AnyBridge::OpenAI(b) => b.abort().await,
            AnyBridge::Gemini(b) => b.abort().await,
            AnyBridge::Codex(b) => b.abort().await,
            AnyBridge::OpenAICompat(b) => b.abort().await,
            AnyBridge::Perplexity(b) => b.abort().await,
            AnyBridge::Kimi(b) => b.abort().await,
            AnyBridge::Antigravity(b) => b.abort().await,
            AnyBridge::AntigravitySdk(b) => b.abort().await,
            AnyBridge::Agentic(b) => b.abort().await,
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
    Status {
        status: String,
    },
    Init {
        session_id: String,
        claude_session_id: Option<String>,
        model: String,
        tools_count: usize,
    },
    MessageDelta {
        text: String,
    },
    Thinking {
        text: String,
    },
    ToolStart {
        tool_id: String,
        name: String,
        input: Value,
    },
    ToolUpdate {
        tool_id: String,
        input: Value,
    },
    ToolEnd {
        tool_id: String,
        output: String,
        is_error: bool,
    },
    Cost {
        usage: Value,
        cost_usd: f64,
        model: String,
    },
    Error {
        error: String,
    },
    CompactBoundary {
        compact_metadata: Value,
    },
    /// Web citation emitted by search-grounded providers (Perplexity
    /// Sonar). Renderer renders these as a CitationCard under the
    /// assistant bubble; multiple Citation events accumulate into the
    /// same card client-side.
    Citation {
        url: String,
        title: Option<String>,
        snippet: Option<String>,
    },
    /// Richer search-result row from providers that surface them
    /// separately from citations (Perplexity's `search_results` field).
    /// Carries an explicit title + optional date so the card can render
    /// "Article — Site — 2026-01-01" rows.
    SearchResult {
        url: String,
        title: String,
        snippet: Option<String>,
        date: Option<String>,
    },
    /// The agentic loop's permission gate is asking the user to approve
    /// a write/shell tool that the session's mode flagged as Ask. The
    /// renderer shows an inline approve/deny dialog tied to `call_id`;
    /// clicking either button POSTs back to
    /// `/api/chat/permission_response`, which resolves the gate's
    /// pending oneshot and the loop continues. `tool_name` + `input`
    /// are included so the dialog can summarise the action.
    PermissionRequest {
        call_id: String,
        tool_name: String,
        input: Value,
    },
}

impl BridgeEvent {
    pub fn to_json(&self) -> Value {
        match self {
            BridgeEvent::Status { status } => json!({"type": "status", "status": status}),
            BridgeEvent::Init {
                session_id,
                claude_session_id,
                model,
                tools_count,
            } => json!({
                "type": "init", "session_id": session_id,
                "claude_session_id": claude_session_id, "model": model,
                "tools_count": tools_count
            }),
            BridgeEvent::MessageDelta { text } => {
                json!({"type": "message_delta", "delta": {"type": "text", "text": text}})
            }
            BridgeEvent::Thinking { text } => json!({"type": "thinking", "text": text}),
            BridgeEvent::ToolStart {
                tool_id,
                name,
                input,
            } => {
                json!({"type": "tool_start", "tool_id": tool_id, "name": name, "input": input})
            }
            BridgeEvent::ToolUpdate { tool_id, input } => {
                json!({"type": "tool_update", "tool_id": tool_id, "input": input})
            }
            BridgeEvent::ToolEnd {
                tool_id,
                output,
                is_error,
            } => json!({
                "type": "tool_end", "tool_id": tool_id, "output": output, "is_error": is_error
            }),
            BridgeEvent::Cost {
                usage,
                cost_usd,
                model,
            } => {
                json!({"type": "cost", "usage": usage, "cost_usd": cost_usd, "model": model})
            }
            BridgeEvent::Error { error } => json!({"type": "error", "error": error}),
            BridgeEvent::CompactBoundary { compact_metadata } => {
                json!({"type": "compact_boundary", "compact_metadata": compact_metadata})
            }
            BridgeEvent::Citation {
                url,
                title,
                snippet,
            } => json!({
                "type": "citation",
                "url": url,
                "title": title,
                "snippet": snippet,
            }),
            BridgeEvent::SearchResult {
                url,
                title,
                snippet,
                date,
            } => json!({
                "type": "search_result",
                "url": url,
                "title": title,
                "snippet": snippet,
                "date": date,
            }),
            BridgeEvent::PermissionRequest {
                call_id,
                tool_name,
                input,
            } => json!({
                "type": "permission_request",
                // `id` (not `call_id`) on the wire so the renderer reuses
                // its existing PermissionRequest store entry + dialog
                // component shape from the CLI-MCP flow. Backend keeps
                // `call_id` internally for clarity.
                "id": call_id,
                "tool_name": tool_name,
                "input": input,
            }),
        }
    }
}
