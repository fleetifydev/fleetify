//! Phase 1d /ws/sessions protocol smoke (no `claude` CLI required):
//!   - auth via ?token= (plus the API token in ?api_token=), ping→pong
//!   - subscribe owned session → init
//!   - subscribe foreign id → error
//!
//! Send→ClaudeBridge flow needs a real CLI and is exercised by manual
//! e2e in Tauri dev. The fidelity-critical stream-json parser is unit-
//! tested in `bridges::claude::tests`.

mod common;

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine;
use common::TestServer;
use fleetify_backend::access::API_TOKEN_QUERY;
use futures_util::{SinkExt, StreamExt};
use jsonwebtoken::{encode, EncodingKey, Header};
use rsa::pkcs8::EncodePrivateKey;
use rsa::traits::PublicKeyParts;
use rsa::{RsaPrivateKey, RsaPublicKey};
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::Message as Frame;

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}

#[tokio::test]
async fn ws_sessions_subscribe_and_ping() {
    // RSA + mock JWKS.
    let mut rng = rand::thread_rng();
    let priv_key = RsaPrivateKey::new(&mut rng, 2048).unwrap();
    let pem = priv_key.to_pkcs8_pem(rsa::pkcs8::LineEnding::LF).unwrap();
    let pub_key = RsaPublicKey::from(&priv_key);
    let b64 = base64::engine::general_purpose::URL_SAFE_NO_PAD;
    let n = b64.encode(pub_key.n().to_bytes_be());
    let e = b64.encode(pub_key.e().to_bytes_be());
    let doc = json!({ "keys": [{ "kty":"RSA","kid":"test","alg":"RS256","n":n,"e":e }] });
    let jwks_app = axum::Router::new().route(
        "/api/auth/jwks",
        axum::routing::get(move || {
            let d = doc.clone();
            async move { axum::Json(d) }
        }),
    );
    let jl = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let jaddr = jl.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(jl, jwks_app).await.unwrap() });

    let origin = format!("http://127.0.0.1:{}", jaddr.port());
    std::env::set_var("FLEET_DB_URL", "sqlite::memory:");
    std::env::set_var("FLEETIFY_ISSUER", &origin);
    std::env::set_var("FLEETIFY_AUDIENCE", "http://127.0.0.1:8765");

    let server = TestServer::start().await;
    let base = server.url("");
    let ws_base = format!("ws://{}", server.addr());

    let mut header = Header::new(jsonwebtoken::Algorithm::RS256);
    header.kid = Some("test".into());
    let token = encode(
        &header,
        &json!({
            "sub": "u1", "email": "a@b.com",
            "iss": format!("{origin}/api/auth"),
            "aud": "http://127.0.0.1:8765",
            "iat": now(), "exp": now() + 3600
        }),
        &EncodingKey::from_rsa_pem(pem.as_bytes()).unwrap(),
    )
    .unwrap();

    // Create a real session via REST (needed for owned-subscribe). The
    // client sends the API token.
    let client = server.client();
    let s: Value = client
        .post(format!("{base}/api/sessions"))
        .bearer_auth(&token)
        .json(&json!({ "title":"T", "project_path": std::env::temp_dir().to_string_lossy() }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let sid = s["id"].as_str().unwrap().to_string();

    // Connect WS with the bearer and the API token in the query.
    let (mut ws, _) = tokio_tungstenite::connect_async(format!(
        "{ws_base}/ws/sessions?token={token}&{API_TOKEN_QUERY}={}",
        server.token.as_str()
    ))
    .await
    .expect("ws connect");

    // ping → pong
    ws.send(Frame::text(json!({"type":"ping"}).to_string()))
        .await
        .unwrap();
    let pong = recv_json(&mut ws).await;
    assert_eq!(pong["type"], "pong");

    // subscribe owned → init
    ws.send(Frame::text(
        json!({"type":"subscribe","session_ids":[sid]}).to_string(),
    ))
    .await
    .unwrap();
    let init = recv_json(&mut ws).await;
    assert_eq!(init["type"], "init");
    assert_eq!(init["session_id"], sid);
    assert_eq!(init["model"], "pending");

    // subscribe a bogus id → error scoped to that sid
    ws.send(Frame::text(
        json!({"type":"subscribe","session_ids":["00000000-0000-0000-0000-000000000000"]})
            .to_string(),
    ))
    .await
    .unwrap();
    let err = recv_json(&mut ws).await;
    assert_eq!(err["type"], "error");
    assert_eq!(err["session_id"], "00000000-0000-0000-0000-000000000000");

    let _ = ws.close(None).await;
    server.handle.shutdown();
}

async fn recv_json<S>(ws: &mut S) -> Value
where
    S: StreamExt<Item = Result<Frame, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
    // Up to ~3s; ignore non-text frames (ping/pong/close).
    let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
    while tokio::time::Instant::now() < deadline {
        match tokio::time::timeout(Duration::from_millis(500), ws.next()).await {
            Ok(Some(Ok(Frame::Text(t)))) => return serde_json::from_str(t.as_str()).expect("json"),
            Ok(Some(Ok(_))) => continue,
            Ok(Some(Err(e))) => panic!("ws err: {e}"),
            Ok(None) => panic!("ws closed early"),
            Err(_) => continue,
        }
    }
    panic!("no json frame within deadline")
}
