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
    pub sandbox: Option<String>,
    pub tool_overrides: Option<String>,
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
    /// Which provider/agent account this session uses. NULL ⇒ the synthetic
    /// System account (real HOME for CLI / legacy keychain key for HTTP).
    pub account_id: Option<String>,
    /// Free-text session rules, materialized as a marked block into the
    /// session's working-directory rule file for its provider. NULL ⇒ none.
    pub session_rules: Option<String>,
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
    #[serde(default)]
    pub account_id: Option<String>,
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
    pub sandbox: Option<String>,
    pub tool_overrides: Option<String>,
    pub project_path: Option<String>,
    pub tool: Option<String>,
    pub claude_session_id: Option<String>,
    pub use_worktree: Option<bool>,
    pub account_id: Option<String>,
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
    "claude-code".into()
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
        assert_eq!(sc.tool, "claude-code");
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

    /// Round-trip: create a session row, PATCH sandbox + tool_overrides via
    /// raw SQL (mirrors the `set!` macro in routers/sessions.rs), then
    /// re-read with `SELECT *` + `FromRow` and assert the values persisted.
    #[tokio::test]
    async fn sandbox_and_tool_overrides_round_trip() {
        let pool = crate::db::init_pool("sqlite::memory:")
            .await
            .expect("open in-memory db");

        // Insert a minimal session row (mirrors the session_migrations helper).
        let id = "test-sandbox-rt-01";
        sqlx::query(
            "INSERT INTO sessions \
             (id,title,project_path,group_path,tool,command,status,use_worktree,\
              permission_mode,session_mode,pinned,order_idx,created_at,budget_used) \
             VALUES (?,?,'','','claude-code','claude-code','idle',1,'default','new',0,0,\
                     '2026-01-01T00:00:00Z',0.0)",
        )
        .bind(id)
        .bind("Sandbox RT session")
        .execute(&pool)
        .await
        .expect("insert session row");

        // Verify both columns default to NULL.
        let before = sqlx::query_as::<_, Session>("SELECT * FROM sessions WHERE id = ?")
            .bind(id)
            .fetch_one(&pool)
            .await
            .expect("fetch before patch");
        assert!(before.sandbox.is_none(), "sandbox should start NULL");
        assert!(
            before.tool_overrides.is_none(),
            "tool_overrides should start NULL"
        );

        // PATCH sandbox.
        sqlx::query("UPDATE sessions SET sandbox = ? WHERE id = ?")
            .bind("docker")
            .bind(id)
            .execute(&pool)
            .await
            .expect("patch sandbox");

        // PATCH tool_overrides.
        let matrix = r#"{"bash":{"allow":true},"edit":{"allow":false}}"#;
        sqlx::query("UPDATE sessions SET tool_overrides = ? WHERE id = ?")
            .bind(matrix)
            .bind(id)
            .execute(&pool)
            .await
            .expect("patch tool_overrides");

        // Re-read and assert.
        let after = sqlx::query_as::<_, Session>("SELECT * FROM sessions WHERE id = ?")
            .bind(id)
            .fetch_one(&pool)
            .await
            .expect("fetch after patch");
        assert_eq!(after.sandbox.as_deref(), Some("docker"));
        assert_eq!(after.tool_overrides.as_deref(), Some(matrix));
    }
}
