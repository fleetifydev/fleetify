//! MCP OAuth 2.0 / OIDC orchestration. Faithful subset of
//! `services/mcp_auth.py` — enough to surface "Sign in to MCP X"
//! buttons in the renderer's MCP settings page.
//!
//! Flow:
//!   1. `start(name, config)` → builds authorize_url with PKCE,
//!      stores state → (verifier, name) in memory, returns the URL.
//!   2. User opens the URL in a browser; the MCP server's authz
//!      endpoint eventually redirects back to our loopback
//!      `<callback_base>/api/mcp/auth/callback?code=…&state=…`.
//!   3. `callback(code, state)` looks up the verifier, POSTs the
//!      MCP server's token endpoint with the standard auth-code
//!      grant payload, persists the returned tokens to mcp_secrets.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use anyhow::{anyhow, Result};
use serde_json::Value;

use super::mcp_secrets::{self, McpSecret};

const STATE_TTL: Duration = Duration::from_secs(600); // 10 minutes

/// In-flight OAuth states (`state` → `(server_name, code_verifier,
/// token_url, redirect_uri, started_at)`). Cleared on success or
/// after STATE_TTL. Process-local.
fn states() -> &'static Mutex<HashMap<String, PendingState>> {
    static M: std::sync::OnceLock<Mutex<HashMap<String, PendingState>>> =
        std::sync::OnceLock::new();
    M.get_or_init(|| Mutex::new(HashMap::new()))
}

struct PendingState {
    server_name: String,
    code_verifier: String,
    token_url: String,
    client_id: String,
    redirect_uri: String,
    started_at: Instant,
}

fn callback_base() -> String {
    std::env::var("FLEETIFY_BACKEND_URL").unwrap_or_else(|_| "http://127.0.0.1:8765".into())
}

fn random_b64(bytes: usize) -> String {
    use base64::Engine;
    use rand::RngCore;
    let mut buf = vec![0u8; bytes];
    rand::thread_rng().fill_bytes(&mut buf);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&buf)
}

fn s256_challenge(verifier: &str) -> String {
    use base64::Engine;
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(verifier.as_bytes());
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(digest)
}

fn percent_encode_minimal(s: &str) -> String {
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

/// Begin the OAuth dance for MCP server `name`. Returns the URL the
/// user should open in their browser. The config must carry
/// `oauth: { authorize_url, token_url, client_id, scopes? }` for this
/// to succeed.
pub fn start(server_name: &str, config: &Value) -> Result<String> {
    let oauth = config
        .get("oauth")
        .ok_or_else(|| anyhow!("server {server_name:?} has no `oauth` block in its config"))?;
    let authorize_url = oauth
        .get("authorize_url")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow!("oauth.authorize_url missing"))?;
    let token_url = oauth
        .get("token_url")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow!("oauth.token_url missing"))?
        .to_string();
    let client_id = oauth
        .get("client_id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow!("oauth.client_id missing"))?
        .to_string();
    let scopes = oauth
        .get("scopes")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let state = random_b64(24);
    let verifier = random_b64(48);
    let challenge = s256_challenge(&verifier);
    let redirect_uri = format!("{}/api/mcp/auth/callback", callback_base());

    // Sweep expired states before insertion.
    {
        let mut g = states().lock().unwrap();
        g.retain(|_, p| p.started_at.elapsed() < STATE_TTL);
        g.insert(
            state.clone(),
            PendingState {
                server_name: server_name.to_string(),
                code_verifier: verifier,
                token_url,
                client_id: client_id.clone(),
                redirect_uri: redirect_uri.clone(),
                started_at: Instant::now(),
            },
        );
    }

    let mut url = format!(
        "{authorize_url}?response_type=code&client_id={}&redirect_uri={}&code_challenge={}&code_challenge_method=S256&state={}",
        percent_encode_minimal(&client_id),
        percent_encode_minimal(&redirect_uri),
        challenge,
        state,
    );
    if !scopes.is_empty() {
        url.push_str("&scope=");
        url.push_str(&percent_encode_minimal(&scopes));
    }
    Ok(url)
}

/// Exchange the code for tokens and persist to mcp_secrets.
pub async fn callback(code: &str, state: &str) -> Result<String> {
    let pending = {
        let mut g = states().lock().unwrap();
        g.remove(state)
    }
    .ok_or_else(|| anyhow!("unknown or expired state {state:?}"))?;
    if pending.started_at.elapsed() >= STATE_TTL {
        return Err(anyhow!("state expired"));
    }
    // POST <token_url> with form-encoded auth-code grant + PKCE
    // verifier. The reqwest::Form helper handles the urlencoding.
    let r = reqwest::Client::new()
        .post(&pending.token_url)
        .form(&[
            ("grant_type", "authorization_code"),
            ("code", code),
            ("redirect_uri", &pending.redirect_uri),
            ("client_id", &pending.client_id),
            ("code_verifier", &pending.code_verifier),
        ])
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .map_err(|e| anyhow!("token POST failed: {e}"))?;
    if !r.status().is_success() {
        let s = r.status().as_u16();
        let body = r.text().await.unwrap_or_default();
        return Err(anyhow!("token POST returned {s}: {body}"));
    }
    let body: Value = r.json().await.map_err(|e| anyhow!("token decode: {e}"))?;
    let access = body
        .get("access_token")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow!("token response missing access_token"))?
        .to_string();
    let refresh = body
        .get("refresh_token")
        .and_then(|v| v.as_str())
        .map(String::from);
    let expires_at = body
        .get("expires_in")
        .and_then(|v| v.as_i64())
        .map(|s| chrono::Utc::now().timestamp() + s);

    // Capture token_type + any other fields under `extra` so the
    // ClaudeBridge MCP-config splice picks them up.
    let mut extra = std::collections::HashMap::new();
    if let Some(obj) = body.as_object() {
        for (k, v) in obj {
            if !matches!(
                k.as_str(),
                "access_token" | "refresh_token" | "expires_in" | "expires_at"
            ) {
                extra.insert(k.clone(), v.clone());
            }
        }
    }

    let secret = McpSecret {
        access_token: Some(access),
        refresh_token: refresh,
        expires_at,
        extra,
    };
    mcp_secrets::set(&pending.server_name, &secret).map_err(|e| anyhow!(e))?;
    Ok(pending.server_name)
}

/// Drop a stored token (sign-out for the server).
pub fn signout(server_name: &str) {
    mcp_secrets::delete(server_name);
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn start_rejects_missing_oauth_block() {
        let r = start("noauth", &json!({ "type": "http" }));
        assert!(r.unwrap_err().to_string().contains("no `oauth` block"));
    }

    #[test]
    fn start_rejects_missing_authorize_url() {
        let r = start(
            "x",
            &json!({
                "oauth": { "token_url": "https://t", "client_id": "c" }
            }),
        );
        assert!(r.unwrap_err().to_string().contains("authorize_url missing"));
    }

    #[test]
    fn start_returns_url_with_pkce_challenge_and_state() {
        let r = start(
            "x",
            &json!({
                "oauth": {
                    "authorize_url": "https://example.com/authorize",
                    "token_url": "https://example.com/token",
                    "client_id": "fleetify-test",
                    "scopes": "read:user"
                }
            }),
        )
        .unwrap();
        assert!(r.starts_with("https://example.com/authorize?"));
        assert!(r.contains("response_type=code"));
        assert!(r.contains("client_id=fleetify-test"));
        assert!(r.contains("code_challenge_method=S256"));
        assert!(r.contains("scope=read%3Auser"));
    }

    #[tokio::test]
    async fn callback_rejects_unknown_state() {
        let e = callback("CODE", "definitely-not-a-real-state-id-xyzzy")
            .await
            .unwrap_err();
        assert!(e.to_string().contains("unknown or expired state"));
    }
}
