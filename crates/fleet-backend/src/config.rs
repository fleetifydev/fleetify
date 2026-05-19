//! Application config — mirrors the original `backend/app/config.py`
//! (dataclasses + cwd→repo-root `config/default.toml` search order).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::Deserialize;

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
    /// Search order parity with Python: explicit path, else
    /// `config/default.toml` in cwd, else `<workspace-root>/config/default.toml`.
    pub fn load(explicit: Option<&Path>) -> anyhow::Result<Self> {
        let candidates: Vec<PathBuf> = match explicit {
            Some(p) => vec![p.to_path_buf()],
            None => vec![
                PathBuf::from("config/default.toml"),
                PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../config/default.toml"),
            ],
        };
        for c in &candidates {
            if c.exists() {
                let txt = std::fs::read_to_string(c)?;
                return Ok(toml::from_str(&txt)?);
            }
        }
        anyhow::bail!("config/default.toml not found in {candidates:?}")
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
        assert_eq!(c.agents["claude"].command, "claude");
        assert_eq!(
            c.agents["claude"].args,
            vec!["-p", "--output-format", "stream-json", "--verbose"]
        );
        assert!(c.agents["claude"].chat_ui);
        assert!(!c.agents["aider"].chat_ui);
    }
}
