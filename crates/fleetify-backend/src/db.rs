//! SQLite pool with the original's durability settings (WAL journal,
//! `foreign_keys=ON` for the plugin_enablements ON DELETE CASCADE) plus
//! the faithful schema applied via `migrations/0001_init.sql`.

use std::path::Path;
use std::str::FromStr;

use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
use sqlx::SqlitePool;

/// Open the pool and run migrations. `url` is e.g. `sqlite::memory:`
/// (tests) or `sqlite://fleet.db` (app).
///
/// In-memory note: sqlx gives each pooled connection its *own* `:memory:`
/// database, so a multi-connection pool would not see the migrated schema.
/// We pin in-memory pools to a single connection so the schema persists for
/// the pool's lifetime (file-backed pools keep the original's 5).
pub async fn init_pool(url: &str) -> anyhow::Result<SqlitePool> {
    let opts = SqliteConnectOptions::from_str(url)?
        .create_if_missing(true)
        .foreign_keys(true)
        .journal_mode(SqliteJournalMode::Wal);
    finish_pool(opts, url.contains(":memory:")).await
}

/// Open the file-backed pool from a filesystem path. Prefer this over
/// [`init_pool`] for the app DB: building a `sqlite://` URL from an absolute
/// Windows path (`C:\Users\…`) is fragile — the `:` after the drive letter
/// confuses the URL parser — whereas `SqliteConnectOptions::filename` takes the
/// path verbatim. Creates the parent dir so a fresh FLEETIFY_HOME works.
pub async fn init_pool_at(path: &Path) -> anyhow::Result<SqlitePool> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let opts = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(true)
        .foreign_keys(true)
        .journal_mode(SqliteJournalMode::Wal);
    finish_pool(opts, false).await
}

async fn finish_pool(opts: SqliteConnectOptions, is_mem: bool) -> anyhow::Result<SqlitePool> {
    let pool = SqlitePoolOptions::new()
        .max_connections(if is_mem { 1 } else { 5 })
        .connect_with(opts)
        .await?;

    sqlx::migrate!("./migrations").run(&pool).await?;
    Ok(pool)
}

#[cfg(test)]
mod migration_tests {
    use super::*;
    use sqlx::Row;

    #[tokio::test]
    async fn routing_decisions_table_exists_after_migration() {
        let pool = init_pool("sqlite::memory:")
            .await
            .expect("open in-memory db");
        let row = sqlx::query(
            "SELECT COUNT(*) AS cnt FROM sqlite_master \
             WHERE type='table' AND name='routing_decisions'",
        )
        .fetch_one(&pool)
        .await
        .expect("query routing_decisions table");
        let count: i64 = row.try_get("cnt").expect("get cnt");
        assert_eq!(count, 1, "routing_decisions table should exist");
    }

    #[tokio::test]
    async fn sessions_table_has_pinning_columns() {
        let pool = init_pool("sqlite::memory:")
            .await
            .expect("open in-memory db");
        let rows = sqlx::query("PRAGMA table_info(sessions)")
            .fetch_all(&pool)
            .await
            .expect("table_info(sessions)");
        let cols: Vec<String> = rows
            .iter()
            .map(|r| r.try_get::<String, _>("name").unwrap())
            .collect();
        assert!(
            cols.contains(&"pinned_agent".to_string()),
            "sessions.pinned_agent missing: {cols:?}"
        );
        assert!(
            cols.contains(&"pinned_model".to_string()),
            "sessions.pinned_model missing: {cols:?}"
        );
        assert!(
            cols.contains(&"routing_decision_id".to_string()),
            "sessions.routing_decision_id missing: {cols:?}"
        );
    }
}
