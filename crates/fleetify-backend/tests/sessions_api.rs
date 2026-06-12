//! Phase 1c integration: real `serve()` (in-memory DB) behind JWKS auth.
//! Mocks the IdP JWKS, mints a JWT, then exercises the faithful /api flow:
//! /healthz shape, POST/GET /api/sessions round-trip, 401 without bearer.

use std::net::SocketAddr;
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine;
use jsonwebtoken::{encode, EncodingKey, Header};
use rsa::pkcs8::EncodePrivateKey;
use rsa::traits::PublicKeyParts;
use rsa::{RsaPrivateKey, RsaPublicKey};

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}

#[tokio::test]
async fn sessions_api_round_trip_with_auth() {
    // 1. RSA keypair + JWK.
    let mut rng = rand::thread_rng();
    let priv_key = RsaPrivateKey::new(&mut rng, 2048).unwrap();
    let pem = priv_key.to_pkcs8_pem(rsa::pkcs8::LineEnding::LF).unwrap();
    let pub_key = RsaPublicKey::from(&priv_key);
    let b64 = base64::engine::general_purpose::URL_SAFE_NO_PAD;
    let n = b64.encode(pub_key.n().to_bytes_be());
    let e = b64.encode(pub_key.e().to_bytes_be());
    let doc = serde_json::json!({
        "keys": [{ "kty": "RSA", "kid": "test", "alg": "RS256", "n": n, "e": e }]
    });

    // 2. Mock IdP JWKS at /api/auth/jwks.
    let jwks_app = axum::Router::new().route(
        "/api/auth/jwks",
        axum::routing::get(move || {
            let d = doc.clone();
            async move { axum::Json(d) }
        }),
    );
    let jwks_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let jwks_addr = jwks_listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(jwks_listener, jwks_app).await.unwrap();
    });

    // 3. Env for serve()'s AuthConfig::from_env + in-memory DB.
    let origin = format!("http://127.0.0.1:{}", jwks_addr.port());
    std::env::set_var("FLEET_DB_URL", "sqlite::memory:");
    std::env::set_var("FLEETIFY_ISSUER", &origin);
    std::env::set_var("FLEETIFY_AUDIENCE", "http://127.0.0.1:8765");

    // 4. Boot the real backend.
    let addr: SocketAddr = "127.0.0.1:0".parse().unwrap();
    let handle = fleetify_backend::serve(addr, None).await.expect("serve");
    let base = format!("http://{}", handle.local_addr());

    // 5. Mint a valid JWT (iss = auth_base, aud = expected).
    let mut header = Header::new(jsonwebtoken::Algorithm::RS256);
    header.kid = Some("test".into());
    let token = encode(
        &header,
        &serde_json::json!({
            "sub": "user-1", "email": "a@b.com", "name": "Alice",
            "iss": format!("{origin}/api/auth"),
            "aud": "http://127.0.0.1:8765",
            "iat": now(), "exp": now() + 3600
        }),
        &EncodingKey::from_rsa_pem(pem.as_bytes()).unwrap(),
    )
    .unwrap();

    let client = reqwest::Client::new();

    // /healthz shape (parity {"status":"ok","version":"0.1.0"}).
    let hz: serde_json::Value = client
        .get(format!("{base}/healthz"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(hz["status"], "ok");
    assert_eq!(hz["version"], "0.1.0");

    // No bearer → 401.
    let unauth = client
        .get(format!("{base}/api/sessions"))
        .send()
        .await
        .unwrap();
    assert_eq!(unauth.status().as_u16(), 401);

    // POST /api/sessions (project_path must be an existing dir).
    let tmp = std::env::temp_dir();
    let created = client
        .post(format!("{base}/api/sessions"))
        .bearer_auth(&token)
        .json(&serde_json::json!({ "title": "T", "project_path": tmp.to_string_lossy() }))
        .send()
        .await
        .unwrap();
    assert_eq!(created.status().as_u16(), 200, "create failed");
    let s: serde_json::Value = created.json().await.unwrap();
    assert!(s["id"].as_str().is_some());
    assert_eq!(s["tool"], "claude-code");
    assert_eq!(
        s["command"],
        "claude -p --output-format stream-json --verbose"
    );

    // GET /api/sessions → contains it.
    let list: serde_json::Value = client
        .get(format!("{base}/api/sessions"))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(list.as_array().unwrap().iter().any(|x| x["id"] == s["id"]));

    handle.shutdown();
}
