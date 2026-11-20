//! Capability matrix — what each agent CAN do (tool-use, vision, model tiers).
//! Built from `config/agents.toml`, compiled into the binary, for the routing
//! module's agent selector. Distinct from the bridge-launch config in
//! `crates::config::AgentConfig`.

use serde::Deserialize;
use std::collections::HashMap;

/// `config/agents.toml`, built in.
pub const DEFAULT_AGENTS_TOML: &str = include_str!("../../../../../config/agents.toml");

#[derive(Debug, Clone, Deserialize)]
pub struct AgentCapability {
    pub supports_tool_use: bool,
    pub supports_vision: bool,
    pub max_context: usize,
    pub mcp_support: bool,
    #[serde(default)]
    pub acp: bool,
    pub default_model: String,
    pub tiers: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CapabilityMatrix {
    #[serde(default)]
    pub agents: HashMap<String, AgentCapability>,
}

impl CapabilityMatrix {
    /// Parses [`DEFAULT_AGENTS_TOML`]; never touches the filesystem.
    pub fn load_default() -> std::io::Result<Self> {
        toml::from_str(DEFAULT_AGENTS_TOML)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_minimum_matrix() {
        let toml_src = r#"
[agents.claude-code]
supports_tool_use = true
supports_vision = true
max_context = 200000
mcp_support = true
default_model = "claude-sonnet-4-6"
tiers = ["claude-haiku-4-5", "claude-sonnet-4-6", "claude-opus-4-7"]
        "#;
        let m: CapabilityMatrix = toml::from_str(toml_src).unwrap();
        let c = &m.agents["claude-code"];
        assert_eq!(c.tiers.len(), 3);
        assert_eq!(c.max_context, 200000);
        assert!(c.supports_tool_use);
        assert!(!c.acp);
    }

    #[test]
    fn the_built_in_matrix_has_the_core_agents() {
        // The config/agents.toml compiled into the binary parses and has them.
        let m = CapabilityMatrix::load_default().expect("the built-in config/agents.toml parses");
        assert!(m.agents.contains_key("claude-code"), "claude agent missing");
        assert!(m.agents.contains_key("openai"), "openai agent missing");
        assert!(m.agents.contains_key("codex-cli"), "codex agent missing");
        assert!(m.agents["claude-code"].tiers.len() >= 2);
    }
}
