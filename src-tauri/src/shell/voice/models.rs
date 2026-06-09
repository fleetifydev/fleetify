//! Local Whisper model catalog + downloader. GGML models are pulled from
//! the whisper.cpp Hugging Face repo into `fleetify_home()/models/whisper/`.
//! Download progress streams to the renderer via `voice-model-progress`.

use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

struct ModelDef {
    id: &'static str,
    name: &'static str,
    file: &'static str,
    url: &'static str,
    size_mb: u32,
}

const MODELS: &[ModelDef] = &[
    ModelDef {
        id: "large-v3-turbo",
        name: "Large v3 Turbo — best multilingual",
        file: "ggml-large-v3-turbo.bin",
        url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin",
        size_mb: 1624,
    },
    ModelDef {
        id: "small",
        name: "Small — faster, good multilingual",
        file: "ggml-small.bin",
        url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin",
        size_mb: 488,
    },
    ModelDef {
        id: "base",
        name: "Base — fastest, lowest accuracy",
        file: "ggml-base.bin",
        url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin",
        size_mb: 148,
    },
];

fn models_dir() -> PathBuf {
    let d = fleetify_core::fleetify_home()
        .join("models")
        .join("whisper");
    let _ = std::fs::create_dir_all(&d);
    d
}
fn def(id: &str) -> Option<&'static ModelDef> {
    MODELS.iter().find(|m| m.id == id)
}

/// Resolve the model file to transcribe with: the requested id if it's
/// downloaded, else any downloaded model (best-first), else None.
pub fn resolve_model_path(id: &str) -> Option<PathBuf> {
    let dir = models_dir();
    if let Some(m) = def(id) {
        let p = dir.join(m.file);
        if p.exists() {
            return Some(p);
        }
    }
    MODELS.iter().map(|m| dir.join(m.file)).find(|p| p.exists())
}

pub fn list() -> Value {
    let dir = models_dir();
    let models: Vec<Value> = MODELS
        .iter()
        .map(|m| {
            json!({
                "id": m.id,
                "name": m.name,
                "size_mb": m.size_mb,
                "downloaded": dir.join(m.file).exists(),
            })
        })
        .collect();
    json!({ "ok": true, "supported": true, "models": models })
}

pub async fn download(app: AppHandle, id: String, cancel: Arc<AtomicBool>) -> Value {
    let Some(m) = def(&id) else {
        return json!({ "ok": false, "code": "BAD_MODEL", "error": "unknown model" });
    };
    let dest = models_dir().join(m.file);
    if dest.exists() {
        return json!({ "ok": true, "already": true });
    }
    let tmp = dest.with_extension("part");

    let mut resp = match reqwest::Client::new().get(m.url).send().await {
        Ok(r) if r.status().is_success() => r,
        Ok(r) => {
            return json!({ "ok": false, "code": "DOWNLOAD_FAILED", "error": format!("http {}", r.status()) })
        }
        Err(e) => return json!({ "ok": false, "code": "DOWNLOAD_FAILED", "error": e.to_string() }),
    };
    let total = resp.content_length().unwrap_or(0);

    let mut file = match std::fs::File::create(&tmp) {
        Ok(f) => f,
        Err(e) => return json!({ "ok": false, "code": "IO", "error": e.to_string() }),
    };
    use std::io::Write;
    let mut received: u64 = 0;
    loop {
        // Check cancellation before reading next chunk.
        if cancel.load(Ordering::Relaxed) {
            drop(file);
            let _ = std::fs::remove_file(&tmp);
            let _ = app.emit(
                "voice-model-progress",
                json!({ "id": id, "cancelled": true }),
            );
            return json!({ "ok": false, "code": "CANCELLED", "error": "Download cancelled" });
        }
        match resp.chunk().await {
            Ok(Some(bytes)) => {
                if file.write_all(&bytes).is_err() {
                    let _ = std::fs::remove_file(&tmp);
                    return json!({ "ok": false, "code": "IO", "error": "write failed" });
                }
                received += bytes.len() as u64;
                let _ = app.emit(
                    "voice-model-progress",
                    json!({ "id": id, "received": received, "total": total }),
                );
            }
            Ok(None) => break,
            Err(e) => {
                let _ = std::fs::remove_file(&tmp);
                return json!({ "ok": false, "code": "DOWNLOAD_FAILED", "error": e.to_string() });
            }
        }
    }
    drop(file);
    if std::fs::rename(&tmp, &dest).is_err() {
        let _ = std::fs::remove_file(&tmp);
        return json!({ "ok": false, "code": "IO", "error": "finalize failed" });
    }
    let _ = app.emit(
        "voice-model-progress",
        json!({ "id": id, "received": received, "total": total, "done": true }),
    );
    json!({ "ok": true })
}
