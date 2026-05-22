//! Weave Router ProxyGateway — sits in front of providers at /anthropic, /openai,
//! /google path prefixes. Bridges resolve their base_url through this gateway
//! when activated.

use async_trait::async_trait;
use http::{HeaderMap, HeaderName, HeaderValue};
use reqwest::Client;
use std::time::Duration;

use crate::services::routing::traits::{ProviderKind, ProxyGateway, RouterError};

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
        let mut h = HeaderMap::new();
        if let Ok(v) = HeaderValue::from_str(&format!("Bearer {}", self.api_key)) {
            h.insert(HeaderName::from_static("x-weave-auth"), v);
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
    fn extra_headers_contains_bearer() {
        let g = WeaveProxyGateway::new("test-key".into(), "https://example.com".into());
        let h = g.extra_headers();
        let v = h.get("x-weave-auth").unwrap();
        assert_eq!(v.to_str().unwrap(), "Bearer test-key");
    }

    #[test]
    fn id_and_display_name() {
        let g = WeaveProxyGateway::new("k".into(), "x".into());
        assert_eq!(g.id(), "weave");
        assert_eq!(g.display_name(), "Weave Router");
    }
}
