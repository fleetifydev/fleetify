//! HTTP-provider health probe. Test-runs every provider in CATALOG
//! (kind = Api) in parallel and writes the result to HttpHealthCache.
//!
//! Same logic the renderer's "Test" button has invoked since PR #18,
//! but driven from the boot warm-up so Settings → Models renders with
//! final pills on first paint.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use crate::providers::{ProviderKind, CATALOG};
use crate::routers::providers::{HealthSnapshot, HttpHealthCache};

const HEALTH_TIMEOUT: Duration = Duration::from_secs(8);

/// Some providers (notably Gemini's OpenAI-compat endpoint at
/// `generativelanguage.googleapis.com/v1beta/openai`) reject bad keys
/// with HTTP 400 + a Google-RPC error envelope instead of the usual
/// 401/403. Returns true when the response body matches one of the
/// well-known key-rejection shapes so callers can map the failure to
/// `AUTH` rather than the generic `NETWORK` bucket. Substring-based
/// rather than JSON-parsed: cheap, robust across whitespace/order,
/// and impossible to misread when the upstream tweaks the envelope.
pub fn is_key_rejection_body(body: &str) -> bool {
    body.contains("API_KEY_INVALID")
        || body.contains("API key not valid")
        || body.contains("UNAUTHENTICATED")
}

/// Fan-out probe of every API-kind provider in the catalog. Writes the
/// resulting snapshot to `cache` (replacing any previous content).
pub async fn warm_all(cache: &HttpHealthCache) {
    let mut joins = Vec::new();
    for spec in CATALOG.iter() {
        if !matches!(spec.kind, ProviderKind::Api) {
            continue;
        }
        let id = spec.id.to_string();
        joins.push(tokio::spawn(async move {
            let snap = probe_one(&id).await;
            (id, snap)
        }));
    }
    let mut map = HashMap::new();
    for j in joins {
        match j.await {
            Ok((id, snap)) => {
                map.insert(id, snap);
            }
            Err(e) => {
                tracing::error!(target: "fleet-backend", error = %e, "warm_all: probe task panicked")
            }
        }
    }
    cache.set(map).await;
}

async fn probe_one(provider_id: &str) -> HealthSnapshot {
    let Some(key) = crate::providers::keys::get_key(provider_id) else {
        return HealthSnapshot::NoKey;
    };
    let Some(spec) = crate::providers::find_provider(provider_id) else {
        return HealthSnapshot::Failed {
            code: "UNKNOWN_PROVIDER".into(),
            message: None,
        };
    };
    let base = spec.default_base_url.trim_end_matches('/');
    // Workers AI's OpenAI-compat surface exposes no `/models`, and its base
    // URL is account-templated (`…/accounts/{account_id}/ai/v1`) — probing
    // `{base}/models` would fire an authenticated request at a malformed URL
    // (literal `{account_id}`). Probe the account-independent token-verify
    // endpoint instead: a genuine health signal (active token → 200/Ok;
    // revoked → 401/AUTH) with no template substitution needed.
    let url = if provider_id == "cloudflare-workers-ai" {
        "https://api.cloudflare.com/client/v4/user/tokens/verify".to_string()
    } else {
        format!("{}/models", base)
    };
    let client = match reqwest::Client::builder().timeout(HEALTH_TIMEOUT).build() {
        Ok(c) => c,
        Err(e) => {
            return HealthSnapshot::Failed {
                code: "NETWORK".into(),
                message: Some(e.to_string()),
            }
        }
    };
    let started = Instant::now();
    // FIXME: Hardcoded Bearer. Every current ProviderKind::Api entry in
    // CATALOG uses AuthSpec::Bearer, but AuthSpec::ApiKey { header, .. }
    // exists. When the first ApiKey-auth provider lands, switch to a
    // `match spec.auth` here.
    let resp = client.get(&url).bearer_auth(&key).send().await;
    let latency_ms = started.elapsed().as_millis() as u64;
    match resp {
        Ok(r) if r.status().is_success() => {
            let body = r.json::<serde_json::Value>().await.unwrap_or_default();
            let model_count = body.get("data").and_then(|v| v.as_array()).map(|a| a.len());
            HealthSnapshot::Ok {
                latency_ms,
                model_count,
            }
        }
        Ok(r)
            if r.status() == reqwest::StatusCode::UNAUTHORIZED
                || r.status() == reqwest::StatusCode::FORBIDDEN =>
        {
            HealthSnapshot::Failed {
                code: "AUTH".into(),
                message: Some(r.status().to_string()),
            }
        }
        Ok(r) if r.status() == reqwest::StatusCode::NOT_FOUND => HealthSnapshot::Failed {
            code: "NOT_FOUND".into(),
            message: Some(r.status().to_string()),
        },
        Ok(r) if r.status() == reqwest::StatusCode::BAD_REQUEST => {
            let status = r.status();
            let body = r.text().await.unwrap_or_default();
            if is_key_rejection_body(&body) {
                HealthSnapshot::Failed {
                    code: "AUTH".into(),
                    message: Some("API key rejected".into()),
                }
            } else {
                HealthSnapshot::Failed {
                    code: "HTTP".into(),
                    message: Some(format!("{status}")),
                }
            }
        }
        Ok(r) => HealthSnapshot::Failed {
            code: "HTTP".into(),
            message: Some(format!("{}", r.status())),
        },
        Err(e) if e.is_timeout() => HealthSnapshot::Failed {
            code: "TIMEOUT".into(),
            message: None,
        },
        Err(e) => HealthSnapshot::Failed {
            code: "NETWORK".into(),
            message: Some(e.to_string()),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_key_rejection_body_matches_gemini_envelope() {
        // Real response from `GET v1beta/openai/models` with a bogus key.
        let body = r#"{
          "error": {
            "code": 400,
            "message": "API key not valid. Please pass a valid API key.",
            "status": "INVALID_ARGUMENT",
            "details": [{"reason": "API_KEY_INVALID"}]
          }
        }"#;
        assert!(is_key_rejection_body(body));
    }

    #[test]
    fn is_key_rejection_body_matches_unauthenticated_envelope() {
        let body = r#"{"error":{"status":"UNAUTHENTICATED","message":"…"}}"#;
        assert!(is_key_rejection_body(body));
    }

    #[test]
    fn is_key_rejection_body_ignores_unrelated_400() {
        // A 400 about a malformed path / missing field shouldn't be
        // mistaken for an auth failure.
        let body = r#"{"error":{"code":400,"message":"Required parameter is missing","status":"INVALID_ARGUMENT","details":[{"reason":"MISSING_REQUIRED_FIELD"}]}}"#;
        assert!(!is_key_rejection_body(body));
    }

    #[test]
    fn is_key_rejection_body_handles_empty_body() {
        assert!(!is_key_rejection_body(""));
    }
}
