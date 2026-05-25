//! Antigravity (`agy`) CLI bridge — headless `-p` mode with
//! per-conversation persistence via the `--conversation <uuid>` flag.
//!
//! ## How agy is driven
//!
//! `agy 1.0.2 --help` exposes (relevant flags only):
//!   • `-p` / `--print <msg>`      — one-shot non-interactive turn
//!   • `--conversation <uuid>`     — resume a specific conversation
//!   • `-c` / `--continue`         — resume the most-recent (any CWD)
//!   • `--print-timeout <dur>`     — wait cap for `-p` (default 5m)
//!   • `--add-dir <path>`          — extra workspace root
//!   • `--dangerously-skip-permissions` — no tool prompts
//!
//! There is **no** `--model` / `-m` flag in 1.0.2 — model selection
//! lives in agy's TUI via `/model` (persisted to its own settings.json).
//! The picker in Fleetify surfaces the right list so the UI matches, but
//! dispatch can't override the model on a per-turn basis yet; we forward
//! `session.model_name` as the *display* model in `Init` and rely on the
//! user's chosen agy default for the actual call. When the upstream CLI
//! grows a flag, we add it here in one line.
//!
//! ## Streaming
//!
//! `-p` mode prints the final response only — there's no `--output-format
//! stream-json` like Claude. We therefore emit a single `MessageDelta`
//! with the full text, sandwiched by `Init` and `Status { "done" }`. The
//! renderer already handles arbitrary-sized single deltas. When agy ships
//! a streaming mode (issue google-antigravity/antigravity-cli#7 tracks
//! `--print` emitting session ids; a streaming variant is the obvious
//! next request), this bridge upgrades to line-by-line forwarding.
//!
//! ## Conversation persistence
//!
//! `agy` writes `~/.gemini/antigravity-cli/cache/last_conversations.json`
//! as a `{cwd: conversation_uuid}` map. After the first turn we read
//! that file to capture the UUID for the bridge's CWD, then pass
//! `--conversation <uuid>` on every subsequent turn so context survives
//! across Fleetify session boundaries.
//!
//! ## Permissions
//!
//! `agy` has its own permission model (tool approval prompts inside the
//! TUI). For headless `-p` we pass `--dangerously-skip-permissions` ONLY
//! when the Fleetify session's `permission_mode` is `bypassPermissions`
//! or `dontAsk`; the default mode never sets it, matching what every
//! other bridge does for safety.

use std::process::Stdio;
use std::sync::Arc;

use serde_json::Value;
use tokio::io::{AsyncReadExt, BufReader};
use tokio::process::Child;
use tokio::sync::{mpsc, Mutex};

use super::BridgeEvent;
use fleetify_core::user_home;

pub struct AntigravityBridge {
    pub session_id: String,
    /// Directory we spawn `agy` from. For use_worktree sessions this is
    /// the per-session worktree under `.fleetify-worktrees/<sid>/`, for
    /// in-place sessions it's the project root. We auto-add the path to
    /// agy's `settings.json -> trustedWorkspaces` before each spawn —
    /// otherwise agy silently refuses to start a conversation in an
    /// unknown dir, producing exit=0 with empty stdout AND no transcript
    /// file (so even the on-disk fallback can't recover anything).
    pub agent_cwd: String,
    pub model: String,
    permission_mode: String,
    /// Captured after the first turn from `cache/last_conversations.json`.
    /// Used as `--conversation <uuid>` on every subsequent turn so the
    /// conversation continues instead of starting fresh.
    conversation_id: Arc<Mutex<Option<String>>>,
    child: Arc<Mutex<Option<Child>>>,
    aborted: Arc<std::sync::atomic::AtomicBool>,
}

impl AntigravityBridge {
    pub fn new(
        session_id: impl Into<String>,
        agent_cwd: impl Into<String>,
        permission_mode: String,
        model_name: Option<String>,
        _is_staff: bool,
        _agent_template: Option<String>,
    ) -> Self {
        Self {
            session_id: session_id.into(),
            agent_cwd: agent_cwd.into(),
            // Display-only — see the long "Model selection" comment
            // above for why we can't pin a specific model on agy from
            // the CLI surface. The picker passes `agy-default` for the
            // single "Auto" entry; the actual model is whatever the
            // user last set via agy's TUI `/model` slash command (state
            // persists server-side via setUserSettings).
            model: model_name.unwrap_or_else(|| "agy-default".into()),
            permission_mode,
            conversation_id: Arc::new(Mutex::new(None)),
            child: Arc::new(Mutex::new(None)),
            aborted: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        }
    }

    /// Normalize a path to the canonical separator agy compares against
    /// on this OS. agy's TUI stores its own trustedWorkspaces entries
    /// with native separators (all `\` on Windows). Fleetify's worktree
    /// paths can arrive as a mix (`C:/proj\.fleetify-worktrees\<sid>`)
    /// because some upstream call composed them with `/` joins. agy
    /// then string-compares its actual CWD (always native-separator
    /// from the OS) against the stored entries and finds no match —
    /// silently refusing to start. Normalizing both sides before
    /// trust + spawn closes the gap.
    fn normalize_path(path: &str) -> String {
        if cfg!(windows) {
            path.replace('/', "\\")
        } else {
            path.to_string()
        }
    }

    /// Ensure `path` is in agy's `trustedWorkspaces` list so it'll
    /// actually start a conversation when we spawn from there. agy's
    /// settings file lives at `~/.gemini/antigravity-cli/settings.json`
    /// and looks like:
    ///   { "colorScheme": "dark",
    ///     "enableTelemetry": false,
    ///     "trustedWorkspaces": ["C:\\Users\\foo\\proj", ...] }
    /// We read it, append `path` if missing (matching the user's
    /// existing entries' case/separators by storing the path verbatim),
    /// and write it back. Idempotent — fast no-op on every subsequent
    /// spawn. Failures are logged + swallowed (agy still might work,
    /// e.g. if the user already trusted it via the TUI).
    fn ensure_trusted_workspace(path: &str) {
        let settings_path = user_home()
            .join(".gemini")
            .join("antigravity-cli")
            .join("settings.json");
        let Ok(raw) = std::fs::read_to_string(&settings_path) else {
            tracing::warn!(
                "agy settings.json unreadable at {:?}; can't auto-trust workspace",
                settings_path
            );
            return;
        };
        let mut cfg: Value = match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!("agy settings.json invalid JSON: {e}; skipping trust update");
                return;
            }
        };
        let obj = match cfg.as_object_mut() {
            Some(o) => o,
            None => return,
        };
        let arr = obj
            .entry("trustedWorkspaces".to_string())
            .or_insert_with(|| Value::Array(vec![]))
            .as_array_mut();
        let Some(arr) = arr else {
            return;
        };
        // Case-insensitive compare on Windows; exact compare elsewhere.
        let already = arr.iter().any(|v| match v.as_str() {
            Some(s) if cfg!(windows) => s.eq_ignore_ascii_case(path),
            Some(s) => s == path,
            None => false,
        });
        if already {
            return;
        }
        arr.push(Value::String(path.to_string()));
        if let Ok(s) = serde_json::to_string_pretty(&cfg) {
            if let Err(e) = std::fs::write(&settings_path, s) {
                tracing::warn!("agy settings.json write failed: {e}");
            } else {
                tracing::info!(workspace = %path, "added workspace to agy trustedWorkspaces");
            }
        }
    }

    // ── Model selection ──────────────────────────────────────────────
    //
    // agy 1.0.2's print mode (`-p`) does NOT honour any model-steering
    // surface we tested:
    //
    //   • `--model <label>`, `-m <label>`, `--default-model <label>`,
    //     `--selected-model <label>` — all silently ignored. agy's
    //     flag parser is permissive (unknown flags accepted, no error),
    //     and the log shows
    //     `model_config_manager.go: Propagating selected model
    //      override to backend: label="Gemini 3.5 Flash (Medium)"`
    //     regardless of what we pass.
    //   • `settings.json -> defaultModel` — agy reads its settings,
    //     ignores unknown keys, and rewrites the file on shutdown
    //     dropping our injected `defaultModel`. The transcript metadata
    //     (`<USER_SETTINGS_CHANGE>Model Selection from None to ...`)
    //     always records the built-in default, never our value.
    //   • Per-conversation model is locked at conv-start time inside
    //     the backend; even starting a fresh conv doesn't read our
    //     defaultModel write.
    //
    // The ONLY working surface is the `/model <label>` slash command
    // typed inside the TUI — which requires PTY-driven dispatch (not
    // print mode). Until we land that, the picker only shows the
    // single "Auto" entry to avoid implying functionality we don't
    // have, and we don't try to steer agy from the bridge.

    pub async fn abort(&self) {
        self.aborted
            .store(true, std::sync::atomic::Ordering::SeqCst);
        if let Some(child) = self.child.lock().await.as_mut() {
            let _ = child.start_kill();
        }
    }

    /// Read agy's per-cwd "most recent conversation" cache and return the
    /// UUID assigned to our `agent_cwd`. `None` when the file is missing
    /// (first ever agy launch on this machine) or doesn't list our path.
    fn read_cached_conversation_id(agent_cwd: &str) -> Option<String> {
        let path = user_home()
            .join(".gemini")
            .join("antigravity-cli")
            .join("cache")
            .join("last_conversations.json");
        let raw = std::fs::read_to_string(&path).ok()?;
        let map: Value = serde_json::from_str(&raw).ok()?;
        // agy stores the key as the absolute CWD path verbatim, with
        // OS-native separators. Match it directly first; fall back to a
        // case-insensitive scan on Windows where the same path may be
        // written with mixed casing depending on how the shell resolved it.
        if let Some(v) = map.get(agent_cwd).and_then(|v| v.as_str()) {
            return Some(v.to_string());
        }
        if cfg!(windows) {
            let needle = agent_cwd.to_lowercase();
            if let Some(obj) = map.as_object() {
                for (k, v) in obj {
                    if k.to_lowercase() == needle {
                        return v.as_str().map(String::from);
                    }
                }
            }
        }
        None
    }

    /// Tail the agy on-disk transcript for the latest assistant reply.
    ///
    /// agy 1.0.2's `-p` mode has a known bug where the streamed response
    /// (driven by the TUI's `text_drip` system) never flushes to stdout —
    /// even though the model genuinely answered. The same response IS
    /// written to disk at
    /// `~/.gemini/antigravity-cli/brain/<conv>/.system_generated/logs/transcript.jsonl`
    /// as a `{source: "MODEL", type: "PLANNER_RESPONSE", content: "..."}`
    /// line. We tail that file and concatenate every PLANNER_RESPONSE
    /// emitted *after* `pre_byte_offset` so we surface only this turn's
    /// reply, not the whole conversation history.
    ///
    /// When upstream issue google-antigravity/antigravity-cli#7 (or a
    /// follow-up that fixes print-mode flushing) lands, this fallback
    /// becomes dead code that simply returns `None` and the bridge keeps
    /// using stdout. Keeping the read path here makes the bridge robust
    /// to a partial fix as well.
    fn read_transcript_response_since(conv_id: &str, pre_byte_offset: u64) -> Option<String> {
        let path = user_home()
            .join(".gemini")
            .join("antigravity-cli")
            .join("brain")
            .join(conv_id)
            .join(".system_generated")
            .join("logs")
            .join("transcript.jsonl");
        let raw = std::fs::read_to_string(&path).ok()?;
        let bytes = raw.as_bytes();
        if (pre_byte_offset as usize) >= bytes.len() {
            return None;
        }
        let slice = &raw[pre_byte_offset as usize..];
        let mut out = String::new();
        for line in slice.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let Ok(v) = serde_json::from_str::<Value>(line) else {
                continue;
            };
            let is_model = v.get("source").and_then(|s| s.as_str()) == Some("MODEL");
            let is_response = v.get("type").and_then(|s| s.as_str()) == Some("PLANNER_RESPONSE");
            let is_done = v.get("status").and_then(|s| s.as_str()) == Some("DONE");
            if is_model && is_response && is_done {
                if let Some(text) = v.get("content").and_then(|c| c.as_str()) {
                    if !out.is_empty() {
                        out.push('\n');
                    }
                    out.push_str(text);
                }
            }
        }
        if out.is_empty() {
            None
        } else {
            Some(out)
        }
    }

    /// Current byte length of the conversation's transcript on disk, or 0
    /// when the file doesn't exist yet (first turn of a new conv).
    fn transcript_size(conv_id: &str) -> u64 {
        let path = user_home()
            .join(".gemini")
            .join("antigravity-cli")
            .join("brain")
            .join(conv_id)
            .join(".system_generated")
            .join("logs")
            .join("transcript.jsonl");
        std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0)
    }

    pub async fn send_message(
        &self,
        message: &str,
        _ctx: super::BridgeContext,
    ) -> anyhow::Result<mpsc::Receiver<BridgeEvent>> {
        let (tx, rx) = mpsc::channel::<BridgeEvent>(8);

        // Build argv. `--print-timeout 10m` matches Fleetify's existing
        // long-running-turn tolerance (claude/gemini both use generous
        // server-side limits); the default 5m clips long agentic tasks.
        let mut argv: Vec<String> = vec![
            "agy".into(),
            "-p".into(),
            message.to_string(),
            "--print-timeout".into(),
            "10m".into(),
        ];
        // Resolve the conversation UUID two ways: in-instance state
        // (fresh bridges always start None — chat.rs constructs a new
        // bridge per turn) and the per-cwd "most recent" cache agy
        // writes to disk. Cache takes precedence ONLY when the instance
        // field is empty so a bridge that already captured an id can't
        // be overridden mid-flight by another process touching the cache.
        // Pre-normalize once for cache lookups / spawn cwd / trust list.
        // agy stores cache keys + trustedWorkspaces in OS-native separator
        // form, so anything we hand to its disk-persisted state must
        // match that or it won't be found / honoured.
        let normalized_cwd_pre = Self::normalize_path(&self.agent_cwd);
        let cached_conv_id = {
            let from_instance = self.conversation_id.lock().await.clone();
            match from_instance {
                Some(id) => Some(id),
                None => {
                    let from_cache = Self::read_cached_conversation_id(&normalized_cwd_pre);
                    if let Some(id) = &from_cache {
                        // Persist it back into the bridge so the
                        // transcript-tail read after spawn looks at the
                        // right conv even when agy refuses to update
                        // its cache (rare, but seen with concurrent
                        // turns).
                        *self.conversation_id.lock().await = Some(id.clone());
                    }
                    from_cache
                }
            }
        };
        if let Some(uuid) = &cached_conv_id {
            argv.push("--conversation".into());
            argv.push(uuid.clone());
        }
        // Mirror every other bridge: only enable the agy "skip permission
        // prompts" escape hatch when the user explicitly chose a mode
        // that means "don't ask me". Default + acceptEdits + plan stay
        // safe.
        if matches!(
            self.permission_mode.as_str(),
            "bypassPermissions" | "dontAsk"
        ) {
            argv.push("--dangerously-skip-permissions".into());
        }
        // Use the same normalized path we already computed for cache
        // lookups above so trust / --add-dir / spawn-cwd all line up.
        let normalized_cwd = normalized_cwd_pre.clone();
        // `--add-dir <cwd>` so agy treats the session's working dir as
        // a workspace root even when `agent_cwd` differs from the shell
        // CWD (which we ALSO set below). Belt + suspenders: agy 1.0.2's
        // workspace inference relies on either signal.
        argv.push("--add-dir".into());
        argv.push(normalized_cwd.clone());

        // BEFORE spawn: make sure agy trusts this directory. Without
        // this step a fresh `.fleetify-worktrees/<sid>/` (or any other
        // new project folder the user picks) gets agy's silent-refuse
        // treatment — exit=0, empty stdout, no transcript file written.
        // Idempotent: re-trusting a known path is a no-op write skip.
        // Use the normalized form so agy's later CWD compare matches.
        Self::ensure_trusted_workspace(&normalized_cwd);

        // We do NOT try to steer the model from here — see the long
        // comment above `abort()` for the exhaustive list of surfaces
        // we tested (`--model`/`-m`/etc CLI flags, `ANTIGRAVITY_MODEL`
        // and adjacent env vars, parent + child `settings.json`
        // `defaultModel`/`model`/`selectedModel` fields, project
        // descriptor injection, stdin slash-command prefix). agy 1.0.2
        // print mode ignores all of them and pins to its built-in
        // default. The TUI's `/model` slash command works, but reaching
        // that needs PTY-driven dispatch.

        let session_id_out = self.session_id.clone();
        let model_out = self.model.clone();
        // Use the normalized path inside the spawn task too — spawn
        // cwd + post-spawn cache lookup + post-spawn transcript read
        // all need to match what agy itself sees.
        let agent_cwd = normalized_cwd.clone();
        let conv_handle = self.conversation_id.clone();
        let child_handle = self.child.clone();
        let aborted = self.aborted.clone();

        // Snapshot the transcript size BEFORE spawn so we can read out
        // only the new lines this turn produced — agy appends to the
        // same JSONL across `--conversation <uuid>` resumes, and we
        // don't want to re-emit the entire history on every turn.
        let pre_transcript_size = cached_conv_id
            .as_deref()
            .map(Self::transcript_size)
            .unwrap_or(0);

        tokio::spawn(async move {
            // Init first so the renderer leaves the pending state and
            // shows the model-name pill straight away.
            let _ = tx
                .send(BridgeEvent::Init {
                    session_id: session_id_out.clone(),
                    claude_session_id: cached_conv_id.clone(),
                    model: model_out.clone(),
                    tools_count: 0,
                })
                .await;

            let mut command = tokio::process::Command::new(&argv[0]);
            command
                .args(&argv[1..])
                .current_dir(&agent_cwd)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .stdin(Stdio::null());

            tracing::info!(
                session_id = %session_id_out,
                cwd = %agent_cwd,
                conv = ?cached_conv_id,
                "antigravity bridge spawn"
            );

            let mut child = match command.spawn() {
                Ok(c) => c,
                Err(e) => {
                    let _ = tx
                        .send(BridgeEvent::Error {
                            error: format!(
                                "failed to spawn `agy`: {e}. \
                                 Ensure Antigravity CLI is installed and on PATH \
                                 (Settings → Agents → Antigravity → Install)."
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

            let stdout = child.stdout.take().expect("piped stdout");
            let stderr = child.stderr.take().expect("piped stderr");
            *child_handle.lock().await = Some(child);

            // Read stdout + stderr concurrently. agy doesn't stream
            // tokens in `-p` mode, but tailing both ensures we don't
            // deadlock on a stderr-heavy spawn (e.g. agy's auto-update
            // chatter on first run).
            let stdout_task = tokio::spawn(async move {
                let mut buf = String::new();
                let mut reader = BufReader::new(stdout);
                let _ = reader.read_to_string(&mut buf).await;
                buf
            });
            let stderr_task = tokio::spawn(async move {
                let mut buf = String::new();
                let mut reader = BufReader::new(stderr);
                let _ = reader.read_to_string(&mut buf).await;
                buf
            });

            // Wait for completion, respecting abort. Poll because abort
            // is a flag we set externally — kill via child_handle when
            // we see it flip.
            let status = loop {
                if aborted.load(std::sync::atomic::Ordering::SeqCst) {
                    if let Some(c) = child_handle.lock().await.as_mut() {
                        let _ = c.start_kill();
                    }
                }
                let mut guard = child_handle.lock().await;
                let Some(c) = guard.as_mut() else { break None };
                match c.try_wait() {
                    Ok(Some(status)) => {
                        *guard = None;
                        break Some(status);
                    }
                    Ok(None) => {
                        drop(guard);
                        tokio::time::sleep(std::time::Duration::from_millis(120)).await;
                    }
                    Err(e) => {
                        tracing::error!("antigravity wait error: {e}");
                        *guard = None;
                        break None;
                    }
                }
            };

            let out = stdout_task.await.unwrap_or_default();
            let err = stderr_task.await.unwrap_or_default();

            // First, capture (or refresh) the agy-side conversation id
            // from its cache. We need this BEFORE the transcript-tail
            // fallback because the transcript lives under that uuid.
            // The cache is per-CWD; if we already had an id from a
            // prior turn it's the same one agy resumed.
            let conv_id = {
                let mut conv = conv_handle.lock().await;
                if conv.is_none() {
                    *conv = Self::read_cached_conversation_id(&agent_cwd);
                    if let Some(id) = &*conv {
                        tracing::info!(
                            session_id = %session_id_out,
                            conv = %id,
                            "captured agy conversation_id"
                        );
                    }
                }
                conv.clone()
            };

            // Reply resolution order:
            //   1. stdout (when upstream agy print-mode flushing works)
            //   2. on-disk transcript tail for this conversation, only
            //      reading bytes appended after `pre_transcript_size`
            //      so we don't surface the entire history on every turn
            //   3. stderr (for cases where agy fails noisily)
            //   4. a clean explanatory error
            let stdout_text = out.trim().to_string();
            let transcript_text = conv_id
                .as_deref()
                .and_then(|id| Self::read_transcript_response_since(id, pre_transcript_size));
            let stdout_len = stdout_text.len();
            let transcript_len = transcript_text.as_ref().map(|s| s.len()).unwrap_or(0);
            let reply: Option<String> = if !stdout_text.is_empty() {
                Some(stdout_text)
            } else {
                transcript_text
            };

            tracing::info!(
                session_id = %session_id_out,
                conv = ?conv_id,
                pre_size = pre_transcript_size,
                stdout_len,
                transcript_len,
                "antigravity bridge resolved reply"
            );

            if let Some(text) = reply {
                let send_res = tx
                    .send(BridgeEvent::MessageDelta { text: text.clone() })
                    .await;
                tracing::info!(
                    session_id = %session_id_out,
                    delta_chars = text.len(),
                    send_ok = send_res.is_ok(),
                    "antigravity bridge emitted MessageDelta"
                );
            } else if aborted.load(std::sync::atomic::Ordering::SeqCst) {
                let _ = tx
                    .send(BridgeEvent::Error {
                        error: "Antigravity turn aborted.".into(),
                    })
                    .await;
            } else {
                let stderr_trim = err.trim();
                let exit_code = status.and_then(|s| s.code());
                let msg = if !stderr_trim.is_empty() {
                    format!("agy stderr: {stderr_trim}")
                } else if conv_id.is_none() {
                    format!(
                        "agy ran but didn't start a conversation for `{}`. \
                         The bridge added this path to agy's trustedWorkspaces \
                         and pinned the model before launch, but agy's print \
                         mode exited without writing a conv cache. Try running \
                         `agy` once interactively from any directory to verify \
                         your login is still active (OAuth tokens expire), \
                         then retry.",
                        agent_cwd,
                    )
                } else {
                    format!(
                        "agy produced no response on disk for conversation \
                         {} (exit {:?}). This usually means the model call \
                         failed silently in agy's print-mode — check \
                         `~/.gemini/antigravity-cli/log/` for the most \
                         recent `cli-*.log` file.",
                        conv_id.unwrap_or_else(|| "<unknown>".into()),
                        exit_code,
                    )
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
