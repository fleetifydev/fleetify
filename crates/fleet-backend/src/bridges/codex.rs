//! Phase 2 stub for the Codex v2-protocol bridge. The full faithful port
//! (thread/turn lifecycle, item/{commandExecution,fileChange,...} delta
//! mapping, unified-diff parse, approval method translation, fs handlers)
//! lands later in Phase 2. Stub emits a clear "not implemented" + done
//! so /ws/sessions dispatch surfaces something honest in the chat UI.

use tokio::sync::mpsc;

use super::BridgeEvent;

pub struct CodexBridge {
    pub session_id: String,
}

impl CodexBridge {
    pub fn new(session_id: impl Into<String>) -> Self {
        Self { session_id: session_id.into() }
    }
    pub async fn send_message(
        &self,
        _msg: &str,
    ) -> anyhow::Result<mpsc::Receiver<BridgeEvent>> {
        let (tx, rx) = mpsc::channel::<BridgeEvent>(8);
        let _ = tx
            .send(BridgeEvent::Error {
                error: "Codex bridge not yet implemented (Phase 2 follow-up)".into(),
            })
            .await;
        let _ = tx.send(BridgeEvent::Status { status: "done".into() }).await;
        Ok(rx)
    }
    pub async fn abort(&self) {}
}
