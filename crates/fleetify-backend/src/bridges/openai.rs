//! Faithful port of `services/openai_bridge.py` — HTTP streaming via the
//! OpenAI v1/chat/completions SSE wire, text-only (tool routing deferred).
//! Pure SSE parser is unit-tested; an axum-mock integration test asserts
//! the end-to-end init → delta → cost → done sequence without the
//! real openai.com.

use std::sync::Arc;

use futures_util::StreamExt;
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tokio::sync::Mutex;

use super::BridgeEvent;

const DEFAULT_MODEL: &str = "gpt-4o-mini";
const DEFAULT_BASE: &str = "https://api.openai.com";

/// Per-bridge state — rolling history + once-flags (parity with the
/// `_history` / `_init_emitted` fields in openai_bridge.py).
#[derive(Default)]
pub struct OpenAIState {
    pub history: Vec<Value>,
    pub init_emitted: bool,
}

pub struct OpenAIBridge {
    pub session_id: String,
    pub model: String,
    pub system_prompt: Option<String>,
    pub base_url: String,
    pub api_key: Option<String>,
    state: Arc<Mutex<OpenAIState>>,
    aborted: Arc<std::sync::atomic::AtomicBool>,
}

impl OpenAIBridge {
    pub fn new(session_id: impl Into<String>) -> Self {
        Self {
            session_id: session_id.into(),
            model: DEFAULT_MODEL.into(),
            system_prompt: None,
            base_url: std::env::var("OPENAI_BASE_URL").unwrap_or_else(|_| DEFAULT_BASE.into()),
            api_key: std::env::var("OPENAI_API_KEY").ok(),
            state: Arc::new(Mutex::new(OpenAIState::default())),
            aborted: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        }
    }

    pub async fn abort(&self) {
        self.aborted
            .store(true, std::sync::atomic::Ordering::SeqCst);
    }

    /// Spawn the streaming request → mpsc<BridgeEvent> (init/running/
    /// message_delta*/cost/done). Errors emit `Error` + `Status done`.
    pub async fn send_message(&self, message: &str) -> anyhow::Result<mpsc::Receiver<BridgeEvent>> {
        self.aborted
            .store(false, std::sync::atomic::Ordering::SeqCst);
        let (tx, rx) = mpsc::channel::<BridgeEvent>(256);

        if self.api_key.is_none() {
            // Skip the real request — parity with OpenAIUnavailable.
            let _ = tx
                .send(BridgeEvent::Error {
                    error: "OPENAI_API_KEY env var is not set".into(),
                })
                .await;
            let _ = tx
                .send(BridgeEvent::Status {
                    status: "done".into(),
                })
                .await;
            return Ok(rx);
        }

        let sid = self.session_id.clone();
        let model = self.model.clone();
        let base = self.base_url.clone();
        let api_key = self.api_key.clone().unwrap();
        let system = self.system_prompt.clone();
        let state = self.state.clone();
        let aborted = self.aborted.clone();
        let msg = message.to_string();

        tokio::spawn(async move {
            // ── Init (once) ──
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

            let url = format!("{}/v1/chat/completions", base.trim_end_matches('/'));
            let body = json!({
                "model": model,
                "messages": history,
                "stream": true,
                "stream_options": {"include_usage": true},
            });
            let resp = match reqwest::Client::new()
                .post(&url)
                .bearer_auth(&api_key)
                .json(&body)
                .send()
                .await
            {
                Ok(r) => r,
                Err(e) => {
                    let _ = tx
                        .send(BridgeEvent::Error {
                            error: format!("OpenAI request failed: {e}"),
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
                        error: format!("OpenAI {s}: {}", &body[..body.len().min(400)]),
                    })
                    .await;
                let _ = tx
                    .send(BridgeEvent::Status {
                        status: "done".into(),
                    })
                    .await;
                return;
            }

            // SSE loop — accumulate bytes, split on \n\n, parse data: <json>.
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

            // App pricing fallback (parity with calculate_cost in the
            // Python OpenAIBridge: it always computes via pricing because
            // the OpenAI SDK doesn't report cost_usd). Pricing table:
            // services::pricing.
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

/// Parse one SSE message block (possibly multi-line `data:` continuation)
/// into BridgeEvent steps. Pure — unit-testable without HTTP.
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
    fn parse_sse_text_delta_and_usage() {
        let mut text = String::new();
        let mut usage = json!({"input_tokens":0,"output_tokens":0,
            "cache_read_tokens":0,"cache_write_tokens":0});

        let steps = parse_sse_event(
            "data: {\"choices\":[{\"delta\":{\"content\":\"Hello\"}}]}\n\n",
            &mut text,
            &mut usage,
        );
        assert!(matches!(
            &steps[..],
            [SseStep::Event(BridgeEvent::MessageDelta { text: t })] if t == "Hello"
        ));
        assert_eq!(text, "Hello");

        let steps = parse_sse_event(
            "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":7,\"completion_tokens\":3,\
             \"prompt_tokens_details\":{\"cached_tokens\":2}}}\n\n",
            &mut text,
            &mut usage,
        );
        assert!(steps.is_empty(), "usage chunk emits no event");
        assert_eq!(usage["input_tokens"], 7);
        assert_eq!(usage["output_tokens"], 3);
        assert_eq!(usage["cache_read_tokens"], 2);

        let steps = parse_sse_event("data: [DONE]\n\n", &mut text, &mut usage);
        assert!(matches!(&steps[..], [SseStep::Done]));
    }

    #[tokio::test]
    async fn end_to_end_against_mock_sse_server() {
        // Mock OpenAI: serve a fixed SSE stream at /v1/chat/completions.
        let body = "data: {\"choices\":[{\"delta\":{\"content\":\"Hi\"}}]}\n\n\
                    data: {\"choices\":[{\"delta\":{\"content\":\" there\"}}]}\n\n\
                    data: {\"choices\":[],\"usage\":{\"prompt_tokens\":5,\"completion_tokens\":2,\
                    \"prompt_tokens_details\":{\"cached_tokens\":1}}}\n\n\
                    data: [DONE]\n\n";
        let app = axum::Router::new().route(
            "/v1/chat/completions",
            axum::routing::post(move || async move {
                axum::http::Response::builder()
                    .header("content-type", "text/event-stream")
                    .body(axum::body::Body::from(body))
                    .unwrap()
            }),
        );
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = l.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(l, app).await.unwrap() });

        std::env::set_var("OPENAI_API_KEY", "test-key");
        let mut b = OpenAIBridge::new("s1");
        b.base_url = format!("http://{addr}");
        let mut rx = b.send_message("hi").await.unwrap();

        let mut events: Vec<BridgeEvent> = Vec::new();
        while let Some(ev) = rx.recv().await {
            events.push(ev);
        }

        // Init → Status running → MessageDelta("Hi") → MessageDelta(" there")
        //   → Cost(usage) → Status done.
        assert!(matches!(events.first(), Some(BridgeEvent::Init { .. })));
        assert!(events
            .iter()
            .any(|e| matches!(e, BridgeEvent::Status { status } if status == "running")));
        let texts: Vec<&str> = events
            .iter()
            .filter_map(|e| match e {
                BridgeEvent::MessageDelta { text } => Some(text.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(texts, vec!["Hi", " there"]);
        let cost = events
            .iter()
            .find_map(|e| match e {
                BridgeEvent::Cost { usage, .. } => Some(usage.clone()),
                _ => None,
            })
            .expect("cost event");
        assert_eq!(cost["input_tokens"], 5);
        assert_eq!(cost["output_tokens"], 2);
        assert_eq!(cost["cache_read_tokens"], 1);
        assert!(matches!(events.last(), Some(BridgeEvent::Status { status }) if status == "done"));
    }
}
