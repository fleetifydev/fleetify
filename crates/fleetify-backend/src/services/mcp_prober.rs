//! MCP server prober — spawn an MCP server (stdio / http / sse) and
//! call `tools/list` to enumerate its tools. Phase-4 subset of
//! `services/mcp_prober.py`.
//!
//! MCP wire protocol = JSON-RPC 2.0:
//!   → `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{...}}`
//!   ← `{"jsonrpc":"2.0","id":1,"result":{...}}`
//!   → `{"jsonrpc":"2.0","method":"notifications/initialized"}`   (notification, no id)
//!   → `{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}`
//!   ← `{"jsonrpc":"2.0","id":2,"result":{"tools":[...]}}`
//!
//! Phase-4 cut covers stdio servers only (http/sse Phase 4 follow-up).
//! Returns the typed `ProbeResult` envelope the renderer's MCP page
//! already reads.

use std::time::Duration;

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

const INIT_TIMEOUT: Duration = Duration::from_secs(15);
const TOOLS_LIST_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolDescriptor {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_schema: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProbeResult {
    pub name: String,
    pub status: String, // "ok" | "error" | "unsupported"
    pub tool_count: usize,
    pub tools: Vec<ToolDescriptor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth_hint: Option<String>,
    pub probed_at: String,
}

fn now_rfc() -> String {
    chrono::Utc::now().to_rfc3339()
}

/// Probe one MCP server config. `name` is the registry key (used for
/// log breadcrumbs + return envelope). `config` is the JSON value the
/// user supplied via /api/mcp/servers — same shape Claude / Gemini /
/// Codex consume from their respective configs.
pub async fn probe(name: &str, config: &Value) -> ProbeResult {
    let kind = config
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or("stdio");
    match kind {
        "stdio" => probe_stdio(name, config).await,
        "http" | "sse" => ProbeResult {
            name: name.into(),
            status: "unsupported".into(),
            tool_count: 0,
            tools: Vec::new(),
            error: Some("http / sse MCP probe not implemented yet (Phase 4 follow-up)".to_string()),
            auth_hint: None,
            probed_at: now_rfc(),
        },
        other => ProbeResult {
            name: name.into(),
            status: "error".into(),
            tool_count: 0,
            tools: Vec::new(),
            error: Some(format!("unknown MCP type: {other}")),
            auth_hint: None,
            probed_at: now_rfc(),
        },
    }
}

async fn probe_stdio(name: &str, config: &Value) -> ProbeResult {
    let command = config
        .get("command")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if command.is_empty() {
        return ProbeResult {
            name: name.into(),
            status: "error".into(),
            tool_count: 0,
            tools: Vec::new(),
            error: Some("stdio MCP missing `command`".into()),
            auth_hint: None,
            probed_at: now_rfc(),
        };
    }
    let args: Vec<String> = config
        .get("args")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    let env_pairs: Vec<(String, String)> = config
        .get("env")
        .and_then(|v| v.as_object())
        .map(|m| {
            m.iter()
                .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                .collect()
        })
        .unwrap_or_default();

    let mut cmd = tokio::process::Command::new(command);
    cmd.args(&args)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    for (k, v) in &env_pairs {
        cmd.env(k, v);
    }
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            return ProbeResult {
                name: name.into(),
                status: "error".into(),
                tool_count: 0,
                tools: Vec::new(),
                error: Some(format!("spawn failed: {e}")),
                auth_hint: None,
                probed_at: now_rfc(),
            };
        }
    };

    let stdin = match child.stdin.take() {
        Some(s) => s,
        None => {
            let _ = child.kill().await;
            return ProbeResult {
                name: name.into(),
                status: "error".into(),
                tool_count: 0,
                tools: Vec::new(),
                error: Some("no stdin pipe on MCP subprocess".into()),
                auth_hint: None,
                probed_at: now_rfc(),
            };
        }
    };
    let stdout = match child.stdout.take() {
        Some(s) => s,
        None => {
            let _ = child.kill().await;
            return ProbeResult {
                name: name.into(),
                status: "error".into(),
                tool_count: 0,
                tools: Vec::new(),
                error: Some("no stdout pipe on MCP subprocess".into()),
                auth_hint: None,
                probed_at: now_rfc(),
            };
        }
    };

    let result = handshake_and_list_tools(stdin, stdout).await;
    let _ = child.kill().await;
    match result {
        Ok(tools) => ProbeResult {
            name: name.into(),
            status: "ok".into(),
            tool_count: tools.len(),
            tools,
            error: None,
            auth_hint: None,
            probed_at: now_rfc(),
        },
        Err(e) => ProbeResult {
            name: name.into(),
            status: "error".into(),
            tool_count: 0,
            tools: Vec::new(),
            error: Some(e.to_string()),
            auth_hint: None,
            probed_at: now_rfc(),
        },
    }
}

async fn handshake_and_list_tools(
    stdin: tokio::process::ChildStdin,
    stdout: tokio::process::ChildStdout,
) -> Result<Vec<ToolDescriptor>> {
    let mut writer = stdin;
    let mut reader = BufReader::new(stdout);

    // 1. initialize → expect a result envelope back.
    write_frame(
        &mut writer,
        &json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": { "name": "fleetify-prober", "version": "0.1.0" }
            }
        }),
    )
    .await?;
    let init_resp = tokio::time::timeout(INIT_TIMEOUT, read_next_response(&mut reader, 1))
        .await
        .map_err(|_| anyhow!("initialize timed out"))??;
    if init_resp.get("error").is_some() {
        return Err(anyhow!(
            "initialize returned error: {}",
            init_resp["error"]["message"].as_str().unwrap_or("?")
        ));
    }

    // 2. notifications/initialized — fire-and-forget notification.
    write_frame(
        &mut writer,
        &json!({
            "jsonrpc": "2.0",
            "method": "notifications/initialized"
        }),
    )
    .await?;

    // 3. tools/list → expect `{ tools: [...] }`.
    write_frame(
        &mut writer,
        &json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/list",
            "params": {}
        }),
    )
    .await?;
    let list_resp =
        tokio::time::timeout(TOOLS_LIST_TIMEOUT, read_next_response(&mut reader, 2))
            .await
            .map_err(|_| anyhow!("tools/list timed out"))??;
    if let Some(err) = list_resp.get("error") {
        return Err(anyhow!(
            "tools/list returned error: {}",
            err.get("message").and_then(|v| v.as_str()).unwrap_or("?")
        ));
    }
    let tools_arr = list_resp
        .get("result")
        .and_then(|r| r.get("tools"))
        .and_then(|t| t.as_array())
        .cloned()
        .unwrap_or_default();
    let tools: Vec<ToolDescriptor> = tools_arr
        .into_iter()
        .filter_map(|t| {
            let obj = t.as_object()?;
            let name = obj.get("name").and_then(|v| v.as_str())?.to_string();
            Some(ToolDescriptor {
                name,
                description: obj
                    .get("description")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                input_schema: obj.get("inputSchema").cloned(),
            })
        })
        .collect();
    Ok(tools)
}

async fn write_frame<W: AsyncWriteExt + Unpin>(w: &mut W, frame: &Value) -> Result<()> {
    let mut buf = serde_json::to_vec(frame)?;
    buf.push(b'\n');
    w.write_all(&buf).await?;
    w.flush().await?;
    Ok(())
}

/// Read inbound frames until one with matching id arrives. Notifications
/// (no id) are ignored. Returns the first response whose id equals
/// `expected_id`.
async fn read_next_response<R: AsyncBufReadExt + Unpin>(
    r: &mut R,
    expected_id: i64,
) -> Result<Value> {
    let mut line = String::new();
    loop {
        line.clear();
        let n = r.read_line(&mut line).await?;
        if n == 0 {
            return Err(anyhow!("MCP server closed stdout before response"));
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let msg: Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if let Some(id) = msg.get("id").and_then(|v| v.as_i64()) {
            if id == expected_id {
                return Ok(msg);
            }
        }
        // Notifications & unrelated responses: keep reading.
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn probe_missing_command_returns_error_envelope() {
        let r = probe("badname", &json!({ "type": "stdio" })).await;
        assert_eq!(r.status, "error");
        assert_eq!(r.tool_count, 0);
        assert!(r.error.unwrap().contains("missing `command`"));
    }

    #[tokio::test]
    async fn probe_http_kind_reports_unsupported() {
        let r = probe(
            "remote",
            &json!({ "type": "http", "url": "https://example.com/mcp" }),
        )
        .await;
        assert_eq!(r.status, "unsupported");
        assert!(r.error.unwrap().contains("not implemented"));
    }

    #[tokio::test]
    async fn probe_unknown_kind_reports_error() {
        let r = probe("weird", &json!({ "type": "smtp" })).await;
        assert_eq!(r.status, "error");
        assert!(r.error.unwrap().contains("unknown MCP type"));
    }
}
