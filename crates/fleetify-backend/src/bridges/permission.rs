//! Cross-bridge permission plumbing.
//!
//! Faithful port of the `permission_handler` flow from the reference
//! Python build (`backend/app/routers/chat.py::_run_send_flow`). Each
//! WS handler creates a per-session [`PermissionSession`] that owns:
//!
//!   • a request → `oneshot::Sender<bool>` map keyed by request_id;
//!   • a session-scoped `always_allow` set for tools the user has
//!     pre-approved via the "Always allow" checkbox in the dialog.
//!
//! The closure handed to bridges (`make_handler`) returns a
//! [`PermissionHandler`] that:
//!   1. fast-paths approval when the tool name is in `always_allow`,
//!   2. otherwise generates a UUID, parks a oneshot sender in the map,
//!      ships a `tool_permission_request` payload via the WS sink, and
//!   3. awaits the receiver. The WS `permission_response` arm in
//!      `routers::chat` resolves the sender with the user's decision.
//!
//! On disconnect / error the WS handler MUST call
//! [`PermissionSession::fail_all_pending`] so bridge tasks waiting on
//! the receivers unblock instead of leaking forever. The Python build
//! does this in its `finally:` block — same pattern here.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use serde_json::{json, Value};
use tokio::sync::{oneshot, Mutex};
use uuid::Uuid;

/// Bridge-facing async callback. Returns `true` when the user approves
/// the tool, `false` when they deny it OR when the session shuts down
/// before they respond. The signature mirrors
/// `bridges::codex_client::ApprovalHandler` and Gemini's
/// `on_permission_request` so each bridge can adapt with a thin
/// closure.
pub type PermissionHandler = Arc<
    dyn Fn(String, Value) -> Pin<Box<dyn Future<Output = bool> + Send>> + Send + Sync,
>;

type PendingMap = HashMap<String, oneshot::Sender<bool>>;

/// Per-WS-session state for the in-flight permission flow.
#[derive(Default)]
pub struct PermissionSession {
    /// `req_id → sender` for every prompt currently parked awaiting
    /// the user's response. Sealed when the user replies or the
    /// session ends.
    pending: Mutex<PendingMap>,
    /// Tool names the user pre-approved via "Always allow". A
    /// HashSet so subsequent prompts for the same tool skip the
    /// round-trip entirely.
    always_allow: Mutex<HashSet<String>>,
}

impl PermissionSession {
    pub fn new() -> Self {
        Self::default()
    }

    /// Build the handler closure that bridges plug into their approval
    /// hook. Captures the session + a sink-sender that ships the
    /// outbound `tool_permission_request` payload. We don't hand a
    /// `tauri::WebSocket` directly because the chat router's sink type
    /// is wrapped in arcs / mutexes; a generic `Fn(Value) → Future`
    /// keeps this module unaware of those wrappers.
    pub fn make_handler<F>(self: &Arc<Self>, send_payload: F) -> PermissionHandler
    where
        F: Fn(Value) -> Pin<Box<dyn Future<Output = ()> + Send>> + Send + Sync + 'static,
    {
        let me = Arc::clone(self);
        let sender = Arc::new(send_payload);
        Arc::new(move |tool_name: String, tool_input: Value| {
            let me = Arc::clone(&me);
            let sender = Arc::clone(&sender);
            Box::pin(async move { me.request(tool_name, tool_input, sender).await })
        })
    }

    /// Internal: actually run a single permission round-trip.
    async fn request<F>(
        &self,
        tool_name: String,
        tool_input: Value,
        send_payload: Arc<F>,
    ) -> bool
    where
        F: Fn(Value) -> Pin<Box<dyn Future<Output = ()> + Send>> + Send + Sync + 'static,
    {
        // Fast-path: always-allow set hit.
        if !tool_name.is_empty()
            && self.always_allow.lock().await.contains(&tool_name)
        {
            tracing::debug!(target: "perm", tool = %tool_name, "auto-allow (always_allow)");
            return true;
        }
        let req_id = Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel::<bool>();
        self.pending.lock().await.insert(req_id.clone(), tx);

        let payload = json!({
            "type": "tool_permission_request",
            "id": req_id,
            "tool_name": tool_name,
            "tool_description": Value::Null,
            "command": format_command(&tool_name, &tool_input),
        });
        send_payload(payload).await;

        tracing::info!(target: "perm", tool = %tool_name, req_id = %req_id, "request.sent");
        let decision = rx.await.unwrap_or_else(|_| {
            tracing::warn!(
                target: "perm",
                req_id = %req_id,
                "sender dropped (session disconnect?) — denying"
            );
            false
        });
        self.pending.lock().await.remove(&req_id);
        tracing::info!(target: "perm", tool = %tool_name, req_id = %req_id, approved = decision, "request.resolved");
        decision
    }

    /// Resolve the matching pending request with the user's decision.
    /// Returns `true` when a sender was actually waiting (so chat.rs
    /// can log "stale response" otherwise).
    pub async fn resolve(&self, req_id: &str, approved: bool) -> bool {
        let Some(tx) = self.pending.lock().await.remove(req_id) else {
            return false;
        };
        let _ = tx.send(approved);
        true
    }

    /// Record an always-allow entry. Empty `tool_name` is a no-op
    /// (defensive — the renderer sends `""` when it didn't get the
    /// name from the bridge in time).
    pub async fn allow_always(&self, tool_name: &str) {
        if tool_name.is_empty() {
            return;
        }
        self.always_allow
            .lock()
            .await
            .insert(tool_name.to_string());
    }

    /// Resolve every currently-pending request with `false`. Used in
    /// the WS handler's `finally`/drop path so bridge callbacks awaiting
    /// these futures don't leak when the user closes the chat
    /// mid-prompt.
    pub async fn fail_all_pending(&self) {
        let mut map = self.pending.lock().await;
        for (_, tx) in map.drain() {
            let _ = tx.send(false);
        }
    }
}

/// Human-readable single-line description of what the tool will do.
/// Surfaces in the renderer's permission dialog above the chat input
/// so the user knows what they're approving without digging into the
/// raw JSON payload.
///
/// Port of `_format_permission_command` from
/// `backend/app/routers/chat.py`. Same tool-name → field mapping; the
/// "fallback to a compact JSON view" tail is mirrored too so unknown
/// tools still surface something useful.
pub fn format_command(tool_name: &str, tool_input: &Value) -> String {
    let name = tool_name.to_ascii_lowercase();
    let get = |k: &str| {
        tool_input
            .get(k)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string()
    };

    match name.as_str() {
        "bash" | "powershell" => {
            let cmd = get("command");
            let trimmed = cmd.trim();
            if trimmed.is_empty() {
                "(no command)".into()
            } else {
                trimmed.to_string()
            }
        }
        "write" => {
            let path = first_nonempty(&[get("file_path"), get("path")]);
            let content = get("content");
            let lines = if content.is_empty() {
                0
            } else {
                content.matches('\n').count() + 1
            };
            let unit = if lines == 1 { "line" } else { "lines" };
            format!("{path}  ·  +{lines} {unit}")
        }
        "edit" | "multiedit" | "read" | "notebookread" => {
            first_nonempty(&[get("file_path"), get("path")])
        }
        "glob" | "grep" => get("pattern"),
        "webfetch" | "websearch" => first_nonempty(&[get("url"), get("query")]),
        "askuserquestion" => first_nonempty(&[
            get("question"),
            get("prompt"),
            get("text"),
        ])
        .trim()
        .to_string(),
        "exitplanmode" => {
            let plan = first_nonempty(&[
                get("plan"),
                get("message"),
                get("summary"),
                get("content"),
            ])
            .trim()
            .to_string();
            plan.chars().take(600).collect()
        }
        "enterplanmode" => String::new(),
        _ => {
            // Fallback — pretty compact JSON, trimmed.
            let s = serde_json::to_string(tool_input).unwrap_or_default();
            s.chars().take(280).collect()
        }
    }
}

fn first_nonempty(candidates: &[String]) -> String {
    for c in candidates {
        if !c.is_empty() {
            return c.clone();
        }
    }
    String::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_bash_command() {
        let v = json!({"command": "ls -la"});
        assert_eq!(format_command("Bash", &v), "ls -la");
    }

    #[test]
    fn format_bash_empty() {
        let v = json!({});
        assert_eq!(format_command("bash", &v), "(no command)");
    }

    #[test]
    fn format_write_counts_lines() {
        let v = json!({"file_path": "/a/b.txt", "content": "x\ny\nz"});
        assert_eq!(format_command("Write", &v), "/a/b.txt  ·  +3 lines");
    }

    #[test]
    fn format_write_single_line_singular() {
        let v = json!({"path": "x", "content": "one"});
        assert_eq!(format_command("write", &v), "x  ·  +1 line");
    }

    #[test]
    fn format_unknown_falls_back_to_json() {
        let v = json!({"foo": "bar"});
        let out = format_command("OddTool", &v);
        assert!(out.contains("foo") && out.contains("bar"));
    }

    #[tokio::test]
    async fn allow_always_short_circuits() {
        let s = Arc::new(PermissionSession::new());
        s.allow_always("Read").await;
        // Make a no-op sink — if the closure fired it'd be observable
        // via a counter, but we just verify the future resolves true
        // without us resolving any pending entry.
        let h = s.make_handler(|_payload| Box::pin(async {}));
        let ok = h("Read".into(), json!({"file_path": "x"})).await;
        assert!(ok);
        assert!(s.pending.lock().await.is_empty());
    }

    #[tokio::test]
    async fn resolve_delivers_decision() {
        let s = Arc::new(PermissionSession::new());
        let s2 = Arc::clone(&s);
        let h = s.make_handler(move |payload| {
            // Pretend to be the WS sink: pull the id and resolve it
            // approved on a background task so the awaiter unblocks.
            let s2 = Arc::clone(&s2);
            Box::pin(async move {
                let id = payload["id"].as_str().unwrap().to_string();
                tokio::spawn(async move {
                    s2.resolve(&id, true).await;
                });
            })
        });
        let ok = h("Bash".into(), json!({"command": "echo hi"})).await;
        assert!(ok);
        assert!(s.pending.lock().await.is_empty());
    }

    #[tokio::test]
    async fn fail_all_pending_unblocks_awaiters() {
        let s = Arc::new(PermissionSession::new());
        let h = s.make_handler(|_payload| Box::pin(async {}));
        let s2 = Arc::clone(&s);
        let task = tokio::spawn(async move {
            h("Bash".into(), json!({})).await
        });
        // Give the closure a beat to register itself in pending.
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        s2.fail_all_pending().await;
        let ok = task.await.unwrap();
        assert!(!ok);
    }
}
