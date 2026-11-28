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
use tokio::process::Child;
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
        // Native Codex approval-policy passthrough (approval axis only;
        // sandbox axis deferred to Phase 3).
        "untrusted" => ("untrusted", "workspace-write"),
        "on-request" => ("on-request", "workspace-write"),
        "never" => ("never", "danger-full-access"),
        _ => ("untrusted", "workspace-write"),
    }
}

/// Effort picker → Codex model_reasoning_effort. `""` ⇒ don't pass the
/// `-c` override (use ~/.codex/config.toml's default).
fn effort_to_codex(effort: &str) -> &'static str {
    match effort {
        "low" => "low",
        "medium" => "medium",
        "high" | "extra_high" | "max" | "ultra_code" => "high",
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

/// Pull a human-readable message out of a codex `error` notification or the
/// `turn.error` carried on a failed `turn/completed`. Both nest the API error
/// under `error.message`, which is itself usually a JSON-encoded error blob —
/// so unwrap the innermost `error.message` / `message` when present, else
/// return the raw string. `None` when there's no error (e.g. a successful turn,
/// where `turn.error` is absent or null). Without surfacing this, a failed turn
/// (e.g. an unsupported model) produced a silent empty reply.
fn extract_codex_error(obj: &Value) -> Option<String> {
    let raw = obj.get("error")?.get("message").and_then(|v| v.as_str())?;
    if let Ok(inner) = serde_json::from_str::<Value>(raw) {
        if let Some(m) = inner
            .get("error")
            .and_then(|e| e.get("message"))
            .and_then(|v| v.as_str())
        {
            return Some(m.to_string());
        }
        if let Some(m) = inner.get("message").and_then(|v| v.as_str()) {
            return Some(m.to_string());
        }
    }
    Some(raw.to_string())
}

/// The event for a Codex error notification or failed turn: a sign-in card
/// when Codex says the login is missing or rejected
/// (`codexErrorInfo: "unauthorized"`), else the error message.
fn codex_failure_event(obj: &Value) -> Option<BridgeEvent> {
    let msg = extract_codex_error(obj)?;
    let unauthorized = obj
        .get("error")
        .and_then(|e| e.get("codexErrorInfo"))
        .and_then(|v| v.as_str())
        == Some("unauthorized");
    Some(if unauthorized {
        BridgeEvent::LoginRequired {
            provider: "codex-cli".into(),
            detail: Some(msg),
        }
    } else {
        BridgeEvent::sign_in_or_error("codex-cli", &msg, msg.clone())
    })
}

/// Does `account/read` say Codex has no login? `{"account": null,
/// "requiresOpenaiAuth": true}` when signed out (verified on codex 0.137).
/// A build without `account/read` (or any other shape) is not a "no".
fn codex_signed_out(account_read: &Value) -> bool {
    account_read.get("account").is_some_and(Value::is_null)
        && account_read
            .get("requiresOpenaiAuth")
            .and_then(Value::as_bool)
            .unwrap_or(true)
}

/// The cold-start error for a signed-out Codex, in Codex's own words
/// (`codex login status`); `sign_in_or_error` turns it into the sign-in card.
const CODEX_NOT_LOGGED_IN: &str = "Not logged in";

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
    /// Independent sandbox tier override for Codex. When `Some`, overrides
    /// the sandbox value derived from `permission_mode` via
    /// `permission_mode_to_codex`. Validated against the three known values
    /// ("read-only", "workspace-write", "danger-full-access"); unknown values
    /// fall back to the derived sandbox silently.
    pub sandbox: Option<String>,
    /// Same gating semantics as ClaudeBridge::is_staff — `fleet_dispatch`
    /// is suppressed on staff sessions so they use the text-protocol
    /// dispatch path instead.
    pub is_staff: bool,
    /// Builtin template id (e.g. `"reverse_engineering"`) — opts the
    /// session into extra stdio MCPs like `fleet_reveng`.
    pub agent_template: Option<String>,
    /// Staff dispatch protocol (from `services::staff_prompt::build`, incl. any
    /// global FLEET.md rules) or a template's system prompt. Codex has no
    /// system-prompt flag, so when set we prepend it to the turn's input item
    /// (see `compose_input_text`). None → message unchanged.
    pub system_prompt: Option<String>,
    /// Optional bridge-out callback for live tool-permission prompts.
    /// When set AND the permission mode requires user approval, the
    /// codex client's `on_approval_request` routes through this handler
    /// (which the chat router's WS layer wires to the renderer's
    /// permission dialog). Unset → auto-deny stub (back-compat for
    /// places that haven't migrated yet).
    pub permission_handler: Option<super::permission::PermissionHandler>,
    aborted: Arc<AtomicBool>,
    /// Advertise codex's method-wired slash commands only once per bridge
    /// (codex's app-server, unlike the ACP agents, never pushes one itself).
    slash_advertised: Arc<AtomicBool>,
    state: Arc<Mutex<Option<State>>>,
}

/// Codex's TUI `/review` has no prompt-text equivalent over the app-server, but
/// it maps to the `review/start` method. Recognise a bare `/review` and return
/// its `ReviewTarget` — the uncommitted working tree, the TUI's default,
/// `{ "type": "uncommittedChanges" }` (verified against a live app-server). Any
/// other message returns None so normal prompts pass through to `turn/start`.
fn codex_review_target(msg: &str) -> Option<Value> {
    if msg.trim() == "/review" {
        Some(json!({ "type": "uncommittedChanges" }))
    } else {
        None
    }
}

/// Prepend a system prompt (staff dispatch protocol, or a template's system
/// prompt) to the user message. Codex's app-server has no system-prompt slot —
/// the input-item text is the only channel — so when set we lead with it,
/// mirroring the agy/antigravity bridge. Empty/None leaves the message as-is.
fn compose_input_text(system_prompt: Option<&str>, message: &str) -> String {
    match system_prompt {
        Some(sp) if !sp.is_empty() => format!("{sp}\n\n---\n\n{message}"),
        _ => message.to_string(),
    }
}

/// The sandbox tier codex is actually given.
///
/// On the host the user's (or the permission mode's) choice stands. Inside a
/// container it cannot: codex builds its sandbox from Landlock+seccomp on
/// Linux and Seatbelt on macOS, and an ordinary container exposes neither, so
/// `read-only` and `workspace-write` both fail to start rather than degrade.
/// The container is the enclosing boundary instead.
fn effective_sandbox(requested: &str, in_container: bool) -> &str {
    if in_container {
        crate::services::container::providers::CODEX_CONTAINER_SANDBOX
    } else {
        requested
    }
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
            sandbox: None,
            is_staff,
            agent_template,
            system_prompt: None,
            permission_handler: None,
            aborted: Arc::new(AtomicBool::new(false)),
            slash_advertised: Arc::new(AtomicBool::new(false)),
            state: Arc::new(Mutex::new(None)),
        }
    }

    /// Builder-style hook so the chat router can inject the live
    /// permission callback after construction without bloating `new`'s
    /// arg list. Returning `Self` lets the caller chain it inline:
    /// `CodexBridge::new(...).with_permission_handler(handler)`.
    pub fn with_permission_handler(
        mut self,
        handler: super::permission::PermissionHandler,
    ) -> Self {
        self.permission_handler = Some(handler);
        self
    }

    async fn cold_start(
        &self,
        base_url_override: Option<String>,
        account_env: Vec<(String, String)>,
        mount_credentials: bool,
    ) -> Result<()> {
        let mut guard = self.state.lock().await;
        if guard.is_some() {
            return Ok(());
        }

        let (approval, derived_sandbox) = permission_mode_to_codex(&self.permission_mode);
        // Apply the user-selected sandbox override when it's one of the three
        // known Codex sandbox values. Unknown strings fall back to the derived
        // value so we never pass garbage to the codex CLI.
        const KNOWN_SANDBOXES: &[&str] = &["read-only", "workspace-write", "danger-full-access"];
        let sandbox: &str = match self.sandbox.as_deref() {
            Some(s) if KNOWN_SANDBOXES.contains(&s) => s,
            Some(unknown) => {
                tracing::warn!(
                    target: "codex",
                    session_id = %self.session_id,
                    unknown_sandbox = unknown,
                    "codex: unknown sandbox value — falling back to derived sandbox '{derived_sandbox}'"
                );
                derived_sandbox
            }
            None => derived_sandbox,
        };
        // Where this turn actually runs. `Unsupported` fails cold_start with
        // the reason rather than falling through to a host spawn — an
        // `ssh://` path is also a valid POSIX path, so falling through is how
        // a session silently runs in the wrong place.
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
            crate::services::container::spawn::preflight(&target, "codex-cli", mount_credentials)
                .await?;

        let bin = which::which("codex")
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| "codex".to_string());

        // Args and env are both collected up front. In container mode they
        // have to be known before the argv exists: env becomes `-e` flags
        // ahead of the container id, and setting it on the Command afterwards
        // would attach it to the docker client instead of to the process
        // inside. That failure is silent — the agent just runs without its
        // key — which makes it the worst one available here.
        let mut args: Vec<String> = vec![
            "app-server".to_string(),
            "--listen".to_string(),
            "stdio://".to_string(),
        ];
        let mut envs: Vec<(String, String)> = Vec::new();
        if let Some(ref url) = base_url_override {
            envs.push(("OPENAI_BASE_URL".to_string(), url.clone()));
        }
        let codex_effort = effort_to_codex(&self.effort);
        if !codex_effort.is_empty() {
            args.push("-c".to_string());
            args.push(format!("model_reasoning_effort={codex_effort}"));
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
        args.extend(mcp_args.iter().cloned());
        args.extend(preflight.args.iter().cloned());
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
        // Multi-account isolation (no-op for the System account). Skipped in
        // a container: HOME/XDG overrides are host paths and the container
        // has its own home, so forwarding them points codex at nothing.
        if !in_container {
            envs.extend(account_env.iter().cloned());
        }
        // Credentials that crossed the boundary (Tier A). Empty on the host.
        envs.extend(preflight.envs.iter().cloned());

        let mut cmd = crate::services::container::spawn::command(
            &crate::services::container::spawn::SpawnRequest {
                target: &target,
                provider_id: "codex-cli",
                host_program: &bin,
                args: &args,
                envs: &envs,
                cwd: &cwd,
                // The app-server conversation is long-lived JSON-RPC over
                // stdin; `docker exec -i` carries it only because this is on.
                pipe_stdin: true,
            },
        )?;

        let mut proc = cmd.spawn().map_err(|e| {
            anyhow!(
                "Codex CLI not found ({e}). Install: `npm install -g @openai/codex` or see https://developers.openai.com/codex/cli"
            )
        })?;
        tracing::info!(target: "codex", session_id = %self.session_id, pid = ?proc.id(), "codex: subprocess spawned");

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

        // Approval handler routing:
        //   bypassPermissions / dontAsk → auto-allow (user opted out
        //     of prompts entirely).
        //   permission_handler set      → ship `(method, params)` to
        //     the renderer via the WS permission dialog and await the
        //     decision. Same flow the Python reference's `can_use_tool`
        //     callback drives.
        //   neither                     → fall back to auto-deny so
        //     unwired call sites still fail safely.
        let perm_mode = self.permission_mode.clone();
        let perm_handler = self.permission_handler.clone();
        client
            .on_approval_request(Arc::new(move |method: String, params| {
                let bypass = matches!(
                    perm_mode.as_str(),
                    "bypassPermissions" | "dontAsk" | "never"
                );
                let handler = perm_handler.clone();
                Box::pin(async move {
                    if bypass {
                        // Approval shape varies per method; the safest
                        // shared shape is `{ decision: "approved" }`.
                        return Ok(serde_json::json!({ "decision": "approved" }));
                    }
                    if let Some(h) = handler {
                        let approved = h(method.clone(), params.clone()).await;
                        let decision = if approved { "approved" } else { "denied" };
                        return Ok(serde_json::json!({ "decision": decision }));
                    }
                    tracing::warn!(
                        target: "codex.approval",
                        "auto-denied approval for {method} — no permission_handler wired"
                    );
                    Ok(serde_json::json!({ "decision": "denied" }))
                })
            }))
            .await;

        // V2 handshake: initialize → initialized notification → thread/start.
        tracing::info!(target: "codex", session_id = %self.session_id, "codex: initialize START");
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
        tracing::info!(target: "codex", session_id = %self.session_id, "codex: initialize OK");
        client.send_initialized().await?;
        // Ask before starting a turn: a signed-out Codex otherwise fails
        // mid-turn with a raw 401.
        if let Ok(Ok(account)) = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            client.call("account/read", json!({ "refreshToken": false })),
        )
        .await
        {
            if codex_signed_out(&account) {
                return Err(anyhow!(CODEX_NOT_LOGGED_IN));
            }
        }
        tracing::info!(target: "codex", session_id = %self.session_id, "codex: initialized notification sent, thread/start START");

        // What codex is TOLD about itself, which is not what we told docker.
        //
        // * cwd — the container's own `/work…`, not the host path. `-w`
        //   already put the process there; handing thread/start the host path
        //   points codex at a directory that does not exist on its side, and
        //   the failure surfaces as a confusing missing-project error well
        //   after the spawn looked fine.
        // * sandbox — codex sandboxes itself with Landlock+seccomp (Linux) or
        //   Seatbelt (macOS), and a container exposes neither, so any other
        //   tier refuses to start. The container is the boundary instead.
        //   This rides the protocol, not argv: a `--sandbox` flag on
        //   `app-server` is silently ignored.
        let agent_cwd = crate::services::container::spawn::agent_workdir(&target, &cwd);
        let effective_sandbox = effective_sandbox(sandbox, in_container);
        if in_container && effective_sandbox != sandbox {
            tracing::info!(
                target: "codex",
                session_id = %self.session_id,
                requested = sandbox,
                effective = effective_sandbox,
                "codex: container replaces the CLI sandbox — Landlock/Seatbelt are unavailable inside"
            );
        }
        let thread_id = tokio::time::timeout(
            std::time::Duration::from_secs(INIT_TIMEOUT_SECS),
            client.thread_start(
                &agent_cwd,
                effective_sandbox,
                approval,
                self.model_name.as_deref(),
                None,
            ),
        )
        .await
        .map_err(|_| anyhow!("Codex thread/start timed out after {INIT_TIMEOUT_SECS}s."))??;
        tracing::info!(target: "codex", session_id = %self.session_id, thread_id = %thread_id, "codex: thread/start OK — bridge READY");

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

        // Advertise codex's method-wired slash commands ONCE so the composer +
        // /help surface them. Codex's app-server doesn't push
        // `available_commands_update` like the ACP agents, so we synthesize the
        // set we route to app-server methods (today: `/review` → `review/start`).
        if !self.slash_advertised.swap(true, Ordering::SeqCst) {
            let _ = bridge_tx
                .send(BridgeEvent::SlashCommands {
                    commands: json!([{
                        "name": "review",
                        "description": "Review your uncommitted changes"
                    }]),
                })
                .await;
        }

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
        // CLI subprocess bridges only get the base URL — codex-cli has
        // no hook for injecting custom HTTP headers into its outbound
        // calls. Day-1 proxy routing is OpenAI-only via the OpenAI
        // bridge's reqwest client; for Codex, extra_headers from the
        // active proxy gateway (e.g. Weave's bearer) are silently
        // dropped. See the E2E test-plan's "Known Day-1 limitations".
        if !ctx.extra_headers.is_empty() {
            tracing::warn!(
                target: "codex",
                "codex bridge: extra_headers from active proxy are ignored on CLI subprocess — \
                 proxy auth headers won't reach the upstream. Day-1 proxy routing is OpenAI-only."
            );
        }

        let session_id = self.session_id.clone();
        let state_mu = self.state.clone();
        let aborted = self.aborted.clone();
        let msg_owned = msg.to_string();
        let sys_prompt = self.system_prompt.clone();
        let needs_cold_start = state_mu.lock().await.is_none();
        let cold_starter = if needs_cold_start {
            Some(self.cold_start_fut(
                ctx.base_url_override.clone(),
                ctx.account_env.clone(),
                ctx.container_mount_credentials,
            ))
        } else {
            None
        };

        tokio::spawn(async move {
            if let Some(fut) = cold_starter {
                if let Err(e) = fut.await {
                    let _ = bridge_tx
                        .send(BridgeEvent::sign_in_or_error(
                            "codex-cli",
                            &e.to_string(),
                            format!("Codex start-up failed: {e}"),
                        ))
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

            // Surface codex-reported errors (e.g. an unsupported model) so a
            // failed turn shows the real reason instead of an empty reply.
            // `error_emitted` dedups the dedicated `error` notification against
            // the `turn.error` on a failed `turn/completed`.
            let error_emitted = Arc::new(AtomicBool::new(false));
            let tx_err = bridge_tx.clone();
            let err_flag = error_emitted.clone();
            client
                .on_notification(
                    "error",
                    Arc::new(move |params: Value| {
                        let tx = tx_err.clone();
                        let flag = err_flag.clone();
                        Box::pin(async move {
                            if let Some(ev) = codex_failure_event(&params) {
                                if !flag.swap(true, Ordering::SeqCst) {
                                    let _ = tx.send(ev).await;
                                }
                            }
                        })
                    }),
                )
                .await;

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
            let sid_for_complete_log = session_id.clone();
            let tx_turn_err = bridge_tx.clone();
            let err_flag_turn = error_emitted.clone();
            client
                .on_notification(
                    "turn/completed",
                    Arc::new(move |params: Value| {
                        let notify = turn_done_completed.clone();
                        let acc = acc_completed.clone();
                        let sid_log = sid_for_complete_log.clone();
                        let tx = tx_turn_err.clone();
                        let flag = err_flag_turn.clone();
                        Box::pin(async move {
                            tracing::info!(target: "codex", session_id = %sid_log, "codex: turn/completed received");
                            // A failed turn carries `turn.error`; surface it if
                            // the dedicated `error` notification didn't already.
                            if let Some(ev) = params.get("turn").and_then(codex_failure_event) {
                                if !flag.swap(true, Ordering::SeqCst) {
                                    let _ = tx.send(ev).await;
                                }
                            }
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
            tracing::info!(target: "codex", session_id = %session_id, "codex: turn/start START");
            // `/review` routes to the app-server `review/start` method (it streams
            // a turn just like `turn/start`); everything else is a normal turn.
            let turn_res = if let Some(target) = codex_review_target(&msg_owned) {
                tracing::info!(target: "codex", session_id = %session_id, "codex: /review → review/start");
                client.review_start(&thread_id, target).await
            } else {
                let input_items = json!([{ "type": "text", "text": compose_input_text(sys_prompt.as_deref(), &msg_owned) }]);
                client.turn_start(&thread_id, input_items, None).await
            };
            tracing::info!(target: "codex", session_id = %session_id, turn_start_ok = turn_res.is_ok(), "codex: turn/start returned — waiting for turn/completed");

            // Wait for turn/completed, abort, or a 90s ceiling. The old
            // 5-minute ceiling left back-to-back sends frozen for the
            // entire ceiling when Codex's app-server hung mid-turn,
            // since the queued send couldn't drain until the in-flight
            // turn's run_send_flow returned. 90s is generous for the
            // model's actual response time but short enough that a
            // truly hung app-server doesn't lock the session out for
            // five whole minutes.
            // A turn/start that failed outright never completes: don't sit
            // out the ceiling before reporting it.
            if turn_res.is_ok() {
                tokio::select! {
                    _ = turn_done.notified() => {}
                    _ = tokio::time::sleep(std::time::Duration::from_secs(90)) => {
                        tracing::warn!(
                            target: "codex",
                            session_id = %session_id,
                            "codex: turn/completed never fired within 90s — emitting Status:done so the session unlocks"
                        );
                    }
                    _ = wait_aborted(aborted.clone()) => {}
                }
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
                if !error_emitted.swap(true, Ordering::SeqCst) {
                    let _ = bridge_tx
                        .send(BridgeEvent::sign_in_or_error(
                            "codex-cli",
                            &e.to_string(),
                            format!("Codex turn/start failed: {e}"),
                        ))
                        .await;
                }
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
        account_env: Vec<(String, String)>,
        mount_credentials: bool,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<()>> + Send>> {
        let session_id = self.session_id.clone();
        let project_path = self.project_path.clone();
        let permission_mode = self.permission_mode.clone();
        let model_name = self.model_name.clone();
        let effort = self.effort.clone();
        let sandbox = self.sandbox.clone();
        let is_staff = self.is_staff;
        let agent_template = self.agent_template.clone();
        let system_prompt = self.system_prompt.clone();
        let state = self.state.clone();
        let permission_handler = self.permission_handler.clone();
        Box::pin(async move {
            let bridge = CodexBridge {
                session_id,
                project_path,
                permission_mode,
                model_name,
                effort,
                sandbox,
                is_staff,
                agent_template,
                system_prompt,
                aborted: Arc::new(AtomicBool::new(false)),
                slash_advertised: Arc::new(AtomicBool::new(false)),
                state,
                permission_handler,
            };
            bridge
                .cold_start(base_url_override, account_env, mount_credentials)
                .await
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
    fn codex_review_target_recognizes_bare_review() {
        // `/review` → review the uncommitted working tree (the app-server's
        // internally-tagged ReviewTarget — verified against a live app-server).
        assert_eq!(
            codex_review_target("/review"),
            Some(json!({ "type": "uncommittedChanges" }))
        );
        assert_eq!(
            codex_review_target("  /review  "),
            Some(json!({ "type": "uncommittedChanges" }))
        );
        // Anything else is a normal prompt → turn/start (None).
        assert_eq!(codex_review_target("/review the auth flow"), None);
        assert_eq!(codex_review_target("please review this"), None);
        assert_eq!(codex_review_target("/compact"), None);
    }

    #[test]
    fn extract_codex_error_unwraps_api_error_and_handles_none() {
        // codex `error` notification: `error.message` is a JSON-encoded API
        // error — unwrap the innermost human message (verified live: codex
        // 0.135.0 rejects an unsupported model this way).
        let p = json!({
            "error": {
                "message": "{\"type\":\"error\",\"status\":400,\"error\":{\"type\":\"invalid_request_error\",\"message\":\"The 'gpt-5.2' model is not supported when using Codex with a ChatGPT account.\"}}",
                "codexErrorInfo": "other"
            }
        });
        assert_eq!(
            extract_codex_error(&p).as_deref(),
            Some("The 'gpt-5.2' model is not supported when using Codex with a ChatGPT account.")
        );
        // A plain (non-JSON) message passes through unchanged.
        assert_eq!(
            extract_codex_error(&json!({ "error": { "message": "boom" } })).as_deref(),
            Some("boom")
        );
        // No error → None (successful turn: `turn.error` absent or null).
        assert_eq!(extract_codex_error(&json!({ "turn": {} })), None);
        assert_eq!(extract_codex_error(&json!({ "error": null })), None);
    }

    #[test]
    fn unauthorized_codex_errors_ask_for_a_sign_in() {
        let p = json!({
            "error": {
                "message": "{\"error\":{\"message\":\"Your authentication token has expired. Please try signing in again.\"}}",
                "codexErrorInfo": "unauthorized"
            }
        });
        match codex_failure_event(&p) {
            Some(BridgeEvent::LoginRequired { provider, detail }) => {
                assert_eq!(provider, "codex-cli");
                assert!(detail.unwrap().contains("signing in again"));
            }
            other => panic!(
                "expected LoginRequired, got {:?}",
                other.map(|e| e.to_json())
            ),
        }
        // Any other failure stays an error.
        let p = json!({ "error": { "message": "boom", "codexErrorInfo": "other" } });
        assert!(matches!(
            codex_failure_event(&p),
            Some(BridgeEvent::Error { .. })
        ));
        assert!(codex_failure_event(&json!({ "turn": {} })).is_none());
    }

    #[test]
    fn account_read_reports_a_signed_out_codex() {
        // Shapes from codex 0.137's app-server, signed out and signed in.
        assert!(codex_signed_out(
            &json!({ "account": null, "requiresOpenaiAuth": true })
        ));
        assert!(!codex_signed_out(&json!({
            "account": { "type": "chatgpt", "planType": "free" },
            "requiresOpenaiAuth": true
        })));
        // A provider that needs no OpenAI login, or an unknown shape.
        assert!(!codex_signed_out(
            &json!({ "account": null, "requiresOpenaiAuth": false })
        ));
        assert!(!codex_signed_out(&json!({})));
        assert!(crate::bridges::acp::is_sign_in_error(CODEX_NOT_LOGGED_IN));
    }

    #[test]
    fn compose_input_text_prepends_system_prompt() {
        assert_eq!(
            super::compose_input_text(Some("RULES"), "hi"),
            "RULES\n\n---\n\nhi"
        );
        assert_eq!(super::compose_input_text(Some(""), "hi"), "hi");
        assert_eq!(super::compose_input_text(None, "hi"), "hi");
    }

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
    fn permission_mapping_native_codex_ids_passthrough() {
        // Native Codex approval-policy values pass through unchanged
        // (approval axis only; sandbox axis deferred to Phase 3).
        assert_eq!(permission_mode_to_codex("untrusted").0, "untrusted");
        assert_eq!(permission_mode_to_codex("on-request").0, "on-request");
        // Native "never" matches canonical bypassPermissions.
        assert_eq!(
            permission_mode_to_codex("never"),
            permission_mode_to_codex("bypassPermissions")
        );
    }

    #[test]
    fn codex_bypass_check_treats_never_like_bypass_permissions() {
        // The on_approval_request bypass check must treat Codex's native
        // "never" approval policy identically to bypassPermissions/dontAsk.
        let bypass = |mode: &str| matches!(mode, "bypassPermissions" | "dontAsk" | "never");
        assert!(bypass("never"));
        assert_eq!(bypass("never"), bypass("bypassPermissions"));
        assert!(!bypass("untrusted"));
        assert!(!bypass("on-request"));
        assert!(!bypass("default"));
    }

    #[test]
    fn sandbox_override_wins_over_derived_value() {
        // When sandbox = Some("read-only"), the derived sandbox from
        // "bypassPermissions" would be "danger-full-access", but the
        // explicit override must win.
        let known: &[&str] = &["read-only", "workspace-write", "danger-full-access"];
        let (_, derived) = permission_mode_to_codex("bypassPermissions");
        assert_eq!(derived, "danger-full-access");

        // Simulate the override logic from cold_start:
        let override_val = Some("read-only".to_string());
        let effective = match override_val.as_deref() {
            Some(s) if known.contains(&s) => s,
            Some(_) | None => derived,
        };
        assert_eq!(effective, "read-only", "override should win over derived");

        // None keeps the derived value.
        let no_override: Option<String> = None;
        let effective2 = match no_override.as_deref() {
            Some(s) if known.contains(&s) => s,
            Some(_) | None => derived,
        };
        assert_eq!(effective2, derived, "None should keep derived sandbox");

        // Unknown string falls back to derived.
        let unknown_override = Some("some-garbage".to_string());
        let effective3 = match unknown_override.as_deref() {
            Some(s) if known.contains(&s) => s,
            Some(_) | None => derived,
        };
        assert_eq!(
            effective3, derived,
            "unknown sandbox should fall back to derived"
        );
    }

    /// On the host, whatever the user (or the permission mode) picked stands.
    #[test]
    fn sandbox_is_untouched_on_the_host() {
        assert_eq!(effective_sandbox("read-only", false), "read-only");
        assert_eq!(
            effective_sandbox("workspace-write", false),
            "workspace-write"
        );
    }

    /// Inside a container it cannot stand: codex builds its sandbox from
    /// Landlock+seccomp (Linux) or Seatbelt (macOS), and a container exposes
    /// neither, so read-only/workspace-write fail to START rather than
    /// degrade. The container is the enclosing boundary instead.
    #[test]
    fn container_replaces_the_codex_sandbox_because_landlock_is_unavailable() {
        assert_eq!(effective_sandbox("read-only", true), "danger-full-access");
        assert_eq!(
            effective_sandbox("workspace-write", true),
            "danger-full-access"
        );
        assert_eq!(
            effective_sandbox("danger-full-access", true),
            "danger-full-access"
        );
    }

    /// The tier rides `thread/start`, not argv. Fleetify runs
    /// `codex app-server`, where a `--sandbox` command-line flag is silently
    /// ignored — so an edit that "moves it to the args" would look correct
    /// and change nothing.
    #[test]
    fn codex_container_argv_is_app_server_with_no_sandbox_flag() {
        let target = crate::services::exec_target::ExecTarget::Container {
            id: "c1".into(),
            workdir: "/work".into(),
        };
        let args: Vec<String> = ["app-server", "--listen", "stdio://"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let argv = crate::services::container::spawn::argv_for(
            &crate::services::container::spawn::SpawnRequest {
                target: &target,
                provider_id: "codex-cli",
                host_program: r"C:\Program Files\nodejs\codex.cmd",
                args: &args,
                envs: &[],
                cwd: "",
                pipe_stdin: true,
            },
        )
        .unwrap();
        assert_eq!(argv[0], "docker");
        assert_eq!(argv[2], "-i", "app-server's JSON-RPC needs docker exec -i");
        let id_at = argv.iter().position(|a| a == "c1").unwrap();
        assert_eq!(
            argv[id_at + 1],
            "codex",
            "must exec the in-container binary, not the host .cmd shim"
        );
        assert!(
            !argv.iter().any(|a| a == "--sandbox"),
            "the sandbox rides thread/start, not argv: {argv:?}"
        );
    }

    /// codex is told its own cwd a second time over the protocol. That copy
    /// must be the container's path — the host path names a directory that
    /// does not exist on codex's side.
    #[test]
    fn thread_start_cwd_is_the_in_container_path() {
        let target = crate::services::exec_target::ExecTarget::Container {
            id: "c1".into(),
            workdir: "/work/repo".into(),
        };
        assert_eq!(
            crate::services::container::spawn::agent_workdir(&target, r"C:\Users\me\repo"),
            "/work/repo"
        );
    }

    #[test]
    fn effort_mapping_collapses_extra_high_and_max() {
        assert_eq!(effort_to_codex("low"), "low");
        assert_eq!(effort_to_codex("medium"), "medium");
        assert_eq!(effort_to_codex("high"), "high");
        assert_eq!(effort_to_codex("extra_high"), "high");
        assert_eq!(effort_to_codex("max"), "high");
        assert_eq!(effort_to_codex("ultra_code"), "high");
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
