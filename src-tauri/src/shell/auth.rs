//! OAuth2 Authorization-Code + PKCE(S256) against the Fleetify IdP —
//! faithful port of `frontend/electron/fleetify-auth.cjs`. Refresh token
//! lives in the OS keychain (service "Fleetify"); access tokens are cached
//! in-process. Dev/prod URL gating mirrors `app.isPackaged` via the build
//! profile (release ⇒ prod pinned; debug ⇒ env-overridable).

use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine;
use rand::RngCore;
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};

const CLIENT_ID: &str = "fleetify-desktop";
const DEFAULT_SCOPES: &str = "openid profile email offline_access";
const KEYCHAIN_SVC: &str = "Fleetify";
const KEYCHAIN_KEY: &str = "refresh_token";
const TOKEN_LEEWAY_S: i64 = 60;

fn is_prod() -> bool {
    !cfg!(debug_assertions)
}
fn env_or(k: &str, d: &str) -> String {
    std::env::var(k).unwrap_or_else(|_| d.to_string())
}

/// `FLEETIFY_NOAUTH=1` swaps every IPC-exposed auth call for a stub
/// "John Doe" identity. Read once at process start.
///
/// Release builds IGNORE the env var unconditionally — same `cfg!(debug_assertions)`
/// gate `is_prod()` uses to pin prod URLs. A user running the shipped
/// installer cannot set `FLEETIFY_NOAUTH=1` to bypass auth.
pub fn is_no_auth() -> bool {
    static FLAG: OnceLock<bool> = OnceLock::new();
    *FLAG.get_or_init(|| {
        if !cfg!(debug_assertions) {
            return false;
        }
        std::env::var("FLEETIFY_NOAUTH").as_deref() == Ok("1")
    })
}

const NOAUTH_SUB: &str = "noauth-john-doe";

fn noauth_user_value() -> serde_json::Value {
    serde_json::json!({
        "sub": NOAUTH_SUB,
        "name": "John Doe",
        "email": "john.doe@fleetify.local",
    })
}

fn noauth_tokens() -> Tokens {
    Tokens {
        access_token: "noauth".into(),
        refresh_token: "noauth".into(),
        id_token: None,
        expires_at: i64::MAX,
        scope: DEFAULT_SCOPES.into(),
    }
}
/// Identity-provider origin; production in release builds. Shared with the
/// embedded backend's token validation via `fleetify_core::endpoints`.
pub fn issuer() -> String {
    fleetify_core::endpoints::issuer_origin()
}
pub fn auth_base() -> String {
    format!("{}/api/auth", issuer())
}
fn dashboard_url() -> String {
    if is_prod() {
        "https://app.fleetify.dev".into()
    } else {
        env_or("FLEETIFY_DASHBOARD_URL", "http://localhost:5174")
    }
}
/// RFC 8707 resource indicator: the audience the embedded backend expects
/// (`fleetify_core::endpoints`); production in release builds.
fn resource() -> String {
    fleetify_core::endpoints::api_resource()
}

#[derive(Clone, Serialize)]
pub struct Tokens {
    pub access_token: String,
    pub refresh_token: String,
    pub id_token: Option<String>,
    pub expires_at: i64,
    pub scope: String,
}

#[derive(Debug)]
pub struct AuthError {
    pub message: String,
    pub kind: String,
}
impl AuthError {
    fn new(m: impl Into<String>, k: impl Into<String>) -> Self {
        Self {
            message: m.into(),
            kind: k.into(),
        }
    }
}
impl std::fmt::Display for AuthError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}
impl std::error::Error for AuthError {}

fn cached() -> &'static Mutex<Option<Tokens>> {
    static C: OnceLock<Mutex<Option<Tokens>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(None))
}
fn cached_uid() -> &'static Mutex<Option<String>> {
    static C: OnceLock<Mutex<Option<String>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(None))
}
fn refresh_lock() -> &'static tokio::sync::Mutex<()> {
    static L: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    L.get_or_init(|| tokio::sync::Mutex::new(()))
}
fn app_handle() -> &'static OnceLock<AppHandle> {
    static A: OnceLock<AppHandle> = OnceLock::new();
    &A
}
pub fn set_app_handle(h: AppHandle) {
    let _ = app_handle().set(h);
}
fn emit_event(payload: serde_json::Value) {
    if let Some(a) = app_handle().get() {
        let _ = a.emit("fleet:auth-event", payload);
    }
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}
fn b64url(b: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(b)
}
fn new_pkce() -> (String, String) {
    let mut v = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut v);
    let verifier = b64url(&v);
    let challenge = b64url(&Sha256::digest(verifier.as_bytes()));
    (verifier, challenge)
}

fn keyring_entry() -> keyring::Result<keyring::Entry> {
    keyring::Entry::new(KEYCHAIN_SVC, KEYCHAIN_KEY)
}
fn keyring_get() -> Option<String> {
    keyring_entry().ok().and_then(|e| e.get_password().ok())
}
fn keyring_set(v: &str) -> keyring::Result<()> {
    keyring_entry()?.set_password(v)
}

/// Auth event for a refresh token that could not be saved; the renderer
/// shows a warning banner on it.
fn keychain_failure_event() -> serde_json::Value {
    serde_json::json!({"kind": "keychain-unavailable"})
}

/// Saves the refresh token so the next launch starts signed in. When the
/// keychain refuses it (Linux without an unlocked Secret Service, a
/// dismissed unlock prompt), sign-in still succeeds for this session (the
/// access token is cached in-process), but the next launch would silently
/// start signed out: log it and tell the renderer.
fn save_refresh_token(token: &str) {
    if let Err(e) = keyring_set(token) {
        tracing::warn!(error = %e, "could not save the refresh token to the system keychain");
        emit_event(keychain_failure_event());
    }
}
fn keyring_del() {
    if let Ok(e) = keyring_entry() {
        let _ = e.delete_credential();
    }
}

async fn decode_token_response(r: reqwest::Response) -> Result<Tokens, AuthError> {
    let status = r.status();
    if !status.is_success() {
        let body = r.text().await.unwrap_or_default();
        if let Ok(j) = serde_json::from_str::<serde_json::Value>(&body) {
            if let Some(err) = j.get("error").and_then(|v| v.as_str()) {
                let d = j
                    .get("error_description")
                    .and_then(|v| v.as_str())
                    .unwrap_or("(no description)");
                return Err(AuthError::new(format!("{err}: {d}"), "auth"));
            }
        }
        return Err(AuthError::new(
            format!("Token endpoint returned {}", status.as_u16()),
            "auth",
        ));
    }
    let j: serde_json::Value = r
        .json()
        .await
        .map_err(|e| AuthError::new(e.to_string(), "auth"))?;
    Ok(Tokens {
        access_token: j
            .get("access_token")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
        refresh_token: j
            .get("refresh_token")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
        id_token: j.get("id_token").and_then(|v| v.as_str()).map(String::from),
        expires_at: now() + j.get("expires_in").and_then(|v| v.as_i64()).unwrap_or(3600),
        scope: j
            .get("scope")
            .and_then(|v| v.as_str())
            .unwrap_or(DEFAULT_SCOPES)
            .to_string(),
    })
}

struct Cb {
    redirect_uri: String,
    state: String,
    rx: std::sync::mpsc::Receiver<Result<String, AuthError>>,
}

fn redirect(u: &url::Url) -> tiny_http::Response<std::io::Empty> {
    tiny_http::Response::empty(302).with_header(
        tiny_http::Header::from_bytes(&b"Location"[..], u.as_str().as_bytes()).unwrap(),
    )
}

/// RFC 8252 loopback: bind 127.0.0.1:0, serve one `/callback`, redirect the
/// browser to the dashboard success/error page, hand the code back.
fn capture_code() -> Result<Cb, AuthError> {
    let server = tiny_http::Server::http("127.0.0.1:0")
        .map_err(|e| AuthError::new(e.to_string(), "loopback"))?;
    let port = server
        .server_addr()
        .to_ip()
        .ok_or_else(|| AuthError::new("loopback has no ip", "loopback"))?
        .port();
    let mut st = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut st);
    let state = b64url(&st);
    let redirect_uri = format!("http://127.0.0.1:{port}/callback");
    let (tx, rx) = std::sync::mpsc::channel();
    let state_c = state.clone();
    let dash = dashboard_url();

    std::thread::spawn(move || loop {
        let req = match server.recv() {
            Ok(r) => r,
            Err(_) => break,
        };
        let raw = req.url().to_string();
        let parsed = url::Url::parse(&format!("http://127.0.0.1{raw}")).ok();
        let path = parsed
            .as_ref()
            .map(|u| u.path().to_string())
            .unwrap_or_default();
        if path != "/callback" {
            let _ = req.respond(tiny_http::Response::empty(404));
            continue;
        }
        let q: std::collections::HashMap<String, String> = parsed
            .as_ref()
            .map(|u| u.query_pairs().into_owned().collect())
            .unwrap_or_default();
        let code = q.get("code").cloned();
        let stt = q.get("state").cloned();
        let err = q.get("error").cloned();
        let mut success =
            url::Url::parse(&dash).unwrap_or_else(|_| url::Url::parse("http://localhost").unwrap());
        if let Some(e) = &err {
            success.set_path("/oauth/error");
            success.query_pairs_mut().append_pair("error", e);
            let _ = req.respond(redirect(&success));
            let _ = tx.send(Err(AuthError::new(
                format!("Authorize failed: {e}"),
                "auth",
            )));
            break;
        }
        if code.is_none() || stt.as_deref() != Some(state_c.as_str()) {
            success.set_path("/oauth/error");
            success
                .query_pairs_mut()
                .append_pair("error", "invalid_callback");
            let _ = req.respond(redirect(&success));
            let _ = tx.send(Err(AuthError::new("Bad authorize callback.", "auth")));
            break;
        }
        success.set_path("/oauth/success");
        let _ = req.respond(redirect(&success));
        let _ = tx.send(Ok(code.unwrap()));
        break;
    });

    Ok(Cb {
        redirect_uri,
        state,
        rx,
    })
}

/// The identity provider's authorize page that sign-in opens in the
/// browser: `base` is [`auth_base`], with the PKCE `challenge`, the loopback
/// `redirect_uri` and `state` from [`capture_code`], and the API `resource`.
fn authorize_url(
    base: &str,
    redirect_uri: &str,
    state: &str,
    challenge: &str,
    resource: &str,
) -> Result<url::Url, AuthError> {
    let mut u = url::Url::parse(&format!("{base}/oauth2/authorize"))
        .map_err(|e| AuthError::new(e.to_string(), "auth"))?;
    u.query_pairs_mut()
        .append_pair("client_id", CLIENT_ID)
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("response_type", "code")
        .append_pair("scope", DEFAULT_SCOPES)
        .append_pair("state", state)
        .append_pair("code_challenge", challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("resource", resource);
    Ok(u)
}

pub async fn sign_in() -> Result<Tokens, AuthError> {
    if is_no_auth() {
        return Ok(noauth_tokens());
    }
    let (verifier, challenge) = new_pkce();
    let cb = capture_code()?;

    let u = authorize_url(
        &auth_base(),
        &cb.redirect_uri,
        &cb.state,
        &challenge,
        &resource(),
    )?;
    fleetify_backend::open_external::open_url(u.as_str())
        .map_err(|e| AuthError::new(format!("browser-failed: {e}"), "browser"))?;

    let rx = cb.rx;
    let joined = tokio::task::spawn_blocking(move || rx.recv_timeout(Duration::from_secs(300)))
        .await
        .map_err(|e| AuthError::new(e.to_string(), "auth"))?;
    let code = joined.map_err(|_| AuthError::new("Sign-in timed out.", "auth"))??;

    let client = reqwest::Client::new();
    let res = resource();
    let r = client
        .post(format!("{}/oauth2/token", auth_base()))
        .form(&[
            ("grant_type", "authorization_code"),
            ("code", code.as_str()),
            ("code_verifier", verifier.as_str()),
            ("redirect_uri", cb.redirect_uri.as_str()),
            ("client_id", CLIENT_ID),
            ("resource", res.as_str()),
        ])
        .send()
        .await
        .map_err(|e| AuthError::new(e.to_string(), "auth"))?;
    let tokens = decode_token_response(r).await?;
    *cached().lock().unwrap() = Some(tokens.clone());
    save_refresh_token(&tokens.refresh_token);
    Ok(tokens)
}

pub async fn refresh_if_needed(force: bool) -> Result<Tokens, AuthError> {
    if is_no_auth() {
        return Ok(noauth_tokens());
    }
    if !force {
        if let Some(t) = cached().lock().unwrap().clone() {
            if now() + TOKEN_LEEWAY_S < t.expires_at {
                return Ok(t);
            }
        }
    }
    let _g = refresh_lock().lock().await;
    if !force {
        if let Some(t) = cached().lock().unwrap().clone() {
            if now() + TOKEN_LEEWAY_S < t.expires_at {
                return Ok(t);
            }
        }
    }
    let refresh_token = cached()
        .lock()
        .unwrap()
        .as_ref()
        .map(|t| t.refresh_token.clone())
        .or_else(keyring_get)
        .ok_or_else(|| AuthError::new("No refresh token — call signIn() first.", "auth"))?;

    let client = reqwest::Client::new();
    let res = resource();
    let r = client
        .post(format!("{}/oauth2/token", auth_base()))
        .form(&[
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token.as_str()),
            ("client_id", CLIENT_ID),
            ("resource", res.as_str()),
        ])
        .send()
        .await
        .map_err(|e| AuthError::new(e.to_string(), "auth"))?;
    let tokens = decode_token_response(r).await?;
    *cached().lock().unwrap() = Some(tokens.clone());
    save_refresh_token(&tokens.refresh_token);
    emit_event(serde_json::json!({"kind":"refreshed","expiresAt":tokens.expires_at}));
    Ok(tokens)
}

/// `sub` from the cached/fetched OIDC userinfo. Cached after first
/// success in `cached_uid()`; cleared on sign_out (parity with the
/// Electron `auth.getUserId()` used as the GitHub-link keychain key).
pub async fn get_user_id() -> Option<String> {
    if is_no_auth() {
        return Some(NOAUTH_SUB.to_string());
    }
    if let Some(u) = cached_uid().lock().unwrap().clone() {
        return Some(u);
    }
    let u = userinfo().await.ok()?;
    let sub = u.get("sub")?.as_str()?.to_string();
    *cached_uid().lock().unwrap() = Some(sub.clone());
    Some(sub)
}

pub async fn userinfo() -> Result<serde_json::Value, AuthError> {
    if is_no_auth() {
        return Ok(noauth_user_value());
    }
    let t = refresh_if_needed(false).await?;
    let r = reqwest::Client::new()
        .get(format!("{}/oauth2/userinfo", auth_base()))
        .bearer_auth(&t.access_token)
        .send()
        .await
        .map_err(|e| AuthError::new(e.to_string(), "auth"))?;
    if !r.status().is_success() {
        return Err(AuthError::new(
            format!("userinfo failed: {}", r.status().as_u16()),
            "auth",
        ));
    }
    r.json()
        .await
        .map_err(|e| AuthError::new(e.to_string(), "auth"))
}

pub async fn sign_out() {
    if is_no_auth() {
        // Stay signed in as John Doe; frontend logout handler short-circuits
        // on state.noAuth so the UI never reacts to this call.
        return;
    }
    let rt = cached()
        .lock()
        .unwrap()
        .as_ref()
        .map(|t| t.refresh_token.clone())
        .or_else(keyring_get);
    if let Some(rt) = rt {
        let _ = reqwest::Client::new()
            .post(format!("{}/oauth2/revoke", auth_base()))
            .form(&[
                ("token", rt.as_str()),
                ("token_type_hint", "refresh_token"),
                ("client_id", CLIENT_ID),
            ])
            .send()
            .await;
    }
    keyring_del();
    *cached().lock().unwrap() = None;
    *cached_uid().lock().unwrap() = None;
    emit_event(serde_json::json!({"kind":"signed-out","reason":"user"}));
}

pub async fn get_state() -> serde_json::Value {
    if is_no_auth() {
        return serde_json::json!({
            "signedIn": true,
            "user": noauth_user_value(),
            "noAuth": true,
        });
    }
    let has_cached = cached().lock().unwrap().is_some();
    if has_cached {
        if let Ok(u) = userinfo().await {
            return serde_json::json!({"signedIn": true, "user": u});
        }
        *cached().lock().unwrap() = None;
    }
    if keyring_get().is_none() {
        return serde_json::json!({"signedIn": false});
    }
    match refresh_if_needed(false).await {
        Ok(_) => match userinfo().await {
            Ok(u) => serde_json::json!({"signedIn": true, "user": u}),
            Err(_) => {
                keyring_del();
                emit_event(serde_json::json!({"kind":"signed-out","reason":"refresh-failed"}));
                serde_json::json!({"signedIn": false})
            }
        },
        Err(_) => {
            keyring_del();
            emit_event(serde_json::json!({"kind":"signed-out","reason":"refresh-failed"}));
            serde_json::json!({"signedIn": false})
        }
    }
}

/// `{ token, expiresAt }` | null — matches `window.fleetify.getAccessToken`.
pub async fn get_access_token(force: bool) -> Option<serde_json::Value> {
    if is_no_auth() {
        return Some(serde_json::json!({"token": "noauth", "expiresAt": i64::MAX}));
    }
    if !force {
        if let Some(t) = cached().lock().unwrap().clone() {
            return Some(serde_json::json!({"token": t.access_token, "expiresAt": t.expires_at}));
        }
    }
    match refresh_if_needed(force).await {
        Ok(t) => Some(serde_json::json!({"token": t.access_token, "expiresAt": t.expires_at})),
        Err(_) => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_sign_in_page_is_a_link_the_opener_accepts() {
        // Sign-in opens the authorize page through open_external, which
        // refuses anything but a clean web link: it must not refuse this one.
        let (_verifier, challenge) = new_pkce();
        for (base, resource) in [
            ("https://fleetify.dev/api/auth", "https://fleetify.dev/api"),
            ("http://localhost:3001/api/auth", "http://127.0.0.1:8765"),
        ] {
            let url = authorize_url(
                base,
                "http://127.0.0.1:53682/callback",
                "c3RhdGUtd2l0aC1zb21lLWJ5dGVz",
                &challenge,
                resource,
            )
            .unwrap();
            let opened = fleetify_backend::open_external::validate_external_url(url.as_str())
                .unwrap_or_else(|e| panic!("{url}: {e}"));
            assert_eq!(opened.as_str(), url.as_str());
            assert!(opened
                .as_str()
                .starts_with(&format!("{base}/oauth2/authorize?")));
        }
    }

    /// Tokens the shell requests must pass the embedded backend's checks:
    /// the backend expects `iss` = the shell's auth base and `aud` = the
    /// `resource` the shell names. Both read the same environment here.
    #[test]
    fn shell_requests_tokens_the_embedded_backend_accepts() {
        let backend = fleetify_backend::auth::AuthConfig::from_env();
        assert_eq!(auth_base(), backend.auth_base);
        assert_eq!(resource(), backend.expected_audience);
    }

    /// The renderer raises its keychain warning banner on exactly this
    /// payload (`src/lib/auth-events.ts`).
    #[test]
    fn keychain_failure_event_is_the_payload_the_renderer_handles() {
        assert_eq!(
            keychain_failure_event(),
            serde_json::json!({"kind": "keychain-unavailable"})
        );
    }
}
