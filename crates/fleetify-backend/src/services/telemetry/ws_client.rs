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

/// The realtime endpoints live on the identity provider's origin:
/// production in release builds, `FLEETIFY_ISSUER` (default: the local
/// IdP) in debug builds — the same origin the shell signs in against.
fn issuer() -> String {
    fleetify_core::endpoints::issuer_origin()
}
fn ticket_url() -> String {
    format!("{}/api/realtime/ticket", issuer().trim_end_matches('/'))
}
fn ws_url() -> String {
    ws_url_for(&issuer())
}
fn ws_url_for(base: &str) -> String {
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
    dyn Fn() -> std::pin::Pin<Box<dyn std::future::Future<Output = Option<String>> + Send>>
        + Send
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
    let bearer_preview = redact_token(&bearer);
    tracing::info!(
        target: "fleetify.telemetry.ws",
        "→ bearer acquired (len={}, prefix={})", bearer.len(), bearer_preview
    );

    // 1. Fetch a ticket.
    let device = device_id::get_or_create();
    tracing::info!(
        target: "fleetify.telemetry.ws",
        "→ device_id={} name={} platform={}",
        device.device_id, device.name, device.platform
    );
    let ticket = fetch_ticket(&bearer, &device.device_id).await?;
    tracing::info!(
        target: "fleetify.telemetry.ws",
        "← ticket acquired (len={}, prefix={})",
        ticket.len(), redact_token(&ticket)
    );

    // 2. Open the WS. Ticket is sent as the SECOND value in the
    //    `Sec-WebSocket-Protocol` subprotocol list (cloud's auth
    //    contract — query-param tickets get rejected with
    //    "missing ticket subprotocol"). Order matches Python's
    //    `subprotocols=["fleetify-rt.v1", f"ticket.{ticket}"]`.
    let url = ws_url();
    let subprotocols = format!("fleetify-rt.v1, ticket.{ticket}");
    tracing::info!(
        target: "fleetify.telemetry.ws",
        "→ ws connect_async url={} subprotocols=[fleetify-rt.v1, ticket.{}]",
        url, redact_token(&ticket)
    );
    // Build the HTTP upgrade request manually so we can attach the
    // subprotocol header. tokio-tungstenite accepts an `http::Request`
    // and runs the upgrade against it.
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    let mut req = url
        .into_client_request()
        .map_err(|e| anyhow!("ws request build failed: {e}"))?;
    req.headers_mut().insert(
        "Sec-WebSocket-Protocol",
        subprotocols
            .parse()
            .map_err(|e| anyhow!("subprotocol header invalid: {e}"))?,
    );
    let (ws_stream, handshake_resp) = match tokio_tungstenite::connect_async(req).await {
        Ok(pair) => pair,
        Err(e) => {
            log_ws_error(&e);
            return Err(anyhow!("WS upgrade failed: {e}"));
        }
    };
    tracing::info!(
        target: "fleetify.telemetry.ws",
        "← ws handshake response status={} headers={:?}",
        handshake_resp.status(),
        handshake_resp
            .headers()
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string()))
            .collect::<Vec<_>>()
    );
    let (mut write, mut read) = ws_stream.split();

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
                tracing::info!(target: "fleetify.telemetry.ws", "→ sending {} events", pending.len());
                for (event_id, payload) in pending {
                    let envelope = json!({
                        "v": WIRE_VERSION,
                        "type": "event",
                        "id": event_id,
                        "payload": payload,
                    });
                    let frame = serde_json::to_string(&envelope)?;
                    tracing::info!(
                        target: "fleetify.telemetry.ws",
                        "→ send event id={} frame={}",
                        event_id,
                        truncate(&frame, 2000)
                    );
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
                    Message::Text(t) => {
                        tracing::info!(
                            target: "fleetify.telemetry.ws",
                            "← recv text frame={}", truncate(&t, 2000)
                        );
                        handle_inbound(&t).await
                    }
                    Message::Binary(b) => {
                        tracing::info!(
                            target: "fleetify.telemetry.ws",
                            "← recv binary ({} bytes)", b.len()
                        );
                    }
                    Message::Ping(b) => {
                        tracing::debug!(target: "fleetify.telemetry.ws", "← ping ({} bytes) → pong", b.len());
                        let _ = write.send(Message::Pong(b)).await;
                    }
                    Message::Pong(_) => {
                        tracing::debug!(target: "fleetify.telemetry.ws", "← pong");
                    }
                    Message::Frame(_) => {}
                    Message::Close(cf) => {
                        tracing::warn!(
                            target: "fleetify.telemetry.ws",
                            "← close frame: {:?}", cf
                        );
                        return Err(anyhow!("ws closed by peer"));
                    }
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
        // The cloud noticed, from our own heartbeat, that we're on a catalog
        // we shouldn't be. Re-probe the pointer, which invalidates the model
        // cache when the identity really moved — this is a TRIGGER for the
        // normal pull, not an alternative source of truth. The socket is
        // auth-gated, so the pull path stays the thing that has to be correct.
        //
        // Jittered by our rollout bucket: the frame arrives on each device's
        // own heartbeat so it's already smeared across a minute, but a catalog
        // publish lands with the whole fleet's heartbeats already in flight,
        // and a deterministic 0–9s spread costs nothing to add.
        "catalog.changed" => {
            let delay = u64::from(crate::routers::providers::device_rollout_bucket() % 10);
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_secs(delay)).await;
                let r = crate::routers::providers::revalidate_remote_catalog(true).await;
                if r.changed {
                    tracing::info!(
                        target: "catalog.version",
                        "catalog change pushed by cloud; model cache invalidated"
                    );
                }
            });
        }
        _ => {}
    }
}

async fn fetch_ticket(bearer: &str, device_id: &str) -> Result<String> {
    let url = ticket_url();
    let payload = json!({ "deviceId": device_id });
    tracing::info!(
        target: "fleetify.telemetry.ws",
        "→ ticket POST url={} body={}", url, payload
    );
    let r = reqwest::Client::new()
        .post(&url)
        .header("Authorization", format!("Bearer {bearer}"))
        .json(&payload)
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| anyhow!("ticket POST failed: {e}"))?;
    let status = r.status();
    let headers: Vec<(String, String)> = r
        .headers()
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string()))
        .collect();
    let body_text = r.text().await.unwrap_or_default();
    tracing::info!(
        target: "fleetify.telemetry.ws",
        "← ticket response status={} headers={:?} body={}",
        status, headers, truncate(&body_text, 2000)
    );
    if !status.is_success() {
        return Err(anyhow!(
            "ticket POST returned {} ({}); body={}",
            status.as_u16(),
            status.canonical_reason().unwrap_or(""),
            truncate(&body_text, 500)
        ));
    }
    let body: Value = serde_json::from_str(&body_text).map_err(|e| {
        anyhow!(
            "ticket response decode failed: {e}; raw={}",
            truncate(&body_text, 500)
        )
    })?;
    body.get("ticket")
        .and_then(|v| v.as_str())
        .map(String::from)
        .ok_or_else(|| anyhow!("ticket response missing `ticket` field; got {body}"))
}

/// Redact a token/ticket to a `<first8>…<last4>` preview so logs never
/// leak the full secret but still let an operator correlate against
/// the cloud's request log.
fn redact_token(s: &str) -> String {
    if s.len() <= 12 {
        return "<short>".into();
    }
    let head: String = s.chars().take(8).collect();
    let tail: String = s
        .chars()
        .rev()
        .take(4)
        .collect::<String>()
        .chars()
        .rev()
        .collect();
    format!("{head}…{tail}")
}

/// Cap log lines at `max` chars so a 2 MB body doesn't fill the
/// terminal scrollback.
fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let head: String = s.chars().take(max).collect();
        format!("{head}…[truncated {} bytes]", s.len() - head.len())
    }
}

/// Surface every detail of a tungstenite::Error so the user sees the
/// 400's response body, headers, and underlying cause.
fn log_ws_error(e: &tokio_tungstenite::tungstenite::Error) {
    use tokio_tungstenite::tungstenite::Error as WsErr;
    match e {
        WsErr::Http(resp) => {
            let status = resp.status();
            let headers: Vec<(String, String)> = resp
                .headers()
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string()))
                .collect();
            let body = resp
                .body()
                .as_ref()
                .map(|b| String::from_utf8_lossy(b).into_owned())
                .unwrap_or_default();
            tracing::warn!(
                target: "fleetify.telemetry.ws",
                "← ws upgrade HTTP {} headers={:?} body={}",
                status, headers, truncate(&body, 2000)
            );
        }
        other => {
            tracing::warn!(
                target: "fleetify.telemetry.ws",
                "ws upgrade non-HTTP error: {other}"
            );
        }
    }
}

/// Minimal percent-encoder for ticket strings on the WS URL — kept
/// for the urlencoding_handles_uuid_shaped_tickets test that locked
/// the behaviour in before the subprotocol-based auth flip. Not used
/// in the live path anymore.
#[cfg_attr(not(test), allow(dead_code))]
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
        assert_eq!(
            ws_url_for("https://fleetify.dev"),
            "wss://fleetify.dev/api/realtime/connect"
        );
        assert_eq!(
            ws_url_for("http://localhost:3001"),
            "ws://localhost:3001/api/realtime/connect"
        );
        // Trailing slash + no scheme = ws://.
        assert_eq!(
            ws_url_for("127.0.0.1:3001/"),
            "ws://127.0.0.1:3001/api/realtime/connect"
        );
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
