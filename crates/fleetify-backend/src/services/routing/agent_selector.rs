//! Layer 1 — capability-matched agent ranking.
//! Given a task and the capability matrix, return the AgentCandidate list
//! consumed by Layer 2 (Decision Router) to pick the final agent + model.

use super::capability_matrix::CapabilityMatrix;
use super::traits::{AgentCandidate, AgentKind, RoutingTask};

pub struct AgentSelector {
    matrix: CapabilityMatrix,
}

impl AgentSelector {
    pub fn new(matrix: CapabilityMatrix) -> Self {
        Self { matrix }
    }

    /// Rank candidates from the task's `allowed_agents` against the capability matrix.
    /// First pass: include only agents whose capabilities satisfy task hints
    /// (e.g., tool-use needed when prompt has code blocks or file_count > 0).
    /// If no agents survive the first pass, fall back to "any allowed agent
    /// present in the matrix" so we never return empty unless allowed_agents is
    /// itself empty.
    pub fn rank(&self, task: &RoutingTask) -> Vec<AgentCandidate> {
        let needs_tool_use =
            task.user_prompt.contains("```") || task.workspace_context.file_count.unwrap_or(0) > 0;

        let mut filtered = Vec::new();
        for agent in &task.allowed_agents {
            let key = agent_key(*agent);
            if let Some(cap) = self.matrix.agents.get(key) {
                if needs_tool_use && !cap.supports_tool_use {
                    continue;
                }
                filtered.push(AgentCandidate {
                    agent: *agent,
                    tiers: cap.tiers.clone(),
                });
            }
        }
        if !filtered.is_empty() {
            return filtered;
        }
        // Fallback: any allowed agent that exists in the matrix.
        task.allowed_agents
            .iter()
            .filter_map(|a| {
                self.matrix
                    .agents
                    .get(agent_key(*a))
                    .map(|cap| AgentCandidate {
                        agent: *a,
                        tiers: cap.tiers.clone(),
                    })
            })
            .collect()
    }
}

fn agent_key(a: AgentKind) -> &'static str {
    match a {
        AgentKind::Claude => "claude",
        AgentKind::OpenAI => "openai",
        AgentKind::Gemini => "gemini",
        AgentKind::Codex => "codex",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::routing::traits::{TaskFlow, WorkspaceHints};

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

[agents.openai]
supports_tool_use = true
supports_vision = true
max_context = 128000
mcp_support = false
default_model = "gpt-4o"
tiers = ["gpt-4o-mini", "gpt-4o"]
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

    #[test]
    fn ranks_allowed_agents() {
        let sel = AgentSelector::new(matrix());
        let c = sel.rank(&task("hello", vec![AgentKind::Claude, AgentKind::OpenAI]));
        assert_eq!(c.len(), 2);
        assert_eq!(c[0].tiers.len(), 2);
    }

    #[test]
    fn empty_allowed_returns_empty() {
        let sel = AgentSelector::new(matrix());
        assert!(sel.rank(&task("hello", vec![])).is_empty());
    }

    #[test]
    fn unknown_allowed_agent_dropped() {
        let sel = AgentSelector::new(matrix());
        // Gemini isn't in the test matrix; only claude survives.
        let c = sel.rank(&task("hello", vec![AgentKind::Gemini, AgentKind::Claude]));
        assert_eq!(c.len(), 1);
        assert_eq!(c[0].agent, AgentKind::Claude);
    }

    #[test]
    fn code_block_prompt_keeps_tool_use_agents() {
        let sel = AgentSelector::new(matrix());
        let c = sel.rank(&task(
            "```py\nprint(1)\n```",
            vec![AgentKind::Claude, AgentKind::OpenAI],
        ));
        // Both agents support tool use, both should survive.
        assert_eq!(c.len(), 2);
    }
}
