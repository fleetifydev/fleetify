//! Voice dictation backend = transcription dispatch for the renderer's
//! webview capture.
//!
//! The renderer records the mic (getUserMedia + AudioWorklet), encodes a
//! 16 kHz mono WAV, base64s it, and calls `voice_transcribe`. We route to
//! one of four engines:
//! - `auto`: tries broker → byok → local in order; first success wins.
//! - `local`: on-device whisper.cpp (cargo feature `local-whisper`).
//! - `broker`: Fleetify-managed Groq via fleetify.dev — key server-side,
//!   authed with the Fleetify OAuth bearer (zero user setup, quota'd).
//! - `byok`: the user's own Groq / OpenAI key, kept in the OS keychain.
//!
//! Cloud calls go out from HERE (reqwest), never the renderer — so the
//! bearer / API key never crosses IPC and we sidestep webview CORS. Same
//! trust model as `github_link.rs`.

use std::sync::Arc;

use base64::Engine as _;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::shell::auth;

pub mod capture;

#[cfg(feature = "local-whisper")]
mod engine_local;
#[cfg(feature = "local-whisper")]
mod models;

/// Managed state: one live recording at a time.
/// Wrapped in Arc so IPC commands can clone the Arc before any `.await`,
/// keeping State<'_> out of async futures (required for 'static bound).
pub struct VoiceCaptureState(pub Arc<tokio::sync::Mutex<Option<capture::RecordingState>>>);

/// Cancellation flag for an in-progress model download.
/// Set to `true` by `voice_cancel_download`; reset to `false` at the
/// start of each new `voice_download_model` call.
pub struct DownloadCancelState(pub Arc<std::sync::atomic::AtomicBool>);

const LOG_TARGET: &str = "voice";
/// Keychain service for BYOK provider keys (account = provider name).
const BYOK_KEYCHAIN_SVC: &str = "Fleetify-Voice";

fn fail(code: &str, error: &str) -> Value {
    json!({ "ok": false, "code": code, "error": error })
}

fn api_base() -> String {
    auth::issuer()
}

fn decode_audio(audio_b64: &str) -> Result<Vec<u8>, Value> {
    base64::engine::general_purpose::STANDARD
        .decode(audio_b64.trim())
        .map_err(|e| fail("BAD_AUDIO", &format!("audio base64 decode: {e}")))
}

/// Dispatch from raw WAV bytes. Called by both the base64 IPC path and
/// the native capture path (`voice_stop_recording`).
pub async fn transcribe_bytes(
    wav: Vec<u8>,
    engine: String,
    language: String,
    model: String,
    prompt: String,
) -> Value {
    if wav.is_empty() {
        return fail("BAD_AUDIO", "empty audio");
    }
    tracing::info!(target: LOG_TARGET, engine = %engine, bytes = wav.len(), "transcribe");
    match engine.as_str() {
        "auto" => transcribe_auto(wav, &language, &model, &prompt).await,
        "local" => transcribe_local(wav, &language, &model).await,
        "broker" => transcribe_broker(wav, &language, &model, &prompt).await,
        "byok" => transcribe_byok(wav, &language, &model, &prompt).await,
        other => fail("BAD_ENGINE", &format!("unknown engine: {other}")),
    }
}

/// Legacy base64 entry point — kept for backward compat with any callers
/// that still send a base64-encoded WAV over IPC.
pub async fn transcribe(
    audio_b64: String,
    engine: String,
    language: String,
    model: String,
    prompt: String,
) -> Value {
    let bytes = match decode_audio(&audio_b64) {
        Ok(b) => b,
        Err(e) => return e,
    };
    transcribe_bytes(bytes, engine, language, model, prompt).await
}

// ── auto (broker → byok → local, first success wins) ─────────────
async fn transcribe_auto(wav: Vec<u8>, language: &str, model: &str, prompt: &str) -> Value {
    // 1. Broker: if a valid Fleetify session exists
    let has_token = auth::get_access_token(false)
        .await
        .and_then(|v| v.get("token").and_then(|t| t.as_str()).map(String::from))
        .is_some();
    if has_token {
        let r = transcribe_broker(wav.clone(), language, model, prompt).await;
        if r.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
            return r;
        }
        // Quota or transient error → try next engine.
    }

    // 2. BYOK: if any provider key is saved in the keychain
    let has_byok = byok_key("groq").map(|k| !k.is_empty()).unwrap_or(false)
        || byok_key("openai").map(|k| !k.is_empty()).unwrap_or(false);
    if has_byok {
        let r = transcribe_byok(wav.clone(), language, model, prompt).await;
        if r.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
            return r;
        }
    }

    // 3. Local: any downloaded Whisper model (cfg-gated)
    transcribe_auto_local(wav, language, model).await
}

#[cfg(feature = "local-whisper")]
async fn transcribe_auto_local(wav: Vec<u8>, language: &str, model: &str) -> Value {
    let r = transcribe_local(wav, language, model).await;
    if r.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
        return r;
    }
    fail(
        "NO_ENGINE",
        "No voice engine available. Sign in to Fleetify, add an API key, or download a local model in Settings → Voice.",
    )
}

#[cfg(not(feature = "local-whisper"))]
async fn transcribe_auto_local(_wav: Vec<u8>, _language: &str, _model: &str) -> Value {
    fail(
        "NO_ENGINE",
        "No voice engine available. Sign in to Fleetify or add an API key in Settings → Voice.",
    )
}

// ── local (on-device whisper.cpp) ─────────────────────────────────
#[cfg(feature = "local-whisper")]
async fn transcribe_local(wav: Vec<u8>, language: &str, model: &str) -> Value {
    let Some(model_path) = models::resolve_model_path(model) else {
        return fail(
            "NO_MODEL",
            "No local Whisper model downloaded. Download one in Settings → Voice.",
        );
    };
    let language = language.to_string();
    // whisper.cpp inference is blocking + heavy → off the async runtime.
    match tokio::task::spawn_blocking(move || engine_local::run(&model_path, &wav, &language)).await
    {
        Ok(Ok(out)) => json!({
            "ok": true,
            "text": out.text,
            "language": out.language,
            "duration_seconds": out.duration_seconds,
            "source": "local",
        }),
        Ok(Err(e)) => fail("LOCAL_FAILED", &e),
        Err(e) => fail("LOCAL_FAILED", &e.to_string()),
    }
}
#[cfg(not(feature = "local-whisper"))]
async fn transcribe_local(_wav: Vec<u8>, _language: &str, _model: &str) -> Value {
    fail(
        "LOCAL_UNAVAILABLE",
        "This build was compiled without the local Whisper engine. Use the managed cloud (broker) or your own key (BYOK).",
    )
}

// ── broker (Fleetify-managed Groq via fleetify.dev) ───────────────
async fn transcribe_broker(wav: Vec<u8>, language: &str, model: &str, prompt: &str) -> Value {
    let bearer = auth::get_access_token(false)
        .await
        .and_then(|v| v.get("token").and_then(|t| t.as_str()).map(String::from));
    let Some(bearer) = bearer else {
        return fail(
            "NO_TOKEN",
            "Sign in to Fleetify to use cloud voice — or switch to your own key in Settings → Voice.",
        );
    };

    // Capture the byte length before `wav` is moved into the multipart part.
    let audio_bytes = wav.len();
    let part = match reqwest::multipart::Part::bytes(wav)
        .file_name("audio.wav")
        .mime_str("audio/wav")
    {
        Ok(p) => p,
        Err(e) => return fail("ERROR", &e.to_string()),
    };
    let mut form = reqwest::multipart::Form::new().part("audio", part);
    if !language.is_empty() && language != "auto" {
        form = form.text("language", language.to_string());
    }
    if !model.is_empty() {
        form = form.text("model", model.to_string());
    }
    if !prompt.is_empty() {
        form = form.text("prompt", prompt.to_string());
    }

    let url = format!("{}/api/integrations/voice/transcribe", api_base());
    tracing::info!(
        target: LOG_TARGET,
        engine = "broker",
        url = %url,
        language = %language,
        model = %model,
        audio_bytes,
        "broker request →"
    );
    match reqwest::Client::new()
        .post(&url)
        .bearer_auth(&bearer)
        .multipart(form)
        .send()
        .await
    {
        Ok(r) => {
            let status = r.status().as_u16();
            if status == 429 {
                tracing::warn!(target: LOG_TARGET, status, "broker ← quota exceeded");
                return fail(
                    "QUOTA_EXCEEDED",
                    "Daily managed-transcription quota reached. Use the local engine or your own key.",
                );
            }
            if !(200..=299).contains(&status) {
                let body = r.text().await.unwrap_or_default();
                tracing::warn!(
                    target: LOG_TARGET,
                    status,
                    body = %body.chars().take(200).collect::<String>(),
                    "broker ← error"
                );
                return fail(
                    "BROKER_FAILED",
                    &format!(
                        "broker {status}: {}",
                        body.chars().take(200).collect::<String>()
                    ),
                );
            }
            let j: Value = r.json().await.unwrap_or_else(|_| json!({}));
            let text = j
                .get("text")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let lang = j
                .get("language")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown");
            let dur = j
                .get("duration_seconds")
                .and_then(|v| v.as_f64())
                .unwrap_or(0.0);
            tracing::info!(
                target: LOG_TARGET,
                status,
                language = lang,
                duration_s = dur,
                text_chars = text.len(),
                text_preview = %text.chars().take(120).collect::<String>(),
                "broker ← ok"
            );
            json!({
                "ok": true,
                "text": text,
                "language": j.get("language").cloned().unwrap_or(Value::Null),
                "duration_seconds": dur,
                "source": "broker",
            })
        }
        Err(e) => {
            tracing::error!(target: LOG_TARGET, error = %e, "broker ← unreachable");
            fail("BROKER_FAILED", &e.to_string())
        }
    }
}

// ── byok (user's own Groq / OpenAI key) ───────────────────────────
async fn transcribe_byok(wav: Vec<u8>, language: &str, model: &str, prompt: &str) -> Value {
    // Model prefix selects the provider: `gpt-*` → OpenAI, else Groq.
    let (provider, endpoint, default_model) = if model.starts_with("gpt-") {
        (
            "openai",
            "https://api.openai.com/v1/audio/transcriptions",
            "gpt-4o-transcribe",
        )
    } else {
        (
            "groq",
            "https://api.groq.com/openai/v1/audio/transcriptions",
            "whisper-large-v3-turbo",
        )
    };
    let key = match byok_key(provider) {
        Some(k) if !k.is_empty() => k,
        _ => {
            return fail(
                "NO_KEY",
                &format!("No {provider} API key set. Add one in Settings → Voice."),
            )
        }
    };
    let use_model = if model.is_empty() {
        default_model.to_string()
    } else {
        model.to_string()
    };

    let part = match reqwest::multipart::Part::bytes(wav)
        .file_name("audio.wav")
        .mime_str("audio/wav")
    {
        Ok(p) => p,
        Err(e) => return fail("ERROR", &e.to_string()),
    };
    let mut form = reqwest::multipart::Form::new()
        .part("file", part)
        .text("model", use_model)
        .text("response_format", "verbose_json");
    if !language.is_empty() && language != "auto" {
        form = form.text("language", language.to_string());
    }
    if !prompt.is_empty() {
        form = form.text("prompt", prompt.to_string());
    }

    match reqwest::Client::new()
        .post(endpoint)
        .bearer_auth(&key)
        .multipart(form)
        .send()
        .await
    {
        Ok(r) => {
            let status = r.status().as_u16();
            if !(200..=299).contains(&status) {
                let body = r.text().await.unwrap_or_default();
                return fail(
                    "BYOK_FAILED",
                    &format!(
                        "{provider} {status}: {}",
                        body.chars().take(200).collect::<String>()
                    ),
                );
            }
            let j: Value = r.json().await.unwrap_or_else(|_| json!({}));
            json!({
                "ok": true,
                "text": j.get("text").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                "language": j.get("language").cloned().unwrap_or(Value::Null),
                "duration_seconds": j.get("duration").and_then(|v| v.as_f64()).unwrap_or(0.0),
                "source": "byok",
            })
        }
        Err(e) => fail("BYOK_FAILED", &e.to_string()),
    }
}

// ── BYOK key storage (OS keychain — never crosses to the renderer) ─
fn byok_entry(provider: &str) -> keyring::Result<keyring::Entry> {
    keyring::Entry::new(BYOK_KEYCHAIN_SVC, provider)
}
fn byok_key(provider: &str) -> Option<String> {
    byok_entry(provider)
        .ok()
        .and_then(|e| e.get_password().ok())
}
/// Store (or clear, when `key` is empty) a provider's BYOK key.
pub fn set_byok_key(provider: &str, key: &str) -> Value {
    let Ok(entry) = byok_entry(provider) else {
        return fail("KEYCHAIN", "keychain unavailable");
    };
    let r = if key.is_empty() {
        entry.delete_credential().map(|_| ())
    } else {
        entry.set_password(key)
    };
    match r {
        Ok(_) => json!({ "ok": true }),
        Err(e) => fail("KEYCHAIN", &e.to_string()),
    }
}
/// Whether a provider key is present (the key itself never leaves Rust).
pub fn has_byok_key(provider: &str) -> Value {
    json!({ "ok": true, "present": byok_key(provider).map(|k| !k.is_empty()).unwrap_or(false) })
}

// ── local model management ────────────────────────────────────────
#[cfg(feature = "local-whisper")]
pub fn list_models() -> Value {
    models::list()
}
#[cfg(not(feature = "local-whisper"))]
pub fn list_models() -> Value {
    json!({ "ok": true, "supported": false, "models": [] })
}

#[cfg(feature = "local-whisper")]
pub async fn download_model(app: AppHandle, id: String) -> Value {
    // Clone the Arc before any await so State<'_> never crosses an await point.
    let cancel: Arc<std::sync::atomic::AtomicBool> =
        Arc::clone(&app.state::<DownloadCancelState>().0);
    cancel.store(false, std::sync::atomic::Ordering::Relaxed);
    models::download(app, id, cancel).await
}
#[cfg(not(feature = "local-whisper"))]
pub async fn download_model(_app: AppHandle, _id: String) -> Value {
    fail(
        "LOCAL_UNAVAILABLE",
        "Local Whisper engine not built in this binary.",
    )
}

pub fn cancel_download(app: AppHandle) -> Value {
    let cancel: Arc<std::sync::atomic::AtomicBool> =
        Arc::clone(&app.state::<DownloadCancelState>().0);
    cancel.store(true, std::sync::atomic::Ordering::Relaxed);
    json!({ "ok": true })
}
