//! Voice dictation backend = transcription dispatch for the renderer's
//! webview capture.
//!
//! The renderer records the mic (getUserMedia + AudioWorklet), encodes a
//! 16 kHz mono WAV, base64s it, and calls `voice_transcribe`. We route to
//! one of three engines:
//! - `local`: on-device whisper.cpp (cargo feature `local-whisper`).
//! - `broker`: Fleetify-managed Groq via fleetify.dev — key server-side,
//!   authed with the Fleetify OAuth bearer (zero user setup, quota'd).
//! - `byok`: the user's own Groq / OpenAI key, kept in the OS keychain.
//!
//! Cloud calls go out from HERE (reqwest), never the renderer — so the
//! bearer / API key never crosses IPC and we sidestep webview CORS. Same
//! trust model as `github_link.rs`.

use base64::Engine as _;
use serde_json::{json, Value};
use tauri::AppHandle;

use crate::shell::auth;

#[cfg(feature = "local-whisper")]
mod engine_local;
#[cfg(feature = "local-whisper")]
mod models;

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

/// Dispatch a transcription request. `engine` ∈ {`local`, `broker`, `byok`}.
/// Returns `{ ok, text, language, duration_seconds, source }` or
/// `{ ok:false, code, error }`.
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
    if bytes.is_empty() {
        return fail("BAD_AUDIO", "empty audio");
    }
    tracing::info!(target: LOG_TARGET, engine = %engine, bytes = bytes.len(), "transcribe");

    match engine.as_str() {
        "local" => transcribe_local(bytes, &language, &model).await,
        "broker" => transcribe_broker(bytes, &language, &model, &prompt).await,
        "byok" => transcribe_byok(bytes, &language, &model, &prompt).await,
        other => fail("BAD_ENGINE", &format!("unknown engine: {other}")),
    }
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
            "Fleetify sign-in required for managed transcription.",
        );
    };

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
                return fail(
                    "QUOTA_EXCEEDED",
                    "Daily managed-transcription quota reached. Use the local engine or your own key.",
                );
            }
            if !(200..=299).contains(&status) {
                let body = r.text().await.unwrap_or_default();
                return fail(
                    "BROKER_FAILED",
                    &format!(
                        "broker {status}: {}",
                        body.chars().take(200).collect::<String>()
                    ),
                );
            }
            let j: Value = r.json().await.unwrap_or_else(|_| json!({}));
            json!({
                "ok": true,
                "text": j.get("text").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                "language": j.get("language").cloned().unwrap_or(Value::Null),
                "duration_seconds": j.get("duration_seconds").and_then(|v| v.as_f64()).unwrap_or(0.0),
                "source": "broker",
            })
        }
        Err(e) => fail("BROKER_FAILED", &e.to_string()),
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
    models::download(app, &id).await
}
#[cfg(not(feature = "local-whisper"))]
pub async fn download_model(_app: AppHandle, _id: String) -> Value {
    fail(
        "LOCAL_UNAVAILABLE",
        "Local Whisper engine not built in this binary.",
    )
}
