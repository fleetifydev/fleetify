//! The notification-area icon on Windows (tauri's `tray-icon` feature is on
//! for Windows builds only, see src-tauri/Cargo.toml). Once a close has
//! hidden the main window (shell::lifecycle), the icon opens it again, with a
//! click or Open Fleetify in its menu, and Quit Fleetify in that menu quits.
//! Its mark follows the taskbar's theme: white on a dark taskbar, dark on a
//! light one ([`tray_icon_png`]). The app's own icon, the window's and the
//! installers', stays as it is.
//!
//! Not built on Linux, where a tray icon needs libayatana-appindicator at
//! run time and not every desktop shows one, nor on macOS, where the Dock
//! does the icon's job. [`tray_icon_png`] is built everywhere, so its test
//! runs on every platform.

use std::sync::atomic::{AtomicBool, Ordering};

use crate::shell::ipc::{ICON_DARK_PNG, ICON_LIGHT_PNG};

/// Set once the icon is in the notification area. A close hides the main
/// window on Windows only then: without the icon, nothing would open the
/// window again or quit Fleetify.
static READY: AtomicBool = AtomicBool::new(false);

/// Whether the notification-area icon is there. Always false off Windows.
pub fn ready() -> bool {
    READY.load(Ordering::SeqCst)
}

/// The menu item that quits. The notice on the first close names it too
/// (shell::close_notice).
pub const QUIT_LABEL: &str = "Quit Fleetify";

/// The tray icon's image for the taskbar's theme, given the
/// `SystemUsesLightTheme` value under
/// `HKCU\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize` (the
/// taskbar's setting, not the apps' `AppsUseLightTheme`), or `None` when
/// there is none: the dark mark (`logo-mark-dark.png`) on a light taskbar,
/// any value but 0, as Windows reads its switches, and the white mark
/// (`logo-mark-light.png`) on a dark one, 0 or no value. Windows scales the
/// image to the notification area's size.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn tray_icon_png(system_uses_light_theme: Option<u32>) -> &'static [u8] {
    match system_uses_light_theme {
        Some(value) if value != 0 => ICON_DARK_PNG,
        _ => ICON_LIGHT_PNG,
    }
}

#[cfg(windows)]
pub use notification_area::create;

#[cfg(windows)]
mod notification_area {
    use std::sync::atomic::Ordering;

    use tauri::image::Image;
    use tauri::menu::{MenuBuilder, MenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
    use tauri::AppHandle;
    use winreg::enums::{HKEY_CURRENT_USER, KEY_NOTIFY, KEY_QUERY_VALUE};
    use winreg::RegKey;

    use super::{tray_icon_png, QUIT_LABEL, READY};
    use crate::shell::lifecycle::{open_main_window, quit};

    /// The icon's id, to find it again when its mark changes.
    const TRAY_ID: &str = "fleetify";
    /// The menu items' ids. The tray's menu handler gets every menu's
    /// events, so they say whose they are.
    const OPEN_ID: &str = "fleetify-tray-open";
    const QUIT_ID: &str = "fleetify-tray-quit";

    /// Where Windows keeps the taskbar's theme.
    const PERSONALIZE: &str = r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize";
    const SYSTEM_USES_LIGHT_THEME: &str = "SystemUsesLightTheme";

    /// Puts the icon in the notification area, at startup (lib.rs's setup).
    /// If that fails, closing the window quits, as before (see [`READY`]).
    pub fn create(app: &AppHandle) {
        match build(app) {
            Ok(()) => READY.store(true, Ordering::SeqCst),
            Err(e) => tracing::warn!(
                "the notification-area icon couldn't be added, so closing the window quits Fleetify: {e}"
            ),
        }
    }

    fn build(app: &AppHandle) -> tauri::Result<()> {
        let theme_key = personalize_key();
        let theme = system_uses_light_theme(theme_key.as_ref());
        let open_item = MenuItem::with_id(app, OPEN_ID, "Open Fleetify", true, None::<&str>)?;
        let quit_item = MenuItem::with_id(app, QUIT_ID, QUIT_LABEL, true, None::<&str>)?;
        let menu = MenuBuilder::new(app)
            .item(&open_item)
            .separator()
            .item(&quit_item)
            .build()?;
        TrayIconBuilder::with_id(TRAY_ID)
            .icon(Image::from_bytes(tray_icon_png(theme))?)
            .tooltip("Fleetify")
            .menu(&menu)
            // A left click opens the window; the menu is for a right click.
            .show_menu_on_left_click(false)
            .on_menu_event(|app, event| match event.id().as_ref() {
                OPEN_ID => open_main_window(app),
                QUIT_ID => quit(app, "the notification-area icon"),
                _ => {}
            })
            .on_tray_icon_event(|tray, event| {
                if opens_window(&event) {
                    open_main_window(tray.app_handle());
                }
            })
            .build(app)?;
        if let Some(key) = theme_key {
            follow_taskbar_theme(app.clone(), key, theme);
        }
        Ok(())
    }

    /// A left click (on release) or double-click opens the window.
    fn opens_window(event: &TrayIconEvent) -> bool {
        matches!(
            event,
            TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } | TrayIconEvent::DoubleClick {
                button: MouseButton::Left,
                ..
            }
        )
    }

    /// The key that holds the taskbar's theme, opened to read it and to wait
    /// for changes. None where it doesn't exist: no light taskbar there.
    fn personalize_key() -> Option<RegKey> {
        RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey_with_flags(PERSONALIZE, KEY_QUERY_VALUE | KEY_NOTIFY)
            .inspect_err(|e| {
                tracing::info!("no taskbar theme to follow ({e}); the tray icon stays white")
            })
            .ok()
    }

    /// `SystemUsesLightTheme` in `key`, or None when either is missing.
    fn system_uses_light_theme(key: Option<&RegKey>) -> Option<u32> {
        key?.get_value::<u32, _>(SYSTEM_USES_LIGHT_THEME).ok()
    }

    /// Switches the icon's mark whenever the taskbar's theme changes. A
    /// thread of its own waits on `key` for Windows to say that one of its
    /// values changed: no polling, and it catches a taskbar-only change,
    /// which the window's `ThemeChanged` (the apps' theme) doesn't. The
    /// thread waits until the process ends; if waiting fails, the mark stays
    /// as it is.
    fn follow_taskbar_theme(app: AppHandle, key: RegKey, mut theme: Option<u32>) {
        let watcher = std::thread::Builder::new()
            .name("tray-theme".into())
            .spawn(move || loop {
                if let Err(status) = wait_for_a_change(&key) {
                    tracing::warn!(
                        status,
                        "can't follow the taskbar's theme any more; the tray icon keeps its mark"
                    );
                    return;
                }
                let now = system_uses_light_theme(Some(&key));
                if tray_icon_png(now) != tray_icon_png(theme) {
                    set_mark(&app, now);
                }
                theme = now;
            });
        if let Err(e) = watcher {
            tracing::warn!("can't follow the taskbar's theme; the tray icon keeps its mark: {e}");
        }
    }

    /// Blocks until a value of `key` is set. Err holds the Win32 error.
    fn wait_for_a_change(key: &RegKey) -> Result<(), u32> {
        use windows_sys::Win32::Foundation::ERROR_SUCCESS;
        use windows_sys::Win32::System::Registry::{
            RegNotifyChangeKeyValue, REG_NOTIFY_CHANGE_LAST_SET,
        };
        // SAFETY: `key` is an open registry key with KEY_NOTIFY access, and
        // it outlives the call. Without an event and with fAsynchronous
        // FALSE, the call only blocks this thread until a value of the key
        // (not of its subkeys) changes.
        let status = unsafe {
            RegNotifyChangeKeyValue(key.raw_handle(), 0, REG_NOTIFY_CHANGE_LAST_SET, 0, 0)
        };
        if status == ERROR_SUCCESS {
            Ok(())
        } else {
            Err(status)
        }
    }

    /// Gives the icon the mark for `theme`.
    fn set_mark(app: &AppHandle, theme: Option<u32>) {
        let Some(tray) = app.tray_by_id(TRAY_ID) else {
            return;
        };
        let set =
            Image::from_bytes(tray_icon_png(theme)).and_then(|icon| tray.set_icon(Some(icon)));
        if let Err(e) = set {
            tracing::warn!("switching the tray icon to the taskbar's theme failed: {e}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Which mark `png` is, for readable failures.
    fn mark(png: &[u8]) -> &'static str {
        if png == ICON_DARK_PNG {
            "dark"
        } else if png == ICON_LIGHT_PNG {
            "white"
        } else {
            "neither"
        }
    }

    #[test]
    fn a_light_taskbar_gets_the_dark_mark() {
        assert_eq!(mark(tray_icon_png(Some(1))), "dark");
    }

    #[test]
    fn a_dark_taskbar_gets_the_white_mark() {
        assert_eq!(mark(tray_icon_png(Some(0))), "white");
    }

    #[test]
    fn without_the_value_the_taskbar_is_dark() {
        // Windows 10 before 1903 has no light taskbar, and no such value.
        assert_eq!(mark(tray_icon_png(None)), "white");
    }

    #[test]
    fn any_value_but_zero_counts_as_on_as_for_any_windows_switch() {
        assert_eq!(mark(tray_icon_png(Some(2))), "dark");
        assert_eq!(mark(tray_icon_png(Some(u32::MAX))), "dark");
    }

    #[test]
    fn the_two_marks_are_different_images() {
        assert_ne!(ICON_LIGHT_PNG, ICON_DARK_PNG);
    }
}
