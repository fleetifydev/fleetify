//! Faithful port of `app/routers/providers.py` — model catalog and
//! provider/CLI scan (claude/gemini/codex CLI presence + auth indicators,
//! ollama HTTP probe, env-key inventory).

use std::path::PathBuf;
use std::time::Duration;

use axum::routing::get;
use axum::{Json, Router};
use serde_json::{json, Value};
use tokio::process::Command;

use crate::routers::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/models", get(list_models))
        .route("/providers/scan", get(scan_providers))
}

fn home() -> PathBuf {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."))
}

/// `which` via `<bin> --version` (avoids a `which` crate dep).
async fn cli_path(bin: &str) -> Option<String> {
    let out = Command::new(bin).arg("--version").output().await.ok()?;
    if out.status.success() {
        // `bin` is the resolved name on PATH. Return Some(bin) — the
        // renderer just needs a truthy string to render "installed".
        Some(bin.to_string())
    } else {
        None
    }
}

async fn check_claude_cli() -> Value {
    let Some(p) = cli_path("claude").await else {
        return json!({ "installed": false, "authenticated": false, "path": null });
    };
    let cd = home().join(".claude");
    let indicators = [
        cd.join("projects"),
        cd.join("sessions"),
        cd.join("history.jsonl"),
        home().join(".config/anthropic/credentials.json"),
    ];
    let mut authed = indicators.iter().any(|x| x.exists());
    if !authed && std::env::var("ANTHROPIC_API_KEY").is_ok() {
        authed = true;
    }
    json!({ "installed": true, "authenticated": authed, "path": p })
}

async fn check_gemini_cli() -> Value {
    let Some(p) = cli_path("gemini").await else {
        return json!({ "installed": false, "authenticated": false, "path": null });
    };
    let authed = home().join(".gemini/oauth_creds.json").exists()
        || std::env::var("GEMINI_API_KEY").is_ok()
        || std::env::var("GOOGLE_API_KEY").is_ok();
    json!({ "installed": true, "authenticated": authed, "path": p })
}

async fn check_codex_cli() -> Value {
    let Some(p) = cli_path("codex").await else {
        return json!({ "installed": false, "authenticated": false, "path": null });
    };
    let authed = home().join(".codex/auth.json").exists()
        || std::env::var("OPENAI_API_KEY").is_ok();
    json!({ "installed": true, "authenticated": authed, "path": p })
}

async fn check_ollama() -> Value {
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
    {
        Ok(c) => c,
        Err(_) => return json!({ "running": false, "models": [] }),
    };
    let resp = match client.get("http://localhost:11434/api/tags").send().await {
        Ok(r) => r,
        Err(_) => return json!({ "running": false, "models": [] }),
    };
    if !resp.status().is_success() {
        return json!({ "running": false, "models": [] });
    }
    let body: Value = match resp.json().await {
        Ok(v) => v,
        Err(_) => return json!({ "running": false, "models": [] }),
    };
    let models: Vec<String> = body
        .get("models")
        .and_then(|m| m.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|m| m.get("name").and_then(|n| n.as_str()).map(String::from))
                .take(10)
                .collect()
        })
        .unwrap_or_default();
    json!({ "running": true, "models": models })
}

async fn scan_providers() -> Json<Value> {
    let (claude, gemini, codex, ollama) = tokio::join!(
        check_claude_cli(),
        check_gemini_cli(),
        check_codex_cli(),
        check_ollama(),
    );
    Json(json!({
        "claude_cli": claude,
        "gemini_cli": gemini,
        "codex_cli": codex,
        "ollama": ollama,
        "env_keys": {
            "anthropic": std::env::var("ANTHROPIC_API_KEY").is_ok(),
            "openai": std::env::var("OPENAI_API_KEY").is_ok(),
            "gemini":
                std::env::var("GEMINI_API_KEY").is_ok()
                    || std::env::var("GOOGLE_API_KEY").is_ok(),
            "groq": std::env::var("GROQ_API_KEY").is_ok(),
        },
    }))
}

/// Faithful with `app/utils/models.py` MODEL_CATALOG_BY_PROVIDER — the
/// new-chat picker's source of truth. Newest-most-capable → fastest →
/// legacy within each provider, top-down by recency.
async fn list_models() -> Json<Value> {
    Json(json!({
        "providers": [
            {
                "id": "claude",
                "label": "Claude",
                "models": [
                    {"id": "claude-opus-4-7",           "label": "Opus 4.7",      "ctx": "200K"},
                    {"id": "claude-opus-4-7[1m]",       "label": "Opus 4.7 (1M)", "ctx": "1M"},
                    {"id": "claude-opus-4-6",           "label": "Opus 4.6",      "ctx": "200K"},
                    {"id": "claude-sonnet-4-6",         "label": "Sonnet 4.6",    "ctx": "200K"},
                    {"id": "claude-haiku-4-5-20251001", "label": "Haiku 4.5",     "ctx": "200K"},
                    {"id": "claude-3-7-sonnet-latest",  "label": "Sonnet 3.7",    "ctx": "200K", "note": "Legacy"},
                    {"id": "claude-3-5-sonnet-latest",  "label": "Sonnet 3.5",    "ctx": "200K", "note": "Legacy"},
                    {"id": "claude-3-5-haiku-latest",   "label": "Haiku 3.5",     "ctx": "200K", "note": "Legacy"},
                    {"id": "claude-3-opus-latest",      "label": "Opus 3",        "ctx": "200K", "note": "Legacy"},
                ]
            },
            {
                "id": "codex",
                "label": "Codex",
                "models": [
                    {"id": "gpt-5.5",   "label": "GPT-5.5",   "ctx": "200K"},
                    {"id": "gpt-5.4",   "label": "GPT-5.4",   "ctx": "200K"},
                    {"id": "gpt-5.2",   "label": "GPT-5.2",   "ctx": "200K"},
                    {"id": "codex-mini","label": "Codex mini","ctx": "200K"},
                ]
            },
            {
                "id": "openai",
                "label": "OpenAI",
                "models": [
                    {"id": "o3",          "label": "o3",          "ctx": "200K"},
                    {"id": "o3-mini",     "label": "o3 mini",     "ctx": "200K"},
                    {"id": "o4-mini",     "label": "o4 mini",     "ctx": "200K"},
                    {"id": "o1",          "label": "o1",          "ctx": "200K", "note": "Legacy"},
                    {"id": "o1-mini",     "label": "o1 mini",     "ctx": "128K", "note": "Legacy"},
                    {"id": "gpt-4o",      "label": "GPT-4o",      "ctx": "128K"},
                    {"id": "gpt-4o-mini", "label": "GPT-4o mini", "ctx": "128K"},
                    {"id": "gpt-4-turbo", "label": "GPT-4 Turbo", "ctx": "128K", "note": "Legacy"},
                    {"id": "gpt-4",       "label": "GPT-4",       "ctx": "8K",   "note": "Legacy"},
                    {"id": "gpt-3.5-turbo","label": "GPT-3.5 Turbo","ctx":"16K", "note": "Legacy"},
                ]
            },
            {
                "id": "gemini",
                "label": "Gemini",
                "models": [
                    {"id": "gemini-3.1-pro-preview",        "label": "3.1 Pro",  "ctx": "1M", "note": "Preview"},
                    {"id": "gemini-3-flash-preview",        "label": "3 Flash",  "ctx": "1M", "note": "Preview"},
                    {"id": "gemini-3.1-flash-lite-preview", "label": "3.1 Lite", "ctx": "1M", "note": "Preview"},
                    {"id": "gemini-2.5-pro",                "label": "2.5 Pro",  "ctx": "1M"},
                    {"id": "gemini-2.5-flash",              "label": "2.5 Flash","ctx": "1M"},
                    {"id": "gemini-2.0-flash",              "label": "2.0 Flash","ctx": "1M", "note": "Legacy"},
                    {"id": "gemini-2.0-flash-lite",         "label": "2.0 Flash Lite","ctx":"1M","note":"Legacy"},
                    {"id": "gemini-1.5-pro",                "label": "1.5 Pro",  "ctx": "2M", "note": "Legacy"},
                    {"id": "gemini-1.5-flash",              "label": "1.5 Flash","ctx": "1M", "note": "Legacy"},
                ]
            }
        ]
    }))
}
