//! Not Diamond DecisionRouter — calls https://api.notdiamond.ai/v2/modelSelect
//! to pick the best (provider, model) for each prompt.
//!
//! API contract is provisional (Not Diamond's full v2 schema isn't public);
//! the shape used here matches the documented v2 endpoint. If the live API
//! diverges, adjust the request/response structs only — the trait surface
//! is stable.

use async_trait::async_trait;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::time::Duration;

use crate::services::routing::traits::{
    AgentCandidate, AgentKind, DecisionRouter, DecisionSource, RouterDecision, RouterError,
    RoutingTask,
};

const DEFAULT_BASE_URL: &str = "https://api.notdiamond.ai/v2";

#[derive(Clone)]
pub struct NotDiamondRouter {
    client: Client,
    base_url: String,
    api_key: String,
}

#[derive(Serialize)]
struct ModelSelectRequest<'a> {
    messages: Vec<MessageRef<'a>>,
    models: Vec<String>,
    tradeoff: &'a str,
}

#[derive(Serialize)]
struct MessageRef<'a> {
    role: &'a str,
    content: &'a str,
}

#[derive(Deserialize)]
struct ModelSelectResponse {
    provider: String,
    model: String,
    #[serde(default)]
    session_id: Option<String>,
}

impl NotDiamondRouter {
    pub fn new(api_key: String) -> Self {
        Self::with_base_url(api_key, DEFAULT_BASE_URL.to_string())
    }

    pub fn with_base_url(api_key: String, base_url: String) -> Self {
        let client = Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap_or_default();
        Self {
            client,
            base_url,
            api_key,
        }
    }
}

fn provider_prefix(a: AgentKind) -> &'static str {
    match a {
        AgentKind::Claude => "anthropic",
        AgentKind::OpenAI => "openai",
        AgentKind::Gemini => "google",
        AgentKind::Codex => "openai",
    }
}

fn agent_from_provider(p: &str) -> Option<AgentKind> {
    match p {
        "anthropic" => Some(AgentKind::Claude),
        "openai" => Some(AgentKind::OpenAI),
        "google" => Some(AgentKind::Gemini),
        _ => None,
    }
}

#[async_trait]
impl DecisionRouter for NotDiamondRouter {
    fn id(&self) -> &'static str {
        "notdiamond"
    }
    fn display_name(&self) -> &'static str {
        "Not Diamond"
    }

    async fn health_check(&self) -> Result<(), RouterError> {
        let resp = self
            .client
            .get(format!("{}/health", self.base_url))
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

    async fn recommend(
        &self,
        task: &RoutingTask,
        candidates: &[AgentCandidate],
    ) -> Result<RouterDecision, RouterError> {
        let mut model_list: Vec<String> = Vec::new();
        for c in candidates {
            let prefix = provider_prefix(c.agent);
            for tier in &c.tiers {
                model_list.push(format!("{prefix}/{tier}"));
            }
        }
        if model_list.is_empty() {
            return Err(RouterError::NotConfigured);
        }

        let req = ModelSelectRequest {
            messages: vec![MessageRef {
                role: "user",
                content: &task.user_prompt,
            }],
            models: model_list,
            tradeoff: "cost",
        };

        let resp = self
            .client
            .post(format!("{}/modelSelect", self.base_url))
            .bearer_auth(&self.api_key)
            .json(&req)
            .send()
            .await
            .map_err(|e| RouterError::Network(e.to_string()))?;

        if !resp.status().is_success() {
            let status = resp.status();
            if status.as_u16() == 401 || status.as_u16() == 403 {
                return Err(RouterError::Auth);
            }
            return Err(RouterError::Upstream(status.to_string()));
        }

        let body: ModelSelectResponse = resp
            .json()
            .await
            .map_err(|e| RouterError::InvalidResponse(e.to_string()))?;

        let agent = agent_from_provider(&body.provider).ok_or_else(|| {
            RouterError::InvalidResponse(format!("unknown provider {}", body.provider))
        })?;

        // Fallback chain: all other (agent, tier) combos from the candidate list,
        // excluding the chosen model.
        let fallback: Vec<(AgentKind, String)> = candidates
            .iter()
            .flat_map(|c| c.tiers.iter().map(move |t| (c.agent, t.clone())))
            .filter(|(_, m)| *m != body.model)
            .collect();

        Ok(RouterDecision {
            agent,
            model: body.model,
            rationale: format!(
                "Not Diamond selection (session={})",
                body.session_id.unwrap_or_default()
            ),
            source: DecisionSource::NotDiamond,
            fallback_chain: fallback,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    use crate::services::routing::traits::{TaskFlow, WorkspaceHints};

    fn task(prompt: &str) -> RoutingTask {
        RoutingTask {
            flow: TaskFlow::Chat {
                session_id: "s".into(),
            },
            user_prompt: prompt.into(),
            conversation_history: None,
            workspace_context: WorkspaceHints::default(),
            user_hint: None,
            allowed_agents: vec![AgentKind::Claude, AgentKind::OpenAI],
            budget_remaining: None,
        }
    }

    fn candidates() -> Vec<AgentCandidate> {
        vec![
            AgentCandidate {
                agent: AgentKind::Claude,
                tiers: vec!["claude-haiku-4-5".into(), "claude-sonnet-4-6".into()],
            },
            AgentCandidate {
                agent: AgentKind::OpenAI,
                tiers: vec!["gpt-4o-mini".into(), "gpt-4o".into()],
            },
        ]
    }

    #[tokio::test]
    async fn recommend_parses_anthropic_response() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v2/modelSelect"))
            .and(header("authorization", "Bearer test-key"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "provider": "anthropic",
                "model": "claude-sonnet-4-6",
                "session_id": "sess_xyz",
            })))
            .mount(&server)
            .await;

        let r = NotDiamondRouter::with_base_url("test-key".into(), format!("{}/v2", server.uri()));
        let d = r.recommend(&task("hi"), &candidates()).await.unwrap();
        assert_eq!(d.agent, AgentKind::Claude);
        assert_eq!(d.model, "claude-sonnet-4-6");
        assert_eq!(d.source, DecisionSource::NotDiamond);
        // Fallback should include the other 3 (haiku + 2 openai tiers).
        assert_eq!(d.fallback_chain.len(), 3);
    }

    #[tokio::test]
    async fn recommend_parses_openai_response() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v2/modelSelect"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "provider": "openai",
                "model": "gpt-4o-mini",
            })))
            .mount(&server)
            .await;
        let r = NotDiamondRouter::with_base_url("k".into(), format!("{}/v2", server.uri()));
        let d = r.recommend(&task("hi"), &candidates()).await.unwrap();
        assert_eq!(d.agent, AgentKind::OpenAI);
        assert_eq!(d.model, "gpt-4o-mini");
    }

    #[tokio::test]
    async fn recommend_errors_on_empty_candidates() {
        let r = NotDiamondRouter::with_base_url("k".into(), "http://localhost".into());
        let res = r.recommend(&task("hi"), &[]).await;
        assert!(matches!(res, Err(RouterError::NotConfigured)));
    }

    #[tokio::test]
    async fn recommend_errors_on_unknown_provider() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v2/modelSelect"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "provider": "mystery",
                "model": "foo",
            })))
            .mount(&server)
            .await;
        let r = NotDiamondRouter::with_base_url("k".into(), format!("{}/v2", server.uri()));
        let res = r.recommend(&task("hi"), &candidates()).await;
        assert!(matches!(res, Err(RouterError::InvalidResponse(_))));
    }

    #[tokio::test]
    async fn recommend_maps_401_to_auth_error() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v2/modelSelect"))
            .respond_with(ResponseTemplate::new(401).set_body_string("unauthorized"))
            .mount(&server)
            .await;
        let r = NotDiamondRouter::with_base_url("k".into(), format!("{}/v2", server.uri()));
        let res = r.recommend(&task("hi"), &candidates()).await;
        assert!(matches!(res, Err(RouterError::Auth)));
    }

    #[tokio::test]
    async fn recommend_maps_500_to_upstream_error() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v2/modelSelect"))
            .respond_with(ResponseTemplate::new(503))
            .mount(&server)
            .await;
        let r = NotDiamondRouter::with_base_url("k".into(), format!("{}/v2", server.uri()));
        let res = r.recommend(&task("hi"), &candidates()).await;
        assert!(matches!(res, Err(RouterError::Upstream(_))));
    }

    #[test]
    fn id_and_display_name() {
        let r = NotDiamondRouter::new("k".into());
        assert_eq!(r.id(), "notdiamond");
        assert_eq!(r.display_name(), "Not Diamond");
    }
}
