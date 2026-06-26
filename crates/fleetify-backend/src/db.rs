//! SQLite pool with the original's durability settings (WAL journal,
//! `foreign_keys=ON` for the plugin_enablements ON DELETE CASCADE) plus
//! the faithful schema applied via `migrations/0001_init.sql`.

use std::path::Path;
use std::str::FromStr;
use std::time::Duration;

use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};
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
        .journal_mode(SqliteJournalMode::Wal)
        // WAL+NORMAL is the documented-safe durability combo (no corruption,
        // only the last commit can be lost on power-loss) and halves the
        // fsync cost per commit — critical when ~20 agents each write every
        // ~800 ms. busy_timeout converts a spurious SQLITE_BUSY into a short
        // wait instead of an immediate dropped write under WAL contention.
        .synchronous(SqliteSynchronous::Normal)
        .busy_timeout(Duration::from_secs(5));
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
        .journal_mode(SqliteJournalMode::Wal)
        // See init_pool: WAL+NORMAL + a 5 s busy timeout keep ~20 concurrent
        // agent writers from serializing on fsync or dropping rows on BUSY.
        .synchronous(SqliteSynchronous::Normal)
        .busy_timeout(Duration::from_secs(5));
    finish_pool(opts, false).await
}

async fn finish_pool(opts: SqliteConnectOptions, is_mem: bool) -> anyhow::Result<SqlitePool> {
    let pool = SqlitePoolOptions::new()
        // 5 → 10: under ~20 concurrent agents the read path (session list,
        // /messages, routing) shares this pool with stalled writers; under WAL
        // readers don't need the write lock, so more connections lets reads
        // through instead of queuing behind a busy writer. acquire_timeout
        // turns sqlx's 30 s default hang into a fast, surfaced error.
        .max_connections(if is_mem { 1 } else { 10 })
        .acquire_timeout(Duration::from_secs(10))
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

    #[tokio::test]
    async fn sessions_table_has_sandbox_and_tool_overrides_columns() {
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
            cols.contains(&"sandbox".to_string()),
            "sessions.sandbox missing: {cols:?}"
        );
        assert!(
            cols.contains(&"tool_overrides".to_string()),
            "sessions.tool_overrides missing: {cols:?}"
        );
    }
}
