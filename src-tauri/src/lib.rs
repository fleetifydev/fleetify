//! Tauri v2 shell. `shell/` reimplements the Electron main process
//! (Phase 1b: auth + bearer bridge + auth IPC). `setup` starts the embedded
//! backend, the bearer bridge, and the main window.

mod shell;

// The app's commands, by name: its ACL manifest. build.rs compiles this file
// in for tauri-build; the crate itself only needs it for tests.
#[cfg(test)]
mod app_commands;

use std::net::SocketAddr;
use std::path::PathBuf;

use tauri::webview::WebviewWindowBuilder;
#[cfg(target_os = "macos")]
use tauri::LogicalPosition;
#[cfg(target_os = "macos")]
use tauri::TitleBarStyle;
use tauri::{Manager, WebviewUrl};

/// Boot shim reconstructing `window.electronAPI` / `window.fleetify`.
const PRELOAD: &str = include_str!("preload.js");

/// Parse `VITE_PORT` with a 3000 fallback, as `vite.config.ts` does. Debug
/// builds load the app from the Vite dev server on this port (see
/// `shell::startup_window::app_origin`).
fn vite_port() -> u16 {
    match std::env::var("VITE_PORT") {
        Ok(s) => s.parse().unwrap_or_else(|_| {
            tracing::warn!(value = %s, "VITE_PORT is not a valid port; falling back to 3000");
            3000
        }),
        Err(_) => 3000,
    }
}

/// Parse `FLEETIFY_BACKEND_PORT` with a hard-coded 8765 fallback. The
/// embedded backend binds this port; the webview URL in release mode
/// (and the Vite dev proxy in debug mode) target the same port.
fn backend_port() -> u16 {
    match std::env::var("FLEETIFY_BACKEND_PORT") {
        Ok(s) => s.parse().unwrap_or_else(|_| {
            // Surface the misconfiguration instead of silently binding 8765 —
            // a typo'd port otherwise looks like "the backend won't connect".
            tracing::warn!(value = %s, "FLEETIFY_BACKEND_PORT is not a valid port; falling back to 8765");
            8765
        }),
        Err(_) => 8765,
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

    // GNOME and other native-Wayland sessions forbid a client from
    // positioning its own toplevel — set_position()/center() are silently
    // ignored by the compositor. That left the post-onboarding resize
    // (760×740 → 1500×960) anchored to its old top-left, stranding the grown
    // window in the bottom-right corner with no way to recenter. Run under
    // Xwayland on Linux, where window positioning works so the recenter in
    // `window_set_size` takes effect. Must be set before GTK initialises
    // (i.e. before the Tauri builder). Respects an explicit override, so
    // `GDK_BACKEND=wayland npm run …` still opts back into native Wayland.
    #[cfg(target_os = "linux")]
    if std::env::var("GDK_BACKEND")
        .map(|v| v.is_empty())
        .unwrap_or(true)
    {
        std::env::set_var("GDK_BACKEND", "x11");
    }

    // Cap the WebView2 disk cache so the per-user data folder (HTTP cache,
    // cookies, Code Cache, …) can't grow unbounded — measured ~480 MB in the
    // wild, ~50× the 9.5 MB installer and far bigger than the ~27 MB program.
    // The packaged app otherwise passes NO browser args (only the `prod` dev
    // script injects any), so the cache had no ceiling. Append rather than
    // replace so an existing override (e.g. remote-debugging) survives.
    #[cfg(target_os = "windows")]
    {
        const CACHE_CAP: &str = "--disk-cache-size=157286400"; // 150 MB
        let existing = std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").unwrap_or_default();
        if !existing.contains("--disk-cache-size") {
            let combined = if existing.trim().is_empty() {
                CACHE_CAP.to_string()
            } else {
                format!("{existing} {CACHE_CAP}")
            };
            std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", combined);
        }
    }

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
            shell::ipc::telemetry_get_config,
            shell::ipc::telemetry_set_posthog_enabled,
            shell::ipc::telemetry_set_cloud_enabled,
            shell::ipc::shell_open_external,
            shell::ipc::shell_show_item_in_folder,
            shell::ipc::detect_editors,
            shell::ipc::open_in_editor,
            shell::ipc::clipboard_write,
            shell::ipc::browser_embed_create,
            shell::ipc::browser_embed_navigate,
            shell::ipc::browser_embed_set_bounds,
            shell::ipc::browser_embed_set_select,
            shell::ipc::browser_embed_nav,
            shell::ipc::browser_embed_devtools,
            shell::ipc::browser_embed_clear_data,
            shell::ipc::browser_embed_close,
            shell::ipc::window_start_dragging,
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
            shell::ipc::dialog_open_file,
            shell::ipc::git_get_context,
            shell::ipc::git_working_diff,
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
            shell::ipc::pty_buffer,
            shell::ipc::git_ensure_repo,
            shell::ipc::git_pull_latest,
            shell::ipc::git_diff_summary,
            shell::ipc::git_open_pr,
            shell::ipc::git_create_pr,
            shell::ipc::git_get_pr_status,
            shell::ipc::git_list_prs,
            shell::ipc::git_merge_pr,
            shell::ipc::git_rerun_check_job,
            shell::ipc::git_rerun_failed_checks,
            shell::ipc::git_delete_remote_branch,
            shell::ipc::git_pr_ready,
            shell::ipc::git_sync_main,
            shell::ipc::git_fetch_base,
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
            shell::ipc::github_list_repos,
            shell::ipc::github_list_installations,
            shell::ipc::voice_list_devices,
            shell::ipc::voice_start_recording,
            shell::ipc::voice_stop_recording,
            shell::ipc::voice_transcribe,
            shell::ipc::voice_set_byok_key,
            shell::ipc::voice_has_byok_key,
            shell::ipc::voice_list_models,
            shell::ipc::voice_download_model,
            shell::ipc::voice_cancel_download,
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
            shell::ipc::providers_set_connected_bulk,
            shell::ipc::providers_test_connection,
            shell::ipc::providers_ollama_probe,
            shell::ipc::providers_ollama_ps,
            shell::ipc::providers_ollama_pull,
            shell::ipc::providers_ollama_pull_cancel,
            shell::ipc::providers_ollama_delete,
            shell::ipc::providers_set_enabled_models,
            shell::ipc::providers_set_ollama_base_url,
            shell::ipc::providers_set_ollama_cloud_base_url,
            shell::ipc::providers_set_cloudflare_account_id,
            shell::ipc::providers_set_account_key,
            shell::ipc::providers_get_account_key_preview,
            shell::ipc::providers_delete_account_key,
            shell::ipc::providers_open_account_login,
            shell::ipc::agent_login_default,
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
        .manage(shell::voice::VoiceCaptureState(std::sync::Arc::new(
            tokio::sync::Mutex::new(None),
        )))
        .manage(shell::voice::DownloadCancelState(std::sync::Arc::new(
            std::sync::atomic::AtomicBool::new(false),
        )))
        // The page the main window starts on, until the app answers (see
        // shell::startup_window).
        .register_uri_scheme_protocol(
            shell::startup_window::PLACEHOLDER_SCHEME,
            |ctx, _request| shell::startup_window::placeholder_response(ctx.webview_label()),
        )
        .setup(|app| {
            // X errors are FATAL in GDK by default: one async BadWindow (e.g.
            // a GDK XTranslateCoordinates racing a webview teardown, or the
            // WebKit inspector probing a just-destroyed window) kills the
            // whole app. Log-and-continue instead — these are races on
            // already-dead X resources, not corrupt state.
            #[cfg(target_os = "linux")]
            {
                unsafe extern "C" fn fleet_x_error_handler(
                    _dpy: *mut x11_dl::xlib::Display,
                    ev: *mut x11_dl::xlib::XErrorEvent,
                ) -> std::os::raw::c_int {
                    if !ev.is_null() {
                        let e = unsafe { &*ev };
                        eprintln!(
                            "[X-ERROR] code={} request={} minor={} resource={:#x} (suppressed)",
                            e.error_code, e.request_code, e.minor_code, e.resourceid
                        );
                    }
                    0
                }
                if let Ok(xl) = x11_dl::xlib::Xlib::open() {
                    unsafe { (xl.XSetErrorHandler)(Some(fleet_x_error_handler)) };
                }
            }
            // Cold-start stopwatch: wall-clock from setup() entry, logged at
            // the first window reveal so the boot path stops being untimed
            // (measure-first). Cheap — just an Instant.
            let boot_start = std::time::Instant::now();
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

            // Decide Fleetify cloud sync for this launch before anything
            // else reads or writes fleet.config.json: ahead of the key
            // migration below, and of the renderer (no command runs until
            // setup returns). A file that is there but can't be read or
            // parsed keeps sync off and gets an explicit opt-out saved, so
            // no later save can drop the user's earlier choice. The early
            // open and the final restore below both follow this decision.
            let cloud_open_at_launch = app
                .path()
                .app_data_dir()
                .map(|dir| shell::config::startup_cloud_decision(&dir))
                .unwrap_or(false);

            // One-shot lift of any plaintext `cfg.apiKeys` entries into
            // the OS keychain. Idempotent — empty / already-migrated
            // configs are a no-op. Runs on the async runtime so a slow
            // / unavailable keychain backend (e.g. Linux without
            // secret-service) doesn't block the rest of setup().
            let app_for_migration = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                shell::migration::migrate_api_keys_to_keychain(&app_for_migration).await;
            });

            // The ports, parsed once: the main window loads the app from
            // one of them (shell::startup_window::app_origin), and the
            // embedded backend binds `backend` below.
            let release = !cfg!(debug_assertions);
            let (backend, vite) = (backend_port(), vite_port());

            // IPC from the app's origin. capabilities/default.json allows
            // only the default ports (Vite on 3000, the backend on 8765);
            // any other configured port gets the same permissions for its
            // own origin, on the main webview only. Added before the window
            // loads the app.
            if let Some(origin) =
                shell::startup_window::runtime_remote_origin(release, backend, vite)
            {
                match app.add_capability(shell::startup_window::runtime_capability(&origin)) {
                    Ok(()) => tracing::info!(%origin, "IPC allowed from the configured app origin"),
                    Err(e) => tracing::warn!(
                        %origin,
                        "allowing IPC from the configured app origin failed: {e}"
                    ),
                }
            }

            // No splash — by explicit user preference. The main
            // window is built `.visible(false)` on a local placeholder
            // page and stays hidden until the app's URL (Vite in debug,
            // the embedded backend in release) answers and the app page
            // has loaded in it. It never loads that URL before then: the
            // engine doesn't retry a first navigation that failed, so a
            // slow backend bind used to leave its error page on screen.
            // A start slower than 15s shows the window with the
            // placeholder ("Starting Fleetify…") until the app loads.
            // See shell::startup_window. Direct WebviewWindow handle
            // clone (no get_webview_window lookup) avoids the AppHandle
            // race the earlier version hit on Windows.
            let app_url: tauri::Url = shell::startup_window::app_origin(release, backend, vite)
                .parse()
                .expect("valid webview url");
            let app_page_loaded = std::sync::Arc::new(tokio::sync::Notify::new());
            let builder = WebviewWindowBuilder::new(
                app,
                shell::startup_window::MAIN_WINDOW,
                WebviewUrl::CustomProtocol(
                    shell::startup_window::PLACEHOLDER_URL
                        .parse()
                        .expect("valid placeholder url"),
                ),
            )
            .on_page_load(shell::startup_window::signal_app_page_loaded(
                app_url.clone(),
                app_page_loaded.clone(),
            ))
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
            .visible(false)
            // Required for HTML5 drag-and-drop on Windows/WebView2. With Tauri's
            // OS-level drag-drop handler ENABLED (the default) WebView2 intercepts
            // every drag over the webview and silently breaks in-page HTML5 DnD —
            // the sidebar's session reorder / drag-to-pin and the composer's file
            // drop both rely on HTML5 DnD (e.dataTransfer), NOT Tauri's native
            // onDragDropEvent. Nothing in the app consumes the native event, so
            // turning the handler off is safe and restores DnD. (No-op on macOS.)
            .disable_drag_drop_handler()
            .initialization_script(PRELOAD);

            // macOS: keep native traffic lights (close/min/max) with
            // overlay style — hides the title bar background but leaves
            // the buttons. Other platforms: remove decorations entirely
            // (renderer ships its own Windows title bar strip).
            #[cfg(target_os = "macos")]
            let builder = builder
                .title_bar_style(TitleBarStyle::Overlay)
                .hidden_title(true)
                .traffic_light_position(LogicalPosition::new(14.0_f64, 24.0_f64));

            #[cfg(not(target_os = "macos"))]
            let builder = builder.decorations(false);

            let main_window = builder.build()?;

            // macOS: set the dock icon programmatically so the transparent
            // PNG is shown as-is (floating bars) without macOS adding its
            // adaptive rounded-rect background — that background is only
            // applied to .icns bundle icons, not to runtime-set NSImages.
            #[cfg(target_os = "macos")]
            {
                let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/icon.png"))
                    .expect("dock icon bytes valid");
                main_window.set_icon(icon).ok();
            }

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
            let addr: SocketAddr = format!("127.0.0.1:{backend}").parse().unwrap();
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
                        // backend_bind_ms splits the boot path: this is the
                        // setup()→backend-bound phase; cold_start_ms at the
                        // window reveal is the total. (total − bind) is the
                        // webview-build + URL-reachable wait. measure-first 2.1.
                        tracing::info!(
                            backend_bind_ms = boot_start.elapsed().as_millis() as u64,
                            "embedded backend up on {addr}"
                        );
                    }
                    Err(e) => {
                        tracing::error!("backend failed to start: {e}");
                    }
                }
            });

            // Let the backend's agent `read_page` read the OPEN panel page
            // straight from the native webview (what the user sees), instead of
            // the separate headless CDP page. The backend stays Tauri-agnostic;
            // it just calls this boxed closure.
            {
                let reader_handle = app.handle().clone();
                fleetify_backend::services::browser::set_embedded_reader(Box::new(move || {
                    let app = reader_handle.clone();
                    Box::pin(crate::shell::ipc::read_embedded_page(app))
                }));
                let nav_handle = app.handle().clone();
                fleetify_backend::services::browser::set_embedded_navigator(Box::new(move |url| {
                    let app = nav_handle.clone();
                    Box::pin(crate::shell::ipc::navigate_embedded_page(app, url))
                }));
            }

            // Boot-time providers warm-up: hydrate PROVIDER_KEYS from
            // the keychain and prime HttpHealthCache so the first chat
            // turn doesn't hit "No API key" and Settings → Models
            // opens with final pills instead of the "Testing…" flash.
            // Waits for the embedded backend to bind before hitting it
            // (200ms × 20 = 4s upper bound covers a cold Rust startup).
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                // Both telemetry gates start closed in the backend. Open the
                // ones that are on right away rather than after the warm-up
                // below: `telemetry_get_config` reports the live gates, and
                // the renderer reads it as soon as it loads (it decides then
                // whether to start posthog-js). It also keeps the backend's
                // first heartbeat and early session events. The PostHog gate
                // is only a flag, so it can open before serve() has set up
                // the PostHog sink. The cloud gate follows the launch
                // decision made at the top of setup; closing it waits for
                // the restore at the end of this task. Rows older builds
                // queued depend on neither: the outbox drops them itself
                // when it opens, before anything can read them.
                if let Ok(dir) = handle.path().app_data_dir() {
                    let cfg = crate::shell::config::load_config_from(&dir);
                    if crate::shell::config::telemetry_from(&cfg).posthog_enabled {
                        fleetify_backend::services::telemetry::posthog::set_enabled(true);
                    }
                }
                if cloud_open_at_launch {
                    fleetify_backend::services::telemetry::set_cloud_enabled(true).await;
                }

                // Wait for the embedded backend to answer its health route
                // before we try to reach it. 200ms × 20 = 4s upper bound
                // covers a cold Rust startup on a slow disk; past it, the
                // warm-up runs anyway.
                let port = std::env::var("FLEETIFY_BACKEND_PORT").unwrap_or_else(|_| "8765".into());
                let ready = crate::shell::backend_ready::wait_for_backend(
                    &crate::shell::backend_ready::health_url(&port),
                    20,
                    std::time::Duration::from_millis(200),
                )
                .await;
                if !ready {
                    tracing::warn!("backend health check timed out; warming up anyway");
                }
                crate::shell::providers_setup::warm_providers_at_boot(&handle).await;
                // Hydrate the backend clone service with the linked GitHub
                // token so private-repo clones authenticate from the first try.
                crate::shell::github_link::push_clone_token().await;

                // Finish the Fleetify cloud sync restore: close the gate if
                // the launch decision kept sync off, or if the saved choice
                // is off now (a file that can't be read or parsed counts as
                // off). Closing also purges what is still queued, if the
                // backend has opened its outbox by now. Nothing orders this
                // after that, so rows older builds queued are dropped by the
                // outbox itself. It never opens the gate, and it does
                // nothing if Settings changed it since launch: reapplying
                // the saved choice here would undo a switch whose save
                // failed. (The PostHog gate was restored at the top of this
                // task, for the same reason.)
                let saved_on = cloud_open_at_launch
                    && handle
                        .path()
                        .app_data_dir()
                        .map(|dir| crate::shell::config::saved_cloud_choice(&dir))
                        .unwrap_or(false);
                crate::shell::ipc::finish_cloud_sync_restore(saved_on).await;
            });

            // Prime the integrations cache in parallel — only needs the
            // `gh` binary, not the backend, so it can race ahead of the
            // backend-bind wait above. Settings → Integrations reads
            // through this cache so the GitHub tile paints with the
            // final state instead of flashing "Loading…".
            tauri::async_runtime::spawn(async {
                crate::shell::integrations_cache::prime_gh_cli().await;
            });

            // Reveal-when-ready: poll the webview URL until it answers
            // HTTP (any response counts, even a 404 the renderer can
            // surface), then load the app in the window and show + focus
            // it once the app page has loaded, so it doesn't flash white.
            // Past 15s without an answer the window shows the placeholder
            // and polling goes on with no cap.
            tauri::async_runtime::spawn(shell::startup_window::load_app_when_ready(
                main_window,
                app_url,
                app_page_loaded,
                boot_start,
            ));

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
                // Idles (no bearer, no socket) while cloud sync is off.
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
