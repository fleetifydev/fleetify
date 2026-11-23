//! JWKS-based JWT auth — faithful port of `backend/app/auth.py` +
//! `backend/app/services/jwks_cache.py`. Validates Bearer tokens issued by
//! the Fleetify identity provider's better-auth OIDC plugin
//! (EdDSA / RS256 / ES256), JIT-resolves users, and caches WS token→user_id.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock, RwLock};
use std::time::{Duration, Instant};

use axum::extract::{FromRef, FromRequestParts};
use axum::http::request::Parts;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use fleetify_core::endpoints;
use jsonwebtoken::{decode, decode_header, Algorithm, DecodingKey, Validation};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;

use crate::models::user::User;

// ── No-auth dev mode ────────────────────────────────────────────────
// `FLEETIFY_NOAUTH=1` short-circuits every protected route to a stub
// "John Doe" user so the desktop UI can run without an identity provider.
//
// Release builds IGNORE the env var unconditionally — `cfg!(debug_assertions)`
// is the same gate `shell::auth::is_prod()` uses to pin prod URLs, so the
// shipped binary cannot be tricked into honouring `FLEETIFY_NOAUTH=1` from
// the user's environment. Anyone building from source can remove the gate,
// but that's outside the threat model.
//
// Read once via OnceLock; the env var is a process-wide constant set by
// `npm run dev:noauth`.
pub fn is_no_auth() -> bool {
    static FLAG: OnceLock<bool> = OnceLock::new();
    *FLAG.get_or_init(|| {
        if !cfg!(debug_assertions) {
            return false;
        }
        std::env::var("FLEETIFY_NOAUTH").as_deref() == Ok("1")
    })
}

fn noauth_principal() -> Principal {
    Principal {
        sub: "noauth-john-doe".into(),
        email: Some("john.doe@fleetify.local".into()),
        name: Some("John Doe".into()),
        raw_claims: serde_json::json!({}),
    }
}

// ── Config (env, parity with app/auth.py) ───────────────────────────
#[derive(Debug, Clone)]
pub struct AuthConfig {
    /// e.g. `http://localhost:3001` (dev) / `https://fleetify.dev` (prod).
    pub issuer_origin: String,
    /// `${origin}/api/auth` — better-auth stamps `iss` WITH this base path.
    pub auth_base: String,
    pub jwks_url: String,
    pub expected_audience: String,
}

impl AuthConfig {
    /// Derives the better-auth base (`{origin}/api/auth`, also the expected
    /// `iss`) and its JWKS URL from the identity-provider origin.
    pub fn new(issuer_origin: String, expected_audience: String) -> Self {
        let auth_base = format!("{issuer_origin}/api/auth");
        let jwks_url = format!("{auth_base}/jwks");
        Self {
            issuer_origin,
            auth_base,
            jwks_url,
            expected_audience,
        }
    }

    /// Production `fleetify.dev` values in release builds, whatever the
    /// environment says; debug builds read `FLEETIFY_ISSUER` and
    /// `FLEETIFY_RESOURCE` / `FLEETIFY_AUDIENCE` (see
    /// [`fleetify_core::endpoints`]). The shell's OAuth client resolves the
    /// same values, so the tokens it obtains are the ones validated here.
    pub fn from_env() -> Self {
        Self::new(endpoints::issuer_origin(), endpoints::api_resource())
    }
}

// ── Principal ───────────────────────────────────────────────────────
#[derive(Debug, Clone)]
pub struct Principal {
    pub sub: String,
    pub email: Option<String>,
    pub name: Option<String>,
    pub raw_claims: serde_json::Value,
}

// ── Errors → HTTP status (parity with the Python HTTPException codes) ─
#[derive(Debug)]
pub enum AuthError {
    NotAuthenticated,
    BadHeader(String),
    MissingKid,
    JwksUnreachable,
    UnknownKey,
    Expired,
    BadAudience,
    BadIssuer,
    Invalid(String),
}

impl std::fmt::Display for AuthError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AuthError::NotAuthenticated => write!(f, "Not authenticated"),
            AuthError::BadHeader(e) => write!(f, "Bad token header: {e}"),
            AuthError::MissingKid => write!(f, "Token missing kid"),
            AuthError::JwksUnreachable => write!(f, "Identity provider unreachable"),
            AuthError::UnknownKey => write!(f, "Unknown signing key"),
            AuthError::Expired => write!(f, "Token expired"),
            AuthError::BadAudience => write!(f, "Wrong audience"),
            AuthError::BadIssuer => write!(f, "Wrong issuer"),
            AuthError::Invalid(e) => write!(f, "Invalid token: {e}"),
        }
    }
}
impl std::error::Error for AuthError {}

impl IntoResponse for AuthError {
    fn into_response(self) -> Response {
        let code = match self {
            AuthError::JwksUnreachable => StatusCode::SERVICE_UNAVAILABLE, // 503
            _ => StatusCode::UNAUTHORIZED,                                 // 401
        };
        (code, self.to_string()).into_response()
    }
}

// ── JWKS cache (24h soft TTL + single-flight force-refresh) ──────────
#[derive(Deserialize)]
struct Jwk {
    kty: String,
    kid: Option<String>,
    #[serde(default)]
    n: Option<String>,
    #[serde(default)]
    e: Option<String>,
    #[serde(default)]
    x: Option<String>,
    #[serde(default)]
    y: Option<String>,
}

#[derive(Deserialize)]
struct JwksDoc {
    #[serde(default)]
    keys: Vec<Jwk>,
}

const JWKS_TTL: Duration = Duration::from_secs(24 * 60 * 60);

pub struct JwksCache {
    url: String,
    keys: RwLock<HashMap<String, Arc<DecodingKey>>>,
    fetched_at: RwLock<Option<Instant>>,
    refresh_lock: tokio::sync::Mutex<()>,
}

impl JwksCache {
    pub fn new(url: impl Into<String>) -> Self {
        Self {
            url: url.into(),
            keys: RwLock::new(HashMap::new()),
            fetched_at: RwLock::new(None),
            refresh_lock: tokio::sync::Mutex::new(()),
        }
    }

    fn is_stale(&self) -> bool {
        match *self.fetched_at.read().unwrap_or_else(|e| e.into_inner()) {
            None => true,
            Some(t) => t.elapsed() > JWKS_TTL,
        }
    }

    pub async fn get_signing_key(&self, kid: &str) -> Result<Option<Arc<DecodingKey>>, AuthError> {
        if self.is_stale() {
            self.refresh(false, None).await?;
        }
        if let Some(k) = self.keys.read().unwrap_or_else(|e| e.into_inner()).get(kid) {
            return Ok(Some(k.clone()));
        }
        // Unknown kid → one force-refresh (single-flight; siblings short-circuit).
        self.refresh(true, Some(kid)).await?;
        Ok(self
            .keys
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .get(kid)
            .cloned())
    }

    async fn refresh(&self, force: bool, target_kid: Option<&str>) -> Result<(), AuthError> {
        let _guard = self.refresh_lock.lock().await;
        if !force && !self.is_stale() {
            return Ok(());
        }
        if force {
            if let Some(k) = target_kid {
                if self
                    .keys
                    .read()
                    .unwrap_or_else(|e| e.into_inner())
                    .contains_key(k)
                {
                    return Ok(()); // a sibling refreshed while we waited
                }
            }
        }
        let resp = reqwest::Client::new()
            .get(&self.url)
            .timeout(Duration::from_secs(10))
            .send()
            .await
            .map_err(|_| AuthError::JwksUnreachable)?;
        if !resp.status().is_success() {
            return Err(AuthError::JwksUnreachable);
        }
        let doc: JwksDoc = resp.json().await.map_err(|_| AuthError::JwksUnreachable)?;

        let mut new_keys: HashMap<String, Arc<DecodingKey>> = HashMap::new();
        for jwk in doc.keys {
            let Some(kid) = jwk.kid.clone() else { continue };
            let key = match jwk.kty.as_str() {
                "RSA" => match (jwk.n.as_deref(), jwk.e.as_deref()) {
                    (Some(n), Some(e)) => DecodingKey::from_rsa_components(n, e).ok(),
                    _ => None,
                },
                "EC" => match (jwk.x.as_deref(), jwk.y.as_deref()) {
                    (Some(x), Some(y)) => DecodingKey::from_ec_components(x, y).ok(),
                    _ => None,
                },
                // OKP = Ed25519 (better-auth's default). Dropping these
                // historically made every Bearer fail kid lookup. An Ed25519
                // public key is 32 bytes: leave out a JWK whose x is any other
                // size (jsonwebtoken 10 and later panic when they verify with
                // a shorter one).
                "OKP" => jwk
                    .x
                    .as_deref()
                    .filter(|x| URL_SAFE_NO_PAD.decode(x).is_ok_and(|b| b.len() == 32))
                    .and_then(|x| DecodingKey::from_ed_components(x).ok()),
                _ => None,
            };
            if let Some(k) = key {
                new_keys.insert(kid, Arc::new(k));
            }
        }
        *self.keys.write().unwrap_or_else(|e| e.into_inner()) = new_keys;
        *self.fetched_at.write().unwrap_or_else(|e| e.into_inner()) = Some(Instant::now());
        Ok(())
    }
}

type JwksCacheSingleton = Mutex<Option<(String, Arc<JwksCache>)>>;

/// Singleton keyed by URL (parity with `get_default_jwks_cache`).
pub fn default_jwks_cache(jwks_url: &str) -> Arc<JwksCache> {
    static SINGLETON: OnceLock<JwksCacheSingleton> = OnceLock::new();
    let cell = SINGLETON.get_or_init(|| Mutex::new(None));
    let mut guard = cell.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((url, cache)) = guard.as_ref() {
        if url == jwks_url {
            return cache.clone();
        }
    }
    let cache = Arc::new(JwksCache::new(jwks_url));
    *guard = Some((jwks_url.to_string(), cache.clone()));
    cache
}

// ── Token validation ────────────────────────────────────────────────
pub async fn validate_token(
    token: &str,
    cfg: &AuthConfig,
    jwks: &JwksCache,
) -> Result<Principal, AuthError> {
    let header = decode_header(token).map_err(|e| AuthError::BadHeader(e.to_string()))?;
    let kid = header.kid.ok_or(AuthError::MissingKid)?;

    let key = jwks
        .get_signing_key(&kid)
        .await?
        .ok_or(AuthError::UnknownKey)?;

    // Allowlist (parity with Python JWT_ALGORITHMS = EdDSA/RS256/ES256),
    // then validate with the token's OWN alg. jsonwebtoken rejects a
    // multi-family `algorithms` vec against a single-family key as an
    // algorithm-confusion mitigation, so we pass exactly the header alg —
    // which is consistent with the kid-selected JWKS key.
    let alg = header.alg;
    if !matches!(alg, Algorithm::EdDSA | Algorithm::RS256 | Algorithm::ES256) {
        return Err(AuthError::Invalid(format!("Disallowed alg: {alg:?}")));
    }
    let mut v = Validation::new(alg);
    v.leeway = 60;
    v.set_audience(&[cfg.expected_audience.as_str()]);
    v.set_issuer(&[cfg.auth_base.as_str()]);
    // jsonwebtoken treats a claim of the wrong JSON type as absent, and
    // rejects an absent claim only when it is required: requiring `aud` and
    // `iss` as well as `exp` keeps a malformed one from skipping its check.
    v.set_required_spec_claims(&["exp", "aud", "iss"]);

    let data = decode::<serde_json::Value>(token, &key, &v).map_err(|e| {
        use jsonwebtoken::errors::ErrorKind::*;
        match e.kind() {
            ExpiredSignature => AuthError::Expired,
            InvalidAudience => AuthError::BadAudience,
            InvalidIssuer => AuthError::BadIssuer,
            _ => AuthError::Invalid(e.to_string()),
        }
    })?;

    let claims = data.claims;
    let sub = claims
        .get("sub")
        .and_then(|v| v.as_str())
        .ok_or_else(|| AuthError::Invalid("missing sub".into()))?
        .to_string();
    let email = claims
        .get("email")
        .and_then(|v| v.as_str())
        .map(String::from);
    let name = claims
        .get("name")
        .and_then(|v| v.as_str())
        .map(String::from);

    Ok(Principal {
        sub,
        email,
        name,
        raw_claims: claims,
    })
}

// ── User JIT resolution (parity with _resolve_user) ─────────────────
pub async fn resolve_user(principal: &Principal, pool: &SqlitePool) -> anyhow::Result<User> {
    if let Some(mut user) = sqlx::query_as::<_, User>("SELECT * FROM users WHERE external_sub = ?")
        .bind(&principal.sub)
        .fetch_optional(pool)
        .await?
    {
        let mut changed = false;
        if let Some(e) = &principal.email {
            if user.email.as_deref() != Some(e.as_str()) {
                user.email = Some(e.clone());
                changed = true;
            }
        }
        if let Some(n) = &principal.name {
            if user.name.as_deref() != Some(n.as_str()) {
                user.name = Some(n.clone());
                changed = true;
            }
        }
        if changed {
            sqlx::query("UPDATE users SET email = ?, name = ?, updated_at = ? WHERE id = ?")
                .bind(&user.email)
                .bind(&user.name)
                .bind(now_rfc3339())
                .bind(&user.id)
                .execute(pool)
                .await?;
        }
        return Ok(user);
    }

    if let Some(email) = &principal.email {
        if let Some(mut legacy) = sqlx::query_as::<_, User>(
            "SELECT * FROM users WHERE email = ? AND external_sub IS NULL",
        )
        .bind(email)
        .fetch_optional(pool)
        .await?
        {
            legacy.external_sub = Some(principal.sub.clone());
            legacy.name = principal.name.clone().or(legacy.name);
            sqlx::query("UPDATE users SET external_sub = ?, name = ?, updated_at = ? WHERE id = ?")
                .bind(&legacy.external_sub)
                .bind(&legacy.name)
                .bind(now_rfc3339())
                .bind(&legacy.id)
                .execute(pool)
                .await?;
            return Ok(legacy);
        }
    }

    let id = uuid::Uuid::new_v4().to_string();
    let created_at = now_rfc3339();
    let insert = sqlx::query(
        "INSERT INTO users (id, name, email, external_sub, created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?, NULL)",
    )
    .bind(&id)
    .bind(&principal.name)
    .bind(&principal.email)
    .bind(&principal.sub)
    .bind(&created_at)
    .execute(pool)
    .await;

    match insert {
        Ok(_) => Ok(
            sqlx::query_as::<_, User>("SELECT * FROM users WHERE id = ?")
                .bind(&id)
                .fetch_one(pool)
                .await?,
        ),
        Err(sqlx::Error::Database(db)) if db.is_unique_violation() => {
            // Race: another request created it first.
            Ok(
                sqlx::query_as::<_, User>("SELECT * FROM users WHERE external_sub = ?")
                    .bind(&principal.sub)
                    .fetch_one(pool)
                    .await?,
            )
        }
        Err(e) => Err(e.into()),
    }
}

pub async fn resolve_user_from_token(
    token: &str,
    cfg: &AuthConfig,
    jwks: &JwksCache,
    pool: &SqlitePool,
) -> anyhow::Result<User> {
    let principal = validate_token(token, cfg, jwks)
        .await
        .map_err(|e| anyhow::anyhow!(e.to_string()))?;
    resolve_user(&principal, pool).await
}

fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339()
}

// ── WebSocket-only token → user_id cache (sha256[:32], 30s, 256 LRU) ─
const TOKEN_USER_TTL: Duration = Duration::from_secs(30);
const TOKEN_USER_MAX: usize = 256;

fn token_cache_key(token: &str) -> String {
    let digest = Sha256::digest(token.as_bytes());
    hex::encode(digest)[..32].to_string()
}

// tiny hex (avoid an extra dep)
mod hex {
    pub fn encode(bytes: impl AsRef<[u8]>) -> String {
        let mut s = String::with_capacity(bytes.as_ref().len() * 2);
        for b in bytes.as_ref() {
            s.push_str(&format!("{b:02x}"));
        }
        s
    }
}

fn token_cache() -> &'static Mutex<HashMap<String, (Instant, String)>> {
    static CACHE: OnceLock<Mutex<HashMap<String, (Instant, String)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

pub async fn resolve_user_id_from_token_cached(
    token: &str,
    cfg: &AuthConfig,
    jwks: &JwksCache,
    pool: &SqlitePool,
) -> anyhow::Result<String> {
    if is_no_auth() {
        let user = resolve_user(&noauth_principal(), pool).await?;
        return Ok(user.id);
    }
    let key = token_cache_key(token);
    {
        let mut c = token_cache().lock().unwrap_or_else(|e| e.into_inner());
        if let Some((exp, uid)) = c.get(&key) {
            if *exp > Instant::now() {
                return Ok(uid.clone());
            }
            c.remove(&key);
        }
    }
    let user = resolve_user_from_token(token, cfg, jwks, pool).await?;
    let mut c = token_cache().lock().unwrap_or_else(|e| e.into_inner());
    c.insert(key, (Instant::now() + TOKEN_USER_TTL, user.id.clone()));
    if c.len() > TOKEN_USER_MAX {
        // Evict the soonest-to-expire entry (TTL/LRU approximation).
        if let Some(victim) = c
            .iter()
            .min_by_key(|(_, (exp, _))| *exp)
            .map(|(k, _)| k.clone())
        {
            c.remove(&victim);
        }
    }
    Ok(user.id)
}

// ── axum extractor (state-driven; wired into the router in Phase 1c) ─
#[derive(Clone)]
pub struct AuthState {
    pub pool: SqlitePool,
    pub cfg: Arc<AuthConfig>,
    pub jwks: Arc<JwksCache>,
}

pub struct AuthUser(pub User);

impl<S> FromRequestParts<S> for AuthUser
where
    S: Send + Sync,
    AuthState: FromRef<S>,
{
    type Rejection = AuthError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        let st = AuthState::from_ref(state);
        if is_no_auth() {
            let user = resolve_user(&noauth_principal(), &st.pool)
                .await
                .map_err(|e| AuthError::Invalid(e.to_string()))?;
            return Ok(AuthUser(user));
        }
        let token = parts
            .headers
            .get(axum::http::header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .ok_or(AuthError::NotAuthenticated)?
            .to_string();
        let principal = validate_token(&token, &st.cfg, &st.jwks).await?;
        let user = resolve_user(&principal, &st.pool)
            .await
            .map_err(|e| AuthError::Invalid(e.to_string()))?;
        Ok(AuthUser(user))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auth_config_new_derives_prod_urls() {
        let c = AuthConfig::new(
            "https://fleetify.dev".into(),
            "https://fleetify.dev/api".into(),
        );
        assert_eq!(c.auth_base, "https://fleetify.dev/api/auth");
        assert_eq!(c.jwks_url, "https://fleetify.dev/api/auth/jwks");
        assert_eq!(c.expected_audience, "https://fleetify.dev/api");
    }
}
