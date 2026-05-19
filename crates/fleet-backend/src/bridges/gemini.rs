//! Phase 2 stub for the Gemini ACP-over-stdio bridge. The full faithful
//! port (faithful_translate_acp_tool_call, MCP server injection, oauth
//! method picker, fs/read|write handlers, item/agentMessage/delta parse)
//! lands later in Phase 2. For now, dispatch from /ws/sessions emits a
//! single clear error so the user knows their Gemini session can't run yet
//! (faithful "not implemented" — not silent).

use tokio::sync::mpsc;

use super::BridgeEvent;

pub struct GeminiBridge {
    pub session_id: String,
}

impl GeminiBridge {
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
                error: "Gemini bridge not yet implemented (Phase 2 follow-up)".into(),
            })
            .await;
        let _ = tx.send(BridgeEvent::Status { status: "done".into() }).await;
        Ok(rx)
    }
    pub async fn abort(&self) {}
}
