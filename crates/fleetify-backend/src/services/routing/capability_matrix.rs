//! Capability matrix — what each agent CAN do (tool-use, vision, model tiers).
//! Loaded from `config/agents.toml` by the routing module's agent selector.
//! Distinct from the bridge-launch config in `crates::config::AgentConfig`.

use serde::Deserialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

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
    /// Load the capability matrix from an explicit path.
    pub fn load(path: impl AsRef<Path>) -> std::io::Result<Self> {
        let raw = std::fs::read_to_string(path.as_ref())?;
        toml::from_str(&raw).map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))
    }

    /// Search order parity with `crates::config::AppConfig::load`: cwd then workspace-root.
    /// Returns the first file that exists, or NotFound.
    pub fn load_default() -> std::io::Result<Self> {
        let candidates: Vec<PathBuf> = vec![
            PathBuf::from("config/agents.toml"),
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../config/agents.toml"),
        ];
        for c in &candidates {
            if c.exists() {
                return Self::load(c);
            }
        }
        Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "config/agents.toml not found",
        ))
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
    fn loads_real_agents_toml() {
        // Should find config/agents.toml via load_default's search.
        let m = CapabilityMatrix::load_default().expect("config/agents.toml must be present");
        assert!(m.agents.contains_key("claude-code"), "claude agent missing");
        assert!(m.agents.contains_key("openai"), "openai agent missing");
        assert!(m.agents.contains_key("codex-cli"), "codex agent missing");
        assert!(m.agents["claude-code"].tiers.len() >= 2);
    }
}
