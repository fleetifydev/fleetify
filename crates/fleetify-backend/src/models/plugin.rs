use serde::{Deserialize, Serialize};

/// `marketplace_sources` row — user-added catalog sources. Mirrors
/// `backend/app/models/plugin.py::MarketplaceSource`.
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct MarketplaceSource {
    pub id: String,
    pub user_id: String,
    pub name: String,
    pub description: Option<String>,
    pub repo_url: String,
    pub is_official: bool,
    pub enabled: bool,
    pub added_at: String,
}

/// `plugin_installs` row — one per (user, plugin_name) on disk.
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct PluginInstall {
    pub id: String,
    pub user_id: String,
    pub source_id: String,
    pub plugin_name: String,
    pub version: String,
    pub commit_sha: String,
    pub install_path: String,
    pub manifest_json: String,
    pub auto_update: bool,
    pub master_enabled: bool,
    pub installed_at: String,
    pub last_updated_at: Option<String>,
}

/// `plugin_enablements` row — activates a plugin for one scope
/// (user / project / agent). ON DELETE CASCADE from plugin_installs.
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct PluginEnablement {
    pub id: String,
    pub install_id: String,
    pub scope_type: String,
    pub scope_id: Option<String>,
    pub enabled: bool,
    pub created_at: String,
}
