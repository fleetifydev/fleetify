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
) -> Result<String, String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize { rows: 30, cols: 100, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;

    let shell = shell.unwrap_or_else(|| {
        if cfg!(windows) {
            std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".into())
        } else {
            std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into())
        }
    });
    let mut cmd = CommandBuilder::new(&shell);
    if let Some(c) = cwd {
        cmd.cwd(c);
    }
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
        PtyEntry { master: pair.master, writer, child },
    );

    // Exit-watch thread: waits on the child + emits pty:exit:<id>.
    let id_exit = id.clone();
    let app_exit = app.clone();
    thread::spawn(move || {
        // Loop polling until the entry is gone or the child reports an exit.
        loop {
            std::thread::sleep(std::time::Duration::from_millis(150));
            let mut guard = registry().lock().unwrap();
            let Some(entry) = guard.get_mut(&id_exit) else { return };
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
    let entry = guard.get_mut(id).ok_or_else(|| "unknown pty id".to_string())?;
    std::io::Write::write_all(&mut entry.writer, data.as_bytes())
        .map_err(|e| e.to_string())
}

pub fn resize(id: &str, cols: u16, rows: u16) -> Result<(), String> {
    let guard = registry().lock().unwrap();
    let entry = guard.get(id).ok_or_else(|| "unknown pty id".to_string())?;
    entry
        .master
        .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())
}

pub fn kill(id: &str) -> Result<(), String> {
    let mut guard = registry().lock().unwrap();
    if let Some(mut entry) = guard.remove(id) {
        let _ = entry.child.kill();
    }
    Ok(())
}
