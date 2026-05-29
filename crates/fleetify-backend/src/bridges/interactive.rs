//! Renderer round-trip for an agent's *blocking* inbound ACP requests.
//!
//! Cursor sends blocking extension requests — `cursor/ask_question`
//! (multiple-choice) and `cursor/create_plan` (plan approval) — and stalls
//! until the client returns a JSON-RPC `result`. This is the same shape as the
//! tool-permission round-trip ([`super::permission::PermissionSession`]) except
//! the user's answer is an arbitrary JSON `outcome`, not a yes/no.
//!
//! Flow (mirrors `PermissionSession`):
//!   1. The bridge's `AcpClient::on_request` handler (built by [`make_handler`])
//!      mints a `req_id`, parks a `oneshot`, and ships a WS payload
//!      (`{type, id, ...request params}`) via the closure the chat router
//!      supplied.
//!   2. The renderer shows a card and POSTs back a `cursor_question_response` /
//!      `cursor_plan_response`; the WS arm calls [`resolve`], which fulfils the
//!      `oneshot`.
//!   3. The handler returns `Ok(outcome)` as the ACP `result`.
//!
//! On disconnect the chat router calls [`fail_all_pending`] so handlers parked
//! on a receiver unblock with a `cancelled` outcome instead of leaking.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use serde_json::{json, Value};
use tokio::sync::{oneshot, Mutex};
use uuid::Uuid;

use super::acp::RequestHandler;

type PendingMap = HashMap<String, oneshot::Sender<Value>>;

/// Per-WS-session state for in-flight blocking extension requests.
#[derive(Default)]
pub struct InteractiveRequestSession {
    pending: Mutex<PendingMap>,
}

impl InteractiveRequestSession {
    pub fn new() -> Self {
        Self::default()
    }

    /// Build an [`AcpClient`](super::acp::AcpClient) inbound-request handler for
    /// one extension method. `event_type` is the `type` tag stamped on the
    /// outbound WS payload (e.g. `"cursor_ask_question"`). `send_payload` ships
    /// that payload to the renderer (the chat router captures the WS sink +
    /// session id). The returned handler's `Ok(outcome)` becomes the ACP
    /// `result`; if the session ends first, it resolves to a `cancelled`
    /// outcome so the agent unblocks.
    pub fn make_handler<F>(
        self: &Arc<Self>,
        event_type: &'static str,
        send_payload: F,
    ) -> RequestHandler
    where
        F: Fn(Value) -> Pin<Box<dyn Future<Output = ()> + Send>> + Send + Sync + 'static,
    {
        let me = Arc::clone(self);
        let sender = Arc::new(send_payload);
        Arc::new(move |params: Value| {
            let me = Arc::clone(&me);
            let sender = Arc::clone(&sender);
            Box::pin(async move {
                let req_id = Uuid::new_v4().to_string();
                let (tx, rx) = oneshot::channel::<Value>();
                me.pending.lock().await.insert(req_id.clone(), tx);

                // Stamp the request's own fields with a `type` + `id` so the
                // renderer can route + correlate the response.
                let mut payload = match params {
                    Value::Object(m) => Value::Object(m),
                    other => json!({ "params": other }),
                };
                if let Value::Object(ref mut m) = payload {
                    m.insert("type".into(), json!(event_type));
                    m.insert("id".into(), json!(req_id));
                }
                sender(payload).await;
                tracing::info!(target: "cursor.interactive", method = %event_type, req_id = %req_id, "request.sent");

                let outcome = rx.await.unwrap_or_else(|_| {
                    tracing::warn!(target: "cursor.interactive", req_id = %req_id, "sender dropped — cancelling");
                    json!({ "outcome": { "outcome": "cancelled" } })
                });
                me.pending.lock().await.remove(&req_id);
                tracing::info!(target: "cursor.interactive", req_id = %req_id, "request.resolved");
                anyhow::Ok(outcome)
            })
        })
    }

    /// Resolve the matching pending request with the renderer's outcome JSON
    /// (the full ACP `result`, e.g. `{"outcome":{"outcome":"answered",...}}`).
    /// Returns `true` when a sender was actually waiting.
    pub async fn resolve(&self, req_id: &str, outcome: Value) -> bool {
        match self.pending.lock().await.remove(req_id) {
            Some(tx) => {
                let _ = tx.send(outcome);
                true
            }
            None => false,
        }
    }

    /// Resolve every currently-pending request with a `cancelled` outcome.
    /// Called from the WS handler's disconnect path so parked handlers unblock.
    pub async fn fail_all_pending(&self) {
        let mut map = self.pending.lock().await;
        for (_, tx) in map.drain() {
            let _ = tx.send(json!({ "outcome": { "outcome": "cancelled" } }));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn resolve_delivers_outcome() {
        let s = Arc::new(InteractiveRequestSession::new());
        let s2 = Arc::clone(&s);
        let h = s.make_handler("cursor_ask_question", move |payload| {
            // Pretend to be the WS sink: pull the id and resolve it.
            let s2 = Arc::clone(&s2);
            Box::pin(async move {
                let id = payload["id"].as_str().unwrap().to_string();
                tokio::spawn(async move {
                    s2.resolve(&id, json!({ "outcome": { "outcome": "skipped" } }))
                        .await;
                });
            })
        });
        let out = h(json!({ "questions": [] })).await.unwrap();
        assert_eq!(out["outcome"]["outcome"], "skipped");
        assert!(s.pending.lock().await.is_empty());
    }

    #[tokio::test]
    async fn fail_all_pending_cancels_awaiters() {
        let s = Arc::new(InteractiveRequestSession::new());
        let h = s.make_handler("cursor_create_plan", |_payload| Box::pin(async {}));
        let s2 = Arc::clone(&s);
        let task = tokio::spawn(async move { h(json!({ "plan": "x" })).await.unwrap() });
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        s2.fail_all_pending().await;
        let out = task.await.unwrap();
        assert_eq!(out["outcome"]["outcome"], "cancelled");
    }
}
