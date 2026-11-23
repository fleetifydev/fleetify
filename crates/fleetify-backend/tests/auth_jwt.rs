//! No-network auth tests: generate an RSA, a P-256 and an Ed25519 key, serve
//! their public halves from a mock JWKS, mint JWTs with jsonwebtoken, and
//! check what `validate_token` accepts and rejects for each allowed algorithm
//! (RS256, ES256, EdDSA), in parity with `app/auth.py`.

use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine;
use fleetify_backend::auth::{validate_token, AuthConfig, AuthError, JwksCache, Principal};
use jsonwebtoken::{encode, Algorithm, EncodingKey, Header};
use ring::rand::SystemRandom;
use ring::signature::{EcdsaKeyPair, Ed25519KeyPair, KeyPair, ECDSA_P256_SHA256_FIXED_SIGNING};
use rsa::pkcs1::EncodeRsaPrivateKey;
use rsa::traits::PublicKeyParts;
use rsa::{RsaPrivateKey, RsaPublicKey};
use serde_json::{json, Value};

const AUTH_BASE: &str = "http://localhost:3001/api/auth";
const AUDIENCE: &str = "http://127.0.0.1:8765";

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// A signing key and the JWK that publishes its public half.
struct TestKey {
    kid: &'static str,
    alg: Algorithm,
    enc: EncodingKey,
    jwk: Value,
    /// The raw public key, the HMAC secret of an algorithm-confusion forgery.
    public: Vec<u8>,
}

/// One key per allowed algorithm, made once per test binary: RSA key
/// generation is slow in a debug build.
fn keys() -> &'static [TestKey] {
    static KEYS: OnceLock<Vec<TestKey>> = OnceLock::new();
    KEYS.get_or_init(|| {
        let rsa = RsaPrivateKey::new(&mut rand::thread_rng(), 2048).expect("rsa keygen");
        let rsa_pub = RsaPublicKey::from(&rsa);
        let n = rsa_pub.n().to_bytes_be();

        let sys = SystemRandom::new();
        let es256 = &ECDSA_P256_SHA256_FIXED_SIGNING;
        let ec = EcdsaKeyPair::generate_pkcs8(es256, &sys).expect("p-256 keygen");
        let point = EcdsaKeyPair::from_pkcs8(es256, ec.as_ref(), &sys)
            .expect("p-256 key")
            .public_key()
            .as_ref()
            .to_vec();
        // The uncompressed point: 0x04, then X and Y, 32 bytes each.
        assert_eq!((point.len(), point[0]), (65, 0x04));

        let ed = Ed25519KeyPair::generate_pkcs8(&sys).expect("ed25519 keygen");
        let ed_x = Ed25519KeyPair::from_pkcs8(ed.as_ref())
            .expect("ed25519 key")
            .public_key()
            .as_ref()
            .to_vec();
        assert_eq!(ed_x.len(), 32);

        vec![
            TestKey {
                kid: "rsa",
                alg: Algorithm::RS256,
                enc: EncodingKey::from_rsa_der(rsa.to_pkcs1_der().expect("pkcs1").as_bytes()),
                jwk: json!({
                    "kty": "RSA", "kid": "rsa", "alg": "RS256", "use": "sig",
                    "n": b64(&n), "e": b64(&rsa_pub.e().to_bytes_be())
                }),
                public: n,
            },
            TestKey {
                kid: "ec",
                alg: Algorithm::ES256,
                enc: EncodingKey::from_ec_der(ec.as_ref()),
                jwk: json!({
                    "kty": "EC", "kid": "ec", "alg": "ES256", "use": "sig", "crv": "P-256",
                    "x": b64(&point[1..33]), "y": b64(&point[33..])
                }),
                public: point,
            },
            TestKey {
                kid: "ed",
                alg: Algorithm::EdDSA,
                enc: EncodingKey::from_ed_der(ed.as_ref()),
                jwk: json!({
                    "kty": "OKP", "kid": "ed", "alg": "EdDSA", "use": "sig", "crv": "Ed25519",
                    "x": b64(&ed_x)
                }),
                public: ed_x,
            },
        ]
    })
}

fn key(kid: &str) -> &'static TestKey {
    keys().iter().find(|k| k.kid == kid).expect("test key")
}

async fn start_jwks(doc: Value) -> String {
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
}

impl Fixture {
    /// A mock JWKS with the test keys, then `extra`.
    async fn new(extra: Vec<Value>) -> Self {
        let mut jwks: Vec<Value> = keys().iter().map(|k| k.jwk.clone()).collect();
        jwks.extend(extra);
        let jwks_url = start_jwks(json!({ "keys": jwks })).await;
        Fixture {
            cfg: AuthConfig {
                issuer_origin: "http://localhost:3001".into(),
                auth_base: AUTH_BASE.into(),
                jwks_url: jwks_url.clone(),
                expected_audience: AUDIENCE.into(),
            },
            jwks: JwksCache::new(jwks_url),
        }
    }

    async fn validate(&self, token: &str) -> Result<Principal, AuthError> {
        validate_token(token, &self.cfg, &self.jwks).await
    }
}

/// Claims that `validate_token` accepts; each test changes one of them.
fn claims() -> Value {
    json!({
        "sub": "user-1", "email": "a@b.com", "name": "Alice",
        "iss": AUTH_BASE, "aud": AUDIENCE,
        "iat": now(), "exp": now() + 3600
    })
}

fn claims_with(name: &str, value: Value) -> Value {
    let mut c = claims();
    c[name] = value;
    c
}

fn claims_without(name: &str) -> Value {
    let mut c = claims();
    c.as_object_mut().unwrap().remove(name);
    c
}

/// Signs `claims` with `enc` under a header that names `alg` and `kid`.
fn sign(alg: Algorithm, kid: &str, enc: &EncodingKey, claims: &Value) -> String {
    let mut header = Header::new(alg);
    header.kid = Some(kid.into());
    encode(&header, claims, enc).expect("encode jwt")
}

fn mint(key: &TestKey, claims: &Value) -> String {
    sign(key.alg, key.kid, &key.enc, claims)
}

/// The rejection of a token whose only fault is one claim (`claims()` passes).
#[track_caller]
fn assert_invalid(res: Result<Principal, AuthError>, case: &str) {
    match res {
        Err(AuthError::Invalid(_)) => {}
        other => panic!("{case}: expected Invalid, got {other:?}"),
    }
}

#[tokio::test]
async fn valid_token_yields_principal() {
    let f = Fixture::new(Vec::new()).await;
    for key in keys() {
        let p = f
            .validate(&mint(key, &claims()))
            .await
            .unwrap_or_else(|e| panic!("{:?}: {e}", key.alg));
        assert_eq!(p.sub, "user-1");
        assert_eq!(p.email.as_deref(), Some("a@b.com"));
        assert_eq!(p.name.as_deref(), Some("Alice"));
    }
}

#[tokio::test]
async fn tampered_payload_is_rejected() {
    let f = Fixture::new(Vec::new()).await;
    let forged = claims_with("sub", json!("someone-else")).to_string();
    let forged = b64(forged.as_bytes());
    for key in keys() {
        let token = mint(key, &claims());
        let parts: Vec<&str> = token.split('.').collect();
        let tampered = format!("{}.{forged}.{}", parts[0], parts[2]);
        match f.validate(&tampered).await {
            Err(AuthError::Invalid(_)) => {}
            other => panic!("{:?}: expected Invalid, got {other:?}", key.alg),
        }
    }
}

#[tokio::test]
async fn alg_must_fit_the_key_the_kid_selects() {
    let f = Fixture::new(Vec::new()).await;
    // Each token is signed with a real key and an allowed alg, but its kid
    // names a key of another type.
    for (signer, kid) in [("rsa", "ec"), ("ec", "ed"), ("ed", "rsa")] {
        let signer = key(signer);
        let token = sign(signer.alg, kid, &signer.enc, &claims());
        match f.validate(&token).await {
            Err(AuthError::Invalid(_)) => {}
            other => panic!(
                "{:?} under kid {kid}: expected Invalid, got {other:?}",
                signer.alg
            ),
        }
    }
}

#[tokio::test]
async fn expired_token_is_rejected() {
    let f = Fixture::new(Vec::new()).await;
    let expired = claims_with("exp", json!(now() - 3600));
    for key in keys() {
        match f.validate(&mint(key, &expired)).await {
            Err(AuthError::Expired) => {}
            other => panic!("{:?}: expected Expired, got {other:?}", key.alg),
        }
    }
}

#[tokio::test]
async fn expiry_has_60_seconds_of_leeway() {
    let f = Fixture::new(Vec::new()).await;
    for key in keys() {
        let within = claims_with("exp", json!(now() - 30));
        if let Err(e) = f.validate(&mint(key, &within)).await {
            panic!(
                "{:?}: 30 s past exp is within the leeway, got {e:?}",
                key.alg
            );
        }
        let beyond = claims_with("exp", json!(now() - 90));
        match f.validate(&mint(key, &beyond)).await {
            Err(AuthError::Expired) => {}
            other => panic!(
                "{:?}: 90 s past exp, expected Expired, got {other:?}",
                key.alg
            ),
        }
    }
}

#[tokio::test]
async fn wrong_audience_is_rejected() {
    let f = Fixture::new(Vec::new()).await;
    let wrong = claims_with("aud", json!("https://evil.example"));
    for key in keys() {
        match f.validate(&mint(key, &wrong)).await {
            Err(AuthError::BadAudience) => {}
            other => panic!("{:?}: expected BadAudience, got {other:?}", key.alg),
        }
    }
}

#[tokio::test]
async fn wrong_issuer_is_rejected() {
    let f = Fixture::new(Vec::new()).await;
    let wrong = claims_with("iss", json!("https://evil.example/api/auth"));
    for key in keys() {
        match f.validate(&mint(key, &wrong)).await {
            Err(AuthError::BadIssuer) => {}
            other => panic!("{:?}: expected BadIssuer, got {other:?}", key.alg),
        }
    }
}

#[tokio::test]
async fn disallowed_alg_is_rejected() {
    let f = Fixture::new(Vec::new()).await;
    // HS256 keyed with each published public key (algorithm confusion), and
    // two RSA algorithms outside the allowlist, signed with the real key.
    let mut tokens: Vec<(&str, Algorithm, EncodingKey)> = keys()
        .iter()
        .map(|k| (k.kid, Algorithm::HS256, EncodingKey::from_secret(&k.public)))
        .collect();
    tokens.push(("rsa", Algorithm::RS512, key("rsa").enc.clone()));
    tokens.push(("rsa", Algorithm::PS256, key("rsa").enc.clone()));
    for (kid, alg, enc) in tokens {
        match f.validate(&sign(alg, kid, &enc, &claims())).await {
            Err(AuthError::Invalid(msg)) if msg.starts_with("Disallowed alg") => {}
            other => panic!("{alg:?} under kid {kid}: expected a disallowed alg, got {other:?}"),
        }
    }
}

// jsonwebtoken reads a registered claim of the wrong JSON type as absent, and
// skips that claim's check unless the claim is required (GHSA-h395-gr6q-cpjc).
// Every token below is validly signed.

#[tokio::test]
async fn exp_of_the_wrong_type_is_rejected() {
    let f = Fixture::new(Vec::new()).await;
    let later = now() + 3600;
    let values = [
        json!(later.to_string()),
        json!("999"),
        json!(true),
        json!(null),
        json!({ "exp": later }),
        json!([later]),
    ];
    for key in keys() {
        for value in &values {
            let token = mint(key, &claims_with("exp", value.clone()));
            assert_invalid(
                f.validate(&token).await,
                &format!("{:?}, exp = {value}", key.alg),
            );
        }
    }
}

#[tokio::test]
async fn aud_of_the_wrong_type_is_rejected() {
    let f = Fixture::new(Vec::new()).await;
    let values = [
        json!(42),
        json!(true),
        json!(null),
        json!({ "aud": AUDIENCE }),
        json!([AUDIENCE, 42]),
    ];
    for key in keys() {
        for value in &values {
            let token = mint(key, &claims_with("aud", value.clone()));
            assert_invalid(
                f.validate(&token).await,
                &format!("{:?}, aud = {value}", key.alg),
            );
        }
    }
}

#[tokio::test]
async fn iss_of_the_wrong_type_is_rejected() {
    let f = Fixture::new(Vec::new()).await;
    let values = [
        json!(42),
        json!(true),
        json!(null),
        json!({ "iss": AUTH_BASE }),
        json!([AUTH_BASE, 42]),
    ];
    for key in keys() {
        for value in &values {
            let token = mint(key, &claims_with("iss", value.clone()));
            assert_invalid(
                f.validate(&token).await,
                &format!("{:?}, iss = {value}", key.alg),
            );
        }
    }
}

#[tokio::test]
async fn token_without_exp_aud_or_iss_is_rejected() {
    let f = Fixture::new(Vec::new()).await;
    for key in keys() {
        for claim in ["exp", "aud", "iss"] {
            let token = mint(key, &claims_without(claim));
            assert_invalid(
                f.validate(&token).await,
                &format!("{:?} without {claim}", key.alg),
            );
        }
    }
}

#[tokio::test]
async fn ed25519_jwk_whose_x_is_not_32_bytes_is_skipped() {
    let f = Fixture::new(vec![json!({
        "kty": "OKP", "kid": "ed-short", "alg": "EdDSA", "use": "sig", "crv": "Ed25519",
        "x": b64(&[7u8; 16])
    })])
    .await;
    let token = sign(Algorithm::EdDSA, "ed-short", &key("ed").enc, &claims());
    match f.validate(&token).await {
        Err(AuthError::UnknownKey) => {}
        other => panic!("expected UnknownKey, got {other:?}"),
    }
}
