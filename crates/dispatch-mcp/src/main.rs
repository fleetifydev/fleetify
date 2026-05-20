//! `fleet-dispatch-mcp` — stdio MCP server letting an agent route a
//! sub-task to another fleet agent without going back to the user.
//! Faithful port of `services/dispatch_mcp.py`.
//!
//! Wire format: line-delimited JSON-RPC 2.0 on stdin/stdout. Same
//! shape as fleet-memory-mcp.
//!
//! Env (set by the bridge at spawn):
//!   FLEETIFY_SESSION_ID    — caller session id (used for rate-limit
//!                            keying + self-dispatch prevention)
//!   FLEETIFY_BEARER        — Fleetify access token
//!   FLEETIFY_BACKEND_URL   — defaults to http://127.0.0.1:8765
//!
//! Tool exposed:
//!   dispatch_to_agent(agent: <uuid|name>, task: <string>)
//!
//! Safety:
//!   - Per-session rate limit: max 5 dispatches per 60 s.
//!   - Self-dispatch (caller == target) refused.
//!   - Target resolved by EXACT UUID or case-insensitive name. No
//!     partial match (avoids mis-routing in fleets with similar names).

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use anyhow::Result;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

const RATE_WINDOW: Duration = Duration::from_secs(60);
const RATE_MAX: usize = 5;

#[tokio::main]
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
                }]
            }
        })),
        "tools/call" => {
            let name = params.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let args = params
                .get("arguments")
                .cloned()
                .unwrap_or(Value::Object(Default::default()));
            if name != "dispatch_to_agent" {
                return Some(json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": {
                        "content": [{ "type": "text", "text": format!("unknown tool: {name}") }],
                        "isError": true
                    }
                }));
            }
            let result = dispatch_to_agent(args).await;
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
    let bearer = std::env::var("FLEETIFY_BEARER")
        .map_err(|_| "FLEETIFY_BEARER env var missing".to_string())?;
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

    // Resolve agent_ref → session_id via the local /api/sessions list.
    // Match by exact UUID first, then by case-insensitive title.
    let url = format!("{backend}/api/sessions");
    let r = reqwest::Client::new()
        .get(&url)
        .bearer_auth(&bearer)
        .send()
        .await
        .map_err(|e| format!("GET /sessions failed: {e}"))?;
    if !r.status().is_success() {
        return Err(format!("GET /sessions returned {}", r.status().as_u16()));
    }
    let sessions: Value = r
        .json()
        .await
        .map_err(|e| format!("decode /sessions failed: {e}"))?;
    let arr = sessions.as_array().ok_or("non-array sessions response")?;
    let lower_ref = agent_ref.to_lowercase();
    let target_id = arr
        .iter()
        .find_map(|s| {
            let id = s.get("id").and_then(|v| v.as_str())?;
            let title = s.get("title").and_then(|v| v.as_str()).unwrap_or("");
            if id == agent_ref || title.to_lowercase() == lower_ref {
                Some(id.to_string())
            } else {
                None
            }
        })
        .ok_or_else(|| format!("no session matches {agent_ref:?}"))?;
    if target_id == caller {
        return Err("cannot dispatch to self".into());
    }

    // Inject the task as a user message into the target session via the
    // local messages POST endpoint.
    let msg_url = format!("{backend}/api/sessions/{target_id}/messages");
    let r = reqwest::Client::new()
        .post(&msg_url)
        .bearer_auth(&bearer)
        .json(&json!({
            "role": "user",
            "content": [{ "type": "text", "text": task }]
        }))
        .send()
        .await
        .map_err(|e| format!("POST messages failed: {e}"))?;
    if !r.status().is_success() {
        return Err(format!(
            "POST messages returned {}",
            r.status().as_u16()
        ));
    }
    Ok(json!({
        "ok": true,
        "target_session_id": target_id,
        "task_dispatched": task,
    }))
}
