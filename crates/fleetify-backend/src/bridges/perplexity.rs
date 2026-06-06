//! Perplexity (Sonar family) HTTP bridge. Shape is OpenAI-compatible
//! for the streaming text delta path; the difference is that Perplexity
//! also returns `citations: [{url, title?, ...}]` and (newer endpoints)
//! `search_results: [{url, title, snippet, date?}]` at the top level of
//! the final SSE chunk. We surface both as dedicated `BridgeEvent`s so
//! the renderer can render a CitationCard under the assistant message.
//!
//! Cribbed structure from `openai_compat.rs` rather than `use`-ing it —
//! Perplexity's parser needs to peek at the top-level JSON, not just
//! the `choices[].delta` path, so factoring it out would mean a wider
//! parser API for a one-off case. Duplication's cheaper than the
//! abstraction here.

use std::sync::Arc;

use futures_util::StreamExt;
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tokio::sync::Mutex;

use super::BridgeEvent;

const DEFAULT_BASE: &str = "https://api.perplexity.ai";
const PROVIDER_ID: &str = "perplexity";

#[derive(Default)]
struct PerplexityState {
    history: Vec<Value>,
    init_emitted: bool,
}

pub struct PerplexityBridge {
    pub session_id: String,
    pub model: String,
    pub system_prompt: Option<String>,
    pub base_url: String,
    pub api_key: Option<String>,
    state: Arc<Mutex<PerplexityState>>,
    aborted: Arc<std::sync::atomic::AtomicBool>,
}

impl PerplexityBridge {
    pub fn new(
        session_id: impl Into<String>,
        model: impl Into<String>,
        account_id: Option<&str>,
    ) -> Self {
        let api_key = crate::providers::keys::get_key_for(PROVIDER_ID, account_id)
            .or_else(|| std::env::var("PERPLEXITY_API_KEY").ok());
        let model = model.into();
        let base_url = resolve_base_url(&model);
        Self {
            session_id: session_id.into(),
            model,
            system_prompt: None,
            base_url,
            api_key,
            state: Arc::new(Mutex::new(PerplexityState::default())),
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

        let Some(api_key) = self.api_key.clone() else {
            let _ = tx
                .send(BridgeEvent::Error {
                    error: "No API key for perplexity. Connect it in Settings → Models.".into(),
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

            let url = format!("{}/chat/completions", base.trim_end_matches('/'));
            let body = json!({
                "model": model,
                "messages": history,
                "stream": true,
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
                            error: format!("perplexity request failed: {e}"),
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
                        error: format!("perplexity {s}: {}", &body[..body.len().min(400)]),
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
            // Citations + search_results land in the FINAL SSE chunk per
            // Perplexity's docs. Collect them as we see them so a delta
            // chunk that happens to include them isn't lost if the
            // stream terminates mid-flight.
            let mut citations: Vec<Value> = Vec::new();
            let mut search_results: Vec<Value> = Vec::new();
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
                    for ev in parse_sse_event(
                        &event_str,
                        &mut assistant_text,
                        &mut citations,
                        &mut search_results,
                        &mut usage,
                    ) {
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

            // Emit citations after the assistant text so the renderer
            // can park the CitationCard at the bottom of the bubble
            // without buffering deltas.
            for c in &citations {
                let url_str = c
                    .get("url")
                    .and_then(|u| u.as_str())
                    .unwrap_or("")
                    .to_string();
                if url_str.is_empty() {
                    continue;
                }
                let _ = tx
                    .send(BridgeEvent::Citation {
                        url: url_str,
                        title: c.get("title").and_then(|t| t.as_str()).map(String::from),
                        snippet: c.get("snippet").and_then(|s| s.as_str()).map(String::from),
                    })
                    .await;
            }
            for r in &search_results {
                let url_str = r
                    .get("url")
                    .and_then(|u| u.as_str())
                    .unwrap_or("")
                    .to_string();
                let title = r
                    .get("title")
                    .and_then(|t| t.as_str())
                    .unwrap_or("")
                    .to_string();
                if url_str.is_empty() || title.is_empty() {
                    continue;
                }
                let _ = tx
                    .send(BridgeEvent::SearchResult {
                        url: url_str,
                        title,
                        snippet: r.get("snippet").and_then(|s| s.as_str()).map(String::from),
                        date: r.get("date").and_then(|d| d.as_str()).map(String::from),
                    })
                    .await;
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
            let cost_usd = crate::services::pricing::calculate_cost(&model, i, o, 0, 0);
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

/// Pick the request base URL for a Perplexity model. Marketplace ids
/// (`anthropic/…`, `openai/…`, `google/…`, `xai/…`, `nvidia/…`) live at
/// `/v1/agent`; native Sonar ids hit the default chat-completions base.
fn resolve_base_url(model: &str) -> String {
    crate::providers::CATALOG
        .iter()
        .find(|p| p.id == PROVIDER_ID)
        .and_then(|p| p.default_models.iter().find(|m| m.id == model))
        .and_then(|m| m.endpoint)
        .map(|s| s.to_string())
        .unwrap_or_else(|| DEFAULT_BASE.to_string())
}

#[derive(Debug)]
enum SseStep {
    Event(BridgeEvent),
    Done,
}

fn find_double_newline(buf: &[u8]) -> Option<usize> {
    buf.windows(2).position(|w| w == b"\n\n")
}

fn parse_sse_event(
    block: &str,
    assistant_text: &mut String,
    citations: &mut Vec<Value>,
    search_results: &mut Vec<Value>,
    usage: &mut Value,
) -> Vec<SseStep> {
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
    // Perplexity-specific: top-level `citations` may be an array of
    // URL strings (older API) OR an array of objects (newer API).
    if let Some(cs) = v.get("citations").and_then(|c| c.as_array()) {
        for entry in cs {
            if let Some(url) = entry.as_str() {
                citations.push(json!({ "url": url }));
            } else if entry.is_object() {
                citations.push(entry.clone());
            }
        }
    }
    if let Some(rs) = v.get("search_results").and_then(|c| c.as_array()) {
        for entry in rs {
            if entry.is_object() {
                search_results.push(entry.clone());
            }
        }
    }
    if let Some(u) = v.get("usage") {
        let g = |k: &str| u.get(k).and_then(|x| x.as_i64()).unwrap_or(0);
        usage["input_tokens"] = json!(g("prompt_tokens"));
        usage["output_tokens"] = json!(g("completion_tokens"));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn model_endpoint(model_id: &str) -> Option<&'static str> {
        crate::providers::CATALOG
            .iter()
            .find(|p| p.id == "perplexity")
            .and_then(|p| p.default_models.iter().find(|m| m.id == model_id))
            .and_then(|m| m.endpoint)
    }

    #[test]
    fn sonar_model_uses_default_base() {
        let b = PerplexityBridge::new("s1", "sonar", None);
        assert_eq!(b.base_url, DEFAULT_BASE);
    }

    #[test]
    fn agent_model_uses_v1_agent_endpoint() {
        // The bridge looks up the catalog by model id; agent models
        // override the base URL via ModelSpec.endpoint.
        let b = PerplexityBridge::new("s1", "anthropic/claude-sonnet-4-6", None);
        assert!(b.base_url.ends_with("/v1/agent"));
        assert_eq!(
            b.base_url,
            model_endpoint("anthropic/claude-sonnet-4-6").unwrap()
        );
    }

    #[test]
    fn parser_extracts_citations_alongside_deltas() {
        let mut text = String::new();
        let mut citations = Vec::new();
        let mut results = Vec::new();
        let mut usage = json!({"input_tokens":0,"output_tokens":0,
            "cache_read_tokens":0,"cache_write_tokens":0});

        // Text delta only.
        let _ = parse_sse_event(
            "data: {\"choices\":[{\"delta\":{\"content\":\"Hello \"}}]}\n\n",
            &mut text,
            &mut citations,
            &mut results,
            &mut usage,
        );
        // Top-level string citations (legacy shape).
        let _ = parse_sse_event(
            "data: {\"choices\":[{\"delta\":{\"content\":\"world\"}}],\"citations\":[\"https://example.com/a\",\"https://example.com/b\"]}\n\n",
            &mut text,
            &mut citations,
            &mut results,
            &mut usage,
        );
        assert_eq!(text, "Hello world");
        assert_eq!(citations.len(), 2);
        assert_eq!(citations[0]["url"], "https://example.com/a");
        assert_eq!(citations[1]["url"], "https://example.com/b");
    }

    #[test]
    fn parser_extracts_search_results_objects() {
        let mut text = String::new();
        let mut citations = Vec::new();
        let mut results = Vec::new();
        let mut usage = json!({"input_tokens":0,"output_tokens":0,
            "cache_read_tokens":0,"cache_write_tokens":0});
        let _ = parse_sse_event(
            "data: {\"choices\":[],\"search_results\":[{\"url\":\"https://x/y\",\"title\":\"T\",\"snippet\":\"S\",\"date\":\"2026-01-01\"}]}\n\n",
            &mut text,
            &mut citations,
            &mut results,
            &mut usage,
        );
        assert_eq!(results.len(), 1);
        assert_eq!(results[0]["url"], "https://x/y");
        assert_eq!(results[0]["title"], "T");
    }
}
