//! `fleet-memory-mcp` — stdio MCP server that exposes `remember` and
//! `recall` tools to a Claude / Gemini / Codex session. The session
//! reaches Fleet's session_memory store via this server's REST proxy
//! to the embedded backend on `127.0.0.1:8765`.
//!
//! Faithful subset of `services/memory_mcp.py`.
//!
//! Wire format: line-delimited JSON-RPC 2.0 on stdin/stdout. Bearer
//! and session context come from env (set by the bridge at spawn):
//!
//!   FLEETIFY_SESSION_ID    — the session this MCP belongs to
//!   FLEETIFY_PROJECT_PATH  — project_path for memory scoping
//!   FLEETIFY_BEARER        — Fleetify access token for REST calls
//!   FLEETIFY_BACKEND_URL   — defaults to http://127.0.0.1:8765
//!
//! Tools:
//!   remember(title: string, content: string, kind?: string)
//!   recall(query?: string, limit?: number)

use std::io::Write;

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
            break; // EOF
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
    let id = msg.get("id").cloned();
    let method = msg.get("method").and_then(|v| v.as_str()).unwrap_or("");
    let params = msg
        .get("params")
        .cloned()
        .unwrap_or(Value::Object(Default::default()));

    // Notifications (no id) — we silently accept everything and reply
    // nothing.
    id.as_ref()?;
    let id = id.unwrap();

    match method {
        "initialize" => Some(json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": {
                "protocolVersion": "2024-11-05",
                "capabilities": { "tools": { "listChanged": false } },
                "serverInfo": { "name": "fleet-memory-mcp", "version": env!("CARGO_PKG_VERSION") }
            }
        })),
        "tools/list" => Some(json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": {
                "tools": tools_list()
            }
        })),
        "tools/call" => {
            let name = params.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let args = params
                .get("arguments")
                .cloned()
                .unwrap_or(Value::Object(Default::default()));
            let result = match name {
                "remember" => remember(args).await,
                "recall" => recall(args).await,
                other => Err(format!("unknown tool: {other}")),
            };
            Some(match result {
                Ok(v) => json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": {
                        "content": [{ "type": "text", "text": v.to_string() }],
                        "isError": false
                    }
                }),
                Err(e) => json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": {
                        "content": [{ "type": "text", "text": e }],
                        "isError": true
                    }
                }),
            })
        }
        _ => Some(json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": -32601, "message": format!("method not handled: {method}") }
        })),
    }
}

fn tools_list() -> Value {
    json!([
        {
            "name": "remember",
            "description": "Save a curated note / decision / learning to Fleet's long-term memory for this project. Survives across sessions for the same project_path so a fresh agent inherits prior context.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "title":   { "type": "string", "description": "Short one-sentence title (≤ 12 words)." },
                    "content": { "type": "string", "description": "1-3 sentence detail." },
                    "kind":    { "type": "string", "enum": ["decision", "learning", "gotcha", "plan", "note"], "default": "note" }
                },
                "required": ["title", "content"]
            }
        },
        {
            "name": "recall",
            "description": "Search Fleet's memory for items relevant to a query. Returns up to `limit` items ordered by recency.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Free-text search." },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 50, "default": 10 }
                }
            }
        }
    ])
}

fn env_or(k: &str, default: &str) -> String {
    std::env::var(k).unwrap_or_else(|_| default.to_string())
}

async fn remember(args: Value) -> Result<Value, String> {
    let session_id = std::env::var("FLEETIFY_SESSION_ID")
        .map_err(|_| "FLEETIFY_SESSION_ID env var missing".to_string())?;
    let bearer = std::env::var("FLEETIFY_BEARER")
        .map_err(|_| "FLEETIFY_BEARER env var missing".to_string())?;
    let backend = env_or("FLEETIFY_BACKEND_URL", "http://127.0.0.1:8765");
    let title = args.get("title").and_then(|v| v.as_str()).unwrap_or("");
    let content = args.get("content").and_then(|v| v.as_str()).unwrap_or("");
    let kind = args.get("kind").and_then(|v| v.as_str()).unwrap_or("note");
    if title.is_empty() || content.is_empty() {
        return Err("title and content are required".into());
    }
    let url = format!("{backend}/api/sessions/{session_id}/memory");
    let r = reqwest::Client::new()
        .post(&url)
        .bearer_auth(&bearer)
        .json(&json!({ "title": title, "content": content, "kind": kind }))
        .send()
        .await
        .map_err(|e| format!("POST {url} failed: {e}"))?;
    if !r.status().is_success() {
        return Err(format!("POST {url} returned {}", r.status().as_u16()));
    }
    Ok(json!({ "ok": true, "kind": kind, "title": title }))
}

async fn recall(args: Value) -> Result<Value, String> {
    let session_id = std::env::var("FLEETIFY_SESSION_ID")
        .map_err(|_| "FLEETIFY_SESSION_ID env var missing".to_string())?;
    let bearer = std::env::var("FLEETIFY_BEARER")
        .map_err(|_| "FLEETIFY_BEARER env var missing".to_string())?;
    let backend = env_or("FLEETIFY_BACKEND_URL", "http://127.0.0.1:8765");
    let limit = args
        .get("limit")
        .and_then(|v| v.as_i64())
        .unwrap_or(10)
        .clamp(1, 50);
    let url = format!("{backend}/api/sessions/{session_id}/memory?limit={limit}");
    let r = reqwest::Client::new()
        .get(&url)
        .bearer_auth(&bearer)
        .send()
        .await
        .map_err(|e| format!("GET {url} failed: {e}"))?;
    if !r.status().is_success() {
        return Err(format!("GET {url} returned {}", r.status().as_u16()));
    }
    let body: Value = r.json().await.map_err(|e| format!("decode failed: {e}"))?;
    // Optional client-side filter by query — the backend's memory
    // endpoint doesn't support full-text search natively (Phase 4
    // follow-up), so we do a simple substring filter.
    let query = args
        .get("query")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_lowercase();
    if query.is_empty() {
        return Ok(body);
    }
    if let Some(arr) = body.as_array() {
        let filtered: Vec<Value> = arr
            .iter()
            .filter(|v| {
                let hay = format!(
                    "{}\n{}\n{}",
                    v.get("title").and_then(|x| x.as_str()).unwrap_or(""),
                    v.get("content").and_then(|x| x.as_str()).unwrap_or(""),
                    v.get("kind").and_then(|x| x.as_str()).unwrap_or("")
                )
                .to_lowercase();
                hay.contains(&query)
            })
            .cloned()
            .collect();
        return Ok(Value::Array(filtered));
    }
    Ok(body)
}

// Allow `Write` import used by the stdout flush path — silences an
// unused-import warning in some configurations.
fn _ensure_write_in_scope() {
    let _ = std::io::stdout().lock().write(b"");
}
