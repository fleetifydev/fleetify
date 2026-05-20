//! Phase-4 wire-conformance: marketplace source CRUD + plugin
//! install validation + MCP auth/start validation through the real
//! axum router behind JWKS auth.
//!
//! Same RSA + mock-JWKS pattern as sessions_api.rs so the same set of
//! integration deps are shared.

use std::net::SocketAddr;
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine;
use jsonwebtoken::{encode, EncodingKey, Header};
use rsa::pkcs8::EncodePrivateKey;
use rsa::traits::PublicKeyParts;
use rsa::{RsaPrivateKey, RsaPublicKey};

fn now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs() as i64
}

#[tokio::test]
async fn phase4_apis_smoke() {
    // 1. Key + JWKS doc.
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

    // 2. Mock JWKS server.
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
        let _ = axum::serve(jwks_listener, jwks_app).await;
    });
    std::env::set_var("FLEETIFY_ISSUER", format!("http://{jwks_addr}"));
    std::env::set_var("FLEET_DB_URL", "sqlite::memory:");

    // 3. Mint a JWT for user "u".
    let mut header = Header::new(jsonwebtoken::Algorithm::RS256);
    header.kid = Some("test".into());
    let claims = serde_json::json!({
        "iss": format!("http://{jwks_addr}/api/auth"),
        "aud": "http://127.0.0.1:8765",
        "sub": "u",
        "iat": now() - 1,
        "exp": now() + 60,
        "email": "u@example.com",
    });
    let key = EncodingKey::from_rsa_pem(pem.as_bytes()).unwrap();
    let token = encode(&header, &claims, &key).unwrap();
    let auth = format!("Bearer {token}");

    // 4. Start backend on an ephemeral port.
    let addr: SocketAddr = "127.0.0.1:0".parse().unwrap();
    let handle = fleetify_backend::serve(addr, None).await.unwrap();
    let base = format!("http://{}", handle.local_addr());

    let client = reqwest::Client::new();

    // ── /api/marketplace/sources auto-seeds Fleetify Official on first hit ──
    let r = client
        .get(format!("{base}/api/marketplace/sources"))
        .header("Authorization", &auth)
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    let v: serde_json::Value = r.json().await.unwrap();
    let arr = v.as_array().unwrap();
    // ensure_official_source seeds exactly one is_official=true row
    // for every fresh user so the Marketplace tab is never empty.
    assert_eq!(arr.len(), 1);
    assert_eq!(arr[0]["is_official"], true);

    // ── POST /api/marketplace/sources rejects empty name ──
    let r = client
        .post(format!("{base}/api/marketplace/sources"))
        .header("Authorization", &auth)
        .json(&serde_json::json!({ "name": "", "repo_url": "https://example.com/x" }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 400);

    // ── POST happy path ──
    let r = client
        .post(format!("{base}/api/marketplace/sources"))
        .header("Authorization", &auth)
        .json(&serde_json::json!({
            "name": "test source",
            "repo_url": "https://example.com/repo",
            "description": "for wire-conformance"
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    let v: serde_json::Value = r.json().await.unwrap();
    let source_id = v["id"].as_str().unwrap().to_string();

    // Duplicate add → 409.
    let r = client
        .post(format!("{base}/api/marketplace/sources"))
        .header("Authorization", &auth)
        .json(&serde_json::json!({
            "name": "test source duplicate",
            "repo_url": "https://example.com/repo"
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 409);

    // List → official seed + the just-added user source = 2 entries.
    let r = client
        .get(format!("{base}/api/marketplace/sources"))
        .header("Authorization", &auth)
        .send()
        .await
        .unwrap();
    let v: serde_json::Value = r.json().await.unwrap();
    let arr = v.as_array().unwrap();
    assert_eq!(arr.len(), 2);
    // User source is added_at-newer so it sorts first; official is the
    // seed with is_official = true.
    assert!(arr.iter().any(|r| r["repo_url"] == "https://example.com/repo"));
    assert!(arr.iter().any(|r| r["is_official"] == true));

    // PATCH (disable).
    let r = client
        .patch(format!("{base}/api/marketplace/sources/{source_id}"))
        .header("Authorization", &auth)
        .json(&serde_json::json!({ "enabled": false }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);

    // DELETE.
    let r = client
        .delete(format!("{base}/api/marketplace/sources/{source_id}"))
        .header("Authorization", &auth)
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);

    // ── /api/plugins/install requires repo_url ──
    let r = client
        .post(format!("{base}/api/plugins/install"))
        .header("Authorization", &auth)
        .json(&serde_json::json!({ "repo_url": "" }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    let v: serde_json::Value = r.json().await.unwrap();
    assert_eq!(v["ok"], false);
    assert!(v["error"].as_str().unwrap().contains("repo_url is required"));

    // ── /api/workflows lists 0 (no plugins installed in test home) ──
    let r = client
        .get(format!("{base}/api/workflows"))
        .header("Authorization", &auth)
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    assert!(r.json::<serde_json::Value>().await.unwrap().as_array().unwrap().is_empty());

    // ── /api/mcp/auth/callback rejects missing params ──
    let r = client
        .get(format!("{base}/api/mcp/auth/callback"))
        .header("Authorization", &auth)
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    let v: serde_json::Value = r.json().await.unwrap();
    assert_eq!(v["ok"], false);
    assert!(v["error"].as_str().unwrap().contains("code + state are required"));

    // ── healthz still works (anchor sanity) ──
    let r = client.get(format!("{base}/healthz")).send().await.unwrap();
    assert_eq!(r.status(), 200);
}
