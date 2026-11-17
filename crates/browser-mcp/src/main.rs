//! `fleet-browser-mcp` — thin stdio MCP server. It exposes the browser
//! tools to the agent but owns NO browser of its own: each tool call is
//! forwarded to the backend's shared browser service
//! (`POST /api/internal/browser/action`), so the agent and the user's
//! Browser panel drive the SAME page. Mirrors the memory-mcp pattern
//! (sidecar = thin client of the backend).
//!
//! Env:
//!   FLEETIFY_BACKEND_URL     — backend base (default http://127.0.0.1:8765)
//!   FLEETIFY_INTERNAL_SECRET — loopback auth for the action endpoint

use std::time::Duration;

use anyhow::Result;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

const ACTION_TIMEOUT: Duration = Duration::from_secs(60);

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
            "jsonrpc": "2.0", "id": id,
            "result": {
                "protocolVersion": "2024-11-05",
                "capabilities": { "tools": { "listChanged": false } },
                "serverInfo": { "name": "fleet-browser-mcp", "version": env!("CARGO_PKG_VERSION") }
            }
        })),
        "tools/list" => Some(json!({
            "jsonrpc": "2.0", "id": id,
            "result": { "tools": tools_list() }
        })),
        "tools/call" => {
            let name = params
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let args = params
                .get("arguments")
                .cloned()
                .unwrap_or(Value::Object(Default::default()));
            let result = call_action(&name, args).await;
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

/// Forward one tool call to the backend's shared browser.
async fn call_action(name: &str, args: Value) -> Result<Value, String> {
    let backend =
        std::env::var("FLEETIFY_BACKEND_URL").unwrap_or_else(|_| "http://127.0.0.1:8765".into());
    let secret = std::env::var("FLEETIFY_INTERNAL_SECRET").unwrap_or_default();
    // Never through a proxy, which would see the internal secret
    // (fleetify_core::loopback).
    let client = fleetify_core::loopback::http_client_builder()
        .build()
        .map_err(|e| format!("HTTP client: {e}"))?;
    let resp = client
        .post(format!("{backend}/api/internal/browser/action"))
        .header("x-fleet-internal", secret)
        .json(&json!({ "name": name, "args": args }))
        .timeout(ACTION_TIMEOUT)
        .send()
        .await
        .map_err(|e| format!("browser backend unreachable: {e}"))?;
    let v: Value = resp
        .json()
        .await
        .map_err(|e| format!("bad browser response: {e}"))?;
    if v.get("ok").and_then(|b| b.as_bool()).unwrap_or(false) {
        Ok(v.get("result").cloned().unwrap_or(Value::Null))
    } else {
        Err(v
            .get("error")
            .and_then(|e| e.as_str())
            .unwrap_or("browser action failed")
            .to_string())
    }
}

fn tools_list() -> Value {
    json!([
        {
            "name": "navigate",
            "description": "Navigate the shared browser to a URL and wait for load. Returns the final URL + page title.",
            "inputSchema": {
                "type": "object",
                "properties": { "url": { "type": "string", "description": "Absolute URL to open." } },
                "required": ["url"]
            }
        },
        {
            "name": "read_page",
            "description": "Read the current page as visible text (default) or raw HTML, capped at 40k chars.",
            "inputSchema": {
                "type": "object",
                "properties": { "format": { "type": "string", "enum": ["text", "html"], "default": "text" } }
            }
        },
        {
            "name": "click",
            "description": "Click the first element matching a CSS selector on the current page.",
            "inputSchema": {
                "type": "object",
                "properties": { "selector": { "type": "string", "description": "CSS selector to click." } },
                "required": ["selector"]
            }
        },
        {
            "name": "fill",
            "description": "Focus an input matching a CSS selector and type a value into it.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "selector": { "type": "string", "description": "CSS selector of the input." },
                    "value": { "type": "string", "description": "Text to type." }
                },
                "required": ["selector", "value"]
            }
        },
        {
            "name": "inspect",
            "description": "Inspect the first element matching a CSS selector: selector path, XPath, bounding box, key attributes, curated computed styles, and React/Vue component + dev source file when detectable.",
            "inputSchema": {
                "type": "object",
                "properties": { "selector": { "type": "string", "description": "CSS selector of the element to inspect." } },
                "required": ["selector"]
            }
        },
        {
            "name": "back",
            "description": "Go back one entry in the browser history.",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "forward",
            "description": "Go forward one entry in the browser history.",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "reload",
            "description": "Reload the current page.",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "screenshot",
            "description": "Capture a PNG screenshot of the current viewport (base64).",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "eval",
            "description": "Evaluate a JavaScript expression in the page and return its JSON-serialisable result.",
            "inputSchema": {
                "type": "object",
                "properties": { "script": { "type": "string", "description": "JS expression to evaluate." } },
                "required": ["script"]
            }
        }
    ])
}
