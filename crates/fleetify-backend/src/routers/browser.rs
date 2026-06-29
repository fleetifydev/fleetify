//! Browser surfaces for the shared interactive panel.
//!
//! - `GET  /ws/browser` — the panel connects here: live JPEG frames stream
//!   DOWN as binary messages; user input (click / scroll / type / key /
//!   nav) goes UP as JSON. Both ends drive the one backend-owned page.
//! - `POST /api/internal/browser/action` — the thin `fleet-browser-mcp`
//!   sidecar forwards each agent tool call here (loopback-gated by the
//!   `x-fleet-internal` secret), so the agent and the user share one browser.

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use axum::routing::{get, post};
use axum::{Json, Router};
use futures_util::{SinkExt as _, StreamExt as _};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::broadcast::error::RecvError;

use crate::routers::AppState;
use crate::services::browser;

/// Mounted at the root (alongside the chat WS), NOT under `/api`.
pub fn ws_router() -> Router<AppState> {
    Router::new()
        .route("/ws/browser", get(ws_handler))
        .route("/ws/browser-url", get(ws_url_handler))
}

/// Lightweight URL-mirror socket (no frames). DOWN: `{type:"url",url}` when the
/// backend CDP page navigates (agent action). UP: `{type:"navigate",url}` when
/// the user navigates the panel's native webview — keeps the agent's browser on
/// the same page the user is looking at.
async fn ws_url_handler(ws: WebSocketUpgrade) -> Response {
    ws.on_upgrade(handle_url_socket)
}

async fn handle_url_socket(socket: WebSocket) {
    let (mut sender, mut receiver) = socket.split();
    let mut urls = browser::subscribe_url();
    let send_task = tokio::spawn(async move {
        // Push the current URL on connect so a freshly-attached panel syncs
        // to whatever the agent already has open.
        if let Some(u) = browser::current_url_opt().await {
            if !u.is_empty() {
                let _ = sender
                    .send(Message::Text(
                        json!({ "type": "url", "url": u }).to_string().into(),
                    ))
                    .await;
            }
        }
        loop {
            match urls.recv().await {
                Ok(u) => {
                    if sender
                        .send(Message::Text(
                            json!({ "type": "url", "url": u }).to_string().into(),
                        ))
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
                Err(RecvError::Lagged(_)) => continue,
                Err(RecvError::Closed) => break,
            }
        }
    });
    while let Some(Ok(msg)) = receiver.next().await {
        if let Message::Text(t) = msg {
            if let Ok(v) = serde_json::from_str::<Value>(t.as_str()) {
                if v.get("type").and_then(|x| x.as_str()) == Some("navigate") {
                    if let Some(url) = v.get("url").and_then(|x| x.as_str()) {
                        let url = url.to_string();
                        tokio::spawn(async move {
                            let _ = browser::navigate(&url).await;
                        });
                    }
                }
            }
        }
    }
    send_task.abort();
}

/// Loopback-gated router (mounted under `/api/internal`).
pub fn internal_router() -> Router<AppState> {
    Router::new().route("/browser/action", post(action))
}

async fn ws_handler(ws: WebSocketUpgrade) -> Response {
    ws.on_upgrade(handle_socket)
}

async fn handle_socket(socket: WebSocket) {
    let (mut sender, mut receiver) = socket.split();
    let mut frames = browser::subscribe();
    // Text replies (inspector hover/pick results) flow back through this.
    let (reply_tx, mut reply_rx) = tokio::sync::mpsc::unbounded_channel::<String>();

    // DOWN: binary frames (broadcast) + JSON text replies (per-socket).
    let send_task = tokio::spawn(async move {
        // Show the current page immediately on connect (the screencast only
        // emits on the next paint, so a freshly-attached panel would be blank).
        if let Some(f) = browser::last_frame_snapshot().await {
            let _ = sender
                .send(Message::Binary(f.as_ref().clone().into()))
                .await;
        }
        loop {
            tokio::select! {
                f = frames.recv() => match f {
                    Ok(frame) => {
                        if sender
                            .send(Message::Binary(frame.as_ref().clone().into()))
                            .await
                            .is_err()
                        {
                            break;
                        }
                    }
                    Err(RecvError::Lagged(_)) => continue,
                    Err(RecvError::Closed) => break,
                },
                Some(text) = reply_rx.recv() => {
                    if sender.send(Message::Text(text.into())).await.is_err() {
                        break;
                    }
                }
            }
        }
    });

    // UP: user input events.
    while let Some(Ok(msg)) = receiver.next().await {
        if let Message::Text(t) = msg {
            handle_input(t.as_str(), &reply_tx).await;
        }
    }
    send_task.abort();
}

async fn handle_input(text: &str, reply: &tokio::sync::mpsc::UnboundedSender<String>) {
    let v: Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(_) => return,
    };
    let kind = v.get("type").and_then(|x| x.as_str()).unwrap_or("");
    let f = |k: &str| v.get(k).and_then(|x| x.as_f64()).unwrap_or(0.0);
    let s = |k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("");
    match kind {
        "click" => {
            let _ = browser::click_xy(f("x"), f("y")).await;
        }
        "scroll" => {
            let _ = browser::scroll(f("x"), f("y"), f("dy")).await;
        }
        "type" => {
            let _ = browser::type_text(s("text")).await;
        }
        "key" => {
            let _ = browser::key(s("key")).await;
        }
        "resize" => {
            let dpr = if f("dpr") > 0.0 { f("dpr") } else { 1.0 };
            let _ = browser::set_viewport(f("width") as u32, f("height") as u32, dpr).await;
        }
        "hover" => {
            if let Ok(v) = browser::hover_at(f("x"), f("y")).await {
                let _ = reply.send(json!({ "type": "hover", "data": v }).to_string());
            }
        }
        "pick" => {
            if let Ok(v) = browser::pick_at(f("x"), f("y")).await {
                let _ = reply.send(json!({ "type": "picked", "data": v }).to_string());
            }
        }
        "navigate" => {
            let _ = browser::navigate(s("url")).await;
        }
        "back" => {
            let _ = browser::back().await;
        }
        "forward" => {
            let _ = browser::forward().await;
        }
        "reload" => {
            let _ = browser::reload().await;
        }
        _ => {}
    }
}

#[derive(Deserialize)]
struct ActionReq {
    name: String,
    #[serde(default)]
    args: Value,
}

async fn action(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(b): Json<ActionReq>,
) -> Result<Json<Value>, StatusCode> {
    let presented = headers
        .get("x-fleet-internal")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if !crate::routers::internal::constant_time_eq(
        presented.as_bytes(),
        st.internal_secret.as_bytes(),
    ) {
        return Err(StatusCode::FORBIDDEN);
    }
    Ok(Json(match browser::action(&b.name, &b.args).await {
        Ok(result) => json!({ "ok": true, "result": result }),
        Err(e) => json!({ "ok": false, "error": e.to_string() }),
    }))
}
