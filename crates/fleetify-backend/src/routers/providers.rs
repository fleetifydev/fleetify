//! Faithful port of `app/routers/providers.py` — model catalog and
//! provider/CLI scan (claude/gemini/codex CLI presence + auth indicators,
//! ollama HTTP probe, env-key inventory).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use axum::extract::{Path, Query, State};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::process::Command;
use tokio::sync::RwLock;

use crate::providers::catalog::ExpiryUnit;
use crate::routers::AppState;

/// In-memory cache of the most recent CLI agent scan. Backend warms it
/// at startup, the endpoint reads it on every poll, install/refresh
/// flows invalidate it.
#[derive(Clone, Default)]
pub struct AgentScanCache {
    inner: Arc<RwLock<Option<HashMap<String, Value>>>>,
}

impl AgentScanCache {
    pub async fn get(&self) -> Option<HashMap<String, Value>> {
        self.inner.read().await.clone()
    }

    pub async fn set(&self, snapshot: HashMap<String, Value>) {
        *self.inner.write().await = Some(snapshot);
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
        .route("/providers/cloudflare/verify", post(cloudflare_verify))
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
    // baked-lineup agent with no probe (claude/codex/gemini/kimi/agy). Fall
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
        "cursor" => (
            crate::bridges::cursor::list_models(cwd)
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
        "hermes" => {
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
    let (models, current) = discover_agent_models("hermes", "").await;
    if !models.is_empty() {
        let n = models.len();
        agent_models_cache()
            .write()
            .await
            .insert("hermes".to_string(), (Instant::now(), models, current));
        tracing::debug!(target: "hermes.discover", "prewarmed {n} hermes models at startup");
    }
}

/// CLI agents whose model lineup comes from a live local probe (the match arms
/// in [`discover_agent_models`]) rather than the remote catalog. Excluded from
/// the remote-catalog prewarm — there is nothing on fleetify.dev/api to warm for
/// them (`hermes` is prewarmed separately via [`prewarm_hermes_models`]).
const LIVE_PROBE_AGENTS: &[&str] = &["opencode", "cursor", "github-copilot", "hermes"];

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
    let bin = cli_path("opencode")
        .await
        .unwrap_or_else(|| "opencode".to_string());
    // npm ships a `.cmd`/`.ps1` shim on Windows; `cmd /C` runs it (CreateProcess
    // can't exec a `.cmd` directly).
    let lower = bin.to_ascii_lowercase();
    let mut cmd = if cfg!(windows) && (lower.ends_with(".cmd") || lower.ends_with(".bat")) {
        let mut c = Command::new("cmd");
        c.arg("/C").arg(&bin).arg("models");
        c
    } else {
        let mut c = Command::new(&bin);
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

#[derive(Clone)]
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

fn provider_models_json(id: &str, models: &ProviderModelList) -> Value {
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
    Value::Object(o)
}

async fn discover_provider_models(id: &str) -> ProviderModelList {
    // 1. Provider with a live `/models` endpoint we proxy directly.
    let live = match id {
        "openrouter" => discover_openrouter_models().await,
        "cloudflare-workers-ai" => discover_cloudflare_models().await,
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
    let models = fetch_remote_catalog_uncached(id).await;
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
    // 1. Serving API: `…/providers/{id}/models`.
    let api_url = format!(
        "{}/providers/{}/models",
        models_api_base().trim_end_matches('/'),
        id
    );
    if let Some(models) = try_fetch_catalog(&client, &api_url).await {
        return models;
    }
    // 2. jsDelivr origin: the catalog's built per-provider file. Lets the app
    //    consume the catalog before the serving API is deployed.
    let cdn_url = format!(
        "https://cdn.jsdelivr.net/gh/fleetifydev/models@{}/dist/providers/{}.json",
        models_cdn_tag(),
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
    let mut req = client.get("https://openrouter.ai/api/v1/models");
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

/// Per-provider scan strategy. `scan_all_agents` picks one based on
/// provider id; the default is `BinOnly` which preserves the
/// pre-refactor behaviour of `cli_path(spec.bin)`.
#[derive(Debug, Clone)]
enum ScanProbe {
    /// Just check the binary on PATH (and Windows PATHEXT shims).
    BinOnly { bin: &'static str },
    /// agy CLI: PATH lookup OR `~/.gemini/antigravity-cli/installation_id`
    /// marker. Shell installer updates PATH on next login only, so the
    /// marker rescues the "I just installed it" UX without a restart.
    AgyCli,
    /// Resolve any usable Python, then run `python -c "import <module>"`
    /// against it. Both must succeed for `installed` to be true.
    PythonModule { module: &'static str },
    /// Cursor CLI: PATH lookup (`cursor-agent`/`agent`) OR the off-PATH
    /// install location the installer writes to without updating PATH
    /// (`%LOCALAPPDATA%\cursor-agent\cursor-agent.cmd` on Windows;
    /// `~/.local/bin/{cursor-agent,agent}` on Unix). Shares the bridge's
    /// `resolve_cursor_bin` so detection and spawn agree.
    CursorCli,
    /// GitHub Copilot CLI: PATH lookup OR the off-PATH npm-global / Homebrew /
    /// winget install dirs a GUI process's minimal PATH frequently misses.
    /// Shares the bridge's `resolve_copilot_bin` so detection and spawn agree.
    GitHubCopilotCli,
    /// Hermes CLI: PATH lookup OR the off-PATH install dirs the Python
    /// installers write to without updating a GUI's PATH. Shares the bridge's
    /// `resolve_hermes_bin` so detection and spawn agree.
    HermesCli,
}

/// Map a catalog id to the probe strategy used by `scan_all_agents`.
/// New providers default to `BinOnly { bin }`. Special cases live
/// here so the catalog's `ProviderSpec` stays declarative.
fn scan_probe_for(id: &'static str, bin: &'static str) -> ScanProbe {
    match id {
        "agy" => ScanProbe::AgyCli,
        "antigravity-sdk" => ScanProbe::PythonModule {
            module: "google.antigravity",
        },
        "cursor" => ScanProbe::CursorCli,
        "github-copilot" => ScanProbe::GitHubCopilotCli,
        "hermes" => ScanProbe::HermesCli,
        _ => ScanProbe::BinOnly { bin },
    }
}

/// Shared scanner used by both the HTTP endpoint and the startup
/// warm-up. Returns a JSON-serializable map keyed by provider id.
pub async fn scan_all_agents() -> HashMap<String, Value> {
    let mut out = HashMap::new();
    for spec in crate::providers::list_cli_agents() {
        let probe = scan_probe_for(spec.id, spec.bin);
        let path = match &probe {
            ScanProbe::BinOnly { bin } => cli_path(bin).await,
            ScanProbe::AgyCli => {
                if let Some(p) = cli_path("agy").await {
                    Some(p)
                } else if agy_installed_via_marker(&home()) {
                    Some("<installer marker>".to_string())
                } else {
                    None
                }
            }
            ScanProbe::PythonModule { module } => {
                let probe = python_module_installed(module).await;
                if probe.installed {
                    probe.path
                } else {
                    None
                }
            }
            ScanProbe::CursorCli => crate::bridges::cursor::resolve_cursor_bin(),
            ScanProbe::HermesCli => crate::bridges::hermes::resolve_hermes_bin(),
            ScanProbe::GitHubCopilotCli => crate::bridges::github_copilot::resolve_copilot_bin(),
        };
        let installed = path.is_some();
        let authenticated = installed && indicators_authenticated(&home(), spec.auth_indicators);
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
                "install_hint": resolve_install_hint(spec),
                "login_hint": spec.login_hint,
            }),
        );
    }
    out
}

/// Cache-aware CLI agent scan handler. Reads from the shared cache on
/// every poll; `?refresh=1` invalidates first so install / manual flows
/// can force a re-scan. Drives Settings → Agents tiles + the New Agent
/// dialog detection chips.
async fn scan_agents_cached(
    State(state): State<AppState>,
    Query(q): Query<ScanQuery>,
) -> Json<Value> {
    let force = matches!(q.refresh, Some(n) if n != 0);
    if force {
        state.agent_scan_cache.invalidate().await;
    }
    if let Some(snapshot) = state.agent_scan_cache.get().await {
        return Json(Value::Object(snapshot.into_iter().collect()));
    }
    let fresh = scan_all_agents().await;
    state.agent_scan_cache.set(fresh.clone()).await;
    Json(Value::Object(fresh.into_iter().collect()))
}

fn home() -> PathBuf {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."))
}

/// Read-only probe: does the agy installation_id marker exist under `home`?
/// Caller passes `home()` from a real scan or a tempdir from tests.
fn agy_installed_via_marker(home: &std::path::Path) -> bool {
    home.join(".gemini")
        .join("antigravity-cli")
        .join("installation_id")
        .exists()
}

/// True iff `path` is a readable JSON file containing `field` as a
/// number whose value (interpreted as `unit` since the Unix epoch)
/// is strictly greater than the current wall-clock time. All other
/// outcomes (missing file, invalid JSON, missing field, non-numeric
/// value, time-in-the-past, system clock unset) evaluate to false.
///
/// Used by `AuthIndicator::JsonExpiry` to detect expired OAuth
/// tokens without spawning the provider's CLI.
pub(crate) fn check_json_expiry(path: &std::path::Path, field: &str, unit: ExpiryUnit) -> bool {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return false;
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return false;
    };
    let Some(n) = value.get(field).and_then(|v| v.as_i64()) else {
        return false;
    };
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let expiry_ms = match unit {
        ExpiryUnit::Millis => n,
        ExpiryUnit::Seconds => n.saturating_mul(1000),
    };
    expiry_ms > now_ms
}

/// Evaluate a CLI agent's auth indicators against an arbitrary home base.
/// Shared by the Settings → Agents scan (real HOME) and the per-account
/// detector (`services::accounts`), which points `home` at an isolated
/// account dir. Any single indicator firing ⇒ authenticated.
pub(crate) fn indicators_authenticated(
    home: &std::path::Path,
    inds: &[crate::providers::AuthIndicator],
) -> bool {
    use crate::providers::AuthIndicator;
    inds.iter().any(|ind| match ind {
        AuthIndicator::HomeDir { path } => home.join(path).exists(),
        AuthIndicator::EnvVar { name } => std::env::var(name).is_ok(),
        AuthIndicator::JsonExpiry { path, field, unit } => {
            check_json_expiry(&home.join(path), field, *unit)
        }
        AuthIndicator::JsonFieldPresent { path, field } => std::fs::read_to_string(home.join(path))
            .ok()
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            .and_then(|v| v.get(*field).cloned())
            .is_some_and(|f| !f.is_null()),
    })
}

/// Shape of the python_module_installed probe result.
pub struct PythonProbe {
    pub installed: bool,
    pub path: Option<String>,
}

/// Resolve the first Python interpreter on PATH that actually executes
/// successfully (exit-success on `--version`). This filters out the
/// Microsoft Store stub on Windows (`python3.exe` / `python.exe` in
/// `%LOCALAPPDATA%\Microsoft\WindowsApps\`) which is on PATH and passes
/// `which::which` but exits non-zero when run without the Store package
/// installed behind it.
async fn working_python_path() -> Option<String> {
    for name in &["python3", "python", "py"] {
        // Resolve via `which` first so we get the absolute path and
        // honour PATHEXT shims. If `which` fails, try a bare spawn.
        let candidate: Option<String> = if let Ok(p) = which::which(name) {
            Some(p.to_string_lossy().into_owned())
        } else {
            None
        };
        let Some(path) = candidate else { continue };
        // Verify the candidate actually runs — the Store stub on Windows
        // passes `which` but exits 9009 when there is no real interpreter.
        let ok = tokio::process::Command::new(&path)
            .arg("--version")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .await
            .map(|s| s.success())
            .unwrap_or(false);
        if ok {
            return Some(path);
        }
    }
    None
}

/// Probe whether `module` is importable under the first Python we can
/// resolve. Honours FLEETIFY_EMBEDDED_PYTHON for forward-compat with a
/// bundled interpreter. 5-second timeout — startup + stdlib import is
/// sub-second on real machines.
pub async fn python_module_installed(module: &str) -> PythonProbe {
    let python_path: Option<String> = match std::env::var("FLEETIFY_EMBEDDED_PYTHON") {
        Ok(p) if std::path::Path::new(&p).exists() => Some(p),
        _ => working_python_path().await,
    };
    let Some(py) = python_path else {
        return PythonProbe {
            installed: false,
            path: None,
        };
    };
    let installed = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        tokio::process::Command::new(&py)
            .args(["-c", &format!("import {module}")])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status(),
    )
    .await
    .map(|r| r.map(|s| s.success()).unwrap_or(false))
    .unwrap_or(false);
    PythonProbe {
        installed,
        path: Some(py),
    }
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

async fn check_kimi_cli() -> Value {
    let Some(p) = cli_path("kimi").await else {
        return json!({ "installed": false, "authenticated": false, "path": null });
    };
    let authed = home().join(".kimi/auth.json").exists() || std::env::var("KIMI_API_KEY").is_ok();
    json!({ "installed": true, "authenticated": authed, "path": p })
}

async fn check_agy_cli() -> Value {
    let Some(p) = cli_path("agy").await else {
        return json!({ "installed": false, "authenticated": false, "path": null });
    };
    // Agy nests under `~/.gemini/antigravity-cli/` and writes
    // `installation_id` on first onboarded launch. Fall back to the
    // shared `oauth_creds.json` (also written by Gemini CLI) or a
    // Google API key for headless setups.
    let authed = home()
        .join(".gemini/antigravity-cli/installation_id")
        .exists()
        || home().join(".gemini/oauth_creds.json").exists()
        || std::env::var("GOOGLE_API_KEY").is_ok();
    json!({ "installed": true, "authenticated": authed, "path": p })
}

/// Detect the Antigravity SDK installation. Two parts:
///   1. **Installed**: Python is on PATH AND `google-antigravity` can be
///      imported. We probe by spawning `python -c "import google.antigravity"`
///      with a short timeout — fast when the module is present, returns
///      non-zero when it's not.
///   2. **Authenticated**: a Gemini API key exists in the OS keyring under
///      `Fleetify-Provider-antigravity-sdk` OR the `GEMINI_API_KEY` env var
///      is set. Either one satisfies the auth gate; the bridge prefers
///      the keyring at dispatch time.
async fn check_antigravity_sdk_cli() -> Value {
    // Locate ANY usable Python — `FLEETIFY_EMBEDDED_PYTHON` first
    // (manual override / future lazy-fetch slot), then system PATH.
    // Both common executable names are tried; Windows usually resolves
    // "python", macOS/Linux "python3". `cli_path` reuses
    // `which::which` so it honours PATHEXT for .cmd shims on Windows.
    let python_path: Option<String> = match std::env::var("FLEETIFY_EMBEDDED_PYTHON") {
        Ok(p) if std::path::Path::new(&p).exists() => Some(p),
        _ => match cli_path("python3").await {
            Some(p) => Some(p),
            None => cli_path("python").await,
        },
    };

    let Some(py) = python_path else {
        return json!({ "installed": false, "authenticated": false, "path": null });
    };

    // Module-import probe. 5s is generous — a fresh interpreter startup
    // + import of google.antigravity is sub-second on every machine
    // I've tested. If it spins longer than this, something is wrong
    // (broken venv, Python repair pending) and we'd rather surface
    // "Not installed" than block the Settings → Agents tile.
    let installed_pkg = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        tokio::process::Command::new(&py)
            .args(["-c", "import google.antigravity"])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status(),
    )
    .await
    .map(|r| r.map(|s| s.success()).unwrap_or(false))
    .unwrap_or(false);

    if !installed_pkg {
        // Python exists but the SDK package isn't installed. Surface
        // installed=false so the Settings card shows the "pip install"
        // button rather than masquerading as ready-to-use.
        return json!({ "installed": false, "authenticated": false, "path": py });
    }

    // Keyring presence check. Mirrors how the bridge reads its key.
    let key_in_keyring = keyring::Entry::new("Fleetify-Provider-antigravity-sdk", "default")
        .ok()
        .and_then(|e| e.get_password().ok())
        .map(|s| !s.is_empty())
        .unwrap_or(false);
    let authed = key_in_keyring
        || std::env::var("GEMINI_API_KEY")
            .map(|s| !s.is_empty())
            .unwrap_or(false);
    json!({ "installed": true, "authenticated": authed, "path": py })
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

/// Build a `{installed, authenticated, path}` value for a CLI agent the
/// legacy `/providers/scan` shape didn't originally carry (OpenCode, Cursor,
/// GitHub Copilot, Hermes). `path` is resolved by the caller — the
/// shell-installer agents land off a GUI process's PATH, so they come in via
/// their bridge's `resolve_*_bin` rather than a bare lookup. Auth reuses the
/// catalog's `auth_indicators` (via `indicators_authenticated`) so the
/// onboarding probe agrees exactly with the Settings → Agents scan.
fn cli_agent_scan(id: &str, path: Option<String>) -> Value {
    let Some(p) = path else {
        return json!({ "installed": false, "authenticated": false, "path": null });
    };
    let authed = crate::providers::list_cli_agents()
        .into_iter()
        .find(|s| s.id == id)
        .map(|spec| indicators_authenticated(&home(), spec.auth_indicators))
        .unwrap_or(false);
    json!({ "installed": true, "authenticated": authed, "path": p })
}

async fn scan_providers() -> Json<Value> {
    // The legacy scan endpoint doesn't have access to ProvidersConfig
    // (it lives in the Tauri shell's fleet.config.json, not the
    // backend's AppState), so we fall back to the localhost default
    // here. The new `providers_ollama_probe` IPC honours the user's
    // configured URL for the Settings surface.
    let (claude, gemini, codex, kimi, agy, agy_sdk, ollama, opencode_path) = tokio::join!(
        check_claude_cli(),
        check_gemini_cli(),
        check_codex_cli(),
        check_kimi_cli(),
        check_agy_cli(),
        check_antigravity_sdk_cli(),
        check_ollama(None),
        cli_path("opencode"),
    );
    // OpenCode / Cursor / GitHub Copilot / Hermes — previously probe-less in
    // onboarding ("Set up in Settings"). Resolve through the same bridge
    // helpers dispatch + the Settings scan use so off-PATH installs are
    // detected and the Install button's completion poll agrees with reality.
    let opencode = cli_agent_scan("opencode", opencode_path);
    let cursor = cli_agent_scan("cursor", crate::bridges::cursor::resolve_cursor_bin());
    let github_copilot = cli_agent_scan(
        "github-copilot",
        crate::bridges::github_copilot::resolve_copilot_bin(),
    );
    let hermes = cli_agent_scan("hermes", crate::bridges::hermes::resolve_hermes_bin());
    Json(json!({
        "claude_cli": claude,
        "gemini_cli": gemini,
        "codex_cli": codex,
        "kimi_cli": kimi,
        "agy_cli": agy,
        "antigravity_sdk": agy_sdk,
        "opencode_cli": opencode,
        "cursor_cli": cursor,
        "github_copilot_cli": github_copilot,
        "hermes_cli": hermes,
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

#[cfg(test)]
mod tests {
    use super::*;

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

    #[test]
    fn cli_agent_scan_reports_not_installed_without_path() {
        let v = cli_agent_scan("opencode", None);
        assert_eq!(v["installed"], serde_json::json!(false));
        assert_eq!(v["authenticated"], serde_json::json!(false));
        assert!(v["path"].is_null());
    }

    #[test]
    fn cli_agent_scan_marks_installed_with_path() {
        let v = cli_agent_scan("opencode", Some("/usr/bin/opencode".to_string()));
        assert_eq!(v["installed"], serde_json::json!(true));
        assert_eq!(v["path"], serde_json::json!("/usr/bin/opencode"));
        // `authenticated` depends on the host's opencode auth file / env var,
        // so assert the shape (a bool), not a fixed value.
        assert!(v["authenticated"].is_boolean());
    }

    #[test]
    fn remote_catalog_prewarm_set_excludes_live_probe_agents_and_covers_remote_sources() {
        let ids = remote_catalog_prewarm_ids();
        // Live-probe CLI agents resolve their lineup from a local CLI/ACP call
        // (the match arms in `discover_agent_models`), not fleetify.dev/api — so
        // they must NOT be in the remote-catalog prewarm set.
        for a in ["opencode", "cursor", "github-copilot", "hermes"] {
            assert!(
                !ids.contains(&a),
                "{a} is discovered via a live probe and must be excluded from the remote prewarm"
            );
        }
        // Baked CLI agents (no live probe → fall through to fetch_remote_catalog)
        // and the HTTP API providers DO source their lineup from the remote
        // catalog, so they must be prewarmed.
        for p in [
            "claude",
            "codex",
            "gemini",
            "kimi",
            "agy",
            "openai",
            "anthropic",
        ] {
            assert!(
                ids.contains(&p),
                "{p} sources from the remote catalog and must be prewarmed"
            );
        }
    }

    #[tokio::test]
    async fn scan_providers_exposes_new_cli_buckets() {
        let Json(v) = scan_providers().await;
        // The four CLI agents that were probe-less in onboarding now carry a
        // {installed, authenticated} bucket so the picker can show an Install
        // button + completion state instead of "Set up in Settings".
        for key in [
            "opencode_cli",
            "cursor_cli",
            "github_copilot_cli",
            "hermes_cli",
        ] {
            let bucket = v.get(key).unwrap_or_else(|| panic!("missing bucket {key}"));
            assert!(
                bucket.get("installed").is_some_and(|b| b.is_boolean()),
                "{key}.installed must be a bool"
            );
            assert!(
                bucket.get("authenticated").is_some_and(|b| b.is_boolean()),
                "{key}.authenticated must be a bool"
            );
        }
        // Legacy buckets remain intact.
        assert!(v.get("claude_cli").is_some());
        assert!(v.get("ollama").is_some());
        assert!(v.get("env_keys").is_some());
    }

    #[tokio::test]
    async fn scan_probe_for_id_returns_bin_only_for_legacy_clis() {
        let probes: Vec<(&str, ScanProbe)> = crate::providers::list_cli_agents()
            .iter()
            .map(|s| (s.id, scan_probe_for(s.id, s.bin)))
            .collect();
        for (id, probe) in probes {
            match (id, probe) {
                ("claude", ScanProbe::BinOnly { bin }) => assert_eq!(bin, "claude"),
                ("codex", ScanProbe::BinOnly { bin }) => assert_eq!(bin, "codex"),
                ("gemini", ScanProbe::BinOnly { bin }) => assert_eq!(bin, "gemini"),
                ("kimi", ScanProbe::BinOnly { bin }) => assert_eq!(bin, "kimi"),
                ("opencode", ScanProbe::BinOnly { bin }) => assert_eq!(bin, "opencode"),
                ("github-copilot", ScanProbe::GitHubCopilotCli) => {}
                ("agy", ScanProbe::AgyCli) => {}
                ("antigravity-sdk", ScanProbe::PythonModule { module }) => {
                    assert_eq!(module, "google.antigravity");
                }
                ("cursor", ScanProbe::CursorCli) => {}
                ("hermes", ScanProbe::HermesCli) => {}
                (other, _) => panic!("unmapped CLI id in scan_probe_for: {other}"),
            }
        }
    }

    #[tokio::test]
    async fn scan_probe_for_agy_uses_agy_cli_variant() {
        let probe = scan_probe_for("agy", "agy");
        assert!(
            matches!(probe, ScanProbe::AgyCli),
            "agy must use AgyCli probe so installation_id fallback works"
        );
    }

    #[tokio::test]
    async fn scan_probe_for_cursor_uses_cursor_cli_variant() {
        let probe = scan_probe_for("cursor", "cursor-agent");
        assert!(
            matches!(probe, ScanProbe::CursorCli),
            "cursor must use CursorCli probe (binary is off-PATH on Windows)"
        );
    }

    #[tokio::test]
    async fn scan_probe_for_hermes_uses_hermes_cli_variant() {
        let probe = scan_probe_for("hermes", "hermes");
        assert!(
            matches!(probe, ScanProbe::HermesCli),
            "hermes must use HermesCli probe (binary is off-PATH on Windows)"
        );
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
    fn agy_cli_probe_returns_installed_when_installation_id_exists() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let marker = tmp.path().join(".gemini/antigravity-cli/installation_id");
        std::fs::create_dir_all(marker.parent().unwrap()).expect("mkdir");
        std::fs::write(&marker, "fake-id").expect("write marker");
        assert!(
            agy_installed_via_marker(tmp.path()),
            "installation_id present => installed"
        );
    }

    #[test]
    fn agy_cli_probe_returns_false_when_marker_absent() {
        let tmp = tempfile::tempdir().expect("tempdir");
        assert!(
            !agy_installed_via_marker(tmp.path()),
            "no marker => not installed via marker path"
        );
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
            .find(|p| p.id == "claude")
            .unwrap();
        // CLI agents have install_hints: None, so the resolver falls back
        // to the single install_hint string (npm install -g …).
        assert_eq!(resolve_install_hint(p), p.install_hint);
        assert!(p.install_hint.contains("npm"));
    }

    #[tokio::test]
    async fn scan_probe_for_antigravity_sdk_uses_python_module() {
        let probe = scan_probe_for("antigravity-sdk", "python3");
        match probe {
            ScanProbe::PythonModule { module } => assert_eq!(module, "google.antigravity"),
            other => panic!("expected PythonModule probe, got {:?}", other),
        }
    }

    #[tokio::test]
    async fn python_module_probe_returns_installed_for_stdlib_module() {
        let py_works = ["python3", "python", "py"].iter().any(|name| {
            std::process::Command::new(name)
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
        let result = python_module_installed("json").await;
        assert!(
            result.installed,
            "json (stdlib) must import successfully when Python is present"
        );
        assert!(result.path.is_some(), "python path should be reported");
    }

    #[tokio::test]
    async fn python_module_probe_returns_not_installed_for_bogus_module() {
        let py_works = ["python3", "python", "py"].iter().any(|name| {
            std::process::Command::new(name)
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
        let result = python_module_installed("definitely_not_a_real_module_2026").await;
        assert!(!result.installed, "bogus module must not import");
        assert!(
            result.path.is_some(),
            "python is still installed, only the module is missing"
        );
    }

    #[test]
    fn check_json_expiry_missing_file_returns_false() {
        let p = std::env::temp_dir().join("fleet-test-missing.json");
        // Make sure it doesn't exist from a prior run
        std::fs::remove_file(&p).ok();
        assert!(!check_json_expiry(&p, "expiry_date", ExpiryUnit::Millis));
    }

    #[test]
    fn check_json_expiry_invalid_json_returns_false() {
        let p = std::env::temp_dir().join("fleet-test-bad-json.json");
        std::fs::write(&p, "{ not json").unwrap();
        assert!(!check_json_expiry(&p, "expiry_date", ExpiryUnit::Millis));
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn check_json_expiry_missing_field_returns_false() {
        let p = std::env::temp_dir().join("fleet-test-missing-field.json");
        std::fs::write(&p, r#"{"foo": 1}"#).unwrap();
        assert!(!check_json_expiry(&p, "expiry_date", ExpiryUnit::Millis));
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn check_json_expiry_past_value_returns_false() {
        let p = std::env::temp_dir().join("fleet-test-past.json");
        std::fs::write(&p, r#"{"expiry_date": 1000}"#).unwrap();
        assert!(!check_json_expiry(&p, "expiry_date", ExpiryUnit::Millis));
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn check_json_expiry_future_value_returns_true() {
        let p = std::env::temp_dir().join("fleet-test-future.json");
        // Year ~33658 in millis = absurdly future, won't expire during the test
        std::fs::write(&p, r#"{"expiry_date": 1000000000000000}"#).unwrap();
        assert!(check_json_expiry(&p, "expiry_date", ExpiryUnit::Millis));
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn check_json_expiry_unit_seconds_converts_correctly() {
        let p = std::env::temp_dir().join("fleet-test-seconds.json");
        // 1_000_000_000_000 seconds = year ~33658
        std::fs::write(&p, r#"{"expiry_date": 1000000000000}"#).unwrap();
        assert!(check_json_expiry(&p, "expiry_date", ExpiryUnit::Seconds));
        std::fs::remove_file(&p).ok();
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
                "id": "claude", "name": "Claude Code", "kind": "cli",
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
        // Absent optionals are omitted from the wire shape (not null).
        assert!(v["models"][1].get("ctx").is_none());
        assert!(v["models"][1].get("supports_effort").is_none());
        assert!(v["models"][1].get("group").is_none());
        assert!(v["models"][1].get("effort").is_none());
        assert_eq!(v["models"][1]["label"], "D");
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
        let claude = payload.iter().find(|p| p["id"] == "claude").unwrap();
        assert_eq!(claude["permission"]["kind"], "modes");
        assert_eq!(claude["timing"]["permission"], "spawn");
        let codex = payload.iter().find(|p| p["id"] == "codex").unwrap();
        assert_eq!(codex["permission"]["kind"], "approval_sandbox");
        let oc = payload.iter().find(|p| p["id"] == "opencode").unwrap();
        assert_eq!(oc["tool_matrix"]["supports_glob"], true);
        assert_eq!(oc["timing"]["effort"], "live");
        let px = payload.iter().find(|p| p["id"] == "perplexity").unwrap();
        assert_eq!(px["permission"]["kind"], "none");
    }
}
