//! GitHub Copilot CLI bridge. Spawns `copilot --acp --stdio` and drives
//! the shared `AcpClient`. Mirrors `bridges/gemini.rs` (also ACP-based).
//!
//! Auth model: `AuthSpec::None`. The Copilot CLI manages its own OAuth
//! token in the OS keychain (service name `copilot-cli`) — Fleetify
//! never sees or stores it. Auth indicators in the catalog surface
//! "Login required" when the user hasn't run `copilot login` yet.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Result};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, Mutex};

use super::acp::AcpClient;
use super::BridgeEvent;

const INIT_TIMEOUT_SECS: u64 = 30;

/// Resolve the standalone GitHub Copilot CLI binary (`copilot`, installed via
/// `npm install -g @github/copilot`). Tries PATH first — the `which` crate
/// honours Windows PATHEXT, so it finds the `.cmd`/`.ps1` shims npm writes —
/// then the common install dirs a GUI-launched process's minimal PATH
/// frequently misses (npm global bin, Homebrew, `~/.local/bin`, and the winget
/// shim dir). Returns an absolute path, or `None` when not installed. Shared by
/// the bridge spawn and `routers::providers` scan detection so they agree
/// (mirrors `cursor::resolve_cursor_bin`).
pub fn resolve_copilot_bin() -> Option<String> {
    // 1. PATH (PATHEXT-aware on Windows via the `which` crate).
    if let Ok(p) = which::which("copilot") {
        return Some(p.to_string_lossy().into_owned());
    }
    // 2. Off-PATH install locations a GUI process's minimal PATH often lacks.
    let mut candidates: Vec<std::path::PathBuf> = Vec::new();
    #[cfg(windows)]
    {
        if let Ok(appdata) = std::env::var("APPDATA") {
            let npm = std::path::Path::new(&appdata).join("npm");
            for f in ["copilot.cmd", "copilot.ps1", "copilot.exe", "copilot"] {
                candidates.push(npm.join(f));
            }
        }
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            let winget = std::path::Path::new(&local)
                .join("Microsoft")
                .join("WinGet");
            // winget's shim dir (present only when it links the package).
            candidates.push(winget.join("Links").join("copilot.exe"));
            // `winget install GitHub.Copilot` drops the real exe under
            // WinGet\Packages\GitHub.Copilot_<hash>\copilot.exe and does NOT
            // always create a Links shim (verified on a live install), so scan
            // the package dir directly. The `<hash>` suffix varies, hence the
            // prefix match + a one-level descent (winget sometimes nests by
            // version).
            if let Ok(entries) = std::fs::read_dir(winget.join("Packages")) {
                for entry in entries.flatten() {
                    if !entry
                        .file_name()
                        .to_string_lossy()
                        .starts_with("GitHub.Copilot")
                    {
                        continue;
                    }
                    let dir = entry.path();
                    candidates.push(dir.join("copilot.exe"));
                    if let Ok(sub) = std::fs::read_dir(&dir) {
                        for s in sub.flatten() {
                            candidates.push(s.path().join("copilot.exe"));
                        }
                    }
                }
            }
        }
    }
    #[cfg(not(windows))]
    {
        for base in ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin"] {
            candidates.push(std::path::Path::new(base).join("copilot"));
        }
        if let Ok(home) = std::env::var("HOME") {
            let h = std::path::Path::new(&home);
            candidates.push(h.join(".local").join("bin").join("copilot"));
            candidates.push(h.join(".npm-global").join("bin").join("copilot"));
            candidates.push(h.join("node_modules").join(".bin").join("copilot"));
        }
    }
    candidates
        .into_iter()
        .find(|p| p.is_file())
        .map(|p| p.to_string_lossy().into_owned())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CopilotPermArgs {
    AllowAll,
    AcceptEdits,
    Ask,
}

fn map_for_copilot(mode: &str) -> CopilotPermArgs {
    match mode {
        "bypassPermissions" | "dontAsk" => CopilotPermArgs::AllowAll,
        "acceptEdits" => CopilotPermArgs::AcceptEdits,
        _ => CopilotPermArgs::Ask,
    }
}

/// Translate an ACP `session/update` notification payload into a
/// Fleetify `BridgeEvent`. Returns `None` when the update kind doesn't
/// produce a renderer-visible event (e.g., `plan` items we choose to
/// suppress; status-only updates).
///
/// ACP shape:
/// ```json
/// { "sessionId": "...", "update": { "sessionUpdate": "<kind>", ... } }
/// ```
fn translate_session_update(notif: &Value) -> Option<BridgeEvent> {
    let update = notif.get("update")?;
    let kind = update.get("sessionUpdate")?.as_str()?;

    match kind {
        "agent_message_chunk" => {
            let text = update
                .get("content")
                .and_then(|c| c.get("text"))
                .and_then(|t| t.as_str())?
                .to_string();
            Some(BridgeEvent::MessageDelta { text })
        }
        "agent_thought_chunk" => {
            let text = update
                .get("content")
                .and_then(|c| c.get("text"))
                .and_then(|t| t.as_str())?
                .to_string();
            Some(BridgeEvent::Thinking { text })
        }
        "tool_call" => {
            // `tool_call` is overloaded by ACP: it can be the initial
            // start event (no status / status=pending) OR the terminal
            // completed/failed event (status set). Disambiguate via `status`.
            let tool_id = update.get("toolCallId")?.as_str()?.to_string();
            let status = update.get("status").and_then(|s| s.as_str());
            if status == Some("completed") || status == Some("failed") {
                let is_error = status == Some("failed");
                let output = extract_tool_output(update.get("content"));
                Some(BridgeEvent::ToolEnd {
                    tool_id,
                    output,
                    is_error,
                })
            } else {
                let name = update
                    .get("title")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let input = update.get("rawInput").cloned().unwrap_or(Value::Null);
                Some(BridgeEvent::ToolStart {
                    tool_id,
                    name,
                    input,
                })
            }
        }
        "tool_call_update" => {
            let tool_id = update.get("toolCallId")?.as_str()?.to_string();
            let input = update.get("rawInput").cloned().unwrap_or(Value::Null);
            Some(BridgeEvent::ToolUpdate { tool_id, input })
        }
        _ => None,
    }
}

fn extract_tool_output(content: Option<&Value>) -> String {
    let Some(arr) = content.and_then(|c| c.as_array()) else {
        return String::new();
    };
    arr.iter()
        .filter_map(|entry| {
            entry
                .get("content")
                .and_then(|c| c.get("text"))
                .and_then(|t| t.as_str())
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// One selectable Copilot model: `(modelId, displayName)`. Includes the native
/// `auto` ("Let Copilot pick the best model").
type CopilotModel = (String, String);

/// Discover the user's available Copilot models WITHOUT starting a chat turn:
/// spawn `copilot --acp --stdio`, run the ACP handshake, open a throwaway
/// session, read its plan-specific `models.availableModels`, then shut down.
/// Used by the `/agents/{id}/models` discovery endpoint to populate the model
/// picker. Requires `copilot login`; on any error the caller falls back to the
/// static catalog list.
pub async fn list_models(project_path: &str) -> Result<Vec<CopilotModel>> {
    let bin = resolve_copilot_bin().ok_or_else(|| anyhow!("copilot CLI not found"))?;
    let cwd_raw = if project_path.is_empty() {
        std::env::var("USERPROFILE")
            .or_else(|_| std::env::var("HOME"))
            .unwrap_or_else(|_| ".".to_string())
    } else {
        project_path.to_string()
    };
    let cwd = fleetify_core::strip_verbatim_prefix(std::path::Path::new(&cwd_raw))
        .to_string_lossy()
        .into_owned();

    // npm ships a `.cmd` shim on Windows; run it via `cmd /C`. winget's `.exe`
    // and Unix binaries spawn directly.
    let mut cmd = if cfg!(windows) && bin.to_ascii_lowercase().ends_with(".cmd") {
        let mut c = Command::new("cmd");
        c.arg("/C").arg(&bin);
        c
    } else {
        Command::new(&bin)
    };
    cmd.arg("--acp")
        .arg("--stdio")
        .arg(format!("--add-dir={}", cwd))
        .arg("--log-level=warning")
        .current_dir(&cwd)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    let mut proc = cmd
        .spawn()
        .map_err(|e| anyhow!("copilot CLI not found ({e})"))?;
    let stdin = proc.stdin.take().ok_or_else(|| anyhow!("no stdin"))?;
    let stdout = proc.stdout.take().ok_or_else(|| anyhow!("no stdout"))?;
    if let Some(stderr) = proc.stderr.take() {
        tokio::spawn(async move {
            let mut r = BufReader::new(stderr).lines();
            while let Ok(Some(_)) = r.next_line().await {}
        });
    }

    let client = Arc::new(AcpClient::new());
    client.attach(stdout, stdin).await?;
    let caps = serde_json::json!({ "fs": { "readTextFile": false, "writeTextFile": false } });
    tokio::time::timeout(
        std::time::Duration::from_secs(INIT_TIMEOUT_SECS),
        client.initialize(caps),
    )
    .await
    .map_err(|_| anyhow!("copilot timed out during model discovery"))??;
    let resp = client
        .call(
            "session/new",
            serde_json::json!({ "cwd": cwd, "mcpServers": [] }),
        )
        .await?;
    let models = parse_copilot_models(&resp);
    client.shutdown().await;
    // `proc` drops here → the transient ACP server is killed.
    Ok(models)
}

/// Extract `(modelId, name)` pairs from a Copilot ACP `session/new` result.
/// Prefers the dedicated `models.availableModels` field; falls back to the
/// `configOptions` entry whose `id == "model"`. Empty when neither is present.
fn parse_copilot_models(result: &Value) -> Vec<CopilotModel> {
    if let Some(arr) = result
        .get("models")
        .and_then(|m| m.get("availableModels"))
        .and_then(|v| v.as_array())
    {
        let list: Vec<CopilotModel> = arr
            .iter()
            .filter_map(|m| {
                let id = m.get("modelId").and_then(|v| v.as_str())?;
                let name = m.get("name").and_then(|v| v.as_str()).unwrap_or(id);
                Some((id.to_string(), name.to_string()))
            })
            .collect();
        if !list.is_empty() {
            return list;
        }
    }
    if let Some(opts) = result.get("configOptions").and_then(|v| v.as_array()) {
        for opt in opts {
            if opt.get("id").and_then(|v| v.as_str()) == Some("model") {
                if let Some(arr) = opt.get("options").and_then(|v| v.as_array()) {
                    return arr
                        .iter()
                        .filter_map(|m| {
                            let id = m.get("value").and_then(|v| v.as_str())?;
                            let name = m.get("name").and_then(|v| v.as_str()).unwrap_or(id);
                            Some((id.to_string(), name.to_string()))
                        })
                        .collect();
                }
            }
        }
    }
    Vec::new()
}

/// Serialize discovered Copilot models into the `[{id,label}]` array shape the
/// renderer's `available_models_update` handler expects (mirror of Cursor's
/// `models_to_json`). `CopilotModel` is `(modelId, name)`.
fn copilot_models_to_json(models: &[CopilotModel]) -> Value {
    Value::Array(
        models
            .iter()
            .map(|(id, name)| serde_json::json!({ "id": id, "label": name }))
            .collect(),
    )
}

pub struct GitHubCopilotBridge {
    pub session_id: String,
    pub project_path: String,
    pub permission_mode: String,
    pub model_name: Option<String>,
    pub effort_level: Option<String>,
    /// Optional MCP config (Fleetify-side shape: `{"mcpServers": {name: {...}}}`).
    pub mcp_config: Option<Value>,

    pub(crate) acp_session_id: Arc<Mutex<Option<String>>>,
    aborted: Arc<AtomicBool>,
    child: Arc<Mutex<Option<Child>>>,
}

impl GitHubCopilotBridge {
    pub fn new(
        session_id: impl Into<String>,
        project_path: impl Into<String>,
        permission_mode: impl Into<String>,
        model_name: Option<String>,
        effort_level: Option<String>,
        mcp_config: Option<Value>,
    ) -> Self {
        Self {
            session_id: session_id.into(),
            project_path: project_path.into(),
            permission_mode: permission_mode.into(),
            model_name,
            effort_level,
            mcp_config,
            acp_session_id: Arc::new(Mutex::new(None)),
            aborted: Arc::new(AtomicBool::new(false)),
            child: Arc::new(Mutex::new(None)),
        }
    }

    /// Build the `copilot --acp --stdio …` Command. Pure — no I/O, no
    /// spawn. Caller adds stdio piping + cwd + env.
    pub(crate) fn build_command(&self) -> Command {
        let bin = resolve_copilot_bin().unwrap_or_else(|| "copilot".to_string());

        let mut cmd = Command::new(&bin);
        cmd.arg("--acp").arg("--stdio");

        match map_for_copilot(&self.permission_mode) {
            CopilotPermArgs::AllowAll => {
                cmd.arg("--allow-all-tools");
            }
            CopilotPermArgs::AcceptEdits => {
                cmd.arg("--allow-tool=write").arg("--allow-tool=edit");
            }
            CopilotPermArgs::Ask => {}
        }

        let cwd = if self.project_path.is_empty() {
            std::env::var("USERPROFILE")
                .or_else(|_| std::env::var("HOME"))
                .unwrap_or_else(|_| ".".to_string())
        } else {
            self.project_path.clone()
        };
        let cwd = fleetify_core::strip_verbatim_prefix(std::path::Path::new(&cwd))
            .to_string_lossy()
            .into_owned();
        cmd.arg(format!("--add-dir={}", cwd));

        if let Some(m) = &self.model_name {
            cmd.arg(format!("--model={}", m));
        }
        if let Some(e) = &self.effort_level {
            cmd.arg(format!("--effort={}", e));
        }

        cmd.arg("--no-ask-user");
        // NOTE: do NOT pass `--no-banner` — the current Copilot CLI (v1.0.56+)
        // has no such flag and exits with "unknown option '--no-banner'",
        // which closes the ACP stream ("ACP initialize failed"). The banner is
        // off by default in this version (only `--banner` enables it), so
        // there's nothing to suppress.
        cmd.arg("--log-level=warning");

        cmd
    }

    /// Translate Fleetify's MCP config (`{mcpServers: {name: {...}}}`) into
    /// the ACP `session/new.mcpServers` array shape. Returns `Value::Array`
    /// for direct passthrough into the JSON-RPC payload.
    fn translate_mcp_config(&self) -> Value {
        let Some(cfg) = self.mcp_config.as_ref() else {
            return Value::Array(Vec::new());
        };
        let Some(servers) = cfg.get("mcpServers").and_then(|m| m.as_object()) else {
            return Value::Array(Vec::new());
        };
        let arr: Vec<Value> = servers
            .iter()
            .map(|(name, server_cfg)| {
                serde_json::json!({
                    "name": name,
                    "command": server_cfg.get("command").cloned().unwrap_or(Value::Null),
                    "args": server_cfg.get("args").cloned().unwrap_or_else(|| serde_json::json!([])),
                    "env": server_cfg.get("env").cloned().unwrap_or_else(|| serde_json::json!({})),
                })
            })
            .collect();
        Value::Array(arr)
    }

    /// Clone-able view used by the spawned send task. Only Arc + small
    /// Copy/Clone fields — no deep clones.
    fn clone_handle(&self) -> GitHubCopilotBridge {
        GitHubCopilotBridge {
            session_id: self.session_id.clone(),
            project_path: self.project_path.clone(),
            permission_mode: self.permission_mode.clone(),
            model_name: self.model_name.clone(),
            effort_level: self.effort_level.clone(),
            mcp_config: self.mcp_config.clone(),
            acp_session_id: self.acp_session_id.clone(),
            aborted: self.aborted.clone(),
            child: self.child.clone(),
        }
    }

    /// Lazily spawn `copilot --acp --stdio`, run the ACP handshake, and
    /// create (or load) the ACP session. Each `send_message` invocation
    /// spawns a fresh subprocess. If a previous turn already established an
    /// ACP session id, `session/load` is used instead of `session/new` to
    /// resume conversational context.
    async fn cold_start(&self, tx: mpsc::Sender<BridgeEvent>) -> Result<(Arc<AcpClient>, String)> {
        let mut cmd = self.build_command();
        cmd.stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());

        // Set current_dir to the normalized cwd so relative paths in
        // copilot's tools resolve correctly.
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
        cmd.current_dir(&cwd);

        let mut proc = cmd.spawn().map_err(|e| {
            anyhow!(
                "GitHub Copilot CLI (`copilot`) not found ({e}). Install with \
                 `npm install -g @github/copilot`, then run `copilot login`. \
                 If it's already installed, make sure its bin dir is on PATH \
                 (npm global bin / Homebrew / ~/.local/bin)."
            )
        })?;

        let stdin = proc.stdin.take().ok_or_else(|| anyhow!("no stdin"))?;
        let stdout = proc.stdout.take().ok_or_else(|| anyhow!("no stdout"))?;

        // Drain stderr to prevent pipe back-pressure; surface lines via tracing.
        if let Some(stderr) = proc.stderr.take() {
            tokio::spawn(async move {
                let mut reader = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = reader.next_line().await {
                    tracing::warn!(target: "copilot_cli", "{line}");
                }
            });
        }

        *self.child.lock().await = Some(proc);

        // Construct AcpClient (no-arg), then attach the stdio pipes.
        // Mirrors Gemini's `AcpClient::new()` + `client.attach(stdout, stdin)`.
        let acp = Arc::new(AcpClient::new());
        acp.attach(stdout, stdin).await?;

        // Wire the session_update notification handler so that ACP
        // session/update notifications are translated into BridgeEvents
        // and forwarded to the caller's channel. This mirrors Gemini's
        // `client.on_session_update(Arc::new(move |params| { ... }))` call
        // inside send_message.
        let update_tx = tx.clone();
        let aborted_for_handler = self.aborted.clone();
        acp.on_session_update(Arc::new(move |params: Value| {
            let tx = update_tx.clone();
            let aborted = aborted_for_handler.clone();
            Box::pin(async move {
                if aborted.load(Ordering::SeqCst) {
                    return;
                }
                if let Some(ev) = translate_session_update(&params) {
                    let _ = tx.send(ev).await;
                }
            })
        }))
        .await;

        // ACP handshake: initialize.
        tokio::time::timeout(
            Duration::from_secs(INIT_TIMEOUT_SECS),
            acp.initialize(serde_json::json!({
                "fs": { "readTextFile": true, "writeTextFile": true }
            })),
        )
        .await
        .map_err(|_| anyhow!("ACP initialize timed out after {INIT_TIMEOUT_SECS}s"))?
        .map_err(|e| anyhow!("ACP initialize failed: {e}"))?;

        // Session: new on first turn, load on subsequent. The session/new
        // result carries Copilot's live model catalog (`models.availableModels`),
        // which we forward to the picker; session/load returns no model block, so
        // a resumed turn re-derives the list from the set_config_option response
        // below.
        let existing = self.acp_session_id.lock().await.clone();
        let mcp = self.translate_mcp_config();
        let mut session_models: Vec<CopilotModel> = Vec::new();
        let mut current_model = self.model_name.clone().unwrap_or_default();
        let session_id = match existing {
            None => {
                // Use the raw call (not the `session_new` helper) so we can read
                // the `models` block and surface it to the renderer's picker.
                let result = acp
                    .call(
                        "session/new",
                        serde_json::json!({ "cwd": cwd, "mcpServers": mcp }),
                    )
                    .await
                    .map_err(|e| anyhow!("session/new failed: {e}"))?;
                session_models = parse_copilot_models(&result);
                if current_model.is_empty() {
                    if let Some(c) = result
                        .get("models")
                        .and_then(|m| m.get("currentModelId"))
                        .and_then(|v| v.as_str())
                    {
                        current_model = c.to_string();
                    }
                }
                let id = result
                    .get("sessionId")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| anyhow!("session/new: missing sessionId"))?
                    .to_string();
                *self.acp_session_id.lock().await = Some(id.clone());
                id
            }
            Some(id) => {
                acp.session_load(&id, &cwd, mcp)
                    .await
                    .map_err(|e| anyhow!("session/load failed: {e}"))?;
                id
            }
        };

        // Apply the picked model to the session. `--model` at spawn only takes
        // effect on a FRESH session/new; a resumed session/load keeps its
        // previous model, so the picked model wouldn't stick (the session would
        // stay on whatever it was first created with). Set it explicitly each
        // turn via set_config_option (configId "model"). Best-effort: an invalid
        // id just leaves the current model — never fail the turn over it. The
        // response echoes the updated `configOptions[model].options`, which
        // re-populates the model list for a resumed turn (session/load gave none).
        if let Some(model) = self.model_name.as_deref().filter(|m| !m.is_empty()) {
            if let Ok(resp) = acp
                .call(
                    "session/set_config_option",
                    serde_json::json!({
                        "sessionId": session_id,
                        "configId": "model",
                        "value": model,
                    }),
                )
                .await
            {
                let updated = parse_copilot_models(&resp);
                if !updated.is_empty() {
                    session_models = updated;
                }
            }
        }

        // Emit Init event so the renderer sees a session id.
        let _ = tx
            .send(BridgeEvent::Init {
                session_id: self.session_id.clone(),
                claude_session_id: Some(session_id.clone()),
                model: self.model_name.clone().unwrap_or_default(),
                tools_count: 0,
            })
            .await;

        // Surface Copilot's live model list so the composer picker renders the
        // real per-plan models (Auto / GPT-5 mini / Claude Haiku 4.5 / …) instead
        // of the static catalog, and round-trips a model switch. Skip when empty
        // (a resumed turn with no model pick) — the renderer keeps whatever the
        // first turn already cached for the session.
        if !session_models.is_empty() {
            let _ = tx
                .send(BridgeEvent::AvailableModels {
                    models: copilot_models_to_json(&session_models),
                    current: current_model,
                })
                .await;
        }

        Ok((acp, session_id))
    }

    pub async fn send_message(
        &self,
        msg: &str,
        ctx: super::BridgeContext,
    ) -> Result<mpsc::Receiver<BridgeEvent>> {
        let _ = ctx; // model_override already applied at construction time
        let (tx, rx) = mpsc::channel::<BridgeEvent>(256);

        let bridge_self = self.clone_handle();
        let bridge_tx = tx.clone();
        let aborted = self.aborted.clone();
        let user_msg = msg.to_string();

        tokio::spawn(async move {
            if aborted.load(Ordering::SeqCst) {
                return;
            }
            let (acp, session_id) = match bridge_self.cold_start(bridge_tx.clone()).await {
                Ok(v) => v,
                Err(e) => {
                    let _ = bridge_tx
                        .send(BridgeEvent::Error {
                            error: e.to_string(),
                        })
                        .await;
                    let _ = bridge_tx
                        .send(BridgeEvent::Status {
                            status: "done".into(),
                        })
                        .await;
                    return;
                }
            };

            let _ = bridge_tx
                .send(BridgeEvent::Status {
                    status: "running".into(),
                })
                .await;

            let prompt = serde_json::json!([{ "type": "text", "text": user_msg }]);
            match acp.session_prompt(&session_id, prompt).await {
                Ok(_) => {
                    let _ = bridge_tx
                        .send(BridgeEvent::Status {
                            status: "done".into(),
                        })
                        .await;
                }
                Err(e) => {
                    let _ = bridge_tx
                        .send(BridgeEvent::Error {
                            error: e.to_string(),
                        })
                        .await;
                    let _ = bridge_tx
                        .send(BridgeEvent::Status {
                            status: "done".into(),
                        })
                        .await;
                }
            }
        });

        Ok(rx)
    }

    pub async fn abort(&self) {
        self.aborted.store(true, Ordering::SeqCst);
        if let Some(mut child) = self.child.lock().await.take() {
            let _ = child.kill().await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn map_for_copilot_bypass_permissions_returns_allow_all() {
        assert_eq!(
            map_for_copilot("bypassPermissions"),
            CopilotPermArgs::AllowAll
        );
    }
    #[test]
    fn map_for_copilot_dont_ask_returns_allow_all() {
        assert_eq!(map_for_copilot("dontAsk"), CopilotPermArgs::AllowAll);
    }
    #[test]
    fn map_for_copilot_accept_edits_returns_accept_edits() {
        assert_eq!(map_for_copilot("acceptEdits"), CopilotPermArgs::AcceptEdits);
    }
    #[test]
    fn map_for_copilot_default_returns_ask() {
        assert_eq!(map_for_copilot("default"), CopilotPermArgs::Ask);
    }
    #[test]
    fn map_for_copilot_unknown_returns_ask() {
        assert_eq!(map_for_copilot("nonsense"), CopilotPermArgs::Ask);
    }

    #[test]
    fn copilot_models_to_json_emits_id_label_array() {
        let models = vec![
            ("auto".to_string(), "Auto".to_string()),
            ("gpt-5-mini".to_string(), "GPT-5 mini".to_string()),
        ];
        assert_eq!(
            copilot_models_to_json(&models),
            serde_json::json!([
                { "id": "auto", "label": "Auto" },
                { "id": "gpt-5-mini", "label": "GPT-5 mini" }
            ])
        );
        assert_eq!(copilot_models_to_json(&[]), serde_json::json!([]));
    }

    fn dummy_bridge(mode: &str, model: Option<&str>, effort: Option<&str>) -> GitHubCopilotBridge {
        GitHubCopilotBridge::new(
            "s1",
            "/tmp/proj",
            mode,
            model.map(String::from),
            effort.map(String::from),
            None,
        )
    }

    fn cmd_args(b: &GitHubCopilotBridge) -> Vec<String> {
        let cmd = b.build_command();
        cmd.as_std()
            .get_args()
            .map(|a| a.to_string_lossy().to_string())
            .collect()
    }

    #[test]
    fn build_command_default_mode_emits_core_flags() {
        let b = dummy_bridge("default", None, None);
        let args = cmd_args(&b);
        assert!(args.iter().any(|a| a == "--acp"));
        assert!(args.iter().any(|a| a == "--stdio"));
        assert!(args.iter().any(|a| a == "--no-ask-user"));
        // `--no-banner` is NOT a valid flag in the current Copilot CLI — it
        // must not be passed (it closes the ACP stream).
        assert!(!args.iter().any(|a| a == "--no-banner"));
        assert!(args.iter().any(|a| a.starts_with("--add-dir=")));
        // Ask mode: no allow-all-tools.
        assert!(!args.iter().any(|a| a == "--allow-all-tools"));
    }

    #[test]
    fn build_command_bypass_permissions_adds_allow_all_tools() {
        let b = dummy_bridge("bypassPermissions", None, None);
        let args = cmd_args(&b);
        assert!(args.iter().any(|a| a == "--allow-all-tools"));
    }

    #[test]
    fn build_command_accept_edits_adds_write_and_edit() {
        let b = dummy_bridge("acceptEdits", None, None);
        let args = cmd_args(&b);
        assert!(args.iter().any(|a| a == "--allow-tool=write"));
        assert!(args.iter().any(|a| a == "--allow-tool=edit"));
        assert!(!args.iter().any(|a| a == "--allow-all-tools"));
    }

    #[test]
    fn build_command_model_override_appends_model_flag() {
        let b = dummy_bridge("default", Some("gpt-5.3-codex"), None);
        let args = cmd_args(&b);
        assert!(args.iter().any(|a| a == "--model=gpt-5.3-codex"));
    }

    #[test]
    fn build_command_no_model_omits_model_flag() {
        let b = dummy_bridge("default", None, None);
        let args = cmd_args(&b);
        assert!(!args.iter().any(|a| a.starts_with("--model=")));
    }

    #[test]
    fn build_command_effort_level_appends_effort_flag() {
        let b = dummy_bridge("default", None, Some("high"));
        let args = cmd_args(&b);
        assert!(args.iter().any(|a| a == "--effort=high"));
    }

    use serde_json::json;

    #[test]
    fn translate_agent_message_chunk_emits_message_delta() {
        let notif = json!({
            "sessionId": "s1",
            "update": {
                "sessionUpdate": "agent_message_chunk",
                "content": { "type": "text", "text": "Hello world" }
            }
        });
        let ev = translate_session_update(&notif).expect("should emit event");
        assert!(matches!(ev, BridgeEvent::MessageDelta { ref text } if text == "Hello world"));
    }

    #[test]
    fn translate_agent_thought_chunk_emits_thinking() {
        let notif = json!({
            "sessionId": "s1",
            "update": {
                "sessionUpdate": "agent_thought_chunk",
                "content": { "type": "text", "text": "thinking..." }
            }
        });
        let ev = translate_session_update(&notif).expect("should emit event");
        assert!(matches!(ev, BridgeEvent::Thinking { ref text } if text == "thinking..."));
    }

    #[test]
    fn translate_tool_call_emits_tool_start() {
        let notif = json!({
            "sessionId": "s1",
            "update": {
                "sessionUpdate": "tool_call",
                "toolCallId": "tc1",
                "title": "view",
                "rawInput": { "path": "README.md" }
            }
        });
        let ev = translate_session_update(&notif).expect("should emit event");
        match ev {
            BridgeEvent::ToolStart {
                tool_id,
                name,
                input,
            } => {
                assert_eq!(tool_id, "tc1");
                assert_eq!(name, "view");
                assert_eq!(input["path"], "README.md");
            }
            other => panic!("expected ToolStart, got {:?}", other),
        }
    }

    #[test]
    fn translate_tool_call_update_emits_tool_update() {
        let notif = json!({
            "sessionId": "s1",
            "update": {
                "sessionUpdate": "tool_call_update",
                "toolCallId": "tc1",
                "rawInput": { "path": "src/main.rs" }
            }
        });
        let ev = translate_session_update(&notif).expect("should emit event");
        assert!(matches!(ev, BridgeEvent::ToolUpdate { ref tool_id, .. } if tool_id == "tc1"));
    }

    #[test]
    fn translate_tool_call_finished_success_emits_tool_end_ok() {
        let notif = json!({
            "sessionId": "s1",
            "update": {
                "sessionUpdate": "tool_call",
                "toolCallId": "tc1",
                "status": "completed",
                "content": [{ "type": "content", "content": { "type": "text", "text": "file body" } }]
            }
        });
        let ev = translate_session_update(&notif).expect("should emit event");
        match ev {
            BridgeEvent::ToolEnd {
                tool_id,
                output,
                is_error,
            } => {
                assert_eq!(tool_id, "tc1");
                assert!(output.contains("file body"));
                assert!(!is_error);
            }
            _ => panic!("expected ToolEnd success"),
        }
    }

    #[test]
    fn translate_tool_call_failed_emits_tool_end_is_error() {
        let notif = json!({
            "sessionId": "s1",
            "update": {
                "sessionUpdate": "tool_call",
                "toolCallId": "tc1",
                "status": "failed",
                "content": [{ "type": "content", "content": { "type": "text", "text": "boom" } }]
            }
        });
        let ev = translate_session_update(&notif).expect("should emit event");
        assert!(matches!(ev, BridgeEvent::ToolEnd { is_error: true, .. }));
    }

    #[test]
    fn translate_unknown_kind_returns_none() {
        let notif = json!({
            "sessionId": "s1",
            "update": { "sessionUpdate": "completely_unknown_kind" }
        });
        assert!(translate_session_update(&notif).is_none());
    }

    #[test]
    fn translate_mcp_config_none_returns_empty_array() {
        let b = dummy_bridge("default", None, None);
        let result = b.translate_mcp_config();
        assert!(result.as_array().unwrap().is_empty());
    }

    #[test]
    fn translate_mcp_config_single_server_translates_command_args_env() {
        let mut b = dummy_bridge("default", None, None);
        b.mcp_config = Some(json!({
            "mcpServers": {
                "github": {
                    "command": "github-mcp",
                    "args": ["--token", "x"],
                    "env": { "GITHUB_TOKEN": "secret" }
                }
            }
        }));
        let result = b.translate_mcp_config();
        let arr = result.as_array().unwrap();
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["name"], "github");
        assert_eq!(arr[0]["command"], "github-mcp");
        assert_eq!(arr[0]["args"][0], "--token");
        assert_eq!(arr[0]["env"]["GITHUB_TOKEN"], "secret");
    }

    #[test]
    fn translate_mcp_config_missing_optional_fields_uses_defaults() {
        let mut b = dummy_bridge("default", None, None);
        b.mcp_config = Some(json!({
            "mcpServers": {
                "barebones": { "command": "barebones-mcp" }
            }
        }));
        let result = b.translate_mcp_config();
        let arr = result.as_array().unwrap();
        assert_eq!(arr[0]["args"], json!([]));
        assert_eq!(arr[0]["env"], json!({}));
    }

    #[tokio::test]
    async fn send_message_returns_err_when_copilot_binary_missing() {
        // Skip when copilot is installed on this host (manual E2E covers
        // the happy path separately).
        if which::which("copilot").is_ok() {
            eprintln!("skipping: copilot binary present on this host");
            return;
        }
        let b = dummy_bridge("default", None, None);
        let ctx = super::super::BridgeContext::default();
        // send_message returns Ok(Receiver) eagerly even when the spawn will
        // fail; the failure surfaces as a BridgeEvent::Error on the channel.
        let mut rx = b
            .send_message("hello", ctx)
            .await
            .expect("rx should be returned eagerly");
        let mut saw_error = false;
        while let Some(ev) = rx.recv().await {
            if let BridgeEvent::Error { error } = &ev {
                assert!(
                    error.to_lowercase().contains("copilot")
                        || error.to_lowercase().contains("not found"),
                    "expected friendly copilot error, got: {error}"
                );
                saw_error = true;
            }
        }
        assert!(
            saw_error,
            "expected an Error BridgeEvent when copilot is missing"
        );
    }

    // Live probe (manual): exercises the real `list_models` against an
    // installed + logged-in Copilot CLI. Run with:
    //   cargo test -p fleetify-backend --lib list_models_live_probe -- --ignored --nocapture
    #[tokio::test]
    #[ignore = "live: needs `copilot login`"]
    async fn list_models_live_probe() {
        let home = std::env::var("USERPROFILE")
            .or_else(|_| std::env::var("HOME"))
            .unwrap_or_else(|_| ".".to_string());
        let result = super::list_models(&home).await;
        eprintln!("=== list_models result: {result:?} ===");
    }

    // Live root-cause regression for the picker showing the *static* catalog:
    // before the AvailableModels-emit fix, cold_start surfaced no live model
    // list to the composer picker. Drives a real turn and asserts the bridge
    // emits an AvailableModels event carrying Copilot's per-plan models.
    //   cargo test -p fleetify-backend --lib cold_start_emits_available_models_live -- --ignored --nocapture
    #[tokio::test]
    #[ignore = "live: needs `copilot login`"]
    async fn cold_start_emits_available_models_live() {
        let home = std::env::var("USERPROFILE")
            .or_else(|_| std::env::var("HOME"))
            .unwrap_or_else(|_| ".".to_string());
        let bridge = GitHubCopilotBridge::new("probe-session", home, "default", None, None, None);
        let ctx = super::super::BridgeContext::default();
        let mut rx = bridge
            .send_message("hi", ctx)
            .await
            .expect("rx should be returned");
        let mut available: Option<Value> = None;
        while let Some(ev) = rx.recv().await {
            match &ev {
                BridgeEvent::AvailableModels { models, current } => {
                    eprintln!("=== AvailableModels: current={current:?} models={models} ===");
                    available = Some(models.clone());
                    bridge.abort().await;
                    break;
                }
                BridgeEvent::Status { status } if status == "done" => break,
                _ => {}
            }
        }
        let models = available.expect("cold_start must emit an AvailableModels event");
        let arr = models.as_array().expect("models must be a JSON array");
        assert!(!arr.is_empty(), "model list must be non-empty");
        assert!(
            arr.iter()
                .all(|m| m.get("id").and_then(|v| v.as_str()).is_some()
                    && m.get("label").and_then(|v| v.as_str()).is_some()),
            "every model must carry string id + label"
        );
    }
}
