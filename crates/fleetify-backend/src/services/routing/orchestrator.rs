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
    RouterDecision, RouterError, RoutingTask,
};
use crate::services::telemetry::{emit_routing_failure, RoutingFailureKind};

pub struct RoutingOrchestrator {
    decision: Arc<RwLock<DecisionRouterRegistry>>,
    proxy: Arc<RwLock<ProxyGatewayRegistry>>,
    enabled: Arc<RwLock<bool>>,
    timeout_ms: u64,
}

impl RoutingOrchestrator {
    /// Convenience constructor for tests / app-entry-point fallback paths:
    /// builds an orchestrator with an empty BuiltInRouter (capability
    /// matrix with no agents) + DirectGateway. `enabled` flag is the
    /// initial master toggle. The `route()` happy-path falls into the
    /// built-in router's defensive branch for empty pools.
    pub fn with_empty_defaults(enabled: bool) -> Arc<Self> {
        use crate::services::routing::capability_matrix::CapabilityMatrix;
        use crate::services::routing::decision::builtin::BuiltInRouter;
        use crate::services::routing::proxy::direct::DirectGateway;

        let matrix = CapabilityMatrix {
            agents: Default::default(),
        };
        let builtin: Arc<dyn DecisionRouter> = Arc::new(BuiltInRouter::new(matrix));
        let dr = Arc::new(RwLock::new(DecisionRouterRegistry::new(builtin)));
        let direct: Arc<dyn ProxyGateway> = Arc::new(DirectGateway);
        let pr = Arc::new(RwLock::new(ProxyGatewayRegistry::new(direct)));
        Arc::new(Self::new(dr, pr, enabled))
    }
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

        // External primary: race against 2s timeout. Capture the
        // outcome before branching so the fallback arm can map it to a
        // categorised `RoutingFailureKind` for the cloud telemetry event.
        let primary_id = primary.id().to_string();
        let timeout = Duration::from_millis(self.timeout_ms);
        let outcome = tokio::time::timeout(timeout, primary.recommend(task, candidates)).await;

        if let Ok(Ok(d)) = outcome {
            return RouteOutcome {
                decision: d,
                latency_ms: elapsed_ms(started),
                fallback_used: false,
                primary_router_id: Some(primary_id),
            };
        }

        // Fallback path. Categorise the failure for telemetry: the outer
        // `Err(_)` is `tokio::time::Elapsed` (the 2s deadline), while
        // `Ok(Err(RouterError::*))` is the router's own error variant.
        // `RouterError::Timeout` (self-reported) maps to the same
        // `RoutingFailureKind::Timeout` as our deadline, since both look
        // identical from the cloud's perspective. `Internal(_)` is
        // shoved under `Upstream` rather than introducing a new variant
        // — the analytics chart doesn't differentiate, and adding a
        // variant churns the wire format. Day-1 narrow set is fine.
        let (failure_kind, error_message) = match &outcome {
            Err(_) => (
                RoutingFailureKind::Timeout,
                format!("deadline {}ms elapsed", self.timeout_ms),
            ),
            Ok(Err(RouterError::Network(s))) => (RoutingFailureKind::Network, s.clone()),
            Ok(Err(RouterError::Upstream(s))) => (RoutingFailureKind::Upstream, s.clone()),
            Ok(Err(RouterError::InvalidResponse(s))) => {
                (RoutingFailureKind::InvalidResponse, s.clone())
            }
            Ok(Err(RouterError::Auth)) => (RoutingFailureKind::Auth, "auth failed".into()),
            Ok(Err(RouterError::NotConfigured)) => (
                RoutingFailureKind::NotConfigured,
                "router not configured".into(),
            ),
            Ok(Err(RouterError::Timeout(ms))) => (
                RoutingFailureKind::Timeout,
                format!("router self-reported timeout after {ms}ms"),
            ),
            Ok(Err(RouterError::Internal(s))) => {
                (RoutingFailureKind::Upstream, format!("internal: {s}"))
            }
            Ok(Ok(_)) => unreachable!("handled by the early return above"),
        };
        let elapsed = elapsed_ms(started);
        // Fire-and-forget telemetry; the outbox swallows errors when
        // not initialised (NOAUTH mode). `user_visible=false`: Day-1
        // doesn't surface a banner — the fallback is transparent.
        let fallback_to = builtin.id().to_string();
        let primary_for_event = primary_id.clone();
        let error_msg_owned = error_message;
        tokio::spawn(async move {
            let _ = emit_routing_failure(
                &primary_for_event,
                failure_kind,
                Some(&fallback_to),
                false,
                elapsed,
                &error_msg_owned,
                chrono::Utc::now(),
            )
            .await;
        });

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

    /// Resolve `(base_url, extra_headers)` for a provider via the active
    /// proxy gateway. Returns None when the active gateway is DirectGateway.
    pub fn proxy_for(&self, provider: ProviderKind) -> Option<(String, http::HeaderMap)> {
        let g: Arc<dyn ProxyGateway> = self.proxy.read().active();
        let proxy_id = g.id();
        let result = g.base_url(provider).map(|u| (u, g.extra_headers()));
        match &result {
            Some((url, headers)) => {
                let header_names: Vec<&str> = headers.keys().map(|k| k.as_str()).collect();
                tracing::debug!(
                    target: "fleetify::routing::proxy",
                    proxy = proxy_id,
                    provider = ?provider,
                    base_url = %url,
                    headers = ?header_names,
                    "proxy_for: resolved via active gateway"
                );
            }
            None => {
                tracing::debug!(
                    target: "fleetify::routing::proxy",
                    proxy = proxy_id,
                    provider = ?provider,
                    "proxy_for: direct (no proxy gateway)"
                );
            }
        }
        result
    }

    /// Register an external decision router after construction. Used by
    /// the startup hydration path (Task 20) to plug in Not Diamond / Weave
    /// once their credentials are resolved on the Tauri side. Registering
    /// the builtin id is a no-op (the registry refuses to overwrite it).
    pub fn register_decision(&self, r: Arc<dyn DecisionRouter>) {
        self.decision.write().register(r);
    }

    /// Register an external proxy gateway after construction. Mirrors
    /// `register_decision` for the proxy side (Weave / LiteLLM).
    pub fn register_proxy(&self, g: Arc<dyn ProxyGateway>) {
        self.proxy.write().register(g);
    }

    /// Set the active decision router by id. Errors if `id` isn't
    /// registered. Used by startup hydration after `register_decision`.
    pub fn set_active_decision(&self, id: &str) -> Result<(), String> {
        self.decision.write().set_active(id)
    }

    /// Set the active proxy gateway by id. Errors if `id` isn't
    /// registered. Used by startup hydration after `register_proxy`.
    pub fn set_active_proxy(&self, id: &str) -> Result<(), String> {
        self.proxy.write().set_active(id)
    }

    /// Live reload — wipes external registry entries and re-hydrates from
    /// a freshly-built `RoutingSetup`. Triggered by the Tauri IPC layer
    /// whenever the user connects / disconnects / activates a router so
    /// the change takes effect immediately, without an app restart.
    ///
    /// Built-in (decision) and None-Direct (proxy) survive the wipe — the
    /// registries refuse to unregister them, and `reset_to_setup` knows
    /// not to try.
    pub fn reload_from_setup(&self, setup: crate::services::routing::setup::RoutingSetup) {
        use crate::services::routing::decision::notdiamond::NotDiamondRouter;
        use crate::services::routing::decision::weave::WeaveDecisionRouter;
        use crate::services::routing::proxy::litellm::LiteLLMGateway;
        use crate::services::routing::proxy::weave::WeaveProxyGateway;

        const DEFAULT_WEAVE_MANAGED: &str = "https://router.workweave.ai";
        const DEFAULT_LITELLM_LOCAL: &str = "http://localhost:4000";

        // Build the new external registries first (cheap), then swap inside
        // the locks so the registry is never half-populated mid-routing.
        let mut new_decisions: Vec<Arc<dyn DecisionRouter>> = Vec::new();
        let mut new_proxies: Vec<Arc<dyn ProxyGateway>> = Vec::new();

        for (id, cred) in setup.resolved.iter() {
            match id.as_str() {
                "notdiamond" => {
                    new_decisions.push(Arc::new(NotDiamondRouter::new(cred.api_key.clone())));
                }
                "weave" => {
                    let url = cred
                        .base_url
                        .clone()
                        .unwrap_or_else(|| DEFAULT_WEAVE_MANAGED.into());
                    new_decisions.push(Arc::new(WeaveDecisionRouter::with_base_url(
                        cred.api_key.clone(),
                        url.clone(),
                    )));
                    new_proxies.push(Arc::new(WeaveProxyGateway::new(cred.api_key.clone(), url)));
                }
                "litellm" => {
                    let url = cred
                        .base_url
                        .clone()
                        .unwrap_or_else(|| DEFAULT_LITELLM_LOCAL.into());
                    new_proxies.push(Arc::new(LiteLLMGateway::new(cred.api_key.clone(), url)));
                }
                other => {
                    tracing::warn!(target: "fleet-backend", "routing reload: unknown router id {other}");
                }
            }
        }

        // Wipe + re-register decision side. We collect ids first so the
        // borrow checker doesn't choke on `unregister` mutating the map
        // while we iterate it.
        {
            let mut dr = self.decision.write();
            let ids_to_drop: Vec<String> = dr
                .list()
                .into_iter()
                .filter_map(|(id, _name)| if id != "builtin" { Some(id) } else { None })
                .collect();
            for id in ids_to_drop {
                dr.unregister(&id);
            }
            for r in new_decisions {
                dr.register(r);
            }
            if let Err(e) = dr.set_active(&setup.active_decision_router) {
                tracing::warn!(
                    target: "fleet-backend",
                    "routing reload: set_active_decision({}) failed: {e}; falling back to builtin",
                    setup.active_decision_router
                );
                let _ = dr.set_active("builtin");
            }
        }

        // Same for the proxy side, preserving none-proxy.
        {
            let mut pr = self.proxy.write();
            let ids_to_drop: Vec<String> = pr
                .list()
                .into_iter()
                .filter_map(|(id, _name)| if id != "none-proxy" { Some(id) } else { None })
                .collect();
            for id in ids_to_drop {
                pr.unregister(&id);
            }
            for g in new_proxies {
                pr.register(g);
            }
            if let Err(e) = pr.set_active(&setup.active_proxy_gateway) {
                tracing::warn!(
                    target: "fleet-backend",
                    "routing reload: set_active_proxy({}) failed: {e}; falling back to none-proxy",
                    setup.active_proxy_gateway
                );
                let _ = pr.set_active("none-proxy");
            }
        }

        self.set_enabled(setup.enabled);

        tracing::info!(
            target: "fleet-backend",
            enabled = setup.enabled,
            resolved = setup.resolved.len(),
            active_decision = %setup.active_decision_router,
            active_proxy = %setup.active_proxy_gateway,
            "routing: orchestrator reloaded"
        );
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
            AgentKind::Kimi => "kimi-k2-instruct".into(),
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

    #[tokio::test]
    async fn external_router_register_and_activate() {
        use crate::services::routing::decision::notdiamond::NotDiamondRouter;
        let orch = RoutingOrchestrator::with_empty_defaults(true);
        let r = Arc::new(NotDiamondRouter::new("test-key".into()));
        orch.register_decision(r);
        assert!(orch.set_active_decision("notdiamond").is_ok());
        assert!(orch.set_active_decision("does-not-exist-router").is_err());
    }

    #[tokio::test]
    async fn external_proxy_register_and_activate() {
        use crate::services::routing::proxy::litellm::LiteLLMGateway;
        let orch = RoutingOrchestrator::with_empty_defaults(true);
        let g = Arc::new(LiteLLMGateway::new(
            "test-key".into(),
            "http://localhost:4000".into(),
        ));
        orch.register_proxy(g);
        assert!(orch.set_active_proxy("litellm").is_ok());
        assert!(orch.set_active_proxy("does-not-exist-proxy").is_err());
    }

    #[tokio::test]
    async fn reload_from_setup_swaps_external_routers_and_active_selection() {
        use crate::services::routing::setup::{ResolvedRouterCredential, RoutingSetup};
        use std::collections::HashMap;

        let orch = RoutingOrchestrator::with_empty_defaults(false);

        // Start clean: only builtin + none-proxy.
        assert_eq!(orch.decision.read().list().len(), 1);
        assert_eq!(orch.proxy.read().list().len(), 1);

        // Reload with notdiamond registered + weave (decision + proxy) +
        // litellm proxy. Active selections + enabled flag flip too.
        let mut resolved = HashMap::new();
        resolved.insert(
            "notdiamond".into(),
            ResolvedRouterCredential {
                id: "notdiamond".into(),
                api_key: "k1".into(),
                base_url: None,
            },
        );
        resolved.insert(
            "weave".into(),
            ResolvedRouterCredential {
                id: "weave".into(),
                api_key: "k2".into(),
                base_url: Some("https://my-weave.example".into()),
            },
        );
        resolved.insert(
            "litellm".into(),
            ResolvedRouterCredential {
                id: "litellm".into(),
                api_key: "k3".into(),
                base_url: Some("http://localhost:4000".into()),
            },
        );
        let setup = RoutingSetup {
            enabled: true,
            active_decision_router: "notdiamond".into(),
            active_proxy_gateway: "weave".into(),
            resolved,
        };
        orch.reload_from_setup(setup);

        assert!(orch.enabled());
        let dr = orch.decision.read();
        // builtin + notdiamond + weave
        let dec_ids: std::collections::HashSet<String> =
            dr.list().into_iter().map(|(id, _)| id).collect();
        assert!(dec_ids.contains("builtin"));
        assert!(dec_ids.contains("notdiamond"));
        assert!(dec_ids.contains("weave"));
        assert_eq!(dr.active().id(), "notdiamond");
        drop(dr);

        let pr = orch.proxy.read();
        let prx_ids: std::collections::HashSet<String> =
            pr.list().into_iter().map(|(id, _)| id).collect();
        assert!(prx_ids.contains("none-proxy"));
        assert!(prx_ids.contains("weave"));
        assert!(prx_ids.contains("litellm"));
        assert_eq!(pr.active().id(), "weave");
        drop(pr);

        // Reload with empty setup → external routers wiped, active falls
        // back to defaults.
        orch.reload_from_setup(RoutingSetup::default());
        assert!(!orch.enabled());
        let dr = orch.decision.read();
        assert_eq!(dr.list().len(), 1, "only builtin should remain");
        assert_eq!(dr.active().id(), "builtin");
        drop(dr);
        let pr = orch.proxy.read();
        assert_eq!(pr.list().len(), 1, "only none-proxy should remain");
        assert_eq!(pr.active().id(), "none-proxy");
    }

    #[tokio::test]
    async fn reload_with_invalid_active_falls_back_to_builtin() {
        use crate::services::routing::setup::RoutingSetup;
        let orch = RoutingOrchestrator::with_empty_defaults(true);
        let setup = RoutingSetup {
            enabled: true,
            active_decision_router: "ghost-router".into(),
            active_proxy_gateway: "ghost-proxy".into(),
            resolved: Default::default(),
        };
        orch.reload_from_setup(setup);
        assert_eq!(orch.decision.read().active().id(), "builtin");
        assert_eq!(orch.proxy.read().active().id(), "none-proxy");
    }
}
