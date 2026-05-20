//! Faithful core of `app/routers/chat.py`'s `/ws/sessions` multiplex.
//! Phase 1d: subscribe/unsubscribe/ping, send→ClaudeBridge stream→persist
//! (user+assistant+cost+claude_session_id), abort. Dispatch tokens,
//! interactive permission, system-prompt assembly, non-Claude bridges and
//! app-owned /compact are Phase 2/3 (explicit deferral, not silent).

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::response::Response;
use axum::routing::get;
use axum::Router;
use futures_util::stream::{SplitSink, StreamExt};
use futures_util::SinkExt;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::Mutex;

use crate::bridges::claude::ClaudeBridge;
use crate::bridges::codex::CodexBridge;
use crate::bridges::gemini::GeminiBridge;
use crate::bridges::openai::OpenAIBridge;
use crate::bridges::{AnyBridge, BridgeEvent};
use crate::models::session::Session;
use crate::routers::AppState;

pub fn router() -> Router<AppState> {
    Router::new().route("/ws/sessions", get(ws_entry))
}

#[derive(Deserialize)]
struct TokenQ {
    #[serde(default)]
    token: String,
}

type Sink = Arc<Mutex<SplitSink<WebSocket, Message>>>;

async fn ws_entry(
    ws: WebSocketUpgrade,
    State(st): State<AppState>,
    Query(q): Query<TokenQ>,
) -> Response {
    ws.on_upgrade(move |socket| handle(socket, st, q.token))
}

async fn send_json(sink: &Sink, v: Value) {
    let _ = sink.lock().await.send(Message::Text(v.to_string().into())).await;
}

async fn owned_session(st: &AppState, sid: &str, user_id: &str) -> Option<Session> {
    let s = sqlx::query_as::<_, Session>("SELECT * FROM sessions WHERE id = ?")
        .bind(sid)
        .fetch_optional(&st.auth.pool)
        .await
        .ok()??;
    match &s.user_id {
        Some(u) if u != user_id => None,
        _ => Some(s),
    }
}

async fn handle(socket: WebSocket, st: AppState, token: String) {
    let (raw_sink, mut stream) = socket.split();
    let sink: Sink = Arc::new(Mutex::new(raw_sink));

    // Auth (parity: resolve_user_id_from_token_cached; 4401 on failure).
    let user_id = match crate::auth::resolve_user_id_from_token_cached(
        &token,
        &st.auth.cfg,
        &st.auth.jwks,
        &st.auth.pool,
    )
    .await
    {
        Ok(uid) => uid,
        Err(_) => {
            send_json(
                &sink,
                json!({"type":"error","error":"Unauthorized — missing or invalid token"}),
            )
            .await;
            let _ = sink.lock().await.close().await;
            return;
        }
    };

    let mut subscribed: HashSet<String> = HashSet::new();
    let bridges: Arc<Mutex<HashMap<String, AnyBridge>>> =
        Arc::new(Mutex::new(HashMap::new()));
    let streaming: Arc<Mutex<HashSet<String>>> = Arc::new(Mutex::new(HashSet::new()));

    while let Some(Ok(msg)) = stream.next().await {
        let text = match msg {
            Message::Text(t) => t.to_string(),
            Message::Close(_) => break,
            _ => continue,
        };
        let Ok(v) = serde_json::from_str::<Value>(&text) else { continue };
        let mtype = v.get("type").and_then(|x| x.as_str()).unwrap_or("");

        match mtype {
            "ping" => send_json(&sink, json!({"type":"pong"})).await,

            "subscribe" => {
                for sid in sid_list(&v) {
                    if subscribed.contains(&sid) {
                        continue;
                    }
                    match owned_session(&st, &sid, &user_id).await {
                        Some(_) => {
                            subscribed.insert(sid.clone());
                            st.sm.register_ws(&sid);
                            send_json(
                                &sink,
                                json!({"type":"init","session_id":sid,"model":"pending"}),
                            )
                            .await;
                        }
                        None => {
                            send_json(
                                &sink,
                                json!({"type":"error","session_id":sid,
                                       "error":format!("Forbidden or not found ({sid})")}),
                            )
                            .await;
                        }
                    }
                }
            }

            "unsubscribe" => {
                for sid in sid_list(&v) {
                    subscribed.remove(&sid);
                    st.sm.unregister_ws(&sid);
                }
            }

            "abort" => {
                if let Some(sid) = v.get("session_id").and_then(|x| x.as_str()) {
                    if let Some(b) = bridges.lock().await.get(sid).cloned() {
                        b.abort().await;
                    }
                    let _ = st.sm.update_status(&st.auth.pool, sid, "idle").await;
                }
            }

            "permission_response" => {
                // Phase 2: interactive permission protocol.
                tracing::debug!("permission_response deferred to Phase 2");
            }

            "send" => {
                let Some(sid) = v.get("session_id").and_then(|x| x.as_str()).map(String::from)
                else {
                    continue;
                };
                if !subscribed.contains(&sid) {
                    match owned_session(&st, &sid, &user_id).await {
                        Some(_) => {
                            subscribed.insert(sid.clone());
                            st.sm.register_ws(&sid);
                        }
                        None => {
                            send_json(
                                &sink,
                                json!({"type":"error","session_id":sid,
                                       "error":format!("Forbidden or not found ({sid})")}),
                            )
                            .await;
                            continue;
                        }
                    }
                }
                let user_text =
                    v.get("message").and_then(|x| x.as_str()).unwrap_or("").trim().to_string();
                if user_text.is_empty() {
                    continue;
                }
                if streaming.lock().await.contains(&sid) {
                    continue; // already streaming this session
                }
                let Some(session) = owned_session(&st, &sid, &user_id).await else {
                    continue;
                };

                streaming.lock().await.insert(sid.clone());
                let st2 = st.clone();
                let sink2 = sink.clone();
                let bridges2 = bridges.clone();
                let streaming2 = streaming.clone();
                tokio::spawn(async move {
                    run_send_flow(st2, sink2, bridges2.clone(), session, user_text).await;
                    streaming2.lock().await.remove(&sid);
                    bridges2.lock().await.remove(&sid);
                });
            }

            _ => {}
        }
    }

    // Disconnect cleanup.
    for sid in &subscribed {
        st.sm.unregister_ws(sid);
    }
    for (_, b) in bridges.lock().await.iter() {
        b.abort().await;
    }
}

fn sid_list(v: &Value) -> Vec<String> {
    match v.get("session_ids") {
        Some(Value::Array(a)) => {
            a.iter().filter_map(|x| x.as_str().map(String::from)).collect()
        }
        Some(Value::String(s)) => vec![s.clone()],
        _ => Vec::new(),
    }
}

/// Persist user msg → spawn ClaudeBridge → stream events (session_id
/// injected) → accumulate + persist assistant msg + cost + claude_session_id.
async fn run_send_flow(
    st: AppState,
    sink: Sink,
    bridges: Arc<Mutex<HashMap<String, AnyBridge>>>,
    session: Session,
    user_text: String,
) {
    let sid = session.id.clone();

    // Hidden side-channel markers (parity): auto-intro / enhance are not
    // persisted; compaction app-owned path is Phase 3 (we still strip it).
    let mut text = user_text;
    let mut persist_user = true;
    for marker in ["[fleet:auto-intro]", "[fleet:enhance-prompt]"] {
        if text.starts_with(marker) {
            text = text
                .trim_start_matches(marker)
                .trim_start_matches('\n')
                .to_string();
            persist_user = false;
        }
    }
    if text.starts_with("[fleet:compaction]") {
        // App-owned compactor: snapshot transcript → Haiku summary →
        // persist + delete + emit a "Conversation summary" card. The
        // renderer's compact button hits send with this marker prefix;
        // we short-circuit BEFORE forwarding to the bridge.
        match crate::services::compactor::compact_session(&st.auth.pool, &sid).await {
            Ok(r) => {
                send_json(
                    &sink,
                    json!({
                        "type": "compact_done",
                        "session_id": sid,
                        "summary": r.summary,
                        "compacted_message_count": r.compacted_message_count,
                    }),
                )
                .await;
            }
            Err(e) => {
                send_json(
                    &sink,
                    json!({
                        "type": "error",
                        "session_id": sid,
                        "error": e.to_string(),
                    }),
                )
                .await;
            }
        }
        let _ = st.sm.update_status(&st.auth.pool, &sid, "idle").await;
        return;
    }

    if persist_user {
        let _ = sqlx::query(
            "INSERT INTO messages (id,session_id,role,content,cost_usd,timestamp) \
             VALUES (?,?,?,?,0.0,?)",
        )
        .bind(uuid::Uuid::new_v4().to_string())
        .bind(&sid)
        .bind("user")
        .bind(json!([{"type":"text","text":text}]).to_string())
        .bind(chrono::Utc::now().to_rfc3339())
        .execute(&st.auth.pool)
        .await;
    }

    let _ = st.sm.update_status(&st.auth.pool, &sid, "running").await;

    // Tool-based bridge selection (parity with chat.py). Gemini/Codex/
    // SdkBridge land later in Phase 2; unknown tool → faithful error.
    let any_bridge: AnyBridge = match session.tool.as_str() {
        "claude" => {
            let mut b = ClaudeBridge::new(sid.clone(), session.project_path.clone());
            b.claude_session_id = session.claude_session_id.clone();
            b.permission_mode = session.permission_mode.clone();
            b.model_name = session.model_name.clone();
            b.session_title = Some(session.title.clone());
            b.session_mode = session.session_mode.clone();
            AnyBridge::Claude(Arc::new(b))
        }
        "openai" => {
            let mut b = OpenAIBridge::new(sid.clone());
            if let Some(m) = &session.model_name {
                b.model = m.clone();
            }
            AnyBridge::OpenAI(Arc::new(b))
        }
        "gemini" => AnyBridge::Gemini(Arc::new(GeminiBridge::new(
            sid.clone(),
            session.project_path.clone(),
            session.permission_mode.clone(),
            session.model_name.clone(),
        ))),
        "codex" => AnyBridge::Codex(Arc::new(CodexBridge::new(
            sid.clone(),
            session.project_path.clone(),
            session.permission_mode.clone(),
            session.model_name.clone(),
            session.effort.clone().unwrap_or_default(),
        ))),
        other => {
            send_json(
                &sink,
                json!({"type":"error","session_id":sid,
                       "error":format!("tool {other:?} not yet supported (Phase 2)")}),
            )
            .await;
            let _ = st.sm.update_status(&st.auth.pool, &sid, "idle").await;
            return;
        }
    };
    bridges.lock().await.insert(sid.clone(), any_bridge.clone());

    // Proactive recall — splice prior-work context onto the user
    // message when the text contains a remember-trigger or path token.
    // Bounded by RECALL_QUERY_TIMEOUT inside maybe_build_recall_context
    // so a slow DB never delays the actual turn.
    let project_for_recall = if session.project_path.is_empty() {
        None
    } else {
        Some(session.project_path.as_str())
    };
    let effective_text = if let Some(ctx) = crate::services::recall_hook::maybe_build_recall_context(
        &st.auth.pool,
        &text,
        &sid,
        project_for_recall,
    )
    .await
    {
        format!("{ctx}\n\n{text}")
    } else {
        text.clone()
    };

    let mut rx = match any_bridge.send_message(&effective_text).await {
        Ok(rx) => rx,
        Err(e) => {
            send_json(
                &sink,
                json!({"type":"error","session_id":sid,"error":format!("spawn failed: {e}")}),
            )
            .await;
            let _ = st.sm.update_status(&st.auth.pool, &sid, "idle").await;
            return;
        }
    };

    let mut content: Vec<Value> = Vec::new();
    let mut usage = Value::Null;
    let mut cost_usd = 0.0_f64;
    let mut model_name: Option<String> = session.model_name.clone();
    let mut new_claude_sid: Option<String> = None;

    while let Some(ev) = rx.recv().await {
        // Forward with session_id injected (renderer demuxes on it).
        let mut payload = ev.to_json();
        if let Value::Object(ref mut m) = payload {
            m.insert("session_id".into(), json!(sid));
        }
        send_json(&sink, payload).await;

        match &ev {
            BridgeEvent::Init { claude_session_id, model, .. } => {
                if claude_session_id.is_some() {
                    new_claude_sid = claude_session_id.clone();
                }
                if model != "unknown" {
                    model_name = Some(model.clone());
                }
            }
            BridgeEvent::MessageDelta { text } => push_text(&mut content, "text", text),
            BridgeEvent::Thinking { text } => push_text(&mut content, "thinking", text),
            BridgeEvent::ToolStart { tool_id, name, input } => {
                content.push(json!({"type":"tool_use","tool_id":tool_id,
                    "tool_name":name,"input":input}));
            }
            BridgeEvent::ToolUpdate { tool_id, input } => {
                for b in content.iter_mut().rev() {
                    if b.get("type").and_then(|x| x.as_str()) == Some("tool_use")
                        && b.get("tool_id").and_then(|x| x.as_str()) == Some(tool_id.as_str())
                    {
                        b["input"] = input.clone();
                        break;
                    }
                }
            }
            BridgeEvent::ToolEnd { tool_id, output, is_error } => {
                content.push(json!({"type":"tool_result","tool_id":tool_id,
                    "output":output,"is_error":is_error}));
                // Record one row in the activity ledger so the Activity /
                // Files / Commands tabs reflect the tool use. Best-effort —
                // any write failure is swallowed inside record_tool_event.
                // Walk back to find the matching tool_use block for name + input.
                let (tool_name, tool_input) = content
                    .iter()
                    .rev()
                    .find_map(|b| {
                        if b.get("type").and_then(|x| x.as_str()) == Some("tool_use")
                            && b.get("tool_id").and_then(|x| x.as_str())
                                == Some(tool_id.as_str())
                        {
                            Some((
                                b.get("tool_name")
                                    .and_then(|x| x.as_str())
                                    .unwrap_or("")
                                    .to_string(),
                                b.get("input").cloned(),
                            ))
                        } else {
                            None
                        }
                    })
                    .unwrap_or_default();
                if !tool_name.is_empty() {
                    let _ = crate::services::activity_logger::record_tool_event(
                        &st.auth.pool,
                        &sid,
                        Some(session.project_path.as_str()),
                        &tool_name,
                        tool_input.as_ref(),
                        Some(output.as_str()),
                        *is_error,
                        None,
                    )
                    .await;
                }
            }
            BridgeEvent::Cost { usage: u, cost_usd: c, model } => {
                usage = u.clone();
                cost_usd = *c;
                if model != "unknown" {
                    model_name = Some(model.clone());
                }
            }
            _ => {}
        }
    }

    // Persist assistant turn + cost + resume id (parity with chat.py tail).
    if !content.is_empty() {
        let _ = sqlx::query(
            "INSERT INTO messages (id,session_id,role,content,model,usage_json,cost_usd,timestamp) \
             VALUES (?,?,?,?,?,?,?,?)",
        )
        .bind(uuid::Uuid::new_v4().to_string())
        .bind(&sid)
        .bind("assistant")
        .bind(Value::Array(content).to_string())
        .bind(&model_name)
        .bind(if usage.is_null() { None } else { Some(usage.to_string()) })
        .bind(cost_usd)
        .bind(chrono::Utc::now().to_rfc3339())
        .execute(&st.auth.pool)
        .await;
    }

    if cost_usd > 0.0 {
        // Snapshot the usage counters once so the spawned telemetry task
        // doesn't try to borrow `usage` past this scope.
        let in_t = usage.get("input_tokens").and_then(|v| v.as_i64()).unwrap_or(0);
        let out_t = usage.get("output_tokens").and_then(|v| v.as_i64()).unwrap_or(0);
        let cache_r = usage
            .get("cache_read_tokens")
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        let cache_w = usage
            .get("cache_write_tokens")
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        let now_utc = chrono::Utc::now();
        let cost_model = model_name.clone().unwrap_or_else(|| "unknown".into());
        let _ = sqlx::query(
            "INSERT INTO cost_events \
             (id,session_id,model,input_tokens,output_tokens,cache_read,cache_write,cost_usd,timestamp) \
             VALUES (?,?,?,?,?,?,?,?,?)",
        )
        .bind(uuid::Uuid::new_v4().to_string())
        .bind(&sid)
        .bind(&cost_model)
        .bind(in_t)
        .bind(out_t)
        .bind(cache_r)
        .bind(cache_w)
        .bind(cost_usd)
        .bind(now_utc.to_rfc3339())
        .execute(&st.auth.pool)
        .await;
        let _ = sqlx::query(
            "UPDATE sessions SET budget_used = COALESCE(budget_used,0.0) + ? WHERE id = ?",
        )
        .bind(cost_usd)
        .bind(&sid)
        .execute(&st.auth.pool)
        .await;
        // Cloud telemetry — fire-and-forget into the outbox (drained by
        // the WS client when it lands).
        let sid_owned = sid.clone();
        tokio::spawn(async move {
            let _ = crate::services::telemetry::emit_cost(
                &sid_owned,
                &cost_model,
                in_t,
                out_t,
                cache_r,
                cache_w,
                cost_usd,
                now_utc,
            )
            .await;
        });
    }

    if let Some(cs) = new_claude_sid {
        if session.claude_session_id.as_deref() != Some(cs.as_str()) {
            let _ = sqlx::query("UPDATE sessions SET claude_session_id = ? WHERE id = ?")
                .bind(&cs)
                .bind(&sid)
                .execute(&st.auth.pool)
                .await;
        }
    }

    let _ = st.sm.update_status(&st.auth.pool, &sid, "idle").await;

    // Schedule end-of-turn distillation. The summariser's cooldown +
    // qualification gate inside maybe_distill_session keeps it from
    // firing on trivial sessions or back-to-back idle/resume bursts,
    // so we can call it on every idle without worrying about cost.
    let project_for_distill = if session.project_path.is_empty() {
        None
    } else {
        Some(session.project_path.clone())
    };
    crate::services::session_summarizer::schedule_distill(
        st.auth.pool.clone(),
        sid.clone(),
        project_for_distill,
    );
}

/// Accumulate consecutive text/thinking deltas into one block (parity with
/// the `_parts` accumulation that collapses to a single block on persist).
fn push_text(content: &mut Vec<Value>, kind: &str, chunk: &str) {
    if let Some(last) = content.last_mut() {
        if last.get("type").and_then(|x| x.as_str()) == Some(kind) {
            if let Some(t) = last.get_mut("text").and_then(|x| x.as_str().map(String::from)) {
                last["text"] = json!(format!("{t}{chunk}"));
                return;
            }
        }
    }
    content.push(json!({"type": kind, "text": chunk}));
}
