//! PostHog-specific outbox. Parallel to `services/telemetry/outbox.rs`
//! but isolated:
//!   - Separate SQLite file (`<HOME>/.fleetify/posthog-outbox.sqlite`)
//!     so the existing Fleetify cloud outbox is untouched.
//!   - Separate schema (`posthog_events`) — kept narrow so the worker
//!     can drain at batch scale.
//!   - Separate ack semantics: PostHog acks via HTTP 200 from a batch
//!     POST, not WS frames. The worker handles that fan-in.

use std::path::PathBuf;
use std::str::FromStr;
use std::sync::OnceLock;

use anyhow::Result;
use serde_json::Value;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePool, SqlitePoolOptions};

const DDL: &str = "
CREATE TABLE IF NOT EXISTS posthog_events (
    id TEXT PRIMARY KEY,
    payload TEXT NOT NULL,
    enqueued_at INTEGER NOT NULL,
    attempt_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS posthog_events_enqueued_idx
    ON posthog_events (enqueued_at);
";

static POOL: OnceLock<SqlitePool> = OnceLock::new();

fn outbox_path() -> PathBuf {
    fleetify_core::fleetify_home().join("posthog-outbox.sqlite")
}

pub async fn init() -> Result<()> {
    if POOL.get().is_some() {
        return Ok(());
    }
    let dir = fleetify_core::fleetify_home();
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
        .ok_or_else(|| anyhow::anyhow!("posthog outbox not initialised"))
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub async fn enqueue(event_id: &str, payload: &Value) -> Result<()> {
    let blob = serde_json::to_string(payload)?;
    sqlx::query("INSERT OR IGNORE INTO posthog_events (id, payload, enqueued_at) VALUES (?, ?, ?)")
        .bind(event_id)
        .bind(blob)
        .bind(now_ms())
        .execute(pool_or_err()?)
        .await?;
    Ok(())
}

pub async fn peek_pending(limit: i64) -> Result<Vec<(String, Value)>> {
    let rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT id, payload FROM posthog_events \
         ORDER BY enqueued_at ASC, id ASC LIMIT ?",
    )
    .bind(limit)
    .fetch_all(pool_or_err()?)
    .await?;
    rows.into_iter()
        .map(|(id, blob)| Ok((id, serde_json::from_str(&blob)?)))
        .collect()
}

pub async fn mark_acked(event_ids: &[String]) -> Result<()> {
    if event_ids.is_empty() {
        return Ok(());
    }
    // SQLite parameter limit is ~999; batches stay <= 100 so one shot is fine.
    let placeholders = (0..event_ids.len())
        .map(|_| "?")
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!("DELETE FROM posthog_events WHERE id IN ({placeholders})");
    // Safe: only `?` placeholders are formatted in; the ids are bound.
    let mut q = sqlx::query(sqlx::AssertSqlSafe(sql));
    for id in event_ids {
        q = q.bind(id);
    }
    q.execute(pool_or_err()?).await?;
    Ok(())
}

pub async fn bump_attempts(event_ids: &[String]) -> Result<()> {
    if event_ids.is_empty() {
        return Ok(());
    }
    let placeholders = (0..event_ids.len())
        .map(|_| "?")
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "UPDATE posthog_events SET attempt_count = attempt_count + 1 WHERE id IN ({placeholders})"
    );
    // Safe: only `?` placeholders are formatted in; the ids are bound.
    let mut q = sqlx::query(sqlx::AssertSqlSafe(sql));
    for id in event_ids {
        q = q.bind(id);
    }
    q.execute(pool_or_err()?).await?;
    Ok(())
}

/// Drop rows whose attempt_count >= threshold. Worker calls this each
/// drain pass so a permanently-failing batch can't fill the queue.
pub async fn drop_poison(threshold: i64) -> Result<u64> {
    let result = sqlx::query("DELETE FROM posthog_events WHERE attempt_count >= ?")
        .bind(threshold)
        .execute(pool_or_err()?)
        .await?;
    Ok(result.rows_affected())
}

pub async fn count() -> Result<i64> {
    let (n,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM posthog_events")
        .fetch_one(pool_or_err()?)
        .await?;
    Ok(n)
}

pub async fn reset() -> Result<()> {
    sqlx::query("DELETE FROM posthog_events")
        .execute(pool_or_err()?)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tokio::sync::Mutex;

    // Mirrors the pattern from telemetry::outbox::tests — the POOL is a
    // process-wide OnceLock, so concurrent tests must serialise through
    // a tokio Mutex held across awaits.
    static TEST_LOCK: Mutex<()> = Mutex::const_new(());

    async fn ensure_inited() {
        let dir = tempfile::tempdir().unwrap();
        let _ = init_at(dir.path().join("ph.sqlite")).await;
        let _ = reset().await;
        // POOL holds the sqlite file open; leak `dir` so Drop doesn't
        // race the worker.
        std::mem::forget(dir);
    }

    #[tokio::test]
    async fn enqueue_peek_ack_roundtrip() {
        let _g = TEST_LOCK.lock().await;
        ensure_inited().await;
        let _ = reset().await;
        enqueue("evt-1", &json!({ "event": "session_started" }))
            .await
            .unwrap();
        enqueue("evt-2", &json!({ "event": "tokens_used" }))
            .await
            .unwrap();
        // Duplicate id is no-op.
        enqueue("evt-1", &json!({ "event": "session_started" }))
            .await
            .unwrap();
        assert_eq!(count().await.unwrap(), 2);
        let pending = peek_pending(10).await.unwrap();
        assert_eq!(pending.len(), 2);
        mark_acked(&["evt-1".to_string()]).await.unwrap();
        let pending = peek_pending(10).await.unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].0, "evt-2");
    }

    #[tokio::test]
    async fn bump_attempts_and_drop_poison() {
        let _g = TEST_LOCK.lock().await;
        ensure_inited().await;
        let _ = reset().await;
        enqueue("evt-poison", &json!({ "event": "test" }))
            .await
            .unwrap();
        for _ in 0..10 {
            bump_attempts(&["evt-poison".to_string()]).await.unwrap();
        }
        let dropped = drop_poison(10).await.unwrap();
        assert_eq!(dropped, 1);
        assert_eq!(count().await.unwrap(), 0);
    }

    #[tokio::test]
    async fn mark_acked_handles_batch() {
        let _g = TEST_LOCK.lock().await;
        ensure_inited().await;
        let _ = reset().await;
        for i in 0..5 {
            enqueue(&format!("e-{i}"), &json!({ "n": i }))
                .await
                .unwrap();
        }
        assert_eq!(count().await.unwrap(), 5);
        let ids: Vec<String> = (0..5).map(|i| format!("e-{i}")).collect();
        mark_acked(&ids).await.unwrap();
        assert_eq!(count().await.unwrap(), 0);
    }
}
