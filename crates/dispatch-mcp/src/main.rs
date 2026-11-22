//! `fleet-dispatch-mcp` — stdio MCP server letting an agent route a
//! sub-task to another fleet agent without going back to the user.
//! Faithful port of `services/dispatch_mcp.py`.
//!
//! Wire format: line-delimited JSON-RPC 2.0 on stdin/stdout. Same
//! shape as fleet-memory-mcp.
//!
//! Env (set by ClaudeBridge::build_mcp_config at spawn):
//!   FLEETIFY_SESSION_ID       — caller session id (used for rate-
//!                                limit keying + self-dispatch refuse)
//!   FLEETIFY_INTERNAL_SECRET  — loopback secret shared with the
//!                                in-process backend; authenticates
//!                                the dispatch POST without exposing
//!                                the user's JWT to a subprocess.
//!   FLEETIFY_BACKEND_URL      — defaults to http://127.0.0.1:8765
//!
//! Tool exposed:
//!   dispatch_to_agent(agent: <uuid|name>, task: <string>)
//!
//! Safety:
//!   - Per-session rate limit: max 5 dispatches per 60 s.
//!   - Self-dispatch (caller == target) refused.
//!   - Target resolved by EXACT UUID or case-insensitive name. No
//!     partial match (avoids mis-routing in fleets with similar names).

// Agent CLIs start this server with its standard streams piped, and not all of
// them stop Windows from opening a console window for a console program. A
// GUI-subsystem program gets no console, and this one needs none: it uses only
// the standard streams it inherits (Rust reads a missing one as end of input
// and drops what is written to it).
#![cfg_attr(windows, windows_subsystem = "windows")]

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use anyhow::Result;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

const RATE_WINDOW: Duration = Duration::from_secs(60);
const RATE_MAX: usize = 5;

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<()> {
    let mut stdin = BufReader::new(tokio::io::stdin());
    let mut stdout = tokio::io::stdout();
    let mut line = String::new();
    loop {
        line.clear();
        let n = stdin.read_line(&mut line).await?;
        if n == 0 {
            break;
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let msg: Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if let Some(reply) = handle(msg).await {
            let mut buf = serde_json::to_vec(&reply)?;
            buf.push(b'\n');
            stdout.write_all(&buf).await?;
            stdout.flush().await?;
        }
    }
    Ok(())
}

async fn handle(msg: Value) -> Option<Value> {
    let id = msg.get("id").cloned()?;
    let method = msg.get("method").and_then(|v| v.as_str()).unwrap_or("");
    let params = msg
        .get("params")
        .cloned()
        .unwrap_or(Value::Object(Default::default()));

    match method {
        "initialize" => Some(json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": {
                "protocolVersion": "2024-11-05",
                "capabilities": { "tools": { "listChanged": false } },
                "serverInfo": { "name": "fleet-dispatch-mcp", "version": env!("CARGO_PKG_VERSION") }
            }
        })),
        "tools/list" => Some(json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": {
                "tools": [{
                    "name": "dispatch_to_agent",
                    "description": "Send a task to another fleet agent and continue your own work. Use when you've identified a sub-task that another agent is better positioned to handle (different project, different specialty, different angle). The target agent runs the task in the background; you do NOT wait for the result. Rate-limited to 5 dispatches per minute. Cannot dispatch to yourself.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "agent": { "type": "string", "description": "Exact UUID or case-insensitive title of the target agent." },
                            "task":  { "type": "string", "description": "Task description for the target. Be specific — the agent only sees this string, not your context." }
                        },
                        "required": ["agent", "task"]
                    }
                },
                {
                    "name": "spawn_agent",
                    "description": "Create a NEW fleet agent (a fresh session) for a project, configured with a provider, model, and permission mode. Use when no existing agent fits and you need to stand one up. Returns the new session_id, which you can then dispatch_to_agent. The spawned agent cannot exceed YOUR permission level. Optional fields are inferred server-side (best available provider, its default model).",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "project_path":    { "type": "string", "description": "Absolute path of the project folder the agent works in. Required." },
                            "task":            { "type": "string", "description": "Optional first task — if set, the agent starts working on it immediately; if omitted, it is created idle for a later dispatch_to_agent." },
                            "title":           { "type": "string", "description": "Short agent name, e.g. \"code-reviewer\"." },
                            "tool":            { "type": "string", "description": "Provider id, e.g. \"claude\", \"openai\", \"gemini\". Omit to auto-pick the best available." },
                            "model":           { "type": "string", "description": "Model hint, e.g. \"opus 4.8\" — canonicalised server-side. Omit for the provider's default model." },
                            "permission_mode": { "type": "string", "description": "\"default\" | \"acceptEdits\" | \"plan\" | \"bypassPermissions\". Clamped to your own level." },
                            "agent_template":  { "type": "string", "description": "Optional builtin template id, e.g. \"reverse_engineering\"." },
                            "use_worktree":    { "type": "boolean", "description": "Git worktree isolation. Default false (work directly in the folder); set true only when isolation is explicitly needed." }
                        },
                        "required": ["project_path"]
                    }
                }]
            }
        })),
        "tools/call" => {
            let name = params.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let args = params
                .get("arguments")
                .cloned()
                .unwrap_or(Value::Object(Default::default()));
            let result = match name {
                "dispatch_to_agent" => dispatch_to_agent(args).await,
                "spawn_agent" => spawn_agent(args).await,
                other => Err(format!("unknown tool: {other}")),
            };
            Some(match result {
                Ok(v) => json!({
                    "jsonrpc": "2.0", "id": id,
                    "result": {
                        "content": [{ "type": "text", "text": v.to_string() }],
                        "isError": false
                    }
                }),
                Err(e) => json!({
                    "jsonrpc": "2.0", "id": id,
                    "result": {
                        "content": [{ "type": "text", "text": e }],
                        "isError": true
                    }
                }),
            })
        }
        _ => Some(json!({
            "jsonrpc": "2.0", "id": id,
            "error": { "code": -32601, "message": format!("method not handled: {method}") }
        })),
    }
}

fn env_or(k: &str, default: &str) -> String {
    std::env::var(k).unwrap_or_else(|_| default.to_string())
}

/// The client for calls to the backend: never through a proxy, which would
/// see the internal secret (`fleetify_core::loopback`).
fn backend_client() -> Result<reqwest::Client, String> {
    fleetify_core::loopback::http_client_builder()
        .build()
        .map_err(|e| format!("HTTP client: {e}"))
}

fn check_rate(session_id: &str) -> Result<(), String> {
    static LOG: std::sync::OnceLock<Mutex<HashMap<String, Vec<Instant>>>> =
        std::sync::OnceLock::new();
    let log = LOG.get_or_init(|| Mutex::new(HashMap::new()));
    let mut g = log.lock().unwrap();
    let entry = g.entry(session_id.to_string()).or_default();
    let now = Instant::now();
    entry.retain(|t| now.duration_since(*t) < RATE_WINDOW);
    if entry.len() >= RATE_MAX {
        return Err(format!(
            "rate-limited: {RATE_MAX} dispatches per {}s",
            RATE_WINDOW.as_secs()
        ));
    }
    entry.push(now);
    Ok(())
}

async fn dispatch_to_agent(args: Value) -> Result<Value, String> {
    let caller = std::env::var("FLEETIFY_SESSION_ID")
        .map_err(|_| "FLEETIFY_SESSION_ID env var missing".to_string())?;
    let secret = std::env::var("FLEETIFY_INTERNAL_SECRET")
        .map_err(|_| "FLEETIFY_INTERNAL_SECRET env var missing".to_string())?;
    let backend = env_or("FLEETIFY_BACKEND_URL", "http://127.0.0.1:8765");

    let agent_ref = args
        .get("agent")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let task = args
        .get("task")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if agent_ref.is_empty() || task.is_empty() {
        return Err("agent and task are required".into());
    }
    check_rate(&caller)?;

    // Single round-trip to the loopback dispatch endpoint. The
    // backend resolves agent_ref (UUID or title), ownership-checks,
    // refuses self-dispatch, persists the target user message, and
    // spawns the bridge run. Result events flow back to the caller's
    // chat via the SessionManager fanout (the caller is treated as
    // the "staff" here for routing purposes).
    let url = format!("{backend}/api/internal/dispatch");
    let r = backend_client()?
        .post(&url)
        .header("X-Fleet-Internal", &secret)
        .json(&json!({
            "caller_session_id": caller,
            "agent": agent_ref,
            "task": task,
        }))
        .send()
        .await
        .map_err(|e| format!("POST /api/internal/dispatch failed: {e}"))?;
    let status = r.status();
    if !status.is_success() {
        let body = r.text().await.unwrap_or_default();
        return Err(format!(
            "/api/internal/dispatch returned {}: {}",
            status.as_u16(),
            body.trim()
        ));
    }
    let v: Value = r
        .json()
        .await
        .map_err(|e| format!("decode dispatch response failed: {e}"))?;
    Ok(v)
}

/// Create a new fleet agent via the loopback `/api/internal/spawn`. The
/// backend resolves the semi-structured args (provider/model/permission hints),
/// enforces the permission clamp, and returns the new session_id. Rate-limited
/// with the same 5/60s window as dispatch to throttle spawn loops.
async fn spawn_agent(args: Value) -> Result<Value, String> {
    let caller = std::env::var("FLEETIFY_SESSION_ID")
        .map_err(|_| "FLEETIFY_SESSION_ID env var missing".to_string())?;
    let secret = std::env::var("FLEETIFY_INTERNAL_SECRET")
        .map_err(|_| "FLEETIFY_INTERNAL_SECRET env var missing".to_string())?;
    let backend = env_or("FLEETIFY_BACKEND_URL", "http://127.0.0.1:8765");

    let project = args
        .get("project_path")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    if project.is_empty() {
        return Err("project_path is required".into());
    }
    check_rate(&caller)?;

    // Forward the caller id + whatever optional hints were provided. The
    // backend does all resolution/validation/clamping.
    let mut body = serde_json::Map::new();
    body.insert("caller_session_id".into(), json!(caller));
    for key in [
        "project_path",
        "title",
        "tool",
        "model",
        "permission_mode",
        "agent_template",
        "task",
        "use_worktree",
    ] {
        if let Some(v) = args.get(key) {
            body.insert(key.into(), v.clone());
        }
    }

    let url = format!("{backend}/api/internal/spawn");
    let r = backend_client()?
        .post(&url)
        .header("X-Fleet-Internal", &secret)
        .json(&Value::Object(body))
        .send()
        .await
        .map_err(|e| format!("POST /api/internal/spawn failed: {e}"))?;
    let status = r.status();
    if !status.is_success() {
        let body = r.text().await.unwrap_or_default();
        return Err(format!(
            "/api/internal/spawn returned {}: {}",
            status.as_u16(),
            body.trim()
        ));
    }
    r.json::<Value>()
        .await
        .map_err(|e| format!("decode spawn response failed: {e}"))
}
