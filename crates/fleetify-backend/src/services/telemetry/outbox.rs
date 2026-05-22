//! Persistent SQLite-backed outbox for telemetry events. Events survive
//! desktop crashes / restarts — the WebSocket client (when it lands)
//! picks up where the previous run left off, replays unacked events, and
//! the cloud's DeviceDO dedups via `seen_id:<uuid>`.
//!
//! Path: `<HOME>/.fleetify/telemetry-outbox.sqlite`. Created lazily on
//! first use; same directory as device.json.

use std::path::PathBuf;
use std::sync::OnceLock;

use anyhow::Result;
use serde_json::Value;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePool, SqlitePoolOptions};
use std::str::FromStr;

const DDL: &str = "
CREATE TABLE IF NOT EXISTS telemetry_outbox (
    id TEXT PRIMARY KEY,
    payload TEXT NOT NULL,
    enqueued_at INTEGER NOT NULL,
    attempt_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS telemetry_outbox_enqueued_idx
    ON telemetry_outbox (enqueued_at);
";

static POOL: OnceLock<SqlitePool> = OnceLock::new();

fn outbox_dir() -> PathBuf {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| ".".into());
    PathBuf::from(home).join(".fleetify")
}

fn outbox_path() -> PathBuf {
    outbox_dir().join("telemetry-outbox.sqlite")
}

/// Initialise the global pool against the default `<HOME>/.fleetify/…`
/// path. Idempotent. Tests use `init_at()` with a custom path instead.
pub async fn init() -> Result<()> {
    if POOL.get().is_some() {
        return Ok(());
    }
    let dir = outbox_dir();
    std::fs::create_dir_all(&dir).ok();
    init_at(outbox_path()).await
}

pub async fn init_at(path: PathBuf) -> Result<()> {
    if POOL.get().is_some() {
        return Ok(());
    }
    let url = format!("sqlite://{}", path.to_string_lossy().replace('\\', "/"));
    let opts = SqliteConnectOptions::from_str(&url)?
        .create_if_missing(true)
        .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
        .synchronous(sqlx::sqlite::SqliteSynchronous::Normal);
    let pool = SqlitePoolOptions::new()
        .max_connections(2)
        .connect_with(opts)
        .await?;
    sqlx::query(DDL).execute(&pool).await?;
    let _ = POOL.set(pool);
    Ok(())
}

fn pool_or_err() -> Result<&'static SqlitePool> {
    POOL.get()
        .ok_or_else(|| anyhow::anyhow!("telemetry outbox not initialised"))
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Persist a new event. Idempotent on duplicate id (no-op).
pub async fn enqueue(event_id: &str, payload: &Value) -> Result<()> {
    let blob = serde_json::to_string(payload)?;
    sqlx::query(
        "INSERT OR IGNORE INTO telemetry_outbox (id, payload, enqueued_at) VALUES (?, ?, ?)",
    )
    .bind(event_id)
    .bind(blob)
    .bind(now_ms())
    .execute(pool_or_err()?)
    .await?;
    Ok(())
}

/// Read up to `limit` un-acked events in FIFO order. Doesn't mark them —
/// the WS client only deletes via `mark_acked` after a server ack lands.
pub async fn peek_pending(limit: i64) -> Result<Vec<(String, Value)>> {
    let rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT id, payload FROM telemetry_outbox \
         ORDER BY enqueued_at ASC, id ASC LIMIT ?",
    )
    .bind(limit)
    .fetch_all(pool_or_err()?)
    .await?;
    rows.into_iter()
        .map(|(id, blob)| Ok((id, serde_json::from_str(&blob)?)))
        .collect()
}

pub async fn mark_acked(event_id: &str) -> Result<()> {
    sqlx::query("DELETE FROM telemetry_outbox WHERE id = ?")
        .bind(event_id)
        .execute(pool_or_err()?)
        .await?;
    Ok(())
}

pub async fn bump_attempt(event_id: &str) -> Result<i64> {
    let row: Option<(i64,)> = sqlx::query_as(
        "UPDATE telemetry_outbox SET attempt_count = attempt_count + 1 \
         WHERE id = ? RETURNING attempt_count",
    )
    .bind(event_id)
    .fetch_optional(pool_or_err()?)
    .await?;
    Ok(row.map(|(c,)| c).unwrap_or(0))
}

pub async fn count() -> Result<i64> {
    let (n,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM telemetry_outbox")
        .fetch_one(pool_or_err()?)
        .await?;
    Ok(n)
}

/// Drop everything. Tests + diagnostics ONLY — losing the outbox loses
/// unacked events.
pub async fn reset() -> Result<()> {
    sqlx::query("DELETE FROM telemetry_outbox")
        .execute(pool_or_err()?)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // Each test must use its OWN sqlite file because POOL is a process-
    // wide OnceLock — once initialised, subsequent init_at() calls are
    // no-ops. We initialise in the first test that runs (via
    // ensure_inited) and then mutate via the public API.
    async fn ensure_inited() {
        let dir = tempfile::tempdir().unwrap();
        let _ = init_at(dir.path().join("ob.sqlite")).await;
        let _ = reset().await;
        // dir drops at end of scope but SQLite holds the file open via
        // the pool; the path stays valid until process exit, which is
        // fine for the test run.
        std::mem::forget(dir);
    }

    #[tokio::test]
    async fn enqueue_peek_ack_roundtrip() {
        ensure_inited().await;
        let _ = reset().await;
        enqueue("evt-1", &json!({ "kind": "session_start", "id": "s1" }))
            .await
            .unwrap();
        enqueue("evt-2", &json!({ "kind": "cost", "id": "s1" }))
            .await
            .unwrap();
        // Duplicate id is a no-op.
        enqueue("evt-1", &json!({ "kind": "session_start", "id": "s1" }))
            .await
            .unwrap();

        let n = count().await.unwrap();
        assert_eq!(n, 2);

        let pending = peek_pending(10).await.unwrap();
        assert_eq!(pending.len(), 2);
        assert_eq!(pending[0].0, "evt-1");
        assert_eq!(pending[0].1["kind"], "session_start");

        mark_acked("evt-1").await.unwrap();
        let pending = peek_pending(10).await.unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].0, "evt-2");
    }

    #[tokio::test]
    async fn bump_attempt_increments_per_event() {
        ensure_inited().await;
        let _ = reset().await;
        enqueue("evt-x", &json!({ "kind": "heartbeat" }))
            .await
            .unwrap();
        let a = bump_attempt("evt-x").await.unwrap();
        let b = bump_attempt("evt-x").await.unwrap();
        assert_eq!(a, 1);
        assert_eq!(b, 2);
    }
}
