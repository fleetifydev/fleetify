//! Weave Router ProxyGateway — sits in front of providers at /anthropic, /openai,
//! /google path prefixes. Bridges resolve their base_url through this gateway
//! when activated.

use async_trait::async_trait;
use http::{HeaderMap, HeaderName, HeaderValue};
use reqwest::Client;
use std::time::Duration;

use crate::services::routing::traits::{ProviderKind, ProxyGateway, RouterError};

/// Returns the first 4 chars of an API key for diagnostic logging (e.g. "rk_a").
/// Pairs with `key_tail` so the user can verify which key is in flight without
/// the full credential ever hitting the log file. Sub-8-char keys collapse to
/// `"***"` since there's not enough material to show both ends safely.
fn key_head(k: &str) -> String {
    if k.len() <= 8 {
        return "***".into();
    }
    k.chars().take(4).collect()
}

/// Returns the last 4 chars of an API key for diagnostic logging.
fn key_tail(k: &str) -> String {
    if k.len() <= 8 {
        return "***".into();
    }
    let v: Vec<char> = k.chars().collect();
    v.iter().rev().take(4).rev().collect()
}

#[derive(Clone)]
pub struct WeaveProxyGateway {
    client: Client,
    base_url: String,
    api_key: String,
}

impl WeaveProxyGateway {
    pub fn new(api_key: String, base_url: String) -> Self {
        let client = Client::builder()
            .timeout(Duration::from_secs(2))
            .build()
            .unwrap_or_default();
        Self {
            client,
            base_url,
            api_key,
        }
    }
}

#[async_trait]
impl ProxyGateway for WeaveProxyGateway {
    fn id(&self) -> &'static str {
        "weave"
    }
    fn display_name(&self) -> &'static str {
        "Weave Router"
    }

    fn base_url(&self, provider: ProviderKind) -> Option<String> {
        let suffix = match provider {
            ProviderKind::Anthropic => "/anthropic",
            ProviderKind::OpenAI | ProviderKind::OpenAICompatible => "/openai",
            ProviderKind::Google => "/google",
        };
        Some(format!("{}{}", self.base_url.trim_end_matches('/'), suffix))
    }

    fn extra_headers(&self) -> HeaderMap {
        // Weave Router's auth middleware accepts the router key (`rk_…`) on
        // three headers, in this precedence order (per `internal/server/
        // middleware/auth.go` in github.com/workweave/router):
        //
        //   1. `X-Weave-Router-Key: <raw rk_…>`       (preferred — raw, no prefix)
        //   2. `Authorization: Bearer <rk_…>`         (fallback)
        //   3. `x-api-key: <rk_…>`                    (last resort)
        //
        // We pick #1 because it leaves `Authorization` / `x-api-key` free for
        // the bridge's *upstream* provider credential (Anthropic `x-api-key`,
        // OpenAI `Authorization: Bearer sk-…`) — Weave's own comment on the
        // header literally calls this out: "carries the Weave Router key when
        // clients need to preserve Authorization / x-api-key for the upstream
        // provider." Sending #2 here would clobber the upstream's bearer when
        // the bridge merges these into the outbound request.
        //
        // The previous implementation used a fabricated `x-weave-auth` header
        // which matches none of the three above — so every proxy turn 401'd
        // upstream, surfacing as misleading errors like "model doesn't exist"
        // (claude-code mistranslates 401 from the proxy as a model-access
        // failure rather than an auth failure).
        let mut h = HeaderMap::new();
        if let Ok(v) = HeaderValue::from_str(&self.api_key) {
            h.insert(HeaderName::from_static("x-weave-router-key"), v);
            tracing::debug!(
                target: "fleetify::routing::proxy",
                head = key_head(&self.api_key),
                tail = key_tail(&self.api_key),
                base_url = %self.base_url,
                "weave proxy: attaching X-Weave-Router-Key (raw, no Bearer prefix)"
            );
        }
        h
    }

    async fn health_check(&self) -> Result<(), RouterError> {
        let resp = self
            .client
            .get(format!("{}/health", self.base_url.trim_end_matches('/')))
            .bearer_auth(&self.api_key)
            .send()
            .await
            .map_err(|e| RouterError::Network(e.to_string()))?;
        if resp.status().is_success() {
            Ok(())
        } else if resp.status().as_u16() == 401 || resp.status().as_u16() == 403 {
            Err(RouterError::Auth)
        } else {
            Err(RouterError::Upstream(resp.status().to_string()))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_url_per_provider() {
        let g = WeaveProxyGateway::new("k".into(), "https://router.workweave.ai".into());
        assert_eq!(
            g.base_url(ProviderKind::Anthropic).as_deref(),
            Some("https://router.workweave.ai/anthropic")
        );
        assert_eq!(
            g.base_url(ProviderKind::OpenAI).as_deref(),
            Some("https://router.workweave.ai/openai")
        );
        assert_eq!(
            g.base_url(ProviderKind::Google).as_deref(),
            Some("https://router.workweave.ai/google")
        );
        assert_eq!(
            g.base_url(ProviderKind::OpenAICompatible).as_deref(),
            Some("https://router.workweave.ai/openai")
        );
    }

    #[test]
    fn base_url_trims_trailing_slash() {
        let g = WeaveProxyGateway::new("k".into(), "https://router.workweave.ai/".into());
        assert_eq!(
            g.base_url(ProviderKind::Anthropic).as_deref(),
            Some("https://router.workweave.ai/anthropic")
        );
    }

    #[test]
    fn extra_headers_uses_router_key_header_with_raw_token() {
        // Regression: Weave's auth middleware reads `X-Weave-Router-Key`
        // (raw, no `Bearer ` prefix). Sending `x-weave-auth: Bearer …`
        // — which the original impl did — matches none of Weave's three
        // accepted headers (`X-Weave-Router-Key`, `Authorization: Bearer`,
        // `x-api-key`) and 401s every proxy turn upstream.
        let g = WeaveProxyGateway::new("rk_test-key".into(), "https://example.com".into());
        let h = g.extra_headers();
        let v = h.get("x-weave-router-key").unwrap();
        assert_eq!(v.to_str().unwrap(), "rk_test-key");
        // And we MUST NOT clobber Authorization — the bridge layers the
        // upstream provider credential (Anthropic key etc.) on top of these,
        // and Weave forwards Authorization unchanged to the upstream.
        assert!(h.get(http::header::AUTHORIZATION).is_none());
    }

    #[test]
    fn id_and_display_name() {
        let g = WeaveProxyGateway::new("k".into(), "x".into());
        assert_eq!(g.id(), "weave");
        assert_eq!(g.display_name(), "Weave Router");
    }
}
