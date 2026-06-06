//! Faithful core of `app/routers/chat.py`'s `/ws/sessions` multiplex.
//! Phase 1d: subscribe/unsubscribe/ping, send→ClaudeBridge stream→persist
//! (user+assistant+cost+claude_session_id), abort. Dispatch tokens,
//! interactive permission, system-prompt assembly, non-Claude bridges and
//! app-owned /compact are Phase 2/3 (explicit deferral, not silent).

use std::collections::{HashMap, HashSet, VecDeque};
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
// crate::bridges::openai::OpenAIBridge — retired from dispatch in favour
// of OpenAICompatBridge. File stays for the mockito unit tests until a
// follow-up sweep retires it entirely.
use crate::bridges::{AnyBridge, BridgeEvent};
use crate::models::session::Session;
use crate::routers::AppState;

pub fn router() -> Router<AppState> {
    Router::new().route("/ws/sessions", get(ws_entry))
}

/// Build the account-scoped Workers AI OpenAI-compat base URL.
fn cloudflare_base_url_for_account(account_id: &str) -> String {
    format!("https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1")
}

/// Resolve the Workers AI base URL from the Cloudflare account id the Tauri
/// shell pushed into the backend cache (`providers_setup::reload_backend` →
/// `/api/internal/providers/reload`, the same path the API keys ride).
/// Returns `None` when not connected, so callers surface a "connect
/// Cloudflare" error instead of firing a request at an unsubstituted
/// `{account_id}`. Sourced from the cache (not a config file) so it behaves
/// identically in dev and the packaged app, where `FLEETIFY_HOME` is unset.
fn cloudflare_base_url() -> Option<String> {
    crate::providers::keys::get_cloudflare_account_id()
        .map(|id| cloudflare_base_url_for_account(&id))
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
    let _ = sink
        .lock()
        .await
        .send(Message::Text(v.to_string().into()))
        .await;
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
    let bridges: Arc<Mutex<HashMap<String, AnyBridge>>> = Arc::new(Mutex::new(HashMap::new()));
    let streaming: Arc<Mutex<HashSet<String>>> = Arc::new(Mutex::new(HashSet::new()));
    // Per-session FIFO of "send" payloads that arrived while the
    // session's `run_send_flow` was still in flight. The spawned task
    // drains this queue before releasing the session's `streaming`
    // slot, so a fast burst of user sends processes in order instead
    // of bouncing off the streaming guard with an `already_running`
    // error frame. Empty entries are pruned on drain to keep the
    // map from leaking entries for long-lived sessions.
    let pending_sends: Arc<Mutex<HashMap<String, VecDeque<String>>>> =
        Arc::new(Mutex::new(HashMap::new()));
    // Per-session permission round-trips. The bridges Codex/Gemini
    // route their CLI/protocol approval hooks through a closure built
    // off this PermissionSession; the `permission_response` WS arm
    // resolves the matching oneshot. On disconnect we
    // `fail_all_pending` so bridge tasks still parked on receivers
    // unblock with `denied` instead of leaking forever (same finally
    // semantics as the Python reference's `permission_futures` cleanup
    // in `chat.py::handle_websocket`).
    let permission_sessions: Arc<
        Mutex<HashMap<String, Arc<crate::bridges::permission::PermissionSession>>>,
    > = Arc::new(Mutex::new(HashMap::new()));
    // Per-session round-trips for an agent's *blocking* inbound ACP extension
    // requests (Cursor's `cursor/ask_question` + `cursor/create_plan`). Same
    // lifecycle as `permission_sessions`: the `cursor_*_response` WS arms
    // resolve a pending oneshot; `fail_all_pending` on disconnect unblocks any
    // handler still parked on a receiver.
    let interactive_sessions: Arc<
        Mutex<HashMap<String, Arc<crate::bridges::interactive::InteractiveRequestSession>>>,
    > = Arc::new(Mutex::new(HashMap::new()));
    // Per-session live fanout tasks. Each subscribed session id gets a
    // forwarder spawned that pulls broadcast::Value events from
    // SessionManager and writes them to this WS's sink. Cancelled on
    // unsubscribe / WS close.
    let fanout_tasks: Arc<Mutex<HashMap<String, tokio::task::JoinHandle<()>>>> =
        Arc::new(Mutex::new(HashMap::new()));

    while let Some(Ok(msg)) = stream.next().await {
        let text = match msg {
            Message::Text(t) => t.to_string(),
            Message::Close(_) => break,
            _ => continue,
        };
        let Ok(v) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
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
                            // Mount a forwarder so background tasks
                            // publishing via send_to_session_ws reach
                            // this sink live. Without this the
                            // dispatch_result + dispatched-agent
                            // events only land in the DB and the
                            // pending card spins until reload.
                            let sink_for = sink.clone();
                            let sid_for = sid.clone();
                            let mut rx = st.sm.subscribe_session(&sid);
                            let handle = tokio::spawn(async move {
                                loop {
                                    match rx.recv().await {
                                        Ok(mut payload) => {
                                            // Inject session_id so the
                                            // renderer's demux still works
                                            // when the publisher omits it.
                                            if let Value::Object(ref mut m) = payload {
                                                m.entry("session_id".to_string())
                                                    .or_insert_with(|| json!(sid_for));
                                            }
                                            send_json(&sink_for, payload).await;
                                        }
                                        Err(tokio::sync::broadcast::error::RecvError::Lagged(
                                            _,
                                        )) => {
                                            // Drop lagged messages and keep going —
                                            // dispatched runs can burst faster than the
                                            // socket. Live UI degradation > full stall.
                                            continue;
                                        }
                                        Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                                            break
                                        }
                                    }
                                }
                            });
                            fanout_tasks.lock().await.insert(sid.clone(), handle);
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
                    if let Some(h) = fanout_tasks.lock().await.remove(&sid) {
                        h.abort();
                    }
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

            // Live model switch for agents that source models at runtime
            // (OpenCode). The renderer ALSO PATCHes session.model_name so a
            // future cold start picks the same model; this arm flips the
            // already-running session via the bridge and echoes the refreshed
            // list back. If no live bridge exists yet, the PATCH alone covers
            // it (next turn cold-starts with the chosen model).
            "model_switch" => {
                let sid = v
                    .get("session_id")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string();
                let model = v
                    .get("model")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string();
                let bridge = if sid.is_empty() || model.is_empty() {
                    None
                } else {
                    bridges.lock().await.get(&sid).cloned()
                };
                if let Some(b) = bridge {
                    match b.set_model(&model).await {
                        Ok(models) => {
                            send_json(
                                &sink,
                                json!({
                                    "type": "available_models_update",
                                    "session_id": sid,
                                    "models": models,
                                    "current_model": model,
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
                                    "error": format!("Model switch failed: {e}"),
                                }),
                            )
                            .await;
                        }
                    }
                }
            }

            // Live session config option (effort, mode, …) for runtime-config
            // agents (OpenCode). The renderer also PATCHes the session field;
            // this flips the running session. Fire-and-forget on success;
            // surfaces an error frame on failure.
            "config_switch" => {
                let sid = v
                    .get("session_id")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string();
                let config_id = v
                    .get("config_id")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string();
                let value = v
                    .get("value")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string();
                let bridge = if sid.is_empty() || config_id.is_empty() {
                    None
                } else {
                    bridges.lock().await.get(&sid).cloned()
                };
                if let Some(b) = bridge {
                    if let Err(e) = b.set_config(&config_id, &value).await {
                        send_json(
                            &sink,
                            json!({
                                "type": "error",
                                "session_id": sid,
                                "error": format!("Config switch failed: {e}"),
                            }),
                        )
                        .await;
                    }
                }
            }

            "auth_code" => {
                // The user pasted the OOB OAuth code from the provider's
                // sign-in page. Route it to the live bridge for that
                // session — the Antigravity CLI bridge writes it into the
                // agy process that's blocking on its "paste the code"
                // prompt. No-op for any other bridge / unknown session.
                let sid = v.get("session_id").and_then(|x| x.as_str()).unwrap_or("");
                let code = v.get("code").and_then(|x| x.as_str()).unwrap_or("");
                if !sid.is_empty() && !code.is_empty() {
                    if let Some(b) = bridges.lock().await.get(sid).cloned() {
                        b.send_auth_code(code).await;
                    } else {
                        tracing::warn!(
                            target: "chat",
                            session = %sid,
                            "auth_code for a session with no live bridge — ignored"
                        );
                    }
                }
            }

            "permission_response" => {
                // Renderer's permission dialog wired up. Payload shape
                // (parity with the Electron build):
                //   { type: "permission_response",
                //     session_id, id, approved, always, tool_name }
                // We pop the matching oneshot sender from THIS
                // session's PermissionSession and resolve it with the
                // user's decision; `always` adds the tool name to the
                // session-scoped allow-list so subsequent prompts for
                // the same tool short-circuit without a round-trip.
                let sid = v
                    .get("session_id")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string();
                let req_id = v
                    .get("id")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string();
                let approved = v.get("approved").and_then(|x| x.as_bool()).unwrap_or(false);
                let always = v.get("always").and_then(|x| x.as_bool()).unwrap_or(false);
                let tool_name = v
                    .get("tool_name")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string();
                if sid.is_empty() || req_id.is_empty() {
                    tracing::warn!(
                        target: "perm",
                        "permission_response missing session_id or id — ignored"
                    );
                    continue;
                }

                // Agentic runner path: HTTP-provider sessions running
                // through `drive_agentic_loop` register their pending
                // permissions on the AgenticBridgeRunner. Check there
                // first — if the call_id matches a pending agentic
                // request, resolve it and short-circuit (the legacy CLI
                // PermissionSession below uses a different mechanism
                // entirely; only one is in play per session).
                let bridge_opt = bridges.lock().await.get(&sid).cloned();
                if let Some(AnyBridge::Agentic(runner)) = bridge_opt.as_ref() {
                    if runner.resolve_permission(&req_id, approved) {
                        tracing::info!(
                            target: "perm",
                            session = %sid, req_id = %req_id, approved,
                            "permission_response.agentic"
                        );
                        continue;
                    }
                }

                let session_opt = permission_sessions.lock().await.get(&sid).cloned();
                if let Some(ps) = session_opt {
                    if approved && always && !tool_name.is_empty() {
                        ps.allow_always(&tool_name).await;
                    }
                    let resolved = ps.resolve(&req_id, approved).await;
                    tracing::info!(
                        target: "perm",
                        session = %sid,
                        req_id = %req_id,
                        approved,
                        always,
                        resolved,
                        "permission_response.local"
                    );
                } else {
                    tracing::warn!(
                        target: "perm",
                        session = %sid,
                        req_id = %req_id,
                        "permission_response for unknown session — dropped"
                    );
                }
            }

            // Renderer's answer to a Cursor blocking extension request
            // (ask_question / create_plan). Payload:
            //   { type, session_id, id, outcome }
            // where `outcome` is the ACP outcome object, e.g.
            //   {outcome:"answered", answers:[...]} | {outcome:"skipped"}
            //   {outcome:"accepted"} | {outcome:"rejected", reason} | {outcome:"cancelled"}
            // We resolve the matching InteractiveRequestSession oneshot with the
            // full ACP `result` (`{outcome: <outcome>}`), which the bridge's
            // on_request handler returns to Cursor.
            "cursor_question_response" | "cursor_plan_response" => {
                let sid = v
                    .get("session_id")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string();
                let req_id = v
                    .get("id")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string();
                let outcome = v
                    .get("outcome")
                    .cloned()
                    .unwrap_or_else(|| json!({ "outcome": "cancelled" }));
                if sid.is_empty() || req_id.is_empty() {
                    tracing::warn!(
                        target: "cursor.interactive",
                        "cursor response missing session_id or id — ignored"
                    );
                    continue;
                }
                let session_opt = interactive_sessions.lock().await.get(&sid).cloned();
                if let Some(is) = session_opt {
                    let resolved = is.resolve(&req_id, json!({ "outcome": outcome })).await;
                    tracing::info!(
                        target: "cursor.interactive",
                        session = %sid,
                        req_id = %req_id,
                        resolved,
                        "cursor_response.resolved"
                    );
                } else {
                    tracing::warn!(
                        target: "cursor.interactive",
                        session = %sid,
                        req_id = %req_id,
                        "cursor response for unknown session — dropped"
                    );
                }
            }

            "send" => {
                let Some(sid) = v
                    .get("session_id")
                    .and_then(|x| x.as_str())
                    .map(String::from)
                else {
                    continue;
                };
                if !subscribed.contains(&sid) {
                    match owned_session(&st, &sid, &user_id).await {
                        Some(_) => {
                            subscribed.insert(sid.clone());
                            st.sm.register_ws(&sid);
                            // Same fanout subscribe as the explicit
                            // "subscribe" branch — keeps the WS live for
                            // dispatched-task events when the renderer
                            // sent a "send" without a prior subscribe.
                            let sink_for = sink.clone();
                            let sid_for = sid.clone();
                            let mut rx = st.sm.subscribe_session(&sid);
                            let handle = tokio::spawn(async move {
                                loop {
                                    match rx.recv().await {
                                        Ok(mut payload) => {
                                            if let Value::Object(ref mut m) = payload {
                                                m.entry("session_id".to_string())
                                                    .or_insert_with(|| json!(sid_for));
                                            }
                                            send_json(&sink_for, payload).await;
                                        }
                                        Err(tokio::sync::broadcast::error::RecvError::Lagged(
                                            _,
                                        )) => continue,
                                        Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                                            break
                                        }
                                    }
                                }
                            });
                            fanout_tasks.lock().await.insert(sid.clone(), handle);
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
                let user_text = v
                    .get("message")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .trim()
                    .to_string();
                if user_text.is_empty() {
                    continue;
                }
                if streaming.lock().await.contains(&sid) {
                    // Already streaming — queue the send and let the
                    // in-flight task drain it once the current
                    // run_send_flow returns. (Detailed flow notes
                    // are below at the loop site.)
                    let qlen = {
                        let mut guard = pending_sends.lock().await;
                        let q = guard.entry(sid.clone()).or_default();
                        q.push_back(user_text);
                        q.len()
                    };
                    tracing::info!(
                        target: "fleet-backend",
                        session_id = %sid,
                        queue_len = qlen,
                        "send: queued (session still streaming)"
                    );
                    send_json(
                        &sink,
                        json!({
                            "type": "queued",
                            "session_id": sid,
                        }),
                    )
                    .await;
                    continue;
                }
                tracing::info!(
                    target: "fleet-backend",
                    session_id = %sid,
                    "send: starting new spawn (streaming set was empty)"
                );
                let Some(session) = owned_session(&st, &sid, &user_id).await else {
                    continue;
                };

                // Ensure a PermissionSession exists for this id BEFORE
                // we hand control to the spawned task. The spawned
                // task may build a bridge that immediately fires a
                // permission request; a missing entry here would mean
                // the WS `permission_response` arm couldn't find the
                // session to resolve.
                let perm_session = {
                    let mut map = permission_sessions.lock().await;
                    map.entry(sid.clone())
                        .or_insert_with(|| {
                            Arc::new(crate::bridges::permission::PermissionSession::new())
                        })
                        .clone()
                };
                // Same for the Cursor extension-request round-trip.
                let interactive_session = {
                    let mut map = interactive_sessions.lock().await;
                    map.entry(sid.clone())
                        .or_insert_with(|| {
                            Arc::new(crate::bridges::interactive::InteractiveRequestSession::new())
                        })
                        .clone()
                };

                streaming.lock().await.insert(sid.clone());
                let st2 = st.clone();
                let sink2 = sink.clone();
                let bridges2 = bridges.clone();
                let streaming2 = streaming.clone();
                let perm_session2 = perm_session.clone();
                let interactive_session2 = interactive_session.clone();
                let pending2 = pending_sends.clone();
                let user_id2 = user_id.clone();
                tokio::spawn(async move {
                    // Run the first turn, then drain queued sends in
                    // order. `streaming` stays in the set the whole
                    // time so a third concurrent "send" still hits the
                    // queue branch. We re-fetch the session row each
                    // iteration in case a mid-stream PATCH bumped
                    // tool/model/permission_mode.
                    let mut current_session = session;
                    let mut current_text = user_text;
                    let mut turn = 0u32;
                    loop {
                        turn += 1;
                        tracing::info!(
                            target: "fleet-backend",
                            session_id = %sid,
                            turn = turn,
                            tool = %current_session.tool,
                            model = ?current_session.model_name,
                            "queue: run_send_flow START"
                        );
                        run_send_flow(
                            st2.clone(),
                            sink2.clone(),
                            bridges2.clone(),
                            current_session,
                            current_text,
                            perm_session2.clone(),
                            interactive_session2.clone(),
                        )
                        .await;
                        tracing::info!(
                            target: "fleet-backend",
                            session_id = %sid,
                            turn = turn,
                            "queue: run_send_flow END (returned)"
                        );
                        let next = {
                            let mut guard = pending2.lock().await;
                            let popped = guard.get_mut(&sid).and_then(|q| q.pop_front());
                            // Prune empty entries so the map doesn't
                            // accumulate per-session shells.
                            if let Some(q) = guard.get(&sid) {
                                if q.is_empty() {
                                    guard.remove(&sid);
                                }
                            }
                            popped
                        };
                        match next {
                            Some(next_text) => {
                                tracing::info!(
                                    target: "fleet-backend",
                                    session_id = %sid,
                                    next_turn = turn + 1,
                                    "queue: popped queued send — re-fetching session"
                                );
                                match owned_session(&st2, &sid, &user_id2).await {
                                    Some(s) => {
                                        current_session = s;
                                        current_text = next_text;
                                    }
                                    None => {
                                        tracing::warn!(
                                            target: "fleet-backend",
                                            session_id = %sid,
                                            "queue: owned_session returned None — aborting drain"
                                        );
                                        break;
                                    }
                                }
                            }
                            None => {
                                tracing::info!(
                                    target: "fleet-backend",
                                    session_id = %sid,
                                    total_turns = turn,
                                    "queue: empty — releasing streaming slot"
                                );
                                break;
                            }
                        }
                    }
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
    {
        let mut tasks = fanout_tasks.lock().await;
        for (_, h) in tasks.drain() {
            h.abort();
        }
    }
    for (_, b) in bridges.lock().await.iter() {
        b.abort().await;
    }
    // Fail every parked permission prompt so bridge tasks awaiting these
    // futures unblock with `denied` instead of leaking forever. Same
    // `finally:` semantics as `permission_futures` cleanup in the
    // Python reference's `chat.py::handle_websocket`.
    let drained_sids: Vec<String> = {
        let mut map = permission_sessions.lock().await;
        let sids: Vec<String> = map.keys().cloned().collect();
        for (_, ps) in map.drain() {
            ps.fail_all_pending().await;
        }
        sids
    };
    // Same for Cursor extension-request round-trips: cancel any parked
    // ask_question / create_plan so the bridge handler unblocks.
    {
        let mut map = interactive_sessions.lock().await;
        for (_, is) in map.drain() {
            is.fail_all_pending().await;
        }
    }
    // Drop the loopback registry entries too — without this, a stale
    // closure (whose captured sink points at a now-closed WS) would
    // keep accepting calls from fleet-permission-mcp and silently
    // never reach a user.
    if !drained_sids.is_empty() {
        let mut reg = st.permission_registry.lock().await;
        for sid in drained_sids {
            reg.remove(&sid);
        }
    }
}

fn sid_list(v: &Value) -> Vec<String> {
    match v.get("session_ids") {
        Some(Value::Array(a)) => a
            .iter()
            .filter_map(|x| x.as_str().map(String::from))
            .collect(),
        Some(Value::String(s)) => vec![s.clone()],
        _ => Vec::new(),
    }
}

/// Persist user msg → spawn ClaudeBridge → stream events (session_id
/// injected) → accumulate + persist assistant msg + cost + claude_session_id.
/// Build the bridge-facing `PermissionHandler` for one session.
///
/// The returned closure ships `tool_permission_request` payloads via
/// the WS sink and awaits the matching `permission_response` arm's
/// resolution. Stamped with `session_id` so the renderer's dialog
/// (which routes per-session via the chat-store) can correlate.
fn build_permission_handler(
    permission_session: &Arc<crate::bridges::permission::PermissionSession>,
    sink: &Sink,
    session_id: &str,
) -> crate::bridges::permission::PermissionHandler {
    let sink = sink.clone();
    let sid = session_id.to_string();
    permission_session.make_handler(move |mut payload| {
        // Stamp the outbound JSON with session_id so the renderer's
        // ws-manager routes it to the right per-session permission
        // store entry. The PermissionSession itself is session-
        // agnostic; we add the field here at the edge.
        if let Value::Object(ref mut m) = payload {
            m.insert("session_id".into(), Value::String(sid.clone()));
        }
        let sink = sink.clone();
        Box::pin(async move {
            send_json(&sink, payload).await;
        })
    })
}

/// Build the ACP inbound-request handler for Cursor's blocking
/// `cursor/ask_question`. Mirrors `build_permission_handler`: ships a
/// `cursor_ask_question` payload (Cursor's question fields + `id` +
/// `session_id`) to the renderer and awaits the matching
/// `cursor_question_response` WS arm's resolution.
fn build_cursor_question_handler(
    interactive_session: &Arc<crate::bridges::interactive::InteractiveRequestSession>,
    sink: &Sink,
    session_id: &str,
) -> crate::bridges::acp::RequestHandler {
    let sink = sink.clone();
    let sid = session_id.to_string();
    interactive_session.make_handler("cursor_ask_question", move |mut payload| {
        if let Value::Object(ref mut m) = payload {
            m.insert("session_id".into(), Value::String(sid.clone()));
        }
        let sink = sink.clone();
        Box::pin(async move {
            send_json(&sink, payload).await;
        })
    })
}

/// Build the ACP inbound-request handler for Cursor's blocking
/// `cursor/create_plan`. Ships a `cursor_create_plan` payload and awaits the
/// `cursor_plan_response` WS arm's resolution.
fn build_cursor_plan_handler(
    interactive_session: &Arc<crate::bridges::interactive::InteractiveRequestSession>,
    sink: &Sink,
    session_id: &str,
) -> crate::bridges::acp::RequestHandler {
    let sink = sink.clone();
    let sid = session_id.to_string();
    interactive_session.make_handler("cursor_create_plan", move |mut payload| {
        if let Value::Object(ref mut m) = payload {
            m.insert("session_id".into(), Value::String(sid.clone()));
        }
        let sink = sink.clone();
        Box::pin(async move {
            send_json(&sink, payload).await;
        })
    })
}

async fn run_send_flow(
    st: AppState,
    sink: Sink,
    bridges: Arc<Mutex<HashMap<String, AnyBridge>>>,
    session: Session,
    user_text: String,
    permission_session: Arc<crate::bridges::permission::PermissionSession>,
    interactive_session: Arc<crate::bridges::interactive::InteractiveRequestSession>,
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

    // ── DIRECT_DISPATCH pre-processing (parity with chat.py:_handle_direct_dispatches) ──
    // When the user types "@AgentName task" in the staff composer, the
    // renderer resolves the name to a session id and appends a
    // [[DIRECT_DISPATCH:<id>|<task>]] token to the outgoing text. We
    // strip the token + dispatch immediately so the staff bridge never
    // sees it (otherwise the model might re-emit a stale DISPATCH
    // token for the same task). The cleaned text retains a `(✓
    // dispatched)` marker so the saved transcript still shows what
    // happened. Staff-only — non-staff sessions never see these tokens
    // because the renderer routes @mentions only from the staff chat.
    text = process_direct_dispatches(
        &st,
        &sink,
        &sid,
        session.user_id.as_deref(),
        &session.title,
        &text,
    )
    .await;

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
    //
    // `agent_cwd` is the working directory the bridge spawns the CLI
    // in. When `worktree_path` is populated (use_worktree=true sessions
    // — see services::worktree::ensure_worktree) we use the worktree
    // checkout so every file the agent creates, every `git` invocation
    // it makes, every relative path it resolves lands INSIDE the
    // session's isolated `.fleetify-worktrees/<id>/` rather than
    // bleeding into the source repo. Falls back to `project_path` for
    // in-place sessions (use_worktree=false).
    // ── Provider routing, resolved BEFORE the bridge is built ──
    // For an "Auto" session (tool/model == "auto") we must dispatch to the
    // ROUTED provider's bridge, not a literal "auto" bridge. So resolve routing
    // here, widen the candidate set to the cross-provider agents Not Diamond
    // supports, then swap session.tool/model to the routed pair so the existing
    // bridge match below builds the right bridge. A pinned (non-auto) session
    // keeps its single-agent candidate set and is left untouched.
    // Fleet's cross-provider Auto is keyed on the TOOL sentinel only. A manual
    // agent can legitimately have model_name == "auto" (e.g. GitHub Copilot's
    // native `auto` model), which must NOT trigger Fleet's Not Diamond routing.
    let is_auto = session.tool == "auto";
    // For Auto, build the candidate pool from the user's ACTIVE providers so
    // Not Diamond only ever picks a model Fleet can execute (no "no API key for
    // provider X" when ND routes to something unconnected). CLI authed-state
    // comes from the agent scan cache (fresh scan if cold); API keys from the
    // process key cache. The Anthropic-API route is gated off until that
    // adapter exists (Phase 2).
    let auto_routes: Vec<crate::services::routing::auto_pool::AutoRoute> = if is_auto {
        let scan = match st.agent_scan_cache.get().await {
            Some(s) => s,
            None => {
                let s = crate::routers::providers::scan_all_agents().await;
                st.agent_scan_cache.set(s.clone()).await;
                s
            }
        };
        let cli_authed = |id: &str| {
            scan.get(id)
                .and_then(|v| v.get("authenticated"))
                .and_then(|b| b.as_bool())
                .unwrap_or(false)
        };
        let has_key = |id: &str| crate::providers::keys::get_key(id).is_some();
        // anthropic_api_available: the "anthropic" Api provider (Anthropic's
        // OpenAI-compatible endpoint) now has a bridge, so Auto may route
        // Claude → Anthropic API when Claude Code is off and a key is connected.
        crate::services::routing::auto_pool::select_routes(
            &cli_authed,
            &has_key,
            has_key("anthropic"),
        )
    } else {
        Vec::new()
    };
    let route_task = crate::services::routing::traits::RoutingTask {
        flow: crate::services::routing::traits::TaskFlow::Chat {
            session_id: sid.clone(),
        },
        user_prompt: text.clone(),
        conversation_history: None,
        workspace_context: crate::services::routing::traits::WorkspaceHints::default(),
        user_hint: None,
        allowed_agents: if is_auto {
            auto_routes.iter().map(|r| r.agent).collect()
        } else {
            match session.tool.as_str() {
                "claude" => vec![crate::services::routing::traits::AgentKind::Claude],
                "openai" => vec![crate::services::routing::traits::AgentKind::OpenAI],
                "gemini" => vec![crate::services::routing::traits::AgentKind::Gemini],
                "codex" => vec![crate::services::routing::traits::AgentKind::Codex],
                "github-copilot" => {
                    vec![crate::services::routing::traits::AgentKind::GitHubCopilot]
                }
                _ => vec![crate::services::routing::traits::AgentKind::Claude],
            }
        },
        budget_remaining: None,
    };
    // Auto routes via Fleet's OWN Not Diamond key (NOTDIAMOND_API_KEY from
    // .env), NOT the user's Settings → Routers orchestrator. A non-auto
    // (manual / pinned) session keeps the user's orchestrator path.
    let resolution = if is_auto {
        crate::services::routing::persist::fleet_auto_resolve(
            &st.auth.pool,
            &route_task,
            &auto_routes,
        )
        .await
    } else {
        crate::services::routing::persist::resolve_routing_for_turn(
            &st.auth.pool,
            &st.routing,
            &sid,
            &session.tool,
            session.model_name.as_deref(),
            route_task,
        )
        .await
    };
    // Auto bridge-swap: rebind `session` to the routed (agent, model). If the
    // master toggle is off so routing didn't pick (model stays "auto"), fall
    // back to a safe default — never feed a bridge the "auto" sentinel.
    let mut session = session;
    if is_auto {
        // tool_override carries the chosen execution path (claude / codex /
        // openai / gemini / gemini-api / anthropic); fall back to the agent's
        // default tool string defensively.
        session.tool = resolution.tool_override.clone().unwrap_or_else(|| {
            crate::services::routing::persist::agent_kind_to_str(resolution.agent).to_string()
        });
        session.model_name = if resolution.model.is_empty() || resolution.model == "auto" {
            Some("claude-sonnet-4-6".to_string())
        } else {
            Some(resolution.model.clone())
        };
    }

    let agent_cwd = session
        .worktree_path
        .clone()
        .filter(|p| !p.is_empty())
        .unwrap_or_else(|| session.project_path.clone());
    let any_bridge: AnyBridge = match session.tool.as_str() {
        "claude" => {
            let mut b = ClaudeBridge::new(sid.clone(), agent_cwd.clone());
            b.claude_session_id = session.claude_session_id.clone();
            b.permission_mode = session.permission_mode.clone();
            b.effort = session.effort.clone().unwrap_or_default();
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
            // Claude CLI in default mode stalls on the interactive
            // prompt when run headless. The MCP at fleet-permission-mcp
            // gives the CLI a tool to call instead; the binary loops
            // back through `/api/internal/permission_prompt` to the
            // handler we register in `permission_registry` just below.
            // Staff/acceptEdits/bypass paths still skip the dialog.
            if !is_staff && session.permission_mode == "default" {
                let handler = build_permission_handler(&permission_session, &sink, &sid);
                st.permission_registry
                    .lock()
                    .await
                    .insert(sid.clone(), handler.clone());
                b = b.with_permission_handler(handler);
            }
            AnyBridge::Claude(Arc::new(b))
        }
        // Generic OpenAI-compatible cloud providers (including "openai"
        // itself). Each one's catalog entry supplies the base URL,
        // env-var hint, and default model list — the bridge stays
        // provider-agnostic. The legacy `OpenAIBridge` (bridges/openai.rs)
        // is no longer dispatched; it stays in the tree for its existing
        // mockito-based unit test and will be retired in a follow-up.
        "openai"
        | "anthropic"
        | "deepseek"
        | "grok"
        | "nvidia-nim"
        | "kimi-api"
        | "gemini-api"
        | "ollama"
        | "openrouter"
        | "cloudflare-workers-ai" => {
            let pid = session.tool.as_str();
            let Some(spec) = crate::providers::find_provider(pid) else {
                send_json(
                    &sink,
                    json!({"type":"error","session_id":sid,
                           "error":format!("unknown provider {pid}")}),
                )
                .await;
                let _ = st.sm.update_status(&st.auth.pool, &sid, "idle").await;
                return;
            };
            let model = session.model_name.clone().unwrap_or_else(|| {
                spec.default_models
                    .first()
                    .map(|m| m.id.to_string())
                    .unwrap_or_default()
            });

            // Agentic dispatch: HTTP-provider sessions ALWAYS run through
            // the agentic loop (workspace context in the system prompt +
            // tool access scaled to the session's permission_mode). The
            // legacy single-shot bridge survives ONLY for Ollama, where
            // local models can't reliably emit OpenAI-style tool_call
            // deltas and a half-broken loop would burn wall-clock on
            // turns that never converge.
            //
            // permission_mode → agentic Mode:
            //   "bypassPermissions" → Autonomous   (all tools auto)
            //   "acceptEdits"       → AcceptEdits  (reads + writes auto)
            //   anything else       → Chat         (reads auto, writes/shell deny)
            //
            // "default" now lands in Chat (was: legacy = no tools, no
            // context). Result: every HTTP session gets workspace context
            // and read tools from day one; the user opts up to writes /
            // shell via the Perms chip as needed.
            let agentic_mode = if pid == "ollama" {
                None
            } else {
                Some(match session.permission_mode.as_str() {
                    "bypassPermissions" => crate::agentic::Mode::Autonomous,
                    "acceptEdits" => crate::agentic::Mode::AcceptEdits,
                    _ => crate::agentic::Mode::Chat,
                })
            };

            if let Some(mode) = agentic_mode {
                let workspace = match crate::agentic::Workspace::new(&agent_cwd) {
                    Ok(w) => w,
                    Err(e) => {
                        send_json(
                            &sink,
                            json!({
                                "type":"error","session_id":sid,
                                "error":format!("agentic workspace init failed: {e}")
                            }),
                        )
                        .await;
                        let _ = st.sm.update_status(&st.auth.pool, &sid, "idle").await;
                        return;
                    }
                };
                let mut tool_ctx = crate::bridges::BridgeContext::default();
                if pid == "cloudflare-workers-ai" {
                    match cloudflare_base_url() {
                        Some(u) => tool_ctx.base_url_override = Some(u),
                        None => {
                            send_json(
                                &sink,
                                json!({
                                    "type":"error","session_id":sid,
                                    "error":"Cloudflare not connected — add your account in Settings → Models"
                                }),
                            )
                            .await;
                            let _ = st.sm.update_status(&st.auth.pool, &sid, "idle").await;
                            return;
                        }
                    }
                }
                let adapter =
                    match crate::bridges::openai_compat_tools::OpenAICompatToolAdapter::from_spec(
                        spec,
                        model.clone(),
                        &tool_ctx,
                    )
                    .map(|a| a.with_effort(session.effort.clone()))
                    {
                        Ok(a) => a,
                        Err(e) => {
                            send_json(
                                &sink,
                                json!({
                                    "type":"error","session_id":sid,
                                    "error":format!("agentic adapter init failed: {e}")
                                }),
                            )
                            .await;
                            let _ = st.sm.update_status(&st.auth.pool, &sid, "idle").await;
                            return;
                        }
                    };
                // System prompt build walks the workspace tree once at
                // session start; the runner caches it for the session's
                // lifetime. Stale-tree risk is acceptable (file listing
                // staleness; nothing the model couldn't recover via
                // list_dir on demand).
                let system_prompt = crate::agentic::build_system_context(&workspace).await;
                AnyBridge::Agentic(Arc::new(
                    crate::bridges::agentic_runner::AgenticBridgeRunner::new(
                        sid.clone(),
                        model,
                        std::sync::Arc::new(adapter),
                        workspace,
                        mode,
                        system_prompt,
                    ),
                ))
            } else {
                // Legacy path — single-shot chat, no tools, identical to
                // pre-agentic behaviour. Ollama always lands here for now
                // (see comment above on tool_call reliability).
                let mut b = crate::bridges::openai_compat::OpenAICompatBridge::from_spec(
                    spec,
                    sid.clone(),
                    model,
                );
                if pid == "ollama" {
                    if let Ok(home) = std::env::var("FLEETIFY_HOME") {
                        let cfg_path = std::path::PathBuf::from(home);
                        let cfg = std::fs::read_to_string(cfg_path.join("fleet.config.json"))
                            .ok()
                            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
                            .unwrap_or_else(|| json!({}));
                        if let Some(url) = cfg
                            .get("providers")
                            .and_then(|p| p.get("ollama_base_url"))
                            .and_then(|u| u.as_str())
                        {
                            b.base_url = url.to_string();
                        }
                    }
                }
                if pid == "cloudflare-workers-ai" {
                    match cloudflare_base_url() {
                        Some(u) => b.base_url = u,
                        None => {
                            send_json(
                                &sink,
                                json!({
                                    "type":"error","session_id":sid,
                                    "error":"Cloudflare not connected — add your account in Settings → Models"
                                }),
                            )
                            .await;
                            let _ = st.sm.update_status(&st.auth.pool, &sid, "idle").await;
                            return;
                        }
                    }
                }
                AnyBridge::OpenAICompat(Arc::new(b))
            }
        }
        "perplexity" => {
            let model = session
                .model_name
                .clone()
                .unwrap_or_else(|| "sonar".to_string());
            AnyBridge::Perplexity(Arc::new(crate::bridges::perplexity::PerplexityBridge::new(
                sid.clone(),
                model,
            )))
        }
        "kimi" => {
            let is_staff = session.title == "Staff Agent";
            let mut b = crate::bridges::kimi::KimiBridge::new(
                sid.clone(),
                agent_cwd.clone(),
                session.permission_mode.clone(),
                session.model_name.clone(),
                is_staff,
                session.agent_template.clone(),
            );
            b.tool_overrides =
                crate::bridges::parse_tool_overrides(session.tool_overrides.as_deref());
            // ACP has no system-prompt slot — staff gets the orchestrator
            // prompt (roster + [[DISPATCH]] protocol), non-staff inherits its
            // template prompt; KimiBridge prepends it onto the turn. Parity
            // with the Gemini block.
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
            // Live permission dialog only in `default` mode (the one mode ACP
            // routes through on_permission_request); staff sessions skip it.
            if !is_staff && session.permission_mode == "default" {
                b = b.with_permission_handler(build_permission_handler(
                    &permission_session,
                    &sink,
                    &sid,
                ));
            }
            AnyBridge::Kimi(Arc::new(b))
        }
        "agy" => {
            let is_staff = session.title == "Staff Agent";
            // agy `-p` has no system-prompt flag, so the staff dispatch protocol
            // (or a template prompt) is carried in the message by the bridge —
            // parity with the antigravity-sdk arm below. Without this the Fleet
            // (staff) agy agent never learns the `[[DISPATCH:...]]` protocol and
            // fabricates "recipient not found" instead of delegating.
            let system_prompt = if is_staff {
                Some(
                    crate::services::staff_prompt::build(
                        &st.auth.pool,
                        &sid,
                        session.user_id.as_deref(),
                    )
                    .await,
                )
            } else {
                crate::services::builtin_templates::get(session.agent_template.as_deref())
                    .map(|tpl| tpl.system_prompt.to_string())
            };
            let mut b = crate::bridges::antigravity::AntigravityBridge::new(
                sid.clone(),
                agent_cwd.clone(),
                session.permission_mode.clone(),
                session.model_name.clone(),
                is_staff,
                session.agent_template.clone(),
            );
            b.system_prompt = system_prompt;
            AnyBridge::Antigravity(Arc::new(b))
        }
        "antigravity-sdk" => {
            let is_staff = session.title == "Staff Agent";
            let system_prompt = if is_staff {
                Some(
                    crate::services::staff_prompt::build(
                        &st.auth.pool,
                        &sid,
                        session.user_id.as_deref(),
                    )
                    .await,
                )
            } else {
                crate::services::builtin_templates::get(session.agent_template.as_deref())
                    .map(|tpl| tpl.system_prompt.to_string())
            };
            AnyBridge::AntigravitySdk(Arc::new(
                crate::bridges::antigravity_sdk::AntigravitySdkBridge::new(
                    sid.clone(),
                    agent_cwd.clone(),
                    session.permission_mode.clone(),
                    session.model_name.clone(),
                    is_staff,
                    session.agent_template.clone(),
                    system_prompt,
                ),
            ))
        }
        "gemini" => {
            let is_staff = session.title == "Staff Agent";
            let mut b = GeminiBridge::new(
                sid.clone(),
                agent_cwd.clone(),
                session.permission_mode.clone(),
                session.model_name.clone(),
                is_staff,
                session.agent_template.clone(),
            );
            // Wire the OS-sandbox toggle (session.sandbox = "on"/"off").
            // Antigravity's sandbox is already expressed via its
            // proceed-in-sandbox mode, so we only set it for Gemini here.
            b.sandbox = session.sandbox.clone();
            // Parity with the Claude block: staff gets the orchestrator
            // prompt (live roster + [[DISPATCH]] protocol), non-staff
            // inherits its template prompt. ACP has no system-prompt slot,
            // so GeminiBridge prepends this onto the turn. Without it a
            // Gemini staff session can't see the fleet or dispatch at all.
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
            // Wire the live permission dialog only when the user opted
            // into a mode that asks. ACP's `default` is the one mode
            // that routes through `on_permission_request`; bypass /
            // dontAsk run autonomously and would never invoke the
            // callback anyway. Staff sessions skip the dialog entirely
            // (they only call safe read-only tools).
            if !is_staff && session.permission_mode == "default" {
                b = b.with_permission_handler(build_permission_handler(
                    &permission_session,
                    &sink,
                    &sid,
                ));
            }
            AnyBridge::Gemini(Arc::new(b))
        }
        "codex" => {
            let is_staff = session.title == "Staff Agent";
            let mut b = CodexBridge::new(
                sid.clone(),
                agent_cwd.clone(),
                session.permission_mode.clone(),
                session.model_name.clone(),
                session.effort.clone().unwrap_or_default(),
                is_staff,
                session.agent_template.clone(),
            );
            // Wire the independent sandbox axis (session.sandbox overrides the
            // approval-derived sandbox; None keeps the derived value).
            b.sandbox = session.sandbox.clone();
            // Codex V2 surfaces approvals through `on_approval_request`
            // in every mode except bypass/dontAsk/never. Wire the handler
            // for all ask-like modes (default, acceptEdits, untrusted,
            // on-request); skip for autonomous modes. The bridge itself
            // short-circuits inside the closure when perm_mode is bypass.
            if !is_staff
                && !matches!(
                    session.permission_mode.as_str(),
                    "never" | "bypassPermissions" | "dontAsk"
                )
            {
                b = b.with_permission_handler(build_permission_handler(
                    &permission_session,
                    &sink,
                    &sid,
                ));
            }
            AnyBridge::Codex(Arc::new(b))
        }
        "opencode" => {
            let is_staff = session.title == "Staff Agent";
            let mut b = crate::bridges::opencode::OpenCodeBridge::new(
                sid.clone(),
                agent_cwd.clone(),
                session.permission_mode.clone(),
                session.model_name.clone(),
                session.effort.clone(),
                is_staff,
                session.agent_template.clone(),
            );
            b.tool_overrides =
                crate::bridges::parse_tool_overrides(session.tool_overrides.as_deref());
            // Resume the prior OpenCode ACP session if we persisted one
            // (our Init event stamped it into session.claude_session_id).
            b.resume_session_id = session.claude_session_id.clone();
            // OpenCode surfaces tool approvals over ACP `session/request_permission`
            // in every mode except the bypass modes — wire the dialog whenever
            // the user-facing mode could ask (mirrors the Codex gate).
            if !is_staff
                && !matches!(
                    session.permission_mode.as_str(),
                    "bypassPermissions" | "dontAsk"
                )
            {
                b = b.with_permission_handler(build_permission_handler(
                    &permission_session,
                    &sink,
                    &sid,
                ));
            }
            AnyBridge::OpenCode(Arc::new(b))
        }
        "hermes" => {
            let is_staff = session.title == "Staff Agent";
            let mut b = crate::bridges::hermes::HermesBridge::new(
                sid.clone(),
                agent_cwd.clone(),
                session.permission_mode.clone(),
                session.model_name.clone(),
                session.effort.clone(),
                is_staff,
                session.agent_template.clone(),
            );
            // Resume the prior Hermes ACP session if we persisted one.
            b.resume_session_id = session.claude_session_id.clone();
            // Staff gets the orchestrator prompt; non-staff inherits its
            // template prompt. Hermes prepends it as a leading ACP text block.
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
            // Wire the live permission dialog except in bypass modes.
            if !is_staff
                && !matches!(
                    session.permission_mode.as_str(),
                    "bypassPermissions" | "dontAsk"
                )
            {
                b = b.with_permission_handler(build_permission_handler(
                    &permission_session,
                    &sink,
                    &sid,
                ));
            }
            AnyBridge::Hermes(Arc::new(b))
        }
        "cursor" => {
            let is_staff = session.title == "Staff Agent";
            let mut b = crate::bridges::cursor::CursorBridge::new(
                sid.clone(),
                agent_cwd.clone(),
                session.permission_mode.clone(),
                session.model_name.clone(),
                session.effort.clone(),
                is_staff,
                session.agent_template.clone(),
            );
            b.tool_overrides =
                crate::bridges::parse_tool_overrides(session.tool_overrides.as_deref());
            // Resume the prior Cursor ACP session if we persisted one (our Init
            // event stamped it into session.claude_session_id).
            b.resume_session_id = session.claude_session_id.clone();
            // Cursor routes tool approvals over ACP `session/request_permission`
            // in every mode except the bypass modes — wire the dialog whenever
            // the user-facing mode could ask (mirrors the OpenCode gate).
            if !is_staff
                && !matches!(
                    session.permission_mode.as_str(),
                    "bypassPermissions" | "dontAsk"
                )
            {
                b = b.with_permission_handler(build_permission_handler(
                    &permission_session,
                    &sink,
                    &sid,
                ));
                // Cursor's blocking extension methods (ask_question / create_plan)
                // surface to the renderer through the same per-session round-trip
                // infrastructure as permissions (see interactive_session).
                b = b.with_cursor_request_handlers(
                    Some(build_cursor_question_handler(
                        &interactive_session,
                        &sink,
                        &sid,
                    )),
                    Some(build_cursor_plan_handler(&interactive_session, &sink, &sid)),
                );
            }
            AnyBridge::Cursor(Arc::new(b))
        }
        "github-copilot" => {
            let mut b = crate::bridges::github_copilot::GitHubCopilotBridge::new(
                sid.clone(),
                agent_cwd.clone(),
                session.permission_mode.clone(),
                session.model_name.clone(),
                session.effort.clone(),
                Some(serde_json::json!({
                    "mcpServers": crate::services::mcp_dispatch::build_merged_map(
                        &sid,
                        session.title == "Staff Agent",
                        session.agent_template.as_deref(),
                    )
                })),
            );
            b.tool_overrides =
                crate::bridges::parse_tool_overrides(session.tool_overrides.as_deref());
            AnyBridge::GitHubCopilot(Arc::new(b))
        }
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
    let effective_text = if let Some(ctx) =
        crate::services::recall_hook::maybe_build_recall_context(
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

    // ── Provider routing per turn ──
    // Resolved ABOVE (before the bridge was built) into `resolution`, so an
    // Auto session dispatches to the routed provider's bridge. `resolution`
    // drives BridgeContext.model_override + the cost-emitter decision id below.
    //
    // If routing picked a DIFFERENT agent than the bridge we already
    // constructed from session.tool, warn — we can override the model
    // via BridgeContext but cannot swap the bridge identity mid-turn.
    // Full bridge-swap is deferred (see task notes).
    let bridge_tool_str = match session.tool.as_str() {
        "claude" | "openai" | "gemini" | "codex" | "github-copilot" => session.tool.as_str(),
        _ => "claude",
    };
    let resolution_tool_str =
        crate::services::routing::persist::agent_kind_to_str(resolution.agent);
    if resolution_tool_str != bridge_tool_str {
        tracing::warn!(
            target: "fleet-backend",
            session_id = %sid,
            bridge_agent = bridge_tool_str,
            routed_agent = resolution_tool_str,
            "routing: decision picked a different agent than session.tool; \
             keeping bridge identity, applying model override only"
        );
    }

    // Build the BridgeContext: model override is always set (so the
    // bridge uses the pinned / freshly-routed tier). Proxy gateway
    // resolution depends on the routed agent's provider family AND on
    // the master toggle — when routing is disabled in Settings → Routers
    // we MUST NOT redirect outbound traffic through the active proxy
    // gateway. Mirrors the gate `resolve_routing_for_dispatch` applies in
    // `persist.rs` so chat and dispatch flows agree on what "routing off"
    // means end-to-end.
    let provider_for_proxy = match resolution.agent {
        crate::services::routing::traits::AgentKind::Claude => {
            crate::services::routing::traits::ProviderKind::Anthropic
        }
        crate::services::routing::traits::AgentKind::OpenAI
        | crate::services::routing::traits::AgentKind::Codex => {
            crate::services::routing::traits::ProviderKind::OpenAI
        }
        crate::services::routing::traits::AgentKind::Gemini => {
            crate::services::routing::traits::ProviderKind::Google
        }
        // Kimi is OpenAI-compatible on the wire — proxies that fan out
        // by provider family put it on the OpenAI-compat endpoint.
        crate::services::routing::traits::AgentKind::Kimi => {
            crate::services::routing::traits::ProviderKind::OpenAICompatible
        }
        // GitHub Copilot CLI is an ACP-based CLI agent (handled in-process by
        // GitHubCopilotBridge); routing-layer ProviderKind has no dedicated
        // Cli variant, so it shares the OpenAICompatible bucket with Kimi.
        crate::services::routing::traits::AgentKind::GitHubCopilot => {
            crate::services::routing::traits::ProviderKind::OpenAICompatible
        }
    };
    let mut bridge_ctx = crate::bridges::BridgeContext {
        model_override: if resolution.model.is_empty() {
            None
        } else {
            Some(resolution.model.clone())
        },
        ..Default::default()
    };
    if st.routing.enabled() {
        if let Some((url, headers)) = st.routing.proxy_for(provider_for_proxy) {
            bridge_ctx.base_url_override = Some(url);
            bridge_ctx.extra_headers = headers;
        }
    }
    let decision_id_opt = resolution.decision_id.clone();
    // Surface the routing decision in the dev console so you can see at a
    // glance which provider/proxy got chosen for this turn and what's about
    // to land in the bridge. Pairs with the per-bridge `…bridge spawn` log.
    tracing::info!(
        target: "fleetify::routing::dispatch",
        session = %sid,
        flow = "chat-turn",
        agent = ?resolution.agent,
        model = %resolution.model,
        decision_id = ?decision_id_opt,
        provider = ?provider_for_proxy,
        base_url_override = ?bridge_ctx.base_url_override,
        proxy_header_count = bridge_ctx.extra_headers.len(),
        "routing decision applied to bridge context"
    );

    let mut rx = match any_bridge.send_message(&effective_text, bridge_ctx).await {
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

    // ── Stream-loss-on-session-switch fix ──
    // Insert a placeholder assistant message NOW + UPDATE its content
    // on a throttled cadence as the bridge streams. When the user
    // navigates away mid-stream and re-opens the session, chat-view's
    // /messages fetch surfaces the partial content + the
    // session.status='running' makes the renderer show the Thinking
    // indicator. Without this, the assistant message only appears at
    // the END of the stream, and partial-progress is invisible after
    // a remount.
    let assistant_msg_id = uuid::Uuid::new_v4().to_string();
    let _ = sqlx::query(
        "INSERT INTO messages (id,session_id,role,content,cost_usd,timestamp) \
         VALUES (?,?,?,?,0.0,?)",
    )
    .bind(&assistant_msg_id)
    .bind(&sid)
    .bind("assistant")
    .bind(json!([]).to_string())
    .bind(chrono::Utc::now().to_rfc3339())
    .execute(&st.auth.pool)
    .await;
    let mut last_persist_at = std::time::Instant::now();
    let persist_throttle = std::time::Duration::from_millis(800);

    while let Some(ev) = rx.recv().await {
        // Intercept AuthRequired before serialization: try to open the URL
        // in the OS default browser and flip opened_in_browser to true on
        // success so the renderer's info card knows the browser was launched.
        let ev = if let BridgeEvent::AuthRequired {
            provider,
            url,
            opened_in_browser: _,
        } = &ev
        {
            let opened = match ::open::that(url) {
                Ok(_) => true,
                Err(e) => {
                    tracing::warn!(
                        provider = %provider,
                        url = %url,
                        error = %e,
                        "open browser for auth URL failed; renderer falls back to clickable link"
                    );
                    false
                }
            };
            BridgeEvent::AuthRequired {
                provider: provider.clone(),
                url: url.clone(),
                opened_in_browser: opened,
            }
        } else {
            ev
        };

        // Forward with session_id injected (renderer demuxes on it).
        let mut payload = ev.to_json();
        if let Value::Object(ref mut m) = payload {
            m.insert("session_id".into(), json!(sid));
        }
        send_json(&sink, payload).await;

        match &ev {
            BridgeEvent::Init {
                claude_session_id,
                model,
                ..
            } => {
                if claude_session_id.is_some() {
                    new_claude_sid = claude_session_id.clone();
                }
                if model != "unknown" {
                    model_name = Some(model.clone());
                }
            }
            BridgeEvent::MessageDelta { text } => push_text(&mut content, "text", text),
            BridgeEvent::Thinking { text } => push_text(&mut content, "thinking", text),
            BridgeEvent::ToolStart {
                tool_id,
                name,
                input,
            } => {
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
            BridgeEvent::ToolEnd {
                tool_id,
                output,
                is_error,
            } => {
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
                            && b.get("tool_id").and_then(|x| x.as_str()) == Some(tool_id.as_str())
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
            BridgeEvent::Cost {
                usage: u,
                cost_usd: c,
                model,
            } => {
                usage = u.clone();
                cost_usd = *c;
                if model != "unknown" {
                    model_name = Some(model.clone());
                }
            }
            // Bridges that keep a persistent daemon alive across turns
            // (Codex app-server, Antigravity SDK) never naturally close
            // their `rx` channel — the JSON-RPC client holds notification
            // handler closures that each retain a `tx.clone()`, and those
            // handlers stay registered until the daemon shuts down (i.e.
            // until the bridge instance drops, which can't happen until
            // run_send_flow returns, which is itself waiting on `rx`).
            // Without this explicit `break`, the loop hangs forever and
            // the per-session queue can't drain — back-to-back sends
            // accumulate but never get processed. Status:done is always
            // the bridge's final event in the per-turn protocol, so
            // breaking on it is safe across every bridge.
            BridgeEvent::Status { status } if status == "done" => break,
            _ => {}
        }

        // Throttled mid-stream persist so a session-switch + re-open
        // shows the partial-so-far instead of a phantom "Thinking…"
        // with no content. Faithful with what the user sees in
        // fleetify (Python): switching away during a long agent run
        // and back keeps showing the live progress. Skips when
        // content is still empty (no bytes to persist yet).
        if !content.is_empty() && last_persist_at.elapsed() >= persist_throttle {
            let _ = sqlx::query("UPDATE messages SET content = ?, model = ? WHERE id = ?")
                .bind(Value::Array(content.clone()).to_string())
                .bind(&model_name)
                .bind(&assistant_msg_id)
                .execute(&st.auth.pool)
                .await;
            last_persist_at = std::time::Instant::now();
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
            handle_staff_dispatch_tokens(&st, &sink, &sid, session.user_id.as_deref(), &full_text)
                .await;
            // Strip every token from each text block so the persisted
            // assistant message + the user-visible bubble stay clean.
            for b in content.iter_mut() {
                if b.get("type").and_then(|x| x.as_str()) == Some("text") {
                    if let Some(t) = b.get("text").and_then(|x| x.as_str()) {
                        let cleaned = crate::services::dispatch::strip_all_tokens(t);
                        b["text"] = json!(cleaned);
                    }
                }
            }
        }
    }

    // Finalize the placeholder assistant row we INSERTed before the
    // stream loop. If the bridge produced nothing (immediate abort,
    // empty response), drop the placeholder so the transcript doesn't
    // carry an empty row. Otherwise UPDATE with the final content +
    // cost + usage + model.
    if content.is_empty() {
        let _ = sqlx::query("DELETE FROM messages WHERE id = ?")
            .bind(&assistant_msg_id)
            .execute(&st.auth.pool)
            .await;
    } else {
        let _ = sqlx::query(
            "UPDATE messages SET content = ?, model = ?, usage_json = ?, \
             cost_usd = ?, timestamp = ? WHERE id = ?",
        )
        .bind(Value::Array(content).to_string())
        .bind(&model_name)
        .bind(if usage.is_null() {
            None
        } else {
            Some(usage.to_string())
        })
        .bind(cost_usd)
        .bind(chrono::Utc::now().to_rfc3339())
        .bind(&assistant_msg_id)
        .execute(&st.auth.pool)
        .await;
    }

    if cost_usd > 0.0 {
        // Snapshot the usage counters once so the spawned telemetry task
        // doesn't try to borrow `usage` past this scope.
        let in_t = usage
            .get("input_tokens")
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        let out_t = usage
            .get("output_tokens")
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
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
        let decision_id_for_cost = decision_id_opt.clone();
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
                decision_id_for_cost.as_deref(),
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

/// Resolve + dispatch every `[[DIRECT_DISPATCH:id|task]]` token the
/// renderer injected into the user's outgoing text (the `@AgentName`
/// flow). Returns the cleaned text the staff bridge will actually see,
/// with each token replaced by a small inline marker so the persisted
/// transcript still reads sensibly. Faithful with chat.py:717-905's
/// `_handle_direct_dispatches`.
///
/// Optimistic-dispatch shape: synchronous parts (resolve, ownership
/// check, push `dispatch_ack` so the pending card renders immediately,
/// persist target user msg, swap in the marker) run inline; the actual
/// bridge spawn runs in a background task — same pattern as the
/// staff-emitted `[[DISPATCH:]]` path. `dispatch_result` events flow
/// back via SessionManager's per-session fanout.
async fn process_direct_dispatches(
    st: &AppState,
    sink: &Sink,
    staff_sid: &str,
    staff_user_id: Option<&str>,
    staff_title: &str,
    text: &str,
) -> String {
    let direct = crate::services::dispatch::parse_direct_dispatches(text);
    if direct.is_empty() {
        return text.to_string();
    }
    // Only the staff session routes @mentions — guard against a
    // renderer regression that leaks the token onto a non-staff send.
    if staff_title != "Staff Agent" {
        // Strip silently; don't dispatch.
        return crate::services::dispatch::strip_all_tokens(text);
    }

    let mut cleaned = text.to_string();
    for d in direct {
        let target: Option<Session> =
            sqlx::query_as::<_, Session>("SELECT * FROM sessions WHERE id = ?")
                .bind(&d.target_id)
                .fetch_optional(&st.auth.pool)
                .await
                .ok()
                .flatten();
        let allowed = match (&target, staff_user_id) {
            (Some(t), Some(uid)) => t.user_id.as_deref().is_none_or(|tu| tu == uid),
            (Some(_), None) => true,
            (None, _) => false,
        };

        // Replace the raw token with a status marker. Faithful with
        // the "(✓ dispatched)" / "(✗ dispatch failed)" markers the
        // Python pipeline writes.
        let raw_token = format!(
            "[[DIRECT_DISPATCH:{}|{}{}]]",
            d.target_id,
            d.task,
            d.extra
                .as_deref()
                .map(|e| format!("||{e}"))
                .unwrap_or_default()
        );
        let marker = if target.is_none() {
            " (✗ dispatch failed)"
        } else if !allowed {
            " (✗ not your agent)"
        } else {
            " (✓ dispatched)"
        };
        // Replace the FIRST occurrence (multiple identical tokens
        // would each get their own marker on subsequent iterations).
        if let Some(pos) = cleaned.find(&raw_token) {
            cleaned.replace_range(pos..pos + raw_token.len(), marker);
        }

        // ── Optimistic ack: card flips to pending immediately ──
        let display = d.target_id.chars().take(8).collect::<String>();
        let (ack_success, ack_message) = match (&target, allowed) {
            (None, _) => (false, format!("Agent `{display}…` not found")),
            (Some(_), false) => (
                false,
                "Dispatch refused — that agent isn't yours.".to_string(),
            ),
            (Some(_), true) => (true, "Dispatched directly via @mention".to_string()),
        };
        send_json(
            sink,
            json!({
                "type": "dispatch_ack",
                "session_id": staff_sid,
                "target_id": d.target_id,
                "task": d.task,
                "success": ack_success,
                "message": ack_message,
            }),
        )
        .await;
        // Fire dispatch_incoming on the TARGET session (when found) so
        // the target's own chat shows the user bubble + Thinking
        // indicator while the bridge spins up. Faithful with
        // chat.py:967-972.
        if ack_success {
            if let Some(t) = target.as_ref() {
                st.sm.send_to_session_ws(
                    &t.id,
                    json!({
                        "type": "dispatch_incoming",
                        "session_id": t.id,
                        "text": d.task,
                        "timestamp": chrono::Utc::now().to_rfc3339(),
                    }),
                );
            }
        }

        if !ack_success {
            continue;
        }
        let Some(target) = target else { continue };

        let full_task = match &d.extra {
            Some(extra) if !extra.is_empty() => {
                format!("{}\n\nAdditional context:\n{extra}", d.task)
            }
            _ => d.task.clone(),
        };

        // Persist the dispatched task as a user message on the target.
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

        // Ancestry chain — same shape as the staff [[DISPATCH:]] path:
        // start from the staff session's chain (usually empty since
        // staff is the root) and append staff itself.
        let mut target_chain = st.sm.get_dispatch_chain(staff_sid);
        target_chain.push(staff_sid.to_string());
        st.sm.set_dispatch_chain(&target.id, target_chain);

        // Layer-2 routing for this @mention dispatch — see the loopback
        // /api/internal/dispatch path for the rationale. Reuses the same
        // helper so all dispatch flows share decision-row provenance.
        let routing_res = crate::services::routing::persist::resolve_routing_for_dispatch(
            &st.auth.pool,
            &st.routing,
            &target.id,
            &target.id,
            &target.tool,
            target.model_name.as_deref(),
            &full_task,
        )
        .await;

        // Background bridge run. dispatch_result + live target stream
        // flow back via SessionManager fanout (subscribed on the WS
        // handler's subscribe path).
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
                routing_res,
            )
            .await;
        });
    }

    // Belt-and-suspenders: strip any lingering token shapes (e.g.
    // malformed/no-match cases the replace_range missed) so the bridge
    // never sees raw [[DIRECT_DISPATCH:]] syntax.
    crate::services::dispatch::strip_all_tokens(&cleaned)
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
        let target: Option<Session> =
            sqlx::query_as::<_, Session>("SELECT * FROM sessions WHERE id = ?")
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

        // Fire dispatch_incoming on the TARGET session so its own chat
        // viewers (if any) render the task as a user bubble + start
        // the "Thinking…" indicator while the bridge spins up.
        // Faithful with chat.py:967-972.
        st.sm.send_to_session_ws(
            &target.id,
            json!({
                "type": "dispatch_incoming",
                "session_id": target.id,
                "text": full_task,
                "timestamp": chrono::Utc::now().to_rfc3339(),
            }),
        );

        // Ack staff immediately so the pending card flips to "dispatched".
        let display = target.id.chars().take(8).collect::<String>();
        send_json(
            sink,
            json!({
                "type": "dispatch_ack",
                // session_id is the renderer's WS-demux routing key —
                // without it the staff chat-store never sees this ack
                // and the "Dispatching to X" pending card never paints.
                "session_id": staff_sid,
                "target_id": target.id,
                "task": d.task,
                "success": true,
                "message": format!("Task dispatched to agent `{display}...`"),
            }),
        )
        .await;

        // Set the target's ancestry chain (staff is the root, so
        // chain becomes [staff_sid] — sub-dispatches the target issues
        // will extend it). The chain is cleared in run_dispatched_task
        // on completion so a re-dispatched session doesn't carry
        // stale ancestry from a prior run.
        let mut target_chain = st.sm.get_dispatch_chain(staff_sid);
        target_chain.push(staff_sid.to_string());
        st.sm.set_dispatch_chain(&target.id, target_chain);

        // Layer-2 routing for the staff [[DISPATCH:]] path. Same helper
        // as the @mention DIRECT_DISPATCH and the /api/internal/dispatch
        // loopback — one routing call per dispatched task.
        let routing_res = crate::services::routing::persist::resolve_routing_for_dispatch(
            &st.auth.pool,
            &st.routing,
            &target.id,
            &target.id,
            &target.tool,
            target.model_name.as_deref(),
            &full_task,
        )
        .await;

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
                routing_res,
            )
            .await;
        });
    }

    // ── STOP / RESTART ──
    for stop_id in parse_stops(text) {
        if let Ok(Some(target)) =
            sqlx::query_as::<_, Session>("SELECT * FROM sessions WHERE id = ?")
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
        if let Ok(Some(target)) =
            sqlx::query_as::<_, Session>("SELECT * FROM sessions WHERE id = ?")
                .bind(&restart_id)
                .fetch_optional(&st.auth.pool)
                .await
        {
            let _ = st.sm.stop_session(&st.auth.pool, &restart_id).await;
            let _ = st
                .sm
                .update_status(&st.auth.pool, &restart_id, "idle")
                .await;
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
async fn inject_agent_context(pool: &sqlx::SqlitePool, target_id: &str, limit: i64) -> String {
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
/// Internal alias used by `routers::internal::dispatch` so the loopback
/// MCP endpoint reuses the exact same bridge-run + result-fanout logic
/// as the staff `[[DISPATCH:]]` path. Same behaviour — the "staff"
/// session here is whichever agent invoked the MCP tool, and its
/// transcript receives the `dispatch_result` card.
pub(crate) async fn run_dispatched_task_internal(
    pool: sqlx::SqlitePool,
    sm: &'static crate::session_manager::SessionManager,
    caller_sid: String,
    target: Session,
    task: String,
    task_for_card: String,
    routing_res: crate::services::routing::persist::RoutingResolution,
) {
    run_dispatched_task(
        pool,
        sm,
        caller_sid,
        target,
        task,
        task_for_card,
        routing_res,
    )
    .await
}

/// Hard wall-clock cap on a single dispatched run. Matches the Python
/// `_DISPATCH_TIMEOUT_SECS = 12 * 60`. Beyond this we abort the bridge
/// and surface a dispatch_result(success=false, "Task timed out…") so
/// the caller's pending card never orphan-spinners — long-running
/// research tasks usually finish well under this; tasks that exceed it
/// are almost always stuck (resume-id mismatch, infinite tool loop,
/// hung subprocess) and the user is better served by a clean failure.
const DISPATCH_TIMEOUT_SECS: u64 = 12 * 60;

async fn run_dispatched_task(
    pool: sqlx::SqlitePool,
    sm: &'static crate::session_manager::SessionManager,
    staff_sid: String,
    target: Session,
    task: String,
    task_for_card: String,
    routing_res: crate::services::routing::persist::RoutingResolution,
) {
    let target_id = target.id.clone();

    // Emit dispatch_progress(phase="received") to staff so the pending
    // card flips from a bare "Dispatching…" to a labeled phase
    // immediately, before the bridge spins. Auto-wake flag set when
    // the target was previously stopped/error so the renderer can
    // explain the longer-than-usual cold-start.
    let auto_woken = matches!(target.status.as_str(), "stopped" | "error" | "idle");
    sm.send_to_session_ws(
        &staff_sid,
        json!({
            "type": "dispatch_progress",
            "session_id": staff_sid,
            "target_id": target_id,
            "phase": "received",
            "auto_woken": auto_woken,
        }),
    );

    // ── Pre-flight budget gate (parity with chat.py:1071-1076) ──
    // Refuse outright when the target's budget cap is exhausted, so
    // a runaway dispatch can't obliterate the limit by appending one
    // last expensive turn. Emit a dispatch_result with a clear summary
    // so the caller's pending card resolves with the real reason.
    if let Some(limit) = target.budget_limit {
        if target.budget_used >= limit {
            tracing::warn!(
                target: "dispatch",
                session_id = %target_id,
                staff = %staff_sid,
                used = target.budget_used,
                limit = limit,
                "dispatch refused: budget exhausted",
            );
            let summary = format!(
                "Budget exhausted: ${:.2} of ${:.2} used. Raise the cap on the target agent to retry.",
                target.budget_used, limit
            );
            persist_dispatch_result(
                &pool,
                &staff_sid,
                &target_id,
                Some(&target.title),
                &task_for_card,
                false,
                &summary,
            )
            .await;
            sm.clear_dispatch_chain(&target_id);
            sm.send_to_session_ws(
                &staff_sid,
                json!({
                    "type": "dispatch_result",
                    "session_id": staff_sid,
                    "target_id": target_id,
                    "target_name": target.title,
                    "project_path": target.project_path,
                    "task": task_for_card,
                    "success": false,
                    "summary": summary,
                }),
            );
            return;
        }
    }

    let _ = sm.update_status(&pool, &target_id, "running").await;

    // Same worktree-aware cwd resolution as the primary chat path.
    // Dispatched tasks run inside the target's isolated worktree so a
    // staff-driven build / refactor doesn't bleed into the source repo.
    let target_cwd = target
        .worktree_path
        .clone()
        .filter(|p| !p.is_empty())
        .unwrap_or_else(|| target.project_path.clone());
    let any_bridge: AnyBridge = match target.tool.as_str() {
        "claude" => {
            let mut b = ClaudeBridge::new(target_id.clone(), target_cwd.clone());
            b.claude_session_id = target.claude_session_id.clone();
            b.permission_mode = target.permission_mode.clone();
            b.model_name = target.model_name.clone();
            b.session_title = Some(target.title.clone());
            b.session_mode = target.session_mode.clone();
            b.is_staff = false; // dispatched tasks always land on non-staff agents
            b.agent_template = target.agent_template.clone();
            if let Some(tpl) =
                crate::services::builtin_templates::get(target.agent_template.as_deref())
            {
                b.system_prompt = Some(tpl.system_prompt.to_string());
            }
            AnyBridge::Claude(std::sync::Arc::new(b))
        }
        "openai"
        | "anthropic"
        | "deepseek"
        | "grok"
        | "nvidia-nim"
        | "kimi-api"
        | "gemini-api"
        | "ollama"
        | "openrouter"
        | "cloudflare-workers-ai" => {
            let pid = target.tool.as_str();
            let Some(spec) = crate::providers::find_provider(pid) else {
                let _ = sm.update_status(&pool, &target_id, "idle").await;
                return;
            };
            let model = target.model_name.clone().unwrap_or_else(|| {
                spec.default_models
                    .first()
                    .map(|m| m.id.to_string())
                    .unwrap_or_default()
            });
            let mut b = crate::bridges::openai_compat::OpenAICompatBridge::from_spec(
                spec,
                target_id.clone(),
                model,
            );
            if pid == "cloudflare-workers-ai" {
                match cloudflare_base_url() {
                    Some(u) => b.base_url = u,
                    None => {
                        let _ = sm.update_status(&pool, &target_id, "idle").await;
                        return;
                    }
                }
            }
            AnyBridge::OpenAICompat(std::sync::Arc::new(b))
        }
        "perplexity" => {
            let model = target
                .model_name
                .clone()
                .unwrap_or_else(|| "sonar".to_string());
            AnyBridge::Perplexity(std::sync::Arc::new(
                crate::bridges::perplexity::PerplexityBridge::new(target_id.clone(), model),
            ))
        }
        "kimi" => {
            let mut b = crate::bridges::kimi::KimiBridge::new(
                target_id.clone(),
                target_cwd.clone(),
                target.permission_mode.clone(),
                target.model_name.clone(),
                false, // dispatched tasks always land on non-staff agents
                target.agent_template.clone(),
            );
            b.tool_overrides =
                crate::bridges::parse_tool_overrides(target.tool_overrides.as_deref());
            // A dispatched Kimi agent inherits its template's system prompt
            // (e.g. reverse_engineering). Mirror the Gemini dispatch arm.
            if let Some(tpl) =
                crate::services::builtin_templates::get(target.agent_template.as_deref())
            {
                b.system_prompt = Some(tpl.system_prompt.to_string());
            }
            AnyBridge::Kimi(std::sync::Arc::new(b))
        }
        "gemini" => {
            let mut b = GeminiBridge::new(
                target_id.clone(),
                target_cwd.clone(),
                target.permission_mode.clone(),
                target.model_name.clone(),
                false, // dispatched tasks always land on non-staff agents
                target.agent_template.clone(),
            );
            // Mirror the Claude dispatch arm: a dispatched Gemini agent
            // inherits its template's system prompt (e.g. reverse_engineering).
            if let Some(tpl) =
                crate::services::builtin_templates::get(target.agent_template.as_deref())
            {
                b.system_prompt = Some(tpl.system_prompt.to_string());
            }
            AnyBridge::Gemini(std::sync::Arc::new(b))
        }
        "codex" => AnyBridge::Codex(std::sync::Arc::new(CodexBridge::new(
            target_id.clone(),
            target_cwd.clone(),
            target.permission_mode.clone(),
            target.model_name.clone(),
            target.effort.clone().unwrap_or_default(),
            false, // dispatched tasks always land on non-staff agents
            target.agent_template.clone(),
        ))),
        "opencode" => {
            let mut b = crate::bridges::opencode::OpenCodeBridge::new(
                target_id.clone(),
                target_cwd.clone(),
                target.permission_mode.clone(),
                target.model_name.clone(),
                target.effort.clone(),
                false, // dispatched tasks always land on non-staff agents
                target.agent_template.clone(),
            );
            b.tool_overrides =
                crate::bridges::parse_tool_overrides(target.tool_overrides.as_deref());
            b.resume_session_id = target.claude_session_id.clone();
            AnyBridge::OpenCode(std::sync::Arc::new(b))
        }
        "hermes" => {
            let mut b = crate::bridges::hermes::HermesBridge::new(
                target_id.clone(),
                target_cwd.clone(),
                target.permission_mode.clone(),
                target.model_name.clone(),
                target.effort.clone(),
                false, // dispatched tasks always land on non-staff agents
                target.agent_template.clone(),
            );
            b.resume_session_id = target.claude_session_id.clone();
            // A dispatched Hermes agent inherits its template's system prompt.
            if let Some(tpl) =
                crate::services::builtin_templates::get(target.agent_template.as_deref())
            {
                b.system_prompt = Some(tpl.system_prompt.to_string());
            }
            AnyBridge::Hermes(std::sync::Arc::new(b))
        }
        "cursor" => {
            let mut b = crate::bridges::cursor::CursorBridge::new(
                target_id.clone(),
                target_cwd.clone(),
                target.permission_mode.clone(),
                target.model_name.clone(),
                target.effort.clone(),
                false, // dispatched tasks always land on non-staff agents
                target.agent_template.clone(),
            );
            b.tool_overrides =
                crate::bridges::parse_tool_overrides(target.tool_overrides.as_deref());
            b.resume_session_id = target.claude_session_id.clone();
            AnyBridge::Cursor(std::sync::Arc::new(b))
        }
        "github-copilot" => {
            let mut b = crate::bridges::github_copilot::GitHubCopilotBridge::new(
                target_id.clone(),
                target_cwd.clone(),
                target.permission_mode.clone(),
                target.model_name.clone(),
                target.effort.clone(),
                Some(serde_json::json!({
                    "mcpServers": crate::services::mcp_dispatch::build_merged_map(
                        &target_id,
                        false,
                        target.agent_template.as_deref(),
                    )
                })),
            );
            b.tool_overrides =
                crate::bridges::parse_tool_overrides(target.tool_overrides.as_deref());
            AnyBridge::GitHubCopilot(std::sync::Arc::new(b))
        }
        "agy" => AnyBridge::Antigravity(std::sync::Arc::new(
            crate::bridges::antigravity::AntigravityBridge::new(
                target_id.clone(),
                target_cwd.clone(),
                target.permission_mode.clone(),
                target.model_name.clone(),
                false, // dispatched tasks always land on non-staff agents
                target.agent_template.clone(),
            ),
        )),
        "antigravity-sdk" => {
            let system_prompt =
                crate::services::builtin_templates::get(target.agent_template.as_deref())
                    .map(|tpl| tpl.system_prompt.to_string());
            AnyBridge::AntigravitySdk(std::sync::Arc::new(
                crate::bridges::antigravity_sdk::AntigravitySdkBridge::new(
                    target_id.clone(),
                    target_cwd.clone(),
                    target.permission_mode.clone(),
                    target.model_name.clone(),
                    false, // dispatched tasks always land on non-staff agents
                    target.agent_template.clone(),
                    system_prompt,
                ),
            ))
        }
        other => {
            let _ = sm.update_status(&pool, &target_id, "idle").await;
            let summary = format!("Cannot dispatch: agent uses unsupported tool `{other}`.");
            persist_dispatch_result(
                &pool,
                &staff_sid,
                &target_id,
                Some(&target.title),
                &task_for_card,
                false,
                &summary,
            )
            .await;
            sm.clear_dispatch_chain(&target_id);
            sm.send_to_session_ws(
                &staff_sid,
                json!({
                    "type": "dispatch_result",
                    "session_id": staff_sid,
                    "target_id": target_id,
                    "target_name": target.title,
                    "project_path": target.project_path,
                    "task": task_for_card,
                    "success": false,
                    "summary": summary,
                }),
            );
            return;
        }
    };

    // Phase 2: starting — bridge is about to spawn. Auto-woken flag
    // surfaces in the staff card so the renderer can show a "waking
    // up…" subtitle on previously-stopped agents.
    sm.send_to_session_ws(
        &staff_sid,
        json!({
            "type": "dispatch_progress",
            "session_id": staff_sid,
            "target_id": target_id,
            "phase": "starting",
            "auto_woken": auto_woken,
        }),
    );

    // Routing-aware bridge context: when the orchestrator picked a tier
    // for this dispatch, `routing_res.model` is non-empty and
    // base_url/headers carry any active proxy gateway. When routing was
    // disabled or pass-through, all three collapse to the bridge's own
    // defaults (model = target.model_name, direct provider URLs).
    let bridge_ctx = crate::bridges::BridgeContext {
        base_url_override: routing_res.base_url_override.clone(),
        extra_headers: routing_res.extra_headers.clone(),
        model_override: if routing_res.model.is_empty() {
            None
        } else {
            Some(routing_res.model.clone())
        },
    };
    tracing::info!(
        target: "fleetify::routing::dispatch",
        staff_session = %staff_sid,
        target_session = %target_id,
        flow = "agent-dispatch",
        model = %routing_res.model,
        base_url_override = ?bridge_ctx.base_url_override,
        proxy_header_count = bridge_ctx.extra_headers.len(),
        "routing decision applied to dispatched bridge context"
    );
    let mut rx = match any_bridge.send_message(&task, bridge_ctx).await {
        Ok(rx) => rx,
        Err(e) => {
            let _ = sm.update_status(&pool, &target_id, "error").await;
            let summary = format!("Bridge failed to start: {e}");
            persist_dispatch_result(
                &pool,
                &staff_sid,
                &target_id,
                Some(&target.title),
                &task_for_card,
                false,
                &summary,
            )
            .await;
            sm.clear_dispatch_chain(&target_id);
            sm.send_to_session_ws(
                &staff_sid,
                json!({
                    "type": "dispatch_result",
                    "session_id": staff_sid,
                    "target_id": target_id,
                    "target_name": target.title,
                    "task": task_for_card,
                    "success": false,
                    "summary": summary,
                    "project_path": target.project_path,
                }),
            );
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

    // Stream-loss-on-session-switch fix (same as run_send_flow): insert
    // a placeholder assistant row on the TARGET session now, UPDATE it
    // throttled as the stream progresses, finalize at the end. Lets
    // the target's chat-view show partial progress on remount.
    let assistant_msg_id = uuid::Uuid::new_v4().to_string();
    let _ = sqlx::query(
        "INSERT INTO messages (id,session_id,role,content,cost_usd,timestamp) \
         VALUES (?,?,?,?,0.0,?)",
    )
    .bind(&assistant_msg_id)
    .bind(&target_id)
    .bind("assistant")
    .bind(json!([]).to_string())
    .bind(chrono::Utc::now().to_rfc3339())
    .execute(&pool)
    .await;
    let mut last_persist_at = std::time::Instant::now();
    let persist_throttle = std::time::Duration::from_millis(800);

    // Wall-clock cap on the entire stream loop. On timeout we abort
    // the bridge (releasing the subprocess), persist a failure card,
    // live-push to the caller WS, and bail out with whatever partial
    // content already accumulated.
    let bridge_for_abort = any_bridge.clone();
    let mut running_emitted = false;
    let stream_result = tokio::time::timeout(
        std::time::Duration::from_secs(DISPATCH_TIMEOUT_SECS),
        async {
            while let Some(ev) = rx.recv().await {
                // First real event from the bridge → flip the pending
                // card's phase badge to "running" so the user knows
                // the agent is actively producing output.
                if !running_emitted {
                    running_emitted = true;
                    sm.send_to_session_ws(
                        &staff_sid,
                        json!({
                            "type": "dispatch_progress",
                            "session_id": staff_sid,
                            "target_id": target_id,
                            "phase": "running",
                        }),
                    );
                }

                // Mirror the target's stream live to any viewer of
                // that session's chat — dispatching to a visible
                // agent updates its own bubble in real time, just
                // like a user-initiated send.

                // Same AuthRequired intercept as the main per-session
                // forwarder: open the browser and flip opened_in_browser
                // so the renderer's info card reflects the actual outcome.
                let ev = if let BridgeEvent::AuthRequired {
                    provider,
                    url,
                    opened_in_browser: _,
                } = &ev
                {
                    let opened = match ::open::that(url) {
                        Ok(_) => true,
                        Err(e) => {
                            tracing::warn!(
                                provider = %provider,
                                url = %url,
                                error = %e,
                                "open browser for auth URL failed; renderer falls back to clickable link"
                            );
                            false
                        }
                    };
                    BridgeEvent::AuthRequired {
                        provider: provider.clone(),
                        url: url.clone(),
                        opened_in_browser: opened,
                    }
                } else {
                    ev
                };

                let mut payload = ev.to_json();
                if let Value::Object(ref mut m) = payload {
                    m.insert("session_id".into(), json!(target_id));
                }
                sm.send_to_session_ws(&target_id, payload);

                // Mirror high-signal events to the STAFF session as
                // `dispatch_stream` so the pending card surfaces a
                // live preview of what the target agent is doing
                // (faithful with chat.py's dispatch_stream emit).
                match &ev {
                    BridgeEvent::MessageDelta { text } => {
                        sm.send_to_session_ws(
                            &staff_sid,
                            json!({
                                "type": "dispatch_stream",
                                "session_id": staff_sid,
                                "target_id": target_id,
                                "kind": "message_delta",
                                "text": text,
                            }),
                        );
                    }
                    BridgeEvent::Thinking { text } => {
                        sm.send_to_session_ws(
                            &staff_sid,
                            json!({
                                "type": "dispatch_stream",
                                "session_id": staff_sid,
                                "target_id": target_id,
                                "kind": "thinking",
                                "text": text,
                            }),
                        );
                    }
                    BridgeEvent::ToolStart { tool_id, name, .. } => {
                        sm.send_to_session_ws(
                            &staff_sid,
                            json!({
                                "type": "dispatch_stream",
                                "session_id": staff_sid,
                                "target_id": target_id,
                                "kind": "tool_start",
                                "tool_id": tool_id,
                                "tool_name": name,
                            }),
                        );
                    }
                    BridgeEvent::ToolEnd {
                        tool_id, is_error, ..
                    } => {
                        sm.send_to_session_ws(
                            &staff_sid,
                            json!({
                                "type": "dispatch_stream",
                                "session_id": staff_sid,
                                "target_id": target_id,
                                "kind": "tool_end",
                                "tool_id": tool_id,
                                "is_error": is_error,
                            }),
                        );
                    }
                    BridgeEvent::Error { error } => {
                        sm.send_to_session_ws(
                            &staff_sid,
                            json!({
                                "type": "dispatch_stream",
                                "session_id": staff_sid,
                                "target_id": target_id,
                                "kind": "error",
                                "text": error,
                            }),
                        );
                    }
                    _ => {}
                }

                match &ev {
                    BridgeEvent::Init {
                        claude_session_id,
                        model,
                        ..
                    } => {
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
                    BridgeEvent::ToolStart {
                        tool_id,
                        name,
                        input,
                    } => {
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
                    BridgeEvent::ToolEnd {
                        tool_id,
                        output,
                        is_error,
                    } => {
                        content.push(json!({"type":"tool_result","tool_id":tool_id,
                            "output":output,"is_error":is_error}));
                    }
                    BridgeEvent::Cost {
                        usage: u,
                        cost_usd: c,
                        model,
                    } => {
                        usage = u.clone();
                        cost_usd = *c;
                        if model != "unknown" {
                            model_name = Some(model.clone());
                        }
                    }
                    // Terminal event of the per-turn protocol. Daemon/ACP
                    // bridges (Gemini, Codex, OpenCode, Cursor, Antigravity)
                    // never close their `rx` on their own — the JSON-RPC
                    // client keeps a notification handler that retains a
                    // `tx.clone()` for the life of the bridge. Without this
                    // break the dispatched run ignores the agent's completion
                    // and spins until DISPATCH_TIMEOUT, so the staff
                    // "Dispatching…" card hangs ~12 min and then resolves as a
                    // FALSE failure even though the agent already finished and
                    // produced its answer. Mirrors the identical guard in
                    // `run_send_flow` (the primary chat loop).
                    BridgeEvent::Status { status } if status == "done" => break,
                    _ => {}
                }

                // Throttled mid-stream persist so the dispatched
                // agent's chat-view shows partial progress on remount.
                // Same shape as run_send_flow.
                if !content.is_empty() && last_persist_at.elapsed() >= persist_throttle {
                    let _ = sqlx::query("UPDATE messages SET content = ?, model = ? WHERE id = ?")
                        .bind(Value::Array(content.clone()).to_string())
                        .bind(&model_name)
                        .bind(&assistant_msg_id)
                        .execute(&pool)
                        .await;
                    last_persist_at = std::time::Instant::now();
                }
            }
        },
    )
    .await;
    let timed_out = stream_result.is_err();
    if timed_out {
        bridge_for_abort.abort().await;
        tracing::warn!(
            target: "dispatch",
            session_id = %target_id,
            staff = %staff_sid,
            secs = DISPATCH_TIMEOUT_SECS,
            "dispatched task timed out — aborting bridge"
        );
    }

    // Finalize the placeholder assistant row we INSERTed before the
    // stream loop. Empty content (immediate abort / no output) drops
    // the placeholder so the target's transcript stays clean.
    if content.is_empty() {
        let _ = sqlx::query("DELETE FROM messages WHERE id = ?")
            .bind(&assistant_msg_id)
            .execute(&pool)
            .await;
    } else {
        let _ = sqlx::query(
            "UPDATE messages SET content = ?, model = ?, usage_json = ?, \
             cost_usd = ?, timestamp = ? WHERE id = ?",
        )
        .bind(Value::Array(content).to_string())
        .bind(&model_name)
        .bind(if usage.is_null() {
            None
        } else {
            Some(usage.to_string())
        })
        .bind(cost_usd)
        .bind(chrono::Utc::now().to_rfc3339())
        .bind(&assistant_msg_id)
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

        // Cloud telemetry — same shape as the chat-handle path, with
        // `routing_decision_id` plumbed through from the dispatch's
        // RoutingResolution so analytics can join the cost back to the
        // routing decision that picked the (agent, model). Fire-and-forget
        // into the outbox; the WS client drains it when it lands.
        let in_t = usage
            .get("input_tokens")
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        let out_t = usage
            .get("output_tokens")
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
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
        let target_id_owned = target_id.clone();
        let decision_id_for_cost = routing_res.decision_id.clone();
        tokio::spawn(async move {
            let _ = crate::services::telemetry::emit_cost(
                &target_id_owned,
                &cost_model,
                in_t,
                out_t,
                cache_r,
                cache_w,
                cost_usd,
                now_utc,
                decision_id_for_cost.as_deref(),
            )
            .await;
        });
    }
    let final_status = if timed_out { "error" } else { "idle" };
    let _ = sm.update_status(&pool, &target_id, final_status).await;

    // Result card on staff side: trim the summary so it fits the
    // inline card. Long agent runs get a "…" cutoff. Timeout path
    // emits a fixed failure summary so the staff card resolves
    // even when the bridge had no usable partial output.
    let success = !timed_out;
    let preview = if timed_out {
        format!(
            "Task timed out after {} minutes — bridge aborted.",
            DISPATCH_TIMEOUT_SECS / 60
        )
    } else {
        let p: String = summary_text.chars().take(600).collect();
        if summary_text.chars().count() > 600 {
            format!("{p}…")
        } else {
            p
        }
    };
    persist_dispatch_result_with_path(
        &pool,
        &staff_sid,
        &target_id,
        Some(&target.title),
        &task_for_card,
        success,
        &preview,
        Some(&target.project_path),
    )
    .await;
    // Always clear the target's ancestry chain when its run ends
    // (success, timeout, or error). Without this, a re-dispatched
    // session would inherit stale ancestry from a prior run and
    // could trip the cycle-detection check spuriously.
    sm.clear_dispatch_chain(&target_id);
    // Live push to the caller WS so the pending card resolves
    // immediately. Persistence above is the on-reload backstop;
    // this is the live UX. `target_name` + `project_path` let the
    // renderer's DispatchResultCard render correctly even before the
    // sessions list has hydrated (e.g. fresh cold-start race).
    sm.send_to_session_ws(
        &staff_sid,
        json!({
            "type": "dispatch_result",
            "session_id": staff_sid,
            "target_id": target_id,
            "target_name": target.title,
            "task": task_for_card,
            "success": success,
            "summary": preview,
            "project_path": target.project_path,
        }),
    );
}

/// Persist a `system`-role `dispatch_result` message on the staff
/// session's transcript. Used in early-exit paths where the target's
/// project_path isn't readily available — see
/// [`persist_dispatch_result_with_path`] for the regular path.
async fn persist_dispatch_result(
    pool: &sqlx::SqlitePool,
    staff_sid: &str,
    target_id: &str,
    target_name: Option<&str>,
    task: &str,
    success: bool,
    summary: &str,
) {
    persist_dispatch_result_with_path(
        pool,
        staff_sid,
        target_id,
        target_name,
        task,
        success,
        summary,
        None,
    )
    .await
}

/// Persist a `system`-role `dispatch_result` message on the staff
/// session's transcript. The renderer's dispatch-card widget reads
/// this block back on next reload, so the pending card resolves
/// regardless of whether the staff WS was open when the dispatched
/// task finished. Faithful with the chat.py "persist as fallback"
/// branch when the live WS push fails.
///
/// `target_name` and `project_path` are persisted alongside the
/// block so the DispatchResultCard can render the agent's title and
/// full project folder even after a full reload, when the live
/// `target_id → session.title` lookup might miss (archived agents,
/// fresh app launches before the sessions list has hydrated).
#[allow(clippy::too_many_arguments)]
async fn persist_dispatch_result_with_path(
    pool: &sqlx::SqlitePool,
    staff_sid: &str,
    target_id: &str,
    target_name: Option<&str>,
    task: &str,
    success: bool,
    summary: &str,
    project_path: Option<&str>,
) {
    let mut block_entry = json!({
        "type": "dispatch_result",
        "agent_id": target_id,
        "task": task,
        "success": success,
        "summary": summary,
    });
    if let Value::Object(ref mut m) = block_entry {
        if let Some(n) = target_name {
            m.insert("agent_name".into(), Value::String(n.to_string()));
        }
        if let Some(p) = project_path {
            m.insert("project_path".into(), Value::String(p.to_string()));
        }
    }
    let block = json!([block_entry]);
    persist_block_into(pool, staff_sid, &block).await;
}

async fn persist_block_into(pool: &sqlx::SqlitePool, staff_sid: &str, block: &Value) {
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
            if let Some(t) = last
                .get_mut("text")
                .and_then(|x| x.as_str().map(String::from))
            {
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
            Some("Target Agent"),
            "do the thing",
            true,
            "summary preview",
        )
        .await;
        let rows: Vec<(String, String)> =
            sqlx::query_as("SELECT role, content FROM messages WHERE session_id = 'staff-1'")
                .fetch_all(&pool)
                .await
                .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].0, "system");
        let blocks: Value = serde_json::from_str(&rows[0].1).unwrap();
        let block = &blocks[0];
        assert_eq!(block["type"], "dispatch_result");
        assert_eq!(block["agent_id"], "target-2");
        assert_eq!(block["agent_name"], "Target Agent");
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

#[cfg(test)]
mod cloudflare_tests {
    use super::cloudflare_base_url_for_account;

    #[test]
    fn builds_account_scoped_base_url() {
        assert_eq!(
            cloudflare_base_url_for_account("abc123"),
            "https://api.cloudflare.com/client/v4/accounts/abc123/ai/v1"
        );
    }
}
