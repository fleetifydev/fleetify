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
        .route("/providers/catalog", get(providers_catalog))
        .route("/agents/scan", get(scan_agents_registry))
}

/// Static catalog that drives Settings → Models tiles, Settings → Agents
/// tiles, and the chat composer's grouped model picker. Returns the
/// `'static` provider registry verbatim — no I/O, no auth check, safe to
/// poll without rate-limiting concerns.
async fn providers_catalog() -> Json<&'static [crate::providers::ProviderSpec]> {
    Json(crate::providers::CATALOG)
}

/// Registry-driven CLI agent scan — replacement for `scan_providers`
/// that consumes `providers::list_cli_agents()` instead of hardcoding
/// claude/codex/gemini. Each entry reports presence on PATH + whether
/// any of the registry's `auth_indicators` fire. Drives Settings →
/// Agents tiles + the New Agent dialog detection chips.
async fn scan_agents_registry() -> Json<Value> {
    use crate::providers::AuthIndicator;
    let mut out = serde_json::Map::new();
    for spec in crate::providers::list_cli_agents() {
        let path = cli_path(spec.bin).await;
        let installed = path.is_some();
        let authenticated = if installed {
            spec.auth_indicators.iter().any(|ind| match ind {
                AuthIndicator::HomeDir { path } => home().join(path).exists(),
                AuthIndicator::EnvVar { name } => std::env::var(name).is_ok(),
            })
        } else {
            false
        };
        crate::services::telemetry::emitters::emit_agent_detected(
            spec.id,
            installed,
            authenticated,
        )
        .await;
        out.insert(
            spec.id.to_string(),
            json!({
                "id": spec.id,
                "display_name": spec.display_name,
                "installed": installed,
                "authenticated": authenticated,
                "path": path,
                "install_hint": spec.install_hint,
                "login_hint": spec.login_hint,
            }),
        );
    }
    Json(Value::Object(out))
}

fn home() -> PathBuf {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."))
}

/// Resolve `<bin>` on PATH and return its absolute path. Uses the
/// `which` crate so Windows `.cmd` / `.bat` / `.ps1` shims (which
/// `npm install -g` creates for gemini / codex / claude) resolve via
/// PATHEXT — `tokio::process::Command::new("gemini")` otherwise fails
/// on Windows because it doesn't honour PATHEXT for bare names. This
/// is exactly the "Not Installed" symptom users hit when the CLI is
/// installed but the renderer claims otherwise.
async fn cli_path(bin: &str) -> Option<String> {
    // 1. `which` honours PATHEXT — finds gemini.cmd / codex.cmd / etc.
    if let Ok(p) = which::which(bin) {
        // 2. Verify with `--version` against the absolute path so we
        //    don't claim "installed" for a broken shim. Best-effort:
        //    when `--version` fails (some pre-release builds don't
        //    implement it) we still report the path — the user sees
        //    "installed" instead of a misleading "not installed".
        let _ = Command::new(&p).arg("--version").output().await;
        return Some(p.to_string_lossy().into_owned());
    }
    // 3. Last-ditch Unix fallback: bare-name spawn (which might fail
    //    if `which` itself isn't on PATH but the binary still is).
    let out = Command::new(bin).arg("--version").output().await.ok()?;
    if out.status.success() {
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
    let authed =
        home().join(".codex/auth.json").exists() || std::env::var("OPENAI_API_KEY").is_ok();
    json!({ "installed": true, "authenticated": authed, "path": p })
}

/// Probe an Ollama daemon. Base URL is parameterized so callers can
/// point at a LAN box (`http://192.168.1.50:11434`) when the user has
/// configured `ProvidersConfig.ollama_base_url`. Defaults to localhost
/// when no value is supplied.
async fn check_ollama(base_url: Option<&str>) -> Value {
    let base = base_url.unwrap_or("http://localhost:11434");
    let url = format!("{}/api/tags", base.trim_end_matches('/'));
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
    {
        Ok(c) => c,
        Err(_) => return json!({ "running": false, "models": [], "base_url": base }),
    };
    let resp = match client.get(&url).send().await {
        Ok(r) => r,
        Err(_) => return json!({ "running": false, "models": [], "base_url": base }),
    };
    if !resp.status().is_success() {
        return json!({ "running": false, "models": [], "base_url": base });
    }
    let body: Value = match resp.json().await {
        Ok(v) => v,
        Err(_) => return json!({ "running": false, "models": [], "base_url": base }),
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
    json!({ "running": true, "models": models, "base_url": base })
}

async fn scan_providers() -> Json<Value> {
    // The legacy scan endpoint doesn't have access to ProvidersConfig
    // (it lives in the Tauri shell's fleet.config.json, not the
    // backend's AppState), so we fall back to the localhost default
    // here. The new `providers_ollama_probe` IPC honours the user's
    // configured URL for the Settings surface.
    let (claude, gemini, codex, ollama) = tokio::join!(
        check_claude_cli(),
        check_gemini_cli(),
        check_codex_cli(),
        check_ollama(None),
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
