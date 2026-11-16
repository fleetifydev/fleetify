//! OpenAI-compatible `ToolAdapter` implementation.
//!
//! Wires the shared `agentic::drive_agentic_loop` to every provider in the
//! catalog that speaks the `/chat/completions` SSE wire with the standard
//! tool-use shape: **openai, deepseek, grok, nvidia-nim, kimi-api,
//! gemini-api** (the OpenAI-compat shim, not the native Gemini API), and
//! **openrouter** (the OpenAI-compatible model aggregator).
//! Perplexity is intentionally out of scope here because it also emits
//! `citations` events the renderer wants to surface separately — it gets
//! its own adapter in the sibling file.
//!
//! Why a separate file from `openai_compat.rs`
//! -------------------------------------------
//!
//! The legacy `OpenAICompatBridge` is a single-shot chat driver — push
//! one user message, stream text back. Adding tool-use to it would
//! either bloat that file with a parallel code path (`if has_tools { ...
//! }`) or force a sweeping refactor. Instead, this file ships a thin
//! adapter that plugs into the new agentic loop; legacy sessions that
//! never opt into tools keep running through the old bridge unchanged.
//!
//! Wire shape (per OpenAI spec)
//! ----------------------------
//!
//! Request body:
//! ```json
//! {
//!   "model": "...",
//!   "messages": [
//!     {"role": "system", "content": "..."},
//!     {"role": "user", "content": "..."},
//!     {"role": "assistant", "content": null, "tool_calls": [
//!       {"id": "...", "type": "function", "function": {"name": "read_file", "arguments": "{...}"}}
//!     ]},
//!     {"role": "tool", "tool_call_id": "...", "content": "..."}
//!   ],
//!   "tools": [{"type": "function", "function": {"name", "description", "parameters"}}],
//!   "tool_choice": "auto",
//!   "stream": true,
//!   "stream_options": {"include_usage": true}
//! }
//! ```
//!
//! SSE deltas relevant to tool use:
//! - `choices[0].delta.content` → text chunk.
//! - `choices[0].delta.tool_calls[i].id` + `function.name` → first delta
//!   for index `i` (id + name arrive once each).
//! - `choices[0].delta.tool_calls[i].function.arguments` → JSON-string
//!   fragments that concatenate into a complete JSON object.
//! - `choices[0].finish_reason: "tool_calls"|"stop"` → turn boundary.

use std::collections::BTreeMap;

use anyhow::{anyhow, Result};
use futures_util::StreamExt;
use serde_json::{json, Value};
use tokio::sync::mpsc;

use crate::agentic::{
    adapter::ToolAdapter,
    catalog::Tool,
    events::{AdapterHistory, TurnEvent, TurnOutcome},
    executor::{ToolCall, ToolResult},
};

pub struct OpenAICompatToolAdapter {
    pub provider_id: &'static str,
    pub model: String,
    pub base_url: String,
    pub api_key: String,
    pub extra_headers: http::HeaderMap,
    /// Effort level from the session (e.g. "low", "medium", "high"). Only
    /// forwarded as `reasoning_effort` to providers whose capability is
    /// `EffortCapability::Levels` — sending it to non-reasoning models causes
    /// a 400, so the gate is strict.
    pub effort: Option<String>,
    /// Stream the `/chat/completions` response (the default). Forced off for
    /// providers in `BROKEN_STREAMING_TOOL_CALLS`, whose streaming tool calls
    /// are mis-serialised — see `streams_tool_calls`.
    streaming: bool,
    http: reqwest::Client,
}

/// Providers whose OpenAI-compatible endpoint mis-serialises tool calls into
/// `delta.content` as *text* when streaming (instead of `tool_calls` deltas),
/// which leaks raw `{"type":"function",...}` JSON into the chat. Their
/// NON-streaming responses return correct native `tool_calls`, so the adapter
/// drops to a single-shot request for them.
///
/// Verified 2026-06 against Cloudflare's
/// `@cf/meta/llama-3.3-70b-instruct-fp8-fast`: `stream:false` →
/// `message.tool_calls`; `stream:true` → the same call streamed as
/// `delta.content` text.
const BROKEN_STREAMING_TOOL_CALLS: &[&str] = &["cloudflare-workers-ai"];

/// Whether `provider_id` streams tool calls correctly. Most do; the few listed
/// in `BROKEN_STREAMING_TOOL_CALLS` need a non-streaming request instead.
fn streams_tool_calls(provider_id: &str) -> bool {
    !BROKEN_STREAMING_TOOL_CALLS.contains(&provider_id)
}

impl OpenAICompatToolAdapter {
    /// Build from a catalog `ProviderSpec`. Pulls the API key the same
    /// way the legacy bridge does (process-wide keyring cache → env-var
    /// fallback) so users get tool-use without re-entering keys.
    pub fn from_spec(
        spec: &'static crate::providers::ProviderSpec,
        model: impl Into<String>,
        ctx: &super::BridgeContext,
    ) -> Result<Self> {
        let env_hint = match spec.auth {
            crate::providers::AuthSpec::Bearer { env_hint } => env_hint,
            _ => None,
        };
        let api_key = crate::providers::keys::get_key_for(spec.id, ctx.account_id.as_deref())
            .or_else(|| env_hint.and_then(|n| std::env::var(n).ok()))
            .ok_or_else(|| {
                anyhow!(
                    "no API key for provider `{}` — connect it in Settings → Models",
                    spec.id
                )
            })?;
        Ok(Self {
            provider_id: spec.id,
            model: ctx.model_override.clone().unwrap_or_else(|| model.into()),
            base_url: ctx
                .base_url_override
                .clone()
                .unwrap_or_else(|| spec.default_base_url.to_string()),
            api_key,
            extra_headers: ctx.extra_headers.clone(),
            effort: None,
            streaming: streams_tool_calls(spec.id),
            http: reqwest::Client::new(),
        })
    }

    /// Set the effort level on an already-constructed adapter. Returns
    /// `self` for a builder-style call chain.
    ///
    /// The value is forwarded as `reasoning_effort` only when the model's
    /// `EffortCapability` is `Levels` — see `build_request_body`.
    pub fn with_effort(mut self, effort: Option<String>) -> Self {
        self.effort = effort;
        self
    }

    /// Test/internal constructor — bypasses key resolution so wiremock
    /// tests can point at a stubbed URL without touching the keyring.
    pub fn new_raw(
        provider_id: &'static str,
        model: String,
        base_url: String,
        api_key: String,
    ) -> Self {
        Self {
            provider_id,
            model,
            base_url,
            api_key,
            extra_headers: http::HeaderMap::new(),
            effort: None,
            streaming: true,
            http: reqwest::Client::new(),
        }
    }

    fn chat_endpoint(&self) -> String {
        // Same suffix logic as `openai_compat.rs`: bases already ending
        // in `/v1` or containing `/v1beta` get only `/chat/completions`
        // appended; bare roots get `/v1/chat/completions`. Keeps the
        // adapter's URL contract identical to the legacy bridge so
        // tested base URLs work in both paths.
        let trimmed = self.base_url.trim_end_matches('/');
        if trimmed.ends_with("/v1") || trimmed.contains("/v1beta") {
            format!("{trimmed}/chat/completions")
        } else {
            format!("{trimmed}/v1/chat/completions")
        }
    }

    /// Build the `/chat/completions` request body. Extracted as a pure
    /// function so unit tests can assert on the exact JSON without standing
    /// up a mock HTTP server.
    pub(crate) fn build_request_body(&self, history: &AdapterHistory, catalog: &[Tool]) -> Value {
        let mut body = json!({
            "model": self.model,
            "messages": history.messages,
            "tools": render_tools(catalog),
            "tool_choice": "auto",
            "stream": self.streaming,
        });
        // `stream_options.include_usage` is only meaningful when streaming,
        // and some compat providers reject it otherwise.
        if self.streaming {
            body["stream_options"] = json!({"include_usage": true});
        }

        // reasoning_effort: only for models whose capability is a discrete
        // level set (OpenAI gpt-5/o-series, Grok reasoning, Perplexity deep
        // research). Sending it to a non-reasoning model 400s the request,
        // so gate strictly on EffortCapability::Levels.
        if let Some(eff) = self.effort.as_deref().filter(|e| !e.is_empty()) {
            if matches!(
                crate::providers::capabilities::effort_capability(self.provider_id, &self.model),
                crate::providers::capabilities::EffortCapability::Levels { .. }
            ) {
                // Defensive clamp: the picker emits the model's own levels,
                // but a session carried over from a CLI model might hold
                // xhigh/max which aren't valid for the OpenAI-compat API.
                let api_effort = match eff {
                    "extra_high" | "xhigh" | "max" | "ultra_code" => "high",
                    other => other,
                };
                body["reasoning_effort"] = serde_json::json!(api_effort);
            }
        }

        body
    }
}

#[async_trait::async_trait]
impl ToolAdapter for OpenAICompatToolAdapter {
    fn init_history(&self, system_prompt: &str, user_message: &str) -> AdapterHistory {
        AdapterHistory {
            messages: vec![
                json!({"role": "system", "content": system_prompt}),
                json!({"role": "user", "content": user_message}),
            ],
            system: system_prompt.into(),
        }
    }

    async fn execute_turn(
        &self,
        history: &AdapterHistory,
        catalog: &[Tool],
        sink: &mpsc::Sender<TurnEvent>,
    ) -> Result<TurnOutcome> {
        let body = self.build_request_body(history, catalog);

        let mut req = self
            .http
            .post(self.chat_endpoint())
            .bearer_auth(&self.api_key)
            .json(&body);
        for (k, v) in self.extra_headers.iter() {
            req = req.header(k.as_str(), v.as_bytes());
        }

        let resp = req
            .send()
            .await
            .map_err(|e| anyhow!("{}: request failed: {e}", self.provider_id))?;
        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(anyhow!(
                "{}: provider returned {status}: {}",
                self.provider_id,
                fleetify_core::text::prefix_within_bytes(&body, 400)
            ));
        }

        if self.streaming {
            parse_sse_stream(resp, sink).await
        } else {
            parse_json_response(resp, sink).await
        }
    }

    fn append_assistant(&self, history: &mut AdapterHistory, outcome: &TurnOutcome) {
        let mut msg = json!({
            "role": "assistant",
            // OpenAI accepts content:null when only tool_calls are present.
            // Some compat providers (notably Groq) reject {content:""} so
            // we send null for the empty-text case rather than empty string.
            "content": if outcome.text.is_empty() {
                Value::Null
            } else {
                Value::String(outcome.text.clone())
            },
        });
        if !outcome.tool_calls.is_empty() {
            let calls: Vec<Value> = outcome
                .tool_calls
                .iter()
                .map(|c| {
                    json!({
                        "id": c.id,
                        "type": "function",
                        "function": {
                            "name": c.name,
                            // arguments is a STRING containing JSON (per
                            // OpenAI spec). serde_json::to_string preserves
                            // whatever shape the model emitted; we don't
                            // re-canonicalise to avoid drifting from what
                            // the model put on the wire.
                            "arguments": serde_json::to_string(&c.input).unwrap_or_else(|_| "{}".into()),
                        },
                    })
                })
                .collect();
            msg["tool_calls"] = Value::Array(calls);
        }
        history.messages.push(msg);
    }

    fn append_tool_results(&self, history: &mut AdapterHistory, results: &[ToolResult]) {
        for r in results {
            history.messages.push(json!({
                "role": "tool",
                "tool_call_id": r.tool_call_id,
                // OpenAI's spec accepts any string here. We don't tag the
                // error path differently — the model is expected to read
                // the content and figure out what went wrong (Tool error:
                // ... prefix from the executor is enough).
                "content": r.content,
            }));
        }
    }
}

// ───── tool schema renderer ────────────────────────────────────────────

fn render_tools(catalog: &[Tool]) -> Value {
    Value::Array(
        catalog
            .iter()
            .map(|t| {
                json!({
                    "type": "function",
                    "function": {
                        "name": t.name,
                        "description": t.description,
                        "parameters": t.parameters,
                    }
                })
            })
            .collect(),
    )
}

// ───── SSE stream parser ───────────────────────────────────────────────

/// Per-index partial tool call accumulated across SSE deltas. The first
/// delta carries `id` + `function.name`; subsequent deltas carry
/// arguments fragments that concatenate into a complete JSON object.
#[derive(Debug, Default)]
struct PartialToolCall {
    id: Option<String>,
    name: Option<String>,
    arguments: String,
}

impl PartialToolCall {
    fn finalize(self) -> Result<ToolCall> {
        let id = self
            .id
            .ok_or_else(|| anyhow!("tool_call delta missing id"))?;
        let name = self
            .name
            .ok_or_else(|| anyhow!("tool_call delta missing function.name"))?;
        // The model emits a JSON-as-string. If parsing fails we surface
        // the raw payload as an error rather than swallowing — typically
        // means the model emitted invalid JSON the provider didn't catch.
        let input: Value = serde_json::from_str(&self.arguments).map_err(|e| {
            anyhow!(
                "tool_call {name} (id={id}) had invalid JSON arguments `{}`: {e}",
                self.arguments
            )
        })?;
        Ok(ToolCall { id, name, input })
    }
}

fn find_double_newline(buf: &[u8]) -> Option<usize> {
    buf.windows(2).position(|w| w == b"\n\n")
}

async fn parse_sse_stream(
    resp: reqwest::Response,
    sink: &mpsc::Sender<TurnEvent>,
) -> Result<TurnOutcome> {
    let mut stream = resp.bytes_stream();
    let mut buf: Vec<u8> = Vec::new();
    let mut text = String::new();
    let mut tool_calls: BTreeMap<usize, PartialToolCall> = BTreeMap::new();
    let mut usage_in: u64 = 0;
    let mut usage_out: u64 = 0;

    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|e| anyhow!("SSE chunk read failed: {e}"))?;
        buf.extend_from_slice(&bytes);

        while let Some(pos) = find_double_newline(&buf) {
            let raw: Vec<u8> = buf.drain(..pos + 2).collect();
            let block = String::from_utf8_lossy(&raw);
            handle_sse_block(
                &block,
                &mut text,
                &mut tool_calls,
                &mut usage_in,
                &mut usage_out,
                sink,
            )
            .await?;
        }
    }

    let calls: Vec<ToolCall> = tool_calls
        .into_values()
        .map(|p| p.finalize())
        .collect::<Result<_>>()?;

    Ok(TurnOutcome {
        text,
        tool_calls: calls,
        usage: if usage_in + usage_out > 0 {
            Some((usage_in, usage_out))
        } else {
            None
        },
    })
}

/// Parse one SSE block (`data: ...\n\n`). Updates the per-turn
/// accumulators (text, tool_calls, usage) and pushes streaming events
/// (TextDelta) into the sink as they arrive.
async fn handle_sse_block(
    block: &str,
    text: &mut String,
    tool_calls: &mut BTreeMap<usize, PartialToolCall>,
    usage_in: &mut u64,
    usage_out: &mut u64,
    sink: &mpsc::Sender<TurnEvent>,
) -> Result<()> {
    // Combine `data:` lines (per SSE spec, single field can span lines;
    // OpenAI in practice always sends one `data:` per block but we
    // handle the spec-compliant case for safety).
    let mut data = String::new();
    for line in block.lines() {
        if let Some(rest) = line.strip_prefix("data:") {
            if !data.is_empty() {
                data.push('\n');
            }
            data.push_str(rest.trim_start());
        }
    }
    if data.is_empty() || data.trim() == "[DONE]" {
        return Ok(());
    }
    let v: Value = serde_json::from_str(&data)
        .map_err(|e| anyhow!("SSE payload not JSON: {e} — payload: `{data}`"))?;

    // Token usage (only present on the final chunk when
    // stream_options.include_usage=true).
    if let Some(u) = v.get("usage") {
        let g = |k: &str| u.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
        *usage_in = g("prompt_tokens");
        *usage_out = g("completion_tokens");
    }

    let Some(choices) = v.get("choices").and_then(|c| c.as_array()) else {
        return Ok(());
    };
    let Some(choice) = choices.first() else {
        return Ok(());
    };

    if let Some(delta) = choice.get("delta") {
        // Text content delta.
        if let Some(t) = delta.get("content").and_then(|x| x.as_str()) {
            if !t.is_empty() {
                text.push_str(t);
                let _ = sink.send(TurnEvent::TextDelta { text: t.into() }).await;
            }
        }
        // Reasoning content delta (OpenAI o-series / DeepSeek-R1 surface
        // reasoning under `reasoning_content`; the OpenAI Responses API
        // uses `reasoning`. Forward both as ThinkingDelta.)
        for key in ["reasoning_content", "reasoning"] {
            if let Some(t) = delta.get(key).and_then(|x| x.as_str()) {
                if !t.is_empty() {
                    let _ = sink.send(TurnEvent::ThinkingDelta { text: t.into() }).await;
                }
            }
        }
        // Tool call deltas.
        if let Some(calls) = delta.get("tool_calls").and_then(|c| c.as_array()) {
            for partial in calls {
                let idx = partial.get("index").and_then(|x| x.as_u64()).unwrap_or(0) as usize;
                let entry = tool_calls.entry(idx).or_default();
                if let Some(id) = partial.get("id").and_then(|x| x.as_str()) {
                    entry.id = Some(id.to_string());
                }
                if let Some(f) = partial.get("function") {
                    if let Some(n) = f.get("name").and_then(|x| x.as_str()) {
                        entry.name = Some(n.to_string());
                    }
                    if let Some(a) = f.get("arguments").and_then(|x| x.as_str()) {
                        entry.arguments.push_str(a);
                    }
                }
            }
        }
    }

    Ok(())
}

/// Parse a NON-streaming `/chat/completions` response. Used for providers in
/// `BROKEN_STREAMING_TOOL_CALLS` whose streamed tool calls leak as text. The
/// outcome mirrors `parse_sse_stream`: assistant text is emitted as a single
/// `TextDelta` (so the renderer still shows it) and `tool_calls` are read
/// straight off `choices[0].message`.
async fn parse_json_response(
    resp: reqwest::Response,
    sink: &mpsc::Sender<TurnEvent>,
) -> Result<TurnOutcome> {
    let v: Value = resp
        .json()
        .await
        .map_err(|e| anyhow!("non-streaming response was not JSON: {e}"))?;

    let message = v
        .get("choices")
        .and_then(|c| c.as_array())
        .and_then(|a| a.first())
        .and_then(|c| c.get("message"));

    let mut text = String::new();
    if let Some(t) = message
        .and_then(|m| m.get("content"))
        .and_then(|x| x.as_str())
    {
        if !t.is_empty() {
            text.push_str(t);
            let _ = sink.send(TurnEvent::TextDelta { text: t.into() }).await;
        }
    }

    let mut tool_calls = Vec::new();
    if let Some(calls) = message
        .and_then(|m| m.get("tool_calls"))
        .and_then(|c| c.as_array())
    {
        for (i, c) in calls.iter().enumerate() {
            let f = c.get("function");
            let name = f
                .and_then(|f| f.get("name"))
                .and_then(|x| x.as_str())
                .ok_or_else(|| anyhow!("tool_call missing function.name"))?
                .to_string();
            // Synthesize an id if the provider omitted one — the agentic loop
            // only needs it to be internally consistent (we rebuild the
            // assistant message ourselves), not to match the provider's id.
            let id = c
                .get("id")
                .and_then(|x| x.as_str())
                .filter(|s| !s.is_empty())
                .map(String::from)
                .unwrap_or_else(|| format!("call_{i}"));
            let args_str = f
                .and_then(|f| f.get("arguments"))
                .and_then(|x| x.as_str())
                .unwrap_or("{}");
            let input: Value = serde_json::from_str(args_str).map_err(|e| {
                anyhow!("tool_call {name} (id={id}) had invalid JSON arguments `{args_str}`: {e}")
            })?;
            tool_calls.push(ToolCall { id, name, input });
        }
    }

    let usage = v.get("usage").and_then(|u| {
        let g = |k: &str| u.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
        let (i, o) = (g("prompt_tokens"), g("completion_tokens"));
        (i + o > 0).then_some((i, o))
    });

    Ok(TurnOutcome {
        text,
        tool_calls,
        usage,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agentic::catalog::catalog_v1;
    use crate::agentic::events::AdapterHistory;
    use crate::agentic::executor::ToolResult;
    use serde_json::json;
    use wiremock::matchers::{body_partial_json, header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn adapter_for(server: &MockServer) -> OpenAICompatToolAdapter {
        OpenAICompatToolAdapter::new_raw(
            "test-provider",
            "test-model".into(),
            server.uri(),
            "test-key".into(),
        )
    }

    // ─── Pure schema / mapping tests ──────────────────────────────────

    #[test]
    fn render_tools_wraps_each_in_function_envelope() {
        let cat = catalog_v1();
        let v = render_tools(&cat);
        let arr = v.as_array().unwrap();
        assert_eq!(arr.len(), 7);
        for entry in arr {
            assert_eq!(entry["type"], "function");
            assert!(entry["function"]["name"].is_string());
            assert!(entry["function"]["description"].is_string());
            assert_eq!(entry["function"]["parameters"]["type"], "object");
        }
    }

    #[test]
    fn append_assistant_emits_null_content_when_only_tools() {
        let adapter =
            OpenAICompatToolAdapter::new_raw("x", "m".into(), "http://x".into(), "k".into());
        let mut h = AdapterHistory::default();
        adapter.append_assistant(
            &mut h,
            &TurnOutcome {
                text: String::new(),
                tool_calls: vec![ToolCall {
                    id: "tc-1".into(),
                    name: "read_file".into(),
                    input: json!({"path": "a.txt"}),
                }],
                usage: None,
            },
        );
        let msg = h.messages.last().unwrap();
        assert_eq!(msg["role"], "assistant");
        assert_eq!(msg["content"], Value::Null);
        let calls = msg["tool_calls"].as_array().unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0]["id"], "tc-1");
        // arguments is the STRING-encoded JSON, not nested JSON.
        let args_str = calls[0]["function"]["arguments"].as_str().unwrap();
        let parsed: Value = serde_json::from_str(args_str).unwrap();
        assert_eq!(parsed["path"], "a.txt");
    }

    #[test]
    fn append_tool_results_emits_one_role_tool_per_result() {
        let adapter =
            OpenAICompatToolAdapter::new_raw("x", "m".into(), "http://x".into(), "k".into());
        let mut h = AdapterHistory::default();
        adapter.append_tool_results(
            &mut h,
            &[
                ToolResult {
                    tool_call_id: "tc-1".into(),
                    content: "first".into(),
                    is_error: false,
                },
                ToolResult {
                    tool_call_id: "tc-2".into(),
                    content: "second".into(),
                    is_error: true,
                },
            ],
        );
        assert_eq!(h.messages.len(), 2);
        assert_eq!(h.messages[0]["role"], "tool");
        assert_eq!(h.messages[0]["tool_call_id"], "tc-1");
        assert_eq!(h.messages[0]["content"], "first");
        assert_eq!(h.messages[1]["tool_call_id"], "tc-2");
    }

    #[test]
    fn endpoint_logic_matches_legacy_bridge() {
        let a = OpenAICompatToolAdapter::new_raw(
            "x",
            "m".into(),
            "https://api.openai.com/v1".into(),
            "k".into(),
        );
        assert_eq!(
            a.chat_endpoint(),
            "https://api.openai.com/v1/chat/completions"
        );

        let b = OpenAICompatToolAdapter::new_raw(
            "x",
            "m".into(),
            "https://api.deepseek.com".into(),
            "k".into(),
        );
        assert_eq!(
            b.chat_endpoint(),
            "https://api.deepseek.com/v1/chat/completions"
        );

        let c = OpenAICompatToolAdapter::new_raw(
            "x",
            "m".into(),
            "https://generativelanguage.googleapis.com/v1beta/openai".into(),
            "k".into(),
        );
        assert_eq!(
            c.chat_endpoint(),
            "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
        );
    }

    #[test]
    fn partial_tool_call_finalises_with_complete_id_name_args() {
        let p = PartialToolCall {
            id: Some("tc-1".into()),
            name: Some("read_file".into()),
            arguments: r#"{"path":"a.txt"}"#.into(),
        };
        let call = p.finalize().unwrap();
        assert_eq!(call.id, "tc-1");
        assert_eq!(call.name, "read_file");
        assert_eq!(call.input["path"], "a.txt");
    }

    #[test]
    fn partial_tool_call_finalise_errors_on_invalid_json_args() {
        let p = PartialToolCall {
            id: Some("tc-1".into()),
            name: Some("x".into()),
            arguments: "not-json".into(),
        };
        let err = p.finalize().unwrap_err();
        assert!(err.to_string().contains("invalid JSON"));
    }

    // ─── wiremock integration: full agentic loop end-to-end ───────────

    fn sse_chunk(json: serde_json::Value) -> String {
        format!("data: {}\n\n", serde_json::to_string(&json).unwrap())
    }

    #[tokio::test]
    async fn execute_turn_streams_text_delta_and_reports_usage() {
        let server = MockServer::start().await;
        let body = [
            sse_chunk(json!({"choices":[{"index":0,"delta":{"content":"Hello "}}]})),
            sse_chunk(json!({"choices":[{"index":0,"delta":{"content":"world"}}]})),
            sse_chunk(json!({"choices":[{"index":0,"finish_reason":"stop"}]})),
            sse_chunk(json!({"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":2}})),
            "data: [DONE]\n\n".into(),
        ]
        .concat();

        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .and(header("authorization", "Bearer test-key"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("content-type", "text/event-stream")
                    .set_body_string(body),
            )
            .mount(&server)
            .await;

        let adapter = adapter_for(&server);
        let history = adapter.init_history("sys", "hi");
        let (tx, mut rx) = mpsc::channel(32);

        let outcome = adapter
            .execute_turn(&history, &catalog_v1(), &tx)
            .await
            .unwrap();

        // Streaming side: two TextDelta events arrived.
        drop(tx);
        let mut text_events = Vec::new();
        while let Some(e) = rx.recv().await {
            if let TurnEvent::TextDelta { text } = e {
                text_events.push(text);
            }
        }
        assert_eq!(text_events.join(""), "Hello world");

        // Consolidated outcome.
        assert_eq!(outcome.text, "Hello world");
        assert!(outcome.tool_calls.is_empty());
        assert_eq!(outcome.usage, Some((7, 2)));
    }

    #[tokio::test]
    async fn execute_turn_accumulates_tool_call_across_argument_deltas() {
        let server = MockServer::start().await;
        // Realistic OpenAI flow: first delta has id+name+empty args,
        // subsequent deltas stream the args JSON in pieces.
        let body = [
            sse_chunk(json!({"choices":[{"index":0,"delta":{"tool_calls":[
                {"index":0,"id":"call_abc","type":"function","function":{"name":"read_file","arguments":""}}
            ]}}]})),
            sse_chunk(json!({"choices":[{"index":0,"delta":{"tool_calls":[
                {"index":0,"function":{"arguments":"{\"path\":\""}}
            ]}}]})),
            sse_chunk(json!({"choices":[{"index":0,"delta":{"tool_calls":[
                {"index":0,"function":{"arguments":"foo.txt\"}"}}
            ]}}]})),
            sse_chunk(json!({"choices":[{"index":0,"finish_reason":"tool_calls"}]})),
            "data: [DONE]\n\n".into(),
        ]
        .concat();

        Mock::given(method("POST"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("content-type", "text/event-stream")
                    .set_body_string(body),
            )
            .mount(&server)
            .await;

        let adapter = adapter_for(&server);
        let history = adapter.init_history("sys", "find foo");
        let (tx, _rx) = mpsc::channel(32);

        let outcome = adapter
            .execute_turn(&history, &catalog_v1(), &tx)
            .await
            .unwrap();

        assert_eq!(outcome.text, "");
        assert_eq!(outcome.tool_calls.len(), 1);
        let call = &outcome.tool_calls[0];
        assert_eq!(call.id, "call_abc");
        assert_eq!(call.name, "read_file");
        assert_eq!(call.input["path"], "foo.txt");
    }

    #[tokio::test]
    async fn execute_turn_surfaces_provider_error_status() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(401).set_body_string(
                r#"{"error":{"message":"invalid api key","type":"invalid_request"}}"#,
            ))
            .mount(&server)
            .await;

        let adapter = adapter_for(&server);
        let history = adapter.init_history("sys", "hi");
        let (tx, _rx) = mpsc::channel(8);

        let err = adapter
            .execute_turn(&history, &catalog_v1(), &tx)
            .await
            .unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("401"));
        assert!(msg.contains("invalid api key"));
    }

    /// Regression: error bodies are not always ASCII (a localized API
    /// message, a Turkish proxy page). Cutting one at byte 400 inside a
    /// letter panicked instead of reporting the error.
    #[tokio::test]
    async fn execute_turn_cuts_a_non_ascii_error_body_on_a_character_boundary() {
        let server = MockServer::start().await;
        let body = format!("E{}", "ş".repeat(300)); // 601 bytes
        assert!(
            !body.is_char_boundary(400),
            "fixture must put byte 400 inside a letter"
        );
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(502).set_body_string(body.clone()))
            .mount(&server)
            .await;

        let adapter = adapter_for(&server);
        let history = adapter.init_history("sys", "hi");
        let (tx, _rx) = mpsc::channel(8);

        let err = adapter
            .execute_turn(&history, &catalog_v1(), &tx)
            .await
            .unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("502"));
        // The body is cut back to the 399 bytes before that letter.
        assert!(msg.ends_with(&format!(": {}", &body[..399])), "{msg}");
    }

    #[tokio::test]
    async fn full_loop_executes_tool_and_completes_with_text() {
        // Two-turn flow: provider asks read_file; bridge executes against
        // a real tempdir; provider receives the result and answers with
        // text. Validates the entire agentic pipeline end-to-end.
        use tempfile::tempdir;

        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join("hello.txt"), "hi from disk\n").unwrap();

        let server = MockServer::start().await;

        // Turn 1: model emits read_file tool call.
        let turn1 = [
            sse_chunk(json!({"choices":[{"index":0,"delta":{"tool_calls":[
                {"index":0,"id":"call_1","type":"function","function":{
                    "name":"read_file","arguments":"{\"path\":\"hello.txt\"}"
                }}
            ]}}]})),
            sse_chunk(json!({"choices":[{"index":0,"finish_reason":"tool_calls"}]})),
            "data: [DONE]\n\n".into(),
        ]
        .concat();

        // Turn 2: model emits final text, no more tools.
        let turn2 = [
            sse_chunk(
                json!({"choices":[{"index":0,"delta":{"content":"The file says: hi from disk"}}]}),
            ),
            sse_chunk(json!({"choices":[{"index":0,"finish_reason":"stop"}]})),
            "data: [DONE]\n\n".into(),
        ]
        .concat();

        // wiremock matches mounts in FIFO registration order; once a
        // mock hits its `up_to_n_times` cap it stops matching and the
        // next eligible mock takes over. Register turn1 first so the
        // FIRST request gets the tool-call response, then turn2.
        Mock::given(method("POST"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("content-type", "text/event-stream")
                    .set_body_string(turn1),
            )
            .up_to_n_times(1)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("content-type", "text/event-stream")
                    .set_body_string(turn2),
            )
            .up_to_n_times(1)
            .mount(&server)
            .await;

        let adapter = adapter_for(&server);
        let ws = crate::agentic::Workspace::new(dir.path()).unwrap();
        let (tx, mut rx) = mpsc::channel(64);

        crate::agentic::drive_agentic_loop(
            &adapter,
            &ws,
            crate::agentic::Mode::Autonomous,
            &crate::agentic::StaticGate(true),
            "you are helpful",
            "read hello.txt".into(),
            &catalog_v1(),
            tx,
            std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
        )
        .await
        .unwrap();

        let mut events = Vec::new();
        while let Some(e) = rx.recv().await {
            events.push(e);
        }
        let mut saw_tool_start = false;
        let mut saw_tool_end = false;
        let mut saw_final_text = false;
        for e in &events {
            match e {
                TurnEvent::ToolStart { call } if call.name == "read_file" => saw_tool_start = true,
                TurnEvent::ToolEnd { result } => {
                    saw_tool_end = true;
                    assert!(result.content.contains("hi from disk"));
                    assert!(!result.is_error);
                }
                TurnEvent::TextDelta { text } if text.contains("hi from disk") => {
                    saw_final_text = true
                }
                _ => {}
            }
        }
        assert!(saw_tool_start, "expected ToolStart for read_file");
        assert!(saw_tool_end, "expected ToolEnd with file contents");
        assert!(saw_final_text, "expected final text describing the file");
    }

    // ─── non-streaming path (Cloudflare tool-call workaround) ─────────────

    #[test]
    fn cloudflare_does_not_stream_tool_calls() {
        // Cloudflare's Workers AI compat endpoint serialises tool calls into
        // `delta.content` as text when streaming; everyone else streams fine.
        assert!(!streams_tool_calls("cloudflare-workers-ai"));
        assert!(streams_tool_calls("openai"));
        assert!(streams_tool_calls("deepseek"));
        assert!(streams_tool_calls("grok"));
    }

    #[tokio::test]
    async fn non_streaming_turn_parses_tool_calls_from_json_body() {
        let server = MockServer::start().await;
        let resp = json!({
            "choices": [{
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": null,
                    "tool_calls": [{
                        "id": "call_1",
                        "type": "function",
                        "function": {"name": "run_command", "arguments": "{\"command\":\"ls\"}"}
                    }]
                },
                "finish_reason": "tool_calls"
            }],
            "usage": {"prompt_tokens": 10, "completion_tokens": 5}
        });
        Mock::given(method("POST"))
            // The whole point: a non-streaming adapter must send stream:false,
            // because Cloudflare's *streaming* tool calls are broken.
            .and(body_partial_json(json!({"stream": false})))
            .respond_with(ResponseTemplate::new(200).set_body_json(resp))
            .mount(&server)
            .await;

        let mut adapter = adapter_for(&server);
        adapter.streaming = false;
        let history = adapter.init_history("sys", "list files");
        let (tx, _rx) = mpsc::channel(8);
        let outcome = adapter
            .execute_turn(&history, &catalog_v1(), &tx)
            .await
            .unwrap();
        assert_eq!(outcome.text, "");
        assert_eq!(outcome.tool_calls.len(), 1);
        assert_eq!(outcome.tool_calls[0].id, "call_1");
        assert_eq!(outcome.tool_calls[0].name, "run_command");
        assert_eq!(outcome.tool_calls[0].input["command"], "ls");
        assert_eq!(outcome.usage, Some((10, 5)));
    }

    #[tokio::test]
    async fn non_streaming_turn_emits_content_as_text_delta() {
        let server = MockServer::start().await;
        let resp = json!({
            "choices": [{
                "index": 0,
                "message": {"role": "assistant", "content": "Hello world"},
                "finish_reason": "stop"
            }],
            "usage": {"prompt_tokens": 3, "completion_tokens": 2}
        });
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(200).set_body_json(resp))
            .mount(&server)
            .await;

        let mut adapter = adapter_for(&server);
        adapter.streaming = false;
        let history = adapter.init_history("sys", "hi");
        let (tx, mut rx) = mpsc::channel(8);
        let outcome = adapter
            .execute_turn(&history, &catalog_v1(), &tx)
            .await
            .unwrap();
        drop(tx);
        let mut texts = Vec::new();
        while let Some(e) = rx.recv().await {
            if let TurnEvent::TextDelta { text } = e {
                texts.push(text);
            }
        }
        assert_eq!(texts.join(""), "Hello world");
        assert_eq!(outcome.text, "Hello world");
        assert!(outcome.tool_calls.is_empty());
        assert_eq!(outcome.usage, Some((3, 2)));
    }

    // ─── reasoning_effort gating ──────────────────────────────────────

    /// Helper: build a minimal AdapterHistory so we can call build_request_body.
    fn minimal_history() -> AdapterHistory {
        AdapterHistory {
            messages: vec![json!({"role": "user", "content": "hi"})],
            system: "sys".into(),
        }
    }

    #[test]
    fn reasoning_effort_included_for_levels_capable_model() {
        // openai/gpt-5.5 is Levels → reasoning_effort must appear in the body.
        let adapter = OpenAICompatToolAdapter::new_raw(
            "openai",
            "gpt-5.5".into(),
            "https://api.openai.com/v1".into(),
            "k".into(),
        )
        .with_effort(Some("high".into()));

        let body = adapter.build_request_body(&minimal_history(), &[]);
        assert_eq!(
            body["reasoning_effort"],
            serde_json::json!("high"),
            "reasoning_effort should be present for a Levels-capable model"
        );
    }

    #[test]
    fn reasoning_effort_omitted_when_effort_is_none() {
        // Even a Levels-capable model must NOT send reasoning_effort when
        // the session carries no effort setting.
        let adapter = OpenAICompatToolAdapter::new_raw(
            "openai",
            "gpt-5.5".into(),
            "https://api.openai.com/v1".into(),
            "k".into(),
        );
        // effort field defaults to None.

        let body = adapter.build_request_body(&minimal_history(), &[]);
        assert!(
            body.get("reasoning_effort").is_none(),
            "reasoning_effort must be absent when effort is None"
        );
    }

    #[test]
    fn reasoning_effort_omitted_for_non_reasoning_model() {
        // openai/gpt-4.1 is EffortCapability::None → reasoning_effort must
        // NOT appear even when the session carries an effort value, because
        // the provider would 400 the request.
        let adapter = OpenAICompatToolAdapter::new_raw(
            "openai",
            "gpt-4.1".into(),
            "https://api.openai.com/v1".into(),
            "k".into(),
        )
        .with_effort(Some("high".into()));

        let body = adapter.build_request_body(&minimal_history(), &[]);
        assert!(
            body.get("reasoning_effort").is_none(),
            "reasoning_effort must be absent for a non-reasoning model (avoids 400)"
        );
    }

    #[test]
    fn reasoning_effort_xhigh_clamped_to_high() {
        // "xhigh" is a valid picker value for CLI models but not for the
        // OpenAI HTTP API. The adapter must clamp it to "high".
        let adapter = OpenAICompatToolAdapter::new_raw(
            "openai",
            "gpt-5.5".into(),
            "https://api.openai.com/v1".into(),
            "k".into(),
        )
        .with_effort(Some("xhigh".into()));

        let body = adapter.build_request_body(&minimal_history(), &[]);
        assert_eq!(
            body["reasoning_effort"],
            serde_json::json!("high"),
            "xhigh must be clamped to high"
        );
    }

    #[test]
    fn reasoning_effort_included_for_grok_reasoning_model() {
        // grok/grok-4.3 is Levels in the capability table.
        let adapter = OpenAICompatToolAdapter::new_raw(
            "grok",
            "grok-4.3".into(),
            "https://api.x.ai/v1".into(),
            "k".into(),
        )
        .with_effort(Some("low".into()));

        let body = adapter.build_request_body(&minimal_history(), &[]);
        assert_eq!(
            body["reasoning_effort"],
            serde_json::json!("low"),
            "reasoning_effort should be forwarded for Grok reasoning models"
        );
    }

    #[test]
    fn reasoning_effort_omitted_for_grok_non_reasoning_model() {
        // grok/grok-4 (non-reasoning) is EffortCapability::None.
        let adapter = OpenAICompatToolAdapter::new_raw(
            "grok",
            "grok-4".into(),
            "https://api.x.ai/v1".into(),
            "k".into(),
        )
        .with_effort(Some("high".into()));

        let body = adapter.build_request_body(&minimal_history(), &[]);
        assert!(
            body.get("reasoning_effort").is_none(),
            "reasoning_effort must be absent for non-reasoning Grok model"
        );
    }
}
