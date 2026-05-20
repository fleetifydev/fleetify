//! SQLite pool with the original's durability settings (WAL journal,
//! `foreign_keys=ON` for the plugin_enablements ON DELETE CASCADE) plus
//! the faithful schema applied via `migrations/0001_init.sql`.

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

    let is_mem = url.contains(":memory:");
    let pool = SqlitePoolOptions::new()
        .max_connections(if is_mem { 1 } else { 5 })
        .connect_with(opts)
        .await?;

    sqlx::migrate!("./migrations").run(&pool).await?;
    Ok(pool)
}
