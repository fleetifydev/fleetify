//! Agent Client Protocol (ACP) client over stdio.
//!
//! Faithful port of `services/acp_client.py`. JSON-RPC 2.0 transport
//! agnostic of which ACP agent is on the other end — used by the
//! Gemini bridge and reusable for any future ACP agent.
//!
//! Wire shape (line-delimited JSON):
//!
//! ```text
//! → {"jsonrpc":"2.0","id":1,"method":"initialize","params":{...}}
//! ← {"jsonrpc":"2.0","id":1,"result":{...}}
//!
//! → {"jsonrpc":"2.0","method":"session/cancel","params":{...}}        (no reply)
//!
//! ← {"jsonrpc":"2.0","id":2,"method":"session/request_permission",…}  (agent → us)
//! → {"jsonrpc":"2.0","id":2,"result":{...}}
//!
//! ← {"jsonrpc":"2.0","method":"session/update","params":{...}}        (no reply)
//! ```
//!
//! Spec: https://agentclientprotocol.com/protocol

use std::collections::HashMap;
use std::pin::Pin;
use std::sync::{
    atomic::{AtomicI64, Ordering},
    Arc,
};

use anyhow::{anyhow, Result};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{oneshot, Mutex};

type PendingMap = HashMap<i64, oneshot::Sender<Result<Value>>>;

/// Handler signature for inbound agent-initiated requests
/// (session/request_permission, fs/read_text_file, fs/write_text_file).
/// Must return a JSON-RPC `result` value.
pub type RequestHandler = Arc<
    dyn Fn(Value) -> Pin<Box<dyn std::future::Future<Output = Result<Value>> + Send>> + Send + Sync,
>;

/// Handler signature for inbound agent-initiated notifications
/// (session/update etc.). Errors are logged but do not propagate.
pub type NotificationHandler =
    Arc<dyn Fn(Value) -> Pin<Box<dyn std::future::Future<Output = ()> + Send>> + Send + Sync>;

#[derive(Default)]
struct Handlers {
    permission: Option<RequestHandler>,
    fs_read: Option<RequestHandler>,
    fs_write: Option<RequestHandler>,
    session_update: Option<NotificationHandler>,
    /// `session/update` notifications that arrived BEFORE `session_update` was
    /// set (during cold_start, before the per-turn handler is wired). Replayed
    /// when `on_session_update` registers, so an ACP agent's initial
    /// `available_commands_update` (pushed right after `session/new`) isn't
    /// dropped — without this the agent's slash commands never reach the UI.
    session_update_pending: Vec<Value>,
    /// Handlers for arbitrary inbound *requests* keyed by method name —
    /// used for agent-specific extension methods (e.g. Cursor's blocking
    /// `cursor/ask_question` / `cursor/create_plan`). Consulted only after
    /// the built-in `session/request_permission` + `fs/*` arms miss.
    generic: HashMap<String, RequestHandler>,
    /// Same, for arbitrary inbound *notifications* (e.g. Cursor's
    /// `cursor/update_todos`). Consulted after `session/update` misses.
    generic_notify: HashMap<String, NotificationHandler>,
}

/// Pipe writer abstraction — any `AsyncWrite + Unpin + Send`.
type DynWriter = Pin<Box<dyn tokio::io::AsyncWrite + Send + Unpin>>;
/// Pipe reader abstraction — any `AsyncBufRead + Unpin + Send`.
type DynReader = Pin<Box<dyn tokio::io::AsyncBufRead + Send + Unpin>>;

pub struct AcpClient {
    writer: Arc<Mutex<Option<DynWriter>>>,
    pending: Arc<Mutex<PendingMap>>,
    handlers: Arc<Mutex<Handlers>>,
    next_id: AtomicI64,
    read_task: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl Default for AcpClient {
    fn default() -> Self {
        Self::new()
    }
}

impl AcpClient {
    pub fn new() -> Self {
        Self {
            writer: Arc::new(Mutex::new(None)),
            pending: Arc::new(Mutex::new(HashMap::new())),
            handlers: Arc::new(Mutex::new(Handlers::default())),
            next_id: AtomicI64::new(1),
            read_task: Mutex::new(None),
        }
    }

    /// Bind the client to an already-spawned subprocess's pipes and
    /// start the read loop. Errors if called twice.
    pub async fn attach<R, W>(&self, reader: R, writer: W) -> Result<()>
    where
        R: tokio::io::AsyncRead + Send + Unpin + 'static,
        W: tokio::io::AsyncWrite + Send + Unpin + 'static,
    {
        {
            let mut task = self.read_task.lock().await;
            if task.as_ref().is_some_and(|h| !h.is_finished()) {
                return Err(anyhow!("AcpClient already attached"));
            }
            let dyn_w: DynWriter = Box::pin(writer);
            *self.writer.lock().await = Some(dyn_w);

            let dyn_r: DynReader = Box::pin(BufReader::new(reader));
            let pending = self.pending.clone();
            let handlers = self.handlers.clone();
            let writer_ref = self.writer.clone();
            let handle = tokio::spawn(read_loop(dyn_r, pending, handlers, writer_ref));
            *task = Some(handle);
        }
        Ok(())
    }

    pub async fn is_running(&self) -> bool {
        self.read_task
            .lock()
            .await
            .as_ref()
            .is_some_and(|h| !h.is_finished())
    }

    /// Stop the read loop, close the writer, fail any pending futures.
    pub async fn shutdown(&self) {
        // Abort the reader.
        if let Some(handle) = self.read_task.lock().await.take() {
            handle.abort();
        }
        // Drain pending futures with an error.
        let mut pending = self.pending.lock().await;
        for (_, tx) in pending.drain() {
            let _ = tx.send(Err(anyhow!("AcpClient shut down")));
        }
        // Drop the writer (closes the pipe).
        let mut w = self.writer.lock().await;
        *w = None;
    }

    pub async fn on_permission_request(&self, h: RequestHandler) {
        self.handlers.lock().await.permission = Some(h);
    }
    pub async fn on_fs_read(&self, h: RequestHandler) {
        self.handlers.lock().await.fs_read = Some(h);
    }
    pub async fn on_fs_write(&self, h: RequestHandler) {
        self.handlers.lock().await.fs_write = Some(h);
    }
    pub async fn on_session_update(&self, h: NotificationHandler) {
        // Register the handler AND replay any `session/update` notifications
        // buffered before it was set (e.g. the agent's `available_commands_update`
        // pushed during cold_start). Otherwise that initial advertisement is lost.
        let pending: Vec<Value> = {
            let mut g = self.handlers.lock().await;
            g.session_update = Some(h.clone());
            std::mem::take(&mut g.session_update_pending)
        };
        for params in pending {
            let h = h.clone();
            tokio::spawn(async move {
                h(params).await;
            });
        }
    }
    /// Register a handler for an arbitrary inbound request method (e.g. an
    /// agent extension like `cursor/ask_question`). The handler's `Ok` value
    /// is written back as the JSON-RPC `result`; `Err` becomes a `-32000`.
    pub async fn on_request(&self, method: &str, h: RequestHandler) {
        self.handlers
            .lock()
            .await
            .generic
            .insert(method.to_string(), h);
    }
    /// Register a handler for an arbitrary inbound notification method (e.g.
    /// `cursor/update_todos`). Fire-and-forget; errors are not propagated.
    pub async fn on_notification(&self, method: &str, h: NotificationHandler) {
        self.handlers
            .lock()
            .await
            .generic_notify
            .insert(method.to_string(), h);
    }

    /// Send a JSON-RPC request and await the response.
    pub async fn call(&self, method: &str, params: Value) -> Result<Value> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);
        let frame = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        if let Err(e) = write_frame(&self.writer, &frame).await {
            self.pending.lock().await.remove(&id);
            return Err(e);
        }
        match rx.await {
            Ok(r) => r,
            Err(_) => Err(anyhow!("ACP response channel dropped")),
        }
    }

    /// Send a JSON-RPC notification (no response awaited).
    pub async fn notify(&self, method: &str, params: Value) -> Result<()> {
        let frame = json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        });
        write_frame(&self.writer, &frame).await
    }

    // ── Typed convenience methods ────────────────────────────────
    pub async fn initialize(&self, client_capabilities: Value) -> Result<Value> {
        self.call(
            "initialize",
            json!({ "protocolVersion": 1, "clientCapabilities": client_capabilities }),
        )
        .await
    }

    pub async fn authenticate(&self, method_id: &str) -> Result<Value> {
        self.call("authenticate", json!({ "methodId": method_id }))
            .await
    }

    pub async fn session_new(&self, cwd: &str, mcp_servers: Value) -> Result<String> {
        let r = self
            .call(
                "session/new",
                json!({ "cwd": cwd, "mcpServers": mcp_servers }),
            )
            .await?;
        r.get("sessionId")
            .and_then(|v| v.as_str())
            .map(String::from)
            .ok_or_else(|| anyhow!("session/new: missing sessionId"))
    }

    pub async fn session_load(
        &self,
        session_id: &str,
        cwd: &str,
        mcp_servers: Value,
    ) -> Result<()> {
        self.call(
            "session/load",
            json!({
                "sessionId": session_id,
                "cwd": cwd,
                "mcpServers": mcp_servers,
            }),
        )
        .await?;
        Ok(())
    }

    pub async fn session_prompt(&self, session_id: &str, content: Value) -> Result<Value> {
        self.call(
            "session/prompt",
            json!({ "sessionId": session_id, "prompt": content }),
        )
        .await
    }

    pub async fn session_cancel(&self, session_id: &str) -> Result<()> {
        self.notify("session/cancel", json!({ "sessionId": session_id }))
            .await
    }
}

async fn write_frame(writer: &Arc<Mutex<Option<DynWriter>>>, frame: &Value) -> Result<()> {
    let mut guard = writer.lock().await;
    let Some(w) = guard.as_mut() else {
        return Err(anyhow!("AcpClient not attached"));
    };
    let mut line = serde_json::to_vec(frame)?;
    line.push(b'\n');
    w.write_all(&line).await?;
    w.flush().await?;
    Ok(())
}

async fn write_result(writer: &Arc<Mutex<Option<DynWriter>>>, req_id: i64, result: Value) {
    let frame = json!({ "jsonrpc": "2.0", "id": req_id, "result": result });
    let _ = write_frame(writer, &frame).await;
}

async fn write_error(
    writer: &Arc<Mutex<Option<DynWriter>>>,
    req_id: i64,
    code: i64,
    message: String,
) {
    let frame = json!({
        "jsonrpc": "2.0",
        "id": req_id,
        "error": { "code": code, "message": message }
    });
    let _ = write_frame(writer, &frame).await;
}

async fn read_loop(
    mut reader: DynReader,
    pending: Arc<Mutex<PendingMap>>,
    handlers: Arc<Mutex<Handlers>>,
    writer: Arc<Mutex<Option<DynWriter>>>,
) {
    let mut line = String::new();
    loop {
        line.clear();
        let n = match reader.read_line(&mut line).await {
            Ok(0) => break, // EOF
            Ok(n) => n,
            Err(e) => {
                tracing::warn!(target: "acp", "read_error: {e}");
                break;
            }
        };
        let _ = n;
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let msg: Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!(target: "acp", "parse_error: {e} raw={}",
                    &trimmed.chars().take(200).collect::<String>());
                continue;
            }
        };
        dispatch(msg, &pending, &handlers, &writer).await;
    }
    // Stream ended — fail every still-pending request.
    let mut map = pending.lock().await;
    for (_, tx) in map.drain() {
        let _ = tx.send(Err(anyhow!("ACP stream closed")));
    }
}

/// Pull the most actionable string out of a JSON-RPC `error.data`.
///
/// ACP agents vary: most put the explanation in `data.details` or a bare-string
/// `data`, but some use `error` / `reason` / `message` / `description`. Returns
/// the first non-empty string. An unrecognised *object* shape is intentionally
/// NOT dumped into chat — the raw error is logged (`tracing`, see `dispatch`)
/// for diagnosis instead, so the chat message stays clean.
fn extract_error_detail(data: &Value) -> Option<&str> {
    if let Some(s) = data.as_str() {
        return (!s.trim().is_empty()).then_some(s);
    }
    [
        "details",
        "error",
        "reason",
        "message",
        "error_description",
        "description",
    ]
    .into_iter()
    .find_map(|k| {
        data.get(k)
            .and_then(|v| v.as_str())
            .filter(|s| !s.trim().is_empty())
    })
}

/// Does an agent's error mean "sign in first"? ACP reserves `-32000` for
/// auth-required, and agents word it differently: Grok and Kimi
/// "Authentication required", Cursor "Not authenticated", Copilot "No
/// authentication information found". Hermes' equivalent is having no model
/// provider configured (`hermes model` fixes it). Matched on the formatted
/// error text so every ACP bridge can use it on start-up and prompt errors.
pub fn is_sign_in_error(message: &str) -> bool {
    let m = message.to_ascii_lowercase();
    [
        "authentication required",
        "auth required",
        "not authenticated",
        "unauthenticated",
        "authentication failed",
        "no authentication information found",
        "not logged in",
        "login required",
        "please log in",
        "please login",
        "no llm provider configured",
    ]
    .iter()
    .any(|phrase| m.contains(phrase))
}

/// Format a JSON-RPC `error` object into a human-readable string.
///
/// ACP agents routinely keep the top-level `message` generic ("Internal
/// error") and put the *actionable* explanation in `error.data` (Hermes:
/// "No LLM provider configured. Run `hermes model`…"). Surfacing that detail
/// turns an opaque "ACP error -32603: Internal error" into something the user
/// can act on, for every ACP bridge (Gemini / OpenCode / Cursor / GitHub
/// Copilot / Hermes / Grok).
fn format_acp_error(err: &Value) -> String {
    let code = err.get("code").and_then(|v| v.as_i64()).unwrap_or(0);
    let message = err
        .get("message")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    // Surface `error.data` (in any of the shapes agents use), dropping it when
    // empty or identical to `message` (no value added).
    let detail = err
        .get("data")
        .and_then(extract_error_detail)
        .map(str::trim)
        .filter(|d| !d.is_empty() && *d != message);
    let base = if message.is_empty() {
        format!("ACP error {code}")
    } else {
        format!("ACP error {code}: {message}")
    };
    match detail {
        Some(d) => format!("{base} — {d}"),
        None => base,
    }
}

async fn dispatch(
    msg: Value,
    pending: &Arc<Mutex<PendingMap>>,
    handlers: &Arc<Mutex<Handlers>>,
    writer: &Arc<Mutex<Option<DynWriter>>>,
) {
    let id = msg.get("id").and_then(|v| v.as_i64());
    let has_result_or_error = msg.get("result").is_some() || msg.get("error").is_some();
    let method = msg.get("method").and_then(|v| v.as_str()).map(String::from);

    // Response to one of OUR requests.
    if let Some(req_id) = id {
        if has_result_or_error {
            if let Some(tx) = pending.lock().await.remove(&req_id) {
                if let Some(err) = msg.get("error") {
                    // Log the COMPLETE raw JSON-RPC error (code + message + data,
                    // verbatim) before it's collapsed to a display string. ACP
                    // agents often return a bare `-32603 Internal error` whose
                    // real cause lives in a `data` shape we don't surface to chat
                    // — this is the only place that cause is recoverable.
                    tracing::warn!(target: "acp", req_id, raw = %err, "ACP request failed");
                    let _ = tx.send(Err(anyhow!("{}", format_acp_error(err))));
                } else {
                    let r = msg.get("result").cloned().unwrap_or(Value::Null);
                    let _ = tx.send(Ok(r));
                }
            }
            return;
        }

        // Inbound REQUEST from the agent (has id + method, no result/error).
        if let Some(m) = method {
            handle_inbound_request(req_id, m, msg, handlers.clone(), writer.clone()).await;
            return;
        }
    }

    // Notification (no id).
    if let Some(m) = method {
        handle_inbound_notification(m, msg, handlers.clone()).await;
    }
}

async fn handle_inbound_request(
    req_id: i64,
    method: String,
    msg: Value,
    handlers: Arc<Mutex<Handlers>>,
    writer: Arc<Mutex<Option<DynWriter>>>,
) {
    let params = msg
        .get("params")
        .cloned()
        .unwrap_or(Value::Object(Default::default()));
    let h = {
        let guard = handlers.lock().await;
        match method.as_str() {
            "session/request_permission" => guard.permission.clone(),
            "fs/read_text_file" => guard.fs_read.clone(),
            "fs/write_text_file" => guard.fs_write.clone(),
            other => guard.generic.get(other).cloned(),
        }
    };
    let Some(handler) = h else {
        write_error(
            &writer,
            req_id,
            -32601,
            format!("Method not handled: {method}"),
        )
        .await;
        return;
    };
    // Spawn so a slow handler can't block the read loop.
    tokio::spawn(async move {
        let result = handler(params).await;
        match result {
            Ok(v) => write_result(&writer, req_id, v).await,
            Err(e) => {
                tracing::warn!(target: "acp", "handler_error method={method} error={e}");
                write_error(&writer, req_id, -32000, e.to_string()).await;
            }
        }
    });
}

async fn handle_inbound_notification(method: String, msg: Value, handlers: Arc<Mutex<Handlers>>) {
    let params = msg
        .get("params")
        .cloned()
        .unwrap_or(Value::Object(Default::default()));
    if method == "session/update" {
        let mut g = handlers.lock().await;
        if let Some(h) = g.session_update.clone() {
            drop(g);
            tokio::spawn(async move {
                h(params).await;
            });
        } else if g.session_update_pending.len() < 128 {
            // No handler yet (cold_start) — buffer so `on_session_update` can
            // replay it, instead of dropping the initial advertisement.
            g.session_update_pending.push(params);
        }
        return;
    }
    // Agent-specific extension notifications (e.g. Cursor's
    // `cursor/update_todos` / `cursor/task` / `cursor/generate_image`).
    let generic = handlers.lock().await.generic_notify.get(&method).cloned();
    if let Some(h) = generic {
        tokio::spawn(async move {
            h(params).await;
        });
        return;
    }
    tracing::debug!(target: "acp", "notification_unhandled method={method}");
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{duplex, AsyncBufReadExt, AsyncWriteExt, BufReader};

    /// Smoke-test: client sends request, the "agent" responds, client
    /// resolves the future with the parsed result.
    #[tokio::test]
    async fn call_resolves_with_agent_response() {
        // Build two duplex pipes — one for client→agent, one for agent→client.
        let (client_to_agent_r, client_to_agent_w) = duplex(4096);
        let (mut agent_to_client_w, agent_to_client_r) = duplex(4096);

        let client = Arc::new(AcpClient::new());
        client
            .attach(agent_to_client_r, client_to_agent_w)
            .await
            .unwrap();

        // Fake agent: read one line, parse, write a matching response.
        let agent = tokio::spawn(async move {
            let mut reader = BufReader::new(client_to_agent_r);
            let mut line = String::new();
            reader.read_line(&mut line).await.unwrap();
            let msg: Value = serde_json::from_str(line.trim()).unwrap();
            let id = msg["id"].as_i64().unwrap();
            assert_eq!(msg["method"], "initialize");
            let reply = json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": { "protocolVersion": 1, "authMethods": [] }
            });
            let mut bytes = serde_json::to_vec(&reply).unwrap();
            bytes.push(b'\n');
            agent_to_client_w.write_all(&bytes).await.unwrap();
            agent_to_client_w.flush().await.unwrap();
        });

        let r = client.initialize(json!({})).await.unwrap();
        assert_eq!(r["protocolVersion"], 1);
        let _ = agent.await;
        client.shutdown().await;
    }

    /// A `session/update` that arrives BEFORE `on_session_update` is registered
    /// (the cold_start race: an agent pushes `available_commands_update` right
    /// after `session/new`, before the per-turn handler is wired) must be
    /// buffered and replayed — not dropped — so the agent's slash commands reach
    /// the UI.
    #[tokio::test]
    async fn session_update_before_handler_is_buffered_and_replayed() {
        let (_client_to_agent_r, client_to_agent_w) = duplex(4096);
        let (mut agent_to_client_w, agent_to_client_r) = duplex(4096);
        let client = Arc::new(AcpClient::new());
        client
            .attach(agent_to_client_r, client_to_agent_w)
            .await
            .unwrap();

        // Agent advertises commands while NO session_update handler is set yet.
        let notif = json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": { "update": {
                "sessionUpdate": "available_commands_update",
                "availableCommands": [{ "name": "review" }]
            } }
        });
        let mut bytes = serde_json::to_vec(&notif).unwrap();
        bytes.push(b'\n');
        agent_to_client_w.write_all(&bytes).await.unwrap();
        agent_to_client_w.flush().await.unwrap();
        // Let the read loop receive + buffer it.
        tokio::time::sleep(std::time::Duration::from_millis(80)).await;

        // Registering the handler must replay the buffered notification.
        let (tx, mut rx) = tokio::sync::mpsc::channel::<Value>(4);
        client
            .on_session_update(Arc::new(move |params: Value| {
                let tx = tx.clone();
                Box::pin(async move {
                    let _ = tx.send(params).await;
                })
            }))
            .await;

        let got = tokio::time::timeout(std::time::Duration::from_secs(1), rx.recv())
            .await
            .expect("handler should be replayed")
            .expect("params present");
        assert_eq!(got["update"]["sessionUpdate"], "available_commands_update");
        client.shutdown().await;
    }

    /// EOF before a response arrives must fail the future, not hang.
    #[tokio::test]
    async fn call_fails_on_eof_before_response() {
        let (client_to_agent_r, client_to_agent_w) = duplex(4096);
        let (agent_to_client_w, agent_to_client_r) = duplex(4096);
        let client = Arc::new(AcpClient::new());
        client
            .attach(agent_to_client_r, client_to_agent_w)
            .await
            .unwrap();

        // Move BOTH agent-side halves into the spawned task so they
        // drop together → the client's reader sees EOF on the
        // agent_to_client pipe, which fails the pending future.
        let agent = tokio::spawn(async move {
            let mut reader = BufReader::new(client_to_agent_r);
            let mut line = String::new();
            let _ = reader.read_line(&mut line).await;
            drop(reader);
            drop(agent_to_client_w);
        });

        let err = client.initialize(json!({})).await.unwrap_err();
        assert!(format!("{err}").contains("ACP stream closed"));
        let _ = agent.await;
    }

    /// Inbound request from the agent gets dispatched to the registered
    /// handler and the handler's result is written back as a response.
    #[tokio::test]
    async fn inbound_request_invokes_handler_and_writes_result() {
        let (client_to_agent_r, client_to_agent_w) = duplex(4096);
        let (mut agent_to_client_w, agent_to_client_r) = duplex(4096);
        let client = Arc::new(AcpClient::new());
        client
            .attach(agent_to_client_r, client_to_agent_w)
            .await
            .unwrap();

        client
            .on_permission_request(Arc::new(|_params: Value| {
                Box::pin(async move {
                    Ok(json!({ "outcome": { "outcome": "selected", "optionId": "allow_once" } }))
                })
            }))
            .await;

        // Agent sends a session/request_permission request.
        let request = json!({
            "jsonrpc": "2.0",
            "id": 42,
            "method": "session/request_permission",
            "params": { "options": [], "sessionId": "s1", "toolCall": {} }
        });
        let mut req_bytes = serde_json::to_vec(&request).unwrap();
        req_bytes.push(b'\n');
        agent_to_client_w.write_all(&req_bytes).await.unwrap();
        agent_to_client_w.flush().await.unwrap();

        // Read the response written back by the client.
        let mut reader = BufReader::new(client_to_agent_r);
        let mut line = String::new();
        // Bounded wait so a regression hangs the test, not the suite.
        tokio::time::timeout(
            std::time::Duration::from_secs(2),
            reader.read_line(&mut line),
        )
        .await
        .expect("timed out waiting for response")
        .unwrap();
        let resp: Value = serde_json::from_str(line.trim()).unwrap();
        assert_eq!(resp["id"], 42);
        assert_eq!(resp["result"]["outcome"]["outcome"], "selected");
        client.shutdown().await;
    }

    /// A generic inbound request (an agent extension method like
    /// `cursor/create_plan`) registered via `on_request` is dispatched to
    /// that handler and its result is written back as the JSON-RPC response.
    #[tokio::test]
    async fn generic_inbound_request_invokes_registered_handler() {
        let (client_to_agent_r, client_to_agent_w) = duplex(4096);
        let (mut agent_to_client_w, agent_to_client_r) = duplex(4096);
        let client = Arc::new(AcpClient::new());
        client
            .attach(agent_to_client_r, client_to_agent_w)
            .await
            .unwrap();

        client
            .on_request(
                "cursor/create_plan",
                Arc::new(|_params: Value| {
                    Box::pin(async move { Ok(json!({ "outcome": { "outcome": "accepted" } })) })
                }),
            )
            .await;

        let request = json!({
            "jsonrpc": "2.0",
            "id": 7,
            "method": "cursor/create_plan",
            "params": { "plan": "1. do the thing" }
        });
        let mut req_bytes = serde_json::to_vec(&request).unwrap();
        req_bytes.push(b'\n');
        agent_to_client_w.write_all(&req_bytes).await.unwrap();
        agent_to_client_w.flush().await.unwrap();

        let mut reader = BufReader::new(client_to_agent_r);
        let mut line = String::new();
        tokio::time::timeout(
            std::time::Duration::from_secs(2),
            reader.read_line(&mut line),
        )
        .await
        .expect("timed out waiting for response")
        .unwrap();
        let resp: Value = serde_json::from_str(line.trim()).unwrap();
        assert_eq!(resp["id"], 7);
        assert_eq!(resp["result"]["outcome"]["outcome"], "accepted");
        client.shutdown().await;
    }

    #[test]
    fn sign_in_errors_are_recognised_across_agents() {
        for msg in [
            // Grok / Kimi session/new, as cold_start formats it.
            "session/new failed: ACP error -32000: Authentication required — no auth method id provided",
            "Kimi authentication failed (ACP error -32000: Authentication required). Run `kimi` in a terminal and `/login` first.",
            // Cursor's documented wording, Copilot's, and Hermes' equivalent.
            "session/new failed: ACP error -32603: Not authenticated",
            "session/new failed: ACP error -32603: Internal error — Error: No authentication information found",
            "session/new failed: ACP error -32603: Internal error — No LLM provider configured. Run `hermes model` to select a provider.",
            // Grok's prompt-time expiry.
            "Grok prompt failed: ACP error -32000: Authentication required — your session has expired",
        ] {
            assert!(is_sign_in_error(msg), "{msg}");
        }
        // A different -32000 (Fleetify's own handler error) and plain failures
        // must NOT turn into a sign-in card.
        for msg in [
            "session/new failed: ACP error -32000: Invalid params",
            "Grok CLI not found. Install: …",
            "Cursor prompt failed: ACP error -32603: Internal error",
        ] {
            assert!(!is_sign_in_error(msg), "{msg}");
        }
    }

    #[test]
    fn format_acp_error_surfaces_data_details() {
        // Hermes' real shape: generic message, actionable text in data.details.
        let err = json!({
            "code": -32603,
            "message": "Internal error",
            "data": { "details": "No LLM provider configured. Run `hermes model` to select a provider." }
        });
        let s = format_acp_error(&err);
        assert!(s.contains("-32603"), "keeps the code: {s}");
        assert!(s.contains("Internal error"), "keeps the message: {s}");
        assert!(
            s.contains("No LLM provider configured. Run `hermes model` to select a provider."),
            "surfaces the actionable detail: {s}"
        );
    }

    #[test]
    fn format_acp_error_falls_back_to_string_data() {
        // Some agents put a bare string in `data` instead of `data.details`.
        let s = format_acp_error(
            &json!({ "code": -32000, "message": "boom", "data": "extra context" }),
        );
        assert_eq!(s, "ACP error -32000: boom — extra context");
    }

    #[test]
    fn format_acp_error_without_detail_is_code_and_message() {
        let s = format_acp_error(&json!({ "code": -32601, "message": "Method not found" }));
        assert_eq!(s, "ACP error -32601: Method not found");
    }

    #[test]
    fn format_acp_error_skips_detail_that_duplicates_message() {
        // No double-printing when details just echoes the message.
        let s =
            format_acp_error(&json!({ "code": 1, "message": "dup", "data": { "details": "dup" } }));
        assert_eq!(s, "ACP error 1: dup");
    }

    #[test]
    fn format_acp_error_handles_empty_message_with_detail() {
        let s = format_acp_error(&json!({ "code": -32603, "data": { "details": "why it broke" } }));
        assert_eq!(s, "ACP error -32603 — why it broke");
    }

    #[test]
    fn format_acp_error_surfaces_alternative_data_keys() {
        // Some agents put the cause under `data.error` / `data.reason`, not
        // `data.details`. Surface those too instead of dropping them.
        let s = format_acp_error(&json!({
            "code": -32603, "message": "Internal error",
            "data": { "error": "model not enabled for this account" }
        }));
        assert!(s.contains("-32603"), "keeps the code: {s}");
        assert!(
            s.contains("model not enabled for this account"),
            "surfaces data.error: {s}"
        );
        let r = format_acp_error(&json!({
            "code": -32000, "message": "bad", "data": { "reason": "rate limited" }
        }));
        assert_eq!(r, "ACP error -32000: bad — rate limited");
    }

    #[test]
    fn format_acp_error_drops_unrecognised_object_data() {
        // An object with no known string key isn't dumped into chat (the full
        // raw error is logged for diagnosis instead).
        let s = format_acp_error(&json!({
            "code": -32603, "message": "Internal error", "data": { "trace_id": "abc123" }
        }));
        assert_eq!(s, "ACP error -32603: Internal error");
    }
}
