//! Faithful port of `app/services/claude_bridge.py`. The stream-json
//! `parse_event` is pure + unit-tested (fidelity-critical); `ClaudeBridge`
//! drives the `claude` subprocess around it. `--mcp-config` injection and
//! `calculate_cost` fallback are Phase 4/3 (explicit, not silent).

use std::collections::{HashMap, HashSet};
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

/// Self-heal an orphaned resume target in a built `claude` argv: replace the
/// `--resume <id>` pair with a single `--continue`. `--continue` resumes the
/// most-recent conversation in the working directory (preserving context),
/// where `--resume <id>` would hard-fail with "No conversation found" when
/// the transcript is gone. No-op (returned unchanged) when the argv has no
/// `--resume`.
fn swap_resume_for_continue(mut cmd: Vec<String>) -> Vec<String> {
    if let Some(i) = cmd.iter().position(|a| a == "--resume") {
        cmd.remove(i); // drop "--resume"
        if i < cmd.len() {
            cmd.remove(i); // drop its <id> value
        }
        cmd.insert(i, "--continue".to_string());
    }
    cmd
}

/// Drop the `--resume <id>` pair entirely, leaving NO resume flag — the turn
/// starts a fresh conversation. Used when the session is running under a
/// different account's `CLAUDE_CONFIG_DIR`: the conversation lives in another
/// account's config dir, so neither `--resume` nor `--continue` (which would
/// grab an unrelated recent conversation) is right; start clean in this account.
fn drop_resume(mut cmd: Vec<String>) -> Vec<String> {
    if let Some(i) = cmd.iter().position(|a| a == "--resume") {
        cmd.remove(i); // drop "--resume"
        if i < cmd.len() {
            cmd.remove(i); // drop its <id> value
        }
    }
    cmd
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
                    let tool_id =
                        s(&block, "id").unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
                    let name = s(&block, "name").unwrap_or_else(|| "unknown".into());
                    let initial = block.get("input").cloned().unwrap_or(json!({}));
                    let idx = inner.get("index").and_then(|x| x.as_i64()).unwrap_or(-1);
                    let input_map = initial.as_object().cloned().unwrap_or_default();
                    st.tool_input_buffers.insert(
                        idx,
                        ToolBuf {
                            tool_id: tool_id.clone(),
                            json: String::new(),
                            input: input_map,
                        },
                    );
                    st.streamed_tool_ids.insert(tool_id.clone());
                    st.tool_states.insert(tool_id.clone(), initial.clone());
                    out.push(BridgeEvent::ToolStart {
                        tool_id,
                        name,
                        input: initial,
                    });
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
                        if let Ok(Value::Object(parsed)) = serde_json::from_str::<Value>(&buf.json)
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
                        let tool_id =
                            s(&block, "id").unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
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
                        out.push(BridgeEvent::ToolStart {
                            tool_id,
                            name,
                            input,
                        });
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
                        let is_error = block
                            .get("is_error")
                            .and_then(|x| x.as_bool())
                            .unwrap_or(false);
                        out.push(BridgeEvent::ToolEnd {
                            tool_id,
                            output,
                            is_error,
                        });
                    }
                    _ => {}
                }
            }
        }
        // Claude Code streams tool outputs back as a `user` message whose
        // content array holds `tool_result` blocks. Without this arm the
        // outputs are dropped: the assistant message persists 23 tool_use
        // blocks but 0 tool_result blocks → cards show commands, no output.
        "user" => {
            let blocks = event
                .get("message")
                .and_then(|m| m.get("content"))
                .and_then(|c| c.as_array())
                .cloned()
                .unwrap_or_default();
            for block in blocks {
                if block.get("type").and_then(|x| x.as_str()) != Some("tool_result") {
                    continue;
                }
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
                let is_error = block
                    .get("is_error")
                    .and_then(|x| x.as_bool())
                    .unwrap_or(false);
                out.push(BridgeEvent::ToolEnd {
                    tool_id,
                    output,
                    is_error,
                });
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

/// Faithful port of `STAFF_SUBAGENTS` from `sdk_bridge.py:101-162`.
/// Drives the staff session's `--agents <json>` flag so the model's
/// `Agent` tool can dispatch to one of five named subagents
/// (`code-reviewer`, `bug-fixer`, `test-writer`, `researcher`,
/// `architect`). Built lazily once per process — the JSON is large
/// and not interesting to re-serialise per turn.
fn staff_subagents_json() -> &'static serde_json::Value {
    static AGENTS: std::sync::OnceLock<serde_json::Value> = std::sync::OnceLock::new();
    AGENTS.get_or_init(|| {
        serde_json::json!({
            "code-reviewer": {
                "description": "Review code for quality, security, and performance",
                "prompt": "You are an expert code reviewer. Analyze code for:\n\
                           - Security vulnerabilities\n\
                           - Performance bottlenecks\n\
                           - Code quality and maintainability\n\
                           Be specific, cite file paths and line numbers, give actionable feedback.",
                "tools": ["Read", "Glob", "Grep"],
                "model": "claude-sonnet-4-6",
            },
            "bug-fixer": {
                "description": "Find root causes of bugs and propose targeted fixes",
                "prompt": "You are an expert debugger. Given a bug:\n\
                           1. Trace the code path to find the root cause\n\
                           2. Propose a minimal, targeted fix\n\
                           3. Explain why it works and what it prevents",
                "tools": ["Read", "Glob", "Grep", "Bash"],
                "model": "claude-sonnet-4-6",
            },
            "test-writer": {
                "description": "Write comprehensive tests with good edge case coverage",
                "prompt": "You are a testing expert. Write:\n\
                           - Unit tests for individual functions\n\
                           - Integration tests for APIs and components\n\
                           - Edge cases and error conditions\n\
                           Follow the project's existing test patterns and framework.",
                "tools": ["Read", "Write", "Bash", "Glob"],
                "model": "claude-sonnet-4-6",
            },
            "researcher": {
                "description": "Research topics, libraries, APIs, and best practices",
                "prompt": "You are a research assistant. Investigate by:\n\
                           - Searching the web for current information\n\
                           - Reading documentation and source code\n\
                           - Synthesizing findings into actionable summaries\n\
                           Be concise and focus on practical information relevant to the task.",
                "tools": ["WebSearch", "WebFetch", "Read"],
                "model": "claude-sonnet-4-6",
            },
            "architect": {
                "description": "Design system architecture, APIs, and data models",
                "prompt": "You are a software architect. Design:\n\
                           - System architecture with component diagrams (ASCII)\n\
                           - API contracts and data models\n\
                           - Database schemas\n\
                           - Component interactions and data flows\n\
                           Focus on scalability, maintainability, and simplicity.",
                "tools": ["Read", "Glob", "Grep"],
                "model": "claude-opus-4-7",
            },
        })
    })
}

/// Effort picker → Claude CLI `--effort` level. Returns `None` when the
/// model has no effort lever (Haiku) or no effort was chosen. Claude Code
/// auto-falls-back for levels a model doesn't support (e.g. xhigh→high on
/// Sonnet), so we only special-case Haiku + the empty/unknown input.
fn effort_to_claude(effort: &str, model: &str) -> Option<&'static str> {
    if model.contains("haiku") {
        return None;
    }
    match effort {
        "low" => Some("low"),
        "medium" => Some("medium"),
        "high" => Some("high"),
        "extra_high" => Some("xhigh"),
        "max" => Some("max"),
        _ => None,
    }
}

/// Drives the `claude` subprocess. `--mcp-config` injection is Phase 4.
pub struct ClaudeBridge {
    pub session_id: String,
    pub project_path: String,
    pub claude_session_id: Option<String>,
    pub permission_mode: String,
    pub effort: String,
    pub model_name: Option<String>,
    pub session_title: Option<String>,
    pub system_prompt: Option<String>,
    pub session_mode: String,
    /// Staff agent (`Session.title == "Staff Agent"`) gets a constrained
    /// tool set (Agent / WebSearch / WebFetch) + the Fleet text-protocol
    /// dispatch system prompt. Non-staff agents get the full tool set
    /// plus the `fleet_dispatch` MCP so they can route subtasks via
    /// `mcp__fleet_dispatch__dispatch_to_agent`. See
    /// `services::staff_prompt::build` for the prompt itself and
    /// `build_mcp_config` for the MCP filtering.
    pub is_staff: bool,
    /// Builtin template id (e.g. `"reverse_engineering"`). When set,
    /// the template's `extra_mcp_servers` opt the session into extra
    /// stdio MCPs (`fleet_reveng` etc.) beyond the baseline
    /// memory+dispatch. Matches `Session.agent_template`.
    pub agent_template: Option<String>,
    /// When set, this bridge mounts `fleet_permission` (an in-process
    /// MCP-over-HTTP server on the backend, NOT a sidecar binary) and
    /// passes `--permission-prompt-tool mcp__fleet_permission__permission_prompt`
    /// so the CLI routes every tool prompt through Fleetify's WS dialog
    /// instead of stalling in headless mode. Storing the handler here is
    /// informational only — the actual lookup at prompt time happens via
    /// the AppState `permission_registry` keyed by `session_id`.
    pub permission_handler: Option<super::permission::PermissionHandler>,
    /// Disable the built-in AskUserQuestion (it can't render headlessly and its
    /// `--permission-prompt-tool` hook was removed in Claude Code 2.1.x) and
    /// route interactive questions to the in-process `ask_user` MCP tool
    /// (served by `fleet_permission`). Independent of `permission_handler` —
    /// staff agents ask the user too, with no per-tool approval dialog.
    pub ask_user_enabled: bool,
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
            effort: String::new(),
            model_name: None,
            session_title: None,
            system_prompt: None,
            session_mode: "new".into(),
            is_staff: false,
            agent_template: None,
            permission_handler: None,
            ask_user_enabled: false,
            child: Arc::new(Mutex::new(None)),
            aborted: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        }
    }

    /// Attach a Fleetify permission handler. The bridge then injects
    /// the `fleet_permission` stdio MCP into `--mcp-config` and passes
    /// `--permission-prompt-tool` so the CLI routes prompts through
    /// it. Builder shape matches Gemini/Codex bridges.
    pub fn with_permission_handler(
        mut self,
        handler: super::permission::PermissionHandler,
    ) -> Self {
        self.permission_handler = Some(handler);
        self
    }

    /// Faithful `_build_command`. `mcp_config_path`, when set, becomes
    /// `--mcp-config <path>` so the agent spawns the configured MCP
    /// servers alongside its built-in tools.
    ///
    /// Staff path (`is_staff = true`) maps to two extra flags faithful
    /// to `sdk_bridge.py:240-265`:
    ///   • `--allowedTools <names>` — constrain claude to `Agent`,
    ///     `WebSearch`, `WebFetch` + the `mcp__fleet_memory__*` names
    ///     (Python's `allowed = ["Agent","WebSearch","WebFetch"] + mcp_tool_names`).
    ///   • `--agents <json>` — register the 5 STAFF_SUBAGENTS so the
    ///     `Agent` tool can dispatch to `code-reviewer`, `bug-fixer`,
    ///     `test-writer`, `researcher`, `architect`.
    pub fn build_command(&self, message: &str, mcp_config_path: Option<&str>) -> Vec<String> {
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
        }
        if self.is_staff {
            // Whitelist Agent + research tools + the mounted mcp_memory
            // tool names. The dispatch token (`[[DISPATCH:id|task]]`) is
            // text-protocol — staff does NOT mount `fleet_dispatch`, so
            // its tool name is intentionally absent from this list.
            let mut allowed: Vec<String> =
                vec!["Agent".into(), "WebSearch".into(), "WebFetch".into()];
            for name in self.mcp_tool_names() {
                allowed.push(name.to_string());
            }
            c.push("--allowedTools".into());
            c.push(allowed.join(","));
            c.push("--agents".into());
            c.push(staff_subagents_json().to_string());
        }
        if let Some(path) = mcp_config_path {
            // `=` form prevents the claude CLI from variadic-slurping
            // subsequent positional args. `--mcp-config <configs...>`
            // would otherwise consume the trailing prompt as a second
            // MCP path (`C:\<cwd>\<message>` → "MCP config file not
            // found" error). Using `=` pins exactly one value.
            c.push(format!("--mcp-config={path}"));
        }
        match self.permission_mode.as_str() {
            "bypassPermissions" | "dangerouslySkipPermissions" => {
                c.push("--dangerously-skip-permissions".into())
            }
            "acceptEdits" => {
                c.push("--permission-mode".into());
                c.push("acceptEdits".into());
            }
            "plan" => {
                c.push("--permission-mode".into());
                c.push("plan".into());
            }
            _ => {}
        }
        // Point the CLI at the fleet_permission MCP tool in EVERY mode
        // (when a handler is wired + an mcp config exists). In default
        // mode every gated tool round-trips through the renderer dialog.
        // In bypass/acceptEdits the mode flag above auto-allows ordinary
        // tools so they never hit this tool — but `AskUserQuestion` CANNOT
        // run headlessly, so the CLI falls back to the permission tool for
        // it regardless of mode. That's our hook: the fleet_permission
        // loopback intercepts AskUserQuestion and returns the user's chosen
        // answer (see internal.rs::permission_prompt). Empirically verified
        // that `--dangerously-skip-permissions` + `--permission-prompt-tool`
        // coexist and only AskUserQuestion reaches the tool under bypass.
        if self.permission_handler.is_some() && mcp_config_path.is_some() {
            c.push("--permission-prompt-tool".into());
            c.push("mcp__fleet_permission__permission_prompt".into());
        }
        // Claude Code 2.1.x removed `--permission-prompt-tool` AND can't render
        // the built-in AskUserQuestion headlessly (it errors out). Disable it
        // and route the model to our in-process `ask_user` MCP tool, which
        // renders the interactive card in Fleetify and blocks for the answer.
        // Wired whenever fleet_permission is mounted — staff and non-staff alike.
        if self.ask_user_enabled && mcp_config_path.is_some() {
            c.push("--disallowedTools".into());
            c.push("AskUserQuestion".into());
            c.push("--append-system-prompt".into());
            c.push(
                "When you need the user to choose between options or clarify an \
                 ambiguous decision, call the `ask_user` tool \
                 (mcp__fleet_permission__ask_user) with a `questions` array (1-4 \
                 questions, each with question/header/options[label+description]). \
                 NEVER use AskUserQuestion — it is disabled here. `ask_user` renders \
                 an interactive card in the app and returns the user's selection."
                    .into(),
            );
        }
        if let Some(level) =
            effort_to_claude(&self.effort, self.model_name.as_deref().unwrap_or(""))
        {
            c.push("--effort".into());
            c.push(level.into());
        }
        c.push(message.to_string());
        c
    }

    /// Build a `--mcp-config` JSON blob for this spawn.
    ///
    /// Faithful with sdk_bridge.py: the user-facing
    /// `~/.fleetify/mcp_servers.json` registry stores ONLY the MCPs
    /// the user explicitly added (http/sse/stdio). The Fleet built-in
    /// stdio servers (`fleet_memory`, `fleet_dispatch`,
    /// `fleet_reveng`) are NEVER persisted there — they're spliced
    /// in-process here, per spawn, just like sdk_bridge.py wires them
    /// at session-create time. That keeps the renderer's MCP list
    /// clean (no auto-injected defaults the user can't remove) and
    /// matches the Python original byte-for-byte.
    ///
    /// Role / template gating, same as `sdk_bridge.py:294-357`:
    ///   • `fleet_memory`   — always mounted (staff + non-staff).
    ///   • `fleet_dispatch` — non-staff only.
    ///   • `fleet_reveng`   — only when `agent_template == "reverse_engineering"`.
    ///
    /// Per-server isolation around the splice: one malformed user
    /// entry can't drop the whole `mcpServers` map and turn every
    /// advertised tool name into a hallucination.
    pub fn build_mcp_config(&self) -> Option<serde_json::Value> {
        let mut map = crate::services::mcp_dispatch::build_merged_map(
            &self.session_id,
            self.is_staff,
            self.agent_template.as_deref(),
        );
        // Splice in fleet_permission whenever a handler is wired — in
        // ALL modes. Default mode uses it for every gated tool; bypass/
        // acceptEdits use it only as the fallback path for AskUserQuestion
        // (which can't run headlessly), so the interactive question card
        // works regardless of permission mode. The MCP is keyed by
        // FLEETIFY_SESSION_ID, so each spawn has its own prompt routing.
        // Also mount it for `ask_user_enabled` (staff orchestrator asks the
        // user without a per-tool permission dialog) — the same in-process
        // server advertises both `permission_prompt` and `ask_user`.
        if self.permission_handler.is_some() || self.ask_user_enabled {
            if let Some(cfg) = crate::services::mcp_dispatch::builtin_mcp_config(
                "fleet_permission",
                &self.session_id,
            ) {
                map.insert("fleet_permission".into(), cfg);
            }
        }
        tracing::info!(
            target: "claude",
            session_id = %self.session_id,
            is_staff = self.is_staff,
            agent_template = self.agent_template.as_deref().unwrap_or(""),
            mcp_mounted = ?map.keys().collect::<Vec<_>>(),
            "mcp_config built",
        );
        if map.is_empty() {
            return None;
        }
        let mut servers = serde_json::Map::new();
        for (k, v) in map {
            servers.insert(k, v);
        }
        Some(serde_json::json!({ "mcpServers": servers }))
    }

    /// Which `mcp__<server>__<tool>` names should this session's system
    /// prompt advertise? Drives a future `allowed_tools` whitelist (staff
    /// path) and is the canonical answer to "is the tool actually
    /// mounted?" — keeping this aligned with `build_mcp_config` is the
    /// fix for the "Searched the web for mcp__fleet_dispatch__…"
    /// fallback: if a tool name appears in the prompt but the MCP
    /// didn't mount, claude does ToolSearch.
    pub fn mcp_tool_names(&self) -> Vec<&'static str> {
        let mut names: Vec<&'static str> = vec![
            "mcp__fleet_memory__remember",
            "mcp__fleet_memory__recall",
            "mcp__fleet_memory__dump_session_memory",
        ];
        if self.ask_user_enabled {
            // Must be allow-listed so the model-facing interactive-question
            // tool doesn't hit a permission gate (the staff agent has no
            // dialog, so an un-allowed MCP call hard-fails with "not granted").
            names.push("mcp__fleet_permission__ask_user");
        }
        if !self.is_staff {
            names.push("mcp__fleet_dispatch__dispatch_to_agent");
        }
        if matches!(self.agent_template.as_deref(), Some("reverse_engineering")) {
            names.extend([
                "mcp__fleet_reveng__fetch_url",
                "mcp__fleet_reveng__discover_assets",
                "mcp__fleet_reveng__find_endpoints",
                "mcp__fleet_reveng__save_asset",
            ]);
        }
        names
    }

    /// Spawn + stream parsed events over an mpsc receiver (faithful
    /// `send_message`: status running → events → stderr-on-error → status done).
    pub async fn send_message(
        &self,
        message: &str,
        ctx: super::BridgeContext,
    ) -> anyhow::Result<tokio::sync::mpsc::Receiver<BridgeEvent>> {
        // Materialize the user's MCP registry to a temp file (when
        // non-empty) so claude spawns those servers alongside its
        // built-in tools. Leaks the temp file until the process exits
        // — claude CLI needs to read it after we return from spawn.
        // OS cleans up temp files at process exit; the leak is bounded
        // by per-turn invocations.
        let mcp_cfg_path: Option<String> = match self.build_mcp_config() {
            Some(value) => {
                let mut tmp = std::env::temp_dir();
                tmp.push(format!("fleetify-mcp-{}.json", uuid::Uuid::new_v4()));
                match std::fs::write(&tmp, value.to_string()) {
                    Ok(_) => Some(tmp.to_string_lossy().into_owned()),
                    Err(e) => {
                        tracing::warn!(target: "claude", "mcp_config write failed: {e}; running without MCPs");
                        None
                    }
                }
            }
            None => None,
        };
        let mut cmd = self.build_command(message, mcp_cfg_path.as_deref());
        // Self-heal an orphaned `--resume` target. If the stored Claude
        // conversation no longer exists on disk (cwd changed, `~/.claude`
        // cleared, or the id was persisted before its transcript was durably
        // written), `claude --resume <id>` hard-fails with "No conversation
        // found with session ID" and the turn produces nothing — and because
        // the turn fails, no fresh id replaces the stale one, so the session
        // stays wedged forever. Detect the missing transcript up front and
        // swap `--resume <id>` for `--continue`, which resumes the most-recent
        // conversation in this cwd (keeping context) instead of erroring. The
        // healed turn emits a valid session id via its init event, which
        // chat.rs persists over the stale one.
        if let Some(id) = self.claude_session_id.as_deref() {
            // Multi-account: when a `CLAUDE_CONFIG_DIR` override is active the
            // conversation must be checked under THAT account's config dir, not
            // the default `~/.claude` — otherwise a transcript that exists under
            // System looks present and `--resume` hard-fails in the other
            // account. When it's genuinely absent there, drop `--resume` (fresh
            // start in this account) rather than `--continue` (which would grab
            // an unrelated recent conversation from the other account).
            let claude_config_dir = ctx
                .account_env
                .iter()
                .find(|(k, _)| k == "CLAUDE_CONFIG_DIR")
                .map(|(_, v)| std::path::PathBuf::from(v));
            let (present, account_scoped) = match &claude_config_dir {
                Some(dir) => (
                    crate::services::claude_history::resume_conversation_exists_in(
                        dir,
                        &self.project_path,
                        id,
                    ),
                    true,
                ),
                None => (
                    crate::services::claude_history::resume_conversation_exists(
                        &self.project_path,
                        id,
                    ),
                    false,
                ),
            };
            if !present {
                if account_scoped {
                    tracing::warn!(
                        target: "fleetify::bridges::claude",
                        session = %self.session_id,
                        stale_claude_session_id = %id,
                        config_dir = ?claude_config_dir,
                        "claude resume target not in this account's config dir — starting fresh in the selected account"
                    );
                    cmd = drop_resume(cmd);
                } else {
                    tracing::warn!(
                        target: "fleetify::bridges::claude",
                        session = %self.session_id,
                        stale_claude_session_id = %id,
                        "claude resume target missing on disk — self-healing with --continue (context preserved)"
                    );
                    cmd = swap_resume_for_continue(cmd);
                }
            }
        }
        // Apply ctx.model_override by injecting `--model <m>` into the
        // argv. We append (rather than replace any pre-existing
        // `--model` produced by build_command) — claude CLI accepts a
        // repeated flag and uses the last value, so this gives the
        // routing override precedence over the bridge's default.
        if let Some(ref m) = ctx.model_override {
            cmd.push("--model".into());
            cmd.push(m.clone());
        }
        self.aborted
            .store(false, std::sync::atomic::Ordering::SeqCst);
        let cwd_raw = if self.project_path.is_empty() {
            std::env::var("USERPROFILE")
                .or_else(|_| std::env::var("HOME"))
                .unwrap_or_else(|_| ".".into())
        } else {
            self.project_path.clone()
        };
        // Strip Windows verbatim (`\\?\`) prefix defensively — same
        // rationale as bridges/gemini.rs (claude-code on Windows is
        // more tolerant than gemini-cli but PATH-resolution and
        // CLAUDE.md auto-discovery can still misbehave with `\\?\`).
        let cwd = fleetify_core::strip_verbatim_prefix(std::path::Path::new(&cwd_raw));

        let mut command = tokio::process::Command::new(&cmd[0]);
        command
            .args(&cmd[1..])
            .current_dir(&cwd)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        // Multi-account isolation: point HOME (and XDG/Windows equivalents) at
        // the selected account's private dir so `claude` reads that account's
        // `~/.claude` credentials. No-op for the System account.
        crate::bridges::account_env::apply_to_command(&mut command, &ctx.account_env);
        if let Some(ref url) = ctx.base_url_override {
            command.env("ANTHROPIC_BASE_URL", url);
        }
        // Forward proxy auth headers to claude-code via its
        // `ANTHROPIC_CUSTOM_HEADERS` env var (newline-separated
        // `Name: Value` pairs — claude-code attaches each one to its
        // outbound HTTP requests). This is what makes proxies like Weave
        // and LiteLLM work for Claude turns: their gateways inject an
        // auth header (`X-Weave-Router-Key`, `Authorization`) into
        // `ctx.extra_headers`, and routing those to the upstream is
        // the whole point of activating a proxy. Headers whose
        // name/value can't be rendered as a clean ASCII line are
        // skipped defensively (claude-code rejects the whole env if
        // it can't parse a line).
        let mut forwarded_header_names: Vec<String> = Vec::new();
        if !ctx.extra_headers.is_empty() {
            let mut lines: Vec<String> = Vec::new();
            for (name, value) in ctx.extra_headers.iter() {
                let Ok(v) = value.to_str() else { continue };
                if v.contains('\n') || v.contains('\r') {
                    continue;
                }
                lines.push(format!("{}: {}", name.as_str(), v));
                forwarded_header_names.push(name.as_str().to_string());
            }
            if !lines.is_empty() {
                command.env("ANTHROPIC_CUSTOM_HEADERS", lines.join("\n"));
            }
        }
        // One-line dispatch log so the user can grep `claude bridge spawn`
        // in their terminal and see exactly what got fired off: which model
        // claude-code will request, whether a proxy is in front of
        // Anthropic, and which auth headers the proxy attached. Header
        // VALUES are intentionally omitted — names only (sufficient to spot
        // a misnamed-header bug like the Weave `x-weave-auth` regression).
        tracing::info!(
            target: "fleetify::bridges::claude",
            session = %self.session_id,
            project = %self.project_path,
            model_override = ?ctx.model_override,
            base_url_override = ?ctx.base_url_override,
            proxy_headers = ?forwarded_header_names,
            "claude bridge spawn"
        );
        let mut child = command.spawn()?;
        let stdout = child.stdout.take().expect("piped stdout");
        let stderr = child.stderr.take();
        *self.child.lock().await = Some(child);

        let (tx, rx) = tokio::sync::mpsc::channel::<BridgeEvent>(256);
        let our_id = self.session_id.clone();
        let child_h = self.child.clone();
        let aborted = self.aborted.clone();

        tokio::spawn(async move {
            let _ = tx
                .send(BridgeEvent::Status {
                    status: "running".into(),
                })
                .await;
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
                        // Surface the raw stderr to the dev terminal so
                        // proxy / model / auth errors from claude-code are
                        // greppable. Truncated to 2 KiB to keep the log
                        // line readable when the upstream returns a huge
                        // JSON body (the renderer still gets the full
                        // string via BridgeEvent::Error for the user).
                        let preview = if t.len() > 2048 {
                            format!("{}…[truncated {}b]", &t[..2048], t.len() - 2048)
                        } else {
                            t.to_string()
                        };
                        tracing::error!(
                            target: "fleetify::bridges::claude",
                            exit_code = code.unwrap_or(-1),
                            "claude-code subprocess exited non-zero — stderr: {}",
                            preview
                        );
                        let _ = tx.send(BridgeEvent::Error { error: t.into() }).await;
                    } else {
                        tracing::warn!(
                            target: "fleetify::bridges::claude",
                            exit_code = code.unwrap_or(-1),
                            "claude-code subprocess exited non-zero with empty stderr"
                        );
                    }
                }
            }
            let _ = tx
                .send(BridgeEvent::Status {
                    status: "done".into(),
                })
                .await;
        });

        Ok(rx)
    }

    pub async fn abort(&self) {
        self.aborted
            .store(true, std::sync::atomic::Ordering::SeqCst);
        if let Some(c) = self.child.lock().await.as_mut() {
            let _ = c.start_kill();
        }
    }
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
    fn user_message_tool_result_emits_tool_end() {
        // Claude Code streams tool OUTPUTS back as a `user` message. Regression
        // guard: this arm was missing, so 23 tool_use blocks persisted with 0
        // tool_result blocks (cards showed commands, never their output).
        let mut st = ParseState::new("s");
        let evs = parse_event(
            &json!({"type":"user","message":{"role":"user","content":[
                {"type":"tool_result","tool_use_id":"t1",
                 "content":[{"type":"text","text":"file contents here"}]}]}}),
            &mut st,
        );
        assert_eq!(
            evs,
            vec![BridgeEvent::ToolEnd {
                tool_id: "t1".into(),
                output: "file contents here".into(),
                is_error: false,
            }]
        );
    }

    #[test]
    fn user_message_tool_result_string_content_and_error() {
        let mut st = ParseState::new("s");
        let evs = parse_event(
            &json!({"type":"user","message":{"content":[
                {"type":"tool_result","tool_use_id":"t2",
                 "content":"boom","is_error":true}]}}),
            &mut st,
        );
        assert_eq!(
            evs,
            vec![BridgeEvent::ToolEnd {
                tool_id: "t2".into(),
                output: "boom".into(),
                is_error: true,
            }]
        );
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
        assert_eq!(
            e1,
            vec![BridgeEvent::ToolStart {
                tool_id: "t1".into(),
                name: "Bash".into(),
                input: json!({})
            }]
        );
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
        assert_eq!(
            e3,
            vec![BridgeEvent::ToolUpdate {
                tool_id: "t1".into(),
                input: json!({"command":"ls"})
            }]
        );
        // Trailing assistant tool_use with SAME id+input → deduped (no event).
        let e4 = parse_event(
            &json!({"type":"assistant","message":{"content":[
                {"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls"}}]}}),
            &mut st,
        );
        assert!(
            e4.is_empty(),
            "duplicate tool_use must be suppressed: {e4:?}"
        );
    }

    #[test]
    fn streamed_text_suppresses_assistant_summary_text() {
        let mut st = ParseState::new("s");
        let d = parse_event(
            &json!({"type":"stream_event","event":{"type":"content_block_delta",
                "index":0,"delta":{"type":"text_delta","text":"Hello"}}}),
            &mut st,
        );
        assert_eq!(
            d,
            vec![BridgeEvent::MessageDelta {
                text: "Hello".into()
            }]
        );
        let a = parse_event(
            &json!({"type":"assistant","message":{"content":[
                {"type":"text","text":"Hello world"}]}}),
            &mut st,
        );
        assert!(
            a.is_empty(),
            "summary text must be suppressed after streaming"
        );
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
        assert_eq!(
            evs,
            vec![BridgeEvent::Cost {
                usage: json!({"input_tokens":10,"output_tokens":20,
                          "cache_read_tokens":5,"cache_write_tokens":3}),
                cost_usd: 0.0123,
                model: "claude-opus-4-7".into()
            }]
        );
    }

    #[test]
    fn build_command_is_faithful() {
        let mut b = ClaudeBridge::new("s", "/tmp/x");
        b.model_name = Some("claude-opus-4-7".into());
        b.permission_mode = "acceptEdits".into();
        let c = b.build_command("hi", None);
        assert_eq!(
            &c[..6],
            &[
                "claude",
                "-p",
                "--output-format",
                "stream-json",
                "--verbose",
                "--include-partial-messages"
            ]
        );
        assert!(c.windows(2).any(|w| w == ["--model", "claude-opus-4-7"]));
        assert!(c
            .windows(2)
            .any(|w| w == ["--permission-mode", "acceptEdits"]));
        assert_eq!(c.last().unwrap(), "hi");
    }

    #[test]
    fn swap_resume_for_continue_replaces_resume_pair() {
        let cmd = vec![
            "claude".to_string(),
            "--resume".to_string(),
            "ghost-id".to_string(),
            "--model".to_string(),
            "claude-opus-4-8".to_string(),
            "hi".to_string(),
        ];
        let healed = swap_resume_for_continue(cmd);
        // --resume and its orphaned id are gone; --continue took their place.
        assert!(!healed.iter().any(|a| a == "--resume"));
        assert!(!healed.iter().any(|a| a == "ghost-id"));
        assert!(healed.iter().any(|a| a == "--continue"));
        // Surrounding args + order preserved.
        assert_eq!(healed.first().unwrap(), "claude");
        assert_eq!(healed.last().unwrap(), "hi");
        assert!(healed
            .windows(2)
            .any(|w| w == ["--model", "claude-opus-4-8"]));
    }

    #[test]
    fn swap_resume_for_continue_noop_without_resume() {
        let cmd = vec![
            "claude".to_string(),
            "--continue".to_string(),
            "hi".to_string(),
        ];
        let out = swap_resume_for_continue(cmd.clone());
        assert_eq!(out, cmd);
    }

    #[test]
    fn build_command_passes_mcp_config_path_through() {
        let b = ClaudeBridge::new("s", "/tmp/x");
        let c = b.build_command("hi", Some("/tmp/mcp.json"));
        // `=` form prevents the claude CLI's variadic --mcp-config
        // <configs...> from slurping the trailing prompt as a second
        // MCP path. See the comment in build_command itself.
        assert!(c.iter().any(|a| a == "--mcp-config=/tmp/mcp.json"));
        assert!(
            !c.iter().any(|a| a == "--mcp-config"),
            "must NOT use space-separated form which slurps positional message"
        );
        // Message is still the last arg even when --mcp-config is set.
        assert_eq!(c.last().unwrap(), "hi");
    }

    #[test]
    fn build_command_staff_emits_constrained_tools_and_subagents() {
        let mut b = ClaudeBridge::new("s", "/tmp/x");
        b.is_staff = true;
        b.system_prompt = Some("you are fleet".into());
        let c = b.build_command("hi", None);

        // --system-prompt is set without the prior `--tools ""` pair.
        assert!(c
            .windows(2)
            .any(|w| w == ["--system-prompt", "you are fleet"]));
        assert!(!c.windows(2).any(|w| w[0] == "--tools" && w[1].is_empty()));

        // --allowedTools constrains to Agent + research + mcp_memory.
        let idx = c
            .iter()
            .position(|s| s == "--allowedTools")
            .expect("--allowedTools");
        let names = &c[idx + 1];
        assert!(names.contains("Agent"));
        assert!(names.contains("WebSearch"));
        assert!(names.contains("WebFetch"));
        assert!(names.contains("mcp__fleet_memory__recall"));
        // Staff path must NOT advertise fleet_dispatch — staff uses the
        // [[DISPATCH:]] text protocol instead. Mounting the tool name
        // here would re-introduce the "Searched the web for select:
        // mcp__fleet_dispatch__dispatch_to_agent" symptom.
        assert!(!names.contains("mcp__fleet_dispatch__"));

        // --agents JSON registers the 5 named subagents.
        let aidx = c.iter().position(|s| s == "--agents").expect("--agents");
        let agents_json: serde_json::Value = serde_json::from_str(&c[aidx + 1]).unwrap();
        for name in [
            "code-reviewer",
            "bug-fixer",
            "test-writer",
            "researcher",
            "architect",
        ] {
            assert!(agents_json.get(name).is_some(), "missing subagent: {name}");
        }
    }

    #[test]
    fn build_command_non_staff_has_no_tool_restriction() {
        let b = ClaudeBridge::new("s", "/tmp/x");
        let c = b.build_command("hi", None);
        assert!(!c.iter().any(|s| s == "--allowedTools"));
        assert!(!c.iter().any(|s| s == "--agents"));
    }

    #[test]
    fn permission_handler_in_default_mode_emits_prompt_tool_flag() {
        // With handler attached + default mode + an mcp config path,
        // the CLI gets `--permission-prompt-tool mcp__fleet_permission__permission_prompt`
        // so claude calls the fleet MCP instead of stalling on its
        // interactive prompt.
        let handler: super::super::permission::PermissionHandler =
            std::sync::Arc::new(|_n, _i| Box::pin(async { false }));
        let b = ClaudeBridge::new("s", "/tmp/x").with_permission_handler(handler);
        let c = b.build_command("hi", Some("/tmp/mcp.json"));
        assert!(c.windows(2).any(|w| w
            == [
                "--permission-prompt-tool",
                "mcp__fleet_permission__permission_prompt"
            ]));
    }

    #[test]
    fn no_handler_means_no_prompt_tool_flag() {
        // The flag must NOT appear when no handler is wired — claude
        // would otherwise fail with "MCP tool not found".
        let b = ClaudeBridge::new("s", "/tmp/x");
        let c = b.build_command("hi", Some("/tmp/mcp.json"));
        assert!(!c.iter().any(|a| a == "--permission-prompt-tool"));
    }

    #[test]
    fn ask_user_enabled_disables_builtin_and_allowlists_ask_user() {
        // With ask_user_enabled + an mcp config path, the CLI must DISABLE the
        // built-in AskUserQuestion (it can't render headlessly in 2.1.x) and
        // the allow-list must include the model-facing ask_user MCP tool so it
        // doesn't hit a permission gate.
        let mut b = ClaudeBridge::new("s", "/tmp/x");
        b.ask_user_enabled = true;
        let c = b.build_command("hi", Some("/tmp/mcp.json"));
        assert!(
            c.windows(2)
                .any(|w| w == ["--disallowedTools", "AskUserQuestion"]),
            "ask_user_enabled must disable the built-in AskUserQuestion"
        );
        assert!(
            c.iter().any(|a| a == "--append-system-prompt"),
            "must inject the ask_user usage instruction"
        );
        assert!(
            b.mcp_tool_names()
                .contains(&"mcp__fleet_permission__ask_user"),
            "ask_user tool must be allow-listed"
        );
    }

    #[test]
    fn no_ask_user_leaves_builtin_ask_question_untouched() {
        let b = ClaudeBridge::new("s", "/tmp/x");
        let c = b.build_command("hi", Some("/tmp/mcp.json"));
        assert!(!c.iter().any(|a| a == "AskUserQuestion"));
        assert!(!b
            .mcp_tool_names()
            .contains(&"mcp__fleet_permission__ask_user"));
    }

    #[test]
    fn permission_handler_in_accept_edits_mode_still_emits_prompt_tool_flag() {
        // acceptEdits auto-allows edits via the CLI's `--permission-mode`
        // flag, but the fleet_permission tool is STILL mounted so the
        // AskUserQuestion fallback path works (and non-edit tools can
        // round-trip through the renderer dialog).
        let handler: super::super::permission::PermissionHandler =
            std::sync::Arc::new(|_n, _i| Box::pin(async { false }));
        let mut b = ClaudeBridge::new("s", "/tmp/x").with_permission_handler(handler);
        b.permission_mode = "acceptEdits".into();
        let c = b.build_command("hi", Some("/tmp/mcp.json"));
        assert!(c.iter().any(|a| a == "--permission-mode"));
        assert!(c.windows(2).any(|w| w
            == [
                "--permission-prompt-tool",
                "mcp__fleet_permission__permission_prompt"
            ]));
    }

    #[test]
    fn permission_handler_in_bypass_mode_still_emits_prompt_tool_flag() {
        // Bypass auto-allows ordinary tools, but AskUserQuestion can't run
        // headlessly so the CLI falls back to fleet_permission for it.
        // Verified empirically that --dangerously-skip-permissions and
        // --permission-prompt-tool coexist; the tool is only hit for
        // AskUserQuestion under bypass.
        let handler: super::super::permission::PermissionHandler =
            std::sync::Arc::new(|_n, _i| Box::pin(async { false }));
        let mut b = ClaudeBridge::new("s", "/tmp/x").with_permission_handler(handler);
        b.permission_mode = "bypassPermissions".into();
        let c = b.build_command("hi", Some("/tmp/mcp.json"));
        assert!(c.iter().any(|a| a == "--dangerously-skip-permissions"));
        assert!(c.windows(2).any(|w| w
            == [
                "--permission-prompt-tool",
                "mcp__fleet_permission__permission_prompt"
            ]));
    }

    #[test]
    fn build_mcp_config_splices_fleet_permission_in_default_mode() {
        let handler: super::super::permission::PermissionHandler =
            std::sync::Arc::new(|_n, _i| Box::pin(async { false }));
        let b = ClaudeBridge::new("s", "/tmp/x").with_permission_handler(handler);
        let cfg = b.build_mcp_config().expect("mcp config must exist");
        let servers = cfg.get("mcpServers").and_then(|v| v.as_object()).unwrap();
        assert!(servers.contains_key("fleet_permission"));
    }

    #[test]
    fn build_mcp_config_splices_fleet_permission_in_bypass_mode_too() {
        // fleet_permission is now mounted in ALL modes so the
        // AskUserQuestion fallback works under bypass.
        let handler: super::super::permission::PermissionHandler =
            std::sync::Arc::new(|_n, _i| Box::pin(async { false }));
        let mut b = ClaudeBridge::new("s", "/tmp/x").with_permission_handler(handler);
        b.permission_mode = "bypassPermissions".into();
        let cfg = b.build_mcp_config().expect("mcp config must exist");
        let servers = cfg.get("mcpServers").and_then(|v| v.as_object()).unwrap();
        assert!(servers.contains_key("fleet_permission"));
    }

    #[test]
    fn mcp_tool_names_align_with_role_and_template() {
        // Non-staff baseline: memory + dispatch.
        let b = ClaudeBridge::new("s", "/tmp/x");
        let names = b.mcp_tool_names();
        assert!(names.contains(&"mcp__fleet_memory__recall"));
        assert!(names.contains(&"mcp__fleet_dispatch__dispatch_to_agent"));
        assert!(!names.contains(&"mcp__fleet_reveng__fetch_url"));

        // Staff: memory only.
        let mut s = ClaudeBridge::new("s", "/tmp/x");
        s.is_staff = true;
        let names = s.mcp_tool_names();
        assert!(names.contains(&"mcp__fleet_memory__recall"));
        assert!(!names.contains(&"mcp__fleet_dispatch__dispatch_to_agent"));

        // Reverse-engineering template adds reveng tools to non-staff.
        let mut r = ClaudeBridge::new("s", "/tmp/x");
        r.agent_template = Some("reverse_engineering".into());
        let names = r.mcp_tool_names();
        assert!(names.contains(&"mcp__fleet_reveng__fetch_url"));
        assert!(names.contains(&"mcp__fleet_reveng__discover_assets"));
    }

    #[test]
    fn effort_to_claude_maps_fleet_vocab() {
        assert_eq!(effort_to_claude("low", "claude-opus-4-8"), Some("low"));
        assert_eq!(
            effort_to_claude("extra_high", "claude-opus-4-8"),
            Some("xhigh")
        );
        assert_eq!(effort_to_claude("max", "claude-opus-4-8"), Some("max"));
        // Sonnet lacks xhigh but Claude Code auto-falls-back, so we still pass it.
        assert_eq!(
            effort_to_claude("extra_high", "claude-sonnet-4-6"),
            Some("xhigh")
        );
        // Haiku has no effort lever.
        assert_eq!(effort_to_claude("high", "claude-haiku-4-5"), None);
        // Empty / unknown → omit the flag.
        assert_eq!(effort_to_claude("", "claude-opus-4-8"), None);
        assert_eq!(effort_to_claude("bogus", "claude-opus-4-8"), None);
    }

    #[test]
    fn build_command_includes_effort_flag() {
        let mut b = ClaudeBridge::new("s", "/tmp/x");
        b.model_name = Some("claude-opus-4-8".into());
        b.effort = "high".into();
        let c = b.build_command("hi", None);
        assert!(c.windows(2).any(|w| w == ["--effort", "high"]));
    }

    #[test]
    fn build_command_omits_effort_when_unset() {
        let mut b = ClaudeBridge::new("s", "/tmp/x");
        b.model_name = Some("claude-opus-4-8".into());
        let c = b.build_command("hi", None);
        assert!(!c.iter().any(|a| a == "--effort"));
    }

    #[test]
    fn build_command_plan_mode_sets_permission_mode_plan() {
        let mut b = ClaudeBridge::new("s", "/tmp/x");
        b.permission_mode = "plan".into();
        let c = b.build_command("hi", None);
        assert!(c.windows(2).any(|w| w == ["--permission-mode", "plan"]));
    }
}
