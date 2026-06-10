//! PTY bridge — faithful with the Electron `node-pty` wrapper in main.cjs.
//! Per-id `pty:data:<id>` / `pty:exit:<id>` events, write/resize/kill
//! commands. portable-pty handles the win/mac/linux backends.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::thread;

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde_json::json;
use tauri::{AppHandle, Emitter};

struct PtyEntry {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn std::io::Write + Send>,
    // Hold the Child so we can kill it; portable-pty children expose .kill().
    child: Box<dyn portable_pty::Child + Send + Sync>,
}

fn registry() -> &'static Mutex<HashMap<String, PtyEntry>> {
    static R: OnceLock<Mutex<HashMap<String, PtyEntry>>> = OnceLock::new();
    R.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Spawn a PTY running `shell` (or $SHELL / cmd.exe). Returns a uuid the
/// renderer uses to address subsequent write/resize/kill calls and to
/// subscribe to `pty:data:<id>` + `pty:exit:<id>` events.
pub fn spawn(
    app: AppHandle,
    shell: Option<String>,
    cwd: Option<String>,
    env: Option<HashMap<String, String>>,
    cols: Option<u16>,
    rows: Option<u16>,
) -> Result<String, String> {
    let program = shell.unwrap_or_else(|| {
        if cfg!(windows) {
            std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".into())
        } else {
            std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into())
        }
    });
    spawn_argv(app, program, Vec::new(), cwd, env, cols, rows)
}

/// Like [`spawn`] but runs `program` with explicit `args` — used by the
/// account-login flow, which runs e.g. `claude login` / `opencode auth login`
/// in a per-account HOME so the agent writes its credentials into the isolated
/// account dir. Shares the same registry + `pty:data`/`pty:exit` events, so the
/// renderer drives it with the existing terminal component.
pub fn spawn_argv(
    app: AppHandle,
    program: String,
    args: Vec<String>,
    cwd: Option<String>,
    env: Option<HashMap<String, String>>,
    cols: Option<u16>,
    rows: Option<u16>,
) -> Result<String, String> {
    let pty_system = native_pty_system();
    // Honour the renderer's measured size from xterm.js + FitAddon. Without
    // this the PTY booted at a fixed 100x30 even on a wider webview, so the
    // shell's first prompt drew at 100 cols and a long zsh / powerlevel10k
    // path wrapped onto a second line before the renderer's resize landed —
    // leaving the cursor sitting on a "> " on the line BELOW the path. Sane
    // floors (40 cols / 8 rows) guard against the worst transient measure
    // (a momentarily-collapsed pane reporting 0).
    let pair = pty_system
        .openpty(PtySize {
            rows: rows.unwrap_or(30).max(8),
            cols: cols.unwrap_or(100).max(40),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let mut cmd = CommandBuilder::new(&program);
    for a in &args {
        cmd.arg(a);
    }
    if let Some(c) = cwd {
        cmd.cwd(c);
    }
    // Inherit the parent's environment first — portable_pty's CommandBuilder
    // gives the child an EMPTY env by default, which is what made the
    // in-app terminal run with no TERM, no PATH, no HOME → "TERM environment
    // variable not set", no colours, `clear` failing, prompts missing.
    // We pass through everything we have and then force-set a sensible
    // colour-capable TERM + COLORTERM so the shell renders ANSI escapes
    // properly. Caller-supplied env (the `env` arg) overrides afterwards.
    for (k, v) in std::env::vars() {
        cmd.env(k, v);
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    if let Some(e) = env {
        for (k, v) in e {
            cmd.env(k, v);
        }
    }

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    // Drop the slave so the child's stdout EOFs when the child exits.
    drop(pair.slave);

    let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let id = uuid::Uuid::new_v4().to_string();

    // Data-pump thread: emits pty:data:<id> events with payload {id,data}.
    let id_data = id.clone();
    let app_data = app.clone();
    thread::spawn(move || {
        let mut reader = reader;
        let mut buf = [0u8; 8192];
        loop {
            match std::io::Read::read(&mut reader, &mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let chunk = String::from_utf8_lossy(&buf[..n]).into_owned();
                    let _ = app_data.emit(
                        &format!("pty:data:{id_data}"),
                        json!({ "id": id_data, "data": chunk }),
                    );
                }
                Err(_) => break,
            }
        }
    });

    registry().lock().unwrap().insert(
        id.clone(),
        PtyEntry {
            master: pair.master,
            writer,
            child,
        },
    );

    // Exit-watch thread: waits on the child + emits pty:exit:<id>.
    let id_exit = id.clone();
    let app_exit = app.clone();
    thread::spawn(move || {
        // Loop polling until the entry is gone or the child reports an exit.
        loop {
            std::thread::sleep(std::time::Duration::from_millis(150));
            let mut guard = registry().lock().unwrap();
            let Some(entry) = guard.get_mut(&id_exit) else {
                return;
            };
            match entry.child.try_wait() {
                Ok(Some(status)) => {
                    let code = status.exit_code() as i64;
                    drop(guard);
                    let _ = app_exit.emit(
                        &format!("pty:exit:{id_exit}"),
                        json!({ "id": id_exit, "exitCode": code }),
                    );
                    registry().lock().unwrap().remove(&id_exit);
                    return;
                }
                Ok(None) => continue,
                Err(_) => {
                    drop(guard);
                    registry().lock().unwrap().remove(&id_exit);
                    return;
                }
            }
        }
    });

    Ok(id)
}

pub fn write(id: &str, data: &str) -> Result<(), String> {
    let mut guard = registry().lock().unwrap();
    let entry = guard
        .get_mut(id)
        .ok_or_else(|| "unknown pty id".to_string())?;
    std::io::Write::write_all(&mut entry.writer, data.as_bytes()).map_err(|e| e.to_string())
}

pub fn resize(id: &str, cols: u16, rows: u16) -> Result<(), String> {
    let guard = registry().lock().unwrap();
    let entry = guard.get(id).ok_or_else(|| "unknown pty id".to_string())?;
    entry
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())
}

pub fn kill(id: &str) -> Result<(), String> {
    let mut guard = registry().lock().unwrap();
    if let Some(mut entry) = guard.remove(id) {
        let _ = entry.child.kill();
    }
    Ok(())
}
