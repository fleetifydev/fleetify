//! Agent bridges. Phase 1d: ClaudeBridge (subprocess `claude
//! --output-format stream-json`). Gemini/Codex/OpenAI/SDK bridges are
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
pub mod gemini;
pub mod github_copilot;
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
    /// into the request body; Claude CLI passes via `--model`. Codex/
    /// Gemini CLIs may not honour runtime model override — flag as a
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
}

/// Tool-dispatch wrapper used by the `/ws/sessions` send flow (parity
/// with chat.py picking ClaudeBridge / SdkBridge / OpenAIBridge / Gemini
/// / Codex by `session.tool`). Gemini + Codex are honest deferred stubs
/// (Phase 2 follow-up) that emit a clear "not implemented" + done.
#[derive(Clone)]
pub enum AnyBridge {
    Claude(Arc<claude::ClaudeBridge>),
    OpenAI(Arc<openai::OpenAIBridge>),
    Gemini(Arc<gemini::GeminiBridge>),
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
    /// the Gemini bridge; skips the ACP `authenticate` step and supports
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
    /// GitHub Copilot CLI — ACP bridge (mirrors Gemini). Spawns
    /// `copilot --acp --stdio` and drives the shared AcpClient.
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
            AnyBridge::Gemini(b) => b.send_message(msg, ctx).await,
            AnyBridge::Codex(b) => b.send_message(msg, ctx).await,
            AnyBridge::OpenAICompat(b) => b.send_message(msg, ctx).await,
            AnyBridge::Perplexity(b) => b.send_message(msg, ctx).await,
            AnyBridge::Kimi(b) => b.send_message(msg, ctx).await,
            AnyBridge::OpenCode(b) => b.send_message(msg, ctx).await,
            AnyBridge::Hermes(b) => b.send_message(msg, ctx).await,
            AnyBridge::Cursor(b) => b.send_message(msg, ctx).await,
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
            AnyBridge::Gemini(b) => b.abort().await,
            AnyBridge::Codex(b) => b.abort().await,
            AnyBridge::OpenAICompat(b) => b.abort().await,
            AnyBridge::Perplexity(b) => b.abort().await,
            AnyBridge::Kimi(b) => b.abort().await,
            AnyBridge::OpenCode(b) => b.abort().await,
            AnyBridge::Hermes(b) => b.abort().await,
            AnyBridge::Cursor(b) => b.abort().await,
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

/// Prepend `dir` (+ `;`) to a PATH-style string. Pure so the cmd.exe
/// truncation semantics are unit-testable without touching the environment.
fn prepend_path_entry(dir: &std::ffi::OsStr, current: &std::ffi::OsStr) -> std::ffi::OsString {
    let mut out = std::ffi::OsString::from(dir);
    if !current.is_empty() {
        out.push(";");
        out.push(current);
    }
    out
}

/// Windows: npm-shim CLIs (`gemini.cmd` / `codex.cmd` / `kimi.cmd` / …) launch
/// `node` from PATH. cmd.exe — which runs the `.cmd` shim — TRUNCATES the
/// inherited PATH at 8191 chars; when the user's PATH is bloated (>8191) and
/// every Node directory sits past that boundary, the shim's `node` invocation
/// fails (`'node' is not recognized`) and the agent dies the instant it spawns
/// ("ACP stream closed"). Prepend Node's own directory so it always survives
/// the truncation. No-op on non-Windows and when `node` can't be resolved (the
/// child then inherits PATH unchanged, behaving exactly as before).
pub fn ensure_node_on_path(cmd: &mut tokio::process::Command) {
    if !cfg!(windows) {
        return;
    }
    let Some(node_dir) = which::which("node")
        .ok()
        .and_then(|p| p.parent().map(std::path::Path::to_path_buf))
    else {
        return;
    };
    let current = std::env::var_os("PATH").unwrap_or_default();
    cmd.env("PATH", prepend_path_entry(node_dir.as_os_str(), &current));
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
}

impl BridgeEvent {
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

    // ── prepend_path_entry ───────────────────────────────────────────────────

    #[test]
    fn prepend_path_entry_puts_dir_within_cmd_truncation_window() {
        use std::ffi::OsString;
        // Reproduce the gemini "ACP stream closed" root cause: a bloated PATH
        // (>8191 chars) where the node dir sits PAST cmd.exe's 8191-char
        // truncation boundary, so the npm `.cmd` shim's `node` invocation can't
        // find it. After prepending, the node dir must land at the very front,
        // safely inside the window cmd.exe keeps.
        let node = "C:\\Program Files\\nodejs";
        let mut bloated = OsString::new();
        for i in 0..400 {
            bloated.push(format!("C:\\some\\padding\\dir-{i:03}\\bin;"));
        }
        bloated.push(node);
        let before = bloated.to_string_lossy();
        assert!(before.len() > 8191, "fixture must exceed the cmd.exe limit");
        assert!(
            before.find("nodejs").unwrap() > 8191,
            "fixture must put nodejs past the truncation boundary"
        );

        let fixed = prepend_path_entry(std::ffi::OsStr::new(node), &bloated);
        let after = fixed.to_string_lossy();
        assert!(after.starts_with("C:\\Program Files\\nodejs;"));
        assert!(
            after.find("nodejs").unwrap() < 8191,
            "after prepend the node dir must survive cmd.exe truncation"
        );
        // The original PATH is preserved after the prepended entry.
        assert!(after.contains("dir-399"));
    }

    #[test]
    fn prepend_path_entry_handles_empty_current() {
        let out = prepend_path_entry(std::ffi::OsStr::new("C:\\node"), std::ffi::OsStr::new(""));
        assert_eq!(out.to_string_lossy(), "C:\\node");
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
