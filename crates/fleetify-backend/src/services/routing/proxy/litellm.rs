//! LiteLLM ProxyGateway — self-hosted proxy with a single base_url for all
//! providers. Authenticates via Bearer token on every request.

use async_trait::async_trait;
use http::{HeaderMap, HeaderValue};
use reqwest::Client;
use std::time::Duration;

use crate::services::routing::traits::{ProviderKind, ProxyGateway, RouterError};

#[derive(Clone)]
pub struct LiteLLMGateway {
    client: Client,
    base_url: String,
    api_key: String,
}

impl LiteLLMGateway {
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
impl ProxyGateway for LiteLLMGateway {
    fn id(&self) -> &'static str {
        "litellm"
    }
    fn display_name(&self) -> &'static str {
        "LiteLLM"
    }

    fn base_url(&self, _provider: ProviderKind) -> Option<String> {
        Some(self.base_url.trim_end_matches('/').to_string())
    }

    fn extra_headers(&self) -> HeaderMap {
        let mut h = HeaderMap::new();
        if let Ok(v) = HeaderValue::from_str(&format!("Bearer {}", self.api_key)) {
            h.insert(http::header::AUTHORIZATION, v);
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
    fn base_url_same_for_all_providers() {
        let g = LiteLLMGateway::new("k".into(), "http://localhost:4000".into());
        for p in [
            ProviderKind::Anthropic,
            ProviderKind::OpenAI,
            ProviderKind::Google,
            ProviderKind::OpenAICompatible,
        ] {
            assert_eq!(g.base_url(p).as_deref(), Some("http://localhost:4000"));
        }
    }

    #[test]
    fn base_url_trims_trailing_slash() {
        let g = LiteLLMGateway::new("k".into(), "http://localhost:4000/".into());
        assert_eq!(
            g.base_url(ProviderKind::OpenAI).as_deref(),
            Some("http://localhost:4000")
        );
    }

    #[test]
    fn extra_headers_contains_authorization_bearer() {
        let g = LiteLLMGateway::new("test-key".into(), "http://localhost:4000".into());
        let h = g.extra_headers();
        let v = h.get(http::header::AUTHORIZATION).unwrap();
        assert_eq!(v.to_str().unwrap(), "Bearer test-key");
    }

    #[test]
    fn id_and_display_name() {
        let g = LiteLLMGateway::new("k".into(), "http://localhost:4000".into());
        assert_eq!(g.id(), "litellm");
        assert_eq!(g.display_name(), "LiteLLM");
    }
}
