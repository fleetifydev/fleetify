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
            // Staff vs non-staff (parity with chat.py: title gates the
            // orchestrator role). Staff gets the dispatch-protocol
            // system prompt; non-staff inherits its template's prompt
            // (e.g. reverse_engineering) when one is set.
            let is_staff = session.title == "Staff Agent";
            b.is_staff = is_staff;
            b.agent_template = session.agent_template.clone();
            if is_staff {
                b.system_prompt = Some(
                    crate::services::staff_prompt::build(
                        &st.auth.pool,
                        &sid,
                        session.user_id.as_deref(),
                    )
                    .await,
                );
            } else if let Some(tpl) =
                crate::services::builtin_templates::get(session.agent_template.as_deref())
            {
                b.system_prompt = Some(tpl.system_prompt.to_string());
            }
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

    // ── Staff dispatch-token processing (parity with chat.py:2682-2793) ──
    // Run BEFORE the assistant persist so the saved bubble doesn't leak
    // raw [[DISPATCH:…]] / [[STOP:…]] / [[RESTART:…]] / [[READ_AGENT:…]]
    // syntax. Token side-effects (target user-msg insertion, target
    // bridge spawn, ack/result WS events) happen inline so the
    // renderer's pending dispatch card resolves visibly.
    let is_staff = session.title == "Staff Agent";
    if is_staff {
        let full_text = content
            .iter()
            .filter_map(|b| {
                if b.get("type").and_then(|x| x.as_str()) == Some("text") {
                    b.get("text").and_then(|x| x.as_str())
                } else {
                    None
                }
            })
            .collect::<Vec<_>>()
            .join("");
        if !full_text.is_empty() {
            handle_staff_dispatch_tokens(
                &st,
                &sink,
                &sid,
                session.user_id.as_deref(),
                &full_text,
            )
            .await;
            // Strip every token from each text block so the persisted
            // assistant message + the user-visible bubble stay clean.
            for b in content.iter_mut() {
                if b.get("type").and_then(|x| x.as_str()) == Some("text") {
                    if let Some(t) = b.get("text").and_then(|x| x.as_str()) {
                        let cleaned =
                            crate::services::dispatch::strip_all_tokens(t);
                        b["text"] = json!(cleaned);
                    }
                }
            }
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

/// Process every dispatch-style token the staff agent emitted in its
/// assistant text. Faithful with `chat.py:2682-2793`:
///   • `[[READ_AGENT:id|N]]` — fetch N recent target messages, persist
///     them as a synthetic user msg on the staff session so the next
///     turn carries the context. Emits `agent_context_injected`.
///   • `[[DISPATCH:id|task]]` — ownership-check, persist user msg on
///     target, spawn the target's bridge in the background, emit
///     `dispatch_ack` immediately and `dispatch_result` on completion.
///   • `[[STOP:id]]` / `[[RESTART:id]]` — update target status, emit
///     `agent_stopped` / `agent_restarted`.
async fn handle_staff_dispatch_tokens(
    st: &AppState,
    sink: &Sink,
    staff_sid: &str,
    staff_user_id: Option<&str>,
    text: &str,
) {
    use crate::services::dispatch::{
        parse_dispatches, parse_read_agents, parse_restarts, parse_stops,
    };

    // ── READ_AGENT ──
    let read_matches = parse_read_agents(text);
    if !read_matches.is_empty() {
        let mut context_parts: Vec<String> = Vec::with_capacity(read_matches.len());
        let mut session_ids: Vec<String> = Vec::with_capacity(read_matches.len());
        for r in &read_matches {
            let limit = r.limit.min(50) as i64;
            let block = inject_agent_context(&st.auth.pool, &r.target_id, limit).await;
            context_parts.push(block);
            session_ids.push(r.target_id.clone());
        }
        if !context_parts.is_empty() {
            let injected = context_parts.join("\n\n");
            send_json(
                sink,
                json!({
                    "type": "agent_context_injected",
                    "session_ids": session_ids,
                }),
            )
            .await;
            let _ = sqlx::query(
                "INSERT INTO messages (id,session_id,role,content,cost_usd,timestamp) \
                 VALUES (?,?,?,?,0.0,?)",
            )
            .bind(uuid::Uuid::new_v4().to_string())
            .bind(staff_sid)
            .bind("user")
            .bind(json!([{"type":"text","text":injected}]).to_string())
            .bind(chrono::Utc::now().to_rfc3339())
            .execute(&st.auth.pool)
            .await;
        }
    }

    // ── DISPATCH ──
    for d in parse_dispatches(text) {
        // Ownership check: untrusted LLM output could name another
        // user's session id. Refuse and tell staff so the pending
        // card resolves.
        let target: Option<Session> = sqlx::query_as::<_, Session>(
            "SELECT * FROM sessions WHERE id = ?",
        )
        .bind(&d.target_id)
        .fetch_optional(&st.auth.pool)
        .await
        .ok()
        .flatten();
        let allowed = match (&target, staff_user_id) {
            (Some(t), Some(uid)) => t.user_id.as_deref().is_none_or(|tu| tu == uid),
            (Some(_), None) => true, // staff session is unowned — allow
            (None, _) => false,
        };
        if !allowed {
            let display = d.target_id.chars().take(8).collect::<String>();
            send_json(
                sink,
                json!({
                    "type": "dispatch_result",
                    "target_id": d.target_id,
                    "task": d.task,
                    "success": false,
                    "summary": format!("Agent `{display}...` is not yours."),
                }),
            )
            .await;
            continue;
        }
        let Some(target) = target else { continue };

        let full_task = match &d.extra {
            Some(extra) if !extra.is_empty() => {
                format!("{}\n\nAdditional context:\n{extra}", d.task)
            }
            _ => d.task.clone(),
        };

        // Persist the dispatched task as a normal user msg on the
        // target session — the agent's own chat reads like the user
        // typed the task directly.
        let _ = sqlx::query(
            "INSERT INTO messages (id,session_id,role,content,cost_usd,timestamp) \
             VALUES (?,?,?,?,0.0,?)",
        )
        .bind(uuid::Uuid::new_v4().to_string())
        .bind(&target.id)
        .bind("user")
        .bind(json!([{"type":"text","text":full_task}]).to_string())
        .bind(chrono::Utc::now().to_rfc3339())
        .execute(&st.auth.pool)
        .await;

        // Ack staff immediately so the pending card flips to "dispatched".
        let display = target.id.chars().take(8).collect::<String>();
        send_json(
            sink,
            json!({
                "type": "dispatch_ack",
                "target_id": target.id,
                "task": d.task,
                "success": true,
                "message": format!("Task dispatched to agent `{display}...`"),
            }),
        )
        .await;

        // Spawn the target's bridge run in the background. Result is
        // persisted as a `system` message on the staff session so the
        // pending card resolves on next reload — the renderer's
        // dispatch-card widget already reads system messages of type
        // `dispatch_result` from the staff transcript. Live push from
        // the spawned task to the staff WS sink is a Phase-3 follow-up
        // (needs a per-session JSON fanout in SessionManager).
        let pool = st.auth.pool.clone();
        let sm = st.sm;
        let staff_sid_owned = staff_sid.to_string();
        let target_owned = target.clone();
        let task_for_card = d.task.clone();
        tokio::spawn(async move {
            run_dispatched_task(
                pool,
                sm,
                staff_sid_owned,
                target_owned,
                full_task,
                task_for_card,
            )
            .await;
        });
    }

    // ── STOP / RESTART ──
    for stop_id in parse_stops(text) {
        if let Ok(Some(target)) = sqlx::query_as::<_, Session>(
            "SELECT * FROM sessions WHERE id = ?",
        )
        .bind(&stop_id)
        .fetch_optional(&st.auth.pool)
        .await
        {
            let _ = st.sm.stop_session(&st.auth.pool, &stop_id).await;
            send_json(
                sink,
                json!({
                    "type": "agent_stopped",
                    "target_id": stop_id,
                    "name": target.title,
                }),
            )
            .await;
        }
    }
    for restart_id in parse_restarts(text) {
        if let Ok(Some(target)) = sqlx::query_as::<_, Session>(
            "SELECT * FROM sessions WHERE id = ?",
        )
        .bind(&restart_id)
        .fetch_optional(&st.auth.pool)
        .await
        {
            let _ = st.sm.stop_session(&st.auth.pool, &restart_id).await;
            let _ = st.sm.update_status(&st.auth.pool, &restart_id, "idle").await;
            send_json(
                sink,
                json!({
                    "type": "agent_restarted",
                    "target_id": restart_id,
                    "name": target.title,
                }),
            )
            .await;
        }
    }
}

/// Fetch the most-recent `limit` messages for `target_id` and format
/// them as a single text block the staff session can prepend to its
/// next turn. Faithful with `chat.py::_inject_agent_context`.
async fn inject_agent_context(
    pool: &sqlx::SqlitePool,
    target_id: &str,
    limit: i64,
) -> String {
    let rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT role, content FROM messages WHERE session_id = ? \
         ORDER BY timestamp DESC LIMIT ?",
    )
    .bind(target_id)
    .bind(limit)
    .fetch_all(pool)
    .await
    .unwrap_or_default();
    if rows.is_empty() {
        return format!("[No messages found for agent {target_id}]");
    }
    let short = &target_id[..target_id.len().min(8)];
    let mut out = vec![format!(
        "[AGENT HISTORY: last {limit} messages from session {short}...]"
    )];
    for (role, content) in rows.into_iter().rev() {
        let blocks: Vec<Value> = serde_json::from_str(&content).unwrap_or_default();
        let mut text = String::new();
        for b in blocks {
            if let Some(t) = b.get("text").and_then(|x| x.as_str()) {
                if !text.is_empty() {
                    text.push(' ');
                }
                text.push_str(t);
            }
        }
        if !text.is_empty() {
            let preview = text.chars().take(800).collect::<String>();
            out.push(format!("[{role}] {preview}"));
        }
    }
    out.join("\n")
}

/// Background task: run the target's bridge with `task` and emit a
/// `dispatch_result` on the staff session's broadcast channel when
/// done (success or failure). Faithful with `_run_agent_task` minus
/// the budget gate (Phase 3) and the dispatch-chain depth check.
async fn run_dispatched_task(
    pool: sqlx::SqlitePool,
    sm: &'static crate::session_manager::SessionManager,
    staff_sid: String,
    target: Session,
    task: String,
    task_for_card: String,
) {
    let target_id = target.id.clone();
    let _ = sm
        .update_status(&pool, &target_id, "running")
        .await;

    let any_bridge: AnyBridge = match target.tool.as_str() {
        "claude" => {
            let mut b = ClaudeBridge::new(target_id.clone(), target.project_path.clone());
            b.claude_session_id = target.claude_session_id.clone();
            b.permission_mode = target.permission_mode.clone();
            b.model_name = target.model_name.clone();
            b.session_title = Some(target.title.clone());
            b.session_mode = target.session_mode.clone();
            b.is_staff = false; // dispatched tasks always land on non-staff agents
            b.agent_template = target.agent_template.clone();
            if let Some(tpl) = crate::services::builtin_templates::get(
                target.agent_template.as_deref(),
            ) {
                b.system_prompt = Some(tpl.system_prompt.to_string());
            }
            AnyBridge::Claude(std::sync::Arc::new(b))
        }
        "openai" => {
            let mut b = OpenAIBridge::new(target_id.clone());
            if let Some(m) = &target.model_name {
                b.model = m.clone();
            }
            AnyBridge::OpenAI(std::sync::Arc::new(b))
        }
        "gemini" => AnyBridge::Gemini(std::sync::Arc::new(GeminiBridge::new(
            target_id.clone(),
            target.project_path.clone(),
            target.permission_mode.clone(),
            target.model_name.clone(),
        ))),
        "codex" => AnyBridge::Codex(std::sync::Arc::new(CodexBridge::new(
            target_id.clone(),
            target.project_path.clone(),
            target.permission_mode.clone(),
            target.model_name.clone(),
            target.effort.clone().unwrap_or_default(),
        ))),
        other => {
            let _ = sm.update_status(&pool, &target_id, "idle").await;
            persist_dispatch_result(
                &pool,
                &staff_sid,
                &target_id,
                &task_for_card,
                false,
                &format!("Cannot dispatch: agent uses unsupported tool `{other}`."),
            )
            .await;
            return;
        }
    };

    let mut rx = match any_bridge.send_message(&task).await {
        Ok(rx) => rx,
        Err(e) => {
            let _ = sm.update_status(&pool, &target_id, "error").await;
            persist_dispatch_result(
                &pool,
                &staff_sid,
                &target_id,
                &task_for_card,
                false,
                &format!("Bridge failed to start: {e}"),
            )
            .await;
            return;
        }
    };

    // Accumulate target assistant content. Same loop shape as the
    // primary run_send_flow but without the live WS forwarding to a
    // staff sink — the target's own viewers (if any) get updates via
    // the session_manager broadcast channel that the WS handler
    // already subscribes for.
    let mut content: Vec<Value> = Vec::new();
    let mut usage = Value::Null;
    let mut cost_usd = 0.0_f64;
    let mut model_name: Option<String> = target.model_name.clone();
    let mut summary_text = String::new();
    let mut new_claude_sid: Option<String> = None;

    while let Some(ev) = rx.recv().await {
        // Phase-3 follow-up: per-session WS fanout so a viewer watching
        // the dispatched agent's chat sees the stream live. For now the
        // events are only persisted (the agent's own /messages endpoint
        // picks them up on reload).
        match &ev {
            BridgeEvent::Init { claude_session_id, model, .. } => {
                if claude_session_id.is_some() {
                    new_claude_sid = claude_session_id.clone();
                }
                if model != "unknown" {
                    model_name = Some(model.clone());
                }
            }
            BridgeEvent::MessageDelta { text } => {
                summary_text.push_str(text);
                push_text(&mut content, "text", text);
            }
            BridgeEvent::Thinking { text } => push_text(&mut content, "thinking", text),
            BridgeEvent::ToolStart { tool_id, name, input } => {
                content.push(json!({"type":"tool_use","tool_id":tool_id,
                    "tool_name":name,"input":input}));
            }
            BridgeEvent::ToolUpdate { tool_id, input } => {
                for b in content.iter_mut().rev() {
                    if b.get("type").and_then(|x| x.as_str()) == Some("tool_use")
                        && b.get("tool_id").and_then(|x| x.as_str())
                            == Some(tool_id.as_str())
                    {
                        b["input"] = input.clone();
                        break;
                    }
                }
            }
            BridgeEvent::ToolEnd { tool_id, output, is_error } => {
                content.push(json!({"type":"tool_result","tool_id":tool_id,
                    "output":output,"is_error":is_error}));
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

    // Persist target assistant content + cost (parity with run_send_flow).
    if !content.is_empty() {
        let _ = sqlx::query(
            "INSERT INTO messages (id,session_id,role,content,model,usage_json,cost_usd,timestamp) \
             VALUES (?,?,?,?,?,?,?,?)",
        )
        .bind(uuid::Uuid::new_v4().to_string())
        .bind(&target_id)
        .bind("assistant")
        .bind(Value::Array(content).to_string())
        .bind(&model_name)
        .bind(if usage.is_null() { None } else { Some(usage.to_string()) })
        .bind(cost_usd)
        .bind(chrono::Utc::now().to_rfc3339())
        .execute(&pool)
        .await;
    }
    if let Some(cs) = new_claude_sid {
        if target.claude_session_id.as_deref() != Some(cs.as_str()) {
            let _ = sqlx::query("UPDATE sessions SET claude_session_id = ? WHERE id = ?")
                .bind(&cs)
                .bind(&target_id)
                .execute(&pool)
                .await;
        }
    }
    if cost_usd > 0.0 {
        let _ = sqlx::query(
            "UPDATE sessions SET budget_used = COALESCE(budget_used,0.0) + ? WHERE id = ?",
        )
        .bind(cost_usd)
        .bind(&target_id)
        .execute(&pool)
        .await;
    }
    let _ = sm.update_status(&pool, &target_id, "idle").await;

    // Result card on staff side: trim the summary so it fits the
    // inline card. Long agent runs get a "…" cutoff.
    let preview: String = summary_text.chars().take(600).collect();
    let preview = if summary_text.chars().count() > 600 {
        format!("{preview}…")
    } else {
        preview
    };
    persist_dispatch_result(&pool, &staff_sid, &target_id, &task_for_card, true, &preview)
        .await;
}

/// Persist a `system`-role `dispatch_result` message on the staff
/// session's transcript. The renderer's dispatch-card widget reads
/// this block back on next reload, so the pending card resolves
/// regardless of whether the staff WS was open when the dispatched
/// task finished. Faithful with the chat.py "persist as fallback"
/// branch when the live WS push fails.
async fn persist_dispatch_result(
    pool: &sqlx::SqlitePool,
    staff_sid: &str,
    target_id: &str,
    task: &str,
    success: bool,
    summary: &str,
) {
    let block = json!([{
        "type": "dispatch_result",
        "agent_id": target_id,
        "task": task,
        "success": success,
        "summary": summary,
    }]);
    let _ = sqlx::query(
        "INSERT INTO messages (id,session_id,role,content,cost_usd,timestamp) \
         VALUES (?,?,?,?,0.0,?)",
    )
    .bind(uuid::Uuid::new_v4().to_string())
    .bind(staff_sid)
    .bind("system")
    .bind(block.to_string())
    .bind(chrono::Utc::now().to_rfc3339())
    .execute(pool)
    .await;
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_pool;

    async fn fresh_pool() -> sqlx::SqlitePool {
        init_pool("sqlite::memory:").await.expect("init_pool")
    }

    async fn insert_minimal_session(pool: &sqlx::SqlitePool, id: &str, title: &str) {
        sqlx::query(
            "INSERT INTO sessions \
             (id,title,project_path,group_path,tool,command,status,\
              use_worktree,permission_mode,session_mode,pinned,order_idx,budget_used,created_at) \
             VALUES (?,?,?,'','claude','','idle',1,'default','new',0,0,0.0,?)",
        )
        .bind(id)
        .bind(title)
        .bind(format!("/tmp/{id}"))
        .bind(chrono::Utc::now().to_rfc3339())
        .execute(pool)
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn persist_dispatch_result_writes_a_system_message_on_staff() {
        let pool = fresh_pool().await;
        insert_minimal_session(&pool, "staff-1", "Staff Agent").await;
        persist_dispatch_result(
            &pool,
            "staff-1",
            "target-2",
            "do the thing",
            true,
            "summary preview",
        )
        .await;
        let rows: Vec<(String, String)> = sqlx::query_as(
            "SELECT role, content FROM messages WHERE session_id = 'staff-1'",
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].0, "system");
        let blocks: Value = serde_json::from_str(&rows[0].1).unwrap();
        let block = &blocks[0];
        assert_eq!(block["type"], "dispatch_result");
        assert_eq!(block["agent_id"], "target-2");
        assert_eq!(block["task"], "do the thing");
        assert_eq!(block["success"], true);
        assert_eq!(block["summary"], "summary preview");
    }

    #[tokio::test]
    async fn inject_agent_context_renders_last_n_messages_in_chronological_order() {
        let pool = fresh_pool().await;
        insert_minimal_session(&pool, "tgt-3", "Backend Agent").await;
        // Insert three messages spaced by timestamp so the DESC LIMIT
        // ordering picks the right two, then the function reverses.
        for (i, (role, text, ts)) in [
            ("user", "first user msg", "2026-05-20T10:00:00Z"),
            ("assistant", "first reply", "2026-05-20T10:00:05Z"),
            ("user", "second user msg", "2026-05-20T10:00:10Z"),
        ]
        .into_iter()
        .enumerate()
        {
            sqlx::query(
                "INSERT INTO messages (id,session_id,role,content,cost_usd,timestamp) \
                 VALUES (?,?,?,?,0.0,?)",
            )
            .bind(format!("msg-{i}"))
            .bind("tgt-3")
            .bind(role)
            .bind(json!([{"type":"text","text":text}]).to_string())
            .bind(ts)
            .execute(&pool)
            .await
            .unwrap();
        }
        let block = inject_agent_context(&pool, "tgt-3", 2).await;
        // Header line first, then the 2 most-recent messages in
        // chronological (oldest-first within the slice) order.
        let lines: Vec<&str> = block.lines().collect();
        assert!(lines[0].starts_with("[AGENT HISTORY:"));
        assert!(lines[0].contains("session tgt-3..."));
        assert_eq!(lines.len(), 3);
        assert!(lines[1].contains("first reply"));
        assert!(lines[2].contains("second user msg"));
    }

    #[tokio::test]
    async fn inject_agent_context_handles_empty_session_with_placeholder() {
        let pool = fresh_pool().await;
        insert_minimal_session(&pool, "tgt-empty", "Frontend Agent").await;
        let block = inject_agent_context(&pool, "tgt-empty", 5).await;
        assert_eq!(block, "[No messages found for agent tgt-empty]");
    }
}
