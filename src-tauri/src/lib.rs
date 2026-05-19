//! Tauri v2 shell. The Electron main process is reimplemented here over the
//! coming phases (OAuth, git, pty, ~56 IPC commands). Phase 0 only boots the
//! window and starts the embedded backend in the `setup` hook.

use std::net::SocketAddr;
use std::path::PathBuf;

use tauri::webview::WebviewWindowBuilder;
use tauri::WebviewUrl;

/// Boot shim reconstructing `window.electronAPI` / `window.fleetify`.
/// Phase 1 expands this to the full ~56-channel contract.
const PRELOAD: &str = include_str!("preload.js");

/// Where the webview loads the UI from.
/// - dev: Vite dev server (HMR); it proxies `/api,/ws,/events,/healthz`
///   to the embedded backend on :8765 (original `vite.config.ts`).
/// - release: the embedded axum server serves the built bundle + API on a
///   single origin, so relative `/api` "just works".
fn webview_url() -> &'static str {
    if cfg!(debug_assertions) {
        "http://localhost:3000"
    } else {
        "http://127.0.0.1:8765"
    }
}

/// Static dir the embedded backend serves the built UI from. `None` in dev
/// (Vite owns the UI); in release, the `dist/` next to the executable or in
/// the working dir (full single-binary asset embedding is a Phase 5 task).
fn static_dir() -> Option<PathBuf> {
    if cfg!(debug_assertions) {
        None
    } else {
        let beside_exe = std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.join("dist")))
            .filter(|p| p.exists());
        Some(beside_exe.unwrap_or_else(|| PathBuf::from("dist")))
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt().with_target(false).compact().init();

    tauri::Builder::default()
        .setup(|app| {
            // Tauri v2: do startup work in the setup hook, not before the builder.
            let addr: SocketAddr = "127.0.0.1:8765".parse().unwrap();
            let sd = static_dir();
            tauri::async_runtime::spawn(async move {
                match fleet_backend::serve(addr, sd).await {
                    Ok(handle) => {
                        // Held for the app lifetime; a graceful-shutdown hook
                        // mirroring the FastAPI lifespan "bye" lands in Phase 1.
                        std::mem::forget(handle);
                        tracing::info!("embedded backend up on {addr}");
                    }
                    Err(e) => tracing::error!("backend failed to start: {e}"),
                }
            });

            WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::External(webview_url().parse().expect("valid webview url")),
            )
            .title("Fleet")
            .inner_size(1500.0, 960.0)
            .initialization_script(PRELOAD)
            .build()?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
