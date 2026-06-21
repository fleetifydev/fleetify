//! Generic JSON-RPC 2.0 client for the Codex V2 protocol over stdio.
//!
//! Faithful port of `services/codex_client.py`. Wire format defined by
//! `codex app-server --listen stdio://`; request ids are UUID strings,
//! method names use slash format (e.g. `thread/start`,
//! `item/agentMessage/delta`).
//!
//! Differences from ACP:
//! - UUID string ids (not integer counters).
//! - Approval handler signature is `(method, params) → result` (the
//!   handler needs to know which of the 5 approval methods fired).
//! - Per-method notification handlers — Codex emits dozens of
//!   `item/*` notification methods and the bridge layer registers a
//!   handler per method (HashMap dispatch).
//! - `initialize` → `initialized` (notification) handshake is required
//!   before any other request is accepted.

use std::collections::HashMap;
use std::pin::Pin;
use std::sync::Arc;

use anyhow::{anyhow, Result};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{oneshot, Mutex};

type PendingMap = HashMap<String, oneshot::Sender<Result<Value>>>;

/// Handler for inbound `(method, params) → result` requests — used by
/// the 5 approval methods which all funnel through a single dispatcher
/// in the bridge layer.
pub type ApprovalHandler = Arc<
    dyn Fn(String, Value) -> Pin<Box<dyn std::future::Future<Output = Result<Value>> + Send>>
        + Send
        + Sync,
>;

/// Handler for inbound `params → result` requests
/// (fs/readFile, fs/writeFile, item/tool/requestUserInput).
pub type RequestHandler = Arc<
    dyn Fn(Value) -> Pin<Box<dyn std::future::Future<Output = Result<Value>> + Send>> + Send + Sync,
>;

/// Handler for inbound notifications (no response expected).
pub type NotificationHandler =
    Arc<dyn Fn(Value) -> Pin<Box<dyn std::future::Future<Output = ()> + Send>> + Send + Sync>;

#[derive(Default)]
struct Handlers {
    approval: Option<ApprovalHandler>,
    fs_read: Option<RequestHandler>,
    fs_write: Option<RequestHandler>,
    user_input: Option<RequestHandler>,
    notifications: HashMap<String, NotificationHandler>,
}

const APPROVAL_METHODS: &[&str] = &[
    "item/permissions/requestApproval",
    "item/fileChange/requestApproval",
    "item/commandExecution/requestApproval",
    // legacy aliases (verified against codex_app_server_protocol.schemas.json)
    "execCommandApproval",
    "applyPatchApproval",
];

type DynWriter = Pin<Box<dyn tokio::io::AsyncWrite + Send + Unpin>>;
type DynReader = Pin<Box<dyn tokio::io::AsyncBufRead + Send + Unpin>>;

pub struct CodexClient {
    writer: Arc<Mutex<Option<DynWriter>>>,
    pending: Arc<Mutex<PendingMap>>,
    handlers: Arc<Mutex<Handlers>>,
    read_task: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl Default for CodexClient {
    fn default() -> Self {
        Self::new()
    }
}

impl CodexClient {
    pub fn new() -> Self {
        Self {
            writer: Arc::new(Mutex::new(None)),
            pending: Arc::new(Mutex::new(HashMap::new())),
            handlers: Arc::new(Mutex::new(Handlers::default())),
            read_task: Mutex::new(None),
        }
    }

    pub async fn attach<R, W>(&self, reader: R, writer: W) -> Result<()>
    where
        R: tokio::io::AsyncRead + Send + Unpin + 'static,
        W: tokio::io::AsyncWrite + Send + Unpin + 'static,
    {
        let mut task = self.read_task.lock().await;
        if task.as_ref().is_some_and(|h| !h.is_finished()) {
            return Err(anyhow!("CodexClient already attached"));
        }
        let dyn_w: DynWriter = Box::pin(writer);
        *self.writer.lock().await = Some(dyn_w);
        let dyn_r: DynReader = Box::pin(BufReader::new(reader));
        let pending = self.pending.clone();
        let handlers = self.handlers.clone();
        let writer_ref = self.writer.clone();
        let handle = tokio::spawn(read_loop(dyn_r, pending, handlers, writer_ref));
        *task = Some(handle);
        Ok(())
    }

    pub async fn is_running(&self) -> bool {
        self.read_task
            .lock()
            .await
            .as_ref()
            .is_some_and(|h| !h.is_finished())
    }

    pub async fn shutdown(&self) {
        if let Some(handle) = self.read_task.lock().await.take() {
            handle.abort();
        }
        let mut pending = self.pending.lock().await;
        for (_, tx) in pending.drain() {
            let _ = tx.send(Err(anyhow!("CodexClient shut down")));
        }
        *self.writer.lock().await = None;
    }

    pub async fn on_approval_request(&self, h: ApprovalHandler) {
        self.handlers.lock().await.approval = Some(h);
    }
    pub async fn on_fs_read(&self, h: RequestHandler) {
        self.handlers.lock().await.fs_read = Some(h);
    }
    pub async fn on_fs_write(&self, h: RequestHandler) {
        self.handlers.lock().await.fs_write = Some(h);
    }
    pub async fn on_user_input(&self, h: RequestHandler) {
        self.handlers.lock().await.user_input = Some(h);
    }
    pub async fn on_notification(&self, method: impl Into<String>, h: NotificationHandler) {
        self.handlers
            .lock()
            .await
            .notifications
            .insert(method.into(), h);
    }

    pub async fn call(&self, method: &str, params: Value) -> Result<Value> {
        let id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id.clone(), tx);
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
            Err(_) => Err(anyhow!("Codex response channel dropped")),
        }
    }

    pub async fn notify(&self, method: &str, params: Value) -> Result<()> {
        let frame = json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        });
        write_frame(&self.writer, &frame).await
    }

    // ── Typed V2 lifecycle ───────────────────────────────────────
    pub async fn initialize(
        &self,
        client_name: &str,
        client_version: &str,
        client_title: Option<&str>,
        opt_out_notification_methods: Option<Vec<String>>,
    ) -> Result<Value> {
        let mut client_info = serde_json::Map::new();
        client_info.insert("name".into(), Value::String(client_name.to_string()));
        client_info.insert("version".into(), Value::String(client_version.to_string()));
        if let Some(t) = client_title {
            client_info.insert("title".into(), Value::String(t.to_string()));
        }
        let mut params = serde_json::Map::new();
        params.insert("clientInfo".into(), Value::Object(client_info));
        if let Some(opts) = opt_out_notification_methods {
            params.insert(
                "capabilities".into(),
                json!({
                    "experimentalApi": true,
                    "optOutNotificationMethods": opts,
                }),
            );
        }
        self.call("initialize", Value::Object(params)).await
    }

    /// Send the post-initialize `initialized` notification.
    pub async fn send_initialized(&self) -> Result<()> {
        self.notify("initialized", json!({})).await
    }

    pub async fn thread_start(
        &self,
        cwd: &str,
        sandbox: &str,
        approval: &str,
        model: Option<&str>,
        config: Option<Value>,
    ) -> Result<String> {
        let mut params = serde_json::Map::new();
        params.insert("cwd".into(), Value::String(cwd.to_string()));
        params.insert("sandbox".into(), Value::String(sandbox.to_string()));
        params.insert("approvalPolicy".into(), Value::String(approval.to_string()));
        if let Some(m) = model {
            params.insert("model".into(), Value::String(m.to_string()));
        }
        if let Some(c) = config {
            params.insert("config".into(), c);
        }
        let r = self.call("thread/start", Value::Object(params)).await?;
        r.get("thread")
            .and_then(|t| t.get("id"))
            .and_then(|v| v.as_str())
            .map(String::from)
            .ok_or_else(|| anyhow!("thread/start: missing thread.id"))
    }

    pub async fn thread_resume(
        &self,
        thread_id: &str,
        cwd: &str,
        config: Option<Value>,
    ) -> Result<()> {
        let mut params = serde_json::Map::new();
        params.insert("threadId".into(), Value::String(thread_id.to_string()));
        params.insert("cwd".into(), Value::String(cwd.to_string()));
        if let Some(c) = config {
            params.insert("config".into(), c);
        }
        self.call("thread/resume", Value::Object(params)).await?;
        Ok(())
    }

    pub async fn thread_inject_items(&self, thread_id: &str, items: Value) -> Result<Value> {
        self.call(
            "thread/inject_items",
            json!({ "threadId": thread_id, "items": items }),
        )
        .await
    }

    pub async fn turn_start(
        &self,
        thread_id: &str,
        input_items: Value,
        model: Option<&str>,
    ) -> Result<Value> {
        let mut params = serde_json::Map::new();
        params.insert("threadId".into(), Value::String(thread_id.to_string()));
        params.insert("input".into(), input_items);
        if let Some(m) = model {
            params.insert("model".into(), Value::String(m.to_string()));
        }
        self.call("turn/start", Value::Object(params)).await
    }

    /// Start a code review (the app-server equivalent of the TUI `/review`).
    /// `target` is an internally-tagged `ReviewTarget`, e.g.
    /// `{ "type": "uncommittedChanges" }` — verified against a live
    /// `codex app-server`. Returns a `turn` that streams like any other turn.
    pub async fn review_start(&self, thread_id: &str, target: Value) -> Result<Value> {
        self.call(
            "review/start",
            json!({ "threadId": thread_id, "target": target }),
        )
        .await
    }

    pub async fn thread_list(&self, cwd: Option<&str>) -> Result<Vec<Value>> {
        let params = match cwd {
            Some(c) => json!({ "cwd": c }),
            None => Value::Object(Default::default()),
        };
        let result = self.call("thread/list", params).await?;
        // ThreadListResponse.required = ["data"]; tolerate legacy aliases.
        for key in ["data", "threads", "items"] {
            if let Some(arr) = result.get(key).and_then(|v| v.as_array()) {
                return Ok(arr.clone());
            }
        }
        Ok(Vec::new())
    }

    pub async fn turn_interrupt(&self, thread_id: &str, turn_id: &str) -> Result<()> {
        self.call(
            "turn/interrupt",
            json!({ "threadId": thread_id, "turnId": turn_id }),
        )
        .await?;
        Ok(())
    }
}

async fn write_frame(writer: &Arc<Mutex<Option<DynWriter>>>, frame: &Value) -> Result<()> {
    let mut guard = writer.lock().await;
    let Some(w) = guard.as_mut() else {
        return Err(anyhow!("CodexClient not attached"));
    };
    let mut line = serde_json::to_vec(frame)?;
    line.push(b'\n');
    w.write_all(&line).await?;
    w.flush().await?;
    Ok(())
}

async fn write_result(writer: &Arc<Mutex<Option<DynWriter>>>, req_id: Value, result: Value) {
    let frame = json!({ "jsonrpc": "2.0", "id": req_id, "result": result });
    let _ = write_frame(writer, &frame).await;
}

async fn write_error(
    writer: &Arc<Mutex<Option<DynWriter>>>,
    req_id: Value,
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
        match reader.read_line(&mut line).await {
            Ok(0) => break, // EOF
            Ok(_) => {}
            Err(e) => {
                tracing::warn!(target: "codex", "read_error: {e}");
                break;
            }
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let msg: Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!(target: "codex", "parse_error: {e} raw={}",
                    &trimmed.chars().take(200).collect::<String>());
                continue;
            }
        };
        dispatch(msg, &pending, &handlers, &writer).await;
    }
    // EOF → fail every pending future so callers don't hang.
    let mut map = pending.lock().await;
    for (_, tx) in map.drain() {
        let _ = tx.send(Err(anyhow!("Codex stream closed")));
    }
}

async fn dispatch(
    msg: Value,
    pending: &Arc<Mutex<PendingMap>>,
    handlers: &Arc<Mutex<Handlers>>,
    writer: &Arc<Mutex<Option<DynWriter>>>,
) {
    let id_value = msg.get("id").cloned();
    let has_result_or_error = msg.get("result").is_some() || msg.get("error").is_some();
    let method = msg.get("method").and_then(|v| v.as_str()).map(String::from);

    // Response to one of OUR requests (UUID string id).
    if let Some(id_v) = &id_value {
        if has_result_or_error {
            let id_str = id_v.as_str().unwrap_or("").to_string();
            if !id_str.is_empty() {
                if let Some(tx) = pending.lock().await.remove(&id_str) {
                    if let Some(err) = msg.get("error") {
                        let code = err.get("code").and_then(|v| v.as_i64()).unwrap_or(0);
                        let m = err
                            .get("message")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        let _ = tx.send(Err(anyhow!("Codex error {code}: {m}")));
                    } else {
                        let r = msg.get("result").cloned().unwrap_or(Value::Null);
                        let _ = tx.send(Ok(r));
                    }
                }
            }
            return;
        }
        if let Some(m) = method {
            handle_inbound_request(id_v.clone(), m, msg, handlers.clone(), writer.clone()).await;
            return;
        }
    }
    if let Some(m) = method {
        handle_inbound_notification(m, msg, handlers.clone()).await;
    }
}

async fn handle_inbound_request(
    req_id: Value,
    method: String,
    msg: Value,
    handlers: Arc<Mutex<Handlers>>,
    writer: Arc<Mutex<Option<DynWriter>>>,
) {
    let params = msg
        .get("params")
        .cloned()
        .unwrap_or(Value::Object(Default::default()));

    let (approval, fs_read, fs_write, user_input) = {
        let g = handlers.lock().await;
        (
            g.approval.clone(),
            g.fs_read.clone(),
            g.fs_write.clone(),
            g.user_input.clone(),
        )
    };

    if APPROVAL_METHODS.contains(&method.as_str()) {
        let Some(h) = approval else {
            write_error(
                &writer,
                req_id,
                -32601,
                format!("Method not handled: {method}"),
            )
            .await;
            return;
        };
        let method_for_handler = method.clone();
        tokio::spawn(async move {
            match h(method_for_handler, params).await {
                Ok(v) => write_result(&writer, req_id, v).await,
                Err(e) => {
                    tracing::warn!(target: "codex", "handler_error method={method} error={e}");
                    write_error(&writer, req_id, -32000, e.to_string()).await;
                }
            }
        });
        return;
    }

    let handler = match method.as_str() {
        "fs/readFile" => fs_read,
        "fs/writeFile" => fs_write,
        "item/tool/requestUserInput" => user_input,
        _ => None,
    };
    let Some(h) = handler else {
        write_error(
            &writer,
            req_id,
            -32601,
            format!("Method not handled: {method}"),
        )
        .await;
        return;
    };
    tokio::spawn(async move {
        match h(params).await {
            Ok(v) => write_result(&writer, req_id, v).await,
            Err(e) => {
                tracing::warn!(target: "codex", "handler_error method={method} error={e}");
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
    let h = handlers.lock().await.notifications.get(&method).cloned();
    if let Some(h) = h {
        // Await directly instead of spawning — spawning concurrent tasks caused
        // delta tokens to arrive out-of-order, producing garbled streamed text.
        h(params).await;
    }
    // Codex emits dozens of notification types; silently ignore unregistered ones.
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{duplex, AsyncBufReadExt, AsyncWriteExt, BufReader};

    /// initialize → returns the response; UUID id round-trips intact.
    #[tokio::test]
    async fn call_resolves_with_response_keyed_by_uuid_id() {
        let (client_to_agent_r, client_to_agent_w) = duplex(4096);
        let (mut agent_to_client_w, agent_to_client_r) = duplex(4096);

        let client = Arc::new(CodexClient::new());
        client
            .attach(agent_to_client_r, client_to_agent_w)
            .await
            .unwrap();

        let agent = tokio::spawn(async move {
            let mut reader = BufReader::new(client_to_agent_r);
            let mut line = String::new();
            reader.read_line(&mut line).await.unwrap();
            let msg: Value = serde_json::from_str(line.trim()).unwrap();
            // V2 ids are UUID strings (not integers).
            let id = msg["id"].as_str().unwrap().to_string();
            assert_eq!(msg["method"], "initialize");
            assert_eq!(msg["params"]["clientInfo"]["name"], "Fleet");
            let reply = json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": {
                    "userAgent": "codex/0",
                    "codexHome": "/tmp",
                    "platformFamily": "windows",
                    "platformOs": "win"
                }
            });
            let mut bytes = serde_json::to_vec(&reply).unwrap();
            bytes.push(b'\n');
            agent_to_client_w.write_all(&bytes).await.unwrap();
            agent_to_client_w.flush().await.unwrap();
        });

        let r = client
            .initialize("Fleet", "0.1.0", Some("Fleetify"), None)
            .await
            .unwrap();
        assert_eq!(r["userAgent"], "codex/0");
        let _ = agent.await;
        client.shutdown().await;
    }

    /// Approval handler runs for any of the 5 V2 approval methods and
    /// gets the method string AND params (single dispatcher pattern).
    #[tokio::test]
    async fn approval_handler_dispatches_all_5_methods() {
        let (client_to_agent_r, client_to_agent_w) = duplex(4096);
        let (mut agent_to_client_w, agent_to_client_r) = duplex(4096);

        let client = Arc::new(CodexClient::new());
        client
            .attach(agent_to_client_r, client_to_agent_w)
            .await
            .unwrap();

        let captured = Arc::new(Mutex::new(Vec::<String>::new()));
        let captured_handler = captured.clone();
        client
            .on_approval_request(Arc::new(move |method, _params| {
                let captured = captured_handler.clone();
                Box::pin(async move {
                    captured.lock().await.push(method.clone());
                    Ok(json!({ "decision": "approved" }))
                })
            }))
            .await;

        // Send 3 of the 5 approval requests; each should run through
        // the same handler and get its own response.
        for (i, m) in [
            "item/permissions/requestApproval",
            "item/fileChange/requestApproval",
            "execCommandApproval",
        ]
        .iter()
        .enumerate()
        {
            let req = json!({
                "jsonrpc": "2.0",
                "id": format!("req-{i}"),
                "method": m,
                "params": {}
            });
            let mut bytes = serde_json::to_vec(&req).unwrap();
            bytes.push(b'\n');
            agent_to_client_w.write_all(&bytes).await.unwrap();
            agent_to_client_w.flush().await.unwrap();
        }

        // Read 3 responses back.
        let mut reader = BufReader::new(client_to_agent_r);
        for _ in 0..3 {
            let mut line = String::new();
            tokio::time::timeout(
                std::time::Duration::from_secs(2),
                reader.read_line(&mut line),
            )
            .await
            .expect("timeout")
            .unwrap();
            let resp: Value = serde_json::from_str(line.trim()).unwrap();
            assert_eq!(resp["result"]["decision"], "approved");
        }

        let got = captured.lock().await.clone();
        assert!(got.contains(&"item/permissions/requestApproval".to_string()));
        assert!(got.contains(&"item/fileChange/requestApproval".to_string()));
        assert!(got.contains(&"execCommandApproval".to_string()));
        client.shutdown().await;
    }

    /// Per-method notification dispatch: registered handlers fire,
    /// unregistered ones are silently ignored (no `warning` log expected).
    #[tokio::test]
    async fn per_method_notification_dispatch() {
        let (_client_to_agent_r, client_to_agent_w) = duplex(4096);
        let (mut agent_to_client_w, agent_to_client_r) = duplex(4096);

        let client = Arc::new(CodexClient::new());
        client
            .attach(agent_to_client_r, client_to_agent_w)
            .await
            .unwrap();

        let counter = Arc::new(Mutex::new(0usize));
        let c2 = counter.clone();
        client
            .on_notification(
                "item/agentMessage/delta",
                Arc::new(move |_p| {
                    let c = c2.clone();
                    Box::pin(async move {
                        *c.lock().await += 1;
                    })
                }),
            )
            .await;

        for _ in 0..3 {
            let notif = json!({
                "jsonrpc": "2.0",
                "method": "item/agentMessage/delta",
                "params": {}
            });
            let mut bytes = serde_json::to_vec(&notif).unwrap();
            bytes.push(b'\n');
            agent_to_client_w.write_all(&bytes).await.unwrap();
            agent_to_client_w.flush().await.unwrap();
        }
        // One unregistered method — should NOT trip the handler.
        let other = json!({
            "jsonrpc": "2.0",
            "method": "item/turn/somethingNew",
            "params": {}
        });
        let mut bytes = serde_json::to_vec(&other).unwrap();
        bytes.push(b'\n');
        agent_to_client_w.write_all(&bytes).await.unwrap();
        agent_to_client_w.flush().await.unwrap();

        // Let the dispatchers run.
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert_eq!(*counter.lock().await, 3);
        client.shutdown().await;
    }
}
