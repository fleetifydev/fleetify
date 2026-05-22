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

/// One-shot back-fix for Windows `\\?\`-prefixed `project_path` rows
/// stored before fleet-core's `strip_verbatim_prefix` landed at the
/// `canonicalize` sites. Without this, gemini-cli's ACP rejects the
/// session/new with `-32603 EISDIR` because lstat treats `\\?\C:\…`
/// as a path with `C:` as its leaf component. No-op on non-Windows
/// targets and on pools that don't have any verbatim-prefixed rows.
async fn normalize_legacy_verbatim_project_paths(pool: &sqlx::SqlitePool) {
    #[cfg(windows)]
    {
        let rows: Vec<(String, String)> = sqlx::query_as(
            "SELECT id, project_path FROM sessions WHERE project_path LIKE '\\\\?\\%'",
        )
        .fetch_all(pool)
        .await
        .unwrap_or_default();
        for (id, raw) in rows {
            let stripped = fleetify_core::strip_verbatim_prefix(std::path::Path::new(&raw))
                .to_string_lossy()
                .into_owned();
            if stripped != raw {
                tracing::info!(
                    target: "fleet-backend",
                    session_id = %id,
                    from = %raw,
                    to = %stripped,
                    "normalizing legacy verbatim project_path"
                );
                let _ = sqlx::query("UPDATE sessions SET project_path = ? WHERE id = ?")
                    .bind(&stripped)
                    .bind(&id)
                    .execute(pool)
                    .await;
            }
        }
    }
    #[cfg(not(windows))]
    {
        let _ = pool;
    }
}

/// Bind `addr` and start serving on a background task. `static_dir` is the
/// built React asset directory for single-origin serving (`None` = API only).
pub async fn serve(addr: SocketAddr, static_dir: Option<PathBuf>) -> anyhow::Result<ServerHandle> {
    // Lifespan parity: one-shot ~/.fleet → ~/.fleetify migration.
    services::migration::migrate_fleet_to_fleetify();

    let cfg = config::AppConfig::load(None)?;
    // App: file-backed `fleet.db`; tests set FLEET_DB_URL=sqlite::memory:.
    let db_url = std::env::var("FLEET_DB_URL")
        .unwrap_or_else(|_| format!("sqlite://{}?mode=rwc", cfg.database.path));
    let pool = db::init_pool(&db_url).await?;
    reset_stale_session_state(&pool).await;
    normalize_legacy_verbatim_project_paths(&pool).await;

    let auth_cfg = Arc::new(auth::AuthConfig::from_env());
    let jwks = auth::default_jwks_cache(&auth_cfg.jwks_url);
    // One-shot loopback secret for the internal dispatch endpoint.
    // 32 random bytes, hex-encoded — small enough to fit in an env
    // var and large enough to make brute-force probing pointless.
    // Stored in process memory only; child MCPs receive it through
    // the env passthrough in ClaudeBridge::build_mcp_config.
    let internal_secret = {
        use rand::RngCore;
        let mut bytes = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut bytes);
        let mut s = String::with_capacity(64);
        for b in bytes {
            use std::fmt::Write;
            let _ = write!(&mut s, "{b:02x}");
        }
        Arc::new(s)
    };
    let state = routers::AppState {
        auth: auth::AuthState {
            pool,
            cfg: auth_cfg,
            jwks,
        },
        app_cfg: Arc::new(cfg),
        sm: session_manager::session_manager(),
        internal_secret: internal_secret.clone(),
        permission_registry: Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new())),
    };
    // Surface the secret + backend URL through env so MCP processes
    // spawned later (by ClaudeBridge::build_mcp_config) can read them
    // without us having to plumb AppState all the way down.
    std::env::set_var("FLEETIFY_INTERNAL_SECRET", internal_secret.as_str());

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
    //
    // FLEETIFY_NOAUTH=1 skips the heartbeat loop entirely — emit_* is
    // also short-circuited so the outbox stays empty.
    if crate::auth::is_no_auth() {
        tracing::info!("telemetry: disabled (FLEETIFY_NOAUTH=1)");
    } else if let Err(e) = services::telemetry::outbox::init().await {
        tracing::warn!("telemetry: outbox init failed: {e} (telemetry disabled)");
    } else {
        tokio::spawn(services::telemetry::run_heartbeat_loop());
    }

    // Fleet built-in MCP servers (fleet_memory / fleet_dispatch /
    // fleet_reveng) are NOT seeded into ~/.fleetify/mcp_servers.json.
    // ClaudeBridge::builtin_mcp_config splices them into the per-spawn
    // --mcp-config JSON instead, so the user-facing /api/mcp/servers
    // list shows ONLY the MCPs the user explicitly added — matching
    // the Python sdk_bridge.py behaviour where builtins live in-process
    // and never appear in the persisted registry. One-shot migration
    // strips stale `builtin: true` rows from registries written by
    // older builds so upgrades don't leave the user with phantom MCPs
    // they can't delete from the UI.
    if std::env::var("FLEET_DB_URL")
        .ok()
        .as_deref()
        .unwrap_or("")
        .ne("sqlite::memory:")
    {
        services::mcp_registry::purge_legacy_builtin_seeds();
    }

    tracing::info!("fleetify-backend listening on http://{local_addr}");
    Ok(ServerHandle {
        local_addr,
        shutdown_tx: Some(shutdown_tx),
    })
}
