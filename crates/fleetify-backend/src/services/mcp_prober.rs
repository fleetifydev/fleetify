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
const HTTP_TIMEOUT: Duration = Duration::from_secs(8);

/// Shared HTTP client so repeated probes reuse the connection pool and
/// TLS session cache (the Tier-2 background loop re-probes on an interval).
fn http_client() -> &'static reqwest::Client {
    static C: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    C.get_or_init(reqwest::Client::new)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolDescriptor {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_schema: Option<Value>,
}

/// Canonical MCP status — serializes to exactly the tokens the
/// renderer's status pill (`mcp-card.tsx`) and composer dot
/// (`chat-input.tsx`) consume. Single source of truth: the backend
/// emits these; the store passes them straight through.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum McpStatus {
    Connected,  // "connected"
    AuthNeeded, // "auth_needed"
    Failed,     // "failed"
    Checking,   // "checking"
    Unknown,    // "unknown"
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProbeResult {
    pub name: String,
    /// Canonical status token consumed by the renderer's status pill.
    pub status: McpStatus,
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

/// Decide status for a NON-2xx HTTP probe response. 401/403 (or any
/// response carrying a `WWW-Authenticate` challenge) means the server
/// is reachable but unauthenticated → AuthNeeded (yellow). Everything
/// else is a hard failure (red). The `www_authenticate` header value,
/// when present, becomes the auth_hint (and is the Tier-3 discovery
/// entry point).
pub(crate) fn classify_http(
    status: u16,
    www_authenticate: Option<&str>,
) -> (McpStatus, Option<String>) {
    if status == 401 || status == 403 || www_authenticate.is_some() {
        return (
            McpStatus::AuthNeeded,
            www_authenticate.map(|s| s.to_string()),
        );
    }
    (McpStatus::Failed, None)
}

/// Probe an http/sse MCP server over Streamable HTTP: POST a JSON-RPC
/// `initialize`, then `tools/list`. `config` is expected to already
/// carry any `Authorization` header (spliced by the caller). Auth
/// failures surface as AuthNeeded; network/other failures as Failed.
async fn probe_http(name: &str, config: &Value) -> ProbeResult {
    let fail = |msg: String, status: McpStatus, hint: Option<String>| ProbeResult {
        name: name.into(),
        status,
        tool_count: 0,
        tools: Vec::new(),
        error: if matches!(status, McpStatus::Failed) {
            Some(msg)
        } else {
            None
        },
        auth_hint: hint,
        probed_at: now_rfc(),
    };

    let url = match config.get("url").and_then(|v| v.as_str()) {
        Some(u) if !u.is_empty() => u.to_string(),
        _ => return fail("http/sse MCP missing `url`".into(), McpStatus::Failed, None),
    };
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert(
        reqwest::header::ACCEPT,
        reqwest::header::HeaderValue::from_static("application/json, text/event-stream"),
    );
    if let Some(obj) = config.get("headers").and_then(|h| h.as_object()) {
        for (k, v) in obj {
            let hname = match reqwest::header::HeaderName::from_bytes(k.as_bytes()) {
                Ok(n) => n,
                Err(_) => {
                    return fail(
                        format!("invalid header name in config: {k:?}"),
                        McpStatus::Failed,
                        None,
                    )
                }
            };
            let hval = match v
                .as_str()
                .and_then(|s| s.parse::<reqwest::header::HeaderValue>().ok())
            {
                Some(val) => val,
                None => {
                    return fail(
                        format!("invalid header value for {k:?}"),
                        McpStatus::Failed,
                        None,
                    )
                }
            };
            headers.insert(hname, hval);
        }
    }
    let client = http_client();
    let init = json!({
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": { "protocolVersion": "2024-11-05", "capabilities": {},
                    "clientInfo": { "name": "fleetify-prober", "version": "0.1.0" } }
    });
    let resp = match client
        .post(&url)
        .headers(headers.clone())
        .json(&init)
        .timeout(HTTP_TIMEOUT)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => return fail(format!("connect failed: {e}"), McpStatus::Failed, None),
    };
    if !resp.status().is_success() {
        let code = resp.status().as_u16();
        let www = resp
            .headers()
            .get("WWW-Authenticate")
            .and_then(|v| v.to_str().ok())
            .map(String::from);
        let (st, hint) = classify_http(code, www.as_deref());
        return fail(format!("initialize returned HTTP {code}"), st, hint);
    }
    let body = match resp.text().await {
        Ok(b) => b,
        Err(e) => {
            return fail(
                format!("initialize: body read failed: {e}"),
                McpStatus::Failed,
                None,
            )
        }
    };
    let init_val = match parse_jsonrpc_body(&body) {
        Some(v) => v,
        None => {
            return fail(
                "initialize: unparseable response".into(),
                McpStatus::Failed,
                None,
            )
        }
    };
    if init_val.get("error").is_some() {
        return fail(
            format!(
                "initialize error: {}",
                init_val["error"]["message"].as_str().unwrap_or("?")
            ),
            McpStatus::Failed,
            None,
        );
    }
    // tools/list (best-effort: connected even if it fails, with 0 tools)
    let list = json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {} });
    let tools: Vec<ToolDescriptor> = match client
        .post(&url)
        .headers(headers)
        .json(&list)
        .timeout(HTTP_TIMEOUT)
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => {
            let b = r.text().await.unwrap_or_default();
            parse_jsonrpc_body(&b)
                .and_then(|v| {
                    v.get("result")
                        .and_then(|x| x.get("tools"))
                        .and_then(|t| t.as_array())
                        .cloned()
                })
                .unwrap_or_default()
                .into_iter()
                .filter_map(|t| {
                    let o = t.as_object()?;
                    Some(ToolDescriptor {
                        name: o.get("name").and_then(|v| v.as_str())?.to_string(),
                        description: o
                            .get("description")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string(),
                        input_schema: o.get("inputSchema").cloned(),
                    })
                })
                .collect()
        }
        _ => Vec::new(),
    };
    ProbeResult {
        name: name.into(),
        status: McpStatus::Connected,
        tool_count: tools.len(),
        tools,
        error: None,
        auth_hint: None,
        probed_at: now_rfc(),
    }
}

/// Extract the first JSON object from either a plain JSON body or an
/// SSE frame (`data: {...}`). MCP Streamable HTTP may answer either.
fn parse_jsonrpc_body(body: &str) -> Option<Value> {
    if let Ok(v) = serde_json::from_str::<Value>(body.trim()) {
        return Some(v);
    }
    for line in body.lines() {
        if let Some(rest) = line.trim().strip_prefix("data:") {
            if let Ok(v) = serde_json::from_str::<Value>(rest.trim()) {
                return Some(v);
            }
        }
    }
    None
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
        "http" | "sse" => probe_http(name, config).await,
        other => ProbeResult {
            name: name.into(),
            status: McpStatus::Failed,
            tool_count: 0,
            tools: Vec::new(),
            error: Some(format!("unknown MCP type: {other}")),
            auth_hint: None,
            probed_at: now_rfc(),
        },
    }
}

async fn probe_stdio(name: &str, config: &Value) -> ProbeResult {
    let command = config.get("command").and_then(|v| v.as_str()).unwrap_or("");
    if command.is_empty() {
        return ProbeResult {
            name: name.into(),
            status: McpStatus::Failed,
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
                status: McpStatus::Failed,
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
                status: McpStatus::Failed,
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
                status: McpStatus::Failed,
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
            status: McpStatus::Connected,
            tool_count: tools.len(),
            tools,
            error: None,
            auth_hint: None,
            probed_at: now_rfc(),
        },
        Err(e) => ProbeResult {
            name: name.into(),
            status: McpStatus::Failed,
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
    let list_resp = tokio::time::timeout(TOOLS_LIST_TIMEOUT, read_next_response(&mut reader, 2))
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
    async fn probe_missing_command_returns_failed() {
        let r = probe("badname", &json!({ "type": "stdio" })).await;
        assert_eq!(r.status, McpStatus::Failed);
        assert_eq!(r.tool_count, 0);
        assert!(r.error.unwrap().contains("missing `command`"));
    }

    #[tokio::test]
    async fn probe_unknown_kind_reports_failed() {
        let r = probe("weird", &json!({ "type": "smtp" })).await;
        assert_eq!(r.status, McpStatus::Failed);
        assert!(r.error.unwrap().contains("unknown MCP type"));
    }

    // --- classify_http unit tests ---

    #[test]
    fn classify_http_401_is_auth_needed() {
        let (st, hint) = classify_http(
            401,
            Some("Bearer resource_metadata=\"https://srv/.well-known/oauth-protected-resource\""),
        );
        assert_eq!(st, McpStatus::AuthNeeded);
        assert!(hint.unwrap().contains("oauth-protected-resource"));
    }

    #[test]
    fn classify_http_403_is_auth_needed() {
        let (st, _) = classify_http(403, None);
        assert_eq!(st, McpStatus::AuthNeeded);
    }

    #[test]
    fn classify_http_500_is_failed() {
        let (st, _) = classify_http(500, None);
        assert_eq!(st, McpStatus::Failed);
    }

    // --- probe_http wiremock integration tests ---

    #[tokio::test]
    async fn probe_http_connected_lists_tools() {
        use wiremock::matchers::{body_partial_json, method};
        use wiremock::{Mock, MockServer, ResponseTemplate};
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(body_partial_json(json!({"method":"initialize"})))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05","capabilities":{}}
            })))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(body_partial_json(json!({"method":"tools/list"})))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"foo","description":"d"}]}
            })))
            .mount(&server)
            .await;
        let r = probe("remote", &json!({ "type":"http", "url": server.uri() })).await;
        assert_eq!(r.status, McpStatus::Connected);
        assert_eq!(r.tool_count, 1);
        assert_eq!(r.tools[0].name, "foo");
    }

    #[tokio::test]
    async fn probe_http_401_is_auth_needed() {
        use wiremock::matchers::method;
        use wiremock::{Mock, MockServer, ResponseTemplate};
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(401).insert_header(
                "WWW-Authenticate",
                "Bearer resource_metadata=\"https://x/.well-known/oauth-protected-resource\"",
            ))
            .mount(&server)
            .await;
        let r = probe("remote", &json!({ "type":"http", "url": server.uri() })).await;
        assert_eq!(r.status, McpStatus::AuthNeeded);
        assert!(r.auth_hint.unwrap().contains("oauth-protected-resource"));
    }

    #[tokio::test]
    async fn probe_http_500_is_failed() {
        use wiremock::matchers::method;
        use wiremock::{Mock, MockServer, ResponseTemplate};
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(500))
            .mount(&server)
            .await;
        let r = probe("remote", &json!({ "type":"http", "url": server.uri() })).await;
        assert_eq!(r.status, McpStatus::Failed);
    }

    #[tokio::test]
    async fn probe_http_403_without_challenge_has_no_hint() {
        use wiremock::matchers::method;
        use wiremock::{Mock, MockServer, ResponseTemplate};
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(403))
            .mount(&server)
            .await;
        let r = probe("remote", &json!({ "type":"http", "url": server.uri() })).await;
        assert_eq!(r.status, McpStatus::AuthNeeded);
        assert!(r.auth_hint.is_none());
    }

    #[test]
    fn parse_jsonrpc_body_reads_sse_data_frame() {
        let body = "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":7,\"result\":{}}\n\n";
        let v = parse_jsonrpc_body(body).unwrap();
        assert_eq!(v["id"], 7);
    }

    #[tokio::test]
    async fn probe_http_invalid_config_header_is_failed() {
        let r = probe(
            "remote",
            &json!({
                "type": "http",
                "url": "http://127.0.0.1:1/mcp",
                "headers": { "X-Bad": "bad\nvalue" }
            }),
        )
        .await;
        assert_eq!(r.status, McpStatus::Failed);
        assert!(r.error.unwrap().contains("header"));
    }
}
