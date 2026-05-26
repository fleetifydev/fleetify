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

/// URL the main webview is pointed at. Debug builds load the Vite dev
/// server (`VITE_PORT`, default 3000); release builds load the
/// embedded backend serving the bundled dist (`FLEETIFY_BACKEND_PORT`,
/// default 8765). Honouring the env vars is what lets the
/// `dev:tauri:wt` script (and the parallel-worktree workflow it
/// enables) run two app instances on different ports side-by-side.
fn webview_url() -> String {
    if cfg!(debug_assertions) {
        let port = std::env::var("VITE_PORT").unwrap_or_else(|_| "3000".into());
        format!("http://localhost:{port}")
    } else {
        let port = std::env::var("FLEETIFY_BACKEND_PORT").unwrap_or_else(|_| "8765".into());
        format!("http://127.0.0.1:{port}")
    }
}

/// Parse `FLEETIFY_BACKEND_PORT` with a hard-coded 8765 fallback. The
/// embedded backend binds this port; the webview URL in release mode
/// (and the Vite dev proxy in debug mode) target the same port.
fn backend_port() -> u16 {
    std::env::var("FLEETIFY_BACKEND_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(8765)
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

    let builder = tauri::Builder::default().plugin(tauri_plugin_dialog::init());

    // macOS 13–15 (Ventura–Sequoia): WKWebView caps requestAnimationFrame
    // and the renderer's page-update tick at ~60 Hz regardless of the
    // display's actual refresh rate, so ProMotion MacBooks and 144/240 Hz
    // externals see the same chop a 60 Hz panel does. The plugin flips
    // WebKit's private `PreferPageRenderingUpdatesNear60FPSEnabled` feature
    // flag at webview-ready time. macOS 26+ already runs at native refresh
    // rate upstream — the plugin detects this and no-ops. Not compiled in
    // on Windows / Linux (target-gated in Cargo.toml).
    #[cfg(target_os = "macos")]
    let builder = builder.plugin(tauri_plugin_macos_fps::init());

    builder
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
            shell::ipc::shell_check_python_runtime,
            shell::ipc::shell_install_ollama,
            shell::ipc::git_watch_head,
            shell::ipc::git_unwatch_head,
            shell::ipc::github_get_link,
            shell::ipc::github_begin_oauth,
            shell::ipc::github_cancel_oauth,
            shell::ipc::github_refresh_link,
            shell::ipc::github_disconnect,
            shell::ipc::github_open_installation,
            shell::ipc::routers_list_routers,
            shell::ipc::routers_connect,
            shell::ipc::routers_disconnect,
            shell::ipc::routers_set_active,
            shell::ipc::routers_set_master_toggle,
            shell::ipc::routers_test_router,
            shell::ipc::routers_get_key_preview,
            shell::ipc::providers_list_catalog,
            shell::ipc::providers_set_key,
            shell::ipc::providers_get_key_preview,
            shell::ipc::providers_delete_key,
            shell::ipc::providers_set_enabled,
            shell::ipc::providers_set_default,
            shell::ipc::providers_test_connection,
            shell::ipc::providers_ollama_probe,
            shell::ipc::providers_set_enabled_models,
            shell::ipc::providers_set_ollama_base_url,
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

            // One-shot lift of any plaintext `cfg.apiKeys` entries into
            // the OS keychain. Idempotent — empty / already-migrated
            // configs are a no-op. Runs on the async runtime so a slow
            // / unavailable keychain backend (e.g. Linux without
            // secret-service) doesn't block the rest of setup().
            let app_for_migration = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                shell::migration::migrate_api_keys_to_keychain(&app_for_migration).await;
            });

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
            // Cold-start at the ONBOARDING size (760×740) rather than
            // the MAIN size (1500×960). Reveal-when-ready paints the
            // first React frame straight into this small window, so
            // new users (splash → welcome → onboarding-chat) never see
            // a giant white frame that then shrinks. Returning users
            // who land on main get a small-to-large grow on first
            // paint instead, which reads as an expand rather than the
            // current jarring shrink. Both sizes are kept in sync with
            // ONBOARDING_SIZE / MAIN_SIZE in src/App.tsx.
            .inner_size(760.0, 740.0)
            // Open on the current monitor's centre on first launch.
            // Without this Tauri falls back to the OS WM's default
            // placement (Windows lands somewhere top-left-ish, looks
            // misaligned on wide displays).
            .center()
            // Hide the OS titlebar — the renderer ships its own custom
            // title strip (min/max/close handled via the window_*
            // IPC commands). Without this, Tauri's native frame stacks
            // on top of the renderer's strip and we get two bars.
            .decorations(false)
            .visible(false)
            .initialization_script(PRELOAD)
            .build()?;

            // Embedded backend (no child process, no health-poll).
            // Port is FLEETIFY_BACKEND_PORT (default 8765) so a second
            // instance launched via `npm run dev:tauri:wt -- <slot>`
            // can run on a sibling port without colliding.
            //
            // Compose RoutingSetup from fleet.config.json + the per-user
            // keychain BEFORE spawning serve(): the backend stays Tauri-
            // agnostic but starts with external routers (Not Diamond,
            // Weave, LiteLLM) already registered when the user had them
            // connected. Fresh installs hand over an empty setup and
            // the backend boots with builtin + DirectGateway only.
            let addr: SocketAddr = format!("127.0.0.1:{}", backend_port()).parse().unwrap();
            let sd = static_dir();
            let app_data_dir = app.path().app_data_dir().ok();
            tauri::async_runtime::spawn(async move {
                let routing_setup = match app_data_dir {
                    Some(dir) => {
                        let uid = shell::auth::get_user_id().await;
                        shell::routing_setup::build(&dir, uid.as_deref())
                    }
                    None => {
                        tracing::warn!(
                            "app_data_dir unavailable; routing orchestrator boots with defaults"
                        );
                        fleetify_backend::services::routing::setup::RoutingSetup::default()
                    }
                };
                match fleetify_backend::serve_with_routing_setup(addr, sd, routing_setup).await {
                    Ok(handle) => {
                        std::mem::forget(handle);
                        tracing::info!("embedded backend up on {addr}");
                    }
                    Err(e) => {
                        tracing::error!("backend failed to start: {e}");
                    }
                }
            });

            // Boot-time providers warm-up: hydrate PROVIDER_KEYS from
            // the keychain and prime HttpHealthCache so the first chat
            // turn doesn't hit "No API key" and Settings → Models
            // opens with final pills instead of the "Testing…" flash.
            // Waits for the embedded backend to bind before hitting it
            // (200ms × 20 = 4s upper bound covers a cold Rust startup).
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                // Wait for the embedded backend to bind its port before
                // we try to reach it. 200ms × 20 = 4s upper bound covers
                // a cold Rust startup on a slow disk.
                let port = std::env::var("FLEETIFY_BACKEND_PORT").unwrap_or_else(|_| "8765".into());
                let health_url = format!("http://127.0.0.1:{port}/health");
                for _ in 0..20 {
                    if let Ok(r) = reqwest::get(&health_url).await {
                        if r.status().is_success() {
                            break;
                        }
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                }
                crate::shell::providers_setup::warm_providers_at_boot(&handle).await;
            });

            // Prime the integrations cache in parallel — only needs the
            // `gh` binary, not the backend, so it can race ahead of the
            // backend-bind wait above. Settings → Integrations reads
            // through this cache so the GitHub tile paints with the
            // final state instead of flashing "Loading…".
            tauri::async_runtime::spawn(async {
                crate::shell::integrations_cache::prime_gh_cli().await;
            });

            // Reveal-when-ready: poll the webview URL until it
            // answers HTTP, then show + focus. Any non-connection-
            // error response counts as "up" (even 404 → renderer can
            // surface the failure). 15s wall-clock cap so a stuck
            // dev server doesn't leave the user with a permanently
            // invisible app. 120ms grace before show() lets the
            // first React frame paint so we don't flash white.
            let webview_url_owned: String = webview_url();
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
