//! `fleet-memory-mcp` — stdio MCP server that exposes `remember` and
//! `recall` tools to a Claude / Gemini / Codex session. The session
//! reaches Fleet's session_memory store through the embedded backend's
//! loopback memory route, `/api/internal/memory`.
//!
//! Faithful subset of `services/memory_mcp.py`.
//!
//! Wire format: line-delimited JSON-RPC 2.0 on stdin/stdout. Session
//! context and the loopback secret come from env (set by the backend's
//! `mcp_dispatch::builtin_mcp_config` at spawn):
//!
//!   FLEETIFY_SESSION_ID       — the session this MCP belongs to: the
//!                                tools read and write its memory, which
//!                                every session on its project recalls
//!   FLEETIFY_INTERNAL_SECRET  — loopback secret shared with the
//!                                in-process backend, sent as
//!                                `X-Fleet-Internal`
//!   FLEETIFY_BACKEND_URL      — defaults to http://127.0.0.1:8765
//!
//! Not `/api/sessions/{id}/memory`, the window's route: that one needs the
//! backend's per-run API token, which only the window holds.
//!
//! Tools:
//!   remember(title: string, content: string, kind?: string)
//!   recall(query?: string, limit?: number)

// Agent CLIs start this server with its standard streams piped, and not all of
// them stop Windows from opening a console window for a console program. A
// GUI-subsystem program gets no console, and this one needs none: it uses only
// the standard streams it inherits (Rust reads a missing one as end of input
// and drops what is written to it).
#![cfg_attr(windows, windows_subsystem = "windows")]

use std::io::Write;

use anyhow::Result;
use reqwest::header::HeaderValue;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

#[tokio::main(flavor = "current_thread")]
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

/// The client for calls to the backend: never through a proxy, which would
/// see the internal secret (`fleetify_core::loopback`).
fn backend_client() -> Result<reqwest::Client, String> {
    fleetify_core::loopback::http_client_builder()
        .build()
        .map_err(|e| format!("HTTP client: {e}"))
}

/// The header the backend's internal routes read the secret from.
const SECRET_HEADER: &str = "X-Fleet-Internal";

/// Where the backend listens when `FLEETIFY_BACKEND_URL` is unset.
const DEFAULT_BACKEND_URL: &str = "http://127.0.0.1:8765";

/// How many notes `recall` returns unless asked for another number, and the
/// most it returns.
const RECALL_DEFAULT_LIMIT: i64 = 10;
const RECALL_MAX_LIMIT: i64 = 50;

/// What this server needs to reach the backend, from the environment the
/// backend starts it with.
struct Backend {
    /// `FLEETIFY_BACKEND_URL`.
    url: String,
    /// `FLEETIFY_INTERNAL_SECRET`.
    secret: String,
    /// `FLEETIFY_SESSION_ID`: the caller, whose memory the tools read and
    /// write.
    session_id: String,
}

impl Backend {
    fn from_env() -> Result<Self, String> {
        Self::from_vars(|name| std::env::var(name).ok())
    }

    /// [`Backend::from_env`], with `var` standing in for the environment.
    fn from_vars(var: impl Fn(&str) -> Option<String>) -> Result<Self, String> {
        let session_id = var("FLEETIFY_SESSION_ID").ok_or("FLEETIFY_SESSION_ID env var missing")?;
        let secret =
            var("FLEETIFY_INTERNAL_SECRET").ok_or("FLEETIFY_INTERNAL_SECRET env var missing")?;
        let url = var("FLEETIFY_BACKEND_URL").unwrap_or_else(|| DEFAULT_BACKEND_URL.to_string());
        Ok(Self {
            url,
            secret,
            session_id,
        })
    }

    /// The backend's memory route for the sidecars.
    fn memory_url(&self) -> String {
        format!("{}/api/internal/memory", self.url)
    }

    /// The secret as a header value, marked sensitive so that no debug
    /// output shows it.
    fn secret_header(&self) -> Result<HeaderValue, String> {
        let mut value = HeaderValue::from_str(&self.secret)
            .map_err(|_| "FLEETIFY_INTERNAL_SECRET isn't a valid header value".to_string())?;
        value.set_sensitive(true);
        Ok(value)
    }
}

fn str_arg<'a>(args: &'a Value, name: &str) -> &'a str {
    args.get(name).and_then(|v| v.as_str()).unwrap_or("")
}

/// `remember`'s request: `POST /api/internal/memory`, with the secret, the
/// caller's session id and the note.
fn remember_request(
    client: &reqwest::Client,
    backend: &Backend,
    args: &Value,
) -> Result<reqwest::Request, String> {
    let title = str_arg(args, "title");
    let content = str_arg(args, "content");
    let kind = args.get("kind").and_then(|v| v.as_str()).unwrap_or("note");
    if title.is_empty() || content.is_empty() {
        return Err("title and content are required".into());
    }
    client
        .post(backend.memory_url())
        .header(SECRET_HEADER, backend.secret_header()?)
        .json(&json!({
            "caller_session_id": backend.session_id,
            "title": title,
            "content": content,
            "kind": kind,
        }))
        .build()
        .map_err(|e| format!("building the remember request failed: {e}"))
}

/// `recall`'s arguments: the query, lowercased and empty when there is none,
/// and how many notes to return, held to 1..=[`RECALL_MAX_LIMIT`].
fn recall_args(args: &Value) -> (String, usize) {
    let query = str_arg(args, "query").to_lowercase();
    let limit = args
        .get("limit")
        .and_then(|v| v.as_i64())
        .unwrap_or(RECALL_DEFAULT_LIMIT)
        .clamp(1, RECALL_MAX_LIMIT);
    (query, limit as usize)
}

/// `recall`'s request: `GET /api/internal/memory`, with the secret and the
/// caller's session id, for the newest `limit` notes, or without a `limit`
/// for as many as the backend returns.
fn recall_request(
    client: &reqwest::Client,
    backend: &Backend,
    limit: Option<usize>,
) -> Result<reqwest::Request, String> {
    let mut query = vec![("caller_session_id", backend.session_id.clone())];
    if let Some(limit) = limit {
        query.push(("limit", limit.to_string()));
    }
    client
        .get(backend.memory_url())
        .header(SECRET_HEADER, backend.secret_header()?)
        .query(&query)
        .build()
        .map_err(|e| format!("building the recall request failed: {e}"))
}

/// The notes in `body` that mention `query` in their title, content or
/// kind, ignoring case: the first `limit` of them, which are the newest, as
/// the backend lists notes newest first. The backend's memory route can't
/// search, so the sidecar filters.
fn matching_notes(body: Value, query: &str, limit: usize) -> Value {
    let Some(notes) = body.as_array() else {
        return body;
    };
    let matching: Vec<Value> = notes
        .iter()
        .filter(|note| {
            let hay = format!(
                "{}\n{}\n{}",
                note.get("title").and_then(|x| x.as_str()).unwrap_or(""),
                note.get("content").and_then(|x| x.as_str()).unwrap_or(""),
                note.get("kind").and_then(|x| x.as_str()).unwrap_or("")
            )
            .to_lowercase();
            hay.contains(query)
        })
        .take(limit)
        .cloned()
        .collect();
    Value::Array(matching)
}

/// Send `request` to the backend. A status other than 2xx is an error that
/// carries the backend's message.
async fn send(
    client: &reqwest::Client,
    request: reqwest::Request,
) -> Result<reqwest::Response, String> {
    let what = format!("{} {}", request.method(), request.url().path());
    let response = client
        .execute(request)
        .await
        .map_err(|e| format!("{what} failed: {e}"))?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(format!(
            "{what} returned {}: {}",
            status.as_u16(),
            body.trim()
        ));
    }
    Ok(response)
}

async fn remember(args: Value) -> Result<Value, String> {
    let backend = Backend::from_env()?;
    let client = backend_client()?;
    let request = remember_request(&client, &backend, &args)?;
    send(&client, request).await?;
    let title = str_arg(&args, "title");
    let kind = args.get("kind").and_then(|v| v.as_str()).unwrap_or("note");
    Ok(json!({ "ok": true, "kind": kind, "title": title }))
}

async fn recall(args: Value) -> Result<Value, String> {
    let backend = Backend::from_env()?;
    let (query, limit) = recall_args(&args);
    let client = backend_client()?;
    // Without a query the backend picks the newest `limit` notes. With one,
    // the filter needs every note the backend returns, not only the newest
    // `limit`, and keeps the newest `limit` matches itself.
    let fetch = query.is_empty().then_some(limit);
    let request = recall_request(&client, &backend, fetch)?;
    let body: Value = send(&client, request)
        .await?
        .json()
        .await
        .map_err(|e| format!("decode failed: {e}"))?;
    if query.is_empty() {
        return Ok(body);
    }
    Ok(matching_notes(body, &query, limit))
}

// Allow `Write` import used by the stdout flush path — silences an
// unused-import warning in some configurations.
fn _ensure_write_in_scope() {
    let _ = std::io::stdout().lock().write(b"");
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &str = "test-secret";

    /// The environment the backend starts this server with
    /// (`mcp_dispatch::builtin_mcp_config`), and nothing else.
    fn sidecar_env(name: &str) -> Option<String> {
        match name {
            "FLEETIFY_SESSION_ID" => Some("caller-session".into()),
            "FLEETIFY_INTERNAL_SECRET" => Some(SECRET.into()),
            "FLEETIFY_BACKEND_URL" => Some("http://127.0.0.1:9".into()),
            _ => None,
        }
    }

    /// [`sidecar_env`] without `missing`.
    fn sidecar_env_without(missing: &'static str) -> impl Fn(&str) -> Option<String> {
        move |name| (name != missing).then(|| sidecar_env(name)).flatten()
    }

    fn backend() -> Backend {
        Backend::from_vars(sidecar_env).expect("the backend from the sidecar's environment")
    }

    fn client() -> reqwest::Client {
        backend_client().unwrap()
    }

    fn json_body(request: &reqwest::Request) -> Value {
        let body = request
            .body()
            .and_then(|body| body.as_bytes())
            .expect("a JSON body");
        serde_json::from_slice(body).unwrap()
    }

    /// `request` carries the internal secret, marked sensitive so no debug
    /// output shows it, and no bearer.
    fn assert_sends_the_secret(request: &reqwest::Request) {
        let secret = request
            .headers()
            .get("x-fleet-internal")
            .expect("an X-Fleet-Internal header");
        assert_eq!(secret, SECRET);
        assert!(secret.is_sensitive(), "the secret isn't marked sensitive");
        assert!(
            request
                .headers()
                .get(reqwest::header::AUTHORIZATION)
                .is_none(),
            "an Authorization header"
        );
    }

    #[test]
    fn the_backend_is_read_from_the_environment_the_backend_gives_its_sidecars() {
        let backend = backend();
        assert_eq!(backend.url, "http://127.0.0.1:9");
        assert_eq!(backend.session_id, "caller-session");

        let default = Backend::from_vars(sidecar_env_without("FLEETIFY_BACKEND_URL"))
            .expect("the backend without FLEETIFY_BACKEND_URL");
        assert_eq!(default.url, "http://127.0.0.1:8765");
    }

    #[test]
    fn the_session_id_and_the_secret_are_required() {
        for missing in ["FLEETIFY_SESSION_ID", "FLEETIFY_INTERNAL_SECRET"] {
            let refused = Backend::from_vars(sidecar_env_without(missing)).err();
            assert_eq!(
                refused,
                Some(format!("{missing} env var missing")),
                "without {missing}"
            );
        }
    }

    #[test]
    fn remember_posts_the_note_for_the_caller_to_the_internal_route() {
        let args = json!({
            "title": "Use sqlx",
            "content": "The session store is SQLite.",
            "kind": "decision",
        });
        let request = remember_request(&client(), &backend(), &args).unwrap();
        assert_eq!(request.method(), reqwest::Method::POST);
        assert_eq!(
            request.url().as_str(),
            "http://127.0.0.1:9/api/internal/memory"
        );
        assert_sends_the_secret(&request);
        assert_eq!(
            json_body(&request),
            json!({
                "caller_session_id": "caller-session",
                "title": "Use sqlx",
                "content": "The session store is SQLite.",
                "kind": "decision",
            })
        );
    }

    #[test]
    fn remember_without_a_kind_saves_a_note() {
        let args = json!({ "title": "t", "content": "c" });
        let request = remember_request(&client(), &backend(), &args).unwrap();
        assert_eq!(json_body(&request)["kind"], "note");
    }

    #[test]
    fn remember_needs_a_title_and_content() {
        for args in [
            json!({ "content": "c" }),
            json!({ "title": "t", "content": "" }),
        ] {
            let refused = remember_request(&client(), &backend(), &args).err();
            assert_eq!(
                refused.as_deref(),
                Some("title and content are required"),
                "{args}"
            );
        }
    }

    #[test]
    fn recall_gets_the_callers_newest_notes_from_the_internal_route() {
        let request = recall_request(&client(), &backend(), Some(7)).unwrap();
        assert_eq!(request.method(), reqwest::Method::GET);
        assert_eq!(
            request.url().as_str(),
            "http://127.0.0.1:9/api/internal/memory?caller_session_id=caller-session&limit=7"
        );
        assert_sends_the_secret(&request);
        assert!(request.body().is_none(), "a GET with a body");
    }

    #[test]
    fn recall_without_a_limit_asks_for_every_note_the_backend_returns() {
        let request = recall_request(&client(), &backend(), None).unwrap();
        assert_eq!(
            request.url().query(),
            Some("caller_session_id=caller-session")
        );
    }

    #[test]
    fn recall_returns_ten_notes_unless_asked_for_one_to_fifty() {
        assert_eq!(recall_args(&json!({})), (String::new(), 10));
        assert_eq!(recall_args(&json!({ "limit": 0 })).1, 1);
        assert_eq!(recall_args(&json!({ "limit": 500 })).1, 50);
        assert_eq!(
            recall_args(&json!({ "query": "SQLite", "limit": 3 })),
            ("sqlite".to_string(), 3)
        );
    }

    #[test]
    fn recall_with_a_query_keeps_the_newest_matching_notes_up_to_the_limit() {
        let notes = json!([
            { "title": "Use SQLite", "content": "for the session store", "kind": "decision" },
            { "title": "Lint", "content": "clippy denies warnings", "kind": "gotcha" },
            { "title": "Store", "content": "sqlite runs in WAL mode", "kind": "learning" },
            { "title": "Old store", "content": "sqlite before the move", "kind": "note" },
        ]);
        let kept = matching_notes(notes, "sqlite", 2);
        let titles: Vec<&str> = kept
            .as_array()
            .expect("an array of notes")
            .iter()
            .map(|note| note["title"].as_str().unwrap())
            .collect();
        assert_eq!(titles, ["Use SQLite", "Store"]);
    }
}
