use async_trait::async_trait;
use http::HeaderMap;
use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentKind {
    Claude,
    OpenAI,
    Gemini,
    Codex,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProviderKind {
    Anthropic,
    OpenAI,
    Google,
    OpenAICompatible,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DecisionSource {
    BuiltIn,
    NotDiamond,
    Weave,
    Inworld,
    Manual,
    Pinned,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RouterDecision {
    pub agent: AgentKind,
    pub model: String,
    pub rationale: String,
    pub source: DecisionSource,
    pub fallback_chain: Vec<(AgentKind, String)>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TaskFlow {
    Chat { session_id: String },
    Dispatch { task_id: String },
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct WorkspaceHints {
    pub file_count: Option<usize>,
    pub repo_size_kb: Option<u64>,
    pub languages: Vec<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ComplexityHint {
    Trivial,
    Simple,
    Medium,
    Complex,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoutingTask {
    pub flow: TaskFlow,
    pub user_prompt: String,
    pub conversation_history: Option<Vec<Message>>,
    pub workspace_context: WorkspaceHints,
    pub user_hint: Option<ComplexityHint>,
    pub allowed_agents: Vec<AgentKind>,
    pub budget_remaining: Option<f64>,
}

#[derive(Debug, Clone)]
pub struct AgentCandidate {
    pub agent: AgentKind,
    pub tiers: Vec<String>,
}

#[derive(Debug, Error)]
pub enum RouterError {
    #[error("network error: {0}")]
    Network(String),
    #[error("timeout after {0}ms")]
    Timeout(u64),
    #[error("upstream returned 4xx/5xx: {0}")]
    Upstream(String),
    #[error("invalid response: {0}")]
    InvalidResponse(String),
    #[error("not configured")]
    NotConfigured,
    #[error("auth failed")]
    Auth,
    #[error("internal: {0}")]
    Internal(String),
}

#[async_trait]
pub trait DecisionRouter: Send + Sync {
    fn id(&self) -> &'static str;
    fn display_name(&self) -> &'static str;
    async fn health_check(&self) -> Result<(), RouterError>;
    async fn recommend(
        &self,
        task: &RoutingTask,
        candidates: &[AgentCandidate],
    ) -> Result<RouterDecision, RouterError>;
}

#[async_trait]
pub trait ProxyGateway: Send + Sync {
    fn id(&self) -> &'static str;
    fn display_name(&self) -> &'static str;
    fn base_url(&self, provider: ProviderKind) -> Option<String>;
    fn extra_headers(&self) -> HeaderMap;
    async fn health_check(&self) -> Result<(), RouterError>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn router_decision_constructs() {
        let d = RouterDecision {
            agent: AgentKind::Claude,
            model: "claude-sonnet-4-6".into(),
            rationale: "code task, medium complexity".into(),
            source: DecisionSource::BuiltIn,
            fallback_chain: vec![(AgentKind::Claude, "claude-haiku-4-5".into())],
        };
        assert_eq!(d.agent, AgentKind::Claude);
        assert_eq!(d.fallback_chain.len(), 1);
    }

    #[test]
    fn routing_task_minimum_fields() {
        let t = RoutingTask {
            flow: TaskFlow::Chat { session_id: "s1".into() },
            user_prompt: "hello".into(),
            conversation_history: None,
            workspace_context: WorkspaceHints::default(),
            user_hint: None,
            allowed_agents: vec![AgentKind::Claude, AgentKind::OpenAI],
            budget_remaining: None,
        };
        assert!(matches!(t.flow, TaskFlow::Chat { .. }));
    }

    #[test]
    fn router_decision_serde_round_trip() {
        let d = RouterDecision {
            agent: AgentKind::Claude,
            model: "claude-sonnet-4-6".into(),
            rationale: "x".into(),
            source: DecisionSource::BuiltIn,
            fallback_chain: vec![(AgentKind::OpenAI, "gpt-4o".into())],
        };
        let s = serde_json::to_string(&d).unwrap();
        let back: RouterDecision = serde_json::from_str(&s).unwrap();
        assert_eq!(back.agent, AgentKind::Claude);
        assert_eq!(back.source, DecisionSource::BuiltIn);
        assert_eq!(back.fallback_chain.len(), 1);
        assert_eq!(back.fallback_chain[0].0, AgentKind::OpenAI);
    }

    #[test]
    fn routing_task_serde_round_trip() {
        let t = RoutingTask {
            flow: TaskFlow::Chat { session_id: "s1".into() },
            user_prompt: "hi".into(),
            conversation_history: None,
            workspace_context: WorkspaceHints::default(),
            user_hint: Some(ComplexityHint::Medium),
            allowed_agents: vec![AgentKind::Claude, AgentKind::Gemini],
            budget_remaining: Some(1.5),
        };
        let s = serde_json::to_string(&t).unwrap();
        let back: RoutingTask = serde_json::from_str(&s).unwrap();
        assert!(matches!(back.flow, TaskFlow::Chat { session_id } if session_id == "s1"));
        assert!(matches!(back.user_hint, Some(ComplexityHint::Medium)));
        assert_eq!(back.allowed_agents.len(), 2);
        // Verify externally-tagged JSON format — for TaskFlow this should contain "type":"chat"
        assert!(s.contains("\"type\":\"chat\""), "TaskFlow should use tagged serde format, got: {}", s);
    }
}
