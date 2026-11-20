//! Application config — mirrors the original `backend/app/config.py`
//! dataclasses. The defaults are `config/default.toml`, compiled into the
//! binary: an installed app's working directory is wherever it was launched
//! from, so no build reads its config from there.

use std::collections::BTreeMap;
use std::path::Path;

use anyhow::Context;
use serde::Deserialize;

/// `config/default.toml`, built in.
pub const DEFAULT_CONFIG_TOML: &str = include_str!("../../../config/default.toml");

#[derive(Debug, Clone, Deserialize)]
pub struct ServerConfig {
    pub host: String,
    pub port: u16,
    #[serde(default)]
    pub reload: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct DatabaseConfig {
    pub path: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct LoggingConfig {
    pub level: String,
    pub format: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AgentConfig {
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub chat_ui: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AppConfig {
    pub server: ServerConfig,
    pub database: DatabaseConfig,
    pub logging: LoggingConfig,
    #[serde(default)]
    pub agents: BTreeMap<String, AgentConfig>,
}

impl AppConfig {
    /// `Some(path)`: read that file. `None`: the built-in defaults
    /// ([`DEFAULT_CONFIG_TOML`]). Never reads the working directory.
    pub fn load(explicit: Option<&Path>) -> anyhow::Result<Self> {
        match explicit {
            Some(path) => {
                let txt = std::fs::read_to_string(path)
                    .with_context(|| format!("reading {}", path.display()))?;
                toml::from_str(&txt).with_context(|| format!("parsing {}", path.display()))
            }
            None => toml::from_str(DEFAULT_CONFIG_TOML).context("parsing the built-in config"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loads_default_toml() {
        let c = AppConfig::load(None).expect("config loads");
        assert_eq!(c.server.host, "127.0.0.1");
        assert_eq!(c.server.port, 8765);
        assert_eq!(c.database.path, "fleet.db");
        assert_eq!(c.agents["claude-code"].command, "claude");
        assert_eq!(
            c.agents["claude-code"].args,
            vec!["-p", "--output-format", "stream-json", "--verbose"]
        );
        assert!(c.agents["claude-code"].chat_ui);
        assert!(!c.agents["aider"].chat_ui);
    }
}
