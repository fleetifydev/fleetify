//! Faithful port of `app/routers/events.py` — SSE `/events/status`
//! streaming `{event:"status", data:{session_id,status}}`, 30s keep-alive
//! ping (parity with the on_status queue + 30s timeout ping).

use std::convert::Infallible;
use std::time::Duration;

use axum::extract::State;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::IntoResponse;
use axum::routing::get;
use axum::Router;
use serde_json::json;

use crate::routers::AppState;

pub fn router() -> Router<AppState> {
    Router::new().route("/events/status", get(status_stream))
}

async fn status_stream(State(st): State<AppState>) -> impl IntoResponse {
    let mut rx = st.sm.subscribe_status();
    let stream = async_stream::stream! {
        loop {
            match rx.recv().await {
                Ok(ev) => {
                    let data = json!({
                        "session_id": ev.session_id,
                        "status": ev.status
                    })
                    .to_string();
                    yield Ok::<Event, Infallible>(
                        Event::default().event("status").data(data),
                    );
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    };
    Sse::new(stream).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(30))
            .text("ping"),
    )
}
