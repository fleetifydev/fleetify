//! Antigravity SDK bridge — Python sidecar wrapping `google.antigravity`.
//!
//! Unlike the `agy` CLI bridge (sister file `antigravity.rs`) which
//! drives the user-facing `agy.exe` and inherits its server-side
//! model-pin restriction, this bridge talks to the **SDK** — a Python
//! package whose `LocalAgentConfig(model=...)` accepts a model id at
//! construction time and honours it for the turn. Result: real
//! per-(model × effort) selection from Fleetify's picker.
//!
//! Wire shape
//! ----------
//!
//! We spawn `<python> scripts/sidecars/fleet-antigravity-sdk.py`, write
//! ONE JSON request to its stdin (`{prompt, model, api_key,
//! conversation_id, workspaces}`), and tail stdout for NEWLINE-DELIMITED
//! JSON events (`init`, `delta`, `thinking`, `tool_start`/`tool_end`,
//! `conversation_id`, `usage`, `error`, `done`). Each event maps 1:1 to
//! a `BridgeEvent`. The sidecar exits as soon as the turn finishes — one
//! process per turn, simple lifecycle.
//!
//! Python resolution (Phase 1: system Python)
//! -------------------------------------------
//!
//! In order:
//!   1. `FLEETIFY_EMBEDDED_PYTHON` env var — manual override. Lets power
//!      users / CI pin a specific interpreter without altering PATH.
//!      Also the slot a future "lazy-fetch python-build-standalone"
//!      Settings toggle would write to (Phase 2 follow-up).
//!   2. `python3` on PATH (dev mode + most posix users).
//!   3. `python` on PATH (Windows fallback when Python launcher chose
//!      this name on install).
//!
//! When nothing resolves, the bridge emits a clean `BridgeEvent::Error`
//! telling the user how to install Python or use the SDK install button
//! in Settings → Agents → Antigravity SDK.
//!
//! We don't bundle Python with Fleetify in Phase 1 — Fleetify's audience
//! is developers who already have Python, and a 40-70 MB embed
//! disproportionately punishes that majority for the minority who don't.
//! The opt-in toggle (Phase 2) covers the latter without bloating
//! everyone else's download.
//!
//! Auth
//! ----
//!
//! The Gemini API key is stored in the OS keyring under
//! `Fleetify-Provider-antigravity-sdk` (same convention as every other
//! HTTP provider's key). The bridge reads it via `keys::get(...)` and
//! injects it into the JSON request — the sidecar also honours
//! `GEMINI_API_KEY` env var, so the bridge sets that too as a belt +
//! suspenders fallback.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Child;
use tokio::sync::{mpsc, Mutex};

use super::BridgeEvent;

pub struct AntigravitySdkBridge {
    pub session_id: String,
    pub agent_cwd: String,
    pub model: String,
    /// Maps the session's `permission_mode` to the autonomy mode the
    /// sidecar configures on `LocalAgentConfig`. Stored as the wire
    /// value (`"default"|"chat"|"autonomous"`) so the bridge stays a
    /// thin pass-through and the policy decisions live in one place
    /// (the Python sidecar's `_apply_autonomy_mode`).
    pub autonomy_mode: String,
    /// Captured from the sidecar's `{type:"conversation_id"}` event so
    /// subsequent turns can resume the same `Conversation`. SDK
    /// equivalent of the agy CLI bridge's per-cwd cache lookup.
    conversation_id: Arc<Mutex<Option<String>>>,
    is_staff: bool,
    agent_template: Option<String>,
    /// System prompt → the SDK's `LocalAgentConfig(system_instructions=)`.
    system_prompt: Option<String>,
    /// In-flight Python subprocess. `abort()` writes to `aborted` and
    /// kills the child; the spawn loop polls both.
    child: Arc<Mutex<Option<Child>>>,
    aborted: Arc<std::sync::atomic::AtomicBool>,
}

/// Translate a session's `permission_mode` (the existing field reused
/// across CLI + HTTP + SDK providers as the tool-autonomy knob) into
/// the wire value the SDK sidecar understands.
///
/// Mirrors the HTTP-agentic mapping in `routers::chat` so a user's
/// Perms chip selection has the same meaning regardless of which
/// provider their session targets:
///
/// - `"bypassPermissions"` → `"autonomous"` — everything allowed.
/// - `"acceptEdits"` → `"accept_edits"` — reads + writes (view_file /
///   list_dir / grep / edit_file / write_file) allowed; shell still
///   denied.
/// - anything else (including the new default `"default"`) → `"chat"`
///   — read tools allowed, writes + shell denied. Every session gets
///   workspace context; "default" is no longer the SDK's stock
///   `confirm_run_command` policy (which would hang on stdin in
///   headless dispatch).
pub fn autonomy_mode_from_permission(permission_mode: &str) -> &'static str {
    match permission_mode {
        "bypassPermissions" => "autonomous",
        // Native antigravity-sdk "always-proceed" is the autonomous tier.
        "always-proceed" => "autonomous",
        "acceptEdits" => "accept_edits",
        // Native "request-review" and "proceed-in-sandbox" fall to chat
        // (conservative safe default) until a dedicated SDK tier is wired.
        _ => "chat",
    }
}

impl AntigravitySdkBridge {
    pub fn new(
        session_id: impl Into<String>,
        agent_cwd: impl Into<String>,
        permission_mode: String,
        model_name: Option<String>,
        is_staff: bool,
        agent_template: Option<String>,
        system_prompt: Option<String>,
    ) -> Self {
        Self {
            session_id: session_id.into(),
            agent_cwd: agent_cwd.into(),
            // `agy-default` mirrors the picker's single fallback label
            // for CLI; the SDK accepts a real id (gemini-3.5-flash,
            // claude-sonnet-4-6, etc) when the user picks something
            // explicit from the picker.
            model: model_name.unwrap_or_else(|| "gemini-3.5-flash".into()),
            autonomy_mode: autonomy_mode_from_permission(&permission_mode).to_string(),
            is_staff,
            agent_template,
            system_prompt,
            conversation_id: Arc::new(Mutex::new(None)),
            child: Arc::new(Mutex::new(None)),
            aborted: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        }
    }

    pub async fn abort(&self) {
        self.aborted
            .store(true, std::sync::atomic::Ordering::SeqCst);
        if let Some(child) = self.child.lock().await.as_mut() {
            let _ = child.start_kill();
        }
    }

    /// Resolve the Python interpreter we'll spawn the sidecar with.
    /// Delegates to `services::python_runtime::locate_python` so the SDK
    /// spawn and the Settings/onboarding probe (`shell_check_python_runtime`)
    /// agree on the same interpreter — otherwise the user could see
    /// "Python detected" in the UI but the bridge still fails to spawn.
    fn resolve_python() -> Option<PathBuf> {
        crate::services::python_runtime::locate_python()
    }

    /// Path to the JSON-stream sidecar script. Mirrors how the MCP
    /// sidecar binaries are resolved (per CLAUDE.md "MCP sidecar
    /// binaries are resolved relative to the running exe"). Worktree
    /// dev builds keep the script next to `scripts/sidecars/`; release
    /// builds bundle it under Tauri's resource_dir as
    /// `resources/sidecars/`.
    fn resolve_sidecar_script() -> Option<PathBuf> {
        // FLEETIFY_RESOURCE_DIR is set by the Tauri shell at setup()
        // — points at the unpacked resources for a release build. In
        // dev mode it's unset, so we walk up from CARGO_MANIFEST_DIR
        // back to the workspace root.
        if let Ok(rd) = std::env::var("FLEETIFY_RESOURCE_DIR") {
            let p = Path::new(&rd)
                .join("sidecars")
                .join("fleet-antigravity-sdk.py");
            if p.exists() {
                return Some(p);
            }
        }
        // Dev fallback: <workspace>/scripts/sidecars/fleet-antigravity-sdk.py
        // CARGO_MANIFEST_DIR points at crates/fleetify-backend; pop two
        // levels and join the relative path.
        let manifest = std::env::var("CARGO_MANIFEST_DIR")
            .ok()
            .map(PathBuf::from)?;
        let candidate = manifest
            .parent()? // crates
            .parent()? // workspace root
            .join("scripts")
            .join("sidecars")
            .join("fleet-antigravity-sdk.py");
        candidate.exists().then_some(candidate)
    }

    /// Fetch the user's Gemini API key from the OS keyring (the same
    /// store every HTTP provider uses for its key). Falls back to the
    /// `GEMINI_API_KEY` env var when nothing's persisted — useful for
    /// scripted / CI launches.
    fn read_api_key() -> Option<String> {
        if let Ok(k) = std::env::var("GEMINI_API_KEY") {
            if !k.is_empty() {
                return Some(k);
            }
        }
        // Keyring entry name mirrors providers_link's convention. We
        // call via the keyring crate directly here rather than going
        // through providers_link to keep this module dispatch-only.
        keyring::Entry::new("Fleetify-Provider-antigravity-sdk", "default")
            .ok()
            .and_then(|e| e.get_password().ok())
            .filter(|s| !s.is_empty())
    }

    pub async fn send_message(
        &self,
        message: &str,
        _ctx: super::BridgeContext,
    ) -> anyhow::Result<mpsc::Receiver<BridgeEvent>> {
        // Refuse a container target up front. This bridge drives a
        // host-installed Python SDK which provisions its OWN remote sandbox,
        // so nesting it inside the user's container is meaningless as well as
        // broken. See `container::providers`.
        super::refuse_non_host_target(&self.agent_cwd)?;

        let (tx, rx) = mpsc::channel::<BridgeEvent>(32);

        // Resolve Python + script paths up front so we can surface a
        // clean error before any spawn work happens.
        let Some(python_path) = Self::resolve_python() else {
            let _ = tx
                .send(BridgeEvent::Init {
                    session_id: self.session_id.clone(),
                    claude_session_id: None,
                    model: self.model.clone(),
                    tools_count: 0,
                })
                .await;
            let _ = tx
                .send(BridgeEvent::Error {
                    error: "No Python interpreter found. The Antigravity SDK runs in a \
                         Python sidecar — install Python 3.10+ from python.org, then \
                         open Settings → Agents → Antigravity SDK → Install to fetch \
                         the `google-antigravity` package."
                        .into(),
                })
                .await;
            let _ = tx
                .send(BridgeEvent::Status {
                    status: "done".into(),
                })
                .await;
            return Ok(rx);
        };
        let Some(script_path) = Self::resolve_sidecar_script() else {
            let _ = tx
                .send(BridgeEvent::Error {
                    error: "Antigravity SDK sidecar script not found. Expected \
                            `scripts/sidecars/fleet-antigravity-sdk.py` in the \
                            workspace or `<resources>/sidecars/...` in a release \
                            build."
                        .into(),
                })
                .await;
            let _ = tx
                .send(BridgeEvent::Status {
                    status: "done".into(),
                })
                .await;
            return Ok(rx);
        };

        let api_key = Self::read_api_key();
        if api_key.is_none() {
            let _ = tx
                .send(BridgeEvent::Init {
                    session_id: self.session_id.clone(),
                    claude_session_id: None,
                    model: self.model.clone(),
                    tools_count: 0,
                })
                .await;
            let _ = tx
                .send(BridgeEvent::Error {
                    error: "Gemini API key not set. Open Settings → Agents → \
                         Antigravity SDK and paste a key from Google AI Studio \
                         (https://aistudio.google.com/apikey). The CLI \
                         (`Antigravity`) uses OAuth and doesn't need this — \
                         the SDK requires its own key."
                        .into(),
                })
                .await;
            let _ = tx
                .send(BridgeEvent::Status {
                    status: "done".into(),
                })
                .await;
            return Ok(rx);
        }
        let api_key = api_key.unwrap();

        // Merge fleet builtins + user registry for THIS session, then
        // render to the SDK's transport-tagged server list. Computed here
        // (sync registry read) and moved into the spawn task below.
        let mcp_map = crate::services::mcp_dispatch::build_merged_map(
            &self.session_id,
            self.is_staff,
            self.agent_template.as_deref(),
        );
        let mcp_servers = crate::services::mcp_dispatch::to_sdk_mcp_servers(&mcp_map);
        let system_instructions = self.system_prompt.clone();

        let session_id_out = self.session_id.clone();
        let model_out = self.model.clone();
        let agent_cwd = self.agent_cwd.clone();
        let autonomy_mode = self.autonomy_mode.clone();
        let conv_handle = self.conversation_id.clone();
        let child_handle = self.child.clone();
        let aborted = self.aborted.clone();
        let prompt = message.to_string();
        let cached_conv_id = self.conversation_id.lock().await.clone();

        tracing::info!(
            session_id = %session_id_out,
            python = %python_path.display(),
            script = %script_path.display(),
            cwd = %agent_cwd,
            model = %model_out,
            mode = %autonomy_mode,
            conv = ?cached_conv_id,
            "antigravity-sdk bridge spawn"
        );

        tokio::spawn(async move {
            let _ = tx
                .send(BridgeEvent::Init {
                    session_id: session_id_out.clone(),
                    claude_session_id: cached_conv_id.clone(),
                    model: model_out.clone(),
                    tools_count: 0,
                })
                .await;

            let request = json!({
                "prompt": prompt,
                "model": model_out,
                "api_key": api_key,
                "conversation_id": cached_conv_id,
                "workspaces": [agent_cwd.clone()],
                "mode": autonomy_mode,
                "mcp_servers": mcp_servers,
                "system_instructions": system_instructions,
            });

            let mut command = tokio::process::Command::new(&python_path);
            command
                .arg(&script_path)
                .current_dir(&agent_cwd)
                .env("GEMINI_API_KEY", &api_key)
                // `PYTHONIOENCODING=utf-8` keeps Turkish/Unicode in the
                // model's reply from crashing the sidecar on Windows
                // (default cp1252 codec can't encode `ı` etc).
                .env("PYTHONIOENCODING", "utf-8")
                // Force unbuffered stdout so the per-token delta flush
                // in the sidecar isn't held back by Python's default
                // line-buffered tty heuristics when stdout is a pipe.
                .env("PYTHONUNBUFFERED", "1")
                .env("FLEETIFY_SESSION_ID", &session_id_out)
                .env(
                    "FLEETIFY_BACKEND_URL",
                    std::env::var("FLEETIFY_BACKEND_URL")
                        .unwrap_or_else(|_| "http://127.0.0.1:8765".into()),
                )
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());

            if let Ok(secret) = std::env::var("FLEETIFY_INTERNAL_SECRET") {
                command.env("FLEETIFY_INTERNAL_SECRET", secret);
            }

            let mut child = match command.spawn() {
                Ok(c) => c,
                Err(e) => {
                    let _ = tx
                        .send(BridgeEvent::Error {
                            error: format!(
                                "failed to spawn Antigravity SDK sidecar: {e}. \
                                 (interpreter: {}, script: {})",
                                python_path.display(),
                                script_path.display(),
                            ),
                        })
                        .await;
                    let _ = tx
                        .send(BridgeEvent::Status {
                            status: "done".into(),
                        })
                        .await;
                    return;
                }
            };

            // Pipe the single-line JSON request to stdin, then close
            // stdin so the sidecar's `sys.stdin.readline()` returns
            // and the turn starts.
            if let Some(mut stdin) = child.stdin.take() {
                let payload = format!("{request}\n");
                if let Err(e) = stdin.write_all(payload.as_bytes()).await {
                    tracing::warn!("antigravity-sdk stdin write failed: {e}");
                }
                drop(stdin);
            }

            let stdout = child.stdout.take().expect("piped stdout");
            let stderr = child.stderr.take().expect("piped stderr");
            *child_handle.lock().await = Some(child);

            // Drain stderr in the background — Python tracebacks land
            // here when the sidecar itself crashes (vs. the wrapped
            // SDK errors which it routes to stdout as `{type:"error"}`).
            // We log stderr but don't surface it unless the process
            // exits with a non-zero status AND no stdout events came
            // through.
            let stderr_buf: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
            {
                let buf = stderr_buf.clone();
                let mut reader = BufReader::new(stderr).lines();
                tokio::spawn(async move {
                    while let Ok(Some(line)) = reader.next_line().await {
                        let mut g = buf.lock().await;
                        g.push_str(&line);
                        g.push('\n');
                    }
                });
            }

            // Parse stdout line-by-line. Each line is a JSON event.
            // Map to BridgeEvent, forward via mpsc.
            let mut lines = BufReader::new(stdout).lines();
            let mut got_any_event = false;
            loop {
                if aborted.load(std::sync::atomic::Ordering::SeqCst) {
                    if let Some(c) = child_handle.lock().await.as_mut() {
                        let _ = c.start_kill();
                    }
                    let _ = tx
                        .send(BridgeEvent::Error {
                            error: "Antigravity SDK turn aborted.".into(),
                        })
                        .await;
                    break;
                }
                let next = match lines.next_line().await {
                    Ok(Some(l)) => l,
                    Ok(None) => break,
                    Err(e) => {
                        tracing::warn!("antigravity-sdk stdout read error: {e}");
                        break;
                    }
                };
                let line = next.trim();
                if line.is_empty() {
                    continue;
                }
                got_any_event = true;
                let Ok(v) = serde_json::from_str::<Value>(line) else {
                    tracing::warn!(
                        line = %line,
                        "antigravity-sdk: skipping non-JSON line from sidecar"
                    );
                    continue;
                };
                let etype = v.get("type").and_then(|s| s.as_str()).unwrap_or("");
                match etype {
                    "init" => {
                        // Sidecar's init carries the *real* SDK model
                        // string after the picker id was normalized
                        // (e.g. `gemini-3.5-flash-medium` →
                        // `gemini-3.5-flash`). Re-emit so the chip
                        // face reflects what actually runs.
                        let model = v
                            .get("model")
                            .and_then(|s| s.as_str())
                            .unwrap_or(model_out.as_str());
                        let _ = tx
                            .send(BridgeEvent::Init {
                                session_id: session_id_out.clone(),
                                claude_session_id: None,
                                model: model.to_string(),
                                tools_count: 0,
                            })
                            .await;
                    }
                    "delta" => {
                        if let Some(text) = v
                            .get("text")
                            .and_then(|s| s.as_str())
                            .filter(|s| !s.is_empty())
                        {
                            let _ = tx
                                .send(BridgeEvent::MessageDelta {
                                    text: text.to_string(),
                                })
                                .await;
                        }
                    }
                    "thinking" => {
                        if let Some(text) = v
                            .get("text")
                            .and_then(|s| s.as_str())
                            .filter(|s| !s.is_empty())
                        {
                            let _ = tx
                                .send(BridgeEvent::Thinking {
                                    text: text.to_string(),
                                })
                                .await;
                        }
                    }
                    "tool_start" => {
                        let tool_id = v
                            .get("tool_id")
                            .and_then(|s| s.as_str())
                            .unwrap_or("")
                            .to_string();
                        let name = v
                            .get("name")
                            .and_then(|s| s.as_str())
                            .unwrap_or("tool")
                            .to_string();
                        let input = v.get("input").cloned().unwrap_or(json!({}));
                        let _ = tx
                            .send(BridgeEvent::ToolStart {
                                tool_id,
                                name,
                                input,
                            })
                            .await;
                    }
                    "tool_end" => {
                        let tool_id = v
                            .get("tool_id")
                            .and_then(|s| s.as_str())
                            .unwrap_or("")
                            .to_string();
                        let output = v
                            .get("output")
                            .and_then(|s| s.as_str())
                            .unwrap_or("")
                            .to_string();
                        let is_error = v.get("is_error").and_then(|b| b.as_bool()).unwrap_or(false);
                        let _ = tx
                            .send(BridgeEvent::ToolEnd {
                                tool_id,
                                output,
                                is_error,
                            })
                            .await;
                    }
                    "conversation_id" => {
                        if let Some(id) = v.get("id").and_then(|s| s.as_str()) {
                            *conv_handle.lock().await = Some(id.to_string());
                            tracing::info!(
                                session_id = %session_id_out,
                                conv = %id,
                                "captured antigravity-sdk conversation_id"
                            );
                        }
                    }
                    "usage" => {
                        // Best-effort cost surface. The SDK's usage
                        // shape varies by version; we forward
                        // whatever's present as the `usage` object on
                        // a Cost event with cost_usd=0 (the SDK
                        // doesn't price the call locally).
                        let mut usage = v.clone();
                        if let Some(o) = usage.as_object_mut() {
                            o.remove("type");
                        }
                        let _ = tx
                            .send(BridgeEvent::Cost {
                                usage,
                                cost_usd: 0.0,
                                model: model_out.clone(),
                            })
                            .await;
                    }
                    "error" => {
                        let msg = v
                            .get("message")
                            .and_then(|s| s.as_str())
                            .unwrap_or("Antigravity SDK error (no message)")
                            .to_string();
                        let _ = tx.send(BridgeEvent::Error { error: msg }).await;
                    }
                    "done" => {
                        // Sidecar signals end-of-turn. We still wait
                        // for the child to exit cleanly so the
                        // stderr drain can flush, then emit Status:
                        // done outside this loop.
                    }
                    other => {
                        tracing::debug!(
                            kind = %other,
                            "antigravity-sdk: unknown event type (forwarding nothing)"
                        );
                    }
                }
            }

            // Wait for the child to exit so we know whether stderr is
            // meaningful. start_kill above (on abort) makes this fast;
            // a graceful exit also resolves here.
            let exit_status = {
                let mut guard = child_handle.lock().await;
                if let Some(c) = guard.as_mut() {
                    match c.wait().await {
                        Ok(s) => Some(s),
                        Err(e) => {
                            tracing::warn!("antigravity-sdk wait failed: {e}");
                            None
                        }
                    }
                } else {
                    None
                }
            };
            *child_handle.lock().await = None;

            // If the sidecar exited with no stdout events AND non-zero
            // status, surface the stderr blob so the user sees what
            // went wrong. The sidecar normally catches its own
            // exceptions and turns them into `{type:"error"}` events,
            // so this path is rare (catastrophic Python startup failure,
            // e.g. interpreter mismatch, broken google-antigravity install).
            if !got_any_event {
                let err_text = stderr_buf.lock().await.clone();
                let exit_code = exit_status.and_then(|s| s.code());
                let msg = if err_text.trim().is_empty() {
                    format!(
                        "Antigravity SDK sidecar exited (code {exit_code:?}) without \
                         producing any events. Try running \
                         `{} {}` manually to see what went wrong.",
                        python_path.display(),
                        script_path.display(),
                    )
                } else {
                    format!("Antigravity SDK sidecar stderr:\n{err_text}")
                };
                let _ = tx.send(BridgeEvent::Error { error: msg }).await;
            }

            let _ = tx
                .send(BridgeEvent::Status {
                    status: "done".into(),
                })
                .await;
        });

        Ok(rx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn autonomy_mode_maps_permission_mode_to_wire_value() {
        // "default" now lands in chat (read tools auto, writes/shell
        // denied) — was the SDK's stock "confirm_run_command" which
        // would hang on stdin in headless dispatch. Every session gets
        // workspace context regardless of the user's autonomy choice.
        assert_eq!(autonomy_mode_from_permission("default"), "chat");
        assert_eq!(autonomy_mode_from_permission("acceptEdits"), "accept_edits");
        assert_eq!(
            autonomy_mode_from_permission("bypassPermissions"),
            "autonomous"
        );
        // Unknown / experimental values fall through to chat — the safest
        // tier that still gives the model context.
        assert_eq!(autonomy_mode_from_permission("plan"), "chat");
        assert_eq!(autonomy_mode_from_permission(""), "chat");
    }

    #[test]
    fn autonomy_mode_native_always_proceed_equals_bypass_permissions() {
        // Native antigravity-sdk "always-proceed" is the autonomous tier —
        // same result as bypassPermissions.
        assert_eq!(
            autonomy_mode_from_permission("always-proceed"),
            "autonomous"
        );
        assert_eq!(
            autonomy_mode_from_permission("always-proceed"),
            autonomy_mode_from_permission("bypassPermissions")
        );
        // Native safe modes fall to chat (conservative default).
        assert_eq!(autonomy_mode_from_permission("request-review"), "chat");
        assert_eq!(autonomy_mode_from_permission("proceed-in-sandbox"), "chat");
    }

    #[test]
    fn new_captures_autonomy_mode_on_construction() {
        // Bridge construction is the moment we lock in the autonomy
        // setting for the session. We pin it here rather than reading
        // each turn so changing permission_mode mid-session requires a
        // fresh bridge (same contract every other field has).
        let b = AntigravitySdkBridge::new(
            "sess-1",
            "C:/tmp",
            "bypassPermissions".into(),
            None,
            false,
            None,
            None,
        );
        assert_eq!(b.autonomy_mode, "autonomous");

        let b = AntigravitySdkBridge::new(
            "sess-2",
            "C:/tmp",
            "default".into(),
            Some("gemini-3.5-flash".into()),
            false,
            None,
            None,
        );
        assert_eq!(b.autonomy_mode, "chat");
        assert_eq!(b.model, "gemini-3.5-flash");
    }

    // Fails to compile unless keyring's persistent Linux store is enabled:
    // plain `linux-native` (keyutils) is in-memory and loses every credential on reboot.
    #[cfg(target_os = "linux")]
    #[test]
    fn linux_keyring_store_survives_reboot() {
        #[allow(unused_imports)]
        use keyring::keyutils_persistent as _;
    }
}
