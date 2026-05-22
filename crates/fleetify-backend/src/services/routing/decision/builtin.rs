//! Built-in DecisionRouter — offline, deterministic, capability-matrix based.
//! Contract: NEVER returns Err. Worst case it returns the user's first
//! allowed agent at its default tier. Acts as the universal fallback for
//! every other DecisionRouter (see Task 9 orchestrator).

use async_trait::async_trait;

use crate::services::routing::agent_selector::AgentSelector;
use crate::services::routing::capability_matrix::CapabilityMatrix;
use crate::services::routing::intent::IntentClassifier;
use crate::services::routing::traits::{
    AgentCandidate, ComplexityHint, DecisionRouter, DecisionSource, RouterDecision, RouterError,
    RoutingTask,
};

pub struct BuiltInRouter {
    selector: AgentSelector,
    classifier: IntentClassifier,
}

impl BuiltInRouter {
    pub fn new(matrix: CapabilityMatrix) -> Self {
        Self {
            selector: AgentSelector::new(matrix),
            classifier: IntentClassifier,
        }
    }

    fn tier_for(complexity: ComplexityHint, tiers: &[String]) -> String {
        if tiers.is_empty() {
            return String::new();
        }
        match complexity {
            ComplexityHint::Trivial | ComplexityHint::Simple => tiers[0].clone(),
            ComplexityHint::Medium => {
                let mid = tiers.len() / 2;
                tiers.get(mid).cloned().unwrap_or_else(|| tiers[0].clone())
            }
            ComplexityHint::Complex => tiers.last().cloned().unwrap_or_else(|| tiers[0].clone()),
        }
    }
}

#[async_trait]
impl DecisionRouter for BuiltInRouter {
    fn id(&self) -> &'static str {
        "builtin"
    }
    fn display_name(&self) -> &'static str {
        "Built-in (Fleetify)"
    }

    async fn health_check(&self) -> Result<(), RouterError> {
        Ok(())
    }

    async fn recommend(
        &self,
        task: &RoutingTask,
        candidates: &[AgentCandidate],
    ) -> Result<RouterDecision, RouterError> {
        let complexity = self.classifier.classify(task);
        // Use upstream-provided candidates if non-empty, otherwise rank ourselves.
        let pool: Vec<AgentCandidate> = if candidates.is_empty() {
            self.selector.rank(task)
        } else {
            candidates.to_vec()
        };

        // Pick the first candidate; if pool is empty we have to fall back further.
        let Some(pick) = pool.first().cloned() else {
            // Last-resort defensive fallback: synthesise a decision from the first
            // allowed agent at no model (caller still gets something, never an Err).
            let agent = task.allowed_agents.first().copied().ok_or_else(|| {
                RouterError::Internal("no allowed agents and no candidates".into())
            })?;
            return Ok(RouterDecision {
                agent,
                model: String::new(),
                rationale: "builtin: no matrix entry — using allowed-agent fallback".into(),
                source: DecisionSource::BuiltIn,
                fallback_chain: vec![],
            });
        };

        let model = Self::tier_for(complexity, &pick.tiers);

        // Fallback chain: other tiers of the same agent first, then siblings.
        let mut fallback: Vec<(crate::services::routing::traits::AgentKind, String)> = Vec::new();
        for t in &pick.tiers {
            if *t != model {
                fallback.push((pick.agent, t.clone()));
            }
        }
        for other in pool.iter().skip(1) {
            if let Some(t) = other.tiers.first() {
                fallback.push((other.agent, t.clone()));
            }
        }

        Ok(RouterDecision {
            agent: pick.agent,
            model,
            rationale: format!("builtin: complexity={complexity:?}, agent={:?}", pick.agent),
            source: DecisionSource::BuiltIn,
            fallback_chain: fallback,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::routing::capability_matrix::CapabilityMatrix;
    use crate::services::routing::traits::{AgentKind, TaskFlow, WorkspaceHints};

    fn matrix() -> CapabilityMatrix {
        toml::from_str(
            r#"
[agents.claude]
supports_tool_use = true
supports_vision = true
max_context = 200000
mcp_support = true
default_model = "claude-sonnet-4-6"
tiers = ["claude-haiku-4-5", "claude-sonnet-4-6", "claude-opus-4-7"]
        "#,
        )
        .unwrap()
    }

    fn task(prompt: &str, allowed: Vec<AgentKind>) -> RoutingTask {
        RoutingTask {
            flow: TaskFlow::Chat {
                session_id: "s".into(),
            },
            user_prompt: prompt.into(),
            conversation_history: None,
            workspace_context: WorkspaceHints::default(),
            user_hint: None,
            allowed_agents: allowed,
            budget_remaining: None,
        }
    }

    #[tokio::test]
    async fn recommends_with_fallback_chain() {
        let r = BuiltInRouter::new(matrix());
        let d = r
            .recommend(&task("Refactor this module", vec![AgentKind::Claude]), &[])
            .await
            .unwrap();
        assert_eq!(d.agent, AgentKind::Claude);
        assert!(d.model.starts_with("claude-"));
        assert_eq!(d.source, DecisionSource::BuiltIn);
        // complex keyword -> Complex -> opus (last tier); fallback has Haiku + Sonnet remaining
        assert_eq!(d.model, "claude-opus-4-7");
        assert!(d
            .fallback_chain
            .iter()
            .any(|(_, m)| m == "claude-haiku-4-5"));
        assert!(d
            .fallback_chain
            .iter()
            .any(|(_, m)| m == "claude-sonnet-4-6"));
    }

    #[tokio::test]
    async fn trivial_picks_lowest_tier() {
        let r = BuiltInRouter::new(matrix());
        let d = r
            .recommend(&task("rename foo to bar", vec![AgentKind::Claude]), &[])
            .await
            .unwrap();
        assert_eq!(d.model, "claude-haiku-4-5");
    }

    #[tokio::test]
    async fn medium_picks_middle_tier() {
        let r = BuiltInRouter::new(matrix());
        // ~25 words → Medium bucket per intent classifier
        let prompt: String = std::iter::repeat("word ").take(25).collect();
        let d = r
            .recommend(&task(&prompt, vec![AgentKind::Claude]), &[])
            .await
            .unwrap();
        assert_eq!(d.model, "claude-sonnet-4-6");
    }

    #[tokio::test]
    async fn upstream_candidates_used_when_provided() {
        let r = BuiltInRouter::new(matrix());
        let upstream = vec![AgentCandidate {
            agent: AgentKind::Claude,
            tiers: vec!["claude-sonnet-4-6".into()],
        }];
        let d = r
            .recommend(&task("hi", vec![AgentKind::Claude]), &upstream)
            .await
            .unwrap();
        // With Simple complexity (<20 words, no keyword), tier_for picks index 0 = the only tier
        assert_eq!(d.model, "claude-sonnet-4-6");
        // No additional tiers means no same-agent fallback options
        assert!(d.fallback_chain.is_empty());
    }

    #[tokio::test]
    async fn never_errors_on_empty_matrix() {
        let empty: CapabilityMatrix = toml::from_str("").unwrap();
        let r = BuiltInRouter::new(empty);
        // Task has allowed_agents but matrix is empty -> the defensive fallback branch
        let d = r
            .recommend(&task("hi", vec![AgentKind::Claude]), &[])
            .await
            .unwrap();
        assert_eq!(d.agent, AgentKind::Claude);
        assert_eq!(d.model, "");
        assert_eq!(d.source, DecisionSource::BuiltIn);
    }

    #[tokio::test]
    async fn health_check_always_ok() {
        let r = BuiltInRouter::new(matrix());
        assert!(r.health_check().await.is_ok());
    }

    #[test]
    fn id_and_display_name() {
        let r = BuiltInRouter::new(matrix());
        assert_eq!(r.id(), "builtin");
        assert_eq!(r.display_name(), "Built-in (Fleetify)");
    }
}
