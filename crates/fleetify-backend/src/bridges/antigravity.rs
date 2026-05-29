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

use std::io::{Read, Write};
use std::sync::{Arc, OnceLock};

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, PtySize};
use regex::Regex;
use serde_json::Value;
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
    /// Write half of agy's controlling PTY while a turn is running. agy
    /// runs inside a pseudo-terminal because it writes its OAuth banner +
    /// sign-in URL to the console (CONOUT$) directly — redirected pipes
    /// capture NOTHING (proven: 0 bytes on both). `send_auth_code` writes
    /// the pasted OOB code here (followed by CR = Enter). Cleared at turn
    /// end.
    pty_writer: Arc<Mutex<Option<Box<dyn Write + Send>>>>,
    /// Killer for the PTY child, so `abort` (and the auth-wait watchdog)
    /// can terminate agy — in a PTY agy waits forever for terminal input,
    /// so it must be killed rather than EOF'd.
    pty_killer: Arc<Mutex<Option<Box<dyn ChildKiller + Send + Sync>>>>,
    /// Set true once the user submits an auth code, so the auth-wait
    /// watchdog (which kills a hung agy) stands down.
    code_submitted: Arc<std::sync::atomic::AtomicBool>,
    aborted: Arc<std::sync::atomic::AtomicBool>,
}

/// How long to keep the sign-in card up (agy alive) waiting for the user
/// to paste the OOB OAuth code. Generous because the browser sign-in
/// takes time — but note agy itself abandons the auth after ~30s, so a
/// code pasted later won't actually work; this is just the safety cap
/// before we give up and kill agy.
const AUTH_CODE_WAIT_SECS: u64 = 150;

/// Once agy has produced real output (the model's answer, or an error),
/// this much PTY silence means the turn is finished. A normal turn self-
/// exits, but a post-OAuth turn LINGERS (verified — agy keeps the terminal
/// open), so this idle gap is how we know to kill it and surface the reply.
const ANSWER_IDLE_SECS: u64 = 4;

/// Backstop for the post-OAuth turn: if neither the answer-screen repaint
/// nor a terminal error is observed within this long after the code was
/// pasted, give up waiting and resolve from whatever landed (transcript /
/// last screen). Covers a sign-in that completes but produces no answer.
const POST_CODE_GRACE_SECS: u64 = 25;

/// Absolute backstop for a single agy turn (matches `--print-timeout`).
const TURN_HARD_CAP_SECS: u64 = 600;

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
            pty_writer: Arc::new(Mutex::new(None)),
            pty_killer: Arc::new(Mutex::new(None)),
            code_submitted: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            aborted: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        }
    }

    /// Feed the OOB OAuth code (that the user pasted from the Google
    /// sign-in page) into agy's controlling PTY, followed by a carriage
    /// return (the Enter key inside a terminal) so agy's "paste the
    /// authorization code here and press Enter:" prompt reads it. No-op
    /// when no turn is mid-flight (agy not waiting).
    pub async fn send_auth_code(&self, code: &str) {
        // Tell the auth-wait watchdog to stand down — a code is coming.
        self.code_submitted
            .store(true, std::sync::atomic::Ordering::SeqCst);
        let mut guard = self.pty_writer.lock().await;
        let Some(writer) = guard.as_mut() else {
            tracing::warn!(
                session_id = %self.session_id,
                "antigravity send_auth_code: no live PTY (agy not awaiting a code?)"
            );
            return;
        };
        // CR (\r) is Enter in a terminal — NOT \n. ConPTY's line
        // discipline turns this into the line submit agy is waiting for.
        let line = format!("{}\r", code.trim());
        if let Err(e) = writer.write_all(line.as_bytes()) {
            tracing::warn!(session_id = %self.session_id, "antigravity send_auth_code write failed: {e}");
            return;
        }
        let _ = writer.flush();
        tracing::info!(session_id = %self.session_id, "antigravity: wrote OAuth code to agy PTY");
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
        if let Some(killer) = self.pty_killer.lock().await.as_mut() {
            let _ = killer.kill();
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

    /// Scan text for agy's auth-required sign-in URL and return JUST the
    /// URL token. agy prints it inside a banner:
    ///   "Authentication required. Please visit the URL to log in:"
    ///   "  https://accounts.google.com/o/oauth2/auth?...&state=…"
    ///
    /// In a PTY the URL is terminated by an ANSI escape (cursor move),
    /// NOT a newline — e.g. `…&state=abc\x1b[6;1HWaiting…`. So we match
    /// the URL as a token of valid URL characters and stop at the first
    /// non-URL byte (ESC, space, newline). Other google.com URLs (docs,
    /// telemetry) don't match the `/o/oauth2/` path and are ignored.
    pub(crate) fn extract_oauth_url(text: &str) -> Option<String> {
        static R: OnceLock<Regex> = OnceLock::new();
        let re = R.get_or_init(|| {
            Regex::new(r"https://accounts\.google\.com/o/oauth2/[\w.\-~:/?#\[\]@!$&'()*+,;=%]*")
                .expect("OAUTH_URL_RE")
        });
        re.find(text).map(|m| m.as_str().to_string())
    }

    /// True when agy's output signals an OAuth sign-in problem (banner or
    /// timeout) even if no URL could be parsed out of it. Case-insensitive
    /// substring match on the phrases agy 1.0.2 prints.
    pub(crate) fn looks_like_auth_failure(text: &str) -> bool {
        let t = text.to_lowercase();
        t.contains("authentication timed out")
            || t.contains("authentication required")
            || t.contains("please visit the url to log in")
    }

    /// Narrow check for the auth-TIMEOUT line specifically (agy gave up
    /// waiting for the code). Unlike `looks_like_auth_failure` this does
    /// NOT match the banner phrases ("authentication required"), so it's
    /// safe to use after AuthRequired was already shown — the banner is
    /// always in the buffer there, only the timeout line means failure.
    pub(crate) fn looks_like_auth_timeout(text: &str) -> bool {
        text.to_lowercase().contains("authentication timed out")
    }

    /// agy rejected the pasted code (bad / expired / wrong account). agy
    /// prints e.g. `authentication failed: token exchange failed: oauth2:
    /// "invalid_grant"`. Distinct from a timeout (code never arrived) and
    /// from success (no failure marker), so the user gets an accurate
    /// "the code was rejected" message instead of a vague one.
    pub(crate) fn looks_like_token_failure(text: &str) -> bool {
        let t = text.to_lowercase();
        t.contains("invalid_grant")
            || t.contains("authentication failed")
            || t.contains("token exchange failed")
    }

    /// Kill the PTY child. Used by `abort` and by the turn-completion
    /// logic. agy self-exits after a NORMAL `-p` turn, but a turn that went
    /// through the interactive OAuth prompt LINGERS (waiting on the terminal)
    /// — so once the answer/error has landed we kill it to unblock the turn.
    async fn kill_pty(handle: &Arc<Mutex<Option<Box<dyn ChildKiller + Send + Sync>>>>) {
        if let Some(k) = handle.lock().await.as_mut() {
            let _ = k.kill();
        }
    }

    /// Strip ANSI / terminal control sequences from raw PTY output so we
    /// can match phrases and surface plain text.
    pub(crate) fn strip_ansi(text: &str) -> String {
        static R: OnceLock<Regex> = OnceLock::new();
        let re = R.get_or_init(|| {
            // CSI (`ESC[ … letter`), OSC (`ESC] … BEL`), and stray `ESC x`.
            Regex::new(r"\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b.").expect("ANSI_RE")
        });
        re.replace_all(text, "").to_string()
    }

    /// Pull the model's answer (or agy's auth error) out of the PTY
    /// transcript of an AUTH turn — the text printed AFTER agy's
    /// "…press Enter:" code prompt, skipping the one echoed input line.
    /// Returns empty when no auth prompt was shown (a normal turn) or
    /// nothing has followed the code yet (still authenticating /
    /// generating), which the caller uses as the "answer not ready" signal.
    pub(crate) fn extract_pty_answer(full: &str) -> String {
        let clean = Self::strip_ansi(full);
        let Some((_, after)) = clean.rsplit_once("press Enter:") else {
            return String::new();
        };
        let mut lines = after
            .lines()
            .map(|l| l.trim_end())
            .skip_while(|l| l.trim().is_empty());
        // The first non-empty line after the prompt is agy echoing back
        // whatever was typed (the pasted code) — drop it; the rest is the
        // model's answer or agy's error.
        let _echoed = lines.next();
        lines.collect::<Vec<_>>().join("\n").trim().to_string()
    }

    /// The text currently "on screen" — agy paints every answer onto a
    /// freshly-cleared screen (`ESC[2J`), verified by probing a normal turn:
    /// the raw stream is `…ESC[2J ESC[m ESC[H <answer> CR LF`. Taking the
    /// tail after the LAST erase-display and stripping ANSI yields the clean
    /// answer for BOTH a normal turn and the post-OAuth turn (where the
    /// banner + code prompt precede that final clear). Falls back to the
    /// whole stripped buffer if agy never cleared the screen.
    pub(crate) fn last_screen(full: &str) -> String {
        let tail = full.rsplit_once("\x1b[2J").map_or(full, |(_, t)| t);
        Self::strip_ansi(tail).trim().to_string()
    }

    /// True when a screen looks like agy's OAuth banner / code prompt rather
    /// than a model answer — used to reject the banner as a false "answer".
    fn looks_like_auth_banner(screen: &str) -> bool {
        let s = screen.to_ascii_lowercase();
        s.contains("paste the authorization code")
            || s.contains("waiting for authentication")
            || s.contains("visit the url")
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
        let pty_writer_handle = self.pty_writer.clone();
        let pty_killer_handle = self.pty_killer.clone();
        let code_submitted = self.code_submitted.clone();
        let aborted = self.aborted.clone();
        // Set the instant the PTY reader detects agy's OAuth sign-in URL,
        // so the post-exit resolution knows an AuthRequired was emitted
        // and picks the FINAL outcome (reply vs timeout) accordingly.
        let auth_emitted = Arc::new(std::sync::atomic::AtomicBool::new(false));
        // Resolve agy to an absolute path — portable_pty's CommandBuilder
        // does not reliably search PATH under Windows ConPTY.
        let exe = which::which(&argv[0])
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|_| argv[0].clone());
        let args: Vec<String> = argv[1..].to_vec();

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

            tracing::info!(
                session_id = %session_id_out,
                cwd = %agent_cwd,
                conv = ?cached_conv_id,
                "antigravity bridge spawn (pty)"
            );

            // agy writes its OAuth banner + sign-in URL + "paste the code"
            // prompt to the CONSOLE (CONOUT$) directly — redirected
            // stdout/stderr pipes capture NOTHING (verified: 0 bytes on
            // both). So we run agy inside a pseudo-terminal (ConPTY on
            // Windows) that WE own: agy treats the PTY as its console, we
            // read everything from the master end, and we type the pasted
            // OAuth code back into it. portable_pty is blocking, so the
            // openpty + spawn runs on a blocking thread.
            let spawn_exe = exe.clone();
            let spawn_args = args.clone();
            let spawn_cwd = agent_cwd.clone();
            let setup = tokio::task::spawn_blocking(move || {
                let pty = native_pty_system();
                let pair = pty
                    .openpty(PtySize {
                        rows: 50,
                        cols: 240,
                        pixel_width: 0,
                        pixel_height: 0,
                    })
                    .map_err(|e| format!("openpty failed: {e}"))?;
                let mut cmd = CommandBuilder::new(&spawn_exe);
                for a in &spawn_args {
                    cmd.arg(a);
                }
                cmd.cwd(&spawn_cwd);
                let child = pair
                    .slave
                    .spawn_command(cmd)
                    .map_err(|e| format!("spawn failed: {e}"))?;
                drop(pair.slave);
                let reader = pair
                    .master
                    .try_clone_reader()
                    .map_err(|e| format!("pty reader failed: {e}"))?;
                let writer = pair
                    .master
                    .take_writer()
                    .map_err(|e| format!("pty writer failed: {e}"))?;
                let killer = child.clone_killer();
                Ok::<_, String>((pair.master, reader, writer, killer, child))
            })
            .await;

            let (master, reader, writer, killer, mut child) = match setup {
                Ok(Ok(t)) => t,
                Ok(Err(e)) => {
                    let _ = tx
                        .send(BridgeEvent::Error {
                            error: format!(
                                "failed to launch `agy`: {e}. Ensure Antigravity CLI is \
                                 installed and on PATH (Settings → Agents → Antigravity → \
                                 Install)."
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
                Err(e) => {
                    let _ = tx
                        .send(BridgeEvent::Error {
                            error: format!("antigravity pty setup task panicked: {e}"),
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

            // Expose the write half + killer so `send_auth_code` / `abort`
            // (and the auth-wait watchdog) can reach the live agy.
            *pty_writer_handle.lock().await = Some(writer);
            *pty_killer_handle.lock().await = Some(killer);

            // Blocking PTY read loop on a dedicated thread → forward raw
            // chunks to the async side. read == 0 (EOF) means agy exited.
            let (byte_tx, mut byte_rx) = mpsc::unbounded_channel::<Vec<u8>>();
            let reader_thread = std::thread::spawn(move || {
                let mut reader = reader;
                let mut buf = [0u8; 4096];
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => {
                            if byte_tx.send(buf[..n].to_vec()).is_err() {
                                break;
                            }
                        }
                        Err(_) => break,
                    }
                }
            });

            // Drive the turn on a 1-second tick.
            //
            // agy self-exits after every `-p` turn — normal, `--conversation`
            // resume, AND post-OAuth (the print-mode answer path is the same).
            // BUT on Windows ConPTY the master never signals EOF when the
            // child exits (verified: bytes flow, agy exits code 0, yet the
            // reader's `read()` never returns 0) — so `byte_rx` never closes.
            // We therefore poll `child.try_wait()` as the deterministic "turn
            // done" signal. The only state where agy stays alive is the auth
            // prompt waiting for the pasted code; the content checks handle
            // that:
            //   • OAuth URL seen → emit AuthRequired (the sign-in card).
            //   • banner shown, no code yet → wait for the user to paste (up
            //     to AUTH_CODE_WAIT_SECS, or until agy itself prints
            //     "authentication timed out").
            //   • code pasted → agy authenticates then runs the prompt and
            //     exits like any turn → `try_wait` catches it. A terminal
            //     error or the POST_CODE_GRACE_SECS backstop covers a stall.
            let mut full = String::new();
            let start_at = std::time::Instant::now();
            let mut last_output = std::time::Instant::now();
            let mut code_at: Option<std::time::Instant> = None;
            loop {
                match tokio::time::timeout(std::time::Duration::from_secs(1), byte_rx.recv()).await
                {
                    Ok(Some(chunk)) => {
                        full.push_str(&String::from_utf8_lossy(&chunk));
                        last_output = std::time::Instant::now();
                        if !auth_emitted.load(std::sync::atomic::Ordering::SeqCst) {
                            if let Some(url) = Self::extract_oauth_url(&full) {
                                if !auth_emitted.swap(true, std::sync::atomic::Ordering::SeqCst) {
                                    tracing::info!(
                                        session_id = %session_id_out,
                                        "antigravity bridge detected OAuth URL on PTY — \
                                         emitting AuthRequired, awaiting the pasted code"
                                    );
                                    let _ = tx
                                        .send(BridgeEvent::AuthRequired {
                                            provider: "antigravity".into(),
                                            url,
                                            opened_in_browser: false,
                                        })
                                        .await;
                                }
                            }
                        }
                    }
                    // Channel closed → agy self-exited (normal turn) or was
                    // killed. Either way the turn is over.
                    Ok(None) => break,
                    // 1-second idle tick — decide whether the turn is over.
                    Err(_) => {
                        if aborted.load(std::sync::atomic::Ordering::SeqCst) {
                            Self::kill_pty(&pty_killer_handle).await;
                            break;
                        }
                        // The deterministic completion signal: agy has exited
                        // (ConPTY won't EOF the reader, so we poll the child).
                        // Drain whatever the reader already buffered, then go.
                        if matches!(child.try_wait(), Ok(Some(_))) {
                            while let Ok(chunk) = byte_rx.try_recv() {
                                full.push_str(&String::from_utf8_lossy(&chunk));
                            }
                            break;
                        }
                        // agy is still alive → it's sitting at the auth prompt.
                        let banner = auth_emitted.load(std::sync::atomic::Ordering::SeqCst);
                        let coded = code_submitted.load(std::sync::atomic::Ordering::SeqCst);
                        if coded && code_at.is_none() {
                            code_at = Some(std::time::Instant::now());
                        }
                        if banner && !coded {
                            // Sign-in card is up; the user is signing in. agy
                            // abandons the auth after ~30s — surface that
                            // promptly instead of waiting the full cap.
                            if Self::looks_like_auth_timeout(&full)
                                || start_at.elapsed()
                                    >= std::time::Duration::from_secs(AUTH_CODE_WAIT_SECS)
                            {
                                Self::kill_pty(&pty_killer_handle).await;
                                break;
                            }
                        } else if banner {
                            // Code pasted but agy hasn't exited yet — normally
                            // `try_wait` above catches the exit. This is the
                            // stall safety net: a terminal auth error that
                            // settled, or the grace window lapsing.
                            let terminal_err = Self::looks_like_token_failure(&full)
                                || Self::looks_like_auth_timeout(&full);
                            let settled = last_output.elapsed()
                                >= std::time::Duration::from_secs(ANSWER_IDLE_SECS);
                            let grace_up = code_at.is_some_and(|t| {
                                t.elapsed() >= std::time::Duration::from_secs(POST_CODE_GRACE_SECS)
                            });
                            if (terminal_err && settled) || grace_up {
                                Self::kill_pty(&pty_killer_handle).await;
                                break;
                            }
                        }
                        if start_at.elapsed() >= std::time::Duration::from_secs(TURN_HARD_CAP_SECS)
                        {
                            Self::kill_pty(&pty_killer_handle).await;
                            break;
                        }
                    }
                }
            }
            // Reap the child for its exit code (returns immediately — it has
            // already exited or just been killed). DO NOT join the reader
            // thread: on ConPTY its blocking `read()` never returns after agy
            // exits (no EOF), so joining would deadlock. Dropping the PTY
            // master + the writer/killer handles closes the console handles,
            // which lets that detached thread fall out of `read()` on its own.
            let exit_code = tokio::task::spawn_blocking(move || {
                let mut child = child;
                child.wait().ok().map(|s| s.exit_code())
            })
            .await
            .ok()
            .flatten();
            *pty_writer_handle.lock().await = None;
            *pty_killer_handle.lock().await = None;
            drop(master);
            drop(reader_thread);

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

            // On-disk transcript tail for THIS turn (bytes appended after
            // `pre_transcript_size` only, so we never re-surface history).
            // Canonical for normal turns.
            let transcript_text = conv_id
                .as_deref()
                .and_then(|id| Self::read_transcript_response_since(id, pre_transcript_size));
            let transcript_reply = transcript_text
                .as_deref()
                .map(str::trim)
                .filter(|t| !t.is_empty())
                .map(str::to_string);

            // During a sign-in turn agy prints the model's answer straight
            // to the PTY in the SAME turn as the OAuth (verified: paste the
            // code → the answer lands immediately, painted onto a cleared
            // screen). The on-disk transcript often misses it — the
            // conversation is created mid-turn and races the cache write — so
            // recover the answer from the PTY as a secondary source. Prefer
            // `last_screen` (text after agy's final `ESC[2J`, which is how it
            // paints every answer) and fall back to the `press Enter:` marker
            // parse. Gate on a clean sign-in: a token rejection
            // (`invalid_grant`) leaves an error string on screen that must
            // NOT be surfaced as the model's reply.
            let auth = auth_emitted.load(std::sync::atomic::Ordering::SeqCst);
            let post_failed = Self::looks_like_token_failure(&full);
            let pty_answer = if auth && !post_failed {
                let screen = Self::last_screen(&full);
                let answer = if !screen.is_empty() && !Self::looks_like_auth_banner(&screen) {
                    screen
                } else {
                    Self::extract_pty_answer(&full)
                };
                (!answer.is_empty()).then_some(answer)
            } else {
                None
            };
            let reply = transcript_reply.or(pty_answer);

            tracing::info!(
                session_id = %session_id_out,
                conv = ?conv_id,
                auth = auth,
                pty_bytes = full.len(),
                has_reply = reply.is_some(),
                exit = ?exit_code,
                "antigravity bridge resolved turn"
            );

            if let Some(reply) = reply {
                // A real answer — transcript, or the PTY for a sign-in turn.
                let _ = tx.send(BridgeEvent::MessageDelta { text: reply }).await;
            } else if aborted.load(std::sync::atomic::Ordering::SeqCst) {
                let _ = tx
                    .send(BridgeEvent::Error {
                        error: if auth_emitted.load(std::sync::atomic::Ordering::SeqCst) {
                            "Antigravity sign-in cancelled.".into()
                        } else {
                            "Antigravity turn aborted.".into()
                        },
                    })
                    .await;
            } else if auth {
                // The sign-in card was shown but no answer could be
                // recovered (neither transcript nor PTY). Disambiguate the
                // real outcome so the chat doesn't mislead (the user
                // reported "it logs in but Fleet doesn't realise").
                let code_was_submitted = code_submitted.load(std::sync::atomic::Ordering::SeqCst);
                if post_failed {
                    // agy rejected the code (bad / expired / wrong account).
                    let _ = tx
                        .send(BridgeEvent::Error {
                            error: "Antigravity sign-in failed — the code was rejected (it may \
                                    be expired, mistyped, or for the wrong account). Re-send \
                                    your message to get a fresh sign-in link and try again."
                                .into(),
                        })
                        .await;
                } else if code_was_submitted && !Self::looks_like_auth_timeout(&full) {
                    // A code was pasted and agy reported no failure → the
                    // sign-in succeeded; agy just didn't answer this turn.
                    // Surface a friendly note (NOT a red error) telling the
                    // user they're in and to re-send to get their answer.
                    let _ = tx
                        .send(BridgeEvent::MessageDelta {
                            text: "✓ Signed in to Antigravity. Send your message again to get \
                                   your answer."
                                .into(),
                        })
                        .await;
                } else if Self::looks_like_auth_timeout(&full) {
                    // No code arrived within agy's ~30s window.
                    let _ = tx
                        .send(BridgeEvent::Error {
                            error: "Antigravity sign-in timed out — agy only waits ~30 seconds \
                                    for the code. Re-send your message for a fresh link, then \
                                    finish the browser step and paste the code promptly."
                                .into(),
                        })
                        .await;
                } else {
                    let _ = tx
                        .send(BridgeEvent::Error {
                            error: "Antigravity sign-in didn't complete. Re-send your message \
                                    to try again — finish the OAuth flow in your browser and \
                                    paste the code here."
                                .into(),
                        })
                        .await;
                }
            } else if Self::looks_like_auth_failure(&full) {
                // A sign-in banner appeared but no URL could be recovered.
                let _ = tx
                    .send(BridgeEvent::Error {
                        error: "Antigravity sign-in is required but the link couldn't be \
                                captured. Run `agy` once in a terminal to sign in (OAuth \
                                tokens expire), then re-send your message."
                            .into(),
                    })
                    .await;
            } else {
                // Genuinely no response on disk.
                let msg = if conv_id.is_none() {
                    format!(
                        "agy ran but didn't start a conversation for `{}`. Try running `agy` \
                         once interactively from any directory to verify your login is still \
                         active (OAuth tokens expire), then retry.",
                        agent_cwd,
                    )
                } else {
                    format!(
                        "agy produced no response on disk for conversation {} (exit {:?}). \
                         Check `~/.gemini/antigravity-cli/log/` for the most recent \
                         `cli-*.log` file.",
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

#[cfg(test)]
mod tests {
    use super::AntigravityBridge;

    #[test]
    fn extract_oauth_url_finds_the_google_accounts_link() {
        let stdout = concat!(
            "Authentication required. Please visit the URL to log in:\n",
            "  https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=abc&scope=openid\n",
            "Waiting for authentication (timeout 30s)...\n",
        );
        let got = AntigravityBridge::extract_oauth_url(stdout);
        assert_eq!(
            got.as_deref(),
            Some("https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=abc&scope=openid"),
        );
    }

    #[test]
    fn extract_oauth_url_returns_none_when_no_link_present() {
        assert_eq!(AntigravityBridge::extract_oauth_url(""), None);
        assert_eq!(
            AntigravityBridge::extract_oauth_url("just regular agy output"),
            None,
        );
    }

    #[test]
    fn extract_oauth_url_ignores_other_google_urls() {
        // Only the OAuth auth endpoint counts.
        let s = "Visit https://google.com/search?q=foo for help.";
        assert_eq!(AntigravityBridge::extract_oauth_url(s), None);
    }

    #[test]
    fn extract_oauth_url_extracts_just_the_token_when_followed_by_ansi() {
        // In a PTY the URL is terminated by an ANSI escape (cursor move),
        // NOT a newline — the regex must capture only the URL token and
        // stop at the ESC byte (this is exactly agy's real PTY output).
        let pty = "  https://accounts.google.com/o/oauth2/auth?client_id=abc&state=xyz\u{1b}[6;1HWaiting for authentication (timeout 30s)...";
        assert_eq!(
            AntigravityBridge::extract_oauth_url(pty).as_deref(),
            Some("https://accounts.google.com/o/oauth2/auth?client_id=abc&state=xyz"),
        );
    }

    #[test]
    fn last_screen_recovers_the_answer_from_a_real_normal_turn() {
        // Captured verbatim from `agy -p "merhaba"` in a PTY: agy enables
        // mouse/focus tracking, hides the cursor, ERASES the display, homes
        // the cursor, prints the answer, then sets the window title.
        let raw = "\u{1b}[?9001h\u{1b}[?1004h\u{1b}[?25l\u{1b}[2J\u{1b}[m\u{1b}[H\
                   Merhaba! Size nasıl yardımcı olabilirim?\r\n\
                   \u{1b}]0;C:\\Users\\loseu\\AppData\\Local\\agy\\bin\\agy.exe\u{07}\u{1b}[?25h";
        assert_eq!(
            AntigravityBridge::last_screen(raw),
            "Merhaba! Size nasıl yardımcı olabilirim?",
        );
    }

    #[test]
    fn last_screen_isolates_the_answer_on_an_auth_turn() {
        // The post-OAuth turn carries the whole banner + code prompt in the
        // buffer; agy then repaints (a second `ESC[2J`) to show the answer.
        // `last_screen` must return ONLY that final answer screen, not the
        // banner soup that a plain ANSI strip of the full buffer would give.
        let raw = "\u{1b}[2J\u{1b}[HAuthentication required. Please visit the URL to log in:\r\n\
                   \u{1b}[?25h\
                   Or, paste the authorization code here and press Enter:\r\n\
                   4/0AbcCODE\r\n\
                   \u{1b}[2J\u{1b}[m\u{1b}[HAleyküm selam! Bugün size nasıl yardımcı olabilirim?\r\n\
                   \u{1b}]0;title\u{07}\u{1b}[?25h";
        let screen = AntigravityBridge::last_screen(raw);
        assert_eq!(
            screen,
            "Aleyküm selam! Bugün size nasıl yardımcı olabilirim?"
        );
        assert!(!AntigravityBridge::looks_like_auth_banner(&screen));
    }

    #[test]
    fn looks_like_auth_banner_flags_the_prompt_not_a_model_answer() {
        assert!(AntigravityBridge::looks_like_auth_banner(
            "Or, paste the authorization code here and press Enter:"
        ));
        assert!(AntigravityBridge::looks_like_auth_banner(
            "Waiting for authentication (timeout 30s)..."
        ));
        assert!(!AntigravityBridge::looks_like_auth_banner(
            "Aleyküm selam! Size nasıl yardımcı olabilirim?"
        ));
    }

    #[test]
    fn looks_like_auth_failure_matches_known_phrases_case_insensitively() {
        assert!(AntigravityBridge::looks_like_auth_failure(
            "ERROR: Authentication Timed Out."
        ));
        assert!(AntigravityBridge::looks_like_auth_failure(
            "Authentication required. Please visit the URL to log in:"
        ));
        assert!(!AntigravityBridge::looks_like_auth_failure(
            "here is your normal answer"
        ));
    }

    #[test]
    fn looks_like_auth_timeout_is_narrow_and_ignores_the_banner() {
        // The timeout line → true.
        assert!(AntigravityBridge::looks_like_auth_timeout(
            "Error: authentication timed out."
        ));
        // The banner phrase alone (shown on EVERY sign-in) → false, so
        // it can't be mistaken for a failure after AuthRequired is up.
        assert!(!AntigravityBridge::looks_like_auth_timeout(
            "Authentication required. Please visit the URL to log in:"
        ));
        assert!(!AntigravityBridge::looks_like_auth_timeout("normal reply"));
    }

    #[test]
    fn looks_like_token_failure_matches_rejected_code_phrases() {
        assert!(AntigravityBridge::looks_like_token_failure(
            "Error: authentication failed: token exchange failed: oauth2: \"invalid_grant\""
        ));
        assert!(AntigravityBridge::looks_like_token_failure(
            "oauth2: invalid_grant"
        ));
        // A timeout is NOT a token rejection.
        assert!(!AntigravityBridge::looks_like_token_failure(
            "Error: authentication timed out."
        ));
        assert!(!AntigravityBridge::looks_like_token_failure("normal reply"));
    }
}
