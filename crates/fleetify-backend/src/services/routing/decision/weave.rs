//! Weave Router DecisionRouter — calls /decide for a routing recommendation.
//! Mirrors NotDiamondRouter shape but talks the Workweave Router protocol.
//! API contract is provisional; see Spec Open Questions for verification.

use async_trait::async_trait;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::time::Duration;

use crate::services::routing::traits::{
    AgentCandidate, AgentKind, DecisionRouter, DecisionSource, RouterDecision, RouterError,
    RoutingTask,
};

pub const DEFAULT_MANAGED_URL: &str = "https://router.workweave.ai";

#[derive(Clone)]
pub struct WeaveDecisionRouter {
    client: Client,
    base_url: String,
    api_key: String,
}

#[derive(Serialize)]
struct DecisionRequest<'a> {
    messages: Vec<MessageRef<'a>>,
    candidates: Vec<String>,
}

#[derive(Serialize)]
struct MessageRef<'a> {
    role: &'a str,
    content: &'a str,
}

#[derive(Deserialize)]
struct DecisionResponse {
    provider: String,
    model: String,
    #[serde(default)]
    rationale: Option<String>,
}

impl WeaveDecisionRouter {
    pub fn new(api_key: String) -> Self {
        Self::with_base_url(api_key, DEFAULT_MANAGED_URL.to_string())
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

fn weave_provider(a: AgentKind) -> &'static str {
    match a {
        AgentKind::Claude => "anthropic",
        AgentKind::OpenAI | AgentKind::Codex => "openai",
        AgentKind::Gemini => "google",
        // Weave's openai-compat endpoint handles Moonshot.
        AgentKind::Kimi => "openai",
        // GitHub Copilot CLI is not a Weave routing target (locally-run CLI
        // agent). Returning the openai-compat provider tag for telemetry only.
        AgentKind::GitHubCopilot => "openai",
    }
}

#[async_trait]
impl DecisionRouter for WeaveDecisionRouter {
    fn id(&self) -> &'static str {
        "weave"
    }
    fn display_name(&self) -> &'static str {
        "Weave Router"
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
        let mut models = Vec::new();
        for c in candidates {
            for t in &c.tiers {
                models.push(format!("{}/{}", weave_provider(c.agent), t));
            }
        }
        if models.is_empty() {
            return Err(RouterError::NotConfigured);
        }
        let req = DecisionRequest {
            messages: vec![MessageRef {
                role: "user",
                content: &task.user_prompt,
            }],
            candidates: models,
        };
        let resp = self
            .client
            .post(format!("{}/decide", self.base_url))
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
        let body: DecisionResponse = resp
            .json()
            .await
            .map_err(|e| RouterError::InvalidResponse(e.to_string()))?;
        let agent = match body.provider.as_str() {
            "anthropic" => AgentKind::Claude,
            "openai" => AgentKind::OpenAI,
            "google" => AgentKind::Gemini,
            other => {
                return Err(RouterError::InvalidResponse(format!(
                    "unknown provider {other}"
                )))
            }
        };
        let fallback: Vec<(AgentKind, String)> = candidates
            .iter()
            .flat_map(|c| c.tiers.iter().map(move |t| (c.agent, t.clone())))
            .filter(|(_, m)| *m != body.model)
            .collect();
        Ok(RouterDecision {
            agent,
            model: body.model,
            rationale: body
                .rationale
                .unwrap_or_else(|| "Weave router decision".into()),
            source: DecisionSource::Weave,
            fallback_chain: fallback,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::routing::traits::{TaskFlow, WorkspaceHints};
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn task() -> RoutingTask {
        RoutingTask {
            flow: TaskFlow::Chat {
                session_id: "s".into(),
            },
            user_prompt: "hi".into(),
            conversation_history: None,
            workspace_context: WorkspaceHints::default(),
            user_hint: None,
            allowed_agents: vec![AgentKind::Claude],
            budget_remaining: None,
        }
    }

    fn cands() -> Vec<AgentCandidate> {
        vec![AgentCandidate {
            agent: AgentKind::Claude,
            tiers: vec!["claude-haiku-4-5".into(), "claude-sonnet-4-6".into()],
        }]
    }

    #[tokio::test]
    async fn recommend_parses_decision() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/decide"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "provider": "anthropic",
                "model": "claude-sonnet-4-6",
                "rationale": "high complexity",
            })))
            .mount(&server)
            .await;
        let r = WeaveDecisionRouter::with_base_url("k".into(), server.uri());
        let d = r.recommend(&task(), &cands()).await.unwrap();
        assert_eq!(d.agent, AgentKind::Claude);
        assert_eq!(d.model, "claude-sonnet-4-6");
        assert_eq!(d.source, DecisionSource::Weave);
        assert_eq!(d.rationale, "high complexity");
    }

    #[tokio::test]
    async fn empty_candidates_errors_not_configured() {
        let r = WeaveDecisionRouter::with_base_url("k".into(), "http://localhost".into());
        assert!(matches!(
            r.recommend(&task(), &[]).await,
            Err(RouterError::NotConfigured)
        ));
    }

    #[tokio::test]
    async fn unknown_provider_invalid_response() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/decide"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "provider": "mystery",
                "model": "x",
            })))
            .mount(&server)
            .await;
        let r = WeaveDecisionRouter::with_base_url("k".into(), server.uri());
        assert!(matches!(
            r.recommend(&task(), &cands()).await,
            Err(RouterError::InvalidResponse(_))
        ));
    }

    #[test]
    fn id_and_display_name() {
        let r = WeaveDecisionRouter::new("k".into());
        assert_eq!(r.id(), "weave");
        assert_eq!(r.display_name(), "Weave Router");
    }
}
