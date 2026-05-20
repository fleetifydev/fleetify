//! Gemini CLI bridge over the Agent Client Protocol (ACP).
//!
//! Faithful port of `services/gemini_bridge.py`. Spawns `gemini --acp`,
//! drives the ACP handshake + session_new, then forwards `session/update`
//! notifications as `BridgeEvent`s the renderer already understands.
//!
//! Phase 2 cut: no MCP server attachment (empty list), no system_prompt
//! splice, no image inputs. The chat handler keys off `claude_session_id`
//! returned in `Init` to resume turns within the same bridge instance.
//! MCP wiring + system_prompt splice are next-phase increments.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use anyhow::{anyhow, Result};
use serde_json::{json, Value};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, Mutex};

use super::acp::AcpClient;
use super::BridgeEvent;

/// Seconds to wait for the ACP `initialize` response. If the handshake
/// doesn't complete in this window the subprocess has hung — bail out.
const INIT_TIMEOUT_SECS: u64 = 30;

/// Map Fleet's `permission_mode` strings to Gemini's `--approval-mode`.
fn approval_mode_to_acp(mode: &str) -> &'static str {
    match mode {
        "default" => "default",
        "acceptEdits" => "auto_edit",
        "bypassPermissions" | "dangerouslySkipPermissions" | "dontAsk" => "yolo",
        "plan" => "plan",
        _ => "default",
    }
}

fn gemini_oauth_creds_exist() -> bool {
    // Mirrors Python: USERPROFILE on Windows, HOME elsewhere.
    let home = std::env::var("USERPROFILE")
        .ok()
        .or_else(|| std::env::var("HOME").ok())
        .unwrap_or_else(|| "~".to_string());
    std::path::Path::new(&home)
        .join(".gemini")
        .join("oauth_creds.json")
        .exists()
}

/// Pick the best auth method id from the initialize() response.
/// Precedence: oauth-personal (creds on disk) → gemini-api-key (env) →
/// vertex-ai (GOOGLE_API_KEY + GOOGLE_CLOUD_PROJECT + GOOGLE_CLOUD_LOCATION).
fn select_auth_method(auth_methods: &Value) -> Option<String> {
    let arr = auth_methods.as_array()?;
    let ids: std::collections::HashSet<&str> = arr
        .iter()
        .filter_map(|m| m.get("id").and_then(|v| v.as_str()))
        .collect();
    if ids.contains("oauth-personal") && gemini_oauth_creds_exist() {
        return Some("oauth-personal".into());
    }
    if ids.contains("gemini-api-key") && std::env::var("GEMINI_API_KEY").is_ok() {
        return Some("gemini-api-key".into());
    }
    if ids.contains("vertex-ai")
        && std::env::var("GOOGLE_API_KEY").is_ok()
        && std::env::var("GOOGLE_CLOUD_PROJECT").is_ok()
        && std::env::var("GOOGLE_CLOUD_LOCATION").is_ok()
    {
        return Some("vertex-ai".into());
    }
    None
}

/// Translate an ACP tool_call / tool_call_update update to a Claude-style
/// (name, input) pair the Process Viewer already classifies. Faithful
/// with `_translate_acp_tool_call`.
fn translate_acp_tool_call(update: &Value) -> (String, Value) {
    let raw_kind = update
        .get("kind")
        .and_then(|v| v.as_str())
        .unwrap_or("other");
    let raw_input = update
        .get("rawInput")
        .cloned()
        .unwrap_or(Value::Object(Default::default()));
    let locations: Vec<Value> = update
        .get("locations")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    // Choose a Claude-style name from the kind.
    let tool_name = match raw_kind {
        "read" => "Read",
        "edit" => "Edit",
        "delete" => "Delete",
        "move" => "Move",
        "search" => "Grep",
        "execute" => "Bash",
        "think" => "Think",
        "fetch" => "WebFetch",
        _ => "Tool",
    }
    .to_string();

    let mut input = if raw_input.is_object() {
        raw_input
    } else {
        json!({})
    };
    // ACP sometimes only fills `locations` (path + optional line). Surface
    // the first location as `file_path` so the renderer's Read/Edit cards
    // render even when rawInput hasn't been populated yet.
    if input.get("file_path").is_none() {
        if let Some(p) = locations
            .first()
            .and_then(|l| l.get("path"))
            .and_then(|p| p.as_str())
        {
            input["file_path"] = Value::String(p.to_string());
        }
    }
    (tool_name, input)
}

/// Strip the literal `[Thought: true|false]` sentinel Gemini sometimes
/// leaks into agent_message_chunk payloads. Returns `(cleaned, had_marker)`.
fn strip_thought_marker(text: &str) -> (String, bool) {
    if !text.contains("[Thought") {
        return (text.to_string(), false);
    }
    // Conservative single-pass strip (no regex dep): walk and skip every
    // `[Thought: true]` / `[Thought: false]` token, tolerating optional
    // whitespace around it. Case-insensitive on the bool literal.
    let lower = text.to_lowercase();
    let mut out = String::with_capacity(text.len());
    let mut had = false;
    let mut i = 0usize;
    let bytes = text.as_bytes();
    let lo_bytes = lower.as_bytes();
    while i < bytes.len() {
        // Look for "[thought:" at this position (lowercase compare).
        if lo_bytes[i..].starts_with(b"[thought:") {
            // Advance to closing ']'.
            let close = lo_bytes[i..].iter().position(|&b| b == b']');
            if let Some(rel_end) = close {
                let end = i + rel_end + 1;
                // Trim a single adjacent leading space if it would leave
                // a double-space (mirrors the regex `\s*…\s*`).
                if !out.is_empty() && out.ends_with(' ') {
                    out.pop();
                }
                // Skip a single trailing space too.
                let mut j = end;
                while j < bytes.len() && (bytes[j] == b' ' || bytes[j] == b'\t') {
                    j += 1;
                }
                i = j;
                had = true;
                continue;
            }
        }
        out.push(bytes[i] as char);
        i += 1;
    }
    (out, had)
}

/// Extract a text representation of a tool's `content` blocks for
/// `tool_end`. Falls back to the raw value on unknown block kinds.
fn extract_tool_output(content: &Value) -> String {
    let Some(arr) = content.as_array() else {
        return String::new();
    };
    let mut buf = String::new();
    for block in arr {
        let kind = block.get("type").and_then(|v| v.as_str()).unwrap_or("");
        match kind {
            "content" => {
                if let Some(inner) = block.get("content") {
                    if let Some(text) = inner.get("text").and_then(|v| v.as_str()) {
                        if !buf.is_empty() {
                            buf.push('\n');
                        }
                        buf.push_str(text);
                    }
                }
            }
            "text" => {
                if let Some(text) = block.get("text").and_then(|v| v.as_str()) {
                    if !buf.is_empty() {
                        buf.push('\n');
                    }
                    buf.push_str(text);
                }
            }
            "diff" => {
                if let Some(p) = block.get("path").and_then(|v| v.as_str()) {
                    if !buf.is_empty() {
                        buf.push('\n');
                    }
                    buf.push_str(&format!("[diff: {p}]"));
                }
            }
            _ => {}
        }
    }
    buf
}

// ── Bridge state (Arc'd so handlers can hold a reference) ────────
struct State {
    client: Arc<AcpClient>,
    /// Process handle so abort() can SIGKILL on shutdown.
    _proc: Child,
    /// ACP session id returned by session/new (or session/load).
    acp_session_id: String,
    /// Model label (best-effort — Gemini doesn't surface it in init).
    model_label: String,
}

pub struct GeminiBridge {
    pub session_id: String,
    pub project_path: String,
    pub permission_mode: String,
    pub model_name: Option<String>,
    aborted: Arc<AtomicBool>,
    state: Arc<Mutex<Option<State>>>,
}

impl GeminiBridge {
    pub fn new(
        session_id: impl Into<String>,
        project_path: impl Into<String>,
        permission_mode: impl Into<String>,
        model_name: Option<String>,
    ) -> Self {
        Self {
            session_id: session_id.into(),
            project_path: project_path.into(),
            permission_mode: permission_mode.into(),
            model_name,
            aborted: Arc::new(AtomicBool::new(false)),
            state: Arc::new(Mutex::new(None)),
        }
    }

    /// Lazily spawn `gemini --acp`, run the ACP handshake, and create
    /// the ACP session. Idempotent — first call sets up State, later
    /// calls return immediately.
    async fn cold_start(&self) -> Result<()> {
        let mut guard = self.state.lock().await;
        if guard.is_some() {
            return Ok(());
        }
        let approval = approval_mode_to_acp(&self.permission_mode);
        let bin = which::which("gemini")
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| "gemini".to_string());

        let mut cmd = Command::new(&bin);
        cmd.arg("--acp").arg("--approval-mode").arg(approval);
        if let Some(m) = &self.model_name {
            cmd.arg("--model").arg(m);
        }
        let cwd = if self.project_path.is_empty() {
            std::env::var("USERPROFILE")
                .or_else(|_| std::env::var("HOME"))
                .unwrap_or_else(|_| ".".to_string())
        } else {
            self.project_path.clone()
        };
        cmd.current_dir(&cwd)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());

        let mut proc = match cmd.spawn() {
            Ok(p) => p,
            Err(e) => {
                return Err(anyhow!(
                    "Gemini CLI not found ({e}). Install: npm install -g @google/gemini-cli"
                ))
            }
        };

        let stdin = proc
            .stdin
            .take()
            .ok_or_else(|| anyhow!("no stdin for gemini --acp"))?;
        let stdout = proc
            .stdout
            .take()
            .ok_or_else(|| anyhow!("no stdout for gemini --acp"))?;

        // Drain stderr so MCP-server startup failures don't backpressure
        // the subprocess (matches the Python `_pump_stderr` task).
        if let Some(stderr) = proc.stderr.take() {
            tokio::spawn(async move {
                use tokio::io::{AsyncBufReadExt, BufReader};
                let mut r = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = r.next_line().await {
                    tracing::debug!(target: "gemini.stderr", "{line}");
                }
            });
        }

        let client = Arc::new(AcpClient::new());
        client.attach(stdout, stdin).await?;

        // ACP handshake.
        let client_caps = json!({ "fs": { "readTextFile": true, "writeTextFile": true } });
        let init = tokio::time::timeout(
            std::time::Duration::from_secs(INIT_TIMEOUT_SECS),
            client.initialize(client_caps),
        )
        .await
        .map_err(|_| {
            anyhow!(
                "Gemini timed out starting up after {INIT_TIMEOUT_SECS}s. Try again, or check that `gemini --acp` runs locally."
            )
        })??;

        let method_id = select_auth_method(init.get("authMethods").unwrap_or(&Value::Null))
            .ok_or_else(|| {
                anyhow!(
                    "Gemini not authenticated. Run `gemini` once interactively to log in, or set GEMINI_API_KEY."
                )
            })?;
        client.authenticate(&method_id).await?;

        // Empty MCP server list for Phase 2 cut (full MCP wiring later).
        let acp_session_id = client
            .session_new(&cwd, json!([]))
            .await
            .map_err(|e| anyhow!("session/new failed: {e}"))?;

        let model_label = self
            .model_name
            .clone()
            .unwrap_or_else(|| "unknown-gemini".to_string());

        *guard = Some(State {
            client,
            _proc: proc,
            acp_session_id,
            model_label,
        });
        Ok(())
    }

    pub async fn send_message(&self, msg: &str) -> Result<mpsc::Receiver<BridgeEvent>> {
        self.aborted.store(false, Ordering::SeqCst);
        let (tx, rx) = mpsc::channel::<BridgeEvent>(32);
        let bridge_tx = tx.clone();

        // Drive the turn on a background task so the caller gets the rx
        // immediately and events flow as they arrive.
        let session_id = self.session_id.clone();
        let state_mu = self.state.clone();
        let aborted = self.aborted.clone();
        let msg_owned = msg.to_string();
        let needs_cold_start = state_mu.lock().await.is_none();
        let cold_starter = if needs_cold_start {
            Some(self.cold_start_fut())
        } else {
            None
        };

        tokio::spawn(async move {
            if let Some(fut) = cold_starter {
                if let Err(e) = fut.await {
                    let _ = bridge_tx
                        .send(BridgeEvent::Error {
                            error: format!("Gemini start-up failed: {e}"),
                        })
                        .await;
                    let _ = bridge_tx
                        .send(BridgeEvent::Status {
                            status: "done".into(),
                        })
                        .await;
                    return;
                }
            }

            // Snapshot the AcpClient + acp_session_id under the mutex so
            // we don't hold the lock across the await.
            let (client, acp_sid, model_label) = {
                let g = state_mu.lock().await;
                match g.as_ref() {
                    Some(s) => (
                        s.client.clone(),
                        s.acp_session_id.clone(),
                        s.model_label.clone(),
                    ),
                    None => {
                        let _ = bridge_tx
                            .send(BridgeEvent::Error {
                                error: "Gemini bridge: cold start did not initialise".into(),
                            })
                            .await;
                        let _ = bridge_tx
                            .send(BridgeEvent::Status {
                                status: "done".into(),
                            })
                            .await;
                        return;
                    }
                }
            };

            // Emit a status:running + init event so the chat handler can
            // persist the ACP session id (parity with claude_session_id).
            let _ = bridge_tx
                .send(BridgeEvent::Status {
                    status: "running".into(),
                })
                .await;
            let _ = bridge_tx
                .send(BridgeEvent::Init {
                    session_id: session_id.clone(),
                    claude_session_id: Some(acp_sid.clone()),
                    model: model_label.clone(),
                    tools_count: 0,
                })
                .await;

            // Per-turn usage accumulator (Gemini may surface usage as a
            // session/update OR on the session_prompt response).
            let usage_acc = Arc::new(Mutex::new(UsageAcc::default()));

            // Wire the session_update handler to push translated events
            // into bridge_tx.
            let event_tx = bridge_tx.clone();
            let acc_clone = usage_acc.clone();
            let aborted_handler = aborted.clone();
            client
                .on_session_update(Arc::new(move |params: Value| {
                    let event_tx = event_tx.clone();
                    let acc = acc_clone.clone();
                    let aborted = aborted_handler.clone();
                    Box::pin(async move {
                        translate_session_update(params, &event_tx, &acc, &aborted).await;
                    })
                }))
                .await;

            // Send the prompt. The chat handler buffers the user message;
            // here we just wrap it in an ACP text block.
            let content = json!([{ "type": "text", "text": msg_owned }]);
            let prompt_res = client.session_prompt(&acp_sid, content).await;

            // Fold any usage surfaced on the session_prompt response.
            if let Ok(result) = &prompt_res {
                fold_usage_from_prompt_result(result, &usage_acc).await;
            }

            // Emit a Cost event if we accumulated any usage tokens.
            let final_usage = usage_acc.lock().await.clone();
            if final_usage.has_any() {
                let cost_usd = crate::services::pricing::calculate_cost(
                    &model_label,
                    final_usage.input_tokens as i64,
                    final_usage.output_tokens as i64,
                    final_usage.cache_read_tokens as i64,
                    final_usage.cache_write_tokens as i64,
                );
                let _ = bridge_tx
                    .send(BridgeEvent::Cost {
                        usage: final_usage.to_json(),
                        cost_usd,
                        model: model_label.clone(),
                    })
                    .await;
            }

            if let Err(e) = prompt_res {
                let _ = bridge_tx
                    .send(BridgeEvent::Error {
                        error: format!("Gemini prompt failed: {e}"),
                    })
                    .await;
            }

            let _ = bridge_tx
                .send(BridgeEvent::Status {
                    status: "done".into(),
                })
                .await;
        });

        Ok(rx)
    }

    /// Cancel the in-flight prompt. Best-effort — the ACP `session/cancel`
    /// is a notification, so any tail events from the agent flush
    /// naturally as `Status: done`.
    pub async fn abort(&self) {
        self.aborted.store(true, Ordering::SeqCst);
        let g = self.state.lock().await;
        if let Some(state) = g.as_ref() {
            let _ = state.client.session_cancel(&state.acp_session_id).await;
        }
    }

    // Helper used by send_message — wraps cold_start in a future so the
    // spawned task can drive it without holding the bridge ref.
    fn cold_start_fut(
        &self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<()>> + Send>> {
        // SAFETY: we only need a clone of fields; the future has 'static lifetime.
        let session_id = self.session_id.clone();
        let project_path = self.project_path.clone();
        let permission_mode = self.permission_mode.clone();
        let model_name = self.model_name.clone();
        let state = self.state.clone();
        Box::pin(async move {
            let bridge = GeminiBridge {
                session_id,
                project_path,
                permission_mode,
                model_name,
                aborted: Arc::new(AtomicBool::new(false)),
                state,
            };
            bridge.cold_start().await
        })
    }
}

// ── session/update → BridgeEvent translation ─────────────────────
#[derive(Clone, Default, Debug)]
struct UsageAcc {
    input_tokens: u64,
    output_tokens: u64,
    cache_read_tokens: u64,
    cache_write_tokens: u64,
}
impl UsageAcc {
    fn has_any(&self) -> bool {
        self.input_tokens + self.output_tokens + self.cache_read_tokens + self.cache_write_tokens > 0
    }
    fn to_json(&self) -> Value {
        json!({
            "input_tokens": self.input_tokens,
            "output_tokens": self.output_tokens,
            "cache_read_tokens": self.cache_read_tokens,
            "cache_write_tokens": self.cache_write_tokens,
        })
    }
}

async fn translate_session_update(
    params: Value,
    tx: &mpsc::Sender<BridgeEvent>,
    usage_acc: &Arc<Mutex<UsageAcc>>,
    aborted: &Arc<AtomicBool>,
) {
    if aborted.load(Ordering::SeqCst) {
        return;
    }
    let update = params.get("update").cloned().unwrap_or(Value::Null);
    let kind = update
        .get("sessionUpdate")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    match kind {
        "agent_message_chunk" => {
            let content = update.get("content").cloned().unwrap_or(Value::Null);
            let text = content
                .get("text")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let is_thought = content
                .get("annotations")
                .and_then(|a| a.get("thought"))
                .and_then(|t| t.as_bool())
                .unwrap_or(false);
            if !text.is_empty() {
                let (cleaned, had_marker) = strip_thought_marker(text);
                if (is_thought || had_marker) && !cleaned.is_empty() {
                    let _ = tx.send(BridgeEvent::Thinking { text: cleaned }).await;
                } else if !cleaned.is_empty() {
                    let _ = tx.send(BridgeEvent::MessageDelta { text: cleaned }).await;
                }
            }
        }
        "agent_thought_chunk" => {
            let text = update
                .get("content")
                .and_then(|c| c.get("text"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if !text.is_empty() {
                let (cleaned, _) = strip_thought_marker(text);
                if !cleaned.is_empty() {
                    let _ = tx.send(BridgeEvent::Thinking { text: cleaned }).await;
                }
            }
        }
        "tool_call" => {
            let (name, input) = translate_acp_tool_call(&update);
            let tool_id = update
                .get("toolCallId")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let _ = tx
                .send(BridgeEvent::ToolStart {
                    tool_id,
                    name,
                    input,
                })
                .await;
        }
        "tool_call_update" => {
            let status = update
                .get("status")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let tool_id = update
                .get("toolCallId")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();

            // Compose an `input_patch` for the renderer's Process Viewer.
            let mut input_patch = serde_json::Map::new();
            if update.get("rawInput").is_some() || update.get("locations").is_some() {
                let (_, translated) = translate_acp_tool_call(&update);
                if let Some(obj) = translated.as_object() {
                    for (k, v) in obj {
                        input_patch.insert(k.clone(), v.clone());
                    }
                }
            }
            if let Some(content) = update.get("content").and_then(|v| v.as_array()) {
                for block in content {
                    let bt = block.get("type").and_then(|v| v.as_str()).unwrap_or("");
                    if bt == "diff" {
                        if let Some(old) = block.get("oldText").and_then(|v| v.as_str()) {
                            input_patch
                                .insert("old_string".into(), Value::String(old.to_string()));
                        }
                        if let Some(new) = block.get("newText").and_then(|v| v.as_str()) {
                            input_patch
                                .insert("new_string".into(), Value::String(new.to_string()));
                        }
                        if !input_patch.contains_key("file_path") {
                            if let Some(p) = block.get("path").and_then(|v| v.as_str()) {
                                input_patch
                                    .insert("file_path".into(), Value::String(p.to_string()));
                            }
                        }
                    }
                }
            }
            if !input_patch.is_empty() {
                let _ = tx
                    .send(BridgeEvent::ToolUpdate {
                        tool_id: tool_id.clone(),
                        input: Value::Object(input_patch),
                    })
                    .await;
            }
            if status == "completed" || status == "failed" {
                let output = extract_tool_output(
                    update.get("content").unwrap_or(&Value::Null),
                );
                let _ = tx
                    .send(BridgeEvent::ToolEnd {
                        tool_id,
                        output,
                        is_error: status == "failed",
                    })
                    .await;
            }
        }
        "usage" => {
            let mut acc = usage_acc.lock().await;
            acc.input_tokens += update
                .get("input_tokens")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            acc.output_tokens += update
                .get("output_tokens")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            acc.cache_read_tokens += update
                .get("cached_tokens")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
        }
        _ => {}
    }
}

async fn fold_usage_from_prompt_result(result: &Value, acc: &Arc<Mutex<UsageAcc>>) {
    // Gemini surfaces usage either on the response itself, on `usage`, or
    // under `_meta.quota.token_count`. Probe all three.
    let candidates: Vec<&Value> = vec![
        result,
        result.get("usage").unwrap_or(&Value::Null),
        result
            .get("_meta")
            .and_then(|m| m.get("quota"))
            .and_then(|q| q.get("token_count"))
            .unwrap_or(&Value::Null),
    ];
    let mut g = acc.lock().await;
    for src in candidates {
        if let Value::Object(_) = src {
            if let Some(v) = src.get("input_tokens").and_then(|v| v.as_u64()) {
                g.input_tokens += v;
            }
            if let Some(v) = src.get("output_tokens").and_then(|v| v.as_u64()) {
                g.output_tokens += v;
            }
            if let Some(v) = src.get("cached_tokens").and_then(|v| v.as_u64()) {
                g.cache_read_tokens += v;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn approval_mapping() {
        assert_eq!(approval_mode_to_acp("default"), "default");
        assert_eq!(approval_mode_to_acp("acceptEdits"), "auto_edit");
        assert_eq!(approval_mode_to_acp("bypassPermissions"), "yolo");
        assert_eq!(approval_mode_to_acp("dangerouslySkipPermissions"), "yolo");
        assert_eq!(approval_mode_to_acp("dontAsk"), "yolo");
        assert_eq!(approval_mode_to_acp("plan"), "plan");
        // Unknown → default (parity with Python `.get(mode, "default")`).
        assert_eq!(approval_mode_to_acp("nope"), "default");
    }

    #[test]
    fn translate_acp_tool_call_maps_kinds_to_names() {
        let u = json!({ "kind": "read", "rawInput": { "file_path": "/x" } });
        let (n, i) = translate_acp_tool_call(&u);
        assert_eq!(n, "Read");
        assert_eq!(i["file_path"], "/x");

        let u = json!({ "kind": "edit", "rawInput": {} });
        assert_eq!(translate_acp_tool_call(&u).0, "Edit");

        let u = json!({ "kind": "execute", "rawInput": {} });
        assert_eq!(translate_acp_tool_call(&u).0, "Bash");

        let u = json!({ "kind": "search" });
        assert_eq!(translate_acp_tool_call(&u).0, "Grep");

        let u = json!({ "kind": "totally-new-kind" });
        assert_eq!(translate_acp_tool_call(&u).0, "Tool");

        // locations[0].path lifts into file_path when rawInput is empty.
        let u = json!({ "kind": "read", "locations": [{ "path": "/y", "line": 4 }] });
        let (_, i) = translate_acp_tool_call(&u);
        assert_eq!(i["file_path"], "/y");
    }

    #[test]
    fn strip_thought_marker_removes_marker_and_flags() {
        // Python's `\s*\[Thought:\s*(true|false)\]\s*` consumes whitespace
        // on BOTH sides — surrounding spaces collapse, not preserve.
        let (s, had) = strip_thought_marker("hello [Thought: true] world");
        assert!(had);
        assert_eq!(s, "helloworld");

        let (s, had) = strip_thought_marker("no marker here");
        assert!(!had);
        assert_eq!(s, "no marker here");

        // Mixed case + multiple markers.
        let (s, had) = strip_thought_marker("[Thought: TRUE] x [Thought: false]");
        assert!(had);
        assert_eq!(s.trim(), "x");
    }

    #[test]
    fn extract_tool_output_concatenates_text_and_inner_content() {
        let v = json!([
            { "type": "text", "text": "first" },
            { "type": "content", "content": { "text": "second" } },
            { "type": "diff", "path": "src/x.rs" },
        ]);
        let s = extract_tool_output(&v);
        assert!(s.contains("first"));
        assert!(s.contains("second"));
        assert!(s.contains("[diff: src/x.rs]"));
    }

    #[test]
    fn usage_acc_to_json_shape_matches_python() {
        let mut acc = UsageAcc::default();
        acc.input_tokens = 5;
        acc.output_tokens = 7;
        let v = acc.to_json();
        assert_eq!(v["input_tokens"], 5);
        assert_eq!(v["output_tokens"], 7);
        assert_eq!(v["cache_read_tokens"], 0);
        assert_eq!(v["cache_write_tokens"], 0);
    }
}
