//! Direct (None) proxy — bridges hit providers at their default URLs.
//! Always registered; cannot be unregistered. Default active gateway.

use async_trait::async_trait;
use http::HeaderMap;

use crate::services::routing::traits::{ProviderKind, ProxyGateway, RouterError};

pub struct DirectGateway;

#[async_trait]
impl ProxyGateway for DirectGateway {
    fn id(&self) -> &'static str {
        "none-proxy"
    }
    fn display_name(&self) -> &'static str {
        "None / Direct"
    }
    fn base_url(&self, _provider: ProviderKind) -> Option<String> {
        None
    }
    fn extra_headers(&self) -> HeaderMap {
        HeaderMap::new()
    }
    async fn health_check(&self) -> Result<(), RouterError> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_url_always_none() {
        let g = DirectGateway;
        assert!(g.base_url(ProviderKind::Anthropic).is_none());
        assert!(g.base_url(ProviderKind::OpenAI).is_none());
        assert!(g.base_url(ProviderKind::Google).is_none());
        assert!(g.base_url(ProviderKind::OpenAICompatible).is_none());
    }

    #[test]
    fn extra_headers_empty() {
        assert!(DirectGateway.extra_headers().is_empty());
    }

    #[test]
    fn id_and_display_name() {
        let g = DirectGateway;
        assert_eq!(g.id(), "none-proxy");
        assert_eq!(g.display_name(), "None / Direct");
    }

    #[tokio::test]
    async fn health_check_always_ok() {
        assert!(DirectGateway.health_check().await.is_ok());
    }
}
