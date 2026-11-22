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

/// The icon's two marks, white and dark, at 32 px: scripts/icons.mjs makes
/// them from public/logo-mark-light.svg and public/logo-mark-dark.svg.
/// Windows draws the icon at 16 to 24 px on most screens, and a 32 px image
/// scales down to that more cleanly than the 256 px taskbar glyphs.
const TRAY_LIGHT_PNG: &[u8] = include_bytes!("../../icons/tray-mark-light.png");
const TRAY_DARK_PNG: &[u8] = include_bytes!("../../icons/tray-mark-dark.png");

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
/// there is none: the dark mark (`tray-mark-dark.png`) on a light taskbar,
/// any value but 0, as Windows reads its switches, and the white mark
/// (`tray-mark-light.png`) on a dark one, 0 or no value. Windows scales the
/// image to the notification area's size.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn tray_icon_png(system_uses_light_theme: Option<u32>) -> &'static [u8] {
    match system_uses_light_theme {
        Some(value) if value != 0 => TRAY_DARK_PNG,
        _ => TRAY_LIGHT_PNG,
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
    use windows_sys::Win32::Foundation::{
        CloseHandle, GetLastError, ERROR_SUCCESS, HANDLE, WAIT_FAILED, WAIT_OBJECT_0,
    };
    use windows_sys::Win32::System::Registry::{
        RegNotifyChangeKeyValue, REG_NOTIFY_CHANGE_LAST_SET,
    };
    use windows_sys::Win32::System::Threading::{CreateEventW, WaitForSingleObject, INFINITE};
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

    /// Switches the icon's mark whenever the taskbar's theme changes, from
    /// `shown`, the theme of the mark it was built with. A thread of its own
    /// waits on `key` for Windows to say that one of its values changed
    /// ([`watch_taskbar_theme`]): no polling, and it catches a taskbar-only
    /// change, which the window's `ThemeChanged` (the apps' theme) doesn't.
    /// The thread waits until the process ends; once a call fails, it ends,
    /// and the mark stays as it is.
    fn follow_taskbar_theme(app: AppHandle, key: RegKey, shown: Option<u32>) {
        let watcher = std::thread::Builder::new()
            .name("tray-theme".into())
            .spawn(move || {
                let error = match ChangeEvent::new() {
                    Ok(event) => {
                        let error = watch_taskbar_theme(&app, &key, &event, shown);
                        // The key first: closing it ends the registration
                        // that signals the event.
                        drop(key);
                        drop(event);
                        error
                    }
                    Err(error) => error,
                };
                tracing::warn!(
                    error,
                    "can't follow the taskbar's theme any more; the tray icon keeps its mark"
                );
            });
        if let Err(e) = watcher {
            tracing::warn!("can't follow the taskbar's theme; the tray icon keeps its mark: {e}");
        }
    }

    /// Keeps the icon's mark on the taskbar's theme until a call fails, and
    /// returns that call's Win32 error. `shown` is the theme of the mark
    /// the icon has.
    ///
    /// Each round registers for the next change to `key` first, then reads
    /// the theme, then waits for `event`. Any change after the registration
    /// signals the event, so the wait returns and the next round reads
    /// again. Reading first and registering after would miss a change in
    /// between: switching the theme writes AppsUseLightTheme and
    /// SystemUsesLightTheme back to back, and the first write's wake-up
    /// could read the old taskbar value and register only after the
    /// second, leaving the wrong mark until the next switch.
    fn watch_taskbar_theme(
        app: &AppHandle,
        key: &RegKey,
        event: &ChangeEvent,
        mut shown: Option<u32>,
    ) -> u32 {
        loop {
            if let Err(error) = notify_on_change(key, event) {
                return error;
            }
            let now = system_uses_light_theme(Some(key));
            if tray_icon_png(now) != tray_icon_png(shown) {
                set_mark(app, now);
            }
            shown = now;
            if let Err(error) = event.wait() {
                return error;
            }
        }
    }

    /// Asks Windows to signal `event` at the next change to a value of
    /// `key` (not of its subkeys), and returns at once. Err holds the Win32
    /// error.
    fn notify_on_change(key: &RegKey, event: &ChangeEvent) -> Result<(), u32> {
        // SAFETY: `key` is an open registry key with KEY_NOTIFY access and
        // `event` an open event handle; the thread that watches keeps both
        // until it ends, and it is the thread that registers. With
        // fAsynchronous TRUE the call returns at once, and Windows signals
        // the event at the key's next change, or when the key is closed.
        let status = unsafe {
            RegNotifyChangeKeyValue(key.raw_handle(), 0, REG_NOTIFY_CHANGE_LAST_SET, event.0, 1)
        };
        if status == ERROR_SUCCESS {
            Ok(())
        } else {
            Err(status)
        }
    }

    /// An unnamed auto-reset event for RegNotifyChangeKeyValue to signal,
    /// closed when dropped.
    struct ChangeEvent(HANDLE);

    impl ChangeEvent {
        /// A new event, not signaled. Err holds the Win32 error.
        fn new() -> Result<Self, u32> {
            // SAFETY: no security attributes and no name, so no other
            // process can open it. Auto-reset (bManualReset FALSE): a wait
            // that returns resets it. Not signaled (bInitialState FALSE).
            let handle = unsafe { CreateEventW(std::ptr::null(), 0, 0, std::ptr::null()) };
            if handle == 0 {
                // SAFETY: reads the error CreateEventW just set.
                Err(unsafe { GetLastError() })
            } else {
                Ok(Self(handle))
            }
        }

        /// Blocks until the event is signaled. Err holds the Win32 error.
        fn wait(&self) -> Result<(), u32> {
            // SAFETY: self.0 is an open event handle until drop.
            match unsafe { WaitForSingleObject(self.0, INFINITE) } {
                WAIT_OBJECT_0 => Ok(()),
                // SAFETY: reads the error the failed wait just set.
                WAIT_FAILED => Err(unsafe { GetLastError() }),
                other => Err(other),
            }
        }
    }

    impl Drop for ChangeEvent {
        fn drop(&mut self) {
            // SAFETY: self.0 is the event handle this value owns, and only
            // this closes it.
            unsafe { CloseHandle(self.0) };
        }
    }

    /// Gives the icon the mark for `theme`. From the watching thread too:
    /// TrayIcon::set_icon runs the change on the main thread.
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
        if png == TRAY_DARK_PNG {
            "dark"
        } else if png == TRAY_LIGHT_PNG {
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
        assert_ne!(TRAY_LIGHT_PNG, TRAY_DARK_PNG);
    }

    #[test]
    fn each_mark_is_32_px_and_its_colour() {
        // 32 px, not the 256 px taskbar glyphs: Windows scales the image to
        // the notification area's 16 to 24 px. The white mark is white and
        // the dark one dark, so neither was swapped for the other.
        for (png, name, colour) in [
            (TRAY_LIGHT_PNG, "white", 255u8),
            (TRAY_DARK_PNG, "dark", 10u8),
        ] {
            let image = tauri::image::Image::from_bytes(png).expect("a PNG");
            assert_eq!((image.width(), image.height()), (32, 32), "{name}");
            let opaque: Vec<&[u8]> = image
                .rgba()
                .chunks(4)
                .filter(|pixel| pixel[3] == 255)
                .collect();
            assert!(opaque.len() > 50, "the {name} mark has no solid bars");
            for pixel in opaque {
                for channel in &pixel[..3] {
                    assert!(
                        channel.abs_diff(colour) <= 8,
                        "the {name} mark has a pixel {pixel:?}"
                    );
                }
            }
        }
    }

    #[test]
    fn the_theme_watcher_registers_before_it_reads_and_waits_for_an_event() {
        // Windows-only code, read as text so the check runs everywhere.
        // Registered first, then read: a change between the two still
        // signals the event, so the wait that follows returns and the next
        // round reads again. Search strings built at run time, so this test
        // never matches itself. Whitespace removed, so line wrapping
        // doesn't matter.
        let source = include_str!("tray.rs").replace("\r\n", "\n");
        let end = source
            .find(&format!("#[cfg(test)]\nmod {} {{", "tests"))
            .unwrap_or(source.len());
        let code: String = source[..end].split_whitespace().collect();
        let watch = code
            .find(&format!("fn{}(", "watch_taskbar_theme"))
            .expect("tray.rs has watch_taskbar_theme");
        let body = &code[watch..];
        let register = body
            .find(&format!("{}(key,event)", "notify_on_change"))
            .expect("the watcher registers for the next change");
        let read = body
            .find(&format!("{}(Some(key))", "system_uses_light_theme"))
            .expect("the watcher reads the theme");
        let wait = body
            .find(&format!("event.{}()", "wait"))
            .expect("the watcher waits for the event");
        assert!(register < read && read < wait, "register, read, then wait");
        // Asynchronous registration, with the event: fAsynchronous TRUE.
        assert!(code.contains(&format!(
            "{}(key.raw_handle(),0,REG_NOTIFY_CHANGE_LAST_SET,event.0,1)",
            "RegNotifyChangeKeyValue"
        )));
    }
}
