//! Tauri v2 shell. `shell/` reimplements the Electron main process
//! (Phase 1b: auth + bearer bridge + auth IPC). `setup` starts the embedded
//! backend, the bearer bridge, and the main window.

mod shell;

use std::net::SocketAddr;
use std::path::PathBuf;

use tauri::webview::WebviewWindowBuilder;
use tauri::{Manager, WebviewUrl};

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
    // Tracing init moved into `setup()` so the file appender can use
    // Tauri's resolved `app_log_dir()` (Windows: %LOCALAPPDATA%, macOS:
    // ~/Library/Logs, Linux: ~/.local/state). The WorkerGuard returned
    // by `logging::init` is `app.manage()`-d to keep the non-blocking
    // writer's flush thread alive for the process lifetime.

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
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
            shell::ipc::window_set_taskbar_icon,
            shell::ipc::fs_read_directory,
            shell::ipc::fs_read_file,
            shell::ipc::fs_get_extension,
            shell::ipc::fs_get_project_root,
            shell::ipc::fs_scaffold_plugin,
            shell::ipc::dialog_open_folder,
            shell::ipc::git_get_context,
            shell::ipc::git_has_gh_cli,
            shell::ipc::git_has_git,
            shell::ipc::git_list_branches,
            shell::ipc::git_set_base_branch,
            shell::ipc::git_checkout,
            shell::ipc::git_commit,
            shell::ipc::git_push,
            shell::ipc::pty_spawn,
            shell::ipc::pty_write,
            shell::ipc::pty_resize,
            shell::ipc::pty_kill,
            shell::ipc::git_ensure_repo,
            shell::ipc::git_pull_latest,
            shell::ipc::git_diff_summary,
            shell::ipc::git_open_pr,
            shell::ipc::git_create_pr,
            shell::ipc::git_get_pr_status,
            shell::ipc::git_list_prs,
            shell::ipc::git_merge_pr,
            shell::ipc::git_pr_ready,
            shell::ipc::git_sync_main,
            shell::ipc::git_carve_next_round,
            shell::ipc::git_preflight_check,
            shell::ipc::shell_check_github_auth,
            shell::ipc::gh_auth_login_launch,
            shell::ipc::gh_auth_login_capture,
            shell::ipc::gh_auth_login_cancel,
            shell::ipc::shell_install_provider,
            shell::ipc::shell_install_ollama,
            shell::ipc::git_watch_head,
            shell::ipc::git_unwatch_head,
            shell::ipc::github_get_link,
            shell::ipc::github_begin_oauth,
            shell::ipc::github_refresh_link,
            shell::ipc::github_disconnect,
            shell::ipc::github_open_installation,
            shell::ipc::git_generate_commit_message,
            shell::ipc::git_generate_pr_summary,
            shell::ipc::git_review_diff,
            shell::ipc::git_diagnose_failure,
            shell::ipc::git_apply_recovery,
            shell::ipc::git_apply_preflight_fix,
            shell::ipc::git_diff_summary_simple,
            shell::ipc::app_log,
            shell::ipc::logs_export,
            shell::ipc::logs_open_folder,
            shell::ipc::feedback_send,
        ])
        .setup(|app| {
            // Bring tracing online FIRST so any setup-phase warnings
            // (auth handle, embedded backend boot, webview build) land
            // in the log file. The returned WorkerGuard is parked on
            // the app's state container so the non-blocking writer's
            // flush thread lives as long as the process.
            if let Some(guard) = shell::logging::init(app.handle()) {
                app.manage(guard);
            }

            // Auth module emits `fleet:auth-event` via this handle.
            shell::auth::set_app_handle(app.handle().clone());

            // No splash — by explicit user preference. The main
            // window is built `.visible(false)` and stays hidden until
            // both the embedded backend AND the webview's target URL
            // (Vite in debug, the backend in release) are reachable.
            // Direct WebviewWindow handle clone (no get_webview_window
            // lookup) avoids the AppHandle race the earlier version
            // hit on Windows. Trade-off: from t=0 to URL-ready (~3-7s
            // depending on Vite cold-start) the user sees nothing on
            // screen. That's the price of "no visible loading state".
            let main_window = WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::External(webview_url().parse().expect("valid webview url")),
            )
            .title("Fleetify")
            .inner_size(1500.0, 960.0)
            // Hide the OS titlebar — the renderer ships its own custom
            // title strip (min/max/close handled via the window_*
            // IPC commands). Without this, Tauri's native frame stacks
            // on top of the renderer's strip and we get two bars.
            .decorations(false)
            .visible(false)
            .initialization_script(PRELOAD)
            .build()?;

            // Embedded backend (no child process, no health-poll).
            let addr: SocketAddr = "127.0.0.1:8765".parse().unwrap();
            let sd = static_dir();
            tauri::async_runtime::spawn(async move {
                match fleetify_backend::serve(addr, sd).await {
                    Ok(handle) => {
                        std::mem::forget(handle);
                        tracing::info!("embedded backend up on {addr}");
                    }
                    Err(e) => {
                        tracing::error!("backend failed to start: {e}");
                    }
                }
            });

            // Reveal-when-ready: poll the webview URL until it
            // answers HTTP, then show + focus. Any non-connection-
            // error response counts as "up" (even 404 → renderer can
            // surface the failure). 15s wall-clock cap so a stuck
            // dev server doesn't leave the user with a permanently
            // invisible app. 120ms grace before show() lets the
            // first React frame paint so we don't flash white.
            let webview_url_owned: String = webview_url().to_string();
            let main_for_reveal = main_window.clone();
            tauri::async_runtime::spawn(async move {
                let client = reqwest::Client::builder()
                    .timeout(std::time::Duration::from_millis(500))
                    .build()
                    .expect("reqwest client");
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
                while std::time::Instant::now() < deadline {
                    if client.get(&webview_url_owned).send().await.is_ok() {
                        break;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
                }
                tokio::time::sleep(std::time::Duration::from_millis(120)).await;
                if let Err(e) = main_for_reveal.show() {
                    tracing::warn!("show main window failed: {e}");
                }
                let _ = main_for_reveal.set_focus();
            });

            // Loopback bearer bridge :8770 (telemetry token source / parity).
            // FLEETIFY_NOAUTH=1 has no consumer to feed and no token to
            // emit, so skip the listener entirely.
            if !shell::auth::is_no_auth() {
                tauri::async_runtime::spawn(async {
                    shell::bearer::run().await;
                });

                // Telemetry WS client → fleetify.dev. Bearer pulled from
                // shell::auth.get_access_token() lazily per attempt so a
                // mid-flow refresh is picked up at the next reconnect.
                tauri::async_runtime::spawn(async {
                    let source: fleetify_backend::services::telemetry::BearerSource =
                        std::sync::Arc::new(|| {
                            Box::pin(async {
                                shell::auth::get_access_token(false).await.and_then(|v| {
                                    v.get("token").and_then(|t| t.as_str()).map(String::from)
                                })
                            })
                        });
                    fleetify_backend::services::telemetry::run_ws_client_loop(source).await;
                });
            }

            Ok(())
        })
        .on_window_event(|_window, event| {
            // Tear down any HEAD watchers on window destroy so app-quit
            // doesn't leak fs watcher handles (matches main.cjs's
            // before-quit cleanup).
            if matches!(event, tauri::WindowEvent::Destroyed) {
                shell::head_watcher::shutdown();
                // Mark the shutdown as clean — removes the crash flag
                // so the next boot doesn't falsely report "previous
                // session crashed". Window-destroyed is the closest
                // we get to a deterministic "the user closed the app"
                // signal in Tauri 2; OS-level kills (Task Manager,
                // SIGKILL) skip this path on purpose, which is exactly
                // what makes the flag a useful crash signal.
                shell::logging::mark_clean_shutdown();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
