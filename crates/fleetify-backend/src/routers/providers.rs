//! Faithful port of `app/routers/providers.py` — model catalog and
//! provider/CLI scan (claude/codex CLI presence + auth indicators,
//! ollama HTTP probe, env-key inventory).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use axum::extract::{Path, Query, State};
use axum::routing::{get, post};
use axum::{Json, Router};
use fleetify_core::process::tokio_command;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::RwLock;

use crate::providers::cli_auth;
use crate::routers::AppState;

/// In-memory cache of the most recent CLI agent scan. Backend warms it
/// at startup; the endpoints rescan once it's older than
/// [`AGENT_SCAN_MAX_AGE`]; install / login / key changes invalidate it.
#[derive(Clone, Default)]
pub struct AgentScanCache {
    inner: Arc<RwLock<Option<TimedScan>>>,
}

/// A scan and when it was taken.
struct TimedScan {
    at: Instant,
    scan: HashMap<String, Value>,
}

impl AgentScanCache {
    /// The last scan, however old (Auto routing and the default-agent pick
    /// would rather use a stale scan than wait for a new one).
    pub async fn get(&self) -> Option<HashMap<String, Value>> {
        self.inner.read().await.as_ref().map(|t| t.scan.clone())
    }

    /// The last scan if it's younger than `max_age`.
    pub async fn get_fresh(&self, max_age: Duration) -> Option<HashMap<String, Value>> {
        self.inner
            .read()
            .await
            .as_ref()
            .filter(|t| t.at.elapsed() < max_age)
            .map(|t| t.scan.clone())
    }

    pub async fn set(&self, snapshot: HashMap<String, Value>) {
        *self.inner.write().await = Some(TimedScan {
            at: Instant::now(),
            scan: snapshot,
        });
    }

    pub async fn invalidate(&self) {
        *self.inner.write().await = None;
    }
}

/// Per-provider health snapshot recorded by the boot warm-up and the
/// user-driven Test button. Reads land in `/api/providers/health` so
/// the renderer can paint status pills without firing its own probe
/// fan-out on every Settings mount.
#[derive(Clone, serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum HealthSnapshot {
    /// Key absent — `connected = false` in `ProvidersConfig`, so we
    /// don't even try to dial the upstream.
    NoKey,
    /// Live round-trip succeeded. `latency_ms` is the end-to-end
    /// reqwest timing; `model_count` is the number of entries the
    /// provider's `/models` endpoint returned (None for providers
    /// without a list endpoint, e.g. fixed-lineup APIs).
    Ok {
        latency_ms: u64,
        model_count: Option<usize>,
    },
    /// Live round-trip failed. `code` mirrors the existing renderer
    /// strings ("AUTH", "NETWORK", "TIMEOUT", "NOT_FOUND") so the
    /// chip pill renders identically. `message` is the short upstream
    /// error body when one is available.
    Failed {
        code: String,
        message: Option<String>,
    },
}

/// Twin of `AgentScanCache` but for HTTP providers — populated by the
/// boot-time warm-up hook in the Tauri shell. Lives on `AppState` so
/// both the public `/api/providers/health` endpoint and the
/// `providers_*` IPC layer can read+invalidate it.
#[derive(Clone, Default)]
pub struct HttpHealthCache {
    inner: Arc<RwLock<Option<HashMap<String, HealthSnapshot>>>>,
}

impl HttpHealthCache {
    pub async fn get(&self) -> Option<HashMap<String, HealthSnapshot>> {
        self.inner.read().await.clone()
    }

    pub async fn set(&self, snapshot: HashMap<String, HealthSnapshot>) {
        *self.inner.write().await = Some(snapshot);
    }

    pub async fn invalidate(&self) {
        *self.inner.write().await = None;
    }

    /// Replace the entry for a single provider id without clobbering
    /// the rest of the cache. Used after `providers_test_connection`
    /// so a manual Test refreshes only that tile.
    pub async fn upsert(&self, provider_id: String, snapshot: HealthSnapshot) {
        let mut guard = self.inner.write().await;
        let map = guard.get_or_insert_with(HashMap::new);
        map.insert(provider_id, snapshot);
    }
}

#[derive(Deserialize)]
struct ScanQuery {
    #[serde(default)]
    refresh: Option<u8>,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/models", get(list_models))
        .route("/providers/scan", get(scan_providers))
        .route("/providers/catalog", get(providers_catalog))
        .route("/providers/health", get(http_health))
        .route("/agents/scan", get(scan_agents_cached))
        .route("/agents/{id}/models", get(list_agent_models))
        .route("/providers/{id}/models", get(list_provider_models))
        .route(
            "/providers/ollama/suggestions",
            get(list_ollama_suggestions),
        )
        .route("/providers/cloudflare/verify", post(cloudflare_verify))
        .route("/providers/catalog/revalidate", post(revalidate_catalog))
}

/// POST /providers/catalog/revalidate — the renderer's staleness check, fired
/// on natural triggers (window focus, model-picker open). Cheap: one small
/// conditional-ish GET of the catalog pointer, debounced server-side. POST
/// because it mutates cache state.
///
/// `changed: true` means the lineup the renderer holds is stale and it should
/// re-discover; `probed: false` means the debounce collapsed this call.
async fn revalidate_catalog() -> Json<Value> {
    let r = revalidate_remote_catalog(false).await;
    Json(json!({
        "ok": true,
        "changed": r.changed,
        "probed": r.probed,
        "commit": r.version.commit,
        "tag": r.version.tag,
    }))
}

use crate::providers::capabilities;

/// CATALOG serialized to JSON with each provider's capability descriptors
/// (permission / tool_matrix / timing) merged in. Per-model effort is
/// delivered with the model lists (catalog model entries + the dynamic
/// `available_models_update` event), not here.
pub fn catalog_with_capabilities() -> Vec<serde_json::Value> {
    crate::providers::CATALOG
        .iter()
        .map(|p| {
            let mut v = serde_json::to_value(p).unwrap_or(serde_json::Value::Null);
            if let Some(obj) = v.as_object_mut() {
                obj.insert(
                    "permission".into(),
                    serde_json::to_value(capabilities::permission_capability(p.id)).unwrap(),
                );
                obj.insert(
                    "tool_matrix".into(),
                    serde_json::to_value(capabilities::tool_matrix(p.id)).unwrap(),
                );
                obj.insert(
                    "timing".into(),
                    serde_json::to_value(capabilities::config_timing(p.id)).unwrap(),
                );
            }
            v
        })
        .collect()
}

/// Static catalog that drives Settings → Models tiles, Settings → Agents
/// tiles, and the chat composer's grouped model picker. Returns the
/// provider registry enriched with capability descriptors — no I/O, no
/// auth check, safe to poll without rate-limiting concerns.
async fn providers_catalog() -> Json<Vec<serde_json::Value>> {
    Json(catalog_with_capabilities())
}

/// Read the prewarmed HTTP-provider health cache. Always returns a
/// 200 + a snapshot map; missing entries mean "warm hasn't completed
/// yet". The renderer treats absent ids as a brief Testing… state.
async fn http_health(State(st): State<AppState>) -> Json<Value> {
    let snapshot = st.http_health_cache.get().await.unwrap_or_default();
    Json(json!({ "ok": true, "providers": snapshot }))
}

/// Resolve the per-OS install hint for a provider. Returns the override
/// matching `cfg!()` when `install_hints` is set, otherwise falls back
/// to the static `install_hint`.
pub fn resolve_install_hint(spec: &crate::providers::ProviderSpec) -> &'static str {
    spec.install_hints
        .as_ref()
        .map(|h| {
            if cfg!(windows) {
                h.windows
            } else if cfg!(target_os = "macos") {
                h.macos
            } else {
                h.linux
            }
        })
        .unwrap_or(spec.install_hint)
}

// ── Dynamic per-agent model discovery ──────────────────────────────────
// OpenCode and Cursor source their model catalog at runtime, not from the
// static `ProviderSpec::default_models`. This endpoint surfaces that catalog
// to the composer's model picker BEFORE a chat session has cold-started, so
// the picker isn't limited to the curated CLI_MODELS fallback. Strategy is
// per-agent (mirrors `scan_probe_for`): OpenCode via the cheap `opencode
// models` CLI (no auth; ids already match the ACP session); Cursor via a
// short ACP `session/new` probe (the only source whose ids match what the
// bridge applies via `set_config_option`). Results are TTL-cached so opening
// the picker repeatedly doesn't re-spawn the agent.

#[derive(Deserialize)]
struct ModelsQuery {
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    refresh: Option<u8>,
}

type ModelList = Vec<(String, String)>; // (id, label)
/// Cache value: (fetched_at, models, current). `current` is the agent's
/// configured/active model id (Hermes only today) — surfaced so the renderer
/// can resolve & self-heal the `"default"` placeholder; `None` for agents that
/// don't report one.
type CachedModels = (Instant, ModelList, Option<String>);
const AGENT_MODELS_TTL: Duration = Duration::from_secs(120);
static AGENT_MODELS_CACHE: OnceLock<RwLock<HashMap<String, CachedModels>>> = OnceLock::new();

fn agent_models_cache() -> &'static RwLock<HashMap<String, CachedModels>> {
    AGENT_MODELS_CACHE.get_or_init(|| RwLock::new(HashMap::new()))
}

/// `GET /agents/{id}/models` — discovered model catalog for a live-model CLI
/// agent (`opencode`, `cursor`, `github-copilot`, `hermes`). Always 200 with
/// `{ id, models: [{id,label}] }`; an empty list means discovery failed (agent
/// not installed, not logged in, or unsupported id) and the renderer keeps its
/// static fallback. `?refresh=1` bypasses the TTL cache.
async fn list_agent_models(Path(id): Path<String>, Query(q): Query<ModelsQuery>) -> Json<Value> {
    let cwd = q.cwd.unwrap_or_default();
    let refresh = q.refresh.unwrap_or(0) == 1;

    if !refresh {
        if let Some((at, models, current)) = agent_models_cache().read().await.get(&id).cloned() {
            if at.elapsed() < AGENT_MODELS_TTL {
                return Json(models_json(&id, &models, &current));
            }
        }
    }

    let (models, current) = discover_agent_models(&id, &cwd).await;
    // Only cache non-empty results: a transient failure (logged out, agent
    // mid-update) shouldn't pin an empty list for the whole TTL window.
    if !models.is_empty() {
        agent_models_cache().write().await.insert(
            id.clone(),
            (Instant::now(), models.clone(), current.clone()),
        );
        return Json(models_json(&id, &models, &current));
    }
    // No live ACP/CLI discovery — either the agent is offline, or it's a
    // baked-lineup agent with no probe (claude/codex/kimi/agy). Fall
    // back to the remote catalog so the picker sources the real lineup instead
    // of the renderer's last-ditch CLI_MODELS. Rich shape (ctx + effort).
    let remote = fetch_remote_catalog(&id).await;
    Json(provider_models_json(&id, &remote))
}

fn models_json(id: &str, models: &ModelList, current: &Option<String>) -> Value {
    json!({
        "id": id,
        "current": current,
        "models": models
            .iter()
            .map(|(i, l)| json!({ "id": i, "label": l }))
            .collect::<Vec<_>>(),
    })
}

/// Returns `(models, current)`. `current` is the agent's configured/active model
/// id and is only populated for Hermes (from its inventory) — see
/// [`crate::bridges::hermes::list_provider_models`].
async fn discover_agent_models(id: &str, cwd: &str) -> (ModelList, Option<String>) {
    match id {
        "opencode" => (discover_opencode_models().await, None),
        "cursor-cli" => (
            crate::bridges::cursor::list_models(cwd)
                .await
                .map(|ms| ms.into_iter().map(|m| (m.id, m.name)).collect())
                .unwrap_or_default(),
            None,
        ),
        "grok-build" => (
            crate::bridges::grok_cli::list_models(cwd)
                .await
                .map(|ms| ms.into_iter().map(|m| (m.id, m.name)).collect())
                .unwrap_or_default(),
            None,
        ),
        "github-copilot" => (
            crate::bridges::github_copilot::list_models(cwd)
                .await
                .unwrap_or_default(),
            None,
        ),
        "hermes-agent" => {
            // Prefer the full multi-provider catalog (every authenticated
            // provider) so the picker can offer a provider selector; fall back
            // to a live `session/new` probe (current provider only) when the
            // inventory read is unavailable (older Hermes, venv python missing).
            // The inventory also reports the configured model as `current`, used
            // to heal sessions persisted with the `"default"` placeholder.
            tracing::debug!(target: "hermes.discover", "discover hermes: provider inventory…");
            let (mut ms, current) = crate::bridges::hermes::list_provider_models(cwd)
                .await
                .unwrap_or_default();
            tracing::debug!(target: "hermes.discover", "discover hermes: inventory → {} models, current={current:?}", ms.len());
            if ms.is_empty() {
                tracing::debug!(target: "hermes.discover", "discover hermes: fallback session probe…");
                ms = crate::bridges::hermes::list_models(cwd)
                    .await
                    .unwrap_or_default();
                tracing::debug!(target: "hermes.discover", "discover hermes: session probe → {} models", ms.len());
            }
            (ms.into_iter().map(|m| (m.id, m.name)).collect(), current)
        }
        _ => (Vec::new(), None),
    }
}

/// Pre-warm the Hermes model cache at startup so the picker shows its real
/// per-provider catalog on first open instead of flashing the static
/// "Hermes (configured model)" placeholder while discovery runs (~1-2s cold).
/// Best-effort: an empty result just leaves the cache unset and the lazy
/// on-open fetch retries. Self-gates — returns fast when Hermes isn't installed
/// (no venv python / binary), so it's safe to always call at boot.
pub async fn prewarm_hermes_models() {
    let (models, current) = discover_agent_models("hermes-agent", "").await;
    if !models.is_empty() {
        let n = models.len();
        agent_models_cache().write().await.insert(
            "hermes-agent".to_string(),
            (Instant::now(), models, current),
        );
        tracing::debug!(target: "hermes.discover", "prewarmed {n} hermes models at startup");
    }
}

/// CLI agents whose model lineup comes from a live local probe (the match arms
/// in [`discover_agent_models`]) rather than the remote catalog. Excluded from
/// the remote-catalog prewarm — there is nothing on fleetify.dev/api to warm for
/// them (`hermes` is prewarmed separately via [`prewarm_hermes_models`]).
const LIVE_PROBE_AGENTS: &[&str] = &[
    "opencode",
    "cursor-cli",
    "grok-build",
    "github-copilot",
    "hermes-agent",
];

/// Provider/agent ids whose model lineup is sourced from the remote catalog
/// (fleetify.dev/api → jsDelivr): every [`crate::providers::catalog::CATALOG`]
/// entry except the live-probe CLI agents. Pure (no I/O) so it's unit-testable.
fn remote_catalog_prewarm_ids() -> Vec<&'static str> {
    crate::providers::catalog::CATALOG
        .iter()
        .map(|p| p.id)
        .filter(|id| !LIVE_PROBE_AGENTS.contains(id))
        .collect()
}

/// Pre-warm the remote model catalog (fleetify.dev/api) for every remote-sourced
/// provider/agent at startup, concurrently, so the model picker shows the live,
/// up-to-date lineup on first open instead of the embedded snapshot baseline
/// until the lazy on-open fetch returns. Best-effort: each fetch self-degrades
/// to an empty (briefly negative-cached) result on network failure, so this
/// never blocks boot and silently falls back to the snapshot when offline. Each
/// `fetch_remote_catalog` populates `REMOTE_CATALOG_CACHE`, which both the
/// `/providers/{id}/models` and (baked-agent) `/agents/{id}/models` endpoints
/// read through.
pub async fn prewarm_remote_catalog() {
    // Record the pointer BEFORE warming, so the first user-triggered probe
    // compares against the identity these payloads actually came from. Without
    // it the first probe reads as "unknown provenance" and re-pulls every
    // provider for nothing on each app start.
    let _ = revalidate_remote_catalog(true).await;
    let ids = remote_catalog_prewarm_ids();
    let total = ids.len();
    let warmed = futures_util::future::join_all(ids.into_iter().map(fetch_remote_catalog))
        .await
        .iter()
        .filter(|models| !models.is_empty())
        .count();
    tracing::debug!(
        target: "catalog.prewarm",
        "prewarmed remote catalog: {warmed}/{total} providers populated at startup"
    );
}

/// `opencode models` prints one model id per line (e.g. `opencode/big-pickle`,
/// `antigravity-manager/claude-sonnet-4-6`). The ids match what the ACP
/// session reports, so they're usable verbatim; the label is derived from the
/// segment after the last `/`.
async fn discover_opencode_models() -> ModelList {
    let bin =
        cli_auth::resolve_bin("opencode", "opencode").unwrap_or_else(|| "opencode".to_string());
    // npm ships a `.cmd`/`.ps1` shim on Windows; `cmd /C` runs it (CreateProcess
    // can't exec a `.cmd` directly).
    let lower = bin.to_ascii_lowercase();
    let mut cmd = if cfg!(windows) && (lower.ends_with(".cmd") || lower.ends_with(".bat")) {
        let mut c = tokio_command("cmd");
        c.arg("/C").arg(&bin).arg("models");
        c
    } else {
        let mut c = tokio_command(&bin);
        c.arg("models");
        c
    };
    let out = match tokio::time::timeout(Duration::from_secs(15), cmd.output()).await {
        Ok(Ok(o)) if o.status.success() => o,
        _ => return Vec::new(),
    };
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && l.contains('/'))
        .map(|id| (id.to_string(), prettify_model_label(id)))
        .collect()
}

/// Turn a slash/dash model id into a title-cased label for the picker
/// (`opencode/deepseek-v4-flash-free` → `Deepseek V4 Flash Free`).
fn prettify_model_label(id: &str) -> String {
    let tail = id.rsplit('/').next().unwrap_or(id);
    tail.split('-')
        .map(|w| {
            let mut chars = w.chars();
            match chars.next() {
                Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

// ── Dynamic HTTP-provider model discovery ──────────────────────────────
// OpenRouter exposes hundreds of models behind one OpenAI-compatible
// endpoint — far too many to curate statically. This endpoint fetches the
// live list from the provider's public `/models` route so the composer's
// picker (with its search box) can browse the full catalog. TTL is longer
// than the per-agent cache: the OpenRouter catalog changes slowly and the
// payload is large.

#[derive(Clone, Serialize, Deserialize)]
struct CatalogModalities {
    #[serde(default)]
    input: Vec<String>,
    #[serde(default)]
    output: Vec<String>,
}

#[derive(Clone, Serialize, Deserialize)]
struct ProviderModel {
    id: String,
    label: String,
    ctx: Option<String>,
    /// Reasoning-effort lever flag. `None` for live-discovery sources that
    /// don't report it (OpenRouter / Cloudflare) — the renderer then defaults
    /// it false; `Some(_)` when the remote catalog supplies it.
    supports_effort: Option<bool>,
    /// Picker sub-group (Perplexity "Sonar API" / "Agent API"). Catalog-only.
    group: Option<String>,
    /// Small badge next to the model ("Reasoning", "Research", …). Catalog-only.
    note: Option<String>,
    /// Per-model endpoint override (Perplexity Agent → `/v1/agent`). Catalog-only.
    endpoint: Option<String>,
    /// Rich effort descriptor (EffortCapability JSON) from the remote catalog.
    /// Opaque here — passed through verbatim to the renderer. `None` for
    /// live-discovery sources (OpenRouter/Cloudflare) that don't report it.
    effort: Option<serde_json::Value>,
    /// Provider's default model flag (from the remote catalog). `false` unless
    /// the catalog marks this model as the provider's default.
    #[serde(default)]
    default: bool,
    /// Catalog availability switch. `Some(false)` ⇒ the model is retired:
    /// hidden from the picker and rejected at send. `None`/`Some(true)` ⇒
    /// selectable. `#[serde(default)]` so disk-cache files written before this
    /// field existed still deserialize.
    #[serde(default)]
    active: Option<bool>,
    /// Picker sort weight from the catalog — higher floats the model toward the
    /// top of its provider's list (the renderer sorts by it, ties keep order).
    /// `None` ⇒ unweighted (treated as 0). `#[serde(default)]` so older
    /// disk-cache files still deserialize.
    #[serde(default)]
    priority: Option<i64>,
    // Optional so catalogs and disk caches from older versions remain readable.
    #[serde(default)]
    tags: Option<Vec<String>>,
    #[serde(default)]
    tool_call: Option<bool>,
    #[serde(default)]
    reasoning: Option<bool>,
    #[serde(default)]
    modalities: Option<CatalogModalities>,
}
type ProviderModelList = Vec<ProviderModel>;

impl ProviderModel {
    /// Live-discovery constructor: id + label (+ optional ctx), no catalog
    /// metadata. Used by the OpenRouter / Cloudflare parsers whose upstream
    /// payloads carry neither effort flags nor picker groups.
    fn basic(id: String, label: String, ctx: Option<String>) -> Self {
        Self {
            id,
            label,
            ctx,
            supports_effort: None,
            group: None,
            note: None,
            endpoint: None,
            effort: None,
            default: false,
            active: None,
            priority: None,
            tags: None,
            tool_call: None,
            reasoning: None,
            modalities: None,
        }
    }
}

const PROVIDER_MODELS_TTL: Duration = Duration::from_secs(600);
static PROVIDER_MODELS_CACHE: OnceLock<RwLock<HashMap<String, (Instant, ProviderModelList)>>> =
    OnceLock::new();

fn provider_models_cache() -> &'static RwLock<HashMap<String, (Instant, ProviderModelList)>> {
    PROVIDER_MODELS_CACHE.get_or_init(|| RwLock::new(HashMap::new()))
}

/// `GET /providers/{id}/models` — live model catalog for HTTP providers that
/// expose a discovery endpoint (currently `openrouter`). Always 200 with
/// `{ id, models: [{id,label,ctx?}] }`; an empty list means discovery failed
/// or the provider has no live catalog, and the renderer keeps its static
/// fallback. `?refresh=1` bypasses the TTL cache.
async fn list_provider_models(Path(id): Path<String>, Query(q): Query<ModelsQuery>) -> Json<Value> {
    // Local installed models are discovered by the Ollama probe. The remote
    // catalog lists pull targets, which must never enter session model discovery.
    if id == "ollama" {
        return Json(provider_models_json(&id, &[]));
    }
    let refresh = q.refresh.unwrap_or(0) == 1;
    if !refresh {
        if let Some((at, models)) = provider_models_cache().read().await.get(&id).cloned() {
            if at.elapsed() < PROVIDER_MODELS_TTL {
                return Json(provider_models_json(&id, &models));
            }
        }
    }
    let models = discover_provider_models(&id).await;
    if !models.is_empty() {
        provider_models_cache()
            .write()
            .await
            .insert(id.clone(), (Instant::now(), models.clone()));
    }
    Json(provider_models_json(&id, &models))
}

async fn list_ollama_suggestions() -> Json<Value> {
    let models: ProviderModelList = fetch_remote_catalog("ollama")
        .await
        .into_iter()
        .filter(|model| model.active != Some(false))
        .collect();
    Json(provider_models_json("ollama", &models))
}

fn provider_models_json(id: &str, models: &[ProviderModel]) -> Value {
    json!({
        "id": id,
        "models": models.iter().map(provider_model_json).collect::<Vec<_>>(),
    })
}

/// One model entry. Required `id`/`label`; every other field is omitted when
/// absent so live-discovery sources (which only know id/label/ctx) and the
/// richer remote catalog share one wire shape and the renderer reads whatever
/// is present (unknown-field tolerant on both sides).
fn provider_model_json(m: &ProviderModel) -> Value {
    let mut o = serde_json::Map::new();
    o.insert("id".into(), json!(m.id));
    o.insert("label".into(), json!(m.label));
    if let Some(ctx) = &m.ctx {
        o.insert("ctx".into(), json!(ctx));
    }
    if let Some(se) = m.supports_effort {
        o.insert("supports_effort".into(), json!(se));
    }
    if let Some(g) = &m.group {
        o.insert("group".into(), json!(g));
    }
    if let Some(n) = &m.note {
        o.insert("note".into(), json!(n));
    }
    if let Some(e) = &m.endpoint {
        o.insert("endpoint".into(), json!(e));
    }
    if let Some(e) = &m.effort {
        o.insert("effort".into(), e.clone());
    }
    o.insert("default".into(), json!(m.default));
    if let Some(a) = m.active {
        o.insert("active".into(), json!(a));
    }
    if let Some(p) = m.priority {
        o.insert("priority".into(), json!(p));
    }
    if let Some(tags) = &m.tags {
        o.insert("tags".into(), json!(tags));
    }
    if let Some(tool_call) = m.tool_call {
        o.insert("tool_call".into(), json!(tool_call));
    }
    if let Some(reasoning) = m.reasoning {
        o.insert("reasoning".into(), json!(reasoning));
    }
    if let Some(modalities) = &m.modalities {
        o.insert("modalities".into(), json!(modalities));
    }
    Value::Object(o)
}

async fn discover_provider_models(id: &str) -> ProviderModelList {
    // 1. Provider with a live `/models` endpoint we proxy directly.
    let live = match id {
        "openrouter" => discover_openrouter_models().await,
        "cloudflare-workers-ai" => discover_cloudflare_models().await,
        "grok" => discover_grok_models().await,
        "ollama-cloud" => discover_ollama_cloud_models().await,
        _ => Vec::new(),
    };
    if !live.is_empty() {
        return live;
    }
    // 2. Key-less remote catalog (fleetify.dev/api → jsDelivr origin). Covers
    //    every fixed-lineup HTTP provider (openai/anthropic/…) plus a degraded
    //    openrouter/cloudflare when their live call failed. Empty on miss → the
    //    renderer keeps the baked `default_models` fallback (chain layer 5).
    fetch_remote_catalog(id).await
}

// ── Remote model catalog (fleetify.dev/api → jsDelivr) ──────────────────────
// The key-less baseline layer of the model-resolution chain (see
// docs/MODEL_DISCOVERY.md). Both the per-provider HTTP endpoint and the
// per-agent endpoint fall through to this when their live source is empty, so
// binary-embedded providers/agents (openai/anthropic/claude/codex/…) source
// their lineup from the published catalog instead of the baked `CATALOG`.

const REMOTE_CATALOG_TTL: Duration = Duration::from_secs(600);
/// Negative-cache window: a miss (API + CDN both unreachable / empty) is cached
/// briefly so a picker open doesn't re-fan the slow fetch every time, while
/// still recovering quickly once the catalog comes online.
const REMOTE_CATALOG_MISS_TTL: Duration = Duration::from_secs(60);
static REMOTE_CATALOG_CACHE: OnceLock<RwLock<HashMap<String, (Instant, ProviderModelList)>>> =
    OnceLock::new();

fn remote_catalog_cache() -> &'static RwLock<HashMap<String, (Instant, ProviderModelList)>> {
    REMOTE_CATALOG_CACHE.get_or_init(|| RwLock::new(HashMap::new()))
}

/// On-disk persistence of the last successful remote-catalog fetch, under
/// FLEETIFY_HOME so it survives restarts and is shared across windows. This is
/// the offline / cold-start fallback that lets us drop the build-time embedded
/// model lists (see docs/superpowers/specs/2026-06-15-runtime-model-catalog.md).
fn disk_cache_path(id: &str) -> PathBuf {
    fleetify_core::fleetify_home()
        .join("models-cache")
        .join(format!("{id}.json"))
}

/// Last-persisted catalog for `id`, or `None` if absent / empty / corrupt.
fn read_disk_cache(id: &str) -> Option<ProviderModelList> {
    let body = std::fs::read_to_string(disk_cache_path(id)).ok()?;
    let models: ProviderModelList = serde_json::from_str(&body).ok()?;
    if models.is_empty() {
        None
    } else {
        Some(models)
    }
}

/// Persist a non-empty fetched catalog (atomic tmp+rename). Best-effort and
/// never persists an empty list, so a transient offline fetch can't clobber the
/// last-good lineup.
fn write_disk_cache(id: &str, models: &ProviderModelList) {
    if models.is_empty() {
        return;
    }
    let path = disk_cache_path(id);
    let Some(dir) = path.parent() else {
        return;
    };
    if std::fs::create_dir_all(dir).is_err() {
        return;
    }
    let Ok(json) = serde_json::to_string(models) else {
        return;
    };
    let tmp = path.with_extension("json.tmp");
    if std::fs::write(&tmp, json).is_ok() {
        let _ = std::fs::rename(&tmp, &path);
    }
}

/// Persist a fresh non-empty fetch, or restore the last-persisted catalog when
/// the fetch came back empty (offline / both remote sources unreachable).
fn persist_or_restore(id: &str, fetched: ProviderModelList) -> ProviderModelList {
    if !fetched.is_empty() {
        write_disk_cache(id, &fetched);
        fetched
    } else {
        read_disk_cache(id).unwrap_or(fetched)
    }
}

/// Base URL of the Fleetify model-catalog serving API. Overridable so dev/CI
/// can point at a local mock or staging; defaults to prod.
fn models_api_base() -> String {
    std::env::var("FLEETIFY_MODELS_API")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "https://fleetify.dev/api".to_string())
}

/// jsDelivr ref (tag/branch) for the direct-CDN fallback. Pin a release tag in
/// prod; defaults to `main`.
fn models_cdn_tag() -> String {
    std::env::var("FLEETIFY_MODELS_TAG")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "main".to_string())
}

// ── Catalog version pointer (cheap staleness probe) ─────────────────────────
// The remote catalog follows the standard remote-config split: an IMMUTABLE,
// long-cached PAYLOAD (jsDelivr `@<tag>/dist/...`) plus a tiny POINTER saying
// which payload is current. `/api/meta` is that pointer — a few hundred bytes
// reporting `{ tag, catalogCommit }`.
//
// Probing the pointer is cheap enough to run on natural user triggers (window
// focus, model-picker open) rather than waiting out REMOTE_CATALOG_TTL, which
// is what actually decides how long a just-published model stays invisible. A
// moved commit invalidates L1 wholesale and the next per-provider read
// re-pulls; the payload fetch path itself is untouched.

/// Renderer triggers (focus + picker open) burst — collapse them.
const CATALOG_PROBE_MIN_INTERVAL: Duration = Duration::from_secs(15);
/// The pointer sits on the user's critical path; fail fast and keep serving.
const CATALOG_PROBE_TIMEOUT: Duration = Duration::from_secs(2);

/// The catalog identity the L1 cache was populated from — specifically the one
/// THIS device is assigned, which under a staged rollout may not be the one the
/// serving API itself has cached.
#[derive(Clone, Default, Serialize)]
pub struct CatalogVersion {
    /// `catalogCommit` of the assigned catalog. Absent for a freshly staged
    /// candidate whose commit the cloud hasn't resolved yet — the tag is then
    /// the identity (it's immutable, so that's just as stable).
    pub commit: Option<String>,
    /// The ref this device should use (immutable CalVer tag, or `main`).
    pub tag: Option<String>,
    /// The ref the serving API has cached. Equal to `tag` outside a rollout;
    /// when they differ, the API can't hand us our payload and we go to the
    /// immutable CDN URL for `tag` instead.
    pub api_tag: Option<String>,
}

impl CatalogVersion {
    /// Stable identity for change detection: the commit when the cloud knows
    /// it, else the (immutable) tag.
    fn identity(&self) -> Option<&str> {
        self.commit.as_deref().or(self.tag.as_deref())
    }

    /// True when the serving API is on a different catalog than we're assigned
    /// — i.e. this device is inside a staged rollout.
    fn is_staged(&self) -> bool {
        match (&self.tag, &self.api_tag) {
            (Some(t), Some(a)) => t != a,
            _ => false,
        }
    }
}

/// Stable rollout bucket in [0, 100) derived from the device id.
///
/// Explicit FNV-1a rather than `DefaultHasher`: the bucket must not move when
/// the toolchain or the app version changes, or a device would hop between
/// rollout slices on upgrade — precisely when someone is watching a staged
/// release and needs the slices to hold still.
pub fn device_rollout_bucket() -> u32 {
    rollout_bucket(&crate::services::telemetry::get_or_create().device_id)
}

fn rollout_bucket(device_id: &str) -> u32 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for b in device_id.as_bytes() {
        hash ^= u64::from(*b);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    (hash % 100) as u32
}

static CATALOG_VERSION: OnceLock<RwLock<CatalogVersion>> = OnceLock::new();
static CATALOG_PROBED_AT: OnceLock<RwLock<Option<Instant>>> = OnceLock::new();

fn catalog_version_cell() -> &'static RwLock<CatalogVersion> {
    CATALOG_VERSION.get_or_init(|| RwLock::new(CatalogVersion::default()))
}

fn catalog_probed_at() -> &'static RwLock<Option<Instant>> {
    CATALOG_PROBED_AT.get_or_init(|| RwLock::new(None))
}

/// The catalog identity currently serving this device. Read by the telemetry
/// heartbeat: a staged rollout can't be operated without knowing which slice of
/// the fleet is on which catalog.
pub async fn active_catalog_version() -> CatalogVersion {
    catalog_version_cell().read().await.clone()
}

/// Outcome of a pointer probe.
pub struct CatalogRevalidation {
    /// The served identity moved — L1 was cleared, the next read re-pulls.
    pub changed: bool,
    /// False when the debounce collapsed this call (nothing was asked).
    pub probed: bool,
    pub version: CatalogVersion,
}

/// Pure parser for the `/api/meta` pointer payload. A response with no
/// `catalogCommit` carries no identity, so it's a miss rather than something we
/// record over a known-good commit.
fn parse_catalog_pointer(body: &Value) -> Option<CatalogVersion> {
    let s = |k: &str| {
        body.get(k)
            .and_then(|v| v.as_str())
            .filter(|v| !v.is_empty())
            .map(str::to_string)
    };
    let api_tag = s("tag");
    let api_commit = s("catalogCommit");
    match s("assignedTag") {
        // The cloud assigned this device a catalog (staged rollout, or simply
        // the stable one). Identity comes from the ASSIGNED pair: falling back
        // to the API's own commit here would report the stable catalog while
        // we're actually serving the candidate — and a rollout you can't
        // observe accurately is worse than no rollout.
        Some(assigned) => {
            let commit = s("assignedCommit").or_else(|| {
                // Same catalog ⇒ the API's commit IS this one's.
                if api_tag.as_deref() == Some(assigned.as_str()) {
                    api_commit.clone()
                } else {
                    None
                }
            });
            Some(CatalogVersion {
                commit,
                tag: Some(assigned),
                api_tag,
            })
        }
        // Older cloud with no assignment concept — the pre-rollout contract,
        // where a response without a commit carries no identity at all.
        None => {
            api_commit.as_ref()?;
            Some(CatalogVersion {
                commit: api_commit,
                tag: api_tag.clone(),
                api_tag,
            })
        }
    }
}

/// GET the pointer. `None` on any network/parse failure — an unreachable
/// pointer must NEVER invalidate a good lineup, or going offline would wipe the
/// picker down to the disk fallback for no reason.
async fn probe_catalog_pointer() -> Option<CatalogVersion> {
    let client = reqwest::Client::builder()
        .timeout(CATALOG_PROBE_TIMEOUT)
        .build()
        .ok()?;
    // Send our rollout bucket so the cloud can assign a staged catalog to a
    // slice of the fleet. Coarse by design — 100 buckets across every install
    // is not an identifier, and it keeps the pointer response shareable per
    // bucket instead of per device.
    let url = format!(
        "{}/meta?b={}",
        models_api_base().trim_end_matches('/'),
        device_rollout_bucket(),
    );
    let body: Value = match client.get(&url).send().await {
        Ok(r) if r.status().is_success() => r.json().await.ok()?,
        _ => return None,
    };
    parse_catalog_pointer(&body)
}

/// Probe the pointer; invalidate L1 when the catalog identity moved. `force`
/// skips the debounce — used by the boot prewarm and the push path, both rare.
pub async fn revalidate_remote_catalog(force: bool) -> CatalogRevalidation {
    if !force {
        if let Some(at) = *catalog_probed_at().read().await {
            if at.elapsed() < CATALOG_PROBE_MIN_INTERVAL {
                return CatalogRevalidation {
                    changed: false,
                    probed: false,
                    version: active_catalog_version().await,
                };
            }
        }
    }
    *catalog_probed_at().write().await = Some(Instant::now());

    let Some(fetched) = probe_catalog_pointer().await else {
        // Offline / pointer down: keep serving what we have.
        return CatalogRevalidation {
            changed: false,
            probed: true,
            version: active_catalog_version().await,
        };
    };

    let previous = active_catalog_version().await;
    // An unrecorded previous identity means we don't know what L1 was populated
    // from (e.g. the boot probe failed and L1 came off the disk cache), so it
    // counts as moved: one extra re-pull beats serving a stale lineup. Entering
    // or leaving a rollout slice moves the identity too, so a staged device
    // re-pulls exactly like a promoted one.
    let changed = previous.identity() != fetched.identity();
    *catalog_version_cell().write().await = fetched.clone();
    if changed {
        remote_catalog_cache().write().await.clear();
        tracing::info!(
            target: "catalog.version",
            "catalog moved {:?} -> {:?} (tag {:?}) — L1 invalidated",
            previous.commit, fetched.commit, fetched.tag
        );
    }
    CatalogRevalidation {
        changed,
        probed: true,
        version: fetched,
    }
}

/// Fetch a provider/agent's curated models from the remote catalog, TTL-cached.
/// Tries the serving API first, then the jsDelivr origin directly; any failure
/// degrades to an empty list (cached briefly) so callers fall to the baked
/// catalog. Never blocks long — short per-request timeout.
async fn fetch_remote_catalog(id: &str) -> ProviderModelList {
    if let Some((at, models)) = remote_catalog_cache().read().await.get(id).cloned() {
        let ttl = if models.is_empty() {
            REMOTE_CATALOG_MISS_TTL
        } else {
            REMOTE_CATALOG_TTL
        };
        if at.elapsed() < ttl {
            return models;
        }
    }
    // Fetch fresh; persist a good result to disk, or restore the last-persisted
    // lineup when the fetch came back empty (offline / both sources unreachable).
    let models = persist_or_restore(id, fetch_remote_catalog_uncached(id).await);
    // Cache even an empty result (negative cache) to bound the fetch fan-out.
    remote_catalog_cache()
        .write()
        .await
        .insert(id.to_string(), (Instant::now(), models.clone()));
    models
}

async fn fetch_remote_catalog_uncached(id: &str) -> ProviderModelList {
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(3))
        .build()
    {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };
    let version = active_catalog_version().await;
    // 1. Serving API: `…/providers/{id}/models` — SKIPPED while we're inside a
    //    staged rollout. The API serves one catalog; if we've been assigned a
    //    different one it simply can't hand us that payload, and asking anyway
    //    would silently drop us back onto the stable lineup. This is the whole
    //    reason the rollout lives in the pointer: the payload is an immutable,
    //    CDN-addressable artifact, so a slice can be served without the API
    //    having to hold two catalogs at once.
    if !version.is_staged() {
        let api_url = format!(
            "{}/providers/{}/models",
            models_api_base().trim_end_matches('/'),
            id
        );
        if let Some(models) = try_fetch_catalog(&client, &api_url).await {
            return models;
        }
    }
    // 2. jsDelivr origin: the catalog's built per-provider file, at the tag we
    //    were assigned (falling back to the configured ref when the pointer
    //    hasn't answered yet). Also the path that let the app consume the
    //    catalog before the serving API existed.
    let cdn_url = format!(
        "https://cdn.jsdelivr.net/gh/fleetifydev/models@{}/dist/providers/{}.json",
        version.tag.as_deref().unwrap_or(&models_cdn_tag()),
        id
    );
    try_fetch_catalog(&client, &cdn_url)
        .await
        .unwrap_or_default()
}

/// GET one catalog URL and parse it. `None` on any network/parse failure OR an
/// empty model list, so the caller can try the next source in the chain.
async fn try_fetch_catalog(client: &reqwest::Client, url: &str) -> Option<ProviderModelList> {
    let body: Value = match client.get(url).send().await {
        Ok(r) if r.status().is_success() => r.json().await.ok()?,
        _ => return None,
    };
    let models = parse_remote_catalog(&body);
    if models.is_empty() {
        None
    } else {
        Some(models)
    }
}

/// Pure parser for the catalog payload — testable without HTTP. Accepts both
/// the serving-API shape (`{ models: [...] }`) and the jsDelivr per-provider
/// file (`{ provider: { models: [...] } }`). Maps each entry's numeric
/// `context` to a humanized ctx string and carries the picker metadata.
fn parse_remote_catalog(body: &Value) -> ProviderModelList {
    let Some(arr) = body
        .get("models")
        .or_else(|| body.get("provider").and_then(|p| p.get("models")))
        .and_then(|m| m.as_array())
    else {
        return Vec::new();
    };
    arr.iter()
        .filter_map(|m| {
            let id = m.get("id").and_then(|x| x.as_str())?.to_string();
            let label = m
                .get("label")
                .and_then(|x| x.as_str())
                .map(str::to_string)
                .unwrap_or_else(|| id.clone());
            let str_field = |k: &str| {
                m.get(k)
                    .and_then(|x| x.as_str())
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
            };
            Some(ProviderModel {
                id,
                label,
                ctx: m
                    .get("context")
                    .and_then(|x| x.as_u64())
                    .map(humanize_context),
                supports_effort: m.get("supports_effort").and_then(|x| x.as_bool()),
                group: str_field("group"),
                note: str_field("note"),
                endpoint: str_field("endpoint"),
                effort: m.get("effort").cloned().filter(|v| !v.is_null()),
                default: m.get("default").and_then(|x| x.as_bool()).unwrap_or(false),
                active: m.get("active").and_then(|x| x.as_bool()),
                priority: m.get("priority").and_then(|x| x.as_i64()),
                tags: m
                    .get("tags")
                    .and_then(|x| serde_json::from_value(x.clone()).ok()),
                tool_call: m.get("tool_call").and_then(|x| x.as_bool()),
                reasoning: m.get("reasoning").and_then(|x| x.as_bool()),
                modalities: m
                    .get("modalities")
                    .and_then(|x| serde_json::from_value(x.clone()).ok()),
            })
        })
        .collect()
}

/// Fetch OpenRouter's public `GET /api/v1/models`. No auth is required for the
/// catalog, but we attach the user's key when present so any account-specific
/// availability is reflected. Network / parse failures degrade to an empty
/// list, so the picker falls back to the curated catalog entries.
async fn discover_openrouter_models() -> ProviderModelList {
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
    {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };
    let mut req = client
        .get("https://openrouter.ai/api/v1/models")
        // Same app-attribution headers we send on chat calls (OpenRouter
        // rankings) — applied here too so every Fleetify→OpenRouter request
        // is attributed consistently.
        .header(
            "HTTP-Referer",
            crate::bridges::openai_compat::OPENROUTER_REFERER,
        )
        .header("X-Title", crate::bridges::openai_compat::OPENROUTER_TITLE);
    if let Some(key) = crate::providers::keys::get_key("openrouter") {
        req = req.bearer_auth(key);
    }
    let body: Value = match req.send().await {
        Ok(r) if r.status().is_success() => match r.json().await {
            Ok(v) => v,
            Err(_) => return Vec::new(),
        },
        _ => return Vec::new(),
    };
    parse_openrouter_models(&body)
}

/// Pure parser for the OpenRouter `/models` payload — testable without HTTP.
/// Maps `data: [{ id, name, context_length }]` to the picker shape, sorted by
/// id for a stable rail order.
fn parse_openrouter_models(body: &Value) -> ProviderModelList {
    let Some(arr) = body.get("data").and_then(|d| d.as_array()) else {
        return Vec::new();
    };
    let mut out: ProviderModelList = arr
        .iter()
        .filter_map(|m| {
            let id = m.get("id").and_then(|x| x.as_str())?.to_string();
            let label = m
                .get("name")
                .and_then(|x| x.as_str())
                .map(str::to_string)
                .unwrap_or_else(|| id.clone());
            let ctx = m
                .get("context_length")
                .and_then(|x| x.as_u64())
                .map(humanize_context);
            Some(ProviderModel::basic(id, label, ctx))
        })
        .collect();
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

/// Fetch xAI's `GET {base}/models` (OpenAI-shaped: `data: [{ id, context_length }]`).
/// Unlike OpenRouter, the xAI catalog is account-scoped and REQUIRES the key, so a
/// missing key → empty list and the renderer falls back to the remote catalog /
/// baked `GROK_MODELS`. Network / parse failures also degrade to empty.
async fn discover_grok_models() -> ProviderModelList {
    let Some(key) = crate::providers::keys::get_key("grok") else {
        return Vec::new();
    };
    let base = crate::providers::find_provider("grok")
        .map(|s| s.default_base_url)
        .unwrap_or("https://api.x.ai/v1");
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
    {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };
    let url = format!("{base}/models");
    let body: Value = match client.get(&url).bearer_auth(&key).send().await {
        Ok(r) if r.status().is_success() => match r.json().await {
            Ok(v) => v,
            Err(_) => return Vec::new(),
        },
        _ => return Vec::new(),
    };
    parse_grok_models(&body)
}

/// Map xAI's OpenAI-compatible `GET /v1/models` payload (`data: [{id, context_length}]`)
/// into our `ProviderModel`s, sorted by id. Pure — unit-tested without a network call.
fn parse_grok_models(body: &Value) -> ProviderModelList {
    let Some(arr) = body.get("data").and_then(|d| d.as_array()) else {
        return Vec::new();
    };
    let mut out: ProviderModelList = arr
        .iter()
        .filter_map(|m| {
            let id = m.get("id").and_then(|x| x.as_str())?.to_string();
            let ctx = m
                .get("context_length")
                .and_then(|x| x.as_u64())
                .map(humanize_context);
            let label = id.clone();
            Some(ProviderModel::basic(id, label, ctx))
        })
        .collect();
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

/// Fetch Ollama Cloud's model list (`GET {base}/api/tags`). The list is open
/// (no key required), but we attach the stored key when present so a future
/// auth-gated list still works. Network / parse failures degrade to an empty
/// list, so the picker falls back to the curated catalog entries.
async fn discover_ollama_cloud_models() -> ProviderModelList {
    // Resolve the cloud base the same way dispatch does
    // (`chat::ollama_cloud_base_url_from_cfg`) so a configured
    // `providers.ollama_cloud_base_url` override is honored here too. With no
    // override this still yields `https://ollama.com` (the catalog default), so
    // it's a no-op for users who never set one.
    let base = crate::routers::chat::ollama_cloud_base_url_from_cfg();
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
    {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };
    let url = format!("{}/api/tags", base.trim_end_matches('/'));
    let mut req = client.get(&url);
    if let Some(key) = crate::providers::keys::get_key("ollama-cloud") {
        req = req.bearer_auth(key);
    }
    let body: Value = match req.send().await {
        Ok(r) if r.status().is_success() => match r.json().await {
            Ok(v) => v,
            Err(_) => return Vec::new(),
        },
        _ => return Vec::new(),
    };
    parse_ollama_tags_models(&body)
}

/// Pure parser for Ollama's `GET /api/tags` payload — testable without HTTP.
/// Maps `models: [{ name, ... }]` to the picker shape (each entry's `name` is
/// both id and label), sorted by id for a stable rail order. Unlike OpenAI's
/// `/v1/models`, Ollama returns `models`, not `data`.
fn parse_ollama_tags_models(body: &Value) -> ProviderModelList {
    let Some(arr) = body.get("models").and_then(|m| m.as_array()) else {
        return Vec::new();
    };
    let mut out: ProviderModelList = arr
        .iter()
        .filter_map(|m| {
            let name = m.get("name").and_then(|n| n.as_str())?.to_string();
            Some(ProviderModel::basic(name.clone(), name, None))
        })
        .collect();
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

/// Fetch Cloudflare Workers AI's live model catalog via
/// `GET /accounts/{id}/ai/models/search`, keeping only Text Generation (chat)
/// models. Requires the stored account id + token; either missing (or any
/// network/parse failure) degrades to an empty list so the picker falls back
/// to the curated catalog. Mirrors `discover_openrouter_models`, but
/// Cloudflare's catalog is account-scoped so it needs auth (OpenRouter's is
/// public).
async fn discover_cloudflare_models() -> ProviderModelList {
    let Some(account_id) = crate::providers::keys::get_cloudflare_account_id() else {
        return Vec::new();
    };
    let Some(token) = crate::providers::keys::get_key("cloudflare-workers-ai") else {
        return Vec::new();
    };
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
    {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };
    // The catalog is small (<100 models). Page through 100 at a time and stop
    // at the first short page; cap pages defensively so a malformed
    // result_info can't loop us.
    let mut out: ProviderModelList = Vec::new();
    for page in 1..=4u32 {
        let url = format!(
            "https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/models/search?per_page=100&page={page}"
        );
        let body: Value = match client.get(&url).bearer_auth(&token).send().await {
            Ok(r) if r.status().is_success() => match r.json().await {
                Ok(v) => v,
                Err(_) => break,
            },
            _ => break,
        };
        let raw_len = body
            .get("result")
            .and_then(|d| d.as_array())
            .map(|a| a.len())
            .unwrap_or(0);
        out.extend(parse_cloudflare_models(&body));
        if raw_len < 100 {
            break; // last page
        }
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out.dedup_by(|a, b| a.id == b.id);
    out
}

/// Pure parser for the Cloudflare `/ai/models/search` payload — testable
/// without HTTP. Keeps only `task.name == "Text Generation"` entries, mapping
/// `result[].name` (the `@cf/...` id) to the picker shape. Label is the id's
/// last path segment for a compact rail entry.
fn parse_cloudflare_models(body: &Value) -> ProviderModelList {
    let Some(arr) = body.get("result").and_then(|d| d.as_array()) else {
        return Vec::new();
    };
    arr.iter()
        .filter(|m| {
            m.get("task")
                .and_then(|t| t.get("name"))
                .and_then(|n| n.as_str())
                == Some("Text Generation")
        })
        .filter_map(|m| {
            let id = m.get("name").and_then(|x| x.as_str())?.to_string();
            let label = id.rsplit('/').next().unwrap_or(&id).to_string();
            Some(ProviderModel::basic(id, label, None))
        })
        .collect()
}

/// `128000 → "128K"`, `1_000_000 → "1M"`, `200000 → "200K"`. Display-only.
fn humanize_context(n: u64) -> String {
    if n >= 1_000_000 {
        let m = n as f64 / 1_000_000.0;
        if (m - m.round()).abs() < 0.05 {
            format!("{}M", m.round() as u64)
        } else {
            format!("{m:.1}M")
        }
    } else if n >= 1_000 {
        format!("{}K", n / 1_000)
    } else {
        n.to_string()
    }
}

/// Shared scanner used by the HTTP endpoints, Auto routing and the startup
/// warm-up. Returns a JSON-serializable map keyed by provider id. Every agent
/// is probed at once: Claude Code and Codex answer through their own status
/// commands (~0.2 s each), the rest from disk. `providers::cli_auth` holds
/// the rules, so every surface gets the same answer.
pub async fn scan_all_agents() -> HashMap<String, Value> {
    let ctx = cli_auth::AuthCtx::system();
    let ctx = &ctx;
    let rows = futures_util::future::join_all(crate::providers::list_cli_agents().into_iter().map(
        |spec| async move {
            let path = cli_auth::detect_install(spec).await;
            let installed = path.is_some();
            let authenticated = cli_auth::agent_signed_in(spec, path.as_deref(), ctx).await;
            crate::services::telemetry::emitters::emit_agent_detected(
                spec.id,
                installed,
                authenticated,
            )
            .await;
            let login = cli_auth::login_spec(spec.id);
            (
                spec.id.to_string(),
                json!({
                    "id": spec.id,
                    "display_name": spec.display_name,
                    "installed": installed,
                    "authenticated": authenticated,
                    // False for agents that work without a sign-in (OpenCode's
                    // free models): "not signed in" is then not a problem.
                    "auth_required": cli_auth::sign_in_required(spec.id),
                    "path": path,
                    "install_hint": resolve_install_hint(spec),
                    "login_hint": spec.login_hint,
                    // How Fleetify signs it in: "browser" | "terminal" | "api_key".
                    "login_kind": login.map(|l| l.kind),
                }),
            )
        },
    ))
    .await;
    rows.into_iter().collect()
}

/// How long a scan stays fresh. Signing in or out happens outside Fleetify
/// too (a terminal, another app), so a stale "Sign in" must heal on its own.
pub const AGENT_SCAN_MAX_AGE: Duration = Duration::from_secs(30);

/// The agent scan: from the cache while it's fresh, else a new scan that
/// refills it. `force` skips the cache (Refresh, a finished login).
pub async fn agent_scan(cache: &AgentScanCache, force: bool) -> HashMap<String, Value> {
    if !force {
        if let Some(snapshot) = cache.get_fresh(AGENT_SCAN_MAX_AGE).await {
            return snapshot;
        }
    }
    let fresh = scan_all_agents().await;
    cache.set(fresh.clone()).await;
    fresh
}

/// Cache-aware CLI agent scan handler. `?refresh=1` forces a re-scan, for
/// install / login / manual flows. Drives Settings → Agents tiles + the New
/// Agent dialog detection chips.
async fn scan_agents_cached(
    State(state): State<AppState>,
    Query(q): Query<ScanQuery>,
) -> Json<Value> {
    let force = matches!(q.refresh, Some(n) if n != 0);
    let snapshot = agent_scan(&state.agent_scan_cache, force).await;
    Json(Value::Object(snapshot.into_iter().collect()))
}

/// Result of verifying a Cloudflare Workers AI token against an account.
pub(crate) struct CfVerify {
    pub valid: bool,
    pub error: Option<String>,
}

/// Verify a Cloudflare token can run Workers AI on a specific account.
///
/// The token this card mints is scoped to *Workers AI only*, which means it
/// lacks the account-listing permission: `GET /accounts` returns an empty
/// list, so the account can't be auto-discovered. Instead the user copies
/// their Account ID by hand (Cloudflare's own REST API quickstart does the
/// same) and we validate the pair against the native Workers AI model catalog
/// (`GET /accounts/{id}/ai/models/search`). A 200/`success` means the token
/// has Workers AI read on that account; a wrong id or a token missing the
/// permission both 403 with code 10000 ("Authentication error"). No inference
/// is run, so verifying is free.
///
/// `base` is the API root (`https://api.cloudflare.com` in prod; a wiremock
/// URI in tests) so the network calls are injectable.
pub(crate) async fn cf_verify_workers_ai(base: &str, token: &str, account_id: &str) -> CfVerify {
    let token = token.trim();
    let account_id = account_id.trim();
    if token.is_empty() {
        return CfVerify {
            valid: false,
            error: Some("empty token".into()),
        };
    }
    if account_id.is_empty() {
        return CfVerify {
            valid: false,
            error: Some("Account ID is required.".into()),
        };
    }
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            return CfVerify {
                valid: false,
                error: Some(e.to_string()),
            }
        }
    };
    let base = base.trim_end_matches('/');
    // 1) Is the token itself active? Surfaces a clear "bad token" message,
    //    distinct from the "bad account / missing permission" case below.
    let active = match client
        .get(format!("{base}/client/v4/user/tokens/verify"))
        .bearer_auth(token)
        .send()
        .await
    {
        Ok(r) => {
            let v: Value = r.json().await.unwrap_or_else(|_| json!({}));
            v.get("result")
                .and_then(|x| x.get("status"))
                .and_then(|s| s.as_str())
                == Some("active")
        }
        Err(e) => {
            return CfVerify {
                valid: false,
                error: Some(format!("verify failed: {e}")),
            }
        }
    };
    if !active {
        return CfVerify {
            valid: false,
            error: Some("Token is not valid or active.".into()),
        };
    }
    // 2) Can the token read Workers AI on this account? Listing the model
    //    catalog is cheap (no inference). A non-success response means a wrong
    //    Account ID or a token without the Workers AI permission.
    match client
        .get(format!(
            "{base}/client/v4/accounts/{account_id}/ai/models/search?per_page=1"
        ))
        .bearer_auth(token)
        .send()
        .await
    {
        Ok(r) => {
            let http_ok = r.status().is_success();
            let v: Value = r.json().await.unwrap_or_else(|_| json!({}));
            let success = http_ok && v.get("success").and_then(|s| s.as_bool()).unwrap_or(false);
            if success {
                CfVerify {
                    valid: true,
                    error: None,
                }
            } else {
                CfVerify {
                    valid: false,
                    error: Some(
                        "Token can't access Workers AI on this account — check the \
                         Account ID and that the token has Workers AI permissions."
                            .into(),
                    ),
                }
            }
        }
        Err(e) => CfVerify {
            valid: false,
            error: Some(format!("Workers AI check failed: {e}")),
        },
    }
}

#[derive(serde::Deserialize)]
struct CloudflareVerifyBody {
    token: String,
    #[serde(default)]
    account_id: String,
}

/// `POST /providers/cloudflare/verify` — body `{ "token": "…", "account_id":
/// "…" }`. Local-only (renderer hits 127.0.0.1); the token is verified against
/// the Workers AI catalog for the given account, never persisted here (the
/// renderer stores it via `providers_set_key` + `set_cloudflare_account_id`
/// after a successful verify). Returns `{ valid, error? }`.
async fn cloudflare_verify(Json(body): Json<CloudflareVerifyBody>) -> Json<Value> {
    let r = cf_verify_workers_ai("https://api.cloudflare.com", &body.token, &body.account_id).await;
    Json(json!({ "valid": r.valid, "error": r.error }))
}

/// Well-known absolute install paths for the `ollama` binary, per OS. Pure so
/// it is unit-testable without a real install. The official installers drop
/// the binary at these fixed locations, which a Finder/Explorer-launched
/// process may not carry on its PATH — same reason the CLI bridges keep a
/// `resolve_*_bin` list.
fn ollama_bin_candidates() -> Vec<PathBuf> {
    #[allow(unused_mut)]
    let mut c: Vec<PathBuf> = Vec::new();
    #[cfg(target_os = "macos")]
    {
        c.push(PathBuf::from("/usr/local/bin/ollama"));
        c.push(PathBuf::from("/opt/homebrew/bin/ollama"));
        // Ollama.app ships the CLI inside the bundle; the /usr/local/bin
        // symlink is only created on first launch, so check the bundle too.
        c.push(PathBuf::from(
            "/Applications/Ollama.app/Contents/Resources/ollama",
        ));
        if let Ok(home) = std::env::var("HOME") {
            c.push(PathBuf::from(home).join("Applications/Ollama.app/Contents/Resources/ollama"));
        }
    }
    #[cfg(target_os = "linux")]
    {
        c.push(PathBuf::from("/usr/local/bin/ollama"));
        c.push(PathBuf::from("/usr/bin/ollama"));
        if let Ok(home) = std::env::var("HOME") {
            c.push(PathBuf::from(home).join(".local/bin/ollama"));
        }
    }
    #[cfg(target_os = "windows")]
    {
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            c.push(PathBuf::from(&local).join(r"Programs\Ollama\ollama.exe"));
        }
        if let Ok(pf) = std::env::var("ProgramFiles") {
            c.push(PathBuf::from(&pf).join(r"Ollama\ollama.exe"));
        }
    }
    c
}

/// Whether the `ollama` CLI is present on this machine — PATH first (which
/// resolves `ollama.exe` on Windows), then the well-known install locations
/// above. Instant and deterministic, unlike the daemon's HTTP probe, so it
/// reports "installed" even when the daemon is stopped or merely slow to
/// answer the scan's 2 s probe.
fn ollama_cli_present() -> bool {
    which::which("ollama").is_ok() || ollama_bin_candidates().iter().any(|p| p.exists())
}

/// `installed` for the Ollama scan row: a reachable daemon proves the install
/// (even a remote `$OLLAMA_HOST` box); otherwise fall back to the local CLI
/// being present on disk.
fn ollama_installed(running: bool, cli_present: bool) -> bool {
    running || cli_present
}

/// Probe an Ollama daemon. Base URL is parameterized so callers can
/// point at a LAN box (`http://192.168.1.50:11434`) when the user has
/// configured `ProvidersConfig.ollama_base_url`. With no explicit value it
/// falls back to `$OLLAMA_HOST`, then the IPv4 loopback default — see
/// `fleetify_core::resolve_ollama_base_url` for why not `localhost`.
///
/// Returns `{ running, installed, models, base_url }`. `running` is the live
/// daemon probe; `installed` is the durable signal (daemon reachable OR the
/// `ollama` CLI on disk) the onboarding picker buckets on, so an installed-but-
/// stopped Ollama isn't mislabelled "Installable".
async fn check_ollama(base_url: Option<&str>) -> Value {
    let base = fleetify_core::resolve_ollama_base_url(
        base_url,
        std::env::var("OLLAMA_HOST").ok().as_deref(),
    );
    let base = base.as_str();
    // Resolved once up front so every "daemon down" exit still reports an
    // accurate install state from the on-disk CLI.
    let cli_present = ollama_cli_present();
    let down = |base: &str| json!({ "running": false, "installed": ollama_installed(false, cli_present), "models": [], "base_url": base });
    let url = format!("{}/api/tags", base.trim_end_matches('/'));
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
    {
        Ok(c) => c,
        Err(_) => return down(base),
    };
    // Optional saved key for a secured/reverse-proxied daemon; keyless
    // localhost works unchanged (no cached key ⇒ no header).
    let mut req = client.get(&url);
    if let Some(k) = crate::providers::keys::get_key("ollama") {
        req = req.header("Authorization", format!("Bearer {k}"));
    }
    let resp = match req.send().await {
        Ok(r) => r,
        Err(_) => return down(base),
    };
    if !resp.status().is_success() {
        return down(base);
    }
    let body: Value = match resp.json().await {
        Ok(v) => v,
        Err(_) => return down(base),
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
    json!({ "running": true, "installed": true, "models": models, "base_url": base })
}

/// Onboarding's `/providers/scan` payload: one `{installed, authenticated,
/// path}` bucket per CLI agent, keyed by the id with `-` → `_`
/// (`claude-code` → `claude_code`), plus Ollama and the env-key inventory.
/// The buckets are cut from the same scan Settings → Agents reads, so
/// onboarding and Settings can't disagree.
fn providers_scan_payload(agents: &HashMap<String, Value>, ollama: Value) -> Value {
    let mut out = serde_json::Map::new();
    for spec in crate::providers::list_cli_agents() {
        let row = agents.get(spec.id);
        let flag = |key: &str| {
            row.and_then(|r| r.get(key))
                .and_then(Value::as_bool)
                .unwrap_or(false)
        };
        out.insert(
            spec.id.replace('-', "_"),
            json!({
                "installed": flag("installed"),
                "authenticated": flag("authenticated"),
                "path": row.and_then(|r| r.get("path")).cloned().unwrap_or(Value::Null),
            }),
        );
    }
    out.insert("ollama".into(), ollama);
    out.insert(
        "env_keys".into(),
        json!({
            "anthropic": std::env::var("ANTHROPIC_API_KEY").is_ok(),
            "openai": std::env::var("OPENAI_API_KEY").is_ok(),
            "groq": std::env::var("GROQ_API_KEY").is_ok(),
        }),
    );
    Value::Object(out)
}

async fn scan_providers(State(state): State<AppState>) -> Json<Value> {
    // The legacy scan endpoint doesn't have access to ProvidersConfig
    // (it lives in the Tauri shell's fleet.config.json, not the
    // backend's AppState), so Ollama falls back to the localhost default
    // here. The new `providers_ollama_probe` IPC honours the user's
    // configured URL for the Settings surface.
    let (agents, ollama) = tokio::join!(
        agent_scan(&state.agent_scan_cache, false),
        check_ollama(None)
    );
    Json(providers_scan_payload(&agents, ollama))
}

/// Faithful with `app/utils/models.py` MODEL_CATALOG_BY_PROVIDER — the
/// new-chat picker's source of truth. Newest-most-capable → fastest →
/// legacy within each provider, top-down by recency.
async fn list_models() -> Json<Value> {
    Json(json!({
        "providers": [
            {
                "id": "claude-code",
                "label": "Claude Code",
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
                "id": "codex-cli",
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
            }
        ]
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ollama_installed_combines_running_daemon_and_cli_presence() {
        // The daemon answering proves Ollama is installed; so does the CLI
        // being on disk. Only when NEITHER holds is Ollama genuinely absent.
        // This is the fix for "installed but the picker shows Installable":
        // the first scan's 2 s HTTP probe can lose the race to a slow daemon,
        // so install state must not hinge on `running` alone.
        assert!(!ollama_installed(false, false));
        assert!(ollama_installed(true, false)); // daemon up, CLI off PATH
        assert!(ollama_installed(false, true)); // CLI present, daemon stopped
        assert!(ollama_installed(true, true));
    }

    #[test]
    fn ollama_bin_candidates_lists_os_known_install_paths() {
        // The official installers drop `ollama` at fixed locations a
        // GUI-launched app's PATH may miss, so we probe them by absolute path.
        let cands = ollama_bin_candidates();
        let as_str: Vec<String> = cands
            .iter()
            .map(|p| p.to_string_lossy().to_string())
            .collect();
        #[cfg(target_os = "linux")]
        {
            assert!(as_str.iter().any(|p| p == "/usr/local/bin/ollama"));
            assert!(as_str.iter().any(|p| p == "/usr/bin/ollama"));
        }
        #[cfg(target_os = "macos")]
        {
            assert!(as_str.iter().any(|p| p == "/usr/local/bin/ollama"));
            assert!(as_str
                .iter()
                .any(|p| p.ends_with("Ollama.app/Contents/Resources/ollama")));
        }
        #[cfg(target_os = "windows")]
        {
            // LOCALAPPDATA / ProgramFiles are effectively always set on Windows.
            assert!(as_str.iter().any(|p| p.ends_with("ollama.exe")));
        }
    }

    #[tokio::test]
    async fn http_health_cache_round_trip() {
        let cache = HttpHealthCache::default();
        assert!(cache.get().await.is_none(), "cold cache returns None");
        let mut snapshot = HashMap::new();
        snapshot.insert(
            "openai".to_string(),
            HealthSnapshot::Ok {
                latency_ms: 142,
                model_count: Some(36),
            },
        );
        snapshot.insert(
            "perplexity".to_string(),
            HealthSnapshot::Failed {
                code: "AUTH".into(),
                message: Some("401".into()),
            },
        );
        cache.set(snapshot.clone()).await;
        let read = cache.get().await.expect("cache populated");
        assert_eq!(read.len(), 2);
        assert!(matches!(
            read.get("openai"),
            Some(HealthSnapshot::Ok {
                latency_ms: 142,
                ..
            })
        ));
        cache.invalidate().await;
        assert!(cache.get().await.is_none(), "invalidate clears cache");
    }

    #[tokio::test]
    async fn http_health_cache_concurrent_writes_dont_panic() {
        let cache = HttpHealthCache::default();
        let mut handles = Vec::new();
        for i in 0..20 {
            let c = cache.clone();
            handles.push(tokio::spawn(async move {
                let mut s = HashMap::new();
                s.insert(
                    format!("id-{i}"),
                    HealthSnapshot::Ok {
                        latency_ms: i * 10,
                        model_count: None,
                    },
                );
                c.set(s).await;
            }));
        }
        for h in handles {
            h.await.unwrap();
        }
        assert!(
            cache.get().await.is_some(),
            "some writer's snapshot survived"
        );
    }

    #[tokio::test]
    async fn http_health_endpoint_returns_cached_snapshot() {
        use crate::auth::{AuthConfig, AuthState};
        use crate::routers::AppState;
        use axum::body::Body;
        use axum::http::Request;
        use std::sync::Arc;
        use tower::ServiceExt;

        // Minimal AppState — mirrors the build_app helper in routers/internal.rs.
        // We only touch http_health_cache, so all other fields are empty/default.
        let pool = crate::db::init_pool("sqlite::memory:").await.unwrap();
        let cfg = Arc::new(crate::config::AppConfig::load(None).expect("config/default.toml"));
        let auth_cfg = Arc::new(AuthConfig::from_env());
        let jwks = crate::auth::default_jwks_cache(&auth_cfg.jwks_url);
        let sm: &'static crate::session_manager::SessionManager =
            Box::leak(Box::new(crate::session_manager::SessionManager::for_tests()));
        let routing = crate::services::routing::RoutingOrchestrator::with_empty_defaults(false);
        let state = AppState {
            auth: AuthState {
                pool,
                cfg: auth_cfg,
                jwks,
            },
            app_cfg: cfg,
            sm,
            internal_secret: Arc::new("test-secret".to_string()),
            routing,
            permission_registry: Arc::new(
                tokio::sync::Mutex::new(std::collections::HashMap::new()),
            ),
            ask_registry: Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new())),
            agent_scan_cache: AgentScanCache::default(),
            http_health_cache: HttpHealthCache::default(),
        };

        let mut snap = HashMap::new();
        snap.insert(
            "openai".to_string(),
            HealthSnapshot::Ok {
                latency_ms: 99,
                model_count: Some(12),
            },
        );
        snap.insert("perplexity".to_string(), HealthSnapshot::NoKey);
        state.http_health_cache.set(snap).await;

        let app = crate::routers::providers::router().with_state(state);
        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/providers/health")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
        let body: serde_json::Value = serde_json::from_slice(
            &axum::body::to_bytes(resp.into_body(), usize::MAX)
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(body["ok"], true);
        assert_eq!(body["providers"]["openai"]["kind"], "ok");
        assert_eq!(body["providers"]["openai"]["latency_ms"], 99);
        assert_eq!(body["providers"]["perplexity"]["kind"], "no_key");
    }

    #[tokio::test]
    async fn agent_scan_cache_returns_primed_value_without_rescan() {
        let cache = AgentScanCache::default();
        let mut primed = HashMap::new();
        primed.insert(
            "test-agent".to_string(),
            json!({ "id": "test-agent", "installed": true }),
        );
        cache.set(primed.clone()).await;
        let read = cache.get().await.expect("cache should be populated");
        assert_eq!(read.len(), 1);
        assert_eq!(read.get("test-agent"), primed.get("test-agent"));
    }

    #[tokio::test]
    async fn agent_scan_cache_invalidate_clears() {
        let cache = AgentScanCache::default();
        cache.set(HashMap::new()).await;
        assert!(cache.get().await.is_some());
        cache.invalidate().await;
        assert!(cache.get().await.is_none());
    }

    #[tokio::test]
    async fn scan_endpoint_caches_repeated_calls() {
        let cache = AgentScanCache::default();
        // Cold call populates the cache.
        let cold = scan_all_agents().await;
        cache.set(cold.clone()).await;
        let warm = cache.get().await.expect("cache should be hot");
        assert_eq!(cold, warm, "cached and fresh scans must match shape");
    }

    #[tokio::test]
    async fn scan_all_agents_returns_one_entry_per_cli_provider() {
        let snapshot = scan_all_agents().await;
        let cli_count = crate::providers::CATALOG
            .iter()
            .filter(|p| matches!(p.kind, crate::providers::ProviderKind::Cli))
            .count();
        assert_eq!(snapshot.len(), cli_count);
        for spec in crate::providers::list_cli_agents() {
            assert!(snapshot.contains_key(spec.id), "missing {}", spec.id);
        }
    }

    // ── Remote-catalog disk cache (offline / cold-start fallback) ──
    fn home_guard<R>(home: &std::path::Path, f: impl FnOnce() -> R) -> R {
        let _g = crate::test_support::home_lock()
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let prev = std::env::var("FLEETIFY_HOME").ok();
        std::env::set_var("FLEETIFY_HOME", home);
        let r = f();
        match prev {
            Some(v) => std::env::set_var("FLEETIFY_HOME", v),
            None => std::env::remove_var("FLEETIFY_HOME"),
        }
        r
    }

    fn sample_models() -> ProviderModelList {
        vec![ProviderModel {
            id: "claude-opus-4-8".into(),
            label: "Opus 4.8".into(),
            ctx: Some("200k".into()),
            supports_effort: Some(true),
            group: None,
            note: None,
            endpoint: None,
            effort: None,
            default: false,
            active: None,
            priority: None,
            tags: None,
            tool_call: None,
            reasoning: None,
            modalities: None,
        }]
    }

    #[test]
    fn models_disk_cache_write_then_read_round_trips() {
        let tmp = tempfile::tempdir().unwrap();
        home_guard(tmp.path(), || {
            assert!(read_disk_cache("anthropic").is_none());
            write_disk_cache("anthropic", &sample_models());
            let got = read_disk_cache("anthropic").unwrap();
            assert_eq!(got.len(), 1);
            assert_eq!(got[0].id, "claude-opus-4-8");
            assert_eq!(got[0].supports_effort, Some(true));
        });
    }

    #[test]
    fn models_disk_cache_empty_not_persisted_corrupt_reads_none() {
        let tmp = tempfile::tempdir().unwrap();
        home_guard(tmp.path(), || {
            write_disk_cache("empty", &Vec::new());
            assert!(read_disk_cache("empty").is_none());
            let p = disk_cache_path("bad");
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(&p, "not json").unwrap();
            assert!(read_disk_cache("bad").is_none());
        });
    }

    #[test]
    fn persist_or_restore_round_trips_and_restores_on_empty() {
        let tmp = tempfile::tempdir().unwrap();
        home_guard(tmp.path(), || {
            let kept = persist_or_restore("anthropic", sample_models());
            assert_eq!(kept.len(), 1);
            let restored = persist_or_restore("anthropic", Vec::new());
            assert_eq!(restored.len(), 1);
            assert_eq!(restored[0].id, "claude-opus-4-8");
            assert!(persist_or_restore("never", Vec::new()).is_empty());
        });
    }

    #[test]
    fn remote_catalog_prewarm_set_excludes_live_probe_agents_and_covers_remote_sources() {
        let ids = remote_catalog_prewarm_ids();
        // Live-probe CLI agents resolve their lineup from a local CLI/ACP call
        // (the match arms in `discover_agent_models`), not fleetify.dev/api — so
        // they must NOT be in the remote-catalog prewarm set.
        for a in [
            "opencode",
            "cursor-cli",
            "grok-build",
            "github-copilot",
            "hermes-agent",
        ] {
            assert!(
                !ids.contains(&a),
                "{a} is discovered via a live probe and must be excluded from the remote prewarm"
            );
        }
        // Baked CLI agents (no live probe → fall through to fetch_remote_catalog)
        // and the HTTP API providers DO source their lineup from the remote
        // catalog, so they must be prewarmed.
        for p in [
            "claude-code",
            "codex-cli",
            "kimi-code",
            "antigravity-cli",
            "openai",
            "anthropic",
        ] {
            assert!(
                ids.contains(&p),
                "{p} sources from the remote catalog and must be prewarmed"
            );
        }
    }

    /// Onboarding's buckets are cut from the Settings scan, so the two can't
    /// disagree (they did: onboarding probed `kimi-code` and
    /// `antigravity-cli`, binaries that don't exist).
    #[test]
    fn providers_scan_payload_mirrors_the_agent_scan() {
        let mut agents = HashMap::new();
        agents.insert(
            "kimi-code".to_string(),
            json!({"installed": true, "authenticated": true, "path": "/usr/bin/kimi"}),
        );
        agents.insert(
            "antigravity-cli".to_string(),
            json!({"installed": true, "authenticated": false, "path": "/home/u/.local/bin/agy"}),
        );
        let v = providers_scan_payload(&agents, json!({"running": false}));
        assert_eq!(v["kimi_code"]["installed"], true);
        assert_eq!(v["kimi_code"]["authenticated"], true);
        assert_eq!(v["kimi_code"]["path"], "/usr/bin/kimi");
        assert_eq!(v["antigravity_cli"]["installed"], true);
        assert_eq!(v["antigravity_cli"]["authenticated"], false);
        // Every CLI agent has a bucket, scanned or not.
        for spec in crate::providers::list_cli_agents() {
            let key = spec.id.replace('-', "_");
            let bucket = v
                .get(&key)
                .unwrap_or_else(|| panic!("missing bucket {key}"));
            assert!(bucket["installed"].is_boolean());
            assert!(bucket["authenticated"].is_boolean());
        }
        assert_eq!(v["claude_code"]["installed"], false);
        assert!(v.get("ollama").is_some());
        assert!(v.get("env_keys").is_some());
    }

    #[tokio::test]
    async fn agent_scan_cache_goes_stale() {
        let cache = AgentScanCache::default();
        cache.set(HashMap::new()).await;
        assert!(cache.get_fresh(Duration::from_secs(60)).await.is_some());
        assert!(cache.get_fresh(Duration::ZERO).await.is_none());
        // Auto routing still gets the stale scan.
        assert!(cache.get().await.is_some());
    }

    #[tokio::test]
    async fn scan_rows_carry_login_kind_and_whether_sign_in_is_required() {
        let snapshot = scan_all_agents().await;
        assert_eq!(snapshot["opencode"]["auth_required"], false);
        assert_eq!(snapshot["claude-code"]["auth_required"], true);
        assert_eq!(snapshot["claude-code"]["login_kind"], "browser");
        assert_eq!(snapshot["hermes-agent"]["login_kind"], "terminal");
        assert_eq!(snapshot["antigravity-sdk"]["login_kind"], "api_key");
        assert_eq!(snapshot["claude-code"]["login_hint"], "claude auth login");
    }

    #[test]
    fn prettify_model_label_title_cases_the_tail_segment() {
        assert_eq!(prettify_model_label("opencode/big-pickle"), "Big Pickle");
        assert_eq!(
            prettify_model_label("opencode/deepseek-v4-flash-free"),
            "Deepseek V4 Flash Free"
        );
        // No slash → whole id is title-cased.
        assert_eq!(prettify_model_label("composer-2.5"), "Composer 2.5");
    }

    #[tokio::test]
    async fn discover_agent_models_returns_empty_for_unknown_agent() {
        // discover_agent_models now returns (models, current); an unknown agent
        // yields no models and no configured-model id.
        let (models, current) = discover_agent_models("totally-unknown", "").await;
        assert!(models.is_empty());
        assert!(current.is_none());
    }

    #[test]
    fn resolve_install_hint_picks_os_specific_when_set() {
        let p = crate::providers::CATALOG
            .iter()
            .find(|p| p.id == "ollama")
            .unwrap();
        let resolved = resolve_install_hint(p);
        if cfg!(windows) {
            assert!(resolved.contains("winget"), "got {resolved}");
        } else if cfg!(target_os = "macos") {
            assert!(resolved.contains("brew"), "got {resolved}");
        } else {
            assert!(resolved.contains("curl"), "got {resolved}");
        }
    }

    #[test]
    fn resolve_install_hint_falls_back_to_static_when_unset() {
        let p = crate::providers::CATALOG
            .iter()
            .find(|p| p.id == "claude-code")
            .unwrap();
        // CLI agents have install_hints: None, so the resolver falls back
        // to the single install_hint string (npm install -g …).
        assert_eq!(resolve_install_hint(p), p.install_hint);
        assert!(p.install_hint.contains("npm"));
    }

    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn python_module_probe_returns_installed_for_stdlib_module() {
        // The probe reads FLEETIFY_EMBEDDED_PYTHON, which other tests set
        // under the crate's env lock: hold it across the probe's awaits.
        let _g = crate::test_support::home_lock()
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let py_works = ["python3", "python", "py"].iter().any(|name| {
            fleetify_core::process::command(name)
                .arg("--version")
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .map(|s| s.success())
                .unwrap_or(false)
        });
        if !py_works {
            eprintln!("skipping: no working python on PATH");
            return;
        }
        let result = cli_auth::python_module_installed("json").await;
        assert!(
            result.installed,
            "json (stdlib) must import successfully when Python is present"
        );
        assert!(result.path.is_some(), "python path should be reported");
    }

    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn python_module_probe_returns_not_installed_for_bogus_module() {
        // As above: the probe reads FLEETIFY_EMBEDDED_PYTHON.
        let _g = crate::test_support::home_lock()
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let py_works = ["python3", "python", "py"].iter().any(|name| {
            fleetify_core::process::command(name)
                .arg("--version")
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .map(|s| s.success())
                .unwrap_or(false)
        });
        if !py_works {
            eprintln!("skipping: no working python on PATH");
            return;
        }
        let result = cli_auth::python_module_installed("definitely_not_a_real_module_2026").await;
        assert!(!result.installed, "bogus module must not import");
        assert!(
            result.path.is_some(),
            "python is still installed, only the module is missing"
        );
    }

    #[test]
    fn humanize_context_formats_common_windows() {
        assert_eq!(humanize_context(128_000), "128K");
        assert_eq!(humanize_context(200_000), "200K");
        assert_eq!(humanize_context(1_000_000), "1M");
        assert_eq!(humanize_context(2_000_000), "2M");
        assert_eq!(humanize_context(1_050_000), "1.1M");
        assert_eq!(humanize_context(512), "512");
    }

    #[test]
    fn parse_openrouter_models_maps_and_sorts() {
        let body = json!({
            "data": [
                { "id": "openai/gpt-4o", "name": "OpenAI: GPT-4o", "context_length": 128000 },
                { "id": "anthropic/claude-sonnet-4", "name": "Anthropic: Claude Sonnet 4", "context_length": 200000 },
                { "id": "no-context/model", "name": "No Context" }
            ]
        });
        let out = parse_openrouter_models(&body);
        assert_eq!(out.len(), 3);
        // Sorted by id: anthropic < no-context < openai.
        assert_eq!(out[0].id, "anthropic/claude-sonnet-4");
        assert_eq!(out[0].label, "Anthropic: Claude Sonnet 4");
        assert_eq!(out[0].ctx.as_deref(), Some("200K"));
        assert_eq!(out[2].id, "openai/gpt-4o");
        assert_eq!(out[2].ctx.as_deref(), Some("128K"));
        // Missing context_length → ctx is None.
        assert_eq!(out[1].id, "no-context/model");
        assert_eq!(out[1].ctx, None);
    }

    #[test]
    fn parse_openrouter_models_handles_missing_or_bad_payload() {
        assert!(parse_openrouter_models(&json!({})).is_empty());
        assert!(parse_openrouter_models(&json!({ "data": "nope" })).is_empty());
        // An entry without an id is skipped.
        assert!(parse_openrouter_models(&json!({ "data": [{ "name": "x" }] })).is_empty());
    }

    #[test]
    fn parse_grok_models_maps_id_and_context() {
        let body = serde_json::json!({
            "object": "list",
            "data": [
                { "id": "grok-4.3", "object": "model", "owned_by": "xai", "context_length": 1_000_000 },
                { "id": "grok-build-0.1", "object": "model", "owned_by": "xai", "context_length": 256_000 }
            ]
        });
        let out = parse_grok_models(&body);
        assert_eq!(out.len(), 2);
        // sorted by id → grok-4.3, then grok-build-0.1
        assert_eq!(out[0].id, "grok-4.3");
        assert_eq!(out[0].ctx.as_deref(), Some("1M"));
        assert_eq!(out[1].id, "grok-build-0.1");
        assert_eq!(out[1].ctx.as_deref(), Some("256K"));
    }

    #[test]
    fn parses_ollama_tags_into_models() {
        let body = serde_json::json!({ "models": [
            { "name": "gpt-oss:120b", "model": "gpt-oss:120b", "size": 1, "details": { "parameter_size": "120B" } },
            { "name": "qwen3-coder:480b", "model": "qwen3-coder:480b", "size": 2 }
        ]});
        let models = parse_ollama_tags_models(&body);
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].id, "gpt-oss:120b");
        assert_eq!(models[0].label, "gpt-oss:120b");
    }

    #[test]
    fn parses_ollama_tags_empty_to_empty() {
        assert!(parse_ollama_tags_models(&serde_json::json!({})).is_empty());
    }

    #[test]
    fn parse_catalog_pointer_reads_identity() {
        // The `/api/meta` pointer: identity is `catalogCommit`, `tag` is the
        // ref being served.
        let body = json!({
            "schemaVersion": 1,
            "tag": "v2026.08.01",
            "catalogCommit": "2340bcf",
            "assignedTag": "v2026.08.01",
            "assignedCommit": "2340bcf",
            "generatedAt": "2026-08-01T11:56:41.652Z",
            "providerCount": 16,
            "modelCount": 91
        });
        let v = parse_catalog_pointer(&body).expect("pointer parses");
        assert_eq!(v.commit.as_deref(), Some("2340bcf"));
        assert_eq!(v.tag.as_deref(), Some("v2026.08.01"));
        assert!(!v.is_staged(), "assigned == served ⇒ not in a rollout");
    }

    #[test]
    fn parse_catalog_pointer_without_commit_is_a_miss() {
        // No identity ⇒ nothing we can compare against, so it must NOT be
        // recorded over a known-good commit (that would mask the next change).
        assert!(parse_catalog_pointer(&json!({ "tag": "main" })).is_none());
        assert!(parse_catalog_pointer(&json!({ "catalogCommit": "" })).is_none());
        assert!(parse_catalog_pointer(&json!({ "nope": 1 })).is_none());
    }

    #[test]
    fn parse_catalog_pointer_tolerates_a_missing_tag() {
        let v = parse_catalog_pointer(&json!({ "catalogCommit": "deadbee" }))
            .expect("commit alone is a valid identity");
        assert_eq!(v.commit.as_deref(), Some("deadbee"));
        assert!(v.tag.is_none());
    }

    #[test]
    fn staged_assignment_reports_the_candidate_not_the_served_catalog() {
        // Inside a rollout the cloud serves `main` from its own cache but
        // assigns us the candidate. Reporting the API's commit here would make
        // the fleet's version distribution lie about who is on what.
        let v = parse_catalog_pointer(&json!({
            "tag": "main",
            "catalogCommit": "aaaaaaa",
            "assignedTag": "v2026.08.01",
            "assignedCommit": null
        }))
        .expect("an assigned tag alone is a valid identity");
        assert_eq!(v.tag.as_deref(), Some("v2026.08.01"));
        assert_eq!(v.api_tag.as_deref(), Some("main"));
        assert!(
            v.commit.is_none(),
            "must NOT inherit the served catalog's commit"
        );
        assert_eq!(v.identity(), Some("v2026.08.01"));
        assert!(
            v.is_staged(),
            "assigned != served ⇒ fetch the payload from the CDN"
        );
    }

    #[test]
    fn rollout_bucket_is_in_range_and_deterministic() {
        for id in ["a", "0e5c7f4e-1f2a-4b3c-8d9e-000000000001", ""] {
            let b = rollout_bucket(id);
            assert!(b < 100, "{id} → {b} out of range");
            assert_eq!(b, rollout_bucket(id), "same device must not hop slices");
        }
        // Different devices land in different slices (not a distribution test —
        // just that the bucket actually depends on the id).
        assert_ne!(rollout_bucket("device-a"), rollout_bucket("device-b"));
    }

    #[test]
    fn parse_remote_catalog_api_shape() {
        // Serving-API shape: top-level `models`.
        let body = json!({
            "provider": { "id": "openai" },
            "models": [
                { "id": "gpt-5.5", "label": "GPT-5.5", "context": 1_050_000, "supports_effort": true },
                { "id": "gpt-4.1", "label": "GPT-4.1", "context": 1_000_000, "supports_effort": false }
            ]
        });
        let out = parse_remote_catalog(&body);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].id, "gpt-5.5");
        assert_eq!(out[0].ctx.as_deref(), Some("1.1M"));
        assert_eq!(out[0].supports_effort, Some(true));
        assert_eq!(out[1].supports_effort, Some(false));
    }

    #[test]
    fn parse_remote_catalog_jsdelivr_shape() {
        // jsDelivr per-provider file: `provider.models`.
        let body = json!({
            "schemaVersion": 1, "commit": "abc",
            "provider": {
                "id": "claude-code", "name": "Claude Code", "kind": "cli",
                "models": [
                    { "id": "claude-opus-4-8", "label": "Opus 4.8", "context": 1_000_000, "supports_effort": true, "effort": {"kind":"levels","levels":["low","high"],"default":"high"} }
                ]
            }
        });
        let out = parse_remote_catalog(&body);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].id, "claude-opus-4-8");
        assert_eq!(out[0].label, "Opus 4.8");
        assert_eq!(out[0].ctx.as_deref(), Some("1M"));
        assert_eq!(out[0].supports_effort, Some(true));
        // effort passes through verbatim
        let effort = serde_json::json!({"kind":"levels","levels":["low","high"],"default":"high"});
        assert_eq!(out[0].effort.as_ref(), Some(&effort));
    }

    #[test]
    fn parse_remote_catalog_carries_default() {
        let body = serde_json::json!({
            "models": [
                {"id": "a", "label": "A", "default": true},
                {"id": "b", "label": "B"}
            ]
        });
        let models = parse_remote_catalog(&body);
        assert!(models.iter().find(|m| m.id == "a").unwrap().default);
        assert!(!models.iter().find(|m| m.id == "b").unwrap().default);
    }

    #[test]
    fn parse_remote_catalog_carries_group_and_endpoint() {
        // Perplexity Agent entries carry the picker group + endpoint override.
        let body = json!({ "models": [
            {
                "id": "anthropic/claude-opus-4-7", "label": "Claude Opus 4.7",
                "context": 1_000_000, "supports_effort": true,
                "group": "Agent API", "note": null, "endpoint": "/v1/agent"
            }
        ]});
        let out = parse_remote_catalog(&body);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].group.as_deref(), Some("Agent API"));
        assert_eq!(out[0].endpoint.as_deref(), Some("/v1/agent"));
        // Explicit JSON null collapses to None (omitted from the wire shape).
        assert_eq!(out[0].note, None);
    }

    #[test]
    fn parse_remote_catalog_treats_null_effort_as_absent() {
        // An explicit JSON null effort collapses to None so it's omitted from
        // the wire shape, mirroring the `note: null -> None` behaviour.
        let body = json!({ "models": [
            { "id": "m1", "label": "M1", "effort": null }
        ]});
        let out = parse_remote_catalog(&body);
        assert_eq!(out.len(), 1);
        assert!(out[0].effort.is_none());
    }

    #[test]
    fn parse_remote_catalog_handles_missing_or_bad_payload() {
        assert!(parse_remote_catalog(&json!({})).is_empty());
        assert!(parse_remote_catalog(&json!({ "models": "nope" })).is_empty());
        // An entry without an id is skipped.
        assert!(parse_remote_catalog(&json!({ "models": [{ "label": "x" }] })).is_empty());
    }

    #[tokio::test]
    async fn ollama_suggestions_are_separate_from_installed_model_discovery() {
        let models = parse_remote_catalog(&json!({
            "provider": { "models": [
                {
                    "id": "qwen3-vl",
                    "label": "Qwen3-VL",
                    "tags": ["2b", "4b"],
                    "tool_call": true,
                    "reasoning": true,
                    "modalities": { "input": ["text", "image"], "output": ["text"] },
                    "priority": 20
                },
                {
                    "id": "nomic-embed-text",
                    "modalities": { "input": ["text"], "output": ["embedding"] }
                },
                { "id": "retired", "active": false }
            ] }
        }));
        let cached = serde_json::to_string(&models).unwrap();
        let models = serde_json::from_str(&cached).unwrap();
        let previous = remote_catalog_cache()
            .write()
            .await
            .insert("ollama".into(), (Instant::now(), models));

        let Json(suggestions) = list_ollama_suggestions().await;
        let Json(discovery) = list_provider_models(
            Path("ollama".into()),
            Query(ModelsQuery {
                cwd: None,
                refresh: Some(1),
            }),
        )
        .await;

        let mut cache = remote_catalog_cache().write().await;
        if let Some(previous) = previous {
            cache.insert("ollama".into(), previous);
        } else {
            cache.remove("ollama");
        }

        assert_eq!(discovery, json!({ "id": "ollama", "models": [] }));
        assert_eq!(suggestions["models"].as_array().unwrap().len(), 2);
        let model = &suggestions["models"][0];
        assert_eq!(model["id"], "qwen3-vl");
        assert_eq!(model["tags"], json!(["2b", "4b"]));
        assert_eq!(model["tool_call"], true);
        assert_eq!(model["reasoning"], true);
        assert_eq!(model["modalities"]["input"], json!(["text", "image"]));
        assert_eq!(model["priority"], 20);
        let embedding = &suggestions["models"][1];
        assert_eq!(embedding["modalities"]["output"], json!(["embedding"]));
        assert!(embedding.get("tags").is_none());
    }

    #[test]
    fn models_api_base_defaults_to_prod() {
        // Only assert the default when the override isn't set in this process,
        // to avoid clobbering a CI-provided value (env is process-global).
        if std::env::var("FLEETIFY_MODELS_API").is_err() {
            assert_eq!(models_api_base(), "https://fleetify.dev/api");
        }
        assert!(!models_cdn_tag().is_empty());
    }

    #[tokio::test]
    async fn cf_verify_workers_ai_active_token_and_account_is_valid() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/client/v4/user/tokens/verify"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "result": { "id": "t1", "status": "active" }, "success": true
            })))
            .mount(&server)
            .await;
        // Native Workers AI model catalog — 200/success proves the token has
        // Workers AI read on this account (no inference is run). Workers AI
        // tokens can't list accounts, so the account id is supplied by hand
        // and validated here instead of via `GET /accounts`.
        Mock::given(method("GET"))
            .and(path("/client/v4/accounts/acc_123/ai/models/search"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "result": [ { "id": "m1", "name": "@cf/meta/llama" } ], "success": true
            })))
            .mount(&server)
            .await;

        let out = super::cf_verify_workers_ai(&server.uri(), "tok", "acc_123").await;
        assert!(out.valid);
        assert!(out.error.is_none());
    }

    #[tokio::test]
    async fn cf_verify_workers_ai_inactive_token_is_invalid() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/client/v4/user/tokens/verify"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "result": { "status": "disabled" }, "success": true
            })))
            .mount(&server)
            .await;
        let out = super::cf_verify_workers_ai(&server.uri(), "tok", "acc_123").await;
        assert!(!out.valid);
    }

    #[tokio::test]
    async fn cf_verify_workers_ai_token_without_account_access_is_invalid() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/client/v4/user/tokens/verify"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "result": { "status": "active" }, "success": true
            })))
            .mount(&server)
            .await;
        // A wrong account id (or a token missing the Workers AI permission)
        // both 403 with code 10000 "Authentication error".
        Mock::given(method("GET"))
            .and(path("/client/v4/accounts/acc_123/ai/models/search"))
            .respond_with(ResponseTemplate::new(403).set_body_json(serde_json::json!({
                "result": null, "success": false,
                "errors": [ { "code": 10000, "message": "Authentication error" } ]
            })))
            .mount(&server)
            .await;
        let out = super::cf_verify_workers_ai(&server.uri(), "tok", "acc_123").await;
        assert!(!out.valid);
        assert!(out.error.is_some());
    }

    #[tokio::test]
    async fn cf_verify_workers_ai_requires_account_id() {
        // A blank account id is rejected before any network call is made.
        let out = super::cf_verify_workers_ai("http://127.0.0.1:1", "tok", "   ").await;
        assert!(!out.valid);
        assert!(out.error.is_some());
    }

    #[test]
    fn provider_models_json_emits_present_omits_absent() {
        let models = vec![
            ProviderModel {
                id: "a/b".into(),
                label: "B".into(),
                ctx: Some("128K".into()),
                supports_effort: Some(true),
                group: Some("Agent API".into()),
                note: Some("Reasoning".into()),
                endpoint: Some("/v1/agent".into()),
                effort: Some(serde_json::json!({
                    "kind": "levels", "levels": ["low", "high"], "default": "high"
                })),
                default: true,
                active: None,
                priority: Some(50),
                tags: None,
                tool_call: None,
                reasoning: None,
                modalities: None,
            },
            ProviderModel::basic("c/d".into(), "D".into(), None),
        ];
        let v = provider_models_json("openrouter", &models);
        assert_eq!(v["id"], "openrouter");
        // Present fields are serialized.
        assert_eq!(v["models"][0]["ctx"], "128K");
        assert_eq!(v["models"][0]["supports_effort"], true);
        assert_eq!(v["models"][0]["group"], "Agent API");
        assert_eq!(v["models"][0]["note"], "Reasoning");
        assert_eq!(v["models"][0]["endpoint"], "/v1/agent");
        // effort descriptor round-trips back out verbatim.
        assert_eq!(v["models"][0]["effort"]["kind"], "levels");
        assert_eq!(v["models"][0]["effort"]["default"], "high");
        // `default` is always emitted (plain bool, not omitted when false).
        assert_eq!(v["models"][0]["default"], true);
        // `priority` is emitted when present.
        assert_eq!(v["models"][0]["priority"], 50);
        // Absent optionals are omitted from the wire shape (not null).
        assert!(v["models"][1].get("ctx").is_none());
        assert!(v["models"][1].get("priority").is_none());
        assert!(v["models"][1].get("supports_effort").is_none());
        assert!(v["models"][1].get("group").is_none());
        assert!(v["models"][1].get("effort").is_none());
        assert_eq!(v["models"][1]["label"], "D");
        // `default` flows from `ProviderModel::basic` as false, still emitted.
        assert_eq!(v["models"][1]["default"], false);
    }

    #[test]
    fn parse_cloudflare_models_keeps_only_text_generation() {
        let body = serde_json::json!({
            "success": true,
            "result": [
                { "name": "@cf/meta/llama-3.3-70b-instruct-fp8-fast", "task": { "name": "Text Generation" } },
                { "name": "@cf/baai/bge-base-en-v1.5", "task": { "name": "Text Embeddings" } },
                { "name": "@cf/openai/gpt-oss-120b", "task": { "name": "Text Generation" } },
                { "name": "@cf/black-forest-labs/flux-1-schnell", "task": { "name": "Text-to-Image" } },
            ],
        });
        let out = parse_cloudflare_models(&body);
        let ids: Vec<&str> = out.iter().map(|m| m.id.as_str()).collect();
        assert!(ids.contains(&"@cf/meta/llama-3.3-70b-instruct-fp8-fast"));
        assert!(ids.contains(&"@cf/openai/gpt-oss-120b"));
        // Non-text tasks (embeddings, image) are filtered out.
        assert_eq!(out.len(), 2);
        // Label is the id's last path segment.
        let m = out.iter().find(|m| m.id.ends_with("gpt-oss-120b")).unwrap();
        assert_eq!(m.label, "gpt-oss-120b");
        assert!(m.ctx.is_none());
    }

    #[test]
    fn catalog_payload_includes_capability() {
        let payload = super::catalog_with_capabilities();
        let claude = payload.iter().find(|p| p["id"] == "claude-code").unwrap();
        assert_eq!(claude["permission"]["kind"], "modes");
        assert_eq!(claude["timing"]["permission"], "spawn");
        let codex = payload.iter().find(|p| p["id"] == "codex-cli").unwrap();
        assert_eq!(codex["permission"]["kind"], "approval_sandbox");
        let oc = payload.iter().find(|p| p["id"] == "opencode").unwrap();
        assert_eq!(oc["tool_matrix"]["supports_glob"], true);
        assert_eq!(oc["timing"]["effort"], "live");
        let px = payload.iter().find(|p| p["id"] == "perplexity").unwrap();
        assert_eq!(px["permission"]["kind"], "none");
    }
}
