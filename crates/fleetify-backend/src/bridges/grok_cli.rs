//! Grok Build CLI bridge over the Agent Client Protocol (ACP).
//!
//! Drives `grok agent stdio` (xAI's Grok Build CLI, a JSON-RPC 2.0 / nd-JSON
//! ACP server over stdio). Forked from the Cursor bridge — Grok's ACP surface
//! is near-identical (`protocolVersion: 1`, `loadSession: true`, the same
//! `session/update` dialect), verified against a live `grok agent stdio`
//! handshake (grok `v0.2.56`). Three deltas from the Cursor template:
//!
//!   * **Auth = `XAI_API_KEY` env injection, no `authenticate`.** Grok's ACP
//!     `authenticate` is non-functional; `session/new` errors `-32000
//!     "Authentication required"` unless `XAI_API_KEY` is set on the spawned
//!     process. We inject the hot-reloaded provider key (see [`cold_start`]).
//!   * **MCP: http/sse only.** Grok rejects stdio MCP entries; [`grok_acceptable_mcp`]
//!     drops any server carrying a `command` (stdio) and passes the rest. We do
//!     NOT backfill stdio `env` (grok rejects that with `-32602 Invalid params`).
//!   * **Models** come back in the `models:{currentModelId,availableModels}`
//!     shape (parsed by [`parse_session_models`]). `availableModels` is empty
//!     pre-auth — the catalog's `default_models: GROK_MODELS` covers that case.
//!
//! Binary resolution ([`resolve_grok_bin`]) prefers `~/.local/bin/grok` (grok's
//! installer target, which may be off a GUI PATH), falling back to PATH.
//! Runtime model selection + session resume mirror the Cursor bridge.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use anyhow::{anyhow, Result};
use serde_json::{json, Value};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, Mutex};

use super::acp::AcpClient;
use super::{BridgeContext, BridgeEvent};

/// Seconds to wait for the ACP `initialize` response before declaring the
/// subprocess hung (parity with the other ACP bridges).
const INIT_TIMEOUT_SECS: u64 = 30;

/// grok's ACP accepts only http/sse MCP servers (no stdio). Drop any entry that
/// carries a `command` (stdio); keep http/sse. Non-array / empty → empty (pass []).
fn grok_acceptable_mcp(servers: &serde_json::Value) -> Vec<serde_json::Value> {
    servers
        .as_array()
        .map(|a| {
            a.iter()
                .filter(|s| s.get("command").is_none())
                .cloned()
                .collect()
        })
        .unwrap_or_default()
}

/// Grok's ACP returns a bare `-32603 Internal error` (no `data.details`) for a
/// few server-side conditions — most often the selected model not being enabled
/// on the account/plan, but also a rejected request or a transient backend
/// fault. When the formatted error carries no actionable detail, append a short,
/// non-asserting hint so the chat isn't a dead end. If Grok DID send a detail
/// (surfaced as `… — <detail>` by `format_acp_error`), leave it untouched.
fn enrich_grok_prompt_error(formatted: &str) -> String {
    let opaque = formatted.contains("-32603") && !formatted.contains(" — ");
    if opaque {
        format!(
            "{formatted}. Grok returned no detail — the selected model may not be \
             enabled on your xAI plan, or the request was rejected server-side. \
             Try a different Grok model, or check your account at https://console.x.ai."
        )
    } else {
        formatted.to_string()
    }
}

/// Resolve the Grok Build CLI binary path across operating systems. xAI's
/// installer targets differ: the native installer writes `~/.grok/bin/grok`
/// (`grok.exe` on Windows), while the `curl … | bash` path writes
/// `~/.local/bin/grok`. A GUI-launched app's inherited PATH often lacks both
/// dirs, so we probe the known install locations first, then fall back to PATH
/// (`which grok`), then the bare name `"grok"` (handled by the caller's spawn).
/// Returns an absolute path when found, else `None` (caller surfaces a hint).
pub fn resolve_grok_bin() -> Option<String> {
    if let Ok(home) = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")) {
        let home = std::path::Path::new(&home);
        let exe = if cfg!(windows) { "grok.exe" } else { "grok" };
        // `.grok/bin` (current native installer, incl. Windows) before the
        // legacy `.local/bin` (curl|bash) target.
        for dir in [
            home.join(".grok").join("bin"),
            home.join(".local").join("bin"),
        ] {
            let p = dir.join(exe);
            if p.exists() {
                return Some(p.to_string_lossy().into_owned());
            }
        }
    }
    if let Ok(p) = which::which("grok") {
        return Some(p.to_string_lossy().into_owned());
    }
    None
}

/// True when a `cold_start` failure is grok's "not signed in" case — i.e. the
/// renderer should run `grok login` and resume, rather than show a hard error.
/// grok returns JSON-RPC `-32000 "Authentication required — no auth method id
/// provided"` on `session/new` when neither `XAI_API_KEY` nor an on-disk OAuth
/// login is present (see the module header). We key off the message text, not
/// the bare `-32000` code, because Fleetify reuses `-32000` for its own inbound
/// ACP handler errors — only the auth message should trigger the login flow.
fn is_auth_required_error(err: &anyhow::Error) -> bool {
    err.to_string()
        .to_ascii_lowercase()
        .contains("authentication required")
}

/// Discover Grok's model catalog WITHOUT starting a chat turn: spawn
/// `grok agent stdio`, run the ACP handshake (with the `XAI_API_KEY` env
/// injected so `session/new` doesn't 401), open a throwaway session, read its
/// `availableModels`, and shut down. Used by the `/agents/{id}/models`
/// discovery endpoint to populate the picker before any chat session has
/// cold-started. `availableModels` is empty until the key is present + valid;
/// the caller then falls back to the static catalog entries (`GROK_MODELS`).
pub async fn list_models(project_path: &str) -> Result<Vec<ModelInfo>> {
    let bin = resolve_grok_bin().ok_or_else(|| anyhow!("grok not found"))?;
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

    let mut cmd = Command::new(&bin);
    cmd.arg("agent")
        .arg("stdio")
        .current_dir(&cwd)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    // Auth: grok needs XAI_API_KEY on the process env; its ACP `authenticate`
    // is non-functional and `session/new` 401s without the key.
    if let Some(key) = crate::providers::keys::get_key("grok") {
        cmd.env("XAI_API_KEY", key);
    }

    let mut proc = cmd.spawn().map_err(|e| anyhow!("grok not found ({e})"))?;
    let stdin = proc.stdin.take().ok_or_else(|| anyhow!("no stdin"))?;
    let stdout = proc.stdout.take().ok_or_else(|| anyhow!("no stdout"))?;
    if let Some(stderr) = proc.stderr.take() {
        tokio::spawn(async move {
            use tokio::io::{AsyncBufReadExt, BufReader};
            let mut r = BufReader::new(stderr).lines();
            while let Ok(Some(_)) = r.next_line().await {}
        });
    }

    let client = Arc::new(AcpClient::new());
    client.attach(stdout, stdin).await?;
    let caps = json!({ "fs": { "readTextFile": true, "writeTextFile": true } });
    tokio::time::timeout(
        std::time::Duration::from_secs(INIT_TIMEOUT_SECS),
        client.initialize(caps),
    )
    .await
    .map_err(|_| anyhow!("grok timed out during model discovery"))??;
    let resp = client
        .call("session/new", json!({ "cwd": cwd, "mcpServers": [] }))
        .await?;
    let (_current, models) = parse_session_models(&resp);
    client.shutdown().await;
    // `proc` drops here → the transient ACP server is killed.
    Ok(models)
}

/// One selectable model surfaced by Grok's session config.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelInfo {
    pub id: String,
    pub name: String,
}

/// Serialize a model list to the `[{id, label}]` array the renderer's model
/// picker consumes (mirrors the catalog `ModelSpec` shape's id/label).
pub fn models_to_json(models: &[ModelInfo]) -> Value {
    Value::Array(
        models
            .iter()
            .map(|m| json!({ "id": m.id, "label": m.name }))
            .collect(),
    )
}

/// Map Fleet's `permission_mode` onto a Grok ACP session *mode*
/// (`session/set_config_option` configId `"mode"`). Only Fleet's `plan` needs a
/// non-default mode, so everything else returns `None` (no set → stays on the
/// agent's default mode).
fn permission_mode_to_session_mode(mode: &str) -> Option<&'static str> {
    match mode {
        "plan" => Some("plan"),
        _ => None,
    }
}

/// Returns `true` when `mode` means "auto-allow all tool calls" for the Grok
/// bridge — i.e. no permission dialog should be shown. Factored out so it can
/// be unit-tested independently of the async closure.
fn grok_is_bypass(mode: &str) -> bool {
    matches!(
        mode,
        "bypassPermissions" | "dontAsk" | "dangerouslySkipPermissions" | "agent"
    )
}

/// Decide whether to issue a `session/set_config_option` for the model.
/// Returns `Some(model)` only when a model was requested, differs from the
/// session's current model, and is actually offered by Grok.
fn select_model_to_apply(
    requested: Option<&str>,
    current: &str,
    available: &[ModelInfo],
) -> Option<String> {
    match requested {
        // Apply when a model is requested, differs from current, and is
        // either offered OR the list is unknown yet (the `session/load`
        // resume path returns no model list — apply best-effort).
        Some(m)
            if m != current && (available.is_empty() || available.iter().any(|x| x.id == m)) =>
        {
            Some(m.to_string())
        }
        _ => None,
    }
}

/// Extract `(currentModelId, availableModels)` from a `session/new` (or
/// `session/set_config_option`) result. Prefers the dedicated `models` field,
/// falling back to the `configOptions` entry whose `category`/`id` is
/// `"model"`. Copied from the OpenCode bridge (grok uses the same shape; the
/// source fn is private there).
fn parse_session_models(result: &Value) -> (String, Vec<ModelInfo>) {
    // Preferred: the dedicated `models` field.
    if let Some(models) = result.get("models") {
        let cur = models
            .get("currentModelId")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let list: Vec<ModelInfo> = models
            .get("availableModels")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|m| {
                        let id = m.get("modelId").and_then(|v| v.as_str())?;
                        let name = m.get("name").and_then(|v| v.as_str()).unwrap_or(id);
                        Some(ModelInfo {
                            id: id.to_string(),
                            name: name.to_string(),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        if !cur.is_empty() || !list.is_empty() {
            return (cur, list);
        }
    }
    // Fallback: the `configOptions` entry categorised as `model`.
    if let Some(opts) = result.get("configOptions").and_then(|v| v.as_array()) {
        for opt in opts {
            let is_model = opt.get("id").and_then(|v| v.as_str()) == Some("model")
                || opt.get("category").and_then(|v| v.as_str()) == Some("model");
            if is_model {
                let cur = opt
                    .get("currentValue")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let list: Vec<ModelInfo> = opt
                    .get("options")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|m| {
                                let id = m.get("value").and_then(|v| v.as_str())?;
                                let name = m.get("name").and_then(|v| v.as_str()).unwrap_or(id);
                                Some(ModelInfo {
                                    id: id.to_string(),
                                    name: name.to_string(),
                                })
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                return (cur, list);
            }
        }
    }
    (String::new(), Vec::new())
}

/// Per-turn `(input_tokens, output_tokens)` from a `session/prompt` response.
/// Reports `usage: {inputTokens, outputTokens, thoughtTokens, ...}`; thinking
/// tokens are billed as output, so they fold into the output count.
fn tokens_from_prompt_result(result: &Value) -> (u64, u64) {
    let u = result.get("usage").unwrap_or(result);
    let input = u.get("inputTokens").and_then(|v| v.as_u64()).unwrap_or(0);
    let output = u.get("outputTokens").and_then(|v| v.as_u64()).unwrap_or(0);
    let thought = u.get("thoughtTokens").and_then(|v| v.as_u64()).unwrap_or(0);
    (input, output + thought)
}

/// Cumulative cost in USD from a `usage_update` event (`update.cost.amount`).
/// `None` when absent.
fn cost_from_usage_update(update: &Value) -> Option<f64> {
    update
        .get("cost")
        .and_then(|c| c.get("amount"))
        .and_then(|v| v.as_f64())
}

/// Translate an ACP `tool_call` / `tool_call_update` into a Claude-style
/// `(name, input)` pair the renderer's Process Viewer already classifies.
/// Protocol-level (kind→name) — same mapping the Gemini bridge uses.
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

/// Pick the `optionId` to return for a `session/request_permission`, by
/// matching the option `kind` rather than assuming a literal id. The ACP
/// permission request carries `options: [{optionId, name, kind}]` where kind
/// is `allow_once|allow_always|reject_once|reject_always`. For `approve` we
/// prefer `allow_once` (fall back to any `allow_*`); for deny we prefer
/// `reject_once` (fall back to any `reject_*`). `None` if no option matches.
fn pick_permission_option(options: &Value, approve: bool) -> Option<String> {
    let arr = options.as_array()?;
    let (exact, prefix) = if approve {
        ("allow_once", "allow")
    } else {
        ("reject_once", "reject")
    };
    let chosen = arr
        .iter()
        .find(|o| o.get("kind").and_then(|v| v.as_str()) == Some(exact))
        .or_else(|| {
            arr.iter().find(|o| {
                o.get("kind")
                    .and_then(|v| v.as_str())
                    .is_some_and(|k| k.starts_with(prefix))
            })
        })?;
    chosen
        .get("optionId")
        .and_then(|v| v.as_str())
        .map(String::from)
}

/// Flatten an ACP tool `content` block array into display text for `ToolEnd`.
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
    /// Process handle so `abort()`/drop can SIGKILL the subprocess.
    _proc: Child,
    /// ACP session id returned by `session/new`.
    acp_session_id: String,
    /// Currently-applied model id (after any `set_config_option`).
    current_model_id: String,
    /// Models Grok offered for this session — surfaced to the renderer
    /// for the live model picker.
    available_models: Vec<ModelInfo>,
}

pub struct GrokCliBridge {
    pub session_id: String,
    pub project_path: String,
    pub permission_mode: String,
    pub model_name: Option<String>,
    /// Reasoning-effort lever, applied via the `effort` config option when
    /// the active model exposes one (best-effort — ignored otherwise).
    pub effort: Option<String>,
    /// Same gating as the other CLI bridges — staff sessions skip the live
    /// permission dialog (they only call read-only tools).
    pub is_staff: bool,
    pub agent_template: Option<String>,
    /// Prior Grok ACP session id to resume via `session/load` instead of
    /// `session/new`. The chat router sets this from the persisted
    /// `session.claude_session_id` (which our `Init` event populated on the
    /// previous turn), mirroring the Claude bridge's resume wiring.
    pub resume_session_id: Option<String>,
    /// Live tool-permission callback wired by the chat router. When set and
    /// the mode is not a bypass mode, Grok's `session/request_permission`
    /// routes through here to the renderer's dialog.
    pub permission_handler: Option<super::permission::PermissionHandler>,
    /// Per-tool allow/deny overlay from `session.tool_overrides`. Keys and
    /// values are lowercased. Empty (the default) means no overrides apply.
    pub tool_overrides: std::collections::HashMap<String, String>,
    aborted: Arc<AtomicBool>,
    state: Arc<Mutex<Option<State>>>,
}

impl GrokCliBridge {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        session_id: impl Into<String>,
        project_path: impl Into<String>,
        permission_mode: impl Into<String>,
        model_name: Option<String>,
        effort: Option<String>,
        is_staff: bool,
        agent_template: Option<String>,
    ) -> Self {
        Self {
            session_id: session_id.into(),
            project_path: project_path.into(),
            permission_mode: permission_mode.into(),
            model_name,
            effort,
            is_staff,
            agent_template,
            resume_session_id: None,
            permission_handler: None,
            tool_overrides: std::collections::HashMap::new(),
            aborted: Arc::new(AtomicBool::new(false)),
            state: Arc::new(Mutex::new(None)),
        }
    }

    pub fn with_permission_handler(
        mut self,
        handler: super::permission::PermissionHandler,
    ) -> Self {
        self.permission_handler = Some(handler);
        self
    }

    /// Models Grok offered for the current session (empty until the
    /// session is cold-started). Used by the renderer's live model picker.
    pub async fn available_models(&self) -> Vec<ModelInfo> {
        self.state
            .lock()
            .await
            .as_ref()
            .map(|s| s.available_models.clone())
            .unwrap_or_default()
    }

    /// Switch the live session's model via `session/set_config_option`.
    /// Returns the refreshed model list. Errors if not started.
    pub async fn set_model(&self, model_id: &str) -> Result<Vec<ModelInfo>> {
        let models = self.set_config("model", model_id).await?;
        // Guarantee current reflects the pick even if the agent's response
        // omitted the model id.
        let mut guard = self.state.lock().await;
        if let Some(st) = guard.as_mut() {
            if st.current_model_id != model_id {
                st.current_model_id = model_id.to_string();
            }
        }
        Ok(models)
    }

    /// Set an arbitrary Grok session config option (`model`, `effort`,
    /// `mode`, …) on the live session via `session/set_config_option`,
    /// returning the refreshed model list (changing the model can change the
    /// available list). Errors if the session isn't started.
    pub async fn set_config(&self, config_id: &str, value: &str) -> Result<Vec<ModelInfo>> {
        let mut guard = self.state.lock().await;
        let st = guard
            .as_mut()
            .ok_or_else(|| anyhow!("Grok session not started"))?;
        let resp = st
            .client
            .call(
                "session/set_config_option",
                json!({ "sessionId": st.acp_session_id, "configId": config_id, "value": value }),
            )
            .await?;
        let (cur, list) = parse_session_models(&resp);
        if !cur.is_empty() {
            st.current_model_id = cur;
        }
        if !list.is_empty() {
            st.available_models = list;
        }
        Ok(st.available_models.clone())
    }

    /// Lazily spawn `grok agent stdio`, run the ACP handshake (no
    /// `authenticate` — auth is via the injected `XAI_API_KEY` env), create the
    /// session, and apply model / mode. Idempotent.
    async fn cold_start(
        &self,
        account_env: Vec<(String, String)>,
        mount_credentials: bool,
    ) -> Result<()> {
        let mut guard = self.state.lock().await;
        if guard.is_some() {
            return Ok(());
        }
        let bin = resolve_grok_bin().unwrap_or_else(|| "grok".to_string());

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

        // Where this turn runs. `Unsupported` fails cold_start with the
        // reason rather than falling through to a host spawn.
        let target = crate::services::exec_target::parse(&self.project_path);
        if let crate::services::exec_target::ExecTarget::Unsupported(reason) = &target {
            anyhow::bail!("{reason}");
        }
        let in_container = matches!(
            target,
            crate::services::exec_target::ExecTarget::Container { .. }
        );

        // Everything that must hold before a container turn is worth
        // spawning: the CLI is actually installed inside (cached — the
        // picker's answer goes stale the moment the container is stopped or
        // replaced, but re-asking uncached cost a docker round trip on every
        // message), and a credential can reach it. Refusing here names the
        // fix; the alternative is the CLI's own opaque failure mid-stream.
        let preflight =
            crate::services::container::spawn::preflight(&target, "grok-build", mount_credentials)
                .await?;

        // Env is collected before the argv exists: in a container it becomes
        // `-e` flags ahead of the container id, and setting it on the Command
        // afterwards would attach it to the docker client instead of to grok.
        let mut envs: Vec<(String, String)> = Vec::new();
        // Multi-account isolation (no-op for the System account). Host-only —
        // HOME/XDG overrides name host paths.
        if !in_container {
            envs.extend(account_env.iter().cloned());
        }
        // Auth: grok's ACP `authenticate` is non-functional — `session/new`
        // errors `-32000 "Authentication required"` unless XAI_API_KEY is set
        // on the process. Inject the hot-reloaded provider key here. Pushed
        // AFTER account_env so a labeled-account override wins if it ever
        // sets one. This one DOES cross into the container: it is the only
        // credential grok can use there, and the key is the whole point.
        if let Some(key) = crate::providers::keys::get_key("grok") {
            envs.push(("XAI_API_KEY".to_string(), key));
        }
        // Credentials that crossed the boundary (Tier A). Empty on the host.
        envs.extend(preflight.envs.iter().cloned());

        let mut args = vec!["agent".to_string(), "stdio".to_string()];
        args.extend(preflight.args.iter().cloned());

        let mut cmd = crate::services::container::spawn::command(
            &crate::services::container::spawn::SpawnRequest {
                target: &target,
                provider_id: "grok-build",
                host_program: &bin,
                args: &args,
                envs: &envs,
                cwd: &cwd,
                pipe_stdin: true,
            },
        )?;

        let mut proc = cmd.spawn().map_err(|e| {
            anyhow!(
                "Grok CLI not found ({e}). Install: curl -fsSL https://x.ai/cli/install.sh | bash"
            )
        })?;

        let stdin = proc
            .stdin
            .take()
            .ok_or_else(|| anyhow!("no stdin for grok agent stdio"))?;
        let stdout = proc
            .stdout
            .take()
            .ok_or_else(|| anyhow!("no stdout for grok agent stdio"))?;
        if let Some(stderr) = proc.stderr.take() {
            tokio::spawn(async move {
                use tokio::io::{AsyncBufReadExt, BufReader};
                let mut r = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = r.next_line().await {
                    tracing::debug!(target: "grok.stderr", "{line}");
                }
            });
        }

        let client = Arc::new(AcpClient::new());
        client.attach(stdout, stdin).await?;

        // Permission routing — bypass auto-allows, a wired handler asks the
        // renderer, neither auto-denies. The returned `optionId` is matched
        // by `kind` against the request's own options (see pick_*).
        // Per-tool overrides (tool_overrides) are consulted FIRST and
        // short-circuit the mode/handler logic when present.
        let perm_mode = self.permission_mode.clone();
        let perm_handler = self.permission_handler.clone();
        let overrides = self.tool_overrides.clone();
        client
            .on_permission_request(Arc::new(move |params: Value| {
                let bypass = grok_is_bypass(perm_mode.as_str());
                let handler = perm_handler.clone();
                let overrides = overrides.clone();
                Box::pin(async move {
                    let options = params.get("options").cloned().unwrap_or(Value::Null);
                    // Extract tool name before bypass/handler check so the override
                    // can short-circuit regardless of mode.
                    let tool_name = params
                        .get("toolCall")
                        .and_then(|tc| {
                            tc.get("title")
                                .or_else(|| tc.get("kind"))
                                .or_else(|| tc.get("name"))
                        })
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    // Per-tool override takes priority over mode logic.
                    let approve = if let Some(forced) =
                        super::tool_override_decision(&overrides, &tool_name)
                    {
                        forced
                    } else if bypass {
                        true
                    } else if let Some(h) = handler {
                        h(tool_name, params.clone()).await
                    } else {
                        tracing::warn!(
                            target: "grok.permission",
                            "auto-denied permission — no permission_handler wired"
                        );
                        false
                    };
                    let option_id =
                        pick_permission_option(&options, approve).unwrap_or_else(|| {
                            if approve {
                                "allow_once".into()
                            } else {
                                "reject_once".into()
                            }
                        });
                    Ok(json!({ "outcome": { "outcome": "selected", "optionId": option_id } }))
                })
            }))
            .await;

        // fs read/write scoped to the project dir.
        let project = self.project_path.clone();
        let project_read = project.clone();
        client
            .on_fs_read(Arc::new(move |params: Value| {
                let project = project_read.clone();
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
        let project_write = project.clone();
        client
            .on_fs_write(Arc::new(move |params: Value| {
                let project = project_write.clone();
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

        // Handshake. Grok needs NO `authenticate` — the injected XAI_API_KEY on
        // the process env authenticates `session/new` (verified against grok
        // v0.2.56; protocolVersion 1 matches `AcpClient::initialize`).
        let client_caps = json!({ "fs": { "readTextFile": true, "writeTextFile": true } });
        tokio::time::timeout(
            std::time::Duration::from_secs(INIT_TIMEOUT_SECS),
            client.initialize(client_caps),
        )
        .await
        .map_err(|_| {
            anyhow!("Grok timed out after {INIT_TIMEOUT_SECS}s. Check that `grok agent stdio` runs locally.")
        })??;

        // Mount the merged MCP map (user registry + fleet built-ins) over ACP.
        // Grok accepts ONLY http/sse MCP servers — `grok_acceptable_mcp` drops
        // every stdio entry (one with a `command`). We do NOT backfill stdio
        // `env` (grok rejects that with `-32602 Invalid params`).
        let mcp_map = crate::services::mcp_dispatch::build_merged_map(
            &self.session_id,
            self.is_staff,
            self.agent_template.as_deref(),
        );
        let mcp_servers = Value::Array(grok_acceptable_mcp(
            &crate::services::mcp_dispatch::to_acp_servers(&mcp_map),
        ));
        // In a container the fleet sidecars are unavailable: mcp_registry
        // resolves them to an absolute HOST path next to the running exe,
        // which does not exist inside, and mcp_dispatch's
        // FLEETIFY_BACKEND_URL points at 127.0.0.1 — the container itself.
        // Advertising servers that cannot start is how the model ends up
        // calling a tool that never answers.
        let mcp_servers = if in_container {
            tracing::info!(
                target: "fleetify::container",
                session_id = %self.session_id,
                "fleet MCP servers dropped for this container turn (host sidecar paths are unreachable inside)"
            );
            Value::Array(Vec::new())
        } else {
            mcp_servers
        };

        // Resume a prior Grok session via `session/load` when we have its id,
        // falling back to `session/new` if the load fails (e.g. the session was
        // pruned). `session/load` replays history as `session/update`
        // notifications, which we intentionally drop here: cold start runs
        // before the per-turn update handler is wired and the Fleet DB already
        // holds the transcript.
        // The cwd grok is TOLD about, which is not the one docker got. `-w`
        // already put the process inside; session/new and session/load name
        // the directory a second time over the protocol, and the host path
        // does not exist on grok's side of the boundary.
        let cwd = crate::services::container::spawn::agent_workdir(&target, &cwd);

        let resume = self.resume_session_id.clone().filter(|s| !s.is_empty());
        let new_session = |servers: Value| {
            let client = client.clone();
            let cwd = cwd.clone();
            async move {
                let resp = client
                    .call("session/new", json!({ "cwd": cwd, "mcpServers": servers }))
                    .await
                    .map_err(|e| anyhow!("session/new failed: {e}"))?;
                let sid = resp
                    .get("sessionId")
                    .and_then(|v| v.as_str())
                    .map(String::from)
                    .ok_or_else(|| anyhow!("session/new: missing sessionId"))?;
                Ok::<(String, Value), anyhow::Error>((sid, resp))
            }
        };
        let (acp_session_id, setup_res) = match resume {
            Some(rid) => {
                match client
                    .call(
                        "session/load",
                        json!({ "sessionId": rid, "cwd": cwd, "mcpServers": mcp_servers.clone() }),
                    )
                    .await
                {
                    Ok(resp) => (rid, resp),
                    Err(e) => {
                        tracing::warn!(target: "grok", "session/load failed ({e}); starting fresh");
                        new_session(mcp_servers).await?
                    }
                }
            }
            None => new_session(mcp_servers).await?,
        };
        let (mut current_model_id, mut available_models) = parse_session_models(&setup_res);

        // Apply the requested model if it differs and is offered.
        if let Some(model) = select_model_to_apply(
            self.model_name.as_deref(),
            &current_model_id,
            &available_models,
        ) {
            match client
                .call(
                    "session/set_config_option",
                    json!({ "sessionId": acp_session_id, "configId": "model", "value": model }),
                )
                .await
            {
                Ok(resp) => {
                    let (cur, list) = parse_session_models(&resp);
                    if !cur.is_empty() {
                        current_model_id = cur;
                    }
                    if !list.is_empty() {
                        available_models = list;
                    }
                }
                Err(e) => tracing::warn!(target: "grok", "set model failed: {e}"),
            }
        }

        // Apply session mode (plan) and effort — both best-effort.
        if let Some(mode) = permission_mode_to_session_mode(&self.permission_mode) {
            let _ = client
                .call(
                    "session/set_config_option",
                    json!({ "sessionId": acp_session_id, "configId": "mode", "value": mode }),
                )
                .await;
        }
        if let Some(effort) = &self.effort {
            let _ = client
                .call(
                    "session/set_config_option",
                    json!({ "sessionId": acp_session_id, "configId": "effort", "value": effort }),
                )
                .await;
        }

        *guard = Some(State {
            client,
            _proc: proc,
            acp_session_id,
            current_model_id,
            available_models,
        });
        Ok(())
    }

    pub async fn send_message(
        &self,
        msg: &str,
        ctx: BridgeContext,
    ) -> Result<mpsc::Receiver<BridgeEvent>> {
        self.aborted.store(false, Ordering::SeqCst);
        let (tx, rx) = mpsc::channel::<BridgeEvent>(32);
        let bridge_tx = tx.clone();

        if ctx.model_override.is_some() {
            tracing::debug!(
                target: "grok",
                "model_override applied at session level via set_config_option, not per-message"
            );
        }

        let session_id = self.session_id.clone();
        let state_mu = self.state.clone();
        let aborted = self.aborted.clone();
        let msg_owned = msg.to_string();
        let needs_cold_start = state_mu.lock().await.is_none();
        let cold_starter = if needs_cold_start {
            Some(self.cold_start_fut(ctx.account_env.clone(), ctx.container_mount_credentials))
        } else {
            None
        };

        tokio::spawn(async move {
            if let Some(fut) = cold_starter {
                if let Err(e) = fut.await {
                    // Not signed in → ask the renderer to run `grok login` and
                    // resume, instead of surfacing a dead-end error. Any other
                    // failure stays a hard error.
                    let ev = if is_auth_required_error(&e) {
                        BridgeEvent::LoginRequired {
                            provider: "grok-build".into(),
                        }
                    } else {
                        BridgeEvent::Error {
                            error: format!("Grok start-up failed: {e}"),
                        }
                    };
                    let _ = bridge_tx.send(ev).await;
                    let _ = bridge_tx
                        .send(BridgeEvent::Status {
                            status: "done".into(),
                        })
                        .await;
                    return;
                }
            }

            let (client, acp_sid, model_label, models_json) = {
                let g = state_mu.lock().await;
                match g.as_ref() {
                    Some(s) => (
                        s.client.clone(),
                        s.acp_session_id.clone(),
                        s.current_model_id.clone(),
                        models_to_json(&s.available_models),
                    ),
                    None => {
                        let _ = bridge_tx
                            .send(BridgeEvent::Error {
                                error: "Grok bridge: cold start did not initialise".into(),
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
                    model: if model_label.is_empty() {
                        "grok".into()
                    } else {
                        model_label.clone()
                    },
                    tools_count: 0,
                })
                .await;

            // Surface Grok's live model list so the composer can render a
            // picker + round-trip a `model_switch`. Skip when empty.
            if models_json.as_array().is_some_and(|a| !a.is_empty()) {
                let _ = bridge_tx
                    .send(BridgeEvent::AvailableModels {
                        models: models_json,
                        current: model_label.clone(),
                    })
                    .await;
            }

            let cost_acc = Arc::new(Mutex::new(None::<f64>));
            let event_tx = bridge_tx.clone();
            let acc_clone = cost_acc.clone();
            let aborted_h = aborted.clone();
            client
                .on_session_update(Arc::new(move |params: Value| {
                    let event_tx = event_tx.clone();
                    let acc = acc_clone.clone();
                    let aborted = aborted_h.clone();
                    Box::pin(async move {
                        translate_session_update(params, &event_tx, &acc, &aborted).await;
                    })
                }))
                .await;

            let content = json!([{ "type": "text", "text": msg_owned }]);
            let prompt_res = client.session_prompt(&acp_sid, content).await;

            if let Ok(result) = &prompt_res {
                let (input, output) = tokens_from_prompt_result(result);
                let cost_usd = cost_acc.lock().await.unwrap_or(0.0);
                if input + output > 0 || cost_usd > 0.0 {
                    let _ = bridge_tx
                        .send(BridgeEvent::Cost {
                            usage: json!({
                                "input_tokens": input,
                                "output_tokens": output,
                                "cache_read_tokens": 0,
                                "cache_write_tokens": 0,
                            }),
                            cost_usd,
                            model: model_label.clone(),
                        })
                        .await;
                }
            }

            if let Err(e) = prompt_res {
                let formatted = format!("Grok prompt failed: {e}");
                // Log at ERROR with session context — the raw JSON-RPC error was
                // already logged by the ACP layer (`target: "acp"`); this gives
                // the grok-attributed, human-readable line in the backend log.
                tracing::error!(target: "grok", session = %session_id, "{formatted}");
                let _ = bridge_tx
                    .send(BridgeEvent::Error {
                        error: enrich_grok_prompt_error(&formatted),
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
            let _ = state.client.session_cancel(&state.acp_session_id).await;
        }
    }

    fn cold_start_fut(
        &self,
        account_env: Vec<(String, String)>,
        mount_credentials: bool,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<()>> + Send>> {
        let bridge = GrokCliBridge {
            session_id: self.session_id.clone(),
            project_path: self.project_path.clone(),
            permission_mode: self.permission_mode.clone(),
            model_name: self.model_name.clone(),
            effort: self.effort.clone(),
            is_staff: self.is_staff,
            agent_template: self.agent_template.clone(),
            resume_session_id: self.resume_session_id.clone(),
            permission_handler: self.permission_handler.clone(),
            tool_overrides: self.tool_overrides.clone(),
            aborted: Arc::new(AtomicBool::new(false)),
            state: self.state.clone(),
        };
        Box::pin(async move { bridge.cold_start(account_env, mount_credentials).await })
    }
}

// ── session/update → BridgeEvent translation ─────────────────────
async fn translate_session_update(
    params: Value,
    tx: &mpsc::Sender<BridgeEvent>,
    cost_acc: &Arc<Mutex<Option<f64>>>,
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
                let event = if is_thought {
                    BridgeEvent::Thinking { text: text.into() }
                } else {
                    BridgeEvent::MessageDelta { text: text.into() }
                };
                let _ = tx.send(event).await;
            }
        }
        "agent_thought_chunk" => {
            let text = update
                .get("content")
                .and_then(|c| c.get("text"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if !text.is_empty() {
                let _ = tx.send(BridgeEvent::Thinking { text: text.into() }).await;
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
                    if block.get("type").and_then(|v| v.as_str()) == Some("diff") {
                        if let Some(old) = block.get("oldText").and_then(|v| v.as_str()) {
                            input_patch.insert("old_string".into(), Value::String(old.into()));
                        }
                        if let Some(new) = block.get("newText").and_then(|v| v.as_str()) {
                            input_patch.insert("new_string".into(), Value::String(new.into()));
                        }
                        if !input_patch.contains_key("file_path") {
                            if let Some(p) = block.get("path").and_then(|v| v.as_str()) {
                                input_patch.insert("file_path".into(), Value::String(p.into()));
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
        "usage_update" => {
            if let Some(c) = cost_from_usage_update(&update) {
                *cost_acc.lock().await = Some(c);
            }
        }
        "available_commands_update" => {
            let commands = update
                .get("availableCommands")
                .cloned()
                .unwrap_or(Value::Array(Vec::new()));
            let _ = tx.send(BridgeEvent::SlashCommands { commands }).await;
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn auth_required_detected_from_session_new_error() {
        // The exact chain cold_start produces: format_acp_error → session/new
        // failed → (would be) "Grok start-up failed". Match is case-insensitive.
        let e = anyhow!(
            "session/new failed: ACP error -32000: Authentication required — no auth method id provided"
        );
        assert!(is_auth_required_error(&e));
    }

    #[test]
    fn non_auth_errors_are_not_login_required() {
        // A different -32000 (Fleetify's own handler error) and a plain failure
        // must NOT trigger the login flow.
        assert!(!is_auth_required_error(&anyhow!(
            "session/new failed: ACP error -32000: Invalid params"
        )));
        assert!(!is_auth_required_error(&anyhow!(
            "Grok CLI not found. Install: …"
        )));
    }

    #[test]
    fn enrich_adds_hint_only_for_opaque_internal_error() {
        // Opaque -32603 (no detail) gets the actionable, non-asserting hint.
        let opaque =
            enrich_grok_prompt_error("Grok prompt failed: ACP error -32603: Internal error");
        assert!(
            opaque.contains("xAI plan"),
            "opaque error gets a hint: {opaque}"
        );
        assert!(opaque.contains("console.x.ai"));
        // A -32603 that already carries a surfaced detail is left untouched.
        let with_detail = enrich_grok_prompt_error(
            "Grok prompt failed: ACP error -32603: Internal error — model not enabled",
        );
        assert_eq!(
            with_detail,
            "Grok prompt failed: ACP error -32603: Internal error — model not enabled"
        );
        // Other codes are left untouched.
        let other = enrich_grok_prompt_error(
            "Grok prompt failed: ACP error -32000: Authentication required",
        );
        assert_eq!(
            other,
            "Grok prompt failed: ACP error -32000: Authentication required"
        );
    }

    #[test]
    fn mcp_filter_drops_stdio_keeps_http_sse() {
        let servers = json!([
            { "name": "mem", "command": "fleet-memory-mcp" },
            { "name": "remote", "type": "http", "url": "https://x/mcp" },
            { "name": "stream", "type": "sse", "url": "https://x/sse" }
        ]);
        let out = grok_acceptable_mcp(&servers);
        let names: Vec<&str> = out
            .iter()
            .filter_map(|s| s.get("name").and_then(|n| n.as_str()))
            .collect();
        assert_eq!(names, vec!["remote", "stream"]);
    }

    #[test]
    fn mcp_filter_non_array_returns_empty() {
        assert!(grok_acceptable_mcp(&json!({})).is_empty());
        assert!(grok_acceptable_mcp(&json!([])).is_empty());
        // All-stdio input → empty (every entry has a `command`).
        let all_stdio = json!([{ "name": "a", "command": "x" }, { "name": "b", "command": "y" }]);
        assert!(grok_acceptable_mcp(&all_stdio).is_empty());
    }

    #[test]
    fn plan_maps_to_plan_mode_others_none() {
        assert_eq!(permission_mode_to_session_mode("plan"), Some("plan"));
        assert_eq!(permission_mode_to_session_mode("default"), None);
        assert_eq!(permission_mode_to_session_mode("acceptEdits"), None);
        assert_eq!(permission_mode_to_session_mode("bypassPermissions"), None);
        assert_eq!(permission_mode_to_session_mode("dontAsk"), None);
    }

    #[test]
    fn grok_is_bypass_agent_mode_auto_allows() {
        assert!(grok_is_bypass("agent"));
        assert_eq!(grok_is_bypass("agent"), grok_is_bypass("bypassPermissions"));
        assert!(grok_is_bypass("bypassPermissions"));
        assert!(grok_is_bypass("dontAsk"));
        assert!(grok_is_bypass("dangerouslySkipPermissions"));
        assert!(!grok_is_bypass("default"));
        assert!(!grok_is_bypass("plan"));
        assert!(!grok_is_bypass("ask"));
        assert!(!grok_is_bypass("acceptEdits"));
    }

    fn models() -> Vec<ModelInfo> {
        vec![
            ModelInfo {
                id: "grok-code-fast-1".into(),
                name: "Grok Code Fast".into(),
            },
            ModelInfo {
                id: "grok-4".into(),
                name: "Grok 4".into(),
            },
        ]
    }

    #[test]
    fn select_model_only_when_requested_differs_and_available() {
        let av = models();
        assert_eq!(
            select_model_to_apply(Some("grok-4"), "grok-code-fast-1", &av),
            Some("grok-4".into())
        );
        assert_eq!(
            select_model_to_apply(Some("grok-code-fast-1"), "grok-code-fast-1", &av),
            None
        );
        assert_eq!(
            select_model_to_apply(Some("not-offered"), "grok-code-fast-1", &av),
            None
        );
        assert_eq!(select_model_to_apply(None, "grok-code-fast-1", &av), None);
        // list unknown (resume via session/load) + differs → apply best-effort.
        assert_eq!(
            select_model_to_apply(Some("grok-4"), "", &[]),
            Some("grok-4".into())
        );
    }

    #[test]
    fn parse_models_from_models_field() {
        let r = json!({
            "sessionId": "ses_x",
            "models": {
                "currentModelId": "grok-code-fast-1",
                "availableModels": [
                    {"modelId": "grok-code-fast-1", "name": "Grok Code Fast"},
                    {"modelId": "grok-4", "name": "Grok 4"}
                ]
            }
        });
        let (cur, list) = parse_session_models(&r);
        assert_eq!(cur, "grok-code-fast-1");
        assert_eq!(list, models());
    }

    #[test]
    fn parse_models_empty_pre_auth_is_empty() {
        // grok returns an empty availableModels list before the key is valid.
        let r = json!({ "sessionId": "ses_x", "models": { "currentModelId": "", "availableModels": [] } });
        let (cur, list) = parse_session_models(&r);
        assert_eq!(cur, "");
        assert!(list.is_empty());
    }

    #[test]
    fn tokens_fold_thought_into_output() {
        let r = json!({
            "stopReason": "end_turn",
            "usage": { "totalTokens": 12713, "inputTokens": 12695, "outputTokens": 3, "thoughtTokens": 15 }
        });
        let (i, o) = tokens_from_prompt_result(&r);
        assert_eq!(i, 12695);
        assert_eq!(o, 18); // 3 output + 15 thinking
    }

    #[test]
    fn cost_extracted_from_usage_update() {
        let u = json!({ "sessionUpdate": "usage_update", "used": 12695, "size": 200000,
                        "cost": { "amount": 0.0123, "currency": "USD" } });
        assert_eq!(cost_from_usage_update(&u), Some(0.0123));
        let none = json!({ "sessionUpdate": "usage_update", "used": 1 });
        assert_eq!(cost_from_usage_update(&none), None);
    }

    #[test]
    fn tool_call_kinds_map_to_names() {
        let (n, i) =
            translate_acp_tool_call(&json!({"kind": "read", "rawInput": {"file_path": "/x"}}));
        assert_eq!(n, "Read");
        assert_eq!(i["file_path"], "/x");
        assert_eq!(translate_acp_tool_call(&json!({"kind": "edit"})).0, "Edit");
        assert_eq!(
            translate_acp_tool_call(&json!({"kind": "execute"})).0,
            "Bash"
        );
        assert_eq!(
            translate_acp_tool_call(&json!({"kind": "weird-new-kind"})).0,
            "Tool"
        );
        let (_, i) =
            translate_acp_tool_call(&json!({"kind": "read", "locations": [{"path": "/y"}]}));
        assert_eq!(i["file_path"], "/y");
    }

    #[test]
    fn picks_permission_option_by_kind() {
        let opts = json!([
            {"optionId": "always", "name": "Allow always", "kind": "allow_always"},
            {"optionId": "once", "name": "Allow once", "kind": "allow_once"},
            {"optionId": "no", "name": "Reject", "kind": "reject_once"}
        ]);
        assert_eq!(pick_permission_option(&opts, true), Some("once".into()));
        assert_eq!(pick_permission_option(&opts, false), Some("no".into()));
        assert_eq!(pick_permission_option(&json!([]), true), None);
        assert_eq!(pick_permission_option(&Value::Null, false), None);
    }

    #[test]
    fn models_to_json_emits_id_label_array() {
        let v = models_to_json(&models());
        assert_eq!(
            v,
            json!([
                {"id": "grok-code-fast-1", "label": "Grok Code Fast"},
                {"id": "grok-4", "label": "Grok 4"}
            ])
        );
        assert_eq!(models_to_json(&[]), json!([]));
    }

    #[test]
    fn tool_output_concatenates_blocks() {
        let v = json!([
            {"type": "text", "text": "first"},
            {"type": "content", "content": {"text": "second"}},
            {"type": "diff", "path": "src/x.rs"}
        ]);
        let s = extract_tool_output(&v);
        assert!(s.contains("first"));
        assert!(s.contains("second"));
        assert!(s.contains("[diff: src/x.rs]"));
    }
}
