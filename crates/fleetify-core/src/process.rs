//! Constructors for child processes, which open no console window on Windows.
//!
//! A release build of the app is a GUI program with no console. Windows gives
//! every console program it starts (an agent CLI, a version check, `cmd`
//! running a `.cmd` shim…) a console of its own, and with it a window, even
//! when all three standard streams are pipes. Without a flag, each background
//! command would flash a window on the screen. [`command`] and
//! [`tokio_command`] pass `CREATE_NO_WINDOW`: the child gets a console without
//! a window, and the console programs it starts share that console unless they
//! ask for a new one, so they open no window either. The flag changes nothing
//! for a GUI program (an editor, the file manager, a browser), which shows its
//! windows as usual. On other platforms both are a plain `Command::new`.
//!
//! The workspace's `clippy.toml` disallows `std::process::Command::new` and
//! `tokio::process::Command::new`, so every child process in the workspace
//! starts from one of these two.

use std::ffi::OsStr;

/// The process creation flag that runs a console program without a console
/// window.
#[cfg(windows)]
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// A [`std::process::Command`] for `program` that, on Windows, starts it
/// without a console window (see [the module docs](crate::process)).
///
/// `creation_flags` replaces the flags rather than adding to them, so a caller
/// that needs another flag passes it together with `CREATE_NO_WINDOW`.
pub fn command(program: impl AsRef<OsStr>) -> std::process::Command {
    #[allow(clippy::disallowed_methods)] // every other spawn goes through here
    let mut command = std::process::Command::new(program);
    hide_console_window(&mut command);
    command
}

/// [`command`] for tokio: a [`tokio::process::Command`] for `program` that, on
/// Windows, starts it without a console window.
#[cfg(feature = "tokio")]
pub fn tokio_command(program: impl AsRef<OsStr>) -> tokio::process::Command {
    // What `tokio::process::Command::new` does, from a command with the flag.
    tokio::process::Command::from(command(program))
}

#[cfg(windows)]
fn hide_console_window(command: &mut std::process::Command) {
    use std::os::windows::process::CommandExt;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn hide_console_window(_: &mut std::process::Command) {}

#[cfg(test)]
mod tests {
    use super::*;

    /// Set in the child process the console window test re-runs itself in.
    const CHILD: &str = "FLEETIFY_PROCESS_TEST_CHILD";

    /// The test the child process runs, by its full name.
    const CHILD_TEST: &str = "process::tests::child_has_no_console_window";

    #[test]
    fn command_is_for_the_program_given() {
        let command = command("git");
        assert_eq!(command.get_program(), "git");
        assert_eq!(command.get_args().len(), 0);
    }

    #[cfg(feature = "tokio")]
    #[test]
    fn tokio_command_is_for_the_program_given() {
        let command = tokio_command("git");
        assert_eq!(command.as_std().get_program(), "git");
        assert_eq!(command.as_std().get_args().len(), 0);
        // As from `tokio::process::Command::new`.
        assert!(!command.get_kill_on_drop());
    }

    /// The child is this test binary, running the one test below, which on
    /// Windows fails if its process has a console window.
    #[test]
    fn a_child_started_through_command_runs_without_a_console_window() {
        let out = command(std::env::current_exe().unwrap())
            .args(["--exact", CHILD_TEST, "--ignored", "--test-threads=1"])
            .env(CHILD, "1")
            .output()
            .unwrap();
        let stdout = String::from_utf8_lossy(&out.stdout);
        let stderr = String::from_utf8_lossy(&out.stderr);
        assert!(
            out.status.success(),
            "the child process failed:\n{stdout}\n{stderr}"
        );
        assert!(
            stdout.contains("1 passed"),
            "the child process didn't run {CHILD_TEST}:\n{stdout}\n{stderr}"
        );
    }

    /// Run by [`a_child_started_through_command_runs_without_a_console_window`]
    /// in a child process. Run any other way, or off Windows, it checks
    /// nothing.
    #[test]
    #[ignore = "run by a_child_started_through_command_runs_without_a_console_window"]
    fn child_has_no_console_window() {
        #[cfg(windows)]
        {
            if std::env::var_os(CHILD).is_none() {
                return;
            }
            #[link(name = "kernel32")]
            unsafe extern "system" {
                fn GetConsoleWindow() -> *mut std::ffi::c_void;
            }
            // SAFETY: GetConsoleWindow takes no arguments; it returns the
            // window of the process's console, or null when it has none.
            let window = unsafe { GetConsoleWindow() };
            assert!(window.is_null(), "this process has a console window");
        }
    }
}
