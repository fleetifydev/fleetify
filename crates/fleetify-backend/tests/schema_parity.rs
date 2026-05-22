//! Asserts the sqlx-created schema is faithful to the original SQLModel
//! schema: all 9 tables, every `sessions` column (incl. the ALTER-added
//! ones), and `foreign_keys=ON`.

use sqlx::Row;

#[tokio::test]
async fn schema_has_all_tables_and_key_columns() {
    let pool = fleetify_backend::db::init_pool("sqlite::memory:")
        .await
        .expect("init pool");

    let tables: Vec<String> = sqlx::query(
        "SELECT name FROM sqlite_master WHERE type='table' \
         AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_sqlx_%'",
    )
    .fetch_all(&pool)
    .await
    .unwrap()
    .into_iter()
    .map(|r| r.get::<String, _>("name"))
    .collect();

    for t in [
        "sessions",
        "groups",
        "messages",
        "cost_events",
        "session_activity",
        "session_memory",
        "users",
        "marketplace_sources",
        "plugin_installs",
        "plugin_enablements",
    ] {
        assert!(
            tables.contains(&t.to_string()),
            "missing table {t}; have {tables:?}"
        );
    }

    let cols: Vec<String> = sqlx::query("PRAGMA table_info(sessions)")
        .fetch_all(&pool)
        .await
        .unwrap()
        .into_iter()
        .map(|r| r.get::<String, _>("name"))
        .collect();

    for c in [
        "id",
        "title",
        "project_path",
        "group_path",
        "tool",
        "command",
        "status",
        "parent_id",
        "worktree_path",
        "worktree_branch",
        "use_worktree",
        "claude_session_id",
        "model_name",
        "permission_mode",
        "session_mode",
        "effort",
        "user_id",
        "pinned",
        "order_idx",
        "created_at",
        "last_accessed",
        "notes",
        "archived_at",
        "budget_limit",
        "budget_used",
        "agent_template",
        "compact_summary",
        "compact_at",
        "compacted_message_count",
    ] {
        assert!(
            cols.contains(&c.to_string()),
            "sessions missing column {c}; have {cols:?}"
        );
    }

    let fk: i64 = sqlx::query("PRAGMA foreign_keys")
        .fetch_one(&pool)
        .await
        .unwrap()
        .get(0);
    assert_eq!(fk, 1, "foreign_keys must be ON");
}
