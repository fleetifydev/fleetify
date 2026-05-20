//! Embedded Fleetify backend (FastAPI 1:1). `serve()` builds config + the
//! sqlx pool + JWKS auth + the SessionManager, runs the lifespan stale-reset,
//! then binds an axum server on a background tokio task; the Tauri shell
//! calls it from its setup hook.

mod http;

pub mod auth;
pub mod bridges;
pub mod config;
pub mod db;
pub mod models;
pub mod routers;
pub mod services;
pub mod session_manager;
#[cfg(test)]
pub mod test_support;

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use tokio::net::TcpListener;
use tokio::sync::oneshot;

pub use http::app;

pub struct ServerHandle {
    local_addr: SocketAddr,
    shutdown_tx: Option<oneshot::Sender<()>>,
}

impl ServerHandle {
    pub fn local_addr(&self) -> SocketAddr {
        self.local_addr
    }
    /// Trigger graceful shutdown (mirrors FastAPI lifespan teardown).
    pub fn shutdown(mut self) {
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(());
        }
    }
}

/// Lifespan parity with `_reset_stale_session_state`: error sessions →
/// idle + cleared resume id; transient states → idle (no bridge alive at boot).
async fn reset_stale_session_state(pool: &sqlx::SqlitePool) {
    let _ = sqlx::query(
        "UPDATE sessions SET claude_session_id = NULL, status = 'idle' WHERE status = 'error'",
    )
    .execute(pool)
    .await;
    let _ = sqlx::query(
        "UPDATE sessions SET status = 'idle' \
         WHERE status IN ('running','compacting','starting','waiting')",
    )
    .execute(pool)
    .await;
}

/// Bind `addr` and start serving on a background task. `static_dir` is the
/// built React asset directory for single-origin serving (`None` = API only).
pub async fn serve(
    addr: SocketAddr,
    static_dir: Option<PathBuf>,
) -> anyhow::Result<ServerHandle> {
    // Lifespan parity: one-shot ~/.fleet → ~/.fleetify migration.
    services::migration::migrate_fleet_to_fleetify();

    let cfg = config::AppConfig::load(None)?;
    // App: file-backed `fleet.db`; tests set FLEET_DB_URL=sqlite::memory:.
    let db_url = std::env::var("FLEET_DB_URL")
        .unwrap_or_else(|_| format!("sqlite://{}?mode=rwc", cfg.database.path));
    let pool = db::init_pool(&db_url).await?;
    reset_stale_session_state(&pool).await;

    let auth_cfg = Arc::new(auth::AuthConfig::from_env());
    let jwks = auth::default_jwks_cache(&auth_cfg.jwks_url);
    let state = routers::AppState {
        auth: auth::AuthState { pool, cfg: auth_cfg, jwks },
        app_cfg: Arc::new(cfg),
        sm: session_manager::session_manager(),
    };

    let listener = TcpListener::bind(addr).await?;
    let local_addr = listener.local_addr()?;
    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();

    let router = app(state, static_dir);
    tokio::spawn(async move {
        let server = axum::serve(listener, router).with_graceful_shutdown(async {
            let _ = shutdown_rx.await;
        });
        if let Err(e) = server.await {
            tracing::error!("fleet-backend server error: {e}");
        }
    });

    // Telemetry pipeline — outbox init + heartbeat loop. Best-effort:
    // a failed outbox init logs and continues so a busted home dir
    // doesn't kill the backend; emit_* sites will see "telemetry outbox
    // not initialised" and skip enqueue gracefully.
    if let Err(e) = services::telemetry::outbox::init().await {
        tracing::warn!("telemetry: outbox init failed: {e} (telemetry disabled)");
    } else {
        tokio::spawn(services::telemetry::run_heartbeat_loop());
    }

    // Ensure the 3 Fleet stdio MCP servers (fleet-memory-mcp /
    // fleet-dispatch-mcp / fleet-reveng-mcp) are registered in
    // ~/.fleetify/mcp_servers.json. Idempotent — user-customised
    // entries are preserved. Skipped quietly when running with
    // FLEET_DB_URL=sqlite::memory: (test env) to keep tests
    // hermetic.
    if std::env::var("FLEET_DB_URL")
        .ok()
        .as_deref()
        .unwrap_or("")
        .ne("sqlite::memory:")
    {
        services::mcp_registry::ensure_fleet_builtins();
    }

    tracing::info!("fleet-backend listening on http://{local_addr}");
    Ok(ServerHandle {
        local_addr,
        shutdown_tx: Some(shutdown_tx),
    })
}
