//! Public entry point for routing. Holds the decision + proxy registries,
//! a master enabled flag, and a 2-second timeout for the primary decision
//! router. On timeout / error, transparently falls back to built-in.

use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::RwLock;

use crate::services::routing::decision::registry::DecisionRouterRegistry;
use crate::services::routing::proxy::registry::ProxyGatewayRegistry;
use crate::services::routing::traits::{
    AgentCandidate, AgentKind, DecisionRouter, DecisionSource, ProviderKind, ProxyGateway,
    RouterDecision, RoutingTask,
};

pub struct RoutingOrchestrator {
    decision: Arc<RwLock<DecisionRouterRegistry>>,
    proxy: Arc<RwLock<ProxyGatewayRegistry>>,
    enabled: Arc<RwLock<bool>>,
    timeout_ms: u64,
}

pub struct RouteOutcome {
    pub decision: RouterDecision,
    pub latency_ms: u64,
    pub fallback_used: bool,
    pub primary_router_id: Option<String>,
}

impl RoutingOrchestrator {
    pub fn new(
        decision: Arc<RwLock<DecisionRouterRegistry>>,
        proxy: Arc<RwLock<ProxyGatewayRegistry>>,
        enabled: bool,
    ) -> Self {
        Self {
            decision,
            proxy,
            enabled: Arc::new(RwLock::new(enabled)),
            timeout_ms: 2000,
        }
    }

    /// Master "intelligent routing" toggle. When off, callers should bypass
    /// `route()` and use the user's manual selection. This struct doesn't
    /// enforce the toggle inside `route()` — callers (chat / dispatch) check
    /// `enabled()` first.
    pub fn enabled(&self) -> bool {
        *self.enabled.read()
    }
    pub fn set_enabled(&self, v: bool) {
        *self.enabled.write() = v;
    }

    /// Route a task to an (agent, model) decision. NEVER returns Err — on
    /// any failure of the primary decision router, falls back to built-in.
    pub async fn route(&self, task: &RoutingTask, candidates: &[AgentCandidate]) -> RouteOutcome {
        let started = Instant::now();
        let (primary, builtin): (Arc<dyn DecisionRouter>, Arc<dyn DecisionRouter>) = {
            let reg = self.decision.read();
            (reg.active(), reg.builtin())
        };

        // Happy path: primary IS builtin. No timeout, no fallback bookkeeping.
        if primary.id() == builtin.id() {
            let d = builtin
                .recommend(task, candidates)
                .await
                .unwrap_or_else(|_| fallback_default(task));
            return RouteOutcome {
                decision: d,
                latency_ms: elapsed_ms(started),
                fallback_used: false,
                primary_router_id: None,
            };
        }

        // External primary: race against 2s timeout.
        let primary_id = primary.id().to_string();
        let timeout = Duration::from_millis(self.timeout_ms);
        match tokio::time::timeout(timeout, primary.recommend(task, candidates)).await {
            Ok(Ok(d)) => RouteOutcome {
                decision: d,
                latency_ms: elapsed_ms(started),
                fallback_used: false,
                primary_router_id: Some(primary_id),
            },
            Ok(Err(_)) | Err(_) => {
                let d = builtin
                    .recommend(task, candidates)
                    .await
                    .unwrap_or_else(|_| fallback_default(task));
                RouteOutcome {
                    decision: d,
                    latency_ms: elapsed_ms(started),
                    fallback_used: true,
                    primary_router_id: Some(primary_id),
                }
            }
        }
    }

    /// Resolve `(base_url, extra_headers)` for a provider via the active
    /// proxy gateway. Returns None when the active gateway is DirectGateway.
    pub fn proxy_for(&self, provider: ProviderKind) -> Option<(String, http::HeaderMap)> {
        let g: Arc<dyn ProxyGateway> = self.proxy.read().active();
        g.base_url(provider).map(|u| (u, g.extra_headers()))
    }

    /// Look up a router (decision OR proxy) by id and call its health_check.
    /// Used by the `test_router` IPC command (Task 20 wiring).
    pub async fn test_router(&self, id: &str) -> Result<bool, String> {
        let dec = self.decision.read().routers.get(id).cloned();
        if let Some(d) = dec {
            return d
                .health_check()
                .await
                .map(|_| true)
                .map_err(|e| e.to_string());
        }
        let prx = self.proxy.read().gateways.get(id).cloned();
        if let Some(p) = prx {
            return p
                .health_check()
                .await
                .map(|_| true)
                .map_err(|e| e.to_string());
        }
        Err(format!("router {id} not found"))
    }
}

fn elapsed_ms(start: Instant) -> u64 {
    let e = start.elapsed();
    (e.as_secs() * 1000) + u64::from(e.subsec_millis())
}

/// Last-resort decision when even the built-in router errors. Returns the
/// first allowed agent at a hardcoded default model.
fn fallback_default(task: &RoutingTask) -> RouterDecision {
    let agent = task
        .allowed_agents
        .first()
        .copied()
        .unwrap_or(AgentKind::Claude);
    RouterDecision {
        agent,
        model: match agent {
            AgentKind::Claude => "claude-sonnet-4-6".into(),
            AgentKind::OpenAI => "gpt-4o".into(),
            AgentKind::Gemini => "gemini-3.1-pro-preview".into(),
            AgentKind::Codex => "gpt-5-codex".into(),
        },
        rationale: "fallback default — built-in errored unexpectedly".into(),
        source: DecisionSource::BuiltIn,
        fallback_chain: vec![],
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use crate::services::routing::capability_matrix::CapabilityMatrix;
    use crate::services::routing::decision::builtin::BuiltInRouter;
    use crate::services::routing::proxy::direct::DirectGateway;
    use crate::services::routing::traits::{RouterError, RoutingTask, TaskFlow, WorkspaceHints};

    fn matrix() -> CapabilityMatrix {
        toml::from_str(
            r#"
[agents.claude]
supports_tool_use = true
supports_vision = true
max_context = 200000
mcp_support = true
default_model = "claude-sonnet-4-6"
tiers = ["claude-haiku-4-5", "claude-sonnet-4-6"]
        "#,
        )
        .unwrap()
    }

    fn task(prompt: &str) -> RoutingTask {
        RoutingTask {
            flow: TaskFlow::Chat {
                session_id: "s".into(),
            },
            user_prompt: prompt.into(),
            conversation_history: None,
            workspace_context: WorkspaceHints::default(),
            user_hint: None,
            allowed_agents: vec![AgentKind::Claude],
            budget_remaining: None,
        }
    }

    fn make_orch() -> RoutingOrchestrator {
        let builtin: Arc<dyn DecisionRouter> = Arc::new(BuiltInRouter::new(matrix()));
        let dr = Arc::new(RwLock::new(DecisionRouterRegistry::new(builtin)));
        let direct: Arc<dyn ProxyGateway> = Arc::new(DirectGateway);
        let pr = Arc::new(RwLock::new(ProxyGatewayRegistry::new(direct)));
        RoutingOrchestrator::new(dr, pr, true)
    }

    #[tokio::test]
    async fn builtin_path_no_fallback() {
        let orch = make_orch();
        let out = orch.route(&task("Refactor"), &[]).await;
        assert!(!out.fallback_used);
        assert!(out.primary_router_id.is_none());
        assert_eq!(out.decision.agent, AgentKind::Claude);
    }

    #[tokio::test]
    async fn enabled_toggle_round_trip() {
        let orch = make_orch();
        assert!(orch.enabled());
        orch.set_enabled(false);
        assert!(!orch.enabled());
        orch.set_enabled(true);
        assert!(orch.enabled());
    }

    #[tokio::test]
    async fn proxy_for_direct_returns_none() {
        let orch = make_orch();
        assert!(orch.proxy_for(ProviderKind::Anthropic).is_none());
        assert!(orch.proxy_for(ProviderKind::OpenAI).is_none());
    }

    // --- Mock decision router that errors / times out, to exercise fallback paths ---
    struct ErroringRouter;
    #[async_trait]
    impl DecisionRouter for ErroringRouter {
        fn id(&self) -> &'static str {
            "erroring"
        }
        fn display_name(&self) -> &'static str {
            "Erroring Mock"
        }
        async fn health_check(&self) -> Result<(), RouterError> {
            Err(RouterError::Auth)
        }
        async fn recommend(
            &self,
            _task: &RoutingTask,
            _candidates: &[AgentCandidate],
        ) -> Result<RouterDecision, RouterError> {
            Err(RouterError::Upstream("500".into()))
        }
    }

    #[tokio::test]
    async fn falls_back_to_builtin_on_primary_error() {
        let orch = make_orch();
        // Register and activate the erroring router.
        {
            let mut reg = orch.decision.write();
            reg.register(Arc::new(ErroringRouter));
            reg.set_active("erroring").unwrap();
        }
        let out = orch.route(&task("hi"), &[]).await;
        assert!(out.fallback_used);
        assert_eq!(out.primary_router_id.as_deref(), Some("erroring"));
        assert_eq!(out.decision.agent, AgentKind::Claude); // built-in decided
    }

    // Slow router that holds the call open past the 2s timeout.
    struct SlowRouter {
        calls: AtomicUsize,
    }
    #[async_trait]
    impl DecisionRouter for SlowRouter {
        fn id(&self) -> &'static str {
            "slow"
        }
        fn display_name(&self) -> &'static str {
            "Slow Mock"
        }
        async fn health_check(&self) -> Result<(), RouterError> {
            Ok(())
        }
        async fn recommend(
            &self,
            _task: &RoutingTask,
            _candidates: &[AgentCandidate],
        ) -> Result<RouterDecision, RouterError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            tokio::time::sleep(Duration::from_secs(5)).await;
            Err(RouterError::Internal("should have timed out".into()))
        }
    }

    #[tokio::test(start_paused = true)]
    async fn falls_back_on_timeout() {
        let orch = make_orch();
        let slow = Arc::new(SlowRouter {
            calls: AtomicUsize::new(0),
        });
        {
            let mut reg = orch.decision.write();
            reg.register(slow.clone());
            reg.set_active("slow").unwrap();
        }
        let out = orch.route(&task("hi"), &[]).await;
        assert!(out.fallback_used);
        assert_eq!(out.primary_router_id.as_deref(), Some("slow"));
        assert!(slow.calls.load(Ordering::SeqCst) >= 1);
    }

    #[tokio::test]
    async fn test_router_unknown_id() {
        let orch = make_orch();
        assert!(orch.test_router("nonexistent").await.is_err());
    }

    #[tokio::test]
    async fn test_router_builtin_ok() {
        let orch = make_orch();
        assert_eq!(orch.test_router("builtin").await.ok(), Some(true));
    }

    #[tokio::test]
    async fn test_router_direct_ok() {
        let orch = make_orch();
        assert_eq!(orch.test_router("none-proxy").await.ok(), Some(true));
    }
}
