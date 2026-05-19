use serde::{Deserialize, Serialize};

/// `sessions` row. Mirrors `backend/app/models/session.py::Session` exactly.
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct Session {
    pub id: String,
    pub title: String,
    pub project_path: String,
    pub group_path: String,
    pub tool: String,
    pub command: String,
    pub status: String,
    pub parent_id: Option<String>,
    pub worktree_path: Option<String>,
    pub worktree_branch: Option<String>,
    pub use_worktree: bool,
    pub claude_session_id: Option<String>,
    pub model_name: Option<String>,
    pub permission_mode: String,
    pub session_mode: String,
    pub effort: Option<String>,
    pub user_id: Option<String>,
    pub pinned: bool,
    pub order_idx: i64,
    pub created_at: String,
    pub last_accessed: Option<String>,
    pub notes: Option<String>,
    pub archived_at: Option<String>,
    pub budget_limit: Option<f64>,
    pub budget_used: f64,
    pub agent_template: Option<String>,
    pub compact_summary: Option<String>,
    pub compact_at: Option<String>,
    pub compacted_message_count: Option<i64>,
}

/// POST /api/sessions body. Defaults mirror `SessionCreate` in Python.
#[derive(Debug, Clone, Deserialize)]
pub struct SessionCreate {
    pub title: String,
    #[serde(default)]
    pub project_path: String,
    #[serde(default = "default_tool")]
    pub tool: String,
    #[serde(default)]
    pub group_path: String,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub model_name: Option<String>,
    #[serde(default = "default_perm")]
    pub permission_mode: String,
    #[serde(default = "default_session_mode")]
    pub session_mode: String,
    #[serde(default)]
    pub claude_session_id: Option<String>,
    #[serde(default = "default_true")]
    pub use_worktree: bool,
    #[serde(default)]
    pub agent_template: Option<String>,
}

/// PATCH /api/sessions/{id} body. All optional (partial update).
#[derive(Debug, Clone, Deserialize, Default)]
pub struct SessionUpdate {
    pub title: Option<String>,
    pub group_path: Option<String>,
    pub pinned: Option<bool>,
    pub order_idx: Option<i64>,
    pub notes: Option<String>,
    pub model_name: Option<String>,
    pub permission_mode: Option<String>,
    pub effort: Option<String>,
    pub project_path: Option<String>,
    pub tool: Option<String>,
    pub claude_session_id: Option<String>,
    pub use_worktree: Option<bool>,
}

/// `groups` row. Mirrors `Group` in Python.
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct Group {
    pub path: String,
    pub name: String,
    pub parent_path: Option<String>,
    pub order_idx: i64,
    pub default_path: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct GroupCreate {
    pub path: String,
    pub name: String,
    #[serde(default)]
    pub parent_path: Option<String>,
}

fn default_tool() -> String {
    "claude".into()
}
fn default_perm() -> String {
    "default".into()
}
fn default_session_mode() -> String {
    "new".into()
}
fn default_true() -> bool {
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_create_defaults_match_python() {
        let sc: SessionCreate = serde_json::from_str(r#"{"title":"x"}"#).unwrap();
        assert_eq!(sc.tool, "claude");
        assert_eq!(sc.permission_mode, "default");
        assert_eq!(sc.session_mode, "new");
        assert!(sc.use_worktree);
        assert_eq!(sc.project_path, "");
        assert!(sc.agent_template.is_none());
    }

    #[test]
    fn session_update_is_all_optional() {
        let su: SessionUpdate = serde_json::from_str(r#"{"pinned":true}"#).unwrap();
        assert_eq!(su.pinned, Some(true));
        assert!(su.title.is_none());
    }
}
