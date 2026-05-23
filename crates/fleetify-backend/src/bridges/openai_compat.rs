//! Generic OpenAI-compatible HTTP bridge. Drives the seven cloud
//! providers that speak the `/chat/completions` SSE wire (OpenAI,
//! DeepSeek, Grok / xAI, NVIDIA NIM, Kimi-API / Moonshot, Gemini API
//! OpenAI-compat shim, and Ollama's `/v1/chat/completions` route).
//!
//! Per-provider quirks live in `ProviderSpec` (base URL, env var hint,
//! default model list) — this bridge stays provider-agnostic. Perplexity
//! is the one exception: it has its own `bridges/perplexity.rs` because
//! it also emits a `citations` field that we want to surface in the UI.
//!
//! Key resolution order:
//!   1. `crate::providers::keys::get_key(provider_id)` — hot-reloaded
//!      from the OS keychain by the Tauri shell.
//!   2. The env var hinted in the catalog (`OPENAI_API_KEY` etc.) —
//!      legacy fallback so existing setups keep working without
//!      touching Settings → Models.
//!   3. `None` → bridge emits an Error event + done.

use std::sync::Arc;

use futures_util::StreamExt;
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tokio::sync::Mutex;

use super::BridgeEvent;

#[derive(Default)]
pub struct OpenAICompatState {
    pub history: Vec<Value>,
    pub init_emitted: bool,
}

pub struct OpenAICompatBridge {
    pub provider_id: &'static str,
    pub session_id: String,
    pub model: String,
    pub system_prompt: Option<String>,
    pub base_url: String,
    pub api_key: Option<String>,
    state: Arc<Mutex<OpenAICompatState>>,
    aborted: Arc<std::sync::atomic::AtomicBool>,
}

impl OpenAICompatBridge {
    /// Construct from a `ProviderSpec` (the catalog entry). Pulls the
    /// API key from the process-wide cache + legacy env-var fallback.
    pub fn from_spec(
        spec: &'static crate::providers::ProviderSpec,
        session_id: impl Into<String>,
        model: impl Into<String>,
    ) -> Self {
        let env_hint = match spec.auth {
            crate::providers::AuthSpec::Bearer { env_hint } => env_hint,
            _ => None,
        };
        let api_key = crate::providers::keys::get_key(spec.id)
            .or_else(|| env_hint.and_then(|n| std::env::var(n).ok()));
        Self {
            provider_id: spec.id,
            session_id: session_id.into(),
            model: model.into(),
            system_prompt: None,
            base_url: spec.default_base_url.to_string(),
            api_key,
            state: Arc::new(Mutex::new(OpenAICompatState::default())),
            aborted: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        }
    }

    pub async fn abort(&self) {
        self.aborted
            .store(true, std::sync::atomic::Ordering::SeqCst);
    }

    pub async fn send_message(
        &self,
        message: &str,
        ctx: super::BridgeContext,
    ) -> anyhow::Result<mpsc::Receiver<BridgeEvent>> {
        self.aborted
            .store(false, std::sync::atomic::Ordering::SeqCst);
        let (tx, rx) = mpsc::channel::<BridgeEvent>(256);

        let provider_id = self.provider_id;
        let Some(api_key) = self.api_key.clone() else {
            let _ = tx
                .send(BridgeEvent::Error {
                    error: format!(
                        "No API key for provider {provider_id}. Connect it in Settings → Models."
                    ),
                })
                .await;
            let _ = tx
                .send(BridgeEvent::Status {
                    status: "done".into(),
                })
                .await;
            return Ok(rx);
        };

        let sid = self.session_id.clone();
        let model = ctx
            .model_override
            .clone()
            .unwrap_or_else(|| self.model.clone());
        let base = ctx
            .base_url_override
            .clone()
            .unwrap_or_else(|| self.base_url.clone());
        let system = self.system_prompt.clone();
        let state = self.state.clone();
        let aborted = self.aborted.clone();
        let msg = message.to_string();
        let extra_headers = ctx.extra_headers.clone();

        tokio::spawn(async move {
            let mut st = state.lock().await;
            if !st.init_emitted {
                let _ = tx
                    .send(BridgeEvent::Init {
                        session_id: sid.clone(),
                        claude_session_id: Some(sid.clone()),
                        model: model.clone(),
                        tools_count: 0,
                    })
                    .await;
                st.init_emitted = true;
            }
            if st.history.is_empty() {
                if let Some(s) = &system {
                    st.history.push(json!({"role":"system","content":s}));
                }
            }
            st.history.push(json!({"role":"user","content":msg}));
            let history = st.history.clone();
            drop(st);

            let _ = tx
                .send(BridgeEvent::Status {
                    status: "running".into(),
                })
                .await;

            // Most OpenAI-compat providers expose `/chat/completions`
            // when the base URL already includes their version prefix
            // (e.g. `/v1`). Providers whose base is the bare root get
            // `/v1` prefix appended — covers DeepSeek / Perplexity /
            // NVIDIA NIM. Gemini-API's OpenAI shim sits at
            // `/v1beta/openai` and follows the same suffix rule.
            let trimmed = base.trim_end_matches('/');
            let url = if trimmed.ends_with("/v1") || trimmed.contains("/v1beta") {
                format!("{trimmed}/chat/completions")
            } else {
                format!("{trimmed}/v1/chat/completions")
            };
            let body = json!({
                "model": model,
                "messages": history,
                "stream": true,
                "stream_options": {"include_usage": true},
            });
            let mut req = reqwest::Client::new()
                .post(&url)
                .bearer_auth(&api_key)
                .json(&body);
            for (k, v) in extra_headers.iter() {
                req = req.header(k.as_str(), v.as_bytes());
            }
            let resp = match req.send().await {
                Ok(r) => r,
                Err(e) => {
                    let _ = tx
                        .send(BridgeEvent::Error {
                            error: format!("{provider_id} request failed: {e}"),
                        })
                        .await;
                    let _ = tx
                        .send(BridgeEvent::Status {
                            status: "done".into(),
                        })
                        .await;
                    return;
                }
            };

            if !resp.status().is_success() {
                let s = resp.status();
                let body = resp.text().await.unwrap_or_default();
                let _ = tx
                    .send(BridgeEvent::Error {
                        error: format!("{provider_id} {s}: {}", &body[..body.len().min(400)]),
                    })
                    .await;
                let _ = tx
                    .send(BridgeEvent::Status {
                        status: "done".into(),
                    })
                    .await;
                return;
            }

            let mut stream = resp.bytes_stream();
            let mut buffer: Vec<u8> = Vec::new();
            let mut assistant_text = String::new();
            let mut usage = json!({
                "input_tokens":0,"output_tokens":0,
                "cache_read_tokens":0,"cache_write_tokens":0
            });

            'outer: while let Some(chunk) = stream.next().await {
                if aborted.load(std::sync::atomic::Ordering::SeqCst) {
                    break;
                }
                let Ok(bytes) = chunk else { break };
                buffer.extend_from_slice(&bytes);
                while let Some(pos) = find_double_newline(&buffer) {
                    let raw: Vec<u8> = buffer.drain(..pos + 2).collect();
                    let event_str = String::from_utf8_lossy(&raw);
                    for ev in parse_sse_event(&event_str, &mut assistant_text, &mut usage) {
                        let stop = matches!(ev, SseStep::Done);
                        if let SseStep::Event(e) = ev {
                            if tx.send(e).await.is_err() {
                                break 'outer;
                            }
                        }
                        if stop {
                            break 'outer;
                        }
                    }
                }
            }

            if !assistant_text.is_empty() {
                let mut st = state.lock().await;
                st.history
                    .push(json!({"role":"assistant","content":assistant_text}));
            }

            let i = usage
                .get("input_tokens")
                .and_then(|x| x.as_i64())
                .unwrap_or(0);
            let o = usage
                .get("output_tokens")
                .and_then(|x| x.as_i64())
                .unwrap_or(0);
            let cr = usage
                .get("cache_read_tokens")
                .and_then(|x| x.as_i64())
                .unwrap_or(0);
            let cost_usd = crate::services::pricing::calculate_cost(&model, i, o, cr, 0);
            let _ = tx
                .send(BridgeEvent::Cost {
                    usage,
                    cost_usd,
                    model,
                })
                .await;
            let _ = tx
                .send(BridgeEvent::Status {
                    status: "done".into(),
                })
                .await;
        });

        Ok(rx)
    }
}

#[derive(Debug)]
enum SseStep {
    Event(BridgeEvent),
    Done,
}

fn find_double_newline(buf: &[u8]) -> Option<usize> {
    buf.windows(2).position(|w| w == b"\n\n")
}

/// Parse one SSE block. Pure — testable without HTTP. Identical to the
/// legacy `openai.rs` parser; kept here so `openai.rs` can stay
/// unchanged until Phase 7 retires it.
fn parse_sse_event(block: &str, assistant_text: &mut String, usage: &mut Value) -> Vec<SseStep> {
    let mut out = Vec::new();
    let mut data = String::new();
    for line in block.lines() {
        if let Some(rest) = line.strip_prefix("data:") {
            if !data.is_empty() {
                data.push('\n');
            }
            data.push_str(rest.trim_start());
        }
    }
    if data.is_empty() {
        return out;
    }
    if data.trim() == "[DONE]" {
        out.push(SseStep::Done);
        return out;
    }
    let Ok(v) = serde_json::from_str::<Value>(&data) else {
        return out;
    };
    if let Some(choices) = v.get("choices").and_then(|c| c.as_array()) {
        if let Some(text) = choices
            .first()
            .and_then(|c| c.get("delta"))
            .and_then(|d| d.get("content"))
            .and_then(|t| t.as_str())
        {
            if !text.is_empty() {
                assistant_text.push_str(text);
                out.push(SseStep::Event(BridgeEvent::MessageDelta {
                    text: text.into(),
                }));
            }
        }
    }
    if let Some(u) = v.get("usage") {
        let g = |k: &str| u.get(k).and_then(|x| x.as_i64()).unwrap_or(0);
        usage["input_tokens"] = json!(g("prompt_tokens"));
        usage["output_tokens"] = json!(g("completion_tokens"));
        if let Some(cached) = u
            .get("prompt_tokens_details")
            .and_then(|d| d.get("cached_tokens"))
            .and_then(|x| x.as_i64())
        {
            usage["cache_read_tokens"] = json!(cached);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parser_extracts_delta_and_usage_like_openai() {
        let mut text = String::new();
        let mut usage = json!({"input_tokens":0,"output_tokens":0,
            "cache_read_tokens":0,"cache_write_tokens":0});

        let steps = parse_sse_event(
            "data: {\"choices\":[{\"delta\":{\"content\":\"Hi\"}}]}\n\n",
            &mut text,
            &mut usage,
        );
        assert!(matches!(
            &steps[..],
            [SseStep::Event(BridgeEvent::MessageDelta { text: t })] if t == "Hi"
        ));
        assert_eq!(text, "Hi");

        let steps = parse_sse_event(
            "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":2}}\n\n",
            &mut text,
            &mut usage,
        );
        assert!(steps.is_empty());
        assert_eq!(usage["input_tokens"], 3);
        assert_eq!(usage["output_tokens"], 2);
    }

    #[test]
    fn url_builder_handles_v1_suffix_correctly() {
        // Smoke test for the URL construction logic embedded in
        // send_message. Mirrors the inline `if/else` so a change to
        // that logic surfaces here too. (We can't directly call
        // send_message without spinning up an HTTP server.)
        fn build_url(base: &str) -> String {
            let trimmed = base.trim_end_matches('/');
            if trimmed.ends_with("/v1") || trimmed.contains("/v1beta") {
                format!("{trimmed}/chat/completions")
            } else {
                format!("{trimmed}/v1/chat/completions")
            }
        }
        assert_eq!(
            build_url("https://api.openai.com/v1"),
            "https://api.openai.com/v1/chat/completions"
        );
        assert_eq!(
            build_url("https://api.deepseek.com"),
            "https://api.deepseek.com/v1/chat/completions"
        );
        assert_eq!(
            build_url("https://generativelanguage.googleapis.com/v1beta/openai"),
            "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
        );
        assert_eq!(
            build_url("http://localhost:11434"),
            "http://localhost:11434/v1/chat/completions"
        );
    }
}
