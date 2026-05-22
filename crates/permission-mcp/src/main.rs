//! `fleet-permission-mcp` — stdio MCP server that surfaces a single
//! `permission_prompt` tool, wired into Claude CLI via
//! `--permission-prompt-tool mcp__fleet_permission__permission_prompt`.
//!
//! The Tauri build drives Claude through the raw `claude` subprocess
//! (no Rust SDK), so the SDK's `can_use_tool` callback isn't available.
//! Anthropic's documented hook for headless Claude permission prompts
//! is exactly this: spawn a stdio MCP that exposes a tool with the
//! canonical input/output contract; Claude calls it once per tool use
//! and obeys the returned `behavior`. See:
//!   https://docs.anthropic.com/.../permission-prompts
//!
//! Wire format: line-delimited JSON-RPC 2.0 on stdin/stdout (same as
//! `fleet-dispatch-mcp` / `fleet-memory-mcp`).
//!
//! Env (set by `ClaudeBridge::build_mcp_config` at spawn):
//!   FLEETIFY_SESSION_ID       — caller session id; the backend uses
//!                               this to look up the in-process
//!                               `PermissionSession` (and the WS that
//!                               will surface the prompt to the user).
//!   FLEETIFY_INTERNAL_SECRET  — loopback secret authenticating the
//!                               POST without exposing the user's JWT.
//!   FLEETIFY_BACKEND_URL      — defaults to http://127.0.0.1:8765.
//!
//! Tool exposed:
//!   permission_prompt(tool_name: str, input: object) -> { behavior, ... }
//!     The Claude CLI invokes this tool with the candidate tool name +
//!     its input. We POST to `/api/internal/permission_prompt`; the
//!     backend runs the same round-trip Codex/Gemini already use
//!     (PermissionSession → WS → renderer dialog → permission_response)
//!     and returns the user's decision. We translate to the response
//!     shape claude expects.

use anyhow::Result;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

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
                "serverInfo": { "name": "fleet-permission-mcp", "version": env!("CARGO_PKG_VERSION") }
            }
        })),
        "tools/list" => Some(json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": {
                "tools": [{
                    "name": "permission_prompt",
                    "description": "Internal — invoked by Claude CLI via --permission-prompt-tool. Surfaces a per-tool approval prompt to the Fleetify user and returns allow/deny. Not meant for the model to call directly.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "tool_name": { "type": "string" },
                            "input":     { "type": "object" }
                        },
                        "required": ["tool_name", "input"]
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
            if name != "permission_prompt" {
                return Some(json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": {
                        "content": [{ "type": "text", "text": format!("unknown tool: {name}") }],
                        "isError": true
                    }
                }));
            }
            // Claude's `permission_prompt` contract expects the tool to
            // return its decision as a JSON-stringified payload in the
            // first text content block. The shape is:
            //   { "behavior": "allow", "updatedInput": {...} }     # approved
            //   { "behavior": "deny",  "message": "<reason>" }     # denied
            // (Anthropic docs — Claude CLI permission-prompt-tool.)
            let decision_payload = match call_backend(args).await {
                Ok(v) => v,
                Err(e) => json!({
                    "behavior": "deny",
                    "message": format!("permission backend error: {e}"),
                }),
            };
            Some(json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": {
                    "content": [{
                        "type": "text",
                        "text": decision_payload.to_string()
                    }],
                    "isError": false
                }
            }))
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

/// Single round-trip to the loopback permission endpoint. Returns the
/// JSON value that should be embedded verbatim as the tool's text
/// content (claude parses it and applies the decision).
async fn call_backend(args: Value) -> Result<Value, String> {
    let caller = std::env::var("FLEETIFY_SESSION_ID")
        .map_err(|_| "FLEETIFY_SESSION_ID env var missing".to_string())?;
    let secret = std::env::var("FLEETIFY_INTERNAL_SECRET")
        .map_err(|_| "FLEETIFY_INTERNAL_SECRET env var missing".to_string())?;
    let backend = env_or("FLEETIFY_BACKEND_URL", "http://127.0.0.1:8765");

    let tool_name = args
        .get("tool_name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let tool_input = args
        .get("input")
        .cloned()
        .unwrap_or(Value::Object(Default::default()));
    if tool_name.is_empty() {
        return Err("tool_name is required".into());
    }

    let url = format!("{backend}/api/internal/permission_prompt");
    let r = reqwest::Client::new()
        .post(&url)
        .header("X-Fleet-Internal", &secret)
        .json(&json!({
            "caller_session_id": caller,
            "tool_name": tool_name,
            "input": tool_input,
        }))
        .send()
        .await
        .map_err(|e| format!("POST /api/internal/permission_prompt failed: {e}"))?;
    let status = r.status();
    if !status.is_success() {
        let body = r.text().await.unwrap_or_default();
        return Err(format!(
            "/api/internal/permission_prompt returned {}: {}",
            status.as_u16(),
            body.trim()
        ));
    }
    r.json::<Value>()
        .await
        .map_err(|e| format!("decode permission response failed: {e}"))
}
