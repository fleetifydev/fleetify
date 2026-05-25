//! The provider-agnostic agentic loop driver.
//!
//! Given a `ToolAdapter` (= "I know how to talk to my HTTP provider"),
//! drives the multi-turn conversation:
//!
//! ```text
//! init_history(system, user)
//! loop:
//!   outcome = adapter.execute_turn(history, catalog, sink)    // streams TextDelta etc.
//!   adapter.append_assistant(history, outcome)
//!   if outcome.tool_calls.is_empty(): break                    // model done
//!   for call in outcome.tool_calls:
//!     sink ← ToolStart(call)
//!     result = executor::execute(call, workspace, mode)        // permission-checked
//!     sink ← ToolEnd(result)
//!   adapter.append_tool_results(history, results)
//! ```
//!
//! Notes
//! -----
//!
//! - Tool execution is sequential, not parallel. Cursor parallelises
//!   reads but it's not worth the executor complexity for v1 — most
//!   turns have 1-3 tool calls and the slowest piece is the LLM, not the
//!   filesystem. Revisit if profiles show contention.
//!
//! - `MAX_TURNS` is a hard cap, not a soft warning. A misbehaving model
//!   that loops on the same tool would otherwise burn through the user's
//!   tokens silently; better to error out at turn 50 with a clear message.
//!
//! - The driver never panics on adapter / executor errors — it forwards
//!   `TurnEvent::Error` to the renderer and returns `Err`. The bridge
//!   wraps that in its existing error surface (BridgeEvent::Error).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use anyhow::{anyhow, Result};
use tokio::sync::mpsc;

use super::adapter::ToolAdapter;
use super::catalog::Tool;
use super::events::TurnEvent;
use super::executor::execute;
use super::permissions::{Mode, PermissionGate};
use super::workspace::Workspace;

/// Hard cap on turns per loop. 50 is generous — a real coding session
/// rarely exceeds 10-20; loops that go higher are almost always
/// pathological (model stuck repeating the same tool with no progress).
pub const MAX_TURNS: usize = 50;

// Nine args (adapter, workspace, mode, gate, prompt, message, catalog,
// sink, aborted) is past clippy's 7-arg default. Bundling into a config
// struct would add boilerplate at every call site for no readability
// gain; every arg here is genuinely independent and named at the call
// site.
#[allow(clippy::too_many_arguments)]
pub async fn drive_agentic_loop(
    adapter: &dyn ToolAdapter,
    workspace: &Workspace,
    mode: Mode,
    gate: &dyn PermissionGate,
    system_prompt: &str,
    user_message: String,
    catalog: &[Tool],
    sink: mpsc::Sender<TurnEvent>,
    aborted: Arc<AtomicBool>,
) -> Result<()> {
    let mut history = adapter.init_history(system_prompt, &user_message);

    for turn in 0..MAX_TURNS {
        // Cooperative abort point between turns. We can't interrupt the
        // provider's in-flight HTTP request — but checking here means a
        // Stop click eventually terminates within one round-trip rather
        // than running the full MAX_TURNS budget.
        if aborted.load(Ordering::SeqCst) {
            let _ = sink
                .send(TurnEvent::Error {
                    message: format!("aborted by user after turn {turn}"),
                })
                .await;
            return Err(anyhow!("aborted"));
        }

        let outcome = match adapter.execute_turn(&history, catalog, &sink).await {
            Ok(o) => o,
            Err(e) => {
                let _ = sink
                    .send(TurnEvent::Error {
                        message: format!("provider error on turn {turn}: {e}"),
                    })
                    .await;
                return Err(e);
            }
        };

        if let Some((input, output)) = outcome.usage {
            let _ = sink
                .send(TurnEvent::Usage {
                    input_tokens: input,
                    output_tokens: output,
                })
                .await;
        }

        adapter.append_assistant(&mut history, &outcome);

        if outcome.tool_calls.is_empty() {
            // Model emitted no tool calls — turn is the final answer.
            return Ok(());
        }

        let mut results = Vec::with_capacity(outcome.tool_calls.len());
        for call in &outcome.tool_calls {
            let _ = sink.send(TurnEvent::ToolStart { call: call.clone() }).await;
            let result = execute(call, workspace, mode, gate).await;
            let _ = sink
                .send(TurnEvent::ToolEnd {
                    result: result.clone(),
                })
                .await;
            results.push(result);
        }
        adapter.append_tool_results(&mut history, &results);
    }

    let msg = format!(
        "agentic loop hit MAX_TURNS ({MAX_TURNS}) — model kept asking for tools without converging"
    );
    let _ = sink
        .send(TurnEvent::Error {
            message: msg.clone(),
        })
        .await;
    Err(anyhow!(msg))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agentic::catalog::catalog_v1;
    use crate::agentic::events::{AdapterHistory, TurnOutcome};
    use crate::agentic::executor::{ToolCall, ToolResult};
    use crate::agentic::permissions::StaticGate;
    use anyhow::Result;
    use parking_lot::Mutex;
    use serde_json::json;
    use std::sync::Arc;
    use tempfile::tempdir;

    /// Scripted adapter for unit-testing the driver. Each "turn" produces a
    /// pre-baked `TurnOutcome`; tool results are appended to a shared log
    /// so tests can assert ordering and that the executor actually ran.
    struct MockAdapter {
        scripted_turns: Mutex<Vec<TurnOutcome>>,
        recorded_results: Arc<Mutex<Vec<Vec<ToolResult>>>>,
        recorded_assistants: Arc<Mutex<Vec<TurnOutcome>>>,
    }

    #[async_trait::async_trait]
    impl ToolAdapter for MockAdapter {
        fn init_history(&self, _system: &str, _user: &str) -> AdapterHistory {
            AdapterHistory::default()
        }

        async fn execute_turn(
            &self,
            _history: &AdapterHistory,
            _catalog: &[Tool],
            sink: &mpsc::Sender<TurnEvent>,
        ) -> Result<TurnOutcome> {
            let next = self
                .scripted_turns
                .lock()
                .pop()
                .ok_or_else(|| anyhow!("mock adapter ran out of scripted turns"))?;
            // Mimic real adapters streaming text before returning the
            // consolidated outcome.
            if !next.text.is_empty() {
                let _ = sink
                    .send(TurnEvent::TextDelta {
                        text: next.text.clone(),
                    })
                    .await;
            }
            Ok(next)
        }

        fn append_assistant(&self, _history: &mut AdapterHistory, outcome: &TurnOutcome) {
            self.recorded_assistants.lock().push(outcome.clone());
        }

        fn append_tool_results(&self, _history: &mut AdapterHistory, results: &[ToolResult]) {
            self.recorded_results.lock().push(results.to_vec());
        }
    }

    fn mk_call(name: &str, input: serde_json::Value) -> ToolCall {
        ToolCall {
            id: format!("tc-{name}"),
            name: name.into(),
            input,
        }
    }

    #[tokio::test]
    async fn loop_terminates_when_model_emits_no_tool_calls() {
        let dir = tempdir().unwrap();
        let ws = Workspace::new(dir.path()).unwrap();
        let adapter = MockAdapter {
            // .pop() reads last-first, so push in REVERSE turn order.
            scripted_turns: Mutex::new(vec![TurnOutcome {
                text: "Hello world".into(),
                tool_calls: vec![],
                usage: Some((10, 5)),
            }]),
            recorded_results: Arc::new(Mutex::new(Vec::new())),
            recorded_assistants: Arc::new(Mutex::new(Vec::new())),
        };
        let (tx, mut rx) = mpsc::channel(32);

        drive_agentic_loop(
            &adapter,
            &ws,
            Mode::Autonomous,
            &StaticGate(true),
            "sys",
            "user msg".into(),
            &catalog_v1(),
            tx,
            Arc::new(AtomicBool::new(false)),
        )
        .await
        .unwrap();

        // Sink received: TextDelta, Usage. No tool events because the
        // model emitted no tool_calls.
        let mut events = Vec::new();
        while let Some(e) = rx.recv().await {
            events.push(e);
        }
        assert!(matches!(events[0], TurnEvent::TextDelta { .. }));
        assert!(matches!(events[1], TurnEvent::Usage { .. }));
        assert_eq!(events.len(), 2);
    }

    #[tokio::test]
    async fn loop_executes_tool_calls_and_feeds_results_back() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), "hello\n").unwrap();
        let ws = Workspace::new(dir.path()).unwrap();

        let recorded_results = Arc::new(Mutex::new(Vec::new()));
        let recorded_assistants = Arc::new(Mutex::new(Vec::new()));

        let adapter = MockAdapter {
            scripted_turns: Mutex::new(vec![
                // Turn 2 (popped second): no tools, done.
                TurnOutcome {
                    text: "Found it!".into(),
                    tool_calls: vec![],
                    usage: None,
                },
                // Turn 1 (popped first): ask to read_file.
                TurnOutcome {
                    text: String::new(),
                    tool_calls: vec![mk_call("read_file", json!({"path": "a.txt"}))],
                    usage: None,
                },
            ]),
            recorded_results: recorded_results.clone(),
            recorded_assistants: recorded_assistants.clone(),
        };
        let (tx, mut rx) = mpsc::channel(32);

        drive_agentic_loop(
            &adapter,
            &ws,
            Mode::Autonomous,
            &StaticGate(true),
            "sys",
            "user msg".into(),
            &catalog_v1(),
            tx,
            Arc::new(AtomicBool::new(false)),
        )
        .await
        .unwrap();

        // Drive emitted: ToolStart, ToolEnd, then on turn 2 TextDelta.
        let mut events = Vec::new();
        while let Some(e) = rx.recv().await {
            events.push(e);
        }
        let mut saw_start = false;
        let mut saw_end = false;
        let mut saw_text = false;
        for e in &events {
            match e {
                TurnEvent::ToolStart { call } if call.name == "read_file" => saw_start = true,
                TurnEvent::ToolEnd { result } => {
                    saw_end = true;
                    // a.txt only has "hello\n" so 1 line + line-number prefix.
                    assert!(result.content.contains("hello"));
                    assert!(!result.is_error);
                }
                TurnEvent::TextDelta { text } if text == "Found it!" => {
                    saw_text = true;
                }
                _ => {}
            }
        }
        assert!(saw_start, "expected ToolStart");
        assert!(saw_end, "expected ToolEnd");
        assert!(saw_text, "expected final TextDelta");

        // Adapter was asked to append assistant turn (twice — once per turn).
        assert_eq!(recorded_assistants.lock().len(), 2);
        // And tool results once (after the tool turn).
        assert_eq!(recorded_results.lock().len(), 1);
        assert_eq!(recorded_results.lock()[0].len(), 1);
    }

    #[tokio::test]
    async fn loop_errors_out_at_max_turns() {
        let dir = tempdir().unwrap();
        let ws = Workspace::new(dir.path()).unwrap();

        // Script enough tool-call turns to exceed MAX_TURNS.
        let mut scripted: Vec<TurnOutcome> = (0..MAX_TURNS + 5)
            .map(|_| TurnOutcome {
                text: String::new(),
                tool_calls: vec![mk_call("list_dir", json!({}))],
                usage: None,
            })
            .collect();
        scripted.reverse(); // pop order

        let adapter = MockAdapter {
            scripted_turns: Mutex::new(scripted),
            recorded_results: Arc::new(Mutex::new(Vec::new())),
            recorded_assistants: Arc::new(Mutex::new(Vec::new())),
        };
        let (tx, mut rx) = mpsc::channel(MAX_TURNS * 4);

        let err = drive_agentic_loop(
            &adapter,
            &ws,
            Mode::Autonomous,
            &StaticGate(true),
            "sys",
            "user".into(),
            &catalog_v1(),
            tx,
            Arc::new(AtomicBool::new(false)),
        )
        .await
        .unwrap_err();
        assert!(err.to_string().contains("MAX_TURNS"));

        let mut error_event_seen = false;
        while let Some(e) = rx.recv().await {
            if let TurnEvent::Error { message } = e {
                if message.contains("MAX_TURNS") {
                    error_event_seen = true;
                }
            }
        }
        assert!(error_event_seen, "expected MAX_TURNS Error event in sink");
    }

    #[tokio::test]
    async fn loop_surfaces_provider_error_via_sink_and_returns_err() {
        let dir = tempdir().unwrap();
        let ws = Workspace::new(dir.path()).unwrap();

        let adapter = MockAdapter {
            scripted_turns: Mutex::new(vec![]), // No turns scripted → execute_turn errors.
            recorded_results: Arc::new(Mutex::new(Vec::new())),
            recorded_assistants: Arc::new(Mutex::new(Vec::new())),
        };
        let (tx, mut rx) = mpsc::channel(8);

        let err = drive_agentic_loop(
            &adapter,
            &ws,
            Mode::Autonomous,
            &StaticGate(true),
            "sys",
            "user".into(),
            &catalog_v1(),
            tx,
            Arc::new(AtomicBool::new(false)),
        )
        .await
        .unwrap_err();
        assert!(err.to_string().contains("ran out of scripted turns"));

        let mut error_event_seen = false;
        while let Some(e) = rx.recv().await {
            if let TurnEvent::Error { message } = e {
                if message.contains("provider error") {
                    error_event_seen = true;
                }
            }
        }
        assert!(error_event_seen);
    }

    #[tokio::test]
    async fn chat_mode_refused_tool_still_completes_loop() {
        // In chat mode, write_file is refused — but the turn doesn't crash.
        // The model gets a tool_result with is_error: true and gets to
        // respond to it. This test simulates a 2-turn flow where the model
        // tries write, gets denied, then gives up.
        let dir = tempdir().unwrap();
        let ws = Workspace::new(dir.path()).unwrap();

        let adapter = MockAdapter {
            scripted_turns: Mutex::new(vec![
                // Turn 2: model gives up, no more tools.
                TurnOutcome {
                    text: "OK I can't write — here's the code instead".into(),
                    tool_calls: vec![],
                    usage: None,
                },
                // Turn 1: model tries write_file (will be refused).
                TurnOutcome {
                    text: String::new(),
                    tool_calls: vec![mk_call(
                        "write_file",
                        json!({"path": "x.txt", "content": "x"}),
                    )],
                    usage: None,
                },
            ]),
            recorded_results: Arc::new(Mutex::new(Vec::new())),
            recorded_assistants: Arc::new(Mutex::new(Vec::new())),
        };
        let (tx, mut rx) = mpsc::channel(32);

        drive_agentic_loop(
            &adapter,
            &ws,
            Mode::Chat,
            // Gate denies — model gets a `User denied permission` tool
            // error and adapts on the next turn instead of looping.
            &StaticGate(false),
            "sys",
            "user".into(),
            &catalog_v1(),
            tx,
            Arc::new(AtomicBool::new(false)),
        )
        .await
        .unwrap();

        let mut saw_error_result = false;
        while let Some(e) = rx.recv().await {
            if let TurnEvent::ToolEnd { result } = e {
                if result.is_error && result.content.contains("denied permission") {
                    saw_error_result = true;
                }
            }
        }
        assert!(saw_error_result, "expected tool refusal in Chat mode");
        assert!(
            !dir.path().join("x.txt").exists(),
            "Chat-mode refusal must not actually write"
        );
    }
}
