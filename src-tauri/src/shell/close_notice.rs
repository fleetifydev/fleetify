//! The notice on the first close that hides the main window, on Windows.
//!
//! Windows 10 and 11 put a new notification-area icon in the hidden-icons
//! flyout, under the ^ arrow, so the first time a close hides the window
//! (shell::lifecycle), Fleetify would seem to have quit. That close explains
//! instead, once: the window stays while a message dialog says that
//! Fleetify keeps running and how to quit it, with Keep running (the
//! default, which hides the window) and Quit Fleetify. The notice is
//! recorded as shown before the dialog opens, so it never comes back,
//! whatever the answer, and even if Fleetify ends while it is open.
//!
//! Never on macOS, where Fleetify stays in the Dock, nor on Linux, where
//! closing the window quits ([`shows_notice`]). Only the dialog itself is
//! built for Windows alone; the rest is built everywhere, so its tests run
//! on every platform.

// Only Windows shows the notice: elsewhere, only the tests use most of this.
#![cfg_attr(not(windows), allow(dead_code))]

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use serde_json::Value;

use crate::shell::config;
use crate::shell::lifecycle::{CloseAction, Platform};

/// The key in `fleet.config.json` that records that the notice has been
/// shown. The shell sets it once ([`record_shown`]); Settings doesn't show
/// it.
pub const SHOWN_KEY: &str = "keepRunningNoticeShown";

/// The dialog's title.
pub const TITLE: &str = "Fleetify is still running";

/// The dialog's text.
pub const MESSAGE: &str = "Fleetify keeps running in the notification area, so your agents can keep working. To quit, right-click the Fleetify icon at the right end of the taskbar (it may be under the ^ arrow) and choose Quit Fleetify.\n\nYou can change this in Settings → General.";

/// The default button: hides the window, as every later close does.
pub const KEEP_RUNNING: &str = "Keep running";

/// The other button: quits, as the same item in the notification-area
/// icon's menu does.
pub const QUIT: &str = crate::shell::tray::QUIT_LABEL;

/// Set while the dialog is open: the window stays until it is answered.
static OPEN: AtomicBool = AtomicBool::new(false);

/// Set once the notice has been shown in this run, so that it shows once
/// even when it couldn't be recorded in `fleet.config.json`.
static SHOWN_THIS_RUN: AtomicBool = AtomicBool::new(false);

/// Whether the dialog is open. A close request then changes nothing: the
/// dialog's buttons decide (shell::lifecycle::on_close_requested).
pub fn is_open() -> bool {
    OPEN.load(Ordering::SeqCst)
}

/// Whether the notice has been shown: in this run, or before, as `cfg`, the
/// saved `fleet.config.json`, records it.
pub fn shown(cfg: Option<&Value>) -> bool {
    SHOWN_THIS_RUN.load(Ordering::SeqCst) || cfg.is_some_and(shown_from)
}

/// Whether `cfg`, the saved `fleet.config.json`, records the notice as
/// shown: only a saved `true` does.
pub fn shown_from(cfg: &Value) -> bool {
    cfg.get(SHOWN_KEY).and_then(Value::as_bool).unwrap_or(false)
}

/// Whether a close request shows the notice first: on Windows only, when
/// the close hides the main window (`action`, from
/// shell::lifecycle::close_action, which hides it only while the setting is
/// on and the notification-area icon is there), until the notice has been
/// shown once (`notice_shown`).
pub fn shows_notice(action: CloseAction, platform: Platform, notice_shown: bool) -> bool {
    action == CloseAction::Hide && platform == Platform::Windows && !notice_shown
}

/// Records in `dir`'s `fleet.config.json` that the notice has been shown.
/// Through config::update_config, which takes the lock every writer of the
/// file holds, and keeps every other setting.
pub fn record_shown(dir: &Path) -> std::io::Result<()> {
    config::update_config(dir, |cfg| {
        if let Some(cfg) = cfg.as_object_mut() {
            cfg.insert(SHOWN_KEY.into(), Value::Bool(true));
        }
    })
}

/// Whether the dialog's answer quits Fleetify, from the label of the button
/// that was pressed: only Quit Fleetify does. Keep running, a dialog
/// dismissed with Esc, Alt+F4 or its own close button (`None`), and one
/// that couldn't be shown (`None` too) keep Fleetify running: the window
/// hides.
pub fn quits(pressed: Option<&str>) -> bool {
    pressed == Some(QUIT)
}

/// Shows the notice for a close of `window`, the main window, and acts on
/// the answer when it comes. Returns whether the notice is showing; when it
/// couldn't be, the caller hides the window, as every later close does.
///
/// The dialog is the native task dialog, parented to the window, through
/// rfd: tauri-plugin-dialog's message dialog reports Esc, Alt+F4, the
/// dialog's close button and a dialog that failed as its second button, so
/// any of them would quit Fleetify; rfd reports them as `Cancel`. The
/// dialog runs on a thread of its own, so the event loop, and every window
/// and agent with it, goes on meanwhile. That thread first records the
/// notice as shown in `dir`, the settings folder, then shows the dialog and
/// hands the answer to the main thread ([`answer`]).
#[cfg(windows)]
pub fn show(window: &tauri::Window, dir: Option<std::path::PathBuf>) -> bool {
    // Built here, on the main thread, which reads the window's handle.
    let dialog = rfd::MessageDialog::new()
        .set_level(rfd::MessageLevel::Info)
        .set_title(TITLE)
        .set_description(MESSAGE)
        .set_buttons(rfd::MessageButtons::OkCancelCustom(
            KEEP_RUNNING.into(),
            QUIT.into(),
        ))
        .set_parent(window);
    let owner = window.clone();
    OPEN.store(true, Ordering::SeqCst);
    SHOWN_THIS_RUN.store(true, Ordering::SeqCst);
    let spawned = std::thread::Builder::new()
        .name("close-notice".into())
        .spawn(move || {
            if let Some(dir) = dir {
                if let Err(e) = record_shown(&dir) {
                    tracing::warn!(
                        "couldn't record the keep-running notice as shown, so the next launch shows it again: {e}"
                    );
                }
            }
            // A dialog that panicked counts as one dismissed: the window
            // hides, and closes work again.
            let pressed =
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || dialog.show()));
            let quit = match &pressed {
                Ok(rfd::MessageDialogResult::Custom(label)) => quits(Some(label.as_str())),
                _ => quits(None),
            };
            answer(owner, quit);
        });
    if let Err(e) = spawned {
        OPEN.store(false, Ordering::SeqCst);
        tracing::warn!("the keep-running notice couldn't be shown, so the window just hides: {e}");
        return false;
    }
    true
}

/// Acts on the dialog's answer, on the main thread: Quit Fleetify quits as
/// the notification-area icon's Quit Fleetify does, and anything else hides
/// the window. Close requests count again from then on.
#[cfg(windows)]
fn answer(window: tauri::Window, quit: bool) {
    use tauri::Manager;

    let app = window.app_handle().clone();
    let on_main_thread = app.run_on_main_thread(move || {
        OPEN.store(false, Ordering::SeqCst);
        if quit {
            crate::shell::lifecycle::quit(window.app_handle(), "the keep-running notice");
        } else if let Err(e) = crate::shell::lifecycle::hide(&window) {
            tracing::warn!("hiding the main window after the keep-running notice failed: {e}");
        }
    });
    if let Err(e) = on_main_thread {
        // The event loop has ended: Fleetify is quitting.
        OPEN.store(false, Ordering::SeqCst);
        tracing::warn!("couldn't act on the keep-running notice: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shell::lifecycle::close_action;
    use serde_json::json;

    /// What a close of the main window does on `platform`.
    fn close(platform: Platform, keep_running: bool, tray_ready: bool) -> CloseAction {
        close_action(true, platform, keep_running, tray_ready)
    }

    #[test]
    fn the_first_close_on_windows_shows_the_notice() {
        let action = close(Platform::Windows, true, true);
        assert_eq!(action, CloseAction::Hide);
        assert!(shows_notice(action, Platform::Windows, false));
    }

    #[test]
    fn once_shown_it_doesnt_show_again() {
        let action = close(Platform::Windows, true, true);
        assert!(!shows_notice(action, Platform::Windows, true));
    }

    #[test]
    fn with_the_setting_off_closing_quits_without_it() {
        let action = close(Platform::Windows, false, true);
        assert_eq!(action, CloseAction::Close);
        assert!(!shows_notice(action, Platform::Windows, false));
    }

    #[test]
    fn without_the_tray_icon_closing_quits_without_it() {
        let action = close(Platform::Windows, true, false);
        assert_eq!(action, CloseAction::Close);
        assert!(!shows_notice(action, Platform::Windows, false));
    }

    #[test]
    fn never_on_macos_or_linux() {
        // macOS hides the window too, and the Dock shows that Fleetify
        // still runs.
        assert_eq!(close(Platform::MacOs, true, false), CloseAction::Hide);
        for platform in [Platform::MacOs, Platform::Linux] {
            for action in [CloseAction::Hide, CloseAction::Close] {
                assert!(
                    !shows_notice(action, platform, false),
                    "{platform:?}, {action:?}"
                );
            }
        }
    }

    #[test]
    fn any_other_window_closes_without_it() {
        let action = close_action(false, Platform::Windows, true, true);
        assert!(!shows_notice(action, Platform::Windows, false));
    }

    #[test]
    fn only_a_saved_true_records_it_as_shown() {
        assert!(shown_from(&json!({ "keepRunningNoticeShown": true })));
        assert!(!shown_from(&json!({})));
        assert!(!shown_from(&json!({ "keepRunningNoticeShown": false })));
        assert!(!shown_from(&json!({ "keepRunningNoticeShown": "true" })));
        assert!(!shown_from(&json!({ "keepRunningNoticeShown": 1 })));
    }

    #[test]
    fn recording_it_keeps_every_other_setting() {
        let tmp = tempfile::tempdir().unwrap();
        // Saved as Settings saves: config_set's replace.
        config::replace_config_keeping_telemetry(
            tmp.path(),
            json!({ "theme": "dark", "keepRunningOnClose": true }),
        )
        .unwrap();
        record_shown(tmp.path()).unwrap();
        let cfg = config::load_config_from(tmp.path());
        assert!(shown_from(&cfg));
        assert_eq!(cfg["theme"], "dark");
        assert_eq!(cfg["keepRunningOnClose"], true);
    }

    #[test]
    fn recording_it_starts_a_settings_file_when_there_is_none() {
        let tmp = tempfile::tempdir().unwrap();
        record_shown(tmp.path()).unwrap();
        assert!(shown_from(&config::load_config_from(tmp.path())));
    }

    #[test]
    fn a_settings_file_that_isnt_valid_stays_as_it_is() {
        // update_config leaves a broken file alone: a save would drop every
        // other setting in it.
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("fleet.config.json"), "{ not json").unwrap();
        assert!(record_shown(tmp.path()).is_err());
        assert_eq!(
            std::fs::read_to_string(tmp.path().join("fleet.config.json")).unwrap(),
            "{ not json"
        );
    }

    #[test]
    fn only_quit_fleetify_quits() {
        assert!(quits(Some("Quit Fleetify")));
        assert!(!quits(Some(KEEP_RUNNING)));
        // Esc, Alt+F4, the dialog's close button, or no dialog at all.
        assert!(!quits(None));
    }

    #[test]
    fn the_notice_names_the_tray_menu_s_quit_and_the_setting() {
        assert_eq!(QUIT, "Quit Fleetify");
        assert!(MESSAGE.contains(&format!("choose {QUIT}.")), "{MESSAGE}");
        assert!(MESSAGE.contains("under the ^ arrow"), "{MESSAGE}");
        assert!(MESSAGE.contains("Settings → General"), "{MESSAGE}");
        assert_eq!(TITLE, "Fleetify is still running");
        assert_eq!(KEEP_RUNNING, "Keep running");
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
    fn the_notice_is_recorded_before_the_dialog_shows_and_never_blocks_the_event_loop() {
        // Recorded first, so a quit from the dialog, or a crash while it is
        // open, can't bring it back. And shown from a thread of its own: the
        // close request comes on the main thread, which must go on. Search
        // strings built at run time, so this test never matches itself.
        let code = code_of(include_str!("close_notice.rs"));
        let show = code
            .find(&format!("pubfn{}(window:&tauri::Window", "show"))
            .expect("close_notice.rs has show");
        let body = &code[show..];
        let spawn = body
            .find(&format!(".{}(move||{{", "spawn"))
            .expect("show spawns a thread");
        let record = body
            .find(&format!("{}(&dir)", "record_shown"))
            .expect("show records the notice");
        let dialog = body
            .find(&format!("dialog.{}()", "show"))
            .expect("show shows the dialog");
        assert!(
            spawn < record && record < dialog,
            "record, then show, on the thread"
        );
        assert!(!code.contains(&format!("{}_show", "blocking")));
    }
}
