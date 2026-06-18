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
    Router::new().route("/ws/browser", get(ws_handler))
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

    // DOWN: push every broadcast frame to this client as a binary message.
    let send_task = tokio::spawn(async move {
        loop {
            match frames.recv().await {
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
            }
        }
    });

    // UP: user input events.
    while let Some(Ok(msg)) = receiver.next().await {
        if let Message::Text(t) = msg {
            handle_input(t.as_str()).await;
        }
    }
    send_task.abort();
}

async fn handle_input(text: &str) {
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
