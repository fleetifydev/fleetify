//! WebSocket client to the cloud's DeviceDO. Phase-4 cut — faithful
//! subset of `services/telemetry/ws_client.py`.
//!
//! Each desktop install opens exactly one long-lived WebSocket to
//! `wss://api.fleetify.dev/api/realtime/connect` (or the dev/preview
//! base). Events flow outbox → socket as fast as the network allows;
//! acks coming back delete rows from the outbox.
//!
//! Wire shape (v=1, JSON):
//!   client → server: `{ "v":1, "type":"event", "id":"<uuid>", "payload":{…} }`
//!   server → client: `{ "v":1, "type":"ack",   "id":"<uuid>" }`
//!
//! Failure modes:
//! - bearer not signed in       → long pause; no requests
//! - bearer fetch / ticket fail → exponential backoff
//! - WS upgrade 401             → backoff + refresh
//! - WS disconnect mid-flow     → reconnect; replay unacked from outbox

use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Result};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::Message;

use super::{device_id, emitters, outbox};

pub const WIRE_VERSION: u32 = 1;
const BACKOFF_INITIAL_S: u64 = 1;
const BACKOFF_MAX_S: u64 = 30;
const MAX_EVENTS_PER_FLUSH: i64 = 200;

fn issuer() -> String {
    std::env::var("FLEETIFY_ISSUER").unwrap_or_else(|_| "https://fleetify.dev".to_string())
}
fn ticket_url() -> String {
    format!("{}/api/realtime/ticket", issuer().trim_end_matches('/'))
}
fn ws_url() -> String {
    let base = issuer();
    let trimmed = base.trim_end_matches('/');
    let url = if let Some(rest) = trimmed.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = trimmed.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        format!("ws://{trimmed}")
    };
    format!("{url}/api/realtime/connect")
}

/// Bearer source. The host (Tauri shell or backend test harness)
/// provides a callback that returns the current Fleetify access token
/// (or None if the user isn't signed in).
pub type BearerSource = Arc<
    dyn Fn() -> std::pin::Pin<
            Box<dyn std::future::Future<Output = Option<String>> + Send>,
        > + Send
        + Sync,
>;

/// Long-running task. Connects to the realtime endpoint, replays the
/// outbox, listens for acks, reconnects with exponential backoff.
/// Never returns (cancellation expected on shutdown).
pub async fn run_ws_client_loop(bearer_source: BearerSource) {
    let mut backoff_secs = BACKOFF_INITIAL_S;
    loop {
        match one_connection_attempt(&bearer_source).await {
            Ok(_) => {
                // Clean disconnect (e.g. server closed). Reset backoff so
                // we reconnect quickly.
                backoff_secs = BACKOFF_INITIAL_S;
            }
            Err(e) => {
                tracing::warn!(
                    target: "fleetify.telemetry.ws",
                    "ws connection failed: {e}; sleeping {backoff_secs}s"
                );
                tokio::time::sleep(Duration::from_secs(backoff_secs)).await;
                backoff_secs = (backoff_secs * 2).min(BACKOFF_MAX_S);
            }
        }
    }
}

async fn one_connection_attempt(bearer_source: &BearerSource) -> Result<()> {
    let bearer = match bearer_source().await {
        Some(b) => b,
        None => {
            // Not signed in — long pause before we even try.
            tokio::time::sleep(Duration::from_secs(BACKOFF_MAX_S)).await;
            return Err(anyhow!("not signed in"));
        }
    };

    // 1. Fetch a ticket.
    let device = device_id::get_or_create();
    let ticket = fetch_ticket(&bearer, &device.device_id).await?;

    // 2. Open the WS.
    let url = format!("{}?ticket={}", ws_url(), urlencoding_minimal(&ticket));
    let (ws_stream, _) = tokio_tungstenite::connect_async(&url)
        .await
        .map_err(|e| anyhow!("WS upgrade failed: {e}"))?;
    let (mut write, mut read) = ws_stream.split();
    tracing::info!(target: "fleetify.telemetry.ws", "connected to {url}");

    // 3. Drain outbox immediately on (re)connect — replays anything
    //    unacked from a prior session.
    let notify = emitters::event_available();
    notify.notify_one();

    let mut last_ping = std::time::Instant::now();
    let ping_interval = Duration::from_secs(30);

    loop {
        tokio::select! {
            biased;
            // Outbox drainer
            _ = notify.notified() => {
                let pending = outbox::peek_pending(MAX_EVENTS_PER_FLUSH).await?;
                if pending.is_empty() {
                    continue;
                }
                tracing::info!(target: "fleetify.telemetry.ws", "sending {} events", pending.len());
                for (event_id, payload) in pending {
                    let envelope = json!({
                        "v": WIRE_VERSION,
                        "type": "event",
                        "id": event_id,
                        "payload": payload,
                    });
                    let frame = serde_json::to_string(&envelope)?;
                    write.send(Message::Text(frame)).await
                        .map_err(|e| anyhow!("ws send failed: {e}"))?;
                }
            }
            // Ack receiver / hibernation keepalive
            msg = read.next() => {
                let Some(msg) = msg else {
                    return Err(anyhow!("ws stream closed by server"));
                };
                let msg = msg.map_err(|e| anyhow!("ws read failed: {e}"))?;
                match msg {
                    Message::Text(t) => handle_inbound(&t).await,
                    Message::Binary(_) => {}
                    Message::Ping(b) => {
                        let _ = write.send(Message::Pong(b)).await;
                    }
                    Message::Pong(_) => {}
                    Message::Frame(_) => {}
                    Message::Close(_) => return Err(anyhow!("ws closed by peer")),
                }
            }
            // Keepalive ping
            _ = tokio::time::sleep(ping_interval.saturating_sub(last_ping.elapsed())) => {
                if last_ping.elapsed() >= ping_interval {
                    let _ = write.send(Message::Ping(Vec::new())).await;
                    last_ping = std::time::Instant::now();
                }
            }
        }
    }
}

async fn handle_inbound(text: &str) {
    let Ok(msg): Result<Value, _> = serde_json::from_str(text) else {
        return;
    };
    let kind = msg.get("type").and_then(|v| v.as_str()).unwrap_or("");
    match kind {
        "ack" => {
            if let Some(id) = msg.get("id").and_then(|v| v.as_str()) {
                let _ = outbox::mark_acked(id).await;
            }
        }
        "nack" => {
            if let Some(id) = msg.get("id").and_then(|v| v.as_str()) {
                // Bump attempt count but keep the row — caller may want
                // to retry or surface the failure.
                let _ = outbox::bump_attempt(id).await;
            }
        }
        _ => {}
    }
}

async fn fetch_ticket(bearer: &str, device_id: &str) -> Result<String> {
    let r = reqwest::Client::new()
        .post(ticket_url())
        .header("Authorization", format!("Bearer {bearer}"))
        .json(&json!({ "deviceId": device_id }))
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| anyhow!("ticket POST failed: {e}"))?;
    if !r.status().is_success() {
        return Err(anyhow!(
            "ticket POST returned {} ({})",
            r.status().as_u16(),
            r.status().canonical_reason().unwrap_or("")
        ));
    }
    let body: Value = r
        .json()
        .await
        .map_err(|e| anyhow!("ticket response decode failed: {e}"))?;
    body.get("ticket")
        .and_then(|v| v.as_str())
        .map(String::from)
        .ok_or_else(|| anyhow!("ticket response missing `ticket` field"))
}

/// Minimal percent-encoder for ticket strings on the WS URL — UUID +
/// short opaque ticket so only `:`/`/`/`?` etc would need escaping in
/// theory. Conservative subset of `encodeURIComponent`.
fn urlencoding_minimal(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        let safe = matches!(b, b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~');
        if safe {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{:02X}", b));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ws_url_translates_http_to_ws_and_https_to_wss() {
        std::env::set_var("FLEETIFY_ISSUER", "https://fleetify.dev");
        assert_eq!(ws_url(), "wss://fleetify.dev/api/realtime/connect");
        std::env::set_var("FLEETIFY_ISSUER", "http://localhost:3001");
        assert_eq!(ws_url(), "ws://localhost:3001/api/realtime/connect");
        // Trailing slash + no scheme = ws://.
        std::env::set_var("FLEETIFY_ISSUER", "127.0.0.1:3001/");
        assert_eq!(ws_url(), "ws://127.0.0.1:3001/api/realtime/connect");
        std::env::remove_var("FLEETIFY_ISSUER");
    }

    #[test]
    fn urlencoding_handles_uuid_shaped_tickets() {
        let s = urlencoding_minimal("a1b2c3-d4e5-f6/yo?");
        assert!(!s.contains('/'));
        assert!(!s.contains('?'));
        // Letters/digits/hyphens stay verbatim.
        assert!(s.starts_with("a1b2c3-d4e5-f6"));
    }
}
