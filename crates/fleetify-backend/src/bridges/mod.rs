//! Agent bridges. Phase 1d: ClaudeBridge (subprocess `claude
//! --output-format stream-json`). Codex/OpenAI/SDK bridges are
//! Phase 2 (spec II.6). The normalized `BridgeEvent` is the exact wire
//! shape the `/ws/sessions` handler forwards (unchanged React client).

pub mod account_env;
pub mod acp;
pub mod agentic_runner;
pub mod antigravity;
pub mod antigravity_sdk;
pub mod claude;
pub mod codex;
pub mod codex_client;
pub mod cursor;
pub mod github_copilot;
pub mod grok_cli;
pub mod hermes;
pub mod interactive;
pub mod kimi;
pub mod openai;
pub mod openai_compat;
pub mod openai_compat_tools;
pub mod opencode;
pub mod permission;
pub mod perplexity;

use std::sync::Arc;

use http::HeaderMap;

/// Per-request override for a bridge. When `None`/empty, the bridge uses
/// its own construction-time defaults (env vars, hardcoded URLs, etc.).
/// Populated by the routing orchestrator (Task 16) when intelligent
/// routing is active.
#[derive(Debug, Clone, Default)]
pub struct BridgeContext {
    /// Overrides the bridge's outbound HTTP base URL.
    /// HTTP bridges apply directly; CLI bridges translate to env vars
    /// (`OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL`, `GEMINI_API_BASE`).
    pub base_url_override: Option<String>,
    /// Extra headers attached to outbound requests. HTTP bridges merge
    /// these into their request builder; CLI bridges currently ignore
    /// (CLIs negotiate their own auth).
    pub extra_headers: HeaderMap,
    /// Overrides the bridge's model selection. HTTP bridges substitute
    /// into the request body; Claude CLI passes via `--model`. The Codex
    /// CLI may not honour runtime model override — flag as a
    /// known limitation but don't block.
    pub model_override: Option<String>,
    /// Multi-account: HOME path for the selected account. Used ONLY by the
    /// antigravity bridge for its in-process disk reads; the actual subprocess
    /// env comes from `account_env`. `None` ⇒ System account.
    pub home_override: Option<std::path::PathBuf>,
    /// Env vars to set on the spawned CLI subprocess so it reads the selected
    /// account's credentials — `CLAUDE_CONFIG_DIR=<dir>` for config-dir agents
    /// (claude/codex), or a full HOME/XDG/AppData bundle for the rest. Empty
    /// for System. Resolved by `services::accounts::resolve_env`.
    pub account_env: Vec<(String, String)>,
    /// Multi-account isolation for HTTP providers: which labeled keychain key
    /// to use (`None`/`"system"` ⇒ the legacy/default key). CLI bridges ignore
    /// this (they isolate via `home_override`).
    pub account_id: Option<String>,
    /// Tier B of the container credential strategy: the session opted in to
    /// mounting this provider's own credential directory into the container.
    /// Ignored for host sessions. Defaults to false — it carries a host login
    /// across the boundary, so it is never implicit.
    pub container_mount_credentials: bool,
}

/// Tool-dispatch wrapper used by the `/ws/sessions` send flow (parity
/// with chat.py picking ClaudeBridge / SdkBridge / OpenAIBridge / Codex
/// by `session.tool`). Codex is an honest deferred stub (Phase 2
/// follow-up) that emits a clear "not implemented" + done.
#[derive(Clone)]
pub enum AnyBridge {
    Claude(Arc<claude::ClaudeBridge>),
    OpenAI(Arc<openai::OpenAIBridge>),
    Codex(Arc<codex::CodexBridge>),
    /// Shared driver for every OpenAI-compatible cloud provider in the
    /// catalog (DeepSeek, Grok, NVIDIA NIM, Kimi-API, Gemini-API,
    /// Ollama, plus OpenAI itself going forward). Provider id lives on
    /// the inner bridge so we can preserve isolation in error messages
    /// + telemetry without N near-identical enum variants.
    OpenAICompat(Arc<openai_compat::OpenAICompatBridge>),
    /// Perplexity (Sonar) gets its own variant because it ALSO emits
    /// citations / search_results alongside the text delta — bridges
    /// see those as new `BridgeEvent`s, the renderer parks them under
    /// the assistant bubble.
    Perplexity(Arc<perplexity::PerplexityBridge>),
    /// Kimi (Moonshot) Code CLI over ACP (`kimi acp`). Shares the
    /// `AcpClient` with the other ACP bridges; spawns plain `kimi acp`
    /// (no model/approval flags), authenticates out-of-band (`kimi` →
    /// `/login`), and attaches MCP over `session/new`.
    Kimi(Arc<kimi::KimiBridge>),
    /// OpenCode CLI over ACP (`opencode acp`). Shares the `AcpClient` with
    /// the other ACP bridges; skips the ACP `authenticate` step and supports
    /// runtime model switching via `session/set_config_option`.
    OpenCode(Arc<opencode::OpenCodeBridge>),
    /// Hermes Agent over ACP (`hermes acp`). Forked from the OpenCode bridge;
    /// switches models via `session/set_model` and modes via `session/set_mode`,
    /// and prepends a system prompt as a leading text block.
    Hermes(Arc<hermes::HermesBridge>),
    /// Cursor CLI over ACP (`cursor-agent acp`). Forked from the OpenCode
    /// bridge — same live model/config switching + session resume; additionally
    /// answers Cursor's blocking `cursor/ask_question` / `cursor/create_plan`
    /// extension methods (routed to a renderer card via the chat router).
    Cursor(Arc<cursor::CursorBridge>),
    /// Grok Build CLI over ACP (`grok agent stdio`). Forked from the Cursor
    /// bridge — same live model/config switching + session resume. Auth is via
    /// an injected `XAI_API_KEY` env (no ACP `authenticate`); MCP is filtered to
    /// http/sse only (grok rejects stdio MCP entries).
    GrokCli(Arc<grok_cli::GrokCliBridge>),
    /// Antigravity (`agy`) CLI — Google's terminal coding agent.
    /// Headless `-p` mode with `--conversation <uuid>` resume; no
    /// streaming until upstream adds a `stream-json` mode.
    Antigravity(Arc<antigravity::AntigravityBridge>),
    /// Antigravity SDK — the Python `google-antigravity` package, driven
    /// from a sidecar process. Sibling of `Antigravity` above but with
    /// real per-turn model selection (`LocalAgentConfig(model=...)`)
    /// and API-key auth instead of the CLI's OAuth.
    AntigravitySdk(Arc<antigravity_sdk::AntigravitySdkBridge>),
    /// Provider-agnostic agentic runner. Wraps any `ToolAdapter`
    /// (OpenAI-compat today; Anthropic/Gemini-direct/others slot in
    /// without enum churn) and drives the shared `drive_agentic_loop`,
    /// translating `TurnEvent` → `BridgeEvent` so the WS handler stays
    /// untouched. Dispatched by `chat.rs` when the session opts into
    /// tool use via `permission_mode = "acceptEdits"` (Chat-mode tools)
    /// or `"bypassPermissions"` (Autonomous tools).
    Agentic(Arc<agentic_runner::AgenticBridgeRunner>),
    /// GitHub Copilot CLI — ACP bridge (mirrors the other ACP agents).
    /// Spawns `copilot --acp --stdio` and drives the shared AcpClient.
    GitHubCopilot(Arc<github_copilot::GitHubCopilotBridge>),
}

impl AnyBridge {
    pub async fn send_message(
        &self,
        msg: &str,
        ctx: BridgeContext,
    ) -> anyhow::Result<tokio::sync::mpsc::Receiver<BridgeEvent>> {
        match self {
            AnyBridge::Claude(b) => b.send_message(msg, ctx).await,
            AnyBridge::OpenAI(b) => b.send_message(msg, ctx).await,
            AnyBridge::Codex(b) => b.send_message(msg, ctx).await,
            AnyBridge::OpenAICompat(b) => b.send_message(msg, ctx).await,
            AnyBridge::Perplexity(b) => b.send_message(msg, ctx).await,
            AnyBridge::Kimi(b) => b.send_message(msg, ctx).await,
            AnyBridge::OpenCode(b) => b.send_message(msg, ctx).await,
            AnyBridge::Hermes(b) => b.send_message(msg, ctx).await,
            AnyBridge::Cursor(b) => b.send_message(msg, ctx).await,
            AnyBridge::GrokCli(b) => b.send_message(msg, ctx).await,
            AnyBridge::Antigravity(b) => b.send_message(msg, ctx).await,
            AnyBridge::AntigravitySdk(b) => b.send_message(msg, ctx).await,
            AnyBridge::Agentic(b) => b.send_message(msg, ctx).await,
            AnyBridge::GitHubCopilot(b) => b.send_message(msg, ctx).await,
        }
    }
    pub async fn abort(&self) {
        match self {
            AnyBridge::Claude(b) => b.abort().await,
            AnyBridge::OpenAI(b) => b.abort().await,
            AnyBridge::Codex(b) => b.abort().await,
            AnyBridge::OpenAICompat(b) => b.abort().await,
            AnyBridge::Perplexity(b) => b.abort().await,
            AnyBridge::Kimi(b) => b.abort().await,
            AnyBridge::OpenCode(b) => b.abort().await,
            AnyBridge::Hermes(b) => b.abort().await,
            AnyBridge::Cursor(b) => b.abort().await,
            AnyBridge::GrokCli(b) => b.abort().await,
            AnyBridge::Antigravity(b) => b.abort().await,
            AnyBridge::AntigravitySdk(b) => b.abort().await,
            AnyBridge::Agentic(b) => b.abort().await,
            AnyBridge::GitHubCopilot(b) => b.abort().await,
        }
    }
    /// Feed an out-of-band auth code into a bridge that's mid-sign-in.
    /// Only the Antigravity CLI bridge currently needs this — its `-p`
    /// OAuth flow blocks on stdin for the code the user pastes from the
    /// Google sign-in page. Every other bridge no-ops.
    pub async fn send_auth_code(&self, code: &str) {
        if let AnyBridge::Antigravity(b) = self {
            b.send_auth_code(code).await;
        }
    }
    /// claude_session_id (if the agent emitted one in `init`). For
    /// non-Claude bridges this is `None` — no resumable session.
    pub fn claude_session_id(&self) -> Option<String> {
        match self {
            AnyBridge::Claude(b) => b.claude_session_id.clone(),
            AnyBridge::GitHubCopilot(b) => {
                // ACP session id surfaces as `claude_session_id` for renderer parity.
                b.acp_session_id.try_lock().ok().and_then(|g| g.clone())
            }
            _ => None,
        }
    }

    /// Switch the live session's model, returning the refreshed model list as
    /// a `[{id, label}]` array. Only OpenCode supports mid-session switching
    /// today (its ACP `session/set_config_option`); other bridges error so
    /// the caller can surface a clear message.
    pub async fn set_model(&self, model_id: &str) -> anyhow::Result<Value> {
        match self {
            AnyBridge::OpenCode(b) => {
                let models = b.set_model(model_id).await?;
                Ok(opencode::models_to_json(&models))
            }
            AnyBridge::Cursor(b) => {
                let models = b.set_model(model_id).await?;
                Ok(cursor::models_to_json(&models))
            }
            AnyBridge::GrokCli(b) => {
                let models = b.set_model(model_id).await?;
                Ok(grok_cli::models_to_json(&models))
            }
            AnyBridge::Hermes(b) => {
                let models = b.set_model(model_id).await?;
                Ok(hermes::models_to_json(&models))
            }
            _ => Err(anyhow::anyhow!(
                "mid-session model switching is not supported for this agent"
            )),
        }
    }

    /// Set an arbitrary live-session config option (e.g. `effort`, `mode`).
    /// OpenCode-only today; returns the refreshed model list as `[{id,label}]`.
    pub async fn set_config(&self, config_id: &str, value: &str) -> anyhow::Result<Value> {
        match self {
            AnyBridge::OpenCode(b) => {
                let models = b.set_config(config_id, value).await?;
                Ok(opencode::models_to_json(&models))
            }
            AnyBridge::Cursor(b) => {
                let models = b.set_config(config_id, value).await?;
                Ok(cursor::models_to_json(&models))
            }
            AnyBridge::GrokCli(b) => {
                let models = b.set_config(config_id, value).await?;
                Ok(grok_cli::models_to_json(&models))
            }
            AnyBridge::Hermes(b) => {
                let models = b.set_config(config_id, value).await?;
                Ok(hermes::models_to_json(&models))
            }
            _ => Err(anyhow::anyhow!(
                "live config switching is not supported for this agent"
            )),
        }
    }
}

use serde_json::{json, Value};

/// Parse a session's `tool_overrides` JSON string into a normalized
/// tool-name → decision map (keys + values lowercased). Returns an empty
/// map on absent/invalid input — a bad override must never break dispatch.
pub fn parse_tool_overrides(raw: Option<&str>) -> std::collections::HashMap<String, String> {
    let mut map = std::collections::HashMap::new();
    let Some(s) = raw else { return map };
    if let Ok(serde_json::Value::Object(obj)) = serde_json::from_str::<serde_json::Value>(s) {
        for (k, v) in obj {
            if let Some(decision) = v.as_str() {
                map.insert(k.to_lowercase(), decision.to_lowercase());
            }
        }
    }
    map
}

/// Decision for a tool under an overrides map, if any. `Some(true)` = force
/// allow, `Some(false)` = force deny, `None` = no override (use mode logic).
pub fn tool_override_decision(
    overrides: &std::collections::HashMap<String, String>,
    tool_name: &str,
) -> Option<bool> {
    match overrides.get(&tool_name.to_lowercase()).map(String::as_str) {
        Some("allow") => Some(true),
        Some("deny") => Some(false),
        _ => None,
    }
}

/// Expand Windows `%VAR%` references using `lookup` (injected for testability).
/// Unknown / unterminated vars are left verbatim; `%%` collapses to a literal
/// `%`. Registry PATH values are `REG_EXPAND_SZ`, which `winreg` returns
/// unexpanded, so the canonical PATH must be expanded before use.
#[cfg(windows)]
fn expand_windows_vars(s: &str, lookup: impl Fn(&str) -> Option<String>) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('%') {
        out.push_str(&rest[..i]);
        let after = &rest[i + 1..];
        match after.find('%') {
            Some(j) => {
                let name = &after[..j];
                match (name.is_empty(), lookup(name)) {
                    (true, _) => out.push('%'), // "%%" → literal %
                    (false, Some(v)) => out.push_str(&v),
                    (false, None) => {
                        // Unknown var: keep the literal `%NAME%`.
                        out.push('%');
                        out.push_str(name);
                        out.push('%');
                    }
                }
                rest = &after[j + 1..];
            }
            None => {
                // No closing `%` — emit the remainder verbatim.
                out.push('%');
                out.push_str(after);
                return out;
            }
        }
    }
    out.push_str(rest);
    out
}

/// Assemble the canonical PATH: `node_dir` (if known) first, then Machine then
/// User entries, trimmed, with empty + case-insensitive-duplicate segments
/// dropped. Pure so the assembly is unit-testable without the registry.
#[cfg(windows)]
fn clean_path(machine: &str, user: &str, node_dir: Option<&str>) -> String {
    let mut seen = std::collections::HashSet::<String>::new();
    let mut out: Vec<String> = Vec::new();
    for raw in node_dir
        .into_iter()
        .chain(machine.split(';'))
        .chain(user.split(';'))
    {
        let e = raw.trim();
        if e.is_empty() {
            continue;
        }
        if seen.insert(e.to_ascii_lowercase()) {
            out.push(e.to_string());
        }
    }
    out.join(";")
}

/// The PATH a *fresh* process gets: the Machine + User registry `Path`,
/// env-expanded, deduped, with Node's own directory ensured present. `None`
/// when both registry reads fail.
#[cfg(windows)]
fn canonical_windows_path() -> Option<String> {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    use winreg::RegKey;
    let read = |root, sub: &str| -> String {
        RegKey::predef(root)
            .open_subkey(sub)
            .ok()
            .and_then(|k| k.get_value::<String, _>("Path").ok())
            .unwrap_or_default()
    };
    let machine = read(
        HKEY_LOCAL_MACHINE,
        r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment",
    );
    let user = read(HKEY_CURRENT_USER, "Environment");
    if machine.is_empty() && user.is_empty() {
        return None;
    }
    let lookup = |k: &str| std::env::var(k).ok();
    let machine = expand_windows_vars(&machine, lookup);
    let user = expand_windows_vars(&user, lookup);
    let node_dir = which::which("node")
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_string_lossy().into_owned()));
    Some(clean_path(&machine, &user, node_dir.as_deref()))
}

/// Hand a spawned CLI agent the user's *canonical* PATH (the Machine + User
/// registry PATH a fresh terminal gets) instead of the runtime PATH our deep
/// launch chain (npm → cross-env → tauri → cargo) bloats to ~17k chars / ~180
/// entries on a dev box. The agents' npm `.cmd` shims — and the agents' own
/// internal `chcp` / shell-outs — run under cmd.exe, which truncates a PATH
/// over 8191 chars and drops `node` / `git`, killing the agent at startup
/// ("ACP stream closed: 'node' is not recognized"). The canonical PATH (~2.5k
/// chars) carries node + System32 + git within the limit. No-op on non-Windows
/// (no cmd.exe PATH-length truncation) and when the registry read fails (the
/// child then keeps the inherited PATH — prior behaviour).
pub fn apply_clean_path(cmd: &mut tokio::process::Command) {
    #[cfg(windows)]
    {
        if let Some(path) = canonical_windows_path() {
            cmd.env("PATH", path);
        }
    }
    #[cfg(not(windows))]
    {
        let _ = cmd;
    }
}

/// Normalized event (parity with `ClaudeBridgeEvent`). `to_json()` is the
/// exact `{type, …}` envelope sent over the chat WebSocket.
#[derive(Debug, Clone, PartialEq)]
pub enum BridgeEvent {
    Status {
        status: String,
    },
    Init {
        session_id: String,
        claude_session_id: Option<String>,
        model: String,
        tools_count: usize,
    },
    MessageDelta {
        text: String,
    },
    Thinking {
        text: String,
    },
    ToolStart {
        tool_id: String,
        name: String,
        input: Value,
    },
    ToolUpdate {
        tool_id: String,
        input: Value,
    },
    ToolEnd {
        tool_id: String,
        output: String,
        is_error: bool,
    },
    Cost {
        usage: Value,
        cost_usd: f64,
        model: String,
    },
    Error {
        error: String,
    },
    CompactBoundary {
        compact_metadata: Value,
    },
    /// Web citation emitted by search-grounded providers (Perplexity
    /// Sonar). Renderer renders these as a CitationCard under the
    /// assistant bubble; multiple Citation events accumulate into the
    /// same card client-side.
    Citation {
        url: String,
        title: Option<String>,
        snippet: Option<String>,
    },
    /// Richer search-result row from providers that surface them
    /// separately from citations (Perplexity's `search_results` field).
    /// Carries an explicit title + optional date so the card can render
    /// "Article — Site — 2026-01-01" rows.
    SearchResult {
        url: String,
        title: String,
        snippet: Option<String>,
        date: Option<String>,
    },
    /// The agentic loop's permission gate is asking the user to approve
    /// a write/shell tool that the session's mode flagged as Ask. The
    /// renderer shows an inline approve/deny dialog tied to `call_id`;
    /// clicking either button POSTs back to
    /// `/api/chat/permission_response`, which resolves the gate's
    /// pending oneshot and the loop continues. `tool_name` + `input`
    /// are included so the dialog can summarise the action.
    PermissionRequest {
        call_id: String,
        tool_name: String,
        input: Value,
    },
    /// Live, per-session model catalog surfaced by an agent that sources its
    /// models at runtime rather than from the static provider catalog
    /// (OpenCode). `models` is an array of `{id, label}`; `current` is the
    /// active model id. The renderer renders these in the composer's model
    /// picker and round-trips a `model_switch` command to change them.
    AvailableModels {
        models: Value,
        current: String,
    },
    /// Slash commands the agent advertises at runtime (OpenCode's
    /// `available_commands_update`). `commands` is an array of
    /// `{name, description}`; the composer merges them into its slash menu.
    SlashCommands {
        commands: Value,
    },
    /// The bridge needs the user to complete an external sign-in
    /// flow before it can produce a reply. The shell intercepts
    /// this event to open `url` in the OS browser (flipping
    /// `opened_in_browser` to true on success), then forwards it
    /// to the renderer which renders an info card. The bridge
    /// itself always emits `opened_in_browser: false`.
    AuthRequired {
        /// Logical provider id for routing (`"antigravity"` for now;
        /// future bridges can reuse this variant).
        provider: String,
        /// The exact URL the user should visit. Forwarded verbatim
        /// to the renderer so the "Open sign-in" fallback button
        /// can use it when shell-open failed.
        url: String,
        /// Set true by the shell layer after a successful OS-browser
        /// open. Bridge always emits false.
        opened_in_browser: bool,
    },
    /// The agent can't answer because it isn't signed in, and recovery is a
    /// sign-in outside the chat (not an in-chat OOB code like `AuthRequired`):
    /// the agent's login command, or an API key for the Antigravity SDK.
    /// Emitted instead of `Error` (or, for Claude Code, instead of the
    /// "Not logged in · Please run /login" reply). The renderer shows a
    /// sign-in card for the provider and re-sends the user's prompt once the
    /// sign-in succeeds.
    LoginRequired {
        /// Catalog id of the CLI agent (`"claude-code"`, `"grok-build"`, …):
        /// selects the login command (`cli_auth::login_spec`) and branding.
        provider: String,
        /// What the agent said, when it said something (shown on the card).
        detail: Option<String>,
    },
}

impl BridgeEvent {
    /// The event for an agent that failed with `err`: a sign-in card when the
    /// agent says it isn't signed in (`acp::is_sign_in_error`), else
    /// `fallback` as an error.
    pub fn sign_in_or_error(provider: &str, err: &str, fallback: String) -> Self {
        if acp::is_sign_in_error(err) {
            BridgeEvent::LoginRequired {
                provider: provider.to_string(),
                detail: Some(err.to_string()),
            }
        } else {
            BridgeEvent::Error { error: fallback }
        }
    }

    pub fn to_json(&self) -> Value {
        match self {
            BridgeEvent::Status { status } => json!({"type": "status", "status": status}),
            BridgeEvent::Init {
                session_id,
                claude_session_id,
                model,
                tools_count,
            } => json!({
                "type": "init", "session_id": session_id,
                "claude_session_id": claude_session_id, "model": model,
                "tools_count": tools_count
            }),
            BridgeEvent::MessageDelta { text } => {
                json!({"type": "message_delta", "delta": {"type": "text", "text": text}})
            }
            BridgeEvent::Thinking { text } => json!({"type": "thinking", "text": text}),
            BridgeEvent::ToolStart {
                tool_id,
                name,
                input,
            } => {
                json!({"type": "tool_start", "tool_id": tool_id, "name": name, "input": input})
            }
            BridgeEvent::ToolUpdate { tool_id, input } => {
                json!({"type": "tool_update", "tool_id": tool_id, "input": input})
            }
            BridgeEvent::ToolEnd {
                tool_id,
                output,
                is_error,
            } => json!({
                "type": "tool_end", "tool_id": tool_id, "output": output, "is_error": is_error
            }),
            BridgeEvent::Cost {
                usage,
                cost_usd,
                model,
            } => {
                json!({"type": "cost", "usage": usage, "cost_usd": cost_usd, "model": model})
            }
            BridgeEvent::Error { error } => json!({"type": "error", "error": error}),
            BridgeEvent::CompactBoundary { compact_metadata } => {
                json!({"type": "compact_boundary", "compact_metadata": compact_metadata})
            }
            BridgeEvent::Citation {
                url,
                title,
                snippet,
            } => json!({
                "type": "citation",
                "url": url,
                "title": title,
                "snippet": snippet,
            }),
            BridgeEvent::SearchResult {
                url,
                title,
                snippet,
                date,
            } => json!({
                "type": "search_result",
                "url": url,
                "title": title,
                "snippet": snippet,
                "date": date,
            }),
            BridgeEvent::PermissionRequest {
                call_id,
                tool_name,
                input,
            } => json!({
                "type": "permission_request",
                // `id` (not `call_id`) on the wire so the renderer reuses
                // its existing PermissionRequest store entry + dialog
                // component shape from the CLI-MCP flow. Backend keeps
                // `call_id` internally for clarity.
                "id": call_id,
                "tool_name": tool_name,
                "input": input,
            }),
            BridgeEvent::AvailableModels { models, current } => json!({
                "type": "available_models_update",
                "models": models,
                "current_model": current,
            }),
            BridgeEvent::SlashCommands { commands } => json!({
                "type": "slash_commands_update",
                "commands": commands,
            }),
            BridgeEvent::AuthRequired {
                provider,
                url,
                opened_in_browser,
            } => json!({
                "type": "auth_required",
                "provider": provider,
                "url": url,
                "opened_in_browser": opened_in_browser,
            }),
            BridgeEvent::LoginRequired { provider, detail } => {
                let mut v = json!({
                    "type": "login_required",
                    "provider": provider,
                });
                if let Some(d) = detail {
                    v["detail"] = json!(d);
                }
                v
            }
        }
    }
}

impl serde::Serialize for BridgeEvent {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.to_json().serialize(serializer)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn login_required_serialises_to_wire_shape() {
        let ev = BridgeEvent::LoginRequired {
            provider: "grok-build".into(),
            detail: None,
        };
        assert_eq!(
            ev.to_json(),
            serde_json::json!({"type": "login_required", "provider": "grok-build"})
        );
        let ev = BridgeEvent::LoginRequired {
            provider: "claude-code".into(),
            detail: Some("Not logged in · Please run /login".into()),
        };
        assert_eq!(
            ev.to_json(),
            serde_json::json!({
                "type": "login_required",
                "provider": "claude-code",
                "detail": "Not logged in · Please run /login",
            })
        );
    }

    // ── canonical PATH assembly (Windows: see apply_clean_path) ──────────────

    #[cfg(windows)]
    #[test]
    fn clean_path_puts_node_first_dedupes_and_drops_empties() {
        let machine = r"C:\Windows\System32;C:\Windows;C:\Program Files\Git\cmd";
        let user = r"C:\Windows\System32;;C:\Users\me\AppData\Roaming\npm"; // dup + empty
        let out = clean_path(machine, user, Some(r"C:\Program Files\nodejs"));
        let parts: Vec<&str> = out.split(';').collect();
        assert_eq!(parts[0], r"C:\Program Files\nodejs"); // node guaranteed first
                                                          // System32 appears once despite being in both Machine and User.
        assert_eq!(
            parts
                .iter()
                .filter(|p| p.eq_ignore_ascii_case(r"C:\Windows\System32"))
                .count(),
            1
        );
        assert!(!parts.iter().any(|p| p.is_empty())); // empty segment dropped
        assert!(parts.contains(&r"C:\Program Files\Git\cmd")); // real entries kept
        assert!(parts.contains(&r"C:\Users\me\AppData\Roaming\npm"));
    }

    #[cfg(windows)]
    #[test]
    fn clean_path_does_not_duplicate_node_already_present() {
        let out = clean_path(
            r"C:\Program Files\nodejs;C:\Windows\System32",
            "",
            Some(r"C:\Program Files\nodejs"),
        );
        assert_eq!(
            out.split(';')
                .filter(|p| p.eq_ignore_ascii_case(r"C:\Program Files\nodejs"))
                .count(),
            1
        );
    }

    #[cfg(windows)]
    #[test]
    fn expand_windows_vars_expands_known_keeps_unknown_and_literal_percent() {
        let lookup = |k: &str| match k {
            "SystemRoot" => Some(r"C:\Windows".to_string()),
            _ => None,
        };
        assert_eq!(
            expand_windows_vars(r"%SystemRoot%\System32;%NOPE%\x", lookup),
            r"C:\Windows\System32;%NOPE%\x"
        );
        assert_eq!(expand_windows_vars("100%% done", lookup), "100% done");
        assert_eq!(expand_windows_vars("no vars", lookup), "no vars");
    }

    // ── parse_tool_overrides ─────────────────────────────────────────────────

    #[test]
    fn parse_tool_overrides_valid_json_returns_lowercased_map() {
        let raw = r#"{"bash":"deny","Read":"allow","WebFetch":"ask"}"#;
        let m = parse_tool_overrides(Some(raw));
        assert_eq!(m.get("bash").map(String::as_str), Some("deny"));
        assert_eq!(m.get("read").map(String::as_str), Some("allow"));
        assert_eq!(m.get("webfetch").map(String::as_str), Some("ask"));
        // Original-case keys are gone (lowercased on insert).
        assert!(!m.contains_key("Read"));
    }

    #[test]
    fn parse_tool_overrides_invalid_json_returns_empty() {
        assert!(parse_tool_overrides(Some("{ THIS IS NOT VALID JSON")).is_empty());
    }

    #[test]
    fn parse_tool_overrides_none_returns_empty() {
        assert!(parse_tool_overrides(None).is_empty());
    }

    #[test]
    fn parse_tool_overrides_empty_string_returns_empty() {
        assert!(parse_tool_overrides(Some("")).is_empty());
    }

    // ── tool_override_decision ───────────────────────────────────────────────

    #[test]
    fn tool_override_decision_allow_returns_some_true() {
        let mut m = std::collections::HashMap::new();
        m.insert("bash".to_string(), "allow".to_string());
        assert_eq!(tool_override_decision(&m, "bash"), Some(true));
        // Case-insensitive lookup.
        assert_eq!(tool_override_decision(&m, "BASH"), Some(true));
        assert_eq!(tool_override_decision(&m, "Bash"), Some(true));
    }

    #[test]
    fn tool_override_decision_deny_returns_some_false() {
        let mut m = std::collections::HashMap::new();
        m.insert("shell".to_string(), "deny".to_string());
        assert_eq!(tool_override_decision(&m, "shell"), Some(false));
        assert_eq!(tool_override_decision(&m, "SHELL"), Some(false));
    }

    #[test]
    fn tool_override_decision_ask_or_absent_returns_none() {
        let mut m = std::collections::HashMap::new();
        m.insert("read".to_string(), "ask".to_string());
        // "ask" is a fall-through → None.
        assert_eq!(tool_override_decision(&m, "read"), None);
        // Absent key → None.
        assert_eq!(tool_override_decision(&m, "bash"), None);
        // Empty map → None.
        let empty: std::collections::HashMap<String, String> = std::collections::HashMap::new();
        assert_eq!(tool_override_decision(&empty, "bash"), None);
    }

    #[test]
    fn auth_required_serializes_with_snake_case_tag() {
        let ev = BridgeEvent::AuthRequired {
            provider: "antigravity".into(),
            url: "https://accounts.google.com/o/oauth2/auth?foo=1".into(),
            opened_in_browser: false,
        };
        let s = serde_json::to_string(&ev).unwrap();
        let v: serde_json::Value = serde_json::from_str(&s).unwrap();
        assert_eq!(v["type"], "auth_required");
        assert_eq!(v["provider"], "antigravity");
        assert_eq!(v["url"], "https://accounts.google.com/o/oauth2/auth?foo=1");
        assert_eq!(v["opened_in_browser"], false);
    }
}

#[cfg(test)]
mod any_bridge_tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn any_bridge_github_copilot_variant_exists() {
        let bridge = Arc::new(github_copilot::GitHubCopilotBridge::new(
            "test-session",
            "/tmp/test-project",
            "default",
            None,
            None,
            None,
        ));
        let any = AnyBridge::GitHubCopilot(bridge);
        assert!(any.claude_session_id().is_none());
    }
}

/// Refuse a non-host execution target for a bridge that cannot run anywhere
/// but the host, surfacing the provider's own reason.
///
/// Used by the two Antigravity bridges. Both do substantial host-side work
/// around the spawn — a PTY, config written next to the agent, a transcript
/// read back off disk — so they cannot simply be wrapped in `docker exec`.
/// Failing here names the reason and the fix; failing at the spawn produces
/// an opaque OS error instead.
pub(crate) fn refuse_non_host_target(project_path: &str) -> anyhow::Result<()> {
    use crate::services::exec_target::{parse, ExecTarget};
    match parse(project_path) {
        ExecTarget::Local => Ok(()),
        ExecTarget::Unsupported(reason) => anyhow::bail!("{reason}"),
        ExecTarget::Container { .. } => {
            // Provider id is not threaded down here, and both callers are
            // Antigravity, so read the reason off the CLI entry — the SDK's
            // is equivalent and the CLI's is the stricter of the two.
            let reason = match crate::services::container::spec_for("antigravity-cli")
                .map(|s| s.support)
            {
                Some(crate::services::container::ContainerSupport::Unsupported(r)) => r,
                _ => {
                    "This agent can't run inside a container. Switch the session to a local folder."
                }
            };
            anyhow::bail!("{reason}")
        }
    }
}
