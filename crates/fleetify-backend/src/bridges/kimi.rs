//! Kimi (Moonshot) Code CLI bridge — placeholder.
//!
//! The wire-up (AnyBridge variant, chat.rs dispatch arm, AgentKind,
//! `[agents.kimi]` capability matrix entry, registry-driven scan +
//! Settings → Agents tile) is in place so the moment the actual
//! `kimi acp` protocol is documented and stable, swapping this file for
//! a gemini.rs-style clone is the only remaining step. Until then,
//! attempting to spawn a Kimi session surfaces a clean error to the
//! chat instead of crashing the bridge dispatcher.
//!
//! Why not a full clone today: the Kimi Code CLI's ACP interface
//! isn't publicly stable yet. Cloning the gemini.rs spawn + handshake
//! verbatim risks shipping a "looks like it works" bridge that fails
//! at runtime in ways the user can't diagnose. The placeholder keeps
//! the contract honest.

use std::sync::Arc;

use tokio::sync::mpsc;

use super::BridgeEvent;

pub struct KimiBridge {
    pub session_id: String,
    pub model: String,
    pub agent_cwd: String,
    aborted: Arc<std::sync::atomic::AtomicBool>,
}

impl KimiBridge {
    pub fn new(
        session_id: impl Into<String>,
        agent_cwd: impl Into<String>,
        _permission_mode: String,
        model_name: Option<String>,
        _is_staff: bool,
        _agent_template: Option<String>,
    ) -> Self {
        Self {
            session_id: session_id.into(),
            model: model_name.unwrap_or_else(|| "kimi-k2-instruct".into()),
            agent_cwd: agent_cwd.into(),
            aborted: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        }
    }

    pub async fn abort(&self) {
        self.aborted
            .store(true, std::sync::atomic::Ordering::SeqCst);
    }

    pub async fn send_message(
        &self,
        _message: &str,
        _ctx: super::BridgeContext,
    ) -> anyhow::Result<mpsc::Receiver<BridgeEvent>> {
        let (tx, rx) = mpsc::channel::<BridgeEvent>(4);
        let sid = self.session_id.clone();
        let model = self.model.clone();
        tokio::spawn(async move {
            // Honest "init" so the UI still gets the model-name pill
            // and the session leaves the pending state cleanly.
            let _ = tx
                .send(BridgeEvent::Init {
                    session_id: sid.clone(),
                    claude_session_id: Some(sid.clone()),
                    model,
                    tools_count: 0,
                })
                .await;
            let _ = tx
                .send(BridgeEvent::Error {
                    error: "Kimi Code CLI bridge is wired but not yet implemented. \
                            The registry / Settings / dispatch surface is ready — once \
                            `kimi acp` ships a documented protocol, the spawn + ACP \
                            handshake will land in this file as a gemini.rs-style clone."
                        .into(),
                })
                .await;
            let _ = tx
                .send(BridgeEvent::Status {
                    status: "done".into(),
                })
                .await;
        });
        Ok(rx)
    }
}
