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
//! Consent: nothing here runs while cloud sync is off (`cloud_gate`). The
//! loop idles without a bearer, a ticket or a socket, and a connected
//! socket is closed as soon as the gate closes.
//!
//! Logging: the bearer and the ticket appear only as `redact_token`
//! previews. Request and response bodies, response header values and frame
//! contents are never logged, and the errors the loop logs carry none of
//! them either.
//!
//! Failure modes:
//! - cloud sync off             → idle until it is turned on; no requests
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

use super::{cloud_enabled, device_id, emitters, gate_changed, outbox};

pub const WIRE_VERSION: u32 = 1;
const BACKOFF_INITIAL_S: u64 = 1;
const BACKOFF_MAX_S: u64 = 30;
const MAX_EVENTS_PER_FLUSH: i64 = 200;
/// How long a close frame may take when sync is turned off mid-connection.
const CLOSE_TIMEOUT: Duration = Duration::from_secs(2);

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

/// Long-running task. While cloud sync is on: connects to the realtime
/// endpoint, replays the outbox, listens for acks, reconnects with
/// exponential backoff. While it is off: waits for it to be turned on.
/// Never returns (cancellation expected on shutdown).
pub async fn run_ws_client_loop(bearer_source: BearerSource) {
    let mut backoff_secs = BACKOFF_INITIAL_S;
    loop {
        wait_until_cloud_enabled().await;
        match one_connection_attempt(&bearer_source).await {
            Ok(_) => {
                // Clean disconnect (server closed, or sync turned off).
                // Reset backoff so we reconnect quickly.
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

/// Returns once cloud sync is on. The `notified()` future is created
/// before the flag is checked: it receives `notify_waiters()` from the
/// moment it exists, so a gate change landing between the check and the
/// await still wakes it.
async fn wait_until_cloud_enabled() {
    loop {
        let changed = gate_changed().notified();
        if cloud_enabled() {
            return;
        }
        changed.await;
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
    // Sync may have been turned off while the bearer was being fetched.
    if !cloud_enabled() {
        return Ok(());
    }

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
    if !cloud_enabled() {
        return Ok(());
    }

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
    // Header names only: a value could echo the ticket subprotocol.
    tracing::info!(
        target: "fleetify.telemetry.ws",
        "← ws handshake response status={} headers={:?}",
        handshake_resp.status(),
        handshake_resp
            .headers()
            .keys()
            .map(|k| k.as_str())
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
        // Created before the check, like in `wait_until_cloud_enabled`: a
        // close landing after the check still wakes the select below.
        let gate = gate_changed().notified();
        tokio::pin!(gate);
        if !cloud_enabled() {
            tracing::info!(
                target: "fleetify.telemetry.ws",
                "cloud sync turned off; closing the socket"
            );
            let _ = tokio::time::timeout(CLOSE_TIMEOUT, write.close()).await;
            return Ok(());
        }
        tokio::select! {
            biased;
            // Gate change: the check at the top of the loop acts on it.
            _ = &mut gate => {}
            // Outbox drainer
            _ = notify.notified() => {
                let pending = outbox::peek_pending(MAX_EVENTS_PER_FLUSH).await?;
                if pending.is_empty() {
                    continue;
                }
                tracing::info!(target: "fleetify.telemetry.ws", "→ sending {} events", pending.len());
                for (event_id, payload) in pending {
                    // Turned off mid-batch: stop here. The purge has
                    // dropped the rest; the loop top closes the socket.
                    if !cloud_enabled() {
                        break;
                    }
                    let frame = event_frame(&event_id, &payload)?;
                    tracing::info!(
                        target: "fleetify.telemetry.ws",
                        "→ send {}",
                        frame_log(&frame)
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
                            "← recv {}", frame_log(&t)
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

/// The wire frame for one outbox row. Sends the row's cloud view: new rows
/// are minimised when queued (and the view leaves them unchanged), but rows
/// queued by older builds may still carry activity summaries and full
/// project paths.
fn event_frame(event_id: &str, payload: &Value) -> Result<String> {
    let envelope = json!({
        "v": WIRE_VERSION,
        "type": "event",
        "id": event_id,
        "payload": emitters::cloud_view(payload),
    });
    Ok(serde_json::to_string(&envelope)?)
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
    fetch_ticket_at(&ticket_url(), bearer, device_id).await
}

/// [`fetch_ticket`] against `url`, so tests can point it at a local server.
///
/// Logs and errors carry the status and, at most, the ticket's redacted
/// preview: never the body (a server may echo the bearer in an error) or
/// the response headers.
async fn fetch_ticket_at(url: &str, bearer: &str, device_id: &str) -> Result<String> {
    let payload = json!({ "deviceId": device_id });
    tracing::info!(target: "fleetify.telemetry.ws", "→ ticket POST url={url}");
    let r = reqwest::Client::new()
        .post(url)
        .header("Authorization", format!("Bearer {bearer}"))
        .json(&payload)
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| anyhow!("ticket POST failed: {e}"))?;
    let status = r.status();
    let body_text = r.text().await.unwrap_or_default();
    let body = serde_json::from_str::<Value>(&body_text);
    let ticket = body
        .as_ref()
        .ok()
        .and_then(|b| b.get("ticket"))
        .and_then(Value::as_str)
        .map(String::from);
    tracing::info!(
        target: "fleetify.telemetry.ws",
        "← ticket response {}",
        ticket_response_log(status, ticket.as_deref())
    );
    if !status.is_success() {
        return Err(anyhow!(
            "ticket POST returned {} ({})",
            status.as_u16(),
            status.canonical_reason().unwrap_or("")
        ));
    }
    // serde_json's message is a position, never the text.
    body.map_err(|e| anyhow!("ticket response decode failed: {e}"))?;
    ticket.ok_or_else(|| anyhow!("ticket response has no `ticket` field"))
}

/// How the ticket endpoint's answer appears in the log: its status and,
/// when it holds a ticket, that ticket's redacted preview.
fn ticket_response_log(status: reqwest::StatusCode, ticket: Option<&str>) -> String {
    match ticket {
        Some(ticket) => format!("status={} ticket={}", status.as_u16(), redact_token(ticket)),
        None => format!("status={}", status.as_u16()),
    }
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

/// How a WebSocket frame appears in the log: its `type`, its `id` and, for
/// an event, the payload's `kind`. Never the rest: an event carries session
/// titles and folder names.
fn frame_log(text: &str) -> String {
    let Ok(frame) = serde_json::from_str::<Value>(text) else {
        return format!("<{} bytes, not JSON>", text.len());
    };
    let field = |v: Option<&Value>| {
        v.and_then(Value::as_str)
            .map_or_else(|| "-".to_string(), |s| truncate(s, 64))
    };
    let mut line = format!(
        "type={} id={}",
        field(frame.get("type")),
        field(frame.get("id"))
    );
    if let Some(kind) = frame.get("payload").and_then(|p| p.get("kind")) {
        line.push_str(&format!(" kind={}", field(Some(kind))));
    }
    line
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

/// Log why the WebSocket upgrade failed: the HTTP status, or the
/// underlying cause when there was no HTTP answer.
fn log_ws_error(e: &tokio_tungstenite::tungstenite::Error) {
    use tokio_tungstenite::tungstenite::Error as WsErr;
    match e {
        // The status only: the body or a header could echo the ticket.
        WsErr::Http(resp) => {
            tracing::warn!(
                target: "fleetify.telemetry.ws",
                "← ws upgrade refused: HTTP {}",
                resp.status()
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
    use crate::services::telemetry::cloud_gate::test_support::GateGuard;
    use crate::services::telemetry::set_cloud_enabled;
    use crate::test_support::LogCapture;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[tokio::test]
    async fn ws_loop_stays_idle_while_the_gate_is_closed() {
        let _g = outbox::tests::TEST_LOCK.lock().await;
        let _gate = GateGuard::new();
        set_cloud_enabled(false).await;

        let calls = Arc::new(AtomicUsize::new(0));
        let counter = calls.clone();
        let source: BearerSource = Arc::new(move || {
            counter.fetch_add(1, Ordering::SeqCst);
            Box::pin(async { None })
        });

        let run =
            tokio::time::timeout(Duration::from_millis(300), run_ws_client_loop(source)).await;
        assert!(
            run.is_err(),
            "the loop never returns; the timeout must fire"
        );
        assert_eq!(
            calls.load(Ordering::SeqCst),
            0,
            "no bearer may be fetched while cloud sync is off"
        );
    }

    #[tokio::test]
    async fn ws_loop_wakes_up_when_the_gate_opens() {
        let _g = outbox::tests::TEST_LOCK.lock().await;
        let _gate = GateGuard::new();
        set_cloud_enabled(false).await;

        let calls = Arc::new(AtomicUsize::new(0));
        let counter = calls.clone();
        // Not signed in: the loop then pauses for BACKOFF_MAX_S, so it asks once.
        let source: BearerSource = Arc::new(move || {
            counter.fetch_add(1, Ordering::SeqCst);
            Box::pin(async { None })
        });
        let task = tokio::spawn(run_ws_client_loop(source));
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(calls.load(Ordering::SeqCst), 0);

        set_cloud_enabled(true).await;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
        while calls.load(Ordering::SeqCst) == 0 && tokio::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        task.abort();
        assert_eq!(
            calls.load(Ordering::SeqCst),
            1,
            "opening the gate must wake the idle loop"
        );
    }

    #[test]
    fn event_frames_send_only_the_cloud_view() {
        // A row an older build queued: it still has the summary and the full path.
        let frame = event_frame(
            "evt-1",
            &json!({
                "kind": "activity",
                "local_session_id": "s1",
                "activity_kind": "command",
                "activity_summary": "export TOKEN=x",
                "project_path": "/home/u/work/fleetify",
            }),
        )
        .unwrap();
        let v: Value = serde_json::from_str(&frame).unwrap();
        assert_eq!(v["v"], WIRE_VERSION);
        assert_eq!(v["type"], "event");
        assert_eq!(v["id"], "evt-1");
        assert_eq!(v["payload"]["activity_kind"], "command");
        assert!(
            v["payload"].get("activity_summary").is_none(),
            "summary on the wire: {frame}"
        );
        assert_eq!(v["payload"]["project_path"], "fleetify");
    }

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

    const BEARER: &str = "bearer-0123456789-SECRET-abcdef";
    const TICKET: &str = "tkt_0123456789-SECRET-ticket-wxyz";

    #[tokio::test]
    async fn the_ticket_response_is_logged_as_its_status_and_a_redacted_preview() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/realtime/ticket"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("set-cookie", "session=cookie-SECRET")
                    .set_body_json(json!({ "ticket": TICKET, "note": "body-SECRET" })),
            )
            .mount(&server)
            .await;

        let logs = LogCapture::start();
        let ticket = fetch_ticket_at(
            &format!("{}/api/realtime/ticket", server.uri()),
            BEARER,
            "device-1",
        )
        .await
        .unwrap();
        let text = logs.text();

        assert_eq!(ticket, TICKET);
        assert!(text.contains("status=200"), "{text}");
        assert!(text.contains(&redact_token(TICKET)), "{text}");
        assert!(
            !text.contains("SECRET"),
            "a secret or the body was logged: {text}"
        );
    }

    #[tokio::test]
    async fn a_refused_ticket_request_logs_and_reports_only_its_status() {
        use wiremock::matchers::method;
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let server = MockServer::start().await;
        // A server that echoes the request back in its error.
        Mock::given(method("POST"))
            .respond_with(
                ResponseTemplate::new(401)
                    .set_body_json(json!({ "error": format!("bad token {BEARER}") })),
            )
            .mount(&server)
            .await;

        let logs = LogCapture::start();
        let err = fetch_ticket_at(&server.uri(), BEARER, "device-1")
            .await
            .unwrap_err()
            .to_string();
        let text = logs.text();

        // The loop logs this error as is.
        assert!(err.contains("401"), "{err}");
        assert!(!err.contains("SECRET"), "{err}");
        assert!(text.contains("status=401"), "{text}");
        assert!(!text.contains("SECRET"), "{text}");
    }

    #[tokio::test]
    async fn an_unreadable_ticket_response_never_shows_its_body() {
        use wiremock::matchers::method;
        use wiremock::{Mock, MockServer, ResponseTemplate};

        for body in [
            format!("ticket={TICKET}"),             // not JSON
            json!({ "token": TICKET }).to_string(), // no `ticket` field
        ] {
            let server = MockServer::start().await;
            Mock::given(method("POST"))
                .respond_with(ResponseTemplate::new(200).set_body_string(body.clone()))
                .mount(&server)
                .await;

            let logs = LogCapture::start();
            let err = fetch_ticket_at(&server.uri(), BEARER, "device-1")
                .await
                .unwrap_err()
                .to_string();
            let text = logs.text();
            assert!(!err.contains("SECRET"), "{body}: {err}");
            assert!(!text.contains("SECRET"), "{body}: {text}");
        }
    }

    #[test]
    fn frames_are_logged_by_type_id_and_kind_only() {
        let event = event_frame(
            "evt-1",
            &json!({
                "kind": "session_start",
                "session_title": "title-SECRET",
                "project_path": "/home/u/folder-SECRET",
            }),
        )
        .unwrap();
        let line = frame_log(&event);
        assert!(line.contains("type=event"), "{line}");
        assert!(line.contains("id=evt-1"), "{line}");
        assert!(line.contains("kind=session_start"), "{line}");
        assert!(!line.contains("SECRET"), "{line}");

        let ack = frame_log(r#"{"v":1,"type":"ack","id":"evt-1"}"#);
        assert!(
            ack.contains("type=ack") && ack.contains("id=evt-1"),
            "{ack}"
        );

        let raw = frame_log("not json SECRET");
        assert!(!raw.contains("SECRET"), "{raw}");
        assert!(raw.contains("15 bytes"), "{raw}");
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
