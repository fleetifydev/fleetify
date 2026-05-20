//! `fleet-reveng-mcp` — stdio MCP server with reverse-engineering
//! toolkit. Phase-2 cut: `fetch_url` + `save_asset`. The HTML / JS
//! parsing tools (`discover_assets`, `find_endpoints`) follow.
//!
//! Faithful subset of `services/reveng_mcp.py`.
//!
//! Env:
//!   FLEETIFY_PROJECT_PATH — root dir for save_asset writes
//!   FLEETIFY_SESSION_ID   — informational, not used for routing here

use std::io::Write as _;
use std::path::PathBuf;
use std::time::Duration;

use anyhow::Result;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

const MAX_BODY: usize = 2_000_000; // 2 MB ceiling on fetched body bytes
const FETCH_TIMEOUT: Duration = Duration::from_secs(15);

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
            "jsonrpc": "2.0", "id": id,
            "result": {
                "protocolVersion": "2024-11-05",
                "capabilities": { "tools": { "listChanged": false } },
                "serverInfo": { "name": "fleet-reveng-mcp", "version": env!("CARGO_PKG_VERSION") }
            }
        })),
        "tools/list" => Some(json!({
            "jsonrpc": "2.0", "id": id,
            "result": { "tools": tools_list() }
        })),
        "tools/call" => {
            let name = params.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let args = params
                .get("arguments")
                .cloned()
                .unwrap_or(Value::Object(Default::default()));
            let result = match name {
                "fetch_url" => fetch_url(args).await,
                "save_asset" => save_asset(args).await,
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

fn tools_list() -> Value {
    json!([
        {
            "name": "fetch_url",
            "description": "Fetch a URL with a browser-like User-Agent and return the body (truncated at 2 MB) + status + headers. Use for inspecting web assets during reverse-engineering.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "url":     { "type": "string", "description": "Absolute URL to fetch." },
                    "method":  { "type": "string", "enum": ["GET", "POST"], "default": "GET" },
                    "headers": { "type": "object", "description": "Optional request headers (string → string map)." },
                    "body":    { "type": "string", "description": "Optional request body (string)." }
                },
                "required": ["url"]
            }
        },
        {
            "name": "save_asset",
            "description": "Write a discovered asset to disk under <project>/.fleetify/reveng-assets/. Returns the absolute path.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "filename": { "type": "string", "description": "Relative filename (no path separators)." },
                    "content":  { "type": "string", "description": "File content. Binary callers should base64-encode and set encoding='base64'." },
                    "encoding": { "type": "string", "enum": ["utf-8", "base64"], "default": "utf-8" }
                },
                "required": ["filename", "content"]
            }
        }
    ])
}

async fn fetch_url(args: Value) -> Result<Value, String> {
    let url = args.get("url").and_then(|v| v.as_str()).unwrap_or("");
    if url.is_empty() {
        return Err("url is required".into());
    }
    let method = args
        .get("method")
        .and_then(|v| v.as_str())
        .unwrap_or("GET")
        .to_uppercase();
    let body = args
        .get("body")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let headers = args.get("headers").and_then(|v| v.as_object()).cloned();

    let client = reqwest::Client::builder()
        .timeout(FETCH_TIMEOUT)
        .user_agent("Mozilla/5.0 (compatible; FleetifyReverseEngineerBot/0.1)")
        .build()
        .map_err(|e| e.to_string())?;
    let mut req = match method.as_str() {
        "GET" => client.get(url),
        "POST" => client.post(url).body(body),
        m => return Err(format!("unsupported method: {m}")),
    };
    if let Some(h) = headers {
        for (k, v) in h {
            if let Some(s) = v.as_str() {
                req = req.header(&k, s);
            }
        }
    }
    let r = req.send().await.map_err(|e| format!("fetch failed: {e}"))?;
    let status = r.status().as_u16();
    let mut hdrs = serde_json::Map::new();
    for (k, v) in r.headers() {
        if let Ok(s) = v.to_str() {
            hdrs.insert(k.to_string(), Value::String(s.to_string()));
        }
    }
    let bytes = r.bytes().await.map_err(|e| format!("read body: {e}"))?;
    let truncated = bytes.len() > MAX_BODY;
    let body_str = if truncated {
        String::from_utf8_lossy(&bytes[..MAX_BODY]).into_owned()
    } else {
        String::from_utf8_lossy(&bytes).into_owned()
    };
    Ok(json!({
        "status": status,
        "headers": Value::Object(hdrs),
        "body": body_str,
        "truncated": truncated,
        "bytes": bytes.len(),
    }))
}

async fn save_asset(args: Value) -> Result<Value, String> {
    use base64::Engine;
    let filename = args
        .get("filename")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if filename.is_empty()
        || filename.contains('/')
        || filename.contains('\\')
        || filename.contains("..")
    {
        return Err("filename must be a leaf name (no separators or '..')".into());
    }
    let content = args
        .get("content")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let encoding = args
        .get("encoding")
        .and_then(|v| v.as_str())
        .unwrap_or("utf-8")
        .to_string();
    let project = std::env::var("FLEETIFY_PROJECT_PATH")
        .map_err(|_| "FLEETIFY_PROJECT_PATH env var missing".to_string())?;
    let dir = PathBuf::from(project).join(".fleetify").join("reveng-assets");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(&filename);
    let bytes: Vec<u8> = match encoding.as_str() {
        "utf-8" => content.into_bytes(),
        "base64" => base64::engine::general_purpose::STANDARD
            .decode(content.trim())
            .map_err(|e| format!("base64 decode: {e}"))?,
        other => return Err(format!("unsupported encoding: {other}")),
    };
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(json!({
        "path": path.to_string_lossy(),
        "bytes": std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0),
    }))
}

// Allow Write import — only used inside `tokio::io::AsyncWriteExt` paths
// when `stdout` flushing.
fn _ensure_write_in_scope() {
    let _ = std::io::stdout().lock().write(b"");
}

// (base64 is a direct dep — pinned in Cargo.toml. No marker needed.)
