//! Embedded Fleetify backend (FastAPI 1:1). `serve()` binds an axum server
//! on a background tokio task; the Tauri shell calls it from its setup hook.

mod http;

pub mod auth;
pub mod config;
pub mod db;
pub mod models;

use std::net::SocketAddr;
use std::path::PathBuf;

use tokio::net::TcpListener;
use tokio::sync::oneshot;

pub use http::app;

/// Running server handle: bound address + graceful-shutdown trigger.
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

/// Bind `addr` and start serving on a background task. `static_dir` is the
/// built React asset directory for single-origin serving (`None` = API only).
pub async fn serve(
    addr: SocketAddr,
    static_dir: Option<PathBuf>,
) -> anyhow::Result<ServerHandle> {
    let listener = TcpListener::bind(addr).await?;
    let local_addr = listener.local_addr()?;
    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();

    let router = app(static_dir);
    tokio::spawn(async move {
        let server = axum::serve(listener, router).with_graceful_shutdown(async {
            let _ = shutdown_rx.await;
        });
        if let Err(e) = server.await {
            tracing::error!("fleet-backend server error: {e}");
        }
    });

    tracing::info!("fleet-backend listening on http://{local_addr}");
    Ok(ServerHandle {
        local_addr,
        shutdown_tx: Some(shutdown_tx),
    })
}
