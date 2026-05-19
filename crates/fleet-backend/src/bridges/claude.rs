//! Faithful port of `app/services/claude_bridge.py`. The stream-json
//! `parse_event` is pure + unit-tested (fidelity-critical); `ClaudeBridge`
//! drives the `claude` subprocess around it. `--mcp-config` injection and
//! `calculate_cost` fallback are Phase 4/3 (explicit, not silent).

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;

use serde_json::{json, Map, Value};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Child;
use tokio::sync::Mutex;

use super::BridgeEvent;

#[derive(Default)]
struct ToolBuf {
    tool_id: String,
    json: String,
    input: Map<String, Value>,
}

/// Per-turn parse state (parity with the ClaudeBridge instance flags).
pub struct ParseState {
    pub our_session_id: String,
    pub claude_session_id: Option<String>,
    model: Option<String>,
    streamed_any_text: bool,
    streamed_any_thinking: bool,
    streamed_tool_ids: HashSet<String>,
    tool_input_buffers: HashMap<i64, ToolBuf>,
    tool_states: HashMap<String, Value>, // tool_id → last input
}

impl ParseState {
    pub fn new(our_session_id: impl Into<String>) -> Self {
        Self {
            our_session_id: our_session_id.into(),
            claude_session_id: None,
            model: None,
            streamed_any_text: false,
            streamed_any_thinking: false,
            streamed_tool_ids: HashSet::new(),
            tool_input_buffers: HashMap::new(),
            tool_states: HashMap::new(),
        }
    }
}

fn s(v: &Value, k: &str) -> Option<String> {
    v.get(k).and_then(|x| x.as_str()).map(String::from)
}

/// Parse one stream-json event → normalized events (1:1 with `_parse_event`).
pub fn parse_event(event: &Value, st: &mut ParseState) -> Vec<BridgeEvent> {
    let mut out = Vec::new();
    let etype = event.get("type").and_then(|x| x.as_str()).unwrap_or("");

    match etype {
        "system" => {
            let subtype = event.get("subtype").and_then(|x| x.as_str()).unwrap_or("");
            if subtype == "init" {
                let sid = s(event, "session_id");
                if let Some(ref id) = sid {
                    st.claude_session_id = Some(id.clone());
                }
                let model = s(event, "model");
                if let Some(ref m) = model {
                    st.model = Some(m.clone());
                }
                let tools_count = event
                    .get("tools")
                    .and_then(|x| x.as_array())
                    .map(|a| a.len())
                    .unwrap_or(0);
                out.push(BridgeEvent::Init {
                    session_id: st.our_session_id.clone(),
                    claude_session_id: sid,
                    model: model.unwrap_or_else(|| "unknown".into()),
                    tools_count,
                });
            } else if subtype == "compact_boundary" {
                let meta = event.get("compact_metadata").cloned().unwrap_or(json!({}));
                out.push(BridgeEvent::CompactBoundary {
                    compact_metadata: json!({
                        "pre_tokens": meta.get("pre_tokens"),
                        "trigger": meta.get("trigger"),
                    }),
                });
            }
        }
        "stream_event" => {
            let inner = event.get("event").cloned().unwrap_or(json!({}));
            let it = inner.get("type").and_then(|x| x.as_str()).unwrap_or("");
            if it == "content_block_start" {
                let block = inner.get("content_block").cloned().unwrap_or(json!({}));
                if block.get("type").and_then(|x| x.as_str()) == Some("tool_use") {
                    let tool_id = s(&block, "id")
                        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
                    let name = s(&block, "name").unwrap_or_else(|| "unknown".into());
                    let initial = block.get("input").cloned().unwrap_or(json!({}));
                    let idx = inner.get("index").and_then(|x| x.as_i64()).unwrap_or(-1);
                    let input_map = initial.as_object().cloned().unwrap_or_default();
                    st.tool_input_buffers.insert(
                        idx,
                        ToolBuf { tool_id: tool_id.clone(), json: String::new(), input: input_map },
                    );
                    st.streamed_tool_ids.insert(tool_id.clone());
                    st.tool_states.insert(tool_id.clone(), initial.clone());
                    out.push(BridgeEvent::ToolStart { tool_id, name, input: initial });
                }
            } else if it == "content_block_delta" {
                let delta = inner.get("delta").cloned().unwrap_or(json!({}));
                match delta.get("type").and_then(|x| x.as_str()).unwrap_or("") {
                    "text_delta" => {
                        if let Some(c) = s(&delta, "text").filter(|c| !c.is_empty()) {
                            st.streamed_any_text = true;
                            out.push(BridgeEvent::MessageDelta { text: c });
                        }
                    }
                    "thinking_delta" => {
                        if let Some(c) = s(&delta, "thinking").filter(|c| !c.is_empty()) {
                            st.streamed_any_thinking = true;
                            out.push(BridgeEvent::Thinking { text: c });
                        }
                    }
                    "input_json_delta" => {
                        let idx = inner.get("index").and_then(|x| x.as_i64()).unwrap_or(-1);
                        if let Some(buf) = st.tool_input_buffers.get_mut(&idx) {
                            if let Some(pj) = s(&delta, "partial_json") {
                                buf.json.push_str(&pj);
                            }
                        }
                    }
                    _ => {}
                }
            } else if it == "content_block_stop" {
                let idx = inner.get("index").and_then(|x| x.as_i64()).unwrap_or(-1);
                if let Some(buf) = st.tool_input_buffers.remove(&idx) {
                    if !buf.json.is_empty() {
                        if let Ok(Value::Object(parsed)) =
                            serde_json::from_str::<Value>(&buf.json)
                        {
                            let mut input = buf.input.clone();
                            input.extend(parsed);
                            let iv = Value::Object(input);
                            st.tool_states.insert(buf.tool_id.clone(), iv.clone());
                            out.push(BridgeEvent::ToolUpdate {
                                tool_id: buf.tool_id,
                                input: iv,
                            });
                        }
                    }
                }
            }
        }
        "assistant" => {
            let blocks = event
                .get("message")
                .and_then(|m| m.get("content"))
                .and_then(|c| c.as_array())
                .cloned()
                .unwrap_or_default();
            for block in blocks {
                match block.get("type").and_then(|x| x.as_str()).unwrap_or("") {
                    "text" => {
                        if st.streamed_any_text {
                            continue;
                        }
                        out.push(BridgeEvent::MessageDelta {
                            text: s(&block, "text").unwrap_or_default(),
                        });
                    }
                    "thinking" => {
                        if st.streamed_any_thinking {
                            continue;
                        }
                        out.push(BridgeEvent::Thinking {
                            text: s(&block, "thinking").unwrap_or_default(),
                        });
                    }
                    "tool_use" => {
                        let tool_id = s(&block, "id")
                            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
                        let name = s(&block, "name").unwrap_or_else(|| "unknown".into());
                        let input = block.get("input").cloned().unwrap_or(json!({}));
                        if st.streamed_tool_ids.contains(&tool_id) {
                            let prev = st.tool_states.get(&tool_id).cloned().unwrap_or(json!({}));
                            if input.is_object()
                                && !input.as_object().unwrap().is_empty()
                                && input != prev
                            {
                                st.tool_states.insert(tool_id.clone(), input.clone());
                                out.push(BridgeEvent::ToolUpdate { tool_id, input });
                            }
                            continue;
                        }
                        st.tool_states.insert(tool_id.clone(), input.clone());
                        out.push(BridgeEvent::ToolStart { tool_id, name, input });
                    }
                    "tool_result" => {
                        let tool_id = s(&block, "tool_use_id").unwrap_or_default();
                        let content = block.get("content").cloned().unwrap_or(json!(""));
                        let output = if let Some(arr) = content.as_array() {
                            arr.iter()
                                .map(|c| {
                                    c.get("text")
                                        .and_then(|t| t.as_str())
                                        .map(String::from)
                                        .unwrap_or_else(|| c.to_string())
                                })
                                .collect::<Vec<_>>()
                                .join("\n")
                        } else if let Some(t) = content.as_str() {
                            t.to_string()
                        } else {
                            content.to_string()
                        };
                        let is_error =
                            block.get("is_error").and_then(|x| x.as_bool()).unwrap_or(false);
                        out.push(BridgeEvent::ToolEnd { tool_id, output, is_error });
                    }
                    _ => {}
                }
            }
        }
        "result" => {
            let usage = event.get("usage").cloned().unwrap_or(json!({}));
            let g = |k: &str| usage.get(k).and_then(|x| x.as_i64()).unwrap_or(0);
            let input_tokens = g("input_tokens");
            let output_tokens = g("output_tokens");
            let cache_read = g("cache_read_input_tokens");
            let cache_write = g("cache_creation_input_tokens");
            // calculate_cost fallback when total_cost_usd is 0 (parity with
            // the Python bridge: "use Claude's reported cost, fall back to
            // calculation"). Pricing table lives in services::pricing.
            let reported = event
                .get("total_cost_usd")
                .and_then(|x| x.as_f64())
                .unwrap_or(0.0);
            let cost_usd = if reported > 0.0 {
                reported
            } else if let Some(m) = &st.model {
                crate::services::pricing::calculate_cost(
                    m,
                    input_tokens,
                    output_tokens,
                    cache_read,
                    cache_write,
                )
            } else {
                0.0
            };
            out.push(BridgeEvent::Cost {
                usage: json!({
                    "input_tokens": input_tokens,
                    "output_tokens": output_tokens,
                    "cache_read_tokens": cache_read,
                    "cache_write_tokens": cache_write,
                }),
                cost_usd,
                model: st.model.clone().unwrap_or_else(|| "unknown".into()),
            });
        }
        _ => {}
    }
    out
}

/// Drives the `claude` subprocess. `--mcp-config` injection is Phase 4.
pub struct ClaudeBridge {
    pub session_id: String,
    pub project_path: String,
    pub claude_session_id: Option<String>,
    pub permission_mode: String,
    pub model_name: Option<String>,
    pub session_title: Option<String>,
    pub system_prompt: Option<String>,
    pub session_mode: String,
    child: Arc<Mutex<Option<Child>>>,
    aborted: Arc<std::sync::atomic::AtomicBool>,
}

impl ClaudeBridge {
    pub fn new(session_id: impl Into<String>, project_path: impl Into<String>) -> Self {
        Self {
            session_id: session_id.into(),
            project_path: project_path.into(),
            claude_session_id: None,
            permission_mode: "default".into(),
            model_name: None,
            session_title: None,
            system_prompt: None,
            session_mode: "new".into(),
            child: Arc::new(Mutex::new(None)),
            aborted: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        }
    }

    /// Faithful `_build_command` (minus `--mcp-config`, Phase 4).
    pub fn build_command(&self, message: &str) -> Vec<String> {
        let mut c = vec![
            "claude".into(),
            "-p".into(),
            "--output-format".into(),
            "stream-json".into(),
            "--verbose".into(),
            "--include-partial-messages".into(),
        ];
        if let Some(id) = &self.claude_session_id {
            c.push("--resume".into());
            c.push(id.clone());
        } else if self.session_mode == "continue" || self.session_mode == "resume" {
            c.push("--continue".into());
        }
        if let Some(m) = &self.model_name {
            c.push("--model".into());
            c.push(m.clone());
        }
        if let Some(t) = &self.session_title {
            c.push("--name".into());
            c.push(t.clone());
        }
        if let Some(sp) = &self.system_prompt {
            c.push("--system-prompt".into());
            c.push(sp.clone());
            c.push("--tools".into());
            c.push(String::new());
        }
        match self.permission_mode.as_str() {
            "bypassPermissions" | "dangerouslySkipPermissions" => {
                c.push("--dangerously-skip-permissions".into())
            }
            "acceptEdits" => {
                c.push("--permission-mode".into());
                c.push("acceptEdits".into());
            }
            _ => {}
        }
        c.push(message.to_string());
        c
    }

    /// Spawn + stream parsed events over an mpsc receiver (faithful
    /// `send_message`: status running → events → stderr-on-error → status done).
    pub async fn send_message(
        &self,
        message: &str,
    ) -> anyhow::Result<tokio::sync::mpsc::Receiver<BridgeEvent>> {
        let cmd = self.build_command(message);
        self.aborted.store(false, std::sync::atomic::Ordering::SeqCst);
        let cwd = if self.project_path.is_empty() {
            std::env::var("USERPROFILE")
                .or_else(|_| std::env::var("HOME"))
                .unwrap_or_else(|_| ".".into())
        } else {
            self.project_path.clone()
        };

        let mut command = tokio::process::Command::new(&cmd[0]);
        command
            .args(&cmd[1..])
            .current_dir(PathBuf::from(cwd))
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = command.spawn()?;
        let stdout = child.stdout.take().expect("piped stdout");
        let stderr = child.stderr.take();
        *self.child.lock().await = Some(child);

        let (tx, rx) = tokio::sync::mpsc::channel::<BridgeEvent>(256);
        let our_id = self.session_id.clone();
        let child_h = self.child.clone();
        let aborted = self.aborted.clone();

        tokio::spawn(async move {
            let _ = tx.send(BridgeEvent::Status { status: "running".into() }).await;
            let mut st = ParseState::new(our_id);
            let mut lines = BufReader::new(stdout).lines();
            let mut buffer = String::new();
            while let Ok(Some(raw)) = lines.next_line().await {
                if aborted.load(std::sync::atomic::Ordering::SeqCst) {
                    break;
                }
                let line = raw.trim();
                if line.is_empty() {
                    continue;
                }
                let event: Value = match serde_json::from_str(line) {
                    Ok(v) => {
                        buffer.clear();
                        v
                    }
                    Err(_) => {
                        buffer.push_str(line);
                        match serde_json::from_str(&buffer) {
                            Ok(v) => {
                                buffer.clear();
                                v
                            }
                            Err(_) => continue,
                        }
                    }
                };
                for ev in parse_event(&event, &mut st) {
                    if tx.send(ev).await.is_err() {
                        break;
                    }
                }
            }
            let code = {
                let mut guard = child_h.lock().await;
                if let Some(c) = guard.as_mut() {
                    c.wait().await.ok().and_then(|s| s.code())
                } else {
                    None
                }
            };
            if code.unwrap_or(0) != 0 {
                if let Some(mut e) = stderr {
                    let mut buf = String::new();
                    let _ = tokio::io::AsyncReadExt::read_to_string(&mut e, &mut buf).await;
                    let t = buf.trim();
                    if !t.is_empty() {
                        let _ = tx.send(BridgeEvent::Error { error: t.into() }).await;
                    }
                }
            }
            let _ = tx.send(BridgeEvent::Status { status: "done".into() }).await;
        });

        Ok(rx)
    }

    pub async fn abort(&self) {
        self.aborted.store(true, std::sync::atomic::Ordering::SeqCst);
        if let Some(c) = self.child.lock().await.as_mut() {
            let _ = c.start_kill();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn system_init_emits_init_with_our_session_id() {
        let mut st = ParseState::new("our-sid");
        let evs = parse_event(
            &json!({"type":"system","subtype":"init","session_id":"claude-123",
                    "model":"claude-opus-4-7","tools":[1,2,3]}),
            &mut st,
        );
        assert_eq!(
            evs,
            vec![BridgeEvent::Init {
                session_id: "our-sid".into(),
                claude_session_id: Some("claude-123".into()),
                model: "claude-opus-4-7".into(),
                tools_count: 3
            }]
        );
        assert_eq!(st.claude_session_id.as_deref(), Some("claude-123"));
    }

    #[test]
    fn streamed_tool_then_assistant_dedup() {
        let mut st = ParseState::new("s");
        // content_block_start (tool_use) → ToolStart, tracked.
        let e1 = parse_event(
            &json!({"type":"stream_event","event":{"type":"content_block_start",
                "index":0,"content_block":{"type":"tool_use","id":"t1","name":"Bash","input":{}}}}),
            &mut st,
        );
        assert_eq!(e1, vec![BridgeEvent::ToolStart {
            tool_id: "t1".into(), name: "Bash".into(), input: json!({})
        }]);
        // input_json_delta accumulates, content_block_stop → ToolUpdate.
        parse_event(
            &json!({"type":"stream_event","event":{"type":"content_block_delta",
                "index":0,"delta":{"type":"input_json_delta","partial_json":"{\"command\":\"ls\"}"}}}),
            &mut st,
        );
        let e3 = parse_event(
            &json!({"type":"stream_event","event":{"type":"content_block_stop","index":0}}),
            &mut st,
        );
        assert_eq!(e3, vec![BridgeEvent::ToolUpdate {
            tool_id: "t1".into(), input: json!({"command":"ls"})
        }]);
        // Trailing assistant tool_use with SAME id+input → deduped (no event).
        let e4 = parse_event(
            &json!({"type":"assistant","message":{"content":[
                {"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls"}}]}}),
            &mut st,
        );
        assert!(e4.is_empty(), "duplicate tool_use must be suppressed: {e4:?}");
    }

    #[test]
    fn streamed_text_suppresses_assistant_summary_text() {
        let mut st = ParseState::new("s");
        let d = parse_event(
            &json!({"type":"stream_event","event":{"type":"content_block_delta",
                "index":0,"delta":{"type":"text_delta","text":"Hello"}}}),
            &mut st,
        );
        assert_eq!(d, vec![BridgeEvent::MessageDelta { text: "Hello".into() }]);
        let a = parse_event(
            &json!({"type":"assistant","message":{"content":[
                {"type":"text","text":"Hello world"}]}}),
            &mut st,
        );
        assert!(a.is_empty(), "summary text must be suppressed after streaming");
    }

    #[test]
    fn result_emits_cost_with_usage_mapping() {
        let mut st = ParseState::new("s");
        parse_event(
            &json!({"type":"system","subtype":"init","session_id":"c","model":"claude-opus-4-7","tools":[]}),
            &mut st,
        );
        let evs = parse_event(
            &json!({"type":"result","total_cost_usd":0.0123,"usage":{
                "input_tokens":10,"output_tokens":20,
                "cache_read_input_tokens":5,"cache_creation_input_tokens":3}}),
            &mut st,
        );
        assert_eq!(evs, vec![BridgeEvent::Cost {
            usage: json!({"input_tokens":10,"output_tokens":20,
                          "cache_read_tokens":5,"cache_write_tokens":3}),
            cost_usd: 0.0123,
            model: "claude-opus-4-7".into()
        }]);
    }

    #[test]
    fn build_command_is_faithful() {
        let mut b = ClaudeBridge::new("s", "/tmp/x");
        b.model_name = Some("claude-opus-4-7".into());
        b.permission_mode = "acceptEdits".into();
        let c = b.build_command("hi");
        assert_eq!(&c[..6], &[
            "claude","-p","--output-format","stream-json","--verbose",
            "--include-partial-messages"
        ]);
        assert!(c.windows(2).any(|w| w == ["--model","claude-opus-4-7"]));
        assert!(c.windows(2).any(|w| w == ["--permission-mode","acceptEdits"]));
        assert_eq!(c.last().unwrap(), "hi");
    }
}
