//! How the main window closes and opens again, and how Fleetify quits.
//!
//! On Windows and macOS, closing the main window (its close button, Alt+F4,
//! Cmd+W) hides it while "Keep Fleetify running when you close the window"
//! is on (Settings → General → Window, on by default): Fleetify keeps
//! running, and so do agent sessions ([`close_action`]). On Windows its
//! notification-area icon (shell::tray) opens the window again, with a
//! click or Open Fleetify in its menu, and Quit Fleetify in that menu quits.
//! On macOS it stays in the Dock: a click on the Dock icon opens the window
//! again (`RunEvent::Reopen`), and Cmd+Q quits. On Linux closing the window
//! quits, as before: a tray icon needs libayatana-appindicator at run time,
//! and not every desktop shows one, so a hidden window could be stranded.
//!
//! On Windows the first close that would hide the window explains first,
//! once (shell::close_notice): Windows puts a new notification-area icon
//! under the ^ arrow, so a window that just disappeared would look as if
//! Fleetify had quit.
//!
//! Quitting stays quitting. Nothing here prevents an exit request: only a
//! close request hides the window, and Quit Fleetify, Cmd+Q, Restart to
//! update and any other `AppHandle::exit` or restart exit without one. They
//! all end in `RunEvent::Exit`, where [`on_exit`] runs the shutdown that
//! the main window's `Destroyed` event used to run: a window that hides is
//! never destroyed, and Cmd+Q never destroyed it either.

use serde_json::Value;
use tauri::{AppHandle, CloseRequestApi, Manager, RunEvent, Window};

use crate::shell::startup_window::{self, MAIN_WINDOW};
use crate::shell::{close_notice, config, head_watcher, logging, tray};

/// The desktop platforms, as [`close_action`] tells them apart.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    Windows,
    MacOs,
    Linux,
}

/// The platform this build is for. Any other than Windows and macOS closes
/// as Linux does.
pub const PLATFORM: Platform = if cfg!(windows) {
    Platform::Windows
} else if cfg!(target_os = "macos") {
    Platform::MacOs
} else {
    Platform::Linux
};

/// What a close request does to a window.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseAction {
    /// Hide the window: Fleetify keeps running.
    Hide,
    /// Let the window close, as Tauri does by default. Closing the last
    /// window quits.
    Close,
}

/// The setting's key in `fleet.config.json`, which Settings → General →
/// Window writes.
pub const KEEP_RUNNING_KEY: &str = "keepRunningOnClose";

/// Whether closing the window keeps Fleetify running, from `cfg`, the saved
/// `fleet.config.json`: it does unless the setting is saved as `false`.
/// Without a value, or with one that isn't a bool, it does, as Settings
/// shows it.
pub fn keep_running_from(cfg: &Value) -> bool {
    cfg.get(KEEP_RUNNING_KEY)
        .and_then(Value::as_bool)
        .unwrap_or(true)
}

/// What a close request does: hide the main window, so Fleetify keeps
/// running, when `keep_running` (the setting) is on, on Windows only while
/// the notification-area icon is there (`tray_ready`), as nothing else would
/// open the window again or quit, and on macOS, where the Dock does both.
/// On Linux, and for any window but the main one (`main_window`), the window
/// closes.
pub fn close_action(
    main_window: bool,
    platform: Platform,
    keep_running: bool,
    tray_ready: bool,
) -> CloseAction {
    let can_come_back = match platform {
        Platform::Windows => tray_ready,
        Platform::MacOs => true,
        Platform::Linux => false,
    };
    if main_window && keep_running && can_come_back {
        CloseAction::Hide
    } else {
        CloseAction::Close
    }
}

/// The handler for a close request on `window` (lib.rs's
/// `on_window_event`): hides it when [`close_action`] says so, and closing
/// goes on otherwise. The setting is read from `fleet.config.json` each
/// time, so a change in Settings counts at the next close. A window that
/// can't be hidden closes, rather than stay on screen after its close
/// button was pressed.
///
/// On Windows, the first close that would hide the main window shows the
/// notice instead (shell::close_notice), and the window stays until it is
/// answered; a notice that can't be shown hides the window, as before.
/// While the notice is open, a close request changes nothing.
pub fn on_close_requested(window: &Window, api: &CloseRequestApi) {
    let main_window = window.label() == MAIN_WINDOW;
    if main_window && close_notice::is_open() {
        api.prevent_close();
        return;
    }
    let dir = window.app_handle().path().app_data_dir().ok();
    let cfg = dir.as_deref().map(config::load_config_from);
    let keep_running = cfg.as_ref().is_none_or(keep_running_from);
    let action = close_action(main_window, PLATFORM, keep_running, tray::ready());
    if action == CloseAction::Close {
        return;
    }
    #[cfg(windows)]
    if close_notice::shows_notice(action, PLATFORM, close_notice::shown(cfg.as_ref()))
        && close_notice::show(window, dir)
    {
        api.prevent_close();
        return;
    }
    match hide(window) {
        Ok(()) => api.prevent_close(),
        Err(e) => {
            tracing::warn!("hiding the main window failed, so closing it quits Fleetify: {e}")
        }
    }
}

/// Hides `window`. On macOS a window in full screen hides with the app, as
/// Cmd+H does: hiding the window alone would leave its empty full-screen
/// Space on screen.
pub(crate) fn hide(window: &Window) -> tauri::Result<()> {
    #[cfg(target_os = "macos")]
    if window.is_fullscreen()? {
        return window.app_handle().hide();
    }
    window.hide()
}

/// Brings the main window to the front: shown, since a close hid it or it
/// starts hidden, restored if minimized, and focused. For opening Fleetify
/// again while it runs (the single-instance plugin's callback), the
/// notification-area icon on Windows and the Dock icon on macOS.
///
/// Until the startup task has shown the window (shell::startup_window), it
/// does nothing: that task shows it once the app has loaded, or with its
/// placeholder after a slow start. It looks the window up with `get_window`:
/// `get_webview_window` finds a window only while every webview in it has
/// the window's label, so not while the Browser panel's child webview is
/// attached. Failures are logged; it never panics.
pub fn open_main_window(app: &AppHandle) {
    if !startup_window::revealed() {
        tracing::info!("Fleetify is still starting; its window shows once it has started");
        return;
    }
    let Some(window) = app.get_window(MAIN_WINDOW) else {
        tracing::warn!("opening the main window failed: it doesn't exist");
        return;
    };
    // macOS: a window closed in full screen hid with the app ([`hide`]).
    #[cfg(target_os = "macos")]
    if let Err(e) = app.show() {
        tracing::warn!("showing Fleetify again failed: {e}");
    }
    if let Err(e) = window.show() {
        tracing::warn!("showing the main window failed: {e}");
    }
    if let Err(e) = window.unminimize() {
        tracing::warn!("restoring the main window failed: {e}");
    }
    if let Err(e) = window.set_focus() {
        tracing::warn!("focusing the main window failed: {e}");
    }
}

/// Quits Fleetify, for Quit Fleetify in the notification-area icon's menu
/// (shell::tray) and in the notice on the first close (shell::close_notice),
/// `from` naming which, for the log. It exits through the event loop, as
/// every quit does, so the shutdown at `RunEvent::Exit` runs ([`on_exit`])
/// and Tauri removes the icon.
#[cfg(windows)]
pub fn quit(app: &AppHandle, from: &str) {
    tracing::info!("quitting from {from}");
    app.exit(0);
}

/// The shutdown every orderly quit runs, at `RunEvent::Exit`: the last
/// window closing, Quit Fleetify, Cmd+Q, Restart to update, or any other
/// `AppHandle::exit` or restart. It drops the HEAD watchers, so quitting
/// doesn't leak their file handles, and marks the shutdown clean, so the
/// next launch doesn't report a crash. A process that is killed (Task
/// Manager, SIGKILL) skips it, which is what makes the flag a crash signal.
pub fn on_exit() {
    head_watcher::shutdown();
    logging::mark_clean_shutdown();
}

/// The app's run-event handler (lib.rs): the shutdown at exit, and on macOS
/// the window again when the Dock icon is clicked.
#[cfg_attr(not(target_os = "macos"), allow(unused_variables))]
pub fn on_run_event(app: &AppHandle, event: RunEvent) {
    match event {
        RunEvent::Exit => on_exit(),
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => open_main_window(app),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn keeping_fleetify_running_is_on_by_default() {
        assert!(keep_running_from(&json!({})));
        assert!(keep_running_from(&json!({ "keepRunningOnClose": true })));
    }

    #[test]
    fn only_a_saved_false_turns_it_off() {
        assert!(!keep_running_from(&json!({ "keepRunningOnClose": false })));
        // Not a bool: on, as Settings shows it.
        assert!(keep_running_from(&json!({ "keepRunningOnClose": "false" })));
        assert!(keep_running_from(&json!({ "keepRunningOnClose": 0 })));
        assert!(keep_running_from(&json!({ "keepRunningOnClose": null })));
    }

    #[test]
    fn the_opt_out_survives_a_save_and_a_reload() {
        // Saved as Settings saves it: config_set replaces the file through
        // replace_config_keeping_telemetry.
        let tmp = tempfile::tempdir().unwrap();
        crate::shell::config::replace_config_keeping_telemetry(
            tmp.path(),
            json!({ "theme": "dark", "keepRunningOnClose": false }),
        )
        .unwrap();
        let cfg = crate::shell::config::load_config_from(tmp.path());
        assert!(!keep_running_from(&cfg));
        assert_eq!(cfg["theme"], "dark");
    }

    #[test]
    fn every_close_action_combination() {
        use CloseAction::{Close, Hide};
        use Platform::{Linux, MacOs, Windows};
        // (main window, platform, keep running, tray ready) → what a close
        // does. Every combination, once.
        let cases = [
            // Windows: hides only while the setting is on and the tray icon
            // is there; without the icon, nothing would open a hidden window
            // again or quit Fleetify.
            (true, Windows, true, true, Hide),
            (true, Windows, true, false, Close),
            (true, Windows, false, true, Close),
            (true, Windows, false, false, Close),
            // macOS: the Dock opens the window again and quits, so the tray
            // icon doesn't count.
            (true, MacOs, true, true, Hide),
            (true, MacOs, true, false, Hide),
            (true, MacOs, false, true, Close),
            (true, MacOs, false, false, Close),
            // Linux: closing the window always quits.
            (true, Linux, true, true, Close),
            (true, Linux, true, false, Close),
            (true, Linux, false, true, Close),
            (true, Linux, false, false, Close),
            // Any window but the main one closes, everywhere.
            (false, Windows, true, true, Close),
            (false, Windows, true, false, Close),
            (false, Windows, false, true, Close),
            (false, Windows, false, false, Close),
            (false, MacOs, true, true, Close),
            (false, MacOs, true, false, Close),
            (false, MacOs, false, true, Close),
            (false, MacOs, false, false, Close),
            (false, Linux, true, true, Close),
            (false, Linux, true, false, Close),
            (false, Linux, false, true, Close),
            (false, Linux, false, false, Close),
        ];
        let inputs: std::collections::HashSet<_> = cases
            .iter()
            .map(|&(main, platform, keep, tray, _)| (main, platform as u8, keep, tray))
            .collect();
        assert_eq!(inputs.len(), 24, "each of the 24 combinations once");
        for (main_window, platform, keep_running, tray_ready, expected) in cases {
            assert_eq!(
                close_action(main_window, platform, keep_running, tray_ready),
                expected,
                "main window {main_window}, {platform:?}, keep running {keep_running}, tray ready {tray_ready}"
            );
        }
    }

    /// `source` up to its test module, with whitespace removed, so line
    /// wrapping doesn't matter. LF line endings, whatever the checkout has.
    fn code_of(source: &str) -> String {
        let source = source.replace("\r\n", "\n");
        let end = source
            .find(&format!("#[cfg(test)]\nmod {} {{", "tests"))
            .unwrap_or(source.len());
        source[..end].split_whitespace().collect()
    }

    #[test]
    fn opening_the_main_window_waits_for_the_startup_reveal_and_looks_it_up_as_a_window() {
        // Until the startup task shows the window, it is that task's to
        // show (shell::startup_window). And get_webview_window finds a window
        // only while every webview in it has the window's label, which the
        // main window hasn't while the Browser panel's child webview is
        // attached: nothing would come to the front. Search strings built at
        // run time, so this test never matches itself.
        let code = code_of(include_str!("lifecycle.rs"));
        let open = code
            .find(&format!("pubfn{}(app:&AppHandle){{", "open_main_window"))
            .expect("lifecycle.rs has open_main_window");
        let body = &code[open..];
        let gate = body
            .find(&format!("if!startup_window::{}(){{", "revealed"))
            .expect("open_main_window checks that the startup task has shown the window");
        let lookup = body
            .find("app.get_")
            .expect("open_main_window looks the window up");
        assert!(gate < lookup, "check the reveal before showing anything");
        assert!(
            body[lookup..].starts_with(&format!("app.{}(MAIN_WINDOW)", "get_window")),
            "open_main_window must look the main window up with get_window"
        );
    }

    #[test]
    fn every_exit_runs_the_shutdown() {
        let code = code_of(include_str!("lifecycle.rs"));
        assert!(
            code.contains(&format!("RunEvent::Exit=>{}(),", "on_exit")),
            "on_run_event must run on_exit at RunEvent::Exit"
        );
        let start = code
            .find(&format!("pubfn{}(){{", "on_exit"))
            .expect("lifecycle.rs has on_exit");
        let body = &code[start..start + code[start..].find('}').unwrap()];
        assert!(
            body.contains(&format!("head_watcher::{}();", "shutdown")),
            "on_exit must drop the HEAD watchers"
        );
        assert!(
            body.contains(&format!("logging::{}();", "mark_clean_shutdown")),
            "on_exit must mark the shutdown clean"
        );
    }

    #[test]
    fn no_exit_request_is_ever_prevented() {
        // Only a close request hides the window: Quit Fleetify, Cmd+Q,
        // Restart to update and every other exit or restart must exit. The
        // needle is put together at run time, so the walk doesn't find it in
        // this file.
        let needle = format!(".{}(", "prevent_exit");
        let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut pending = vec![src];
        let mut hits = Vec::new();
        let mut walked = 0;
        while let Some(dir) = pending.pop() {
            for entry in std::fs::read_dir(&dir).expect("read a source directory") {
                let path = entry.expect("read a directory entry").path();
                if path.is_dir() {
                    pending.push(path);
                } else if path.extension().is_some_and(|ext| ext == "rs") {
                    walked += 1;
                    let text = std::fs::read_to_string(&path).expect("read a source file");
                    if text.contains(&needle) {
                        hits.push(path.display().to_string());
                    }
                }
            }
        }
        assert!(walked > 10, "the walk found only {walked} source files");
        assert!(hits.is_empty(), "{hits:#?} prevent an exit request");
    }
}
