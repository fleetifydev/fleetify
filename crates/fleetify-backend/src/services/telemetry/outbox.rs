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
    fleetify_core::fleetify_home()
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

    // One-time self-heal: an earlier build enqueued `routing_decision`,
    // `routing_failure`, and `router_health_change` events into the
    // outbox even though the cloud ingest schema doesn't accept those
    // kinds yet. Those events get NACK'd on every flush forever, which
    // both spams the logs and prevents legitimate events ahead of them
    // from being acked promptly. Drop them at startup so the user
    // doesn't have to manually wipe the SQLite file.
    let dropped = sqlx::query(
        "DELETE FROM telemetry_outbox \
         WHERE json_extract(payload, '$.kind') IN \
           ('routing_decision', 'routing_failure', 'router_health_change')",
    )
    .execute(&pool)
    .await
    .map(|r| r.rows_affected())
    .unwrap_or(0);
    if dropped > 0 {
        tracing::info!(
            target: "fleetify.telemetry",
            dropped,
            "outbox: pruned legacy routing_* events not accepted by cloud schema"
        );
    }

    let _ = POOL.set(pool);
    Ok(())
}

/// Whether `init()` / `init_at()` has opened the pool. False in no-auth
/// dev mode and after a failed init; nothing can be queued then.
pub(crate) fn is_initialised() -> bool {
    POOL.get().is_some()
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

/// Drop every queued event, unacked ones included. Serves opt-out:
/// turning cloud sync off (`set_cloud_enabled(false)`) calls this so
/// nothing stays queued to be sent later. Tests and diagnostics use it
/// too. Anywhere else, losing the outbox loses unacked events.
pub async fn reset() -> Result<()> {
    sqlx::query("DELETE FROM telemetry_outbox")
        .execute(pool_or_err()?)
        .await?;
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use serde_json::json;
    use tokio::sync::Mutex;

    // Every telemetry test that touches the process-wide
    // OnceLock<SqlitePool> or the cloud-sync gate takes this one lock:
    // the tests here, the emitter tests and the gate / WS-loop tests.
    // cargo test runs #[tokio::test] cases in parallel by default, so a
    // sibling test calling `reset()` or flipping the gate mid-roundtrip
    // would wipe the events this test just enqueued, or let them in when
    // it expects them kept out, and assertions would race. Serialise them
    // through a tokio Mutex (held across awaits) — cheaper than a
    // per-test pool, and these tests run in well under a second.
    pub(crate) static TEST_LOCK: Mutex<()> = Mutex::const_new(());

    // Each test must use its OWN sqlite file because POOL is a process-
    // wide OnceLock — once initialised, subsequent init_at() calls are
    // no-ops. We initialise in the first test that runs (via
    // ensure_inited) and then mutate via the public API.
    pub(crate) async fn ensure_inited() {
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
        let _g = TEST_LOCK.lock().await;
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
        let _g = TEST_LOCK.lock().await;
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
