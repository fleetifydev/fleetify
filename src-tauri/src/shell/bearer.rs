//! Loopback bearer bridge — faithful port of `electron/bearer-bridge.cjs`.
//! `GET http://127.0.0.1:8770/auth/access-token`:
//!   200 {token,expires_at} | 401 {error:"not-signed-in"} |
//!   503 {error:"refresh-failed",detail}. Peer hard-pinned to loopback.

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

pub async fn run() {
    let listener = match TcpListener::bind(("127.0.0.1", 8770u16)).await {
        Ok(l) => l,
        Err(e) => {
            tracing::error!("bearer-bridge bind failed: {e}");
            return;
        }
    };
    tracing::info!("bearer-bridge listening on http://127.0.0.1:8770/auth/access-token");
    loop {
        let (mut sock, peer) = match listener.accept().await {
            Ok(x) => x,
            Err(_) => continue,
        };
        tokio::spawn(async move {
            let ok_peer = peer.ip().is_loopback();
            let mut buf = [0u8; 2048];
            let n = match sock.read(&mut buf).await {
                Ok(n) => n,
                Err(_) => return,
            };
            let head = String::from_utf8_lossy(&buf[..n]);
            let first = head.lines().next().unwrap_or("");
            let mut it = first.split_whitespace();
            let method = it.next().unwrap_or("");
            let path = it.next().unwrap_or("");

            let (status, body): (u16, String) = if !ok_peer {
                (403, String::new())
            } else if method != "GET" || path != "/auth/access-token" {
                (404, String::new())
            } else {
                match super::auth::refresh_if_needed(false).await {
                    Ok(t) => (
                        200,
                        serde_json::json!({"token": t.access_token, "expires_at": t.expires_at})
                            .to_string(),
                    ),
                    Err(e) => {
                        let m = e.to_string().to_lowercase();
                        if m.contains("no refresh token") || m.contains("invalid_grant") {
                            (401, serde_json::json!({"error":"not-signed-in"}).to_string())
                        } else {
                            (
                                503,
                                serde_json::json!({"error":"refresh-failed","detail": e.to_string()})
                                    .to_string(),
                            )
                        }
                    }
                }
            };
            let reason = match status {
                200 => "OK",
                401 => "Unauthorized",
                403 => "Forbidden",
                404 => "Not Found",
                _ => "Service Unavailable",
            };
            let resp = format!(
                "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            let _ = sock.write_all(resp.as_bytes()).await;
        });
    }
}
