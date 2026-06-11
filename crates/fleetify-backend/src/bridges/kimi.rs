//! Kimi (Moonshot) Code CLI bridge over the Agent Client Protocol (ACP).
//!
//! Kimi Code CLI ships a first-class ACP server: `kimi acp` speaks JSON-RPC
//! over stdin/stdout (the same protocol Gemini / OpenCode / Cursor / Hermes
//! use), so this is a gemini.rs-style clone — spawn `kimi acp`, run the ACP
//! handshake + `session/new`, then forward `session/update` notifications as
//! the `BridgeEvent`s the renderer already understands.
//!
//! Differences from the Gemini bridge (Kimi's CLI is intentionally lean):
//!   * **Spawn:** plain `kimi acp` — there are no documented `--model` /
//!     `--approval-mode` flags for ACP mode, so model + approval ride through
//!     ACP (`session/new` model defaults; permissions via
//!     `session/request_permission`) rather than process args.
//!   * **Auth:** Kimi authenticates out-of-band — you run `kimi` once and
//!     send `/login`. So we only call ACP `authenticate` when `initialize`
//!     actually advertises an `authMethods` entry; otherwise we go straight
//!     to `session/new`. A "not logged in" error surfaces verbatim.
//!
//! MCP servers (user registry + fleet built-ins) attach over ACP
//! `session/new` via `ensure_stdio_env(to_acp_servers(..))` — identical to
//! every other ACP bridge.

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

/// Returns `true` when `mode` means "auto-allow all tool calls" for the Kimi
/// bridge — i.e. no permission dialog should be shown. Factored out so it can
/// be unit-tested independently of the async closure.
fn kimi_is_bypass(mode: &str) -> bool {
    matches!(mode, "bypassPermissions" | "dontAsk" | "yolo")
}

/// Normalize an ACP `mcpServers` array so every **stdio** entry (one with a
/// `command`) carries an `env` field. ACP agents that mirror gemini-cli's
/// strict `zMcpServerStdio` schema reject an env-less stdio entry with
/// `-32602 Invalid params`, which would take EVERY MCP (fleet built-ins
/// included) down with it. Backfilling `env: []` keeps one env-less user
/// entry from sinking the rest. http/sse entries pass through untouched.
/// Mirrors the same helper in the gemini / opencode / cursor ACP bridges.
fn ensure_stdio_env(servers: Value) -> Value {
    let Value::Array(arr) = servers else {
        return servers;
    };
    Value::Array(
        arr.into_iter()
            .map(|mut entry| {
                if let Value::Object(ref mut m) = entry {
                    if m.contains_key("command") && !m.contains_key("env") {
                        m.insert("env".to_string(), Value::Array(Vec::new()));
                    }
                }
                entry
            })
            .collect(),
    )
}

/// Compose the ACP `session/prompt` content for one turn. ACP `session/new`
/// carries no system-prompt slot, so a present system prompt (the staff
/// orchestrator roster + `[[DISPATCH]]` protocol, or an agent template) rides
/// in as a leading text block ahead of the user's text. Additive — it layers
/// onto Kimi's built-in tool-use prompt. An absent/empty prompt yields a
/// single user-text block.
fn compose_prompt_content(system_prompt: Option<&str>, msg: &str) -> Value {
    match system_prompt {
        Some(sp) if !sp.is_empty() => json!([
            { "type": "text", "text": sp },
            { "type": "text", "text": msg },
        ]),
        _ => json!([{ "type": "text", "text": msg }]),
    }
}

/// Translate an ACP tool_call / tool_call_update update to a Claude-style
/// (name, input) pair the Process Viewer already classifies.
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

/// Extract a text representation of a tool's `content` blocks for `tool_end`.
fn extract_tool_output(content: &Value) -> String {
    let Some(arr) = content.as_array() else {
        return String::new();
    };
    let mut buf = String::new();
    for block in arr {
        let kind = block.get("type").and_then(|v| v.as_str()).unwrap_or("");
        match kind {
            "content" => {
                if let Some(text) = block
                    .get("content")
                    .and_then(|inner| inner.get("text"))
                    .and_then(|v| v.as_str())
                {
                    if !buf.is_empty() {
                        buf.push('\n');
                    }
                    buf.push_str(text);
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
    /// Process handle kept alive for the session; dropped on shutdown.
    _proc: Child,
    /// ACP session id returned by session/new.
    acp_session_id: String,
    /// Model label (best-effort — Kimi doesn't surface it in init).
    model_label: String,
}

pub struct KimiBridge {
    pub session_id: String,
    pub project_path: String,
    pub permission_mode: String,
    pub model_name: Option<String>,
    /// Staff orchestrator prompt or an agent-template prompt, set by the chat
    /// router exactly as for `GeminiBridge`. ACP has no system-prompt slot, so
    /// it rides in as a leading text block on the turn.
    pub system_prompt: Option<String>,
    pub is_staff: bool,
    pub agent_template: Option<String>,
    /// Live tool-permission callback. When set AND the ACP approval mode is
    /// `"default"`, the ACP client's `on_permission_request` routes through
    /// this handler (the renderer's permission dialog). Unset → auto-deny.
    pub permission_handler: Option<super::permission::PermissionHandler>,
    /// Per-tool allow/deny overlay from `session.tool_overrides`. Keys and
    /// values are lowercased. Empty (the default) means no overrides apply.
    pub tool_overrides: std::collections::HashMap<String, String>,
    aborted: Arc<AtomicBool>,
    state: Arc<Mutex<Option<State>>>,
}

impl KimiBridge {
    pub fn new(
        session_id: impl Into<String>,
        project_path: impl Into<String>,
        permission_mode: impl Into<String>,
        model_name: Option<String>,
        is_staff: bool,
        agent_template: Option<String>,
    ) -> Self {
        Self {
            session_id: session_id.into(),
            project_path: project_path.into(),
            permission_mode: permission_mode.into(),
            model_name,
            system_prompt: None,
            is_staff,
            agent_template,
            permission_handler: None,
            tool_overrides: std::collections::HashMap::new(),
            aborted: Arc::new(AtomicBool::new(false)),
            state: Arc::new(Mutex::new(None)),
        }
    }

    /// Builder hook for the chat router to inject the live permission
    /// callback. Same shape as `GeminiBridge::with_permission_handler`.
    pub fn with_permission_handler(
        mut self,
        handler: super::permission::PermissionHandler,
    ) -> Self {
        self.permission_handler = Some(handler);
        self
    }

    /// Lazily spawn `kimi acp`, run the ACP handshake, and create the ACP
    /// session. Idempotent — first call sets up State, later calls return.
    async fn cold_start(&self, account_env: Vec<(String, String)>) -> Result<()> {
        let mut guard = self.state.lock().await;
        if guard.is_some() {
            return Ok(());
        }
        let bin = which::which("kimi")
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| "kimi".to_string());

        let mut cmd = Command::new(&bin);
        cmd.arg("acp");

        // Strip any `\\?\` verbatim prefix before handing the cwd to kimi —
        // some ACP agents choke on it. New session rows are normalized at
        // create time, but pre-existing rows could still carry it.
        let cwd_raw = if self.project_path.is_empty() {
            std::env::var("USERPROFILE")
                .or_else(|_| std::env::var("HOME"))
                .unwrap_or_else(|_| ".".to_string())
        } else {
            self.project_path.clone()
        };
        let cwd = fleetify_core::strip_verbatim_prefix(std::path::Path::new(&cwd_raw))
            .to_string_lossy()
            .into_owned();
        cmd.current_dir(&cwd)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        // Multi-account isolation (no-op for the System account).
        crate::bridges::account_env::apply_to_command(&mut cmd, &account_env);
        // Keep Node reachable for the npm `.cmd` shim under cmd.exe's 8191-char
        // PATH truncation — see `bridges::ensure_node_on_path`.
        crate::bridges::ensure_node_on_path(&mut cmd);

        let mut proc = cmd.spawn().map_err(|e| {
            anyhow!(
                "Kimi Code CLI not found ({e}). Install it (see \
                 https://moonshotai.github.io/kimi-cli), then run `kimi` and `/login` to authenticate."
            )
        })?;

        let stdin = proc
            .stdin
            .take()
            .ok_or_else(|| anyhow!("no stdin for kimi acp"))?;
        let stdout = proc
            .stdout
            .take()
            .ok_or_else(|| anyhow!("no stdout for kimi acp"))?;

        // Drain stderr so MCP-server startup failures don't backpressure the
        // subprocess.
        if let Some(stderr) = proc.stderr.take() {
            tokio::spawn(async move {
                use tokio::io::{AsyncBufReadExt, BufReader};
                let mut r = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = r.next_line().await {
                    tracing::debug!(target: "kimi.stderr", "{line}");
                }
            });
        }

        let client = Arc::new(AcpClient::new());
        client.attach(stdout, stdin).await?;

        // Permission handler routing — same three-way split as the Gemini
        // bridge: bypass → auto-allow; handler set → ask the user; neither →
        // auto-deny stub (safe fallback).
        // Per-tool overrides (tool_overrides) are consulted FIRST and
        // short-circuit the mode/handler logic when present.
        let perm_mode = self.permission_mode.clone();
        let perm_handler = self.permission_handler.clone();
        let overrides = self.tool_overrides.clone();
        client
            .on_permission_request(Arc::new(move |params| {
                let bypass = kimi_is_bypass(perm_mode.as_str());
                let handler = perm_handler.clone();
                let overrides = overrides.clone();
                Box::pin(async move {
                    // Extract tool name before bypass/handler check so the override
                    // can short-circuit regardless of mode.
                    let tool_name = params
                        .get("toolCall")
                        .and_then(|tc| tc.get("name"))
                        .or_else(|| params.get("tool_name"))
                        .or_else(|| params.get("name"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    // Per-tool override takes priority over mode logic.
                    if let Some(forced) = super::tool_override_decision(&overrides, &tool_name) {
                        let option_id = if forced { "allow_once" } else { "deny" };
                        return Ok(json!({
                            "outcome": { "outcome": "selected", "optionId": option_id }
                        }));
                    }
                    if bypass {
                        return Ok(json!({
                            "outcome": { "outcome": "selected", "optionId": "allow_once" }
                        }));
                    }
                    if let Some(h) = handler {
                        let approved = h(tool_name, params.clone()).await;
                        let option_id = if approved { "allow_once" } else { "deny" };
                        return Ok(json!({
                            "outcome": { "outcome": "selected", "optionId": option_id }
                        }));
                    }
                    tracing::warn!(
                        target: "kimi.permission",
                        "auto-denied ACP permission request — no permission_handler wired"
                    );
                    Ok(json!({
                        "outcome": { "outcome": "selected", "optionId": "deny" }
                    }))
                })
            }))
            .await;

        // fs read / write: scope to project_path. Outside-project paths are
        // refused with -32000.
        let project = self.project_path.clone();
        let project_for_read = project.clone();
        client
            .on_fs_read(Arc::new(move |params: Value| {
                let project = project_for_read.clone();
                Box::pin(async move {
                    let path = params.get("path").and_then(|v| v.as_str()).unwrap_or("");
                    if path.is_empty() {
                        return Err(anyhow!("path is required"));
                    }
                    if !project.is_empty() && !path.starts_with(&project) {
                        return Err(anyhow!("path outside project: {path}"));
                    }
                    let body =
                        std::fs::read_to_string(path).map_err(|e| anyhow!("read {path}: {e}"))?;
                    Ok(json!({ "content": body }))
                })
            }))
            .await;

        let project_for_write = project.clone();
        client
            .on_fs_write(Arc::new(move |params: Value| {
                let project = project_for_write.clone();
                Box::pin(async move {
                    let path = params.get("path").and_then(|v| v.as_str()).unwrap_or("");
                    let content = params.get("content").and_then(|v| v.as_str()).unwrap_or("");
                    if path.is_empty() {
                        return Err(anyhow!("path is required"));
                    }
                    if !project.is_empty() && !path.starts_with(&project) {
                        return Err(anyhow!("path outside project: {path}"));
                    }
                    if let Some(parent) = std::path::Path::new(path).parent() {
                        let _ = std::fs::create_dir_all(parent);
                    }
                    std::fs::write(path, content).map_err(|e| anyhow!("write {path}: {e}"))?;
                    Ok(json!({}))
                })
            }))
            .await;

        // ACP handshake.
        let client_caps = json!({ "fs": { "readTextFile": true, "writeTextFile": true } });
        let init = tokio::time::timeout(
            std::time::Duration::from_secs(INIT_TIMEOUT_SECS),
            client.initialize(client_caps),
        )
        .await
        .map_err(|_| {
            anyhow!(
                "Kimi timed out starting up after {INIT_TIMEOUT_SECS}s. Try again, or check that `kimi acp` runs locally (and that you've run `kimi` → `/login`)."
            )
        })??;

        // Kimi authenticates out-of-band (`kimi` → `/login`). Only call ACP
        // `authenticate` when `initialize` actually advertises a method;
        // otherwise go straight to session/new. A genuine auth failure here
        // surfaces verbatim so the user knows to log in.
        if let Some(method_id) = init
            .get("authMethods")
            .and_then(|v| v.as_array())
            .and_then(|methods| methods.first())
            .and_then(|m| m.get("id"))
            .and_then(|v| v.as_str())
        {
            client.authenticate(method_id).await.map_err(|e| {
                anyhow!("Kimi authentication failed ({e}). Run `kimi` in a terminal and `/login` first.")
            })?;
        }

        // Materialize merged MCP map (user registry + fleet built-ins) for ACP
        // session/new — same wiring as the Gemini / Hermes / Cursor bridges.
        let mcp_map = crate::services::mcp_dispatch::build_merged_map(
            &self.session_id,
            self.is_staff,
            self.agent_template.as_deref(),
        );
        let mcp_servers = ensure_stdio_env(crate::services::mcp_dispatch::to_acp_servers(&mcp_map));
        tracing::info!(
            target: "kimi",
            session_id = %self.session_id,
            is_staff = self.is_staff,
            agent_template = self.agent_template.as_deref().unwrap_or(""),
            mcp_mounted = ?mcp_map.keys().collect::<Vec<_>>(),
            "kimi MCP servers built"
        );
        let acp_session_id = client.session_new(&cwd, mcp_servers).await.map_err(|e| {
            anyhow!(
                "session/new failed: {e}. If this is an auth error, run `kimi` → `/login` first."
            )
        })?;

        let model_label = self
            .model_name
            .clone()
            .unwrap_or_else(|| "kimi".to_string());

        *guard = Some(State {
            client,
            _proc: proc,
            acp_session_id,
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
        let (tx, rx) = mpsc::channel::<BridgeEvent>(32);
        let bridge_tx = tx.clone();

        // Model / base_url / header overrides don't apply at runtime for an
        // ACP subprocess (the session is already created, and `kimi acp`
        // exposes no model flag). Documented Day-1 limit — parity with Gemini.
        if ctx.model_override.is_some() {
            tracing::warn!(
                target: "kimi",
                "Kimi bridge: model_override not supported at runtime (ACP session already created). Ignoring."
            );
        }
        if !ctx.extra_headers.is_empty() {
            tracing::warn!(
                target: "kimi",
                "kimi bridge: extra_headers from active proxy are ignored on a CLI subprocess."
            );
        }

        let session_id = self.session_id.clone();
        let state_mu = self.state.clone();
        let aborted = self.aborted.clone();
        let msg_owned = msg.to_string();
        let system_prompt = self.system_prompt.clone();
        let needs_cold_start = state_mu.lock().await.is_none();
        let cold_starter = if needs_cold_start {
            Some(self.cold_start_fut(ctx.account_env.clone()))
        } else {
            None
        };

        tokio::spawn(async move {
            if let Some(fut) = cold_starter {
                if let Err(e) = fut.await {
                    let _ = bridge_tx
                        .send(BridgeEvent::Error {
                            error: format!("Kimi start-up failed: {e}"),
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
                                error: "Kimi bridge: cold start did not initialise".into(),
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
                    claude_session_id: Some(acp_sid.clone()),
                    model: model_label.clone(),
                    tools_count: 0,
                })
                .await;

            let usage_acc = Arc::new(Mutex::new(UsageAcc::default()));

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

            let content = compose_prompt_content(system_prompt.as_deref(), &msg_owned);
            let prompt_res = client.session_prompt(&acp_sid, content).await;

            if let Ok(result) = &prompt_res {
                fold_usage_from_prompt_result(result, &usage_acc).await;
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

            if let Err(e) = prompt_res {
                let _ = bridge_tx
                    .send(BridgeEvent::Error {
                        error: format!("Kimi prompt failed: {e}"),
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

    /// Cancel the in-flight prompt. Best-effort — ACP `session/cancel` is a
    /// notification, so tail events flush naturally as `Status: done`.
    pub async fn abort(&self) {
        self.aborted.store(true, Ordering::SeqCst);
        let g = self.state.lock().await;
        if let Some(state) = g.as_ref() {
            let _ = state.client.session_cancel(&state.acp_session_id).await;
        }
    }

    // Wraps cold_start in a 'static future so the spawned turn task can drive
    // it without holding the bridge ref.
    fn cold_start_fut(
        &self,
        account_env: Vec<(String, String)>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<()>> + Send>> {
        let session_id = self.session_id.clone();
        let project_path = self.project_path.clone();
        let permission_mode = self.permission_mode.clone();
        let model_name = self.model_name.clone();
        let system_prompt = self.system_prompt.clone();
        let is_staff = self.is_staff;
        let agent_template = self.agent_template.clone();
        let state = self.state.clone();
        let permission_handler = self.permission_handler.clone();
        let tool_overrides = self.tool_overrides.clone();
        Box::pin(async move {
            let bridge = KimiBridge {
                session_id,
                project_path,
                permission_mode,
                model_name,
                system_prompt,
                is_staff,
                agent_template,
                permission_handler,
                tool_overrides,
                aborted: Arc::new(AtomicBool::new(false)),
                state,
            };
            bridge.cold_start(account_env).await
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
            let text = content.get("text").and_then(|v| v.as_str()).unwrap_or("");
            let is_thought = content
                .get("annotations")
                .and_then(|a| a.get("thought"))
                .and_then(|t| t.as_bool())
                .unwrap_or(false);
            if !text.is_empty() {
                if is_thought {
                    let _ = tx
                        .send(BridgeEvent::Thinking {
                            text: text.to_string(),
                        })
                        .await;
                } else {
                    let _ = tx
                        .send(BridgeEvent::MessageDelta {
                            text: text.to_string(),
                        })
                        .await;
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
                let _ = tx
                    .send(BridgeEvent::Thinking {
                        text: text.to_string(),
                    })
                    .await;
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
                            input_patch.insert("old_string".into(), Value::String(old.to_string()));
                        }
                        if let Some(new) = block.get("newText").and_then(|v| v.as_str()) {
                            input_patch.insert("new_string".into(), Value::String(new.to_string()));
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
                let output = extract_tool_output(update.get("content").unwrap_or(&Value::Null));
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
    // Usage may ride on the response itself or under `usage`. Probe both.
    let candidates: Vec<&Value> = vec![result, result.get("usage").unwrap_or(&Value::Null)];
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
    fn kimi_is_bypass_native_yolo_auto_allows() {
        // Kimi/Gemini native "yolo" maps to the bypass tier — same as
        // bypassPermissions.
        assert!(kimi_is_bypass("yolo"));
        assert_eq!(kimi_is_bypass("yolo"), kimi_is_bypass("bypassPermissions"));
        // Canonical bypass modes still work.
        assert!(kimi_is_bypass("bypassPermissions"));
        assert!(kimi_is_bypass("dontAsk"));
        // Ask-like modes must NOT bypass.
        assert!(!kimi_is_bypass("default"));
        assert!(!kimi_is_bypass("plan"));
        assert!(!kimi_is_bypass("ask"));
    }

    #[test]
    fn ensure_stdio_env_backfills_only_envless_stdio() {
        let input = json!([
            { "name": "a", "command": "node", "args": ["x"] },
            { "name": "b", "command": "node", "args": [], "env": [{"name":"K","value":"v"}] },
            { "name": "c", "type": "http", "url": "http://x", "headers": [] },
        ]);
        let out = ensure_stdio_env(input);
        let arr = out.as_array().unwrap();
        assert_eq!(arr[0]["env"], json!([])); // injected
        assert_eq!(arr[1]["env"], json!([{"name":"K","value":"v"}])); // preserved
        assert!(arr[2].get("env").is_none()); // http untouched
        assert_eq!(ensure_stdio_env(json!({})), json!({})); // non-array passthrough
    }

    #[test]
    fn compose_prompt_content_prepends_then_passes_through() {
        let c = compose_prompt_content(Some("You ARE Fleet"), "list agents");
        let arr = c.as_array().unwrap();
        assert_eq!(arr.len(), 2);
        assert_eq!(arr[0]["text"], "You ARE Fleet");
        assert_eq!(arr[1]["text"], "list agents");
        for sp in [None, Some("")] {
            let c = compose_prompt_content(sp, "hello");
            assert_eq!(c.as_array().unwrap().len(), 1);
            assert_eq!(c.as_array().unwrap()[0]["text"], "hello");
        }
    }

    #[test]
    fn translate_acp_tool_call_maps_kinds() {
        assert_eq!(
            translate_acp_tool_call(&json!({ "kind": "read", "rawInput": { "file_path": "/x" } }))
                .0,
            "Read"
        );
        assert_eq!(
            translate_acp_tool_call(&json!({ "kind": "execute" })).0,
            "Bash"
        );
        // locations[0].path lifts into file_path when rawInput is empty.
        let (_, i) =
            translate_acp_tool_call(&json!({ "kind": "read", "locations": [{ "path": "/y" }] }));
        assert_eq!(i["file_path"], "/y");
    }

    #[test]
    fn extract_tool_output_concatenates_blocks() {
        let v = json!([
            { "type": "text", "text": "first" },
            { "type": "content", "content": { "text": "second" } },
            { "type": "diff", "path": "src/x.rs" },
        ]);
        let s = extract_tool_output(&v);
        assert!(s.contains("first") && s.contains("second") && s.contains("[diff: src/x.rs]"));
    }
}
