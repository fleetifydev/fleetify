//! Bridge wrapper that drives the shared `agentic::drive_agentic_loop`
//! for any provider whose `ToolAdapter` is wired up, then translates the
//! loop's `TurnEvent` stream into the per-bridge `BridgeEvent` stream
//! the chat WS handler already speaks.
//!
//! Why a thin wrapper instead of one variant per adapter
//! -----------------------------------------------------
//!
//! `AnyBridge` already has 9 variants for the legacy bridges; adding one
//! per agentic provider (OpenAI-compat-agentic, Anthropic-agentic, ...)
//! would double the surface and the boilerplate dispatch matches in
//! `chat.rs`. Instead, ALL agentic flows land in a single
//! `AnyBridge::Agentic(Arc<AgenticBridgeRunner>)` variant. The runner
//! owns a `Box<dyn ToolAdapter>` and stays provider-agnostic — adding a
//! second provider adapter is one new branch in `chat.rs` (constructing
//! the right adapter) with zero changes here.
//!
//! Event translation
//! -----------------
//!
//! | TurnEvent              | BridgeEvent                                |
//! |------------------------|--------------------------------------------|
//! | TextDelta              | MessageDelta                               |
//! | ThinkingDelta          | Thinking                                   |
//! | ToolStart { call }     | ToolStart { tool_id, name, input }         |
//! | ToolEnd  { result }    | ToolEnd  { tool_id, output, is_error }     |
//! | Usage   { in, out }    | Cost { usage, cost_usd, model }            |
//! | Error   { message }    | Error { error }                            |
//!
//! Plus a synthetic `Init` at the start (so the renderer's existing
//! session-init plumbing fires) and a `Status::done` at the end.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use parking_lot::Mutex;
use serde_json::{json, Value};
use tokio::sync::{mpsc, oneshot};

use crate::agentic::{
    catalog_v1, drive_agentic_loop, Mode, PermissionGate, Tool, ToolAdapter, ToolCall, ToolResult,
    TurnEvent, Workspace,
};

use super::BridgeEvent;

/// In-flight permission requests keyed by call_id. The bridge inserts on
/// ask() and the HTTP endpoint pops + signals when the user clicks
/// Approve/Deny in the renderer. `abort()` drains the map with a deny
/// to unblock any executor waiting on a oneshot the user will never
/// answer.
type PendingPermissions = Arc<Mutex<HashMap<String, oneshot::Sender<bool>>>>;

/// Gate that emits a `TurnEvent::PermissionRequest` and blocks on a
/// matching reply from the HTTP `/api/chat/permission_response` endpoint
/// (which finds this gate's pending entry by call_id and fires the
/// oneshot). 5-minute timeout deny — protects against forgotten dialogs
/// keeping the loop hung indefinitely. Aborting the bridge also drains
/// pending senders with deny so anything waiting wakes up.
struct InteractiveGate {
    sink: mpsc::Sender<TurnEvent>,
    pending: PendingPermissions,
}

#[async_trait::async_trait]
impl PermissionGate for InteractiveGate {
    async fn ask(&self, call_id: &str, tool_name: &str, input: &Value) -> bool {
        let (tx, rx) = oneshot::channel::<bool>();
        self.pending.lock().insert(call_id.to_string(), tx);
        let _ = self
            .sink
            .send(TurnEvent::PermissionRequest {
                call_id: call_id.to_string(),
                tool_name: tool_name.to_string(),
                input: input.clone(),
            })
            .await;

        match tokio::time::timeout(Duration::from_secs(300), rx).await {
            Ok(Ok(decision)) => decision,
            _ => {
                // Timed out or sender dropped: clean up the entry (no
                // longer of interest) and deny so the model adapts.
                self.pending.lock().remove(call_id);
                false
            }
        }
    }
}

pub struct AgenticBridgeRunner {
    pub session_id: String,
    pub model: String,
    pub adapter: Arc<dyn ToolAdapter>,
    pub workspace: Workspace,
    pub mode: Mode,
    pub system_prompt: String,
    pub catalog: Vec<Tool>,
    aborted: Arc<AtomicBool>,
    /// In-flight permission gates. Reused across send_message calls so
    /// the HTTP endpoint can route a click to whichever turn fired the
    /// request, even if a new turn started by then.
    pending: PendingPermissions,
}

impl AgenticBridgeRunner {
    pub fn new(
        session_id: impl Into<String>,
        model: impl Into<String>,
        adapter: Arc<dyn ToolAdapter>,
        workspace: Workspace,
        mode: Mode,
        system_prompt: impl Into<String>,
    ) -> Self {
        Self {
            session_id: session_id.into(),
            model: model.into(),
            adapter,
            workspace,
            mode,
            system_prompt: system_prompt.into(),
            catalog: catalog_v1(),
            aborted: Arc::new(AtomicBool::new(false)),
            pending: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn abort(&self) {
        // Cooperative flag for the loop driver between turns.
        self.aborted.store(true, Ordering::SeqCst);
        // Drain in-flight permission asks with deny so any awaiting
        // executor wakes up immediately. Without this, a runner that's
        // mid-ask would block until the 5-minute timeout in the
        // InteractiveGate even though abort() was clicked.
        let drained: Vec<_> = self.pending.lock().drain().collect();
        for (_, tx) in drained {
            let _ = tx.send(false);
        }
    }

    /// Resolve a pending permission request. Called by the HTTP
    /// `/api/chat/permission_response` endpoint when the user clicks
    /// Approve / Deny in the renderer. Returns true if the call_id
    /// matched a pending request (signal delivered), false if no such
    /// request was waiting (stale click, timeout already fired, etc.).
    pub fn resolve_permission(&self, call_id: &str, approved: bool) -> bool {
        let entry = self.pending.lock().remove(call_id);
        match entry {
            Some(tx) => tx.send(approved).is_ok(),
            None => false,
        }
    }

    pub async fn send_message(
        &self,
        msg: &str,
        _ctx: super::BridgeContext,
    ) -> Result<mpsc::Receiver<BridgeEvent>> {
        // Reset abort flag at the start of every turn so a session that
        // was aborted earlier can still send new messages.
        self.aborted.store(false, Ordering::SeqCst);

        let (be_tx, be_rx) = mpsc::channel::<BridgeEvent>(256);

        let adapter = self.adapter.clone();
        let workspace = self.workspace.clone();
        let mode = self.mode;
        let system_prompt = self.system_prompt.clone();
        let catalog = self.catalog.clone();
        let aborted = self.aborted.clone();
        let pending = self.pending.clone();
        let session_id = self.session_id.clone();
        let model = self.model.clone();
        let user_message = msg.to_string();

        tokio::spawn(async move {
            // Init + status:running mirror what the legacy bridges emit
            // so the renderer's session-init plumbing fires identically.
            let _ = be_tx
                .send(BridgeEvent::Init {
                    session_id: session_id.clone(),
                    claude_session_id: Some(session_id.clone()),
                    model: model.clone(),
                    tools_count: catalog.len(),
                })
                .await;
            let _ = be_tx
                .send(BridgeEvent::Status {
                    status: "running".into(),
                })
                .await;

            let (te_tx, te_rx) = mpsc::channel::<TurnEvent>(256);

            // Translator: drain TurnEvents, push BridgeEvents. Spawned
            // independently so the loop driver isn't blocked by a slow
            // WS consumer.
            let translator_be_tx = be_tx.clone();
            let translator_model = model.clone();
            let translator = tokio::spawn(async move {
                translate_turn_events(te_rx, translator_be_tx, translator_model).await;
            });

            // Permission gate uses the TurnEvent sink to publish
            // PermissionRequest events to the renderer, then awaits a
            // resolve_permission() callback (routed via the HTTP
            // endpoint) via its own oneshot map.
            let gate = InteractiveGate {
                sink: te_tx.clone(),
                pending: pending.clone(),
            };

            // Drive the loop. Ignored error: drive_agentic_loop emits a
            // TurnEvent::Error before returning Err, so the translator
            // forwards it as BridgeEvent::Error — we don't need to
            // double-handle here.
            let _ = drive_agentic_loop(
                adapter.as_ref(),
                &workspace,
                mode,
                &gate,
                &system_prompt,
                user_message,
                &catalog,
                te_tx,
                aborted,
            )
            .await;

            // Explicit drop: `gate` holds its own clone of the TurnEvent
            // sink (so PermissionRequest events still reach the renderer
            // mid-turn). Without dropping it here the translator below
            // would hang forever waiting on a `te_rx.recv()` whose final
            // sender clone is still alive in the gate. Cost us a 60s
            // hang during testing before the fix landed.
            drop(gate);

            // Wait for the translator to drain remaining TurnEvents
            // before we close the BridgeEvent channel — otherwise the
            // final Error / Usage events get dropped on the floor.
            let _ = translator.await;

            let _ = be_tx
                .send(BridgeEvent::Status {
                    status: "done".into(),
                })
                .await;
        });

        Ok(be_rx)
    }
}

async fn translate_turn_events(
    mut te_rx: mpsc::Receiver<TurnEvent>,
    be_tx: mpsc::Sender<BridgeEvent>,
    model: String,
) {
    while let Some(te) = te_rx.recv().await {
        let be = match te {
            TurnEvent::TextDelta { text } => BridgeEvent::MessageDelta { text },
            TurnEvent::ThinkingDelta { text } => BridgeEvent::Thinking { text },
            TurnEvent::ToolStart { call } => {
                let ToolCall { id, name, input } = call;
                BridgeEvent::ToolStart {
                    tool_id: id,
                    name,
                    input,
                }
            }
            TurnEvent::ToolEnd { result } => {
                let ToolResult {
                    tool_call_id,
                    content,
                    is_error,
                } = result;
                BridgeEvent::ToolEnd {
                    tool_id: tool_call_id,
                    output: content,
                    is_error,
                }
            }
            TurnEvent::Usage {
                input_tokens,
                output_tokens,
            } => BridgeEvent::Cost {
                usage: json!({
                    "input_tokens": input_tokens,
                    "output_tokens": output_tokens,
                    // Compat with the existing Cost-event consumers that
                    // expect these fields. Agentic flows don't surface
                    // cache hits today (provider deltas don't include
                    // cached_tokens in their per-chunk usage); leave 0.
                    "cache_read_tokens": 0,
                    "cache_write_tokens": 0,
                }),
                // Pricing calculation is a follow-up — needs the per-
                // model rate table the legacy bridges already wire up
                // via `services::pricing`. Default 0 here keeps the
                // wire shape valid; renderer shows "—" for unknown cost.
                cost_usd: 0.0,
                model: model.clone(),
            },
            TurnEvent::PermissionRequest {
                call_id,
                tool_name,
                input,
            } => BridgeEvent::PermissionRequest {
                call_id,
                tool_name,
                input,
            },
            TurnEvent::Error { message } => BridgeEvent::Error { error: message },
        };
        if be_tx.send(be).await.is_err() {
            break; // Consumer dropped — no point continuing.
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agentic::events::{AdapterHistory, TurnOutcome};
    use crate::agentic::executor::{ToolCall as ToolCallStruct, ToolResult as ToolResultStruct};
    use parking_lot::Mutex;
    use serde_json::json;
    use std::sync::Arc as StdArc;
    use tempfile::tempdir;

    /// Mock adapter that emits scripted TurnEvents through the sink and
    /// returns scripted TurnOutcomes from execute_turn.
    struct ScriptedAdapter {
        turns: Mutex<Vec<TurnOutcome>>,
    }

    #[async_trait::async_trait]
    impl ToolAdapter for ScriptedAdapter {
        fn init_history(&self, _sys: &str, _user: &str) -> AdapterHistory {
            AdapterHistory::default()
        }

        async fn execute_turn(
            &self,
            _history: &AdapterHistory,
            _catalog: &[Tool],
            sink: &mpsc::Sender<TurnEvent>,
        ) -> Result<TurnOutcome> {
            let next = self
                .turns
                .lock()
                .pop()
                .ok_or_else(|| anyhow::anyhow!("no more scripted turns"))?;
            if !next.text.is_empty() {
                let _ = sink
                    .send(TurnEvent::TextDelta {
                        text: next.text.clone(),
                    })
                    .await;
            }
            Ok(next)
        }

        fn append_assistant(&self, _h: &mut AdapterHistory, _o: &TurnOutcome) {}
        fn append_tool_results(&self, _h: &mut AdapterHistory, _r: &[ToolResultStruct]) {}
    }

    #[tokio::test]
    async fn runner_emits_init_running_done_envelope() {
        let dir = tempdir().unwrap();
        let ws = Workspace::new(dir.path()).unwrap();
        let adapter = StdArc::new(ScriptedAdapter {
            turns: Mutex::new(vec![TurnOutcome {
                text: "ok".into(),
                tool_calls: vec![],
                usage: Some((3, 1)),
            }]),
        });

        let runner =
            AgenticBridgeRunner::new("sess-1", "test-model", adapter, ws, Mode::Autonomous, "sys");
        let mut rx = runner
            .send_message("hi", super::super::BridgeContext::default())
            .await
            .unwrap();

        let mut events = Vec::new();
        while let Some(e) = rx.recv().await {
            events.push(e);
        }

        // Envelope: Init, Status:running, ... MessageDelta/Cost ..., Status:done
        assert!(matches!(events.first(), Some(BridgeEvent::Init { .. })));
        assert!(matches!(
            events.get(1),
            Some(BridgeEvent::Status { status }) if status == "running"
        ));
        assert!(events
            .iter()
            .any(|e| matches!(e, BridgeEvent::MessageDelta { text } if text == "ok")));
        assert!(events.iter().any(|e| matches!(e, BridgeEvent::Cost { .. })));
        assert!(matches!(
            events.last(),
            Some(BridgeEvent::Status { status }) if status == "done"
        ));
    }

    #[tokio::test]
    async fn runner_maps_tool_start_end_to_bridge_events() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), "x").unwrap();
        let ws = Workspace::new(dir.path()).unwrap();
        let adapter = StdArc::new(ScriptedAdapter {
            turns: Mutex::new(vec![
                // Turn 2: done, no more tools.
                TurnOutcome {
                    text: "done".into(),
                    tool_calls: vec![],
                    usage: None,
                },
                // Turn 1: ask for read_file.
                TurnOutcome {
                    text: String::new(),
                    tool_calls: vec![ToolCallStruct {
                        id: "tc-1".into(),
                        name: "read_file".into(),
                        input: json!({"path": "a.txt"}),
                    }],
                    usage: None,
                },
            ]),
        });

        let runner =
            AgenticBridgeRunner::new("sess-1", "test-model", adapter, ws, Mode::Autonomous, "sys");
        let mut rx = runner
            .send_message("read it", super::super::BridgeContext::default())
            .await
            .unwrap();

        let mut events = Vec::new();
        while let Some(e) = rx.recv().await {
            events.push(e);
        }

        let mut saw_start = false;
        let mut saw_end = false;
        for e in &events {
            if let BridgeEvent::ToolStart {
                tool_id,
                name,
                input,
            } = e
            {
                assert_eq!(tool_id, "tc-1");
                assert_eq!(name, "read_file");
                assert_eq!(input["path"], "a.txt");
                saw_start = true;
            }
            if let BridgeEvent::ToolEnd {
                tool_id,
                output,
                is_error,
            } = e
            {
                assert_eq!(tool_id, "tc-1");
                assert!(output.contains("x"), "got: {output}");
                assert!(!is_error);
                saw_end = true;
            }
        }
        assert!(saw_start, "expected BridgeEvent::ToolStart");
        assert!(saw_end, "expected BridgeEvent::ToolEnd");
    }

    #[tokio::test]
    async fn abort_propagates_to_loop_at_next_turn_boundary() {
        let dir = tempdir().unwrap();
        let ws = Workspace::new(dir.path()).unwrap();
        // Adapter that loops on a tool call forever — only abort can
        // stop it (without abort it would burn MAX_TURNS and error).
        let adapter = StdArc::new(ScriptedAdapter {
            turns: Mutex::new(
                (0..100)
                    .map(|_| TurnOutcome {
                        text: String::new(),
                        tool_calls: vec![ToolCallStruct {
                            id: "tc-loop".into(),
                            name: "list_dir".into(),
                            input: json!({}),
                        }],
                        usage: None,
                    })
                    .collect(),
            ),
        });

        let runner = StdArc::new(AgenticBridgeRunner::new(
            "sess-1",
            "test-model",
            adapter,
            ws,
            Mode::Autonomous,
            "sys",
        ));
        let mut rx = runner
            .send_message("loop", super::super::BridgeContext::default())
            .await
            .unwrap();

        // Let one turn complete, then abort.
        let _first = rx.recv().await.unwrap(); // Init
        let _second = rx.recv().await.unwrap(); // Status:running
        runner.abort().await;

        let mut saw_abort_error = false;
        let mut saw_done = false;
        while let Some(e) = rx.recv().await {
            if let BridgeEvent::Error { error } = &e {
                if error.contains("aborted") {
                    saw_abort_error = true;
                }
            }
            if let BridgeEvent::Status { status } = &e {
                if status == "done" {
                    saw_done = true;
                }
            }
        }
        assert!(saw_abort_error, "expected aborted error event");
        assert!(saw_done, "expected done status after abort");
    }
}
