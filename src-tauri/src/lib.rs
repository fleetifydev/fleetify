//! Tauri v2 shell. `shell/` reimplements the Electron main process
//! (Phase 1b: auth + bearer bridge + auth IPC). `setup` starts the embedded
//! backend, the bearer bridge, and the main window.

mod shell;

use std::net::SocketAddr;
use std::path::PathBuf;

use tauri::webview::WebviewWindowBuilder;
use tauri::WebviewUrl;

/// Boot shim reconstructing `window.electronAPI` / `window.fleetify`.
const PRELOAD: &str = include_str!("preload.js");

fn webview_url() -> &'static str {
    if cfg!(debug_assertions) {
        "http://localhost:3000"
    } else {
        "http://127.0.0.1:8765"
    }
}

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
        .invoke_handler(tauri::generate_handler![
            shell::ipc::auth_sign_in,
            shell::ipc::auth_sign_out,
            shell::ipc::auth_userinfo,
            shell::ipc::auth_get_access_token,
            shell::ipc::auth_get_state,
            shell::ipc::config_get,
            shell::ipc::config_set,
            shell::ipc::shell_open_external,
            shell::ipc::shell_show_item_in_folder,
            shell::ipc::clipboard_write,
            shell::ipc::window_minimize,
            shell::ipc::window_maximize,
            shell::ipc::window_close,
            shell::ipc::window_set_size,
            shell::ipc::fs_read_directory,
            shell::ipc::fs_read_file,
            shell::ipc::fs_get_extension,
            shell::ipc::fs_get_project_root,
        ])
        .setup(|app| {
            // Auth module emits `fleet:auth-event` via this handle.
            shell::auth::set_app_handle(app.handle().clone());

            // Embedded backend (no child process, no health-poll).
            let addr: SocketAddr = "127.0.0.1:8765".parse().unwrap();
            let sd = static_dir();
            tauri::async_runtime::spawn(async move {
                match fleet_backend::serve(addr, sd).await {
                    Ok(handle) => {
                        std::mem::forget(handle);
                        tracing::info!("embedded backend up on {addr}");
                    }
                    Err(e) => tracing::error!("backend failed to start: {e}"),
                }
            });

            // Loopback bearer bridge :8770 (telemetry token source / parity).
            tauri::async_runtime::spawn(async {
                shell::bearer::run().await;
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
