//! PTY bridge — faithful with the Electron `node-pty` wrapper in main.cjs.
//! Per-id `pty:data:<id>` / `pty:exit:<id>` events, write/resize/kill
//! commands. portable-pty handles the win/mac/linux backends.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde_json::json;
use tauri::{AppHandle, Emitter};

/// Cap on the per-PTY output buffer. Login flows print a few hundred bytes; an
/// interactive shell could stream forever, so we keep only the most recent tail
/// (the login URL/code is read from the START, long before this fills).
const OUTPUT_CAP: usize = 256 * 1024;

struct PtyEntry {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn std::io::Write + Send>,
    // Hold the Child so we can kill it; portable-pty children expose .kill().
    child: Box<dyn portable_pty::Child + Send + Sync>,
    // All output emitted so far (capped tail). Lets a renderer that subscribes
    // to `pty:data:<id>` AFTER the child has already printed (Tauri drops
    // events with no listener) still recover the early bytes via `snapshot`.
    output: Arc<Mutex<String>>,
}

fn registry() -> &'static Mutex<HashMap<String, PtyEntry>> {
    static R: OnceLock<Mutex<HashMap<String, PtyEntry>>> = OnceLock::new();
    R.get_or_init(|| Mutex::new(HashMap::new()))
}

/// A plain piped child (no PTY) — used by [`spawn_piped`] for non-interactive
/// login flows. Shares the `pty:exit:<id>` event + `snapshot`/`kill` surface
/// with the ConPTY registry so the renderer drives both the same way.
struct ProcEntry {
    output: Arc<Mutex<String>>,
    child: std::process::Child,
}

fn proc_registry() -> &'static Mutex<HashMap<String, ProcEntry>> {
    static R: OnceLock<Mutex<HashMap<String, ProcEntry>>> = OnceLock::new();
    R.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Spawn `program args` with piped stdout+stderr (NOT a PTY) and stream both
/// into a buffer readable via [`snapshot`]; emit `pty:exit:<id>` on exit.
///
/// Used by the in-chat login flow. A device-OAuth CLI like `grok login` writes
/// its URL/code to **stderr**, needs no TTY, and — crucially — piped output is
/// clean, whereas a ConPTY wraps everything in cursor-positioning escape codes
/// that mangle the URL. Inherits the parent environment (the System account's
/// real HOME) plus any `env` overrides; `std::process::Command` inherits env by
/// default, so we only layer overrides on top.
pub fn spawn_piped(
    app: AppHandle,
    program: String,
    args: Vec<String>,
    cwd: Option<String>,
    env: Option<HashMap<String, String>>,
) -> Result<String, String> {
    let mut cmd = std::process::Command::new(&program);
    cmd.args(&args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    if let Some(c) = cwd {
        cmd.current_dir(c);
    }
    if let Some(e) = env {
        for (k, v) in e {
            cmd.env(k, v);
        }
    }
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let id = uuid::Uuid::new_v4().to_string();
    let output = Arc::new(Mutex::new(String::new()));

    // Drain stdout AND stderr into the shared buffer (capped tail). grok writes
    // to stderr; capture both so nothing is missed.
    let streams: [Option<Box<dyn std::io::Read + Send>>; 2] = [
        child
            .stdout
            .take()
            .map(|s| Box::new(s) as Box<dyn std::io::Read + Send>),
        child
            .stderr
            .take()
            .map(|s| Box::new(s) as Box<dyn std::io::Read + Send>),
    ];
    for stream in streams.into_iter().flatten() {
        let out = output.clone();
        thread::spawn(move || {
            let mut reader = stream;
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let mut g = out.lock().unwrap();
                        g.push_str(&String::from_utf8_lossy(&buf[..n]));
                        if g.len() > OUTPUT_CAP {
                            let mut cut = g.len() - OUTPUT_CAP;
                            while !g.is_char_boundary(cut) {
                                cut += 1;
                            }
                            *g = g.split_off(cut);
                        }
                    }
                    Err(_) => break,
                }
            }
        });
    }

    proc_registry()
        .lock()
        .unwrap()
        .insert(id.clone(), ProcEntry { output, child });

    // Exit-watch: poll for the child's exit, emit pty:exit:<id>, then reap.
    let id_exit = id.clone();
    let app_exit = app.clone();
    thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_millis(200));
        let mut guard = proc_registry().lock().unwrap();
        let Some(entry) = guard.get_mut(&id_exit) else {
            return;
        };
        match entry.child.try_wait() {
            Ok(Some(status)) => {
                let code = status.code().unwrap_or(-1) as i64;
                drop(guard);
                let _ = app_exit.emit(
                    &format!("pty:exit:{id_exit}"),
                    json!({ "id": id_exit, "exitCode": code }),
                );
                proc_registry().lock().unwrap().remove(&id_exit);
                return;
            }
            Ok(None) => continue,
            Err(_) => {
                drop(guard);
                proc_registry().lock().unwrap().remove(&id_exit);
                return;
            }
        }
    });

    Ok(id)
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

    // Shared output buffer — appended by the pump thread, read by `snapshot`.
    let output = Arc::new(Mutex::new(String::new()));

    // Data-pump thread: appends to the buffer THEN emits pty:data:<id>. The
    // append-before-emit order means a `snapshot` taken after a late subscribe
    // never misses bytes the renderer's listener wasn't yet around to receive.
    let id_data = id.clone();
    let app_data = app.clone();
    let output_pump = output.clone();
    thread::spawn(move || {
        let mut reader = reader;
        let mut buf = [0u8; 8192];
        loop {
            match std::io::Read::read(&mut reader, &mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let chunk = String::from_utf8_lossy(&buf[..n]).into_owned();
                    {
                        let mut g = output_pump.lock().unwrap();
                        g.push_str(&chunk);
                        if g.len() > OUTPUT_CAP {
                            // Keep the most recent OUTPUT_CAP bytes, cut at a
                            // char boundary so split_off can't panic.
                            let mut cut = g.len() - OUTPUT_CAP;
                            while !g.is_char_boundary(cut) {
                                cut += 1;
                            }
                            *g = g.split_off(cut);
                        }
                    }
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
            output,
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

/// All output a PTY (or piped proc) has emitted so far (capped tail). `None`
/// once the child has exited and its entry was reaped. Lets a renderer recover
/// output printed before its `pty:data:<id>` listener finished registering.
pub fn snapshot(id: &str) -> Option<String> {
    if let Some(s) = registry()
        .lock()
        .unwrap()
        .get(id)
        .map(|e| e.output.lock().unwrap().clone())
    {
        return Some(s);
    }
    proc_registry()
        .lock()
        .unwrap()
        .get(id)
        .map(|e| e.output.lock().unwrap().clone())
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
    if let Some(mut entry) = registry().lock().unwrap().remove(id) {
        let _ = entry.child.kill();
        return Ok(());
    }
    if let Some(mut entry) = proc_registry().lock().unwrap().remove(id) {
        let _ = entry.child.kill();
    }
    Ok(())
}
