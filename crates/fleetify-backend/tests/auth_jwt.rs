//! No-network auth test: generate an RSA keypair, serve a mock JWKS,
//! mint JWTs with jsonwebtoken, and assert `validate_token` parity with
//! `app/auth.py` (valid → Principal; wrong aud → BadAudience; expired).

use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine;
use fleetify_backend::auth::{validate_token, AuthConfig, AuthError, JwksCache};
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

async fn start_jwks(doc: serde_json::Value) -> String {
    let app = axum::Router::new().route(
        "/jwks",
        axum::routing::get(move || {
            let d = doc.clone();
            async move { axum::Json(d) }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    format!("http://{addr}/jwks")
}

struct Fixture {
    cfg: AuthConfig,
    jwks: JwksCache,
    enc: EncodingKey,
}

async fn fixture() -> Fixture {
    let mut rng = rand::thread_rng();
    let priv_key = RsaPrivateKey::new(&mut rng, 2048).expect("rsa keygen");
    let pem = priv_key
        .to_pkcs8_pem(rsa::pkcs8::LineEnding::LF)
        .expect("pkcs8 pem");
    let pub_key = RsaPublicKey::from(&priv_key);

    let b64 = base64::engine::general_purpose::URL_SAFE_NO_PAD;
    let n = b64.encode(pub_key.n().to_bytes_be());
    let e = b64.encode(pub_key.e().to_bytes_be());

    let doc = serde_json::json!({
        "keys": [{ "kty": "RSA", "kid": "test", "alg": "RS256", "use": "sig", "n": n, "e": e }]
    });
    let jwks_url = start_jwks(doc).await;

    let cfg = AuthConfig {
        issuer_origin: "http://localhost:3001".into(),
        auth_base: "http://localhost:3001/api/auth".into(),
        jwks_url: jwks_url.clone(),
        expected_audience: "http://127.0.0.1:8765".into(),
    };
    Fixture {
        jwks: JwksCache::new(jwks_url),
        enc: EncodingKey::from_rsa_pem(pem.as_bytes()).expect("enc key"),
        cfg,
    }
}

fn mint(enc: &EncodingKey, claims: serde_json::Value) -> String {
    let mut header = Header::new(jsonwebtoken::Algorithm::RS256);
    header.kid = Some("test".into());
    encode(&header, &claims, enc).expect("encode jwt")
}

#[tokio::test]
async fn valid_token_yields_principal() {
    let f = fixture().await;
    let token = mint(
        &f.enc,
        serde_json::json!({
            "sub": "user-1", "email": "a@b.com", "name": "Alice",
            "iss": f.cfg.auth_base, "aud": f.cfg.expected_audience,
            "iat": now(), "exp": now() + 3600
        }),
    );
    let p = validate_token(&token, &f.cfg, &f.jwks)
        .await
        .expect("valid");
    assert_eq!(p.sub, "user-1");
    assert_eq!(p.email.as_deref(), Some("a@b.com"));
    assert_eq!(p.name.as_deref(), Some("Alice"));
}

#[tokio::test]
async fn wrong_audience_is_rejected() {
    let f = fixture().await;
    let token = mint(
        &f.enc,
        serde_json::json!({
            "sub": "u", "iss": f.cfg.auth_base, "aud": "https://evil.example",
            "iat": now(), "exp": now() + 3600
        }),
    );
    match validate_token(&token, &f.cfg, &f.jwks).await {
        Err(AuthError::BadAudience) => {}
        other => panic!("expected BadAudience, got {other:?}"),
    }
}

#[tokio::test]
async fn expired_token_is_rejected() {
    let f = fixture().await;
    let token = mint(
        &f.enc,
        serde_json::json!({
            "sub": "u", "iss": f.cfg.auth_base, "aud": f.cfg.expected_audience,
            "iat": now() - 7200, "exp": now() - 3600
        }),
    );
    match validate_token(&token, &f.cfg, &f.jwks).await {
        Err(AuthError::Expired) => {}
        other => panic!("expected Expired, got {other:?}"),
    }
}
