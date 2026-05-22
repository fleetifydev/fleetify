//! Codex CLI bridge over the V2 protocol (`codex app-server` stdio).
//!
//! Faithful port of `services/codex_bridge.py` — Phase-2 cut focuses on
//! the streaming-text loop: spawn → V2 handshake → thread/start →
//! turn/start with text input, translate the notification methods the
//! renderer most depends on (item/agentMessage/delta, item/started,
//! item/completed, thread/tokenUsage/updated, turn/started,
//! turn/completed) to BridgeEvent, abort via turn/interrupt.
//!
//! Deferred to follow-up commits in Phase 2:
//! - Sub-agent (spawnAgent collab thread) tracking + parent_task_id
//!   tagging on forwarded events.
//! - Unified-diff parsing from item/* fileChange payloads → ToolUpdate
//!   { old_string, new_string } pairs.
//! - TOML inline-table emission of MCP server config via `-c` flags.
//! - Live approval flow (Fleet permission_handler routed through
//!   on_approval_request). The skeleton wires NO handler so any
//!   inbound approval gets a default `-32601 Method not handled`
//!   reply — Codex falls back to its own approval mode.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use anyhow::{anyhow, Result};
use serde_json::{json, Value};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, Mutex};

use super::codex_client::CodexClient;
use super::BridgeEvent;

const INIT_TIMEOUT_SECS: u64 = 30;

/// Fleet permission_mode → (approvalPolicy, sandbox). Mirrors `_PERM_MAP`.
fn permission_mode_to_codex(mode: &str) -> (&'static str, &'static str) {
    match mode {
        "default" => ("untrusted", "workspace-write"),
        "acceptEdits" => ("on-request", "workspace-write"),
        "bypassPermissions" | "dontAsk" => ("never", "danger-full-access"),
        "plan" => ("never", "read-only"),
        _ => ("untrusted", "workspace-write"),
    }
}

/// Effort picker → Codex model_reasoning_effort. `""` ⇒ don't pass the
/// `-c` override (use ~/.codex/config.toml's default).
fn effort_to_codex(effort: &str) -> &'static str {
    match effort {
        "low" => "low",
        "medium" => "medium",
        "high" | "extra_high" | "max" => "high",
        _ => "",
    }
}

/// V2 item kind → Claude-style tool name (faithful subset).
fn kind_to_tool_name(kind: &str) -> &'static str {
    match kind {
        "read" | "fileRead" | "file_read" => "Read",
        "edit" | "fileChange" | "file_change" => "Edit",
        "write" => "Write",
        "delete" => "Delete",
        "move" | "rename" => "Move",
        "exec" | "execute" | "commandExecution" | "command_execution" => "Bash",
        "search" | "fileSearch" | "file_search" => "Grep",
        "fetch" | "webFetch" | "web_fetch" => "WebFetch",
        "webSearch" | "web_search" => "WebSearch",
        "think" | "reasoning" => "Thinking",
        _ => "Tool",
    }
}

fn is_tool_kind(kind: &str) -> bool {
    matches!(
        kind,
        "read"
            | "fileRead"
            | "file_read"
            | "edit"
            | "fileChange"
            | "file_change"
            | "write"
            | "delete"
            | "move"
            | "rename"
            | "exec"
            | "execute"
            | "commandExecution"
            | "command_execution"
            | "search"
            | "fileSearch"
            | "file_search"
            | "fetch"
            | "webFetch"
            | "web_fetch"
            | "webSearch"
            | "web_search"
    )
}

struct State {
    client: Arc<CodexClient>,
    _proc: Child,
    thread_id: String,
    current_turn_id: Arc<Mutex<Option<String>>>,
    model_label: String,
}

pub struct CodexBridge {
    pub session_id: String,
    pub project_path: String,
    pub permission_mode: String,
    pub model_name: Option<String>,
    pub effort: String,
    /// Same gating semantics as ClaudeBridge::is_staff — `fleet_dispatch`
    /// is suppressed on staff sessions so they use the text-protocol
    /// dispatch path instead.
    pub is_staff: bool,
    /// Builtin template id (e.g. `"reverse_engineering"`) — opts the
    /// session into extra stdio MCPs like `fleet_reveng`.
    pub agent_template: Option<String>,
    aborted: Arc<AtomicBool>,
    state: Arc<Mutex<Option<State>>>,
}

impl CodexBridge {
    pub fn new(
        session_id: impl Into<String>,
        project_path: impl Into<String>,
        permission_mode: impl Into<String>,
        model_name: Option<String>,
        effort: impl Into<String>,
        is_staff: bool,
        agent_template: Option<String>,
    ) -> Self {
        Self {
            session_id: session_id.into(),
            project_path: project_path.into(),
            permission_mode: permission_mode.into(),
            model_name,
            effort: effort.into(),
            is_staff,
            agent_template,
            aborted: Arc::new(AtomicBool::new(false)),
            state: Arc::new(Mutex::new(None)),
        }
    }

    async fn cold_start(&self, base_url_override: Option<String>) -> Result<()> {
        let mut guard = self.state.lock().await;
        if guard.is_some() {
            return Ok(());
        }

        let (approval, sandbox) = permission_mode_to_codex(&self.permission_mode);
        let bin = which::which("codex")
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| "codex".to_string());

        let mut cmd = Command::new(&bin);
        cmd.args(["app-server", "--listen", "stdio://"]);
        if let Some(ref url) = base_url_override {
            cmd.env("OPENAI_BASE_URL", url);
        }
        let codex_effort = effort_to_codex(&self.effort);
        if !codex_effort.is_empty() {
            cmd.arg("-c")
                .arg(format!("model_reasoning_effort={codex_effort}"));
        }
        // Materialize the merged MCP map (user registry + fleet
        // builtins) into Codex `-c mcp_servers.<n>.X=<toml>` args.
        // Logged so a missing fleet_dispatch on a non-staff session is
        // visible without strace-ing the spawn.
        let mcp_map = crate::services::mcp_dispatch::build_merged_map(
            &self.session_id,
            self.is_staff,
            self.agent_template.as_deref(),
        );
        let mcp_args = crate::services::mcp_dispatch::to_codex_cli_args(&mcp_map);
        tracing::info!(
            target: "codex",
            session_id = %self.session_id,
            is_staff = self.is_staff,
            agent_template = self.agent_template.as_deref().unwrap_or(""),
            mcp_mounted = ?mcp_map.keys().collect::<Vec<_>>(),
            mcp_arg_count = mcp_args.len(),
            "codex MCP args built"
        );
        for a in &mcp_args {
            cmd.arg(a);
        }
        let cwd_raw = if self.project_path.is_empty() {
            std::env::var("USERPROFILE")
                .or_else(|_| std::env::var("HOME"))
                .unwrap_or_else(|_| ".".to_string())
        } else {
            self.project_path.clone()
        };
        // Strip Windows verbatim (`\\?\`) prefix — see notes in
        // bridges/gemini.rs cold_start. Same defensive normalization
        // for pre-existing session rows whose project_path was stored
        // before this fix landed.
        let cwd = fleetify_core::strip_verbatim_prefix(std::path::Path::new(&cwd_raw))
            .to_string_lossy()
            .into_owned();
        cmd.current_dir(&cwd)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());

        let mut proc = cmd.spawn().map_err(|e| {
            anyhow!(
                "Codex CLI not found ({e}). Install: `npm install -g @openai/codex` or see https://developers.openai.com/codex/cli"
            )
        })?;

        let stdin = proc
            .stdin
            .take()
            .ok_or_else(|| anyhow!("no stdin for codex app-server"))?;
        let stdout = proc
            .stdout
            .take()
            .ok_or_else(|| anyhow!("no stdout for codex app-server"))?;

        if let Some(stderr) = proc.stderr.take() {
            tokio::spawn(async move {
                use tokio::io::{AsyncBufReadExt, BufReader};
                let mut r = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = r.next_line().await {
                    tracing::debug!(target: "codex.stderr", "{line}");
                }
            });
        }

        let client = Arc::new(CodexClient::new());
        client.attach(stdout, stdin).await?;

        // Approval handler: auto-allow when permission_mode is one of
        // the bypass variants (where the user already opted into "no
        // prompts"), otherwise deny — the renderer's permission UI for
        // Codex sessions isn't wired yet so deny is the safe default.
        // The Python ships a richer renderer-prompt-and-wait flow; that
        // lands once a renderer permission_handler IPC exists.
        let perm_mode = self.permission_mode.clone();
        client
            .on_approval_request(Arc::new(move |method: String, _params| {
                let bypass = matches!(perm_mode.as_str(), "bypassPermissions" | "dontAsk");
                Box::pin(async move {
                    if bypass {
                        // Approval shape varies per method; the safest
                        // shared shape is `{ decision: "approved" }`.
                        Ok(serde_json::json!({ "decision": "approved" }))
                    } else {
                        tracing::warn!(
                            target: "codex.approval",
                            "auto-denied approval for {method} — renderer permission UI not wired"
                        );
                        Ok(serde_json::json!({ "decision": "denied" }))
                    }
                })
            }))
            .await;

        // V2 handshake: initialize → initialized notification → thread/start.
        tokio::time::timeout(
            std::time::Duration::from_secs(INIT_TIMEOUT_SECS),
            client.initialize("fleet", "0.1.0", Some("Fleet"), None),
        )
        .await
        .map_err(|_| {
            anyhow!(
                "Codex initialize timed out after {INIT_TIMEOUT_SECS}s. Try again, or run `codex app-server --listen stdio://` manually to debug."
            )
        })??;
        client.send_initialized().await?;

        let thread_id = tokio::time::timeout(
            std::time::Duration::from_secs(INIT_TIMEOUT_SECS),
            client.thread_start(&cwd, sandbox, approval, self.model_name.as_deref(), None),
        )
        .await
        .map_err(|_| anyhow!("Codex thread/start timed out after {INIT_TIMEOUT_SECS}s."))??;

        let model_label = self
            .model_name
            .clone()
            .unwrap_or_else(|| "gpt-5.4".to_string());

        *guard = Some(State {
            client,
            _proc: proc,
            thread_id,
            current_turn_id: Arc::new(Mutex::new(None)),
            model_label,
        });
        Ok(())
    }

    pub async fn send_message(
        &self,
        msg: &str,
        ctx: super::BridgeContext,
    ) -> Result<mpsc::Receiver<BridgeEvent>> {
        self.aborted.store(false, Ordering::SeqCst);
        let (tx, rx) = mpsc::channel::<BridgeEvent>(64);
        let bridge_tx = tx.clone();

        // model_override is not honoured at runtime for the Codex CLI
        // bridge: model is configured via TOML at app-server startup.
        // Documented Day-1 limit (v1.1 routing risk per spec).
        if ctx.model_override.is_some() {
            tracing::warn!(
                target: "codex",
                "Codex bridge: model_override not supported (TOML-only config). Ignoring."
            );
        }
        // base_url_override is applied as OPENAI_BASE_URL in the cold
        // start path. Once the app-server subprocess is up, mid-session
        // env changes don't take effect — first turn only.
        if let Some(ref url) = ctx.base_url_override {
            tracing::debug!(target: "codex", "Codex base_url_override request: {url} (only applies on cold start)");
        }

        let session_id = self.session_id.clone();
        let state_mu = self.state.clone();
        let aborted = self.aborted.clone();
        let msg_owned = msg.to_string();
        let needs_cold_start = state_mu.lock().await.is_none();
        let cold_starter = if needs_cold_start {
            Some(self.cold_start_fut(ctx.base_url_override.clone()))
        } else {
            None
        };

        tokio::spawn(async move {
            if let Some(fut) = cold_starter {
                if let Err(e) = fut.await {
                    let _ = bridge_tx
                        .send(BridgeEvent::Error {
                            error: format!("Codex start-up failed: {e}"),
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

            let (client, thread_id, current_turn_id, model_label) = {
                let g = state_mu.lock().await;
                match g.as_ref() {
                    Some(s) => (
                        s.client.clone(),
                        s.thread_id.clone(),
                        s.current_turn_id.clone(),
                        s.model_label.clone(),
                    ),
                    None => {
                        let _ = bridge_tx
                            .send(BridgeEvent::Error {
                                error: "Codex bridge: cold start did not initialise".into(),
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

            let _ = bridge_tx
                .send(BridgeEvent::Status {
                    status: "running".into(),
                })
                .await;
            let _ = bridge_tx
                .send(BridgeEvent::Init {
                    session_id: session_id.clone(),
                    claude_session_id: Some(thread_id.clone()),
                    model: model_label.clone(),
                    tools_count: 0,
                })
                .await;

            let usage_acc = Arc::new(Mutex::new(UsageAcc::default()));

            // ── Notification handlers (registered before turn/start) ──
            let tx_msg = bridge_tx.clone();
            client
                .on_notification(
                    "item/agentMessage/delta",
                    Arc::new(move |params: Value| {
                        let tx = tx_msg.clone();
                        Box::pin(async move {
                            // Per AgentMessageDeltaNotification.json: `delta`
                            // IS the string; tolerate nested {text:...} for
                            // pre-release builds.
                            let text = match params.get("delta") {
                                Some(Value::String(s)) => s.clone(),
                                Some(Value::Object(o)) => o
                                    .get("text")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("")
                                    .to_string(),
                                _ => params
                                    .get("text")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("")
                                    .to_string(),
                            };
                            if !text.is_empty() {
                                let _ = tx.send(BridgeEvent::MessageDelta { text }).await;
                            }
                        })
                    }),
                )
                .await;

            let turn_id_started = current_turn_id.clone();
            client
                .on_notification(
                    "turn/started",
                    Arc::new(move |params: Value| {
                        let cell = turn_id_started.clone();
                        Box::pin(async move {
                            // Schema: params.turn.id (defensive fallback to
                            // turnId / turn_id for pre-release builds).
                            let tid = params
                                .get("turn")
                                .and_then(|t| t.get("id"))
                                .and_then(|v| v.as_str())
                                .or_else(|| params.get("turnId").and_then(|v| v.as_str()))
                                .or_else(|| params.get("turn_id").and_then(|v| v.as_str()))
                                .map(String::from);
                            if let Some(t) = tid {
                                *cell.lock().await = Some(t);
                            }
                        })
                    }),
                )
                .await;

            let turn_done = Arc::new(tokio::sync::Notify::new());
            let turn_done_completed = turn_done.clone();
            let acc_completed = usage_acc.clone();
            client
                .on_notification(
                    "turn/completed",
                    Arc::new(move |params: Value| {
                        let notify = turn_done_completed.clone();
                        let acc = acc_completed.clone();
                        Box::pin(async move {
                            accumulate_usage(&acc, &params).await;
                            notify.notify_one();
                        })
                    }),
                )
                .await;

            let acc_tokens = usage_acc.clone();
            client
                .on_notification(
                    "thread/tokenUsage/updated",
                    Arc::new(move |params: Value| {
                        let acc = acc_tokens.clone();
                        Box::pin(async move {
                            accumulate_usage(&acc, &params).await;
                        })
                    }),
                )
                .await;

            let tx_started = bridge_tx.clone();
            client
                .on_notification(
                    "item/started",
                    Arc::new(move |params: Value| {
                        let tx = tx_started.clone();
                        Box::pin(async move {
                            if let Some((id, name, input)) = item_to_tool_start(&params) {
                                let _ = tx
                                    .send(BridgeEvent::ToolStart {
                                        tool_id: id,
                                        name,
                                        input,
                                    })
                                    .await;
                            }
                        })
                    }),
                )
                .await;

            let tx_completed = bridge_tx.clone();
            client
                .on_notification(
                    "item/completed",
                    Arc::new(move |params: Value| {
                        let tx = tx_completed.clone();
                        Box::pin(async move {
                            // Surface diff details (file_path / old_string /
                            // new_string) as a ToolUpdate BEFORE the ToolEnd
                            // so the renderer's Edit card carries the diff
                            // body inline.
                            if let Some((id, patch)) = item_to_tool_update(&params) {
                                let _ = tx
                                    .send(BridgeEvent::ToolUpdate {
                                        tool_id: id,
                                        input: patch,
                                    })
                                    .await;
                            }
                            if let Some((id, output, is_error)) = item_to_tool_end(&params) {
                                let _ = tx
                                    .send(BridgeEvent::ToolEnd {
                                        tool_id: id,
                                        output,
                                        is_error,
                                    })
                                    .await;
                            }
                        })
                    }),
                )
                .await;

            // Send the prompt as a single text input item.
            let input_items = json!([{ "type": "text", "text": msg_owned }]);
            let turn_res = client.turn_start(&thread_id, input_items, None).await;

            // Wait for turn/completed, abort, or a generous ceiling.
            tokio::select! {
                _ = turn_done.notified() => {}
                _ = tokio::time::sleep(std::time::Duration::from_secs(300)) => {
                    tracing::warn!(target: "codex", "turn/completed never fired within 300s — emitting Status:done anyway");
                }
                _ = wait_aborted(aborted.clone()) => {}
            }

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

            if let Err(e) = turn_res {
                let _ = bridge_tx
                    .send(BridgeEvent::Error {
                        error: format!("Codex turn/start failed: {e}"),
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

    pub async fn abort(&self) {
        self.aborted.store(true, Ordering::SeqCst);
        let g = self.state.lock().await;
        if let Some(state) = g.as_ref() {
            let turn_id = state.current_turn_id.lock().await.clone();
            if let Some(tid) = turn_id {
                let _ = state.client.turn_interrupt(&state.thread_id, &tid).await;
            }
        }
    }

    fn cold_start_fut(
        &self,
        base_url_override: Option<String>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<()>> + Send>> {
        let session_id = self.session_id.clone();
        let project_path = self.project_path.clone();
        let permission_mode = self.permission_mode.clone();
        let model_name = self.model_name.clone();
        let effort = self.effort.clone();
        let is_staff = self.is_staff;
        let agent_template = self.agent_template.clone();
        let state = self.state.clone();
        Box::pin(async move {
            let bridge = CodexBridge {
                session_id,
                project_path,
                permission_mode,
                model_name,
                effort,
                is_staff,
                agent_template,
                aborted: Arc::new(AtomicBool::new(false)),
                state,
            };
            bridge.cold_start(base_url_override).await
        })
    }
}

async fn wait_aborted(aborted: Arc<AtomicBool>) {
    loop {
        if aborted.load(Ordering::SeqCst) {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
}

// ── Usage accumulator ────────────────────────────────────────────
#[derive(Clone, Default, Debug)]
struct UsageAcc {
    input_tokens: u64,
    output_tokens: u64,
    cache_read_tokens: u64,
    cache_write_tokens: u64,
}
impl UsageAcc {
    fn has_any(&self) -> bool {
        self.input_tokens + self.output_tokens + self.cache_read_tokens + self.cache_write_tokens
            > 0
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

/// Fold whichever shape Codex sent (V2's `tokenUsage.last` /
/// `tokenUsage.total` or a flat `usage`/root payload) into the per-turn
/// accumulator. Faithful with Python's `_accumulate_usage`.
async fn accumulate_usage(acc: &Arc<Mutex<UsageAcc>>, params: &Value) {
    let mut guard = acc.lock().await;
    let candidates: Vec<&Value> = vec![
        params,
        params.get("usage").unwrap_or(&Value::Null),
        params
            .get("tokenUsage")
            .and_then(|t| t.get("last"))
            .unwrap_or(&Value::Null),
        params
            .get("tokenUsage")
            .and_then(|t| t.get("total"))
            .unwrap_or(&Value::Null),
    ];
    for src in candidates {
        if !src.is_object() {
            continue;
        }
        for key in ["inputTokens", "input_tokens"] {
            if let Some(v) = src.get(key).and_then(|v| v.as_u64()) {
                guard.input_tokens += v;
                break;
            }
        }
        for key in ["outputTokens", "output_tokens"] {
            if let Some(v) = src.get(key).and_then(|v| v.as_u64()) {
                guard.output_tokens += v;
                break;
            }
        }
        for key in [
            "cachedInputTokens",
            "cached_input_tokens",
            "cache_read_tokens",
        ] {
            if let Some(v) = src.get(key).and_then(|v| v.as_u64()) {
                guard.cache_read_tokens += v;
                break;
            }
        }
        for key in ["reasoningOutputTokens", "reasoning_output_tokens"] {
            if let Some(v) = src.get(key).and_then(|v| v.as_u64()) {
                guard.output_tokens += v;
                break;
            }
        }
    }
}

fn item_to_tool_start(params: &Value) -> Option<(String, String, Value)> {
    let item = params.get("item")?;
    let id = item
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if id.is_empty() {
        return None;
    }
    let kind = item
        .get("kind")
        .and_then(|v| v.as_str())
        .or_else(|| item.get("type").and_then(|v| v.as_str()))
        .or_else(|| item.get("itemType").and_then(|v| v.as_str()))
        .unwrap_or("");
    if !is_tool_kind(kind) {
        return None;
    }
    let name = kind_to_tool_name(kind).to_string();
    let input = item
        .get("input")
        .cloned()
        .or_else(|| item.get("params").cloned())
        .or_else(|| item.get("arguments").cloned())
        .unwrap_or_else(|| Value::Object(Default::default()));
    Some((id, name, input))
}

/// Split a unified-diff hunk body into `(removed, added)` line groups.
/// Faithful with `_parse_unified_diff` — strips `@@`/`---`/`+++` headers
/// and "\ No newline" lines, buckets `-`/`+` lines into the two groups,
/// drops context lines (would double-count and inflate both columns).
pub fn parse_unified_diff(patch: &str) -> (String, String) {
    if patch.is_empty() {
        return (String::new(), String::new());
    }
    let mut old_lines: Vec<&str> = Vec::new();
    let mut new_lines: Vec<&str> = Vec::new();
    for raw in patch.lines() {
        if raw.is_empty() {
            continue;
        }
        let first = raw.as_bytes()[0] as char;
        if first == '@' || first == '\\' {
            continue;
        }
        if raw.starts_with("---") || raw.starts_with("+++") {
            continue;
        }
        let body = match first {
            '-' | '+' | ' ' => &raw[1..],
            _ => raw,
        };
        match first {
            '-' => old_lines.push(body),
            '+' => new_lines.push(body),
            _ => {} // drop context
        }
    }
    (old_lines.join("\n"), new_lines.join("\n"))
}

/// Walk a V2 `changes[]` array and produce `(file_path, old, new)`.
/// Concatenates parsed diffs from each change so multi-hunk fileChanges
/// still render as one block; tolerates `oldText/newText` (and
/// snake_case) alongside `diff` for pre-release builds.
pub fn extract_diff_from_changes(changes: &Value) -> (String, String, String) {
    let Some(arr) = changes.as_array() else {
        return (String::new(), String::new(), String::new());
    };
    let mut file_path = String::new();
    let mut old_parts: Vec<String> = Vec::new();
    let mut new_parts: Vec<String> = Vec::new();
    for change in arr {
        let Some(obj) = change.as_object() else {
            continue;
        };
        if file_path.is_empty() {
            if let Some(p) = obj.get("path").and_then(|v| v.as_str()) {
                file_path = p.to_string();
            }
        }
        if let Some(diff) = obj.get("diff").and_then(|v| v.as_str()) {
            if !diff.is_empty() {
                let (o, n) = parse_unified_diff(diff);
                if !o.is_empty() {
                    old_parts.push(o);
                }
                if !n.is_empty() {
                    new_parts.push(n);
                }
            }
        }
        // V2 also sometimes surfaces oldText/newText alongside diff.
        for (old_k, new_k) in [("oldText", "newText"), ("old_text", "new_text")] {
            let has_either = obj.contains_key(old_k) || obj.contains_key(new_k);
            if has_either {
                if let Some(s) = obj.get(old_k).and_then(|v| v.as_str()) {
                    if !s.is_empty() {
                        old_parts.push(s.to_string());
                    }
                }
                if let Some(s) = obj.get(new_k).and_then(|v| v.as_str()) {
                    if !s.is_empty() {
                        new_parts.push(s.to_string());
                    }
                }
                break;
            }
        }
    }
    (file_path, old_parts.join("\n"), new_parts.join("\n"))
}

/// Build a ToolUpdate `input` patch from an item/started or
/// item/completed payload when it carries fileChange `changes[]`.
/// Returns None when there's nothing diff-shaped to surface.
fn item_to_tool_update(params: &Value) -> Option<(String, Value)> {
    let item = params.get("item")?;
    let id = item
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if id.is_empty() {
        return None;
    }
    let changes = item.get("changes")?;
    let (path, old, new) = extract_diff_from_changes(changes);
    if path.is_empty() && old.is_empty() && new.is_empty() {
        return None;
    }
    let mut patch = serde_json::Map::new();
    if !path.is_empty() {
        patch.insert("file_path".into(), Value::String(path));
    }
    if !old.is_empty() {
        patch.insert("old_string".into(), Value::String(old));
    }
    if !new.is_empty() {
        patch.insert("new_string".into(), Value::String(new));
    }
    Some((id, Value::Object(patch)))
}

fn item_to_tool_end(params: &Value) -> Option<(String, String, bool)> {
    let item = params.get("item")?;
    let id = item
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if id.is_empty() {
        return None;
    }
    let kind = item
        .get("kind")
        .and_then(|v| v.as_str())
        .or_else(|| item.get("type").and_then(|v| v.as_str()))
        .or_else(|| item.get("itemType").and_then(|v| v.as_str()))
        .unwrap_or("");
    if !is_tool_kind(kind) {
        return None;
    }
    let status = item
        .get("status")
        .and_then(|v| v.as_str())
        .unwrap_or("completed");
    let is_error = status == "failed" || status == "error";
    let output = item
        .get("output")
        .and_then(|v| v.as_str())
        .map(String::from)
        .or_else(|| {
            item.get("result")
                .and_then(|v| v.as_str())
                .map(String::from)
        })
        .or_else(|| {
            item.get("content")
                .and_then(|v| v.as_str())
                .map(String::from)
        })
        .unwrap_or_default();
    Some((id, output, is_error))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn send_message_accepts_bridge_context() {
        // Compile-only — just construct a default ctx and assert its shape.
        let ctx = crate::bridges::BridgeContext::default();
        assert!(ctx.base_url_override.is_none());
        assert!(ctx.extra_headers.is_empty());
        assert!(ctx.model_override.is_none());
    }

    #[test]
    fn permission_mapping() {
        assert_eq!(
            permission_mode_to_codex("default"),
            ("untrusted", "workspace-write")
        );
        assert_eq!(
            permission_mode_to_codex("acceptEdits"),
            ("on-request", "workspace-write")
        );
        assert_eq!(
            permission_mode_to_codex("bypassPermissions"),
            ("never", "danger-full-access")
        );
        assert_eq!(
            permission_mode_to_codex("dontAsk"),
            ("never", "danger-full-access")
        );
        assert_eq!(permission_mode_to_codex("plan"), ("never", "read-only"));
        assert_eq!(
            permission_mode_to_codex("nope"),
            ("untrusted", "workspace-write")
        );
    }

    #[test]
    fn effort_mapping_collapses_extra_high_and_max() {
        assert_eq!(effort_to_codex("low"), "low");
        assert_eq!(effort_to_codex("medium"), "medium");
        assert_eq!(effort_to_codex("high"), "high");
        assert_eq!(effort_to_codex("extra_high"), "high");
        assert_eq!(effort_to_codex("max"), "high");
        assert_eq!(effort_to_codex(""), "");
        assert_eq!(effort_to_codex("nope"), "");
    }

    #[test]
    fn kind_to_tool_name_aliases() {
        assert_eq!(kind_to_tool_name("read"), "Read");
        assert_eq!(kind_to_tool_name("fileRead"), "Read");
        assert_eq!(kind_to_tool_name("file_read"), "Read");
        assert_eq!(kind_to_tool_name("commandExecution"), "Bash");
        assert_eq!(kind_to_tool_name("execute"), "Bash");
        assert_eq!(kind_to_tool_name("webSearch"), "WebSearch");
        assert_eq!(kind_to_tool_name("reasoning"), "Thinking");
        assert_eq!(kind_to_tool_name("xyz"), "Tool");
    }

    #[tokio::test]
    async fn accumulate_usage_handles_v2_and_legacy_shapes() {
        let acc = Arc::new(Mutex::new(UsageAcc::default()));
        let v2 = json!({
            "tokenUsage": {
                "last": { "inputTokens": 100, "outputTokens": 200, "cachedInputTokens": 10 }
            }
        });
        accumulate_usage(&acc, &v2).await;
        let g = acc.lock().await.clone();
        assert_eq!(g.input_tokens, 100);
        assert_eq!(g.output_tokens, 200);
        assert_eq!(g.cache_read_tokens, 10);

        let legacy = json!({
            "usage": { "input_tokens": 5, "output_tokens": 7, "cache_read_tokens": 1 }
        });
        accumulate_usage(&acc, &legacy).await;
        let g = acc.lock().await.clone();
        assert_eq!(g.input_tokens, 105);
        assert_eq!(g.output_tokens, 207);
        assert_eq!(g.cache_read_tokens, 11);
    }

    #[test]
    fn item_to_tool_start_extracts_tool_kind_items() {
        let p = json!({
            "item": {
                "id": "item-1",
                "kind": "fileChange",
                "input": { "file_path": "/x.rs", "old_string": "a", "new_string": "b" }
            }
        });
        let (id, name, input) = item_to_tool_start(&p).unwrap();
        assert_eq!(id, "item-1");
        assert_eq!(name, "Edit");
        assert_eq!(input["file_path"], "/x.rs");

        // Text/reasoning items return None — text is streamed via the
        // delta channel.
        let p_text = json!({ "item": { "id": "x", "kind": "agentMessage" } });
        assert!(item_to_tool_start(&p_text).is_none());
    }

    #[test]
    fn unified_diff_strips_headers_and_buckets_lines() {
        let patch = "\
@@ -1,3 +1,3 @@
 context line one
-removed line a
-removed line b
+added line a
+added line b
 context line two
";
        let (old, new) = parse_unified_diff(patch);
        assert_eq!(old, "removed line a\nremoved line b");
        assert_eq!(new, "added line a\nadded line b");
    }

    #[test]
    fn unified_diff_tolerates_no_headers() {
        let patch = "-foo\n+bar\n";
        let (old, new) = parse_unified_diff(patch);
        assert_eq!(old, "foo");
        assert_eq!(new, "bar");
    }

    #[test]
    fn extract_diff_handles_oldtext_newtext_fallback() {
        let changes = json!([
            { "path": "src/x.rs", "oldText": "a", "newText": "b" }
        ]);
        let (path, old, new) = extract_diff_from_changes(&changes);
        assert_eq!(path, "src/x.rs");
        assert_eq!(old, "a");
        assert_eq!(new, "b");
    }

    #[test]
    fn extract_diff_concatenates_multiple_hunks() {
        let changes = json!([
            { "path": "x", "diff": "-a\n+b\n" },
            { "diff": "-c\n+d\n" },
        ]);
        let (path, old, new) = extract_diff_from_changes(&changes);
        assert_eq!(path, "x");
        assert_eq!(old, "a\nc");
        assert_eq!(new, "b\nd");
    }

    #[test]
    fn item_to_tool_update_extracts_patch_when_changes_present() {
        let params = json!({
            "item": {
                "id": "i-7",
                "kind": "fileChange",
                "changes": [
                    { "path": "src/x.rs", "diff": "-old\n+new\n" }
                ]
            }
        });
        let (id, patch) = item_to_tool_update(&params).unwrap();
        assert_eq!(id, "i-7");
        assert_eq!(patch["file_path"], "src/x.rs");
        assert_eq!(patch["old_string"], "old");
        assert_eq!(patch["new_string"], "new");

        // No changes → None.
        let p2 = json!({ "item": { "id": "x", "kind": "fileChange" } });
        assert!(item_to_tool_update(&p2).is_none());
    }

    #[test]
    fn item_to_tool_end_propagates_status_and_output() {
        let p = json!({
            "item": {
                "id": "i",
                "kind": "exec",
                "status": "completed",
                "output": "done"
            }
        });
        let (id, output, is_error) = item_to_tool_end(&p).unwrap();
        assert_eq!(id, "i");
        assert_eq!(output, "done");
        assert!(!is_error);

        let p_fail = json!({
            "item": { "id": "f", "kind": "exec", "status": "failed" }
        });
        let (_, _, is_error) = item_to_tool_end(&p_fail).unwrap();
        assert!(is_error);
    }
}
