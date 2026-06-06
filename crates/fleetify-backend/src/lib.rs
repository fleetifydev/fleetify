//! Embedded Fleetify backend (FastAPI 1:1). `serve()` builds config + the
//! sqlx pool + JWKS auth + the SessionManager, runs the lifespan stale-reset,
//! then binds an axum server on a background tokio task; the Tauri shell
//! calls it from its setup hook.

mod http;

pub mod agentic;
pub mod auth;
pub mod bridges;
pub mod config;
pub mod db;
pub mod models;
pub mod providers;
pub mod routers;
pub mod services;
pub mod session_manager;
#[cfg(test)]
pub mod test_support;

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use tokio::net::TcpListener;
use tokio::sync::oneshot;

pub use http::app;

pub struct ServerHandle {
    local_addr: SocketAddr,
    shutdown_tx: Option<oneshot::Sender<()>>,
}

impl ServerHandle {
    pub fn local_addr(&self) -> SocketAddr {
        self.local_addr
    }
    /// Trigger graceful shutdown (mirrors FastAPI lifespan teardown).
    pub fn shutdown(mut self) {
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(());
        }
    }
}

/// Lifespan parity with `_reset_stale_session_state`: error sessions →
/// idle + cleared resume id; transient states → idle (no bridge alive at boot).
async fn reset_stale_session_state(pool: &sqlx::SqlitePool) {
    let _ = sqlx::query(
        "UPDATE sessions SET claude_session_id = NULL, status = 'idle' WHERE status = 'error'",
    )
    .execute(pool)
    .await;
    let _ = sqlx::query(
        "UPDATE sessions SET status = 'idle' \
         WHERE status IN ('running','compacting','starting','waiting')",
    )
    .execute(pool)
    .await;
}

/// One-shot back-fix for Windows `\\?\`-prefixed `project_path` rows
/// stored before fleet-core's `strip_verbatim_prefix` landed at the
/// `canonicalize` sites. Without this, gemini-cli's ACP rejects the
/// session/new with `-32603 EISDIR` because lstat treats `\\?\C:\…`
/// as a path with `C:` as its leaf component. No-op on non-Windows
/// targets and on pools that don't have any verbatim-prefixed rows.
async fn normalize_legacy_verbatim_project_paths(pool: &sqlx::SqlitePool) {
    #[cfg(windows)]
    {
        let rows: Vec<(String, String)> = sqlx::query_as(
            "SELECT id, project_path FROM sessions WHERE project_path LIKE '\\\\?\\%'",
        )
        .fetch_all(pool)
        .await
        .unwrap_or_default();
        for (id, raw) in rows {
            let stripped = fleetify_core::strip_verbatim_prefix(std::path::Path::new(&raw))
                .to_string_lossy()
                .into_owned();
            if stripped != raw {
                tracing::info!(
                    target: "fleet-backend",
                    session_id = %id,
                    from = %raw,
                    to = %stripped,
                    "normalizing legacy verbatim project_path"
                );
                let _ = sqlx::query("UPDATE sessions SET project_path = ? WHERE id = ?")
                    .bind(&stripped)
                    .bind(&id)
                    .execute(pool)
                    .await;
            }
        }
    }
    #[cfg(not(windows))]
    {
        let _ = pool;
    }
}

/// Bind `addr` and start serving on a background task. `static_dir` is the
/// built React asset directory for single-origin serving (`None` = API only).
///
/// Convenience wrapper around `serve_with_routing_setup` for callers that
/// don't have hydrated router credentials (tests, headless dev runs).
/// External routers stay un-registered — only builtin + DirectGateway are
/// available, and the master toggle defaults to OFF.
pub async fn serve(addr: SocketAddr, static_dir: Option<PathBuf>) -> anyhow::Result<ServerHandle> {
    serve_with_routing_setup(
        addr,
        static_dir,
        services::routing::setup::RoutingSetup::default(),
    )
    .await
}

/// Whether this instance should isolate its sessions DB under FLEETIFY_HOME:
/// true for worktree instances (FLEETIFY_HOME explicitly set) and no-auth dev
/// runs (`FLEETIFY_NOAUTH=1`, debug-only). Keeps the NOAUTH "John Doe" stub
/// fleet out of the real-auth prod DB.
fn db_should_isolate() -> bool {
    std::env::var("FLEETIFY_HOME")
        .map(|v| !v.is_empty())
        .unwrap_or(false)
        || auth::is_no_auth()
}

/// Resolve the file-backed sessions DB path. Delegates the policy to
/// [`resolve_db_path_in`] so it's unit-testable without touching the process
/// environment.
fn resolve_db_path(configured: &str) -> PathBuf {
    resolve_db_path_in(
        configured,
        fleetify_core::fleetify_home(),
        db_should_isolate(),
    )
}

/// Pure resolution: an absolute configured path is used verbatim; a relative
/// one is placed under `home` when `isolate`, else kept relative (prod's
/// historical CWD-relative layout).
fn resolve_db_path_in(configured: &str, home: PathBuf, isolate: bool) -> PathBuf {
    let p = std::path::Path::new(configured);
    if p.is_absolute() {
        p.to_path_buf()
    } else if isolate {
        home.join(p)
    } else {
        p.to_path_buf()
    }
}

/// Bind `addr` and start serving, hydrating the routing orchestrator with
/// the supplied `routing_setup`. The Tauri shell composes the setup from
/// `fleet.config.json` + the per-user keychain before invoking this so
/// the backend stays Tauri-agnostic.
pub async fn serve_with_routing_setup(
    addr: SocketAddr,
    static_dir: Option<PathBuf>,
    routing_setup: services::routing::setup::RoutingSetup,
) -> anyhow::Result<ServerHandle> {
    // Load `.env` from the workspace root (if present) into the process
    // environment. Existing env vars are NOT overridden — a real shell-set
    // value wins over the file. No-op when `.env` is absent, which is the
    // production case. Powers single-source dev config for POSTHOG_API_KEY
    // and similar without forcing a wrapper shell script.
    let _ = dotenvy::dotenv();

    // Lifespan parity: one-shot ~/.fleet → ~/.fleetify migration.
    services::migration::migrate_fleet_to_fleetify();

    let cfg = config::AppConfig::load(None)?;
    // Sessions DB. Tests pin FLEET_DB_URL=sqlite::memory:. Otherwise resolve a
    // file path: a relative path is placed under FLEETIFY_HOME for worktree /
    // no-auth dev instances so they DON'T share the prod DB. Sharing previously
    // mixed the real user's fleet with the NOAUTH "John Doe" stub user, which
    // broke cross-session dispatch — a dispatch target owned by one identity is
    // invisible to a caller scoped to the other. Prod (no FLEETIFY_HOME, real
    // auth) keeps the historical CWD-relative path untouched.
    let pool = match std::env::var("FLEET_DB_URL") {
        Ok(url) => db::init_pool(&url).await?,
        Err(_) => db::init_pool_at(&resolve_db_path(&cfg.database.path)).await?,
    };
    reset_stale_session_state(&pool).await;
    normalize_legacy_verbatim_project_paths(&pool).await;
    // One-shot rewrite of `sessions.model_name` rows whose pinned id was
    // dropped from the provider catalog by Tasks 7+8. Idempotent — once
    // every row points at a live id this becomes a no-op. Runs before
    // the HTTP server binds so the first chat turn after boot can't race
    // against an un-migrated row.
    services::session_migrations::migrate_orphaned_model_names(&pool).await;

    let auth_cfg = Arc::new(auth::AuthConfig::from_env());
    let jwks = auth::default_jwks_cache(&auth_cfg.jwks_url);
    // One-shot loopback secret for the internal dispatch endpoint.
    // 32 random bytes, hex-encoded — small enough to fit in an env
    // var and large enough to make brute-force probing pointless.
    // Stored in process memory only; child MCPs receive it through
    // the env passthrough in ClaudeBridge::build_mcp_config.
    let internal_secret = {
        use rand::RngCore;
        let mut bytes = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut bytes);
        let mut s = String::with_capacity(64);
        for b in bytes {
            use std::fmt::Write;
            let _ = write!(&mut s, "{b:02x}");
        }
        Arc::new(s)
    };
    // Routing orchestrator: BuiltInRouter (capability-matrix backed) +
    // DirectGateway are the always-present defaults. External routers
    // (Not Diamond, Weave, LiteLLM) are hydrated below from `routing_setup`
    // — the Tauri shell composed it from fleet.config.json + the per-user
    // keychain before calling us. Master toggle reflects the user's saved
    // choice (default OFF for fresh installs).
    let routing = {
        use parking_lot::RwLock;
        use services::routing::capability_matrix::CapabilityMatrix;
        use services::routing::decision::builtin::BuiltInRouter;
        use services::routing::decision::registry::DecisionRouterRegistry;
        use services::routing::proxy::direct::DirectGateway;
        use services::routing::proxy::registry::ProxyGatewayRegistry;
        use services::routing::traits::{DecisionRouter, ProxyGateway};
        use services::routing::RoutingOrchestrator;

        // Capability matrix is best-effort: a missing or malformed
        // config/agents.toml shouldn't kill the backend. The built-in
        // router degrades to "no candidates" (still returns a defensive
        // fallback decision) when its matrix is empty.
        let matrix = CapabilityMatrix::load_default().unwrap_or_else(|e| {
            tracing::warn!(
                target: "fleet-backend",
                error = %e,
                "routing: capability matrix load failed; using empty matrix"
            );
            CapabilityMatrix {
                agents: Default::default(),
            }
        });
        let builtin: Arc<dyn DecisionRouter> = Arc::new(BuiltInRouter::new(matrix));
        let dr = Arc::new(RwLock::new(DecisionRouterRegistry::new(builtin)));
        let direct: Arc<dyn ProxyGateway> = Arc::new(DirectGateway);
        let pr = Arc::new(RwLock::new(ProxyGatewayRegistry::new(direct)));
        let orch = Arc::new(RoutingOrchestrator::new(dr, pr, false));

        // Hydrate external routers from the supplied setup. Walk the
        // resolved-credentials map, register the right router type per
        // known id, then apply the saved active selections + master
        // toggle. Unknown ids are logged + skipped so a stale config
        // entry can't brick the backend.
        {
            use services::routing::decision::notdiamond::NotDiamondRouter;
            use services::routing::decision::weave::{WeaveDecisionRouter, DEFAULT_MANAGED_URL};
            use services::routing::proxy::litellm::LiteLLMGateway;
            use services::routing::proxy::weave::WeaveProxyGateway;

            for (id, cred) in routing_setup.resolved.iter() {
                match id.as_str() {
                    "notdiamond" => {
                        let r = NotDiamondRouter::new(cred.api_key.clone());
                        orch.register_decision(Arc::new(r));
                    }
                    "weave" => {
                        let base = cred
                            .base_url
                            .clone()
                            .unwrap_or_else(|| DEFAULT_MANAGED_URL.to_string());
                        let dec =
                            WeaveDecisionRouter::with_base_url(cred.api_key.clone(), base.clone());
                        let prx = WeaveProxyGateway::new(cred.api_key.clone(), base);
                        orch.register_decision(Arc::new(dec));
                        orch.register_proxy(Arc::new(prx));
                    }
                    "litellm" => {
                        let base = cred
                            .base_url
                            .clone()
                            .unwrap_or_else(|| "http://localhost:4000".to_string());
                        let prx = LiteLLMGateway::new(cred.api_key.clone(), base);
                        orch.register_proxy(Arc::new(prx));
                    }
                    other => {
                        tracing::warn!(
                            target: "fleet-backend",
                            router_id = %other,
                            "routing: unknown router id in setup; skipping"
                        );
                    }
                }
            }

            // Apply saved active selections — log+ignore failures so a
            // disconnected router that's still pinned in config falls
            // back to builtin / none-proxy via the registry's `active()`
            // accessor (which defensively returns the immortal default
            // when the saved active id is unregistered).
            if !routing_setup.active_decision_router.is_empty()
                && routing_setup.active_decision_router != "builtin"
            {
                if let Err(e) = orch.set_active_decision(&routing_setup.active_decision_router) {
                    tracing::warn!(
                        target: "fleet-backend",
                        router_id = %routing_setup.active_decision_router,
                        error = %e,
                        "routing: saved active decision router not registered; using builtin"
                    );
                }
            }
            if !routing_setup.active_proxy_gateway.is_empty()
                && routing_setup.active_proxy_gateway != "none-proxy"
            {
                if let Err(e) = orch.set_active_proxy(&routing_setup.active_proxy_gateway) {
                    tracing::warn!(
                        target: "fleet-backend",
                        gateway_id = %routing_setup.active_proxy_gateway,
                        error = %e,
                        "routing: saved active proxy gateway not registered; using none-proxy"
                    );
                }
            }

            orch.set_enabled(routing_setup.enabled);
            tracing::info!(
                target: "fleet-backend",
                enabled = routing_setup.enabled,
                resolved = routing_setup.resolved.len(),
                active_decision = %routing_setup.active_decision_router,
                active_proxy = %routing_setup.active_proxy_gateway,
                "routing: orchestrator hydrated"
            );
        }

        orch
    };

    let state = routers::AppState {
        auth: auth::AuthState {
            pool,
            cfg: auth_cfg,
            jwks,
        },
        app_cfg: Arc::new(cfg),
        sm: session_manager::session_manager(),
        internal_secret: internal_secret.clone(),
        routing,
        permission_registry: Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new())),
        ask_registry: Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new())),
        agent_scan_cache: routers::providers::AgentScanCache::default(),
        http_health_cache: routers::providers::HttpHealthCache::default(),
    };
    // Surface the secret + backend URL through env so MCP processes
    // spawned later (by ClaudeBridge::build_mcp_config) can read them
    // without us having to plumb AppState all the way down.
    std::env::set_var("FLEETIFY_INTERNAL_SECRET", internal_secret.as_str());

    let listener = TcpListener::bind(addr).await?;
    let local_addr = listener.local_addr()?;
    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();

    let agent_scan_cache = state.agent_scan_cache.clone();
    let router = app(state, static_dir);
    tokio::spawn(async move {
        let server = axum::serve(listener, router).with_graceful_shutdown(async {
            let _ = shutdown_rx.await;
        });
        if let Err(e) = server.await {
            tracing::error!("fleet-backend server error: {e}");
        }
    });

    // Warm the CLI agent scan cache so Settings → Agents renders
    // instantly on first open. Best-effort: any failure logs and the
    // first scan endpoint call falls back to a live scan.
    tokio::spawn(async move {
        let snapshot = routers::providers::scan_all_agents().await;
        agent_scan_cache.set(snapshot).await;
        tracing::debug!("agent_scan_cache: warmed at startup");
        // Pre-warm Hermes' multi-provider model catalog so the model picker
        // shows real providers + models on first open instead of flashing the
        // static "Hermes (configured model)" placeholder while discovery runs.
        routers::providers::prewarm_hermes_models().await;
    });

    // Warm MCP server statuses at boot so Settings → Tools & MCPs and the
    // composer show real connection state on first open instead of "Unknown"
    // until the user clicks Test connection. Best-effort: a failed probe just
    // caches a failed/auth_needed status the UI surfaces honestly.
    tokio::spawn(async {
        crate::services::mcp_status::warm_all().await;
        tracing::debug!("mcp_status_cache: warmed at startup");
    });

    // Telemetry pipeline — outbox init + heartbeat loop. Best-effort:
    // a failed outbox init logs and continues so a busted home dir
    // doesn't kill the backend; emit_* sites will see "telemetry outbox
    // not initialised" and skip enqueue gracefully.
    //
    // FLEETIFY_NOAUTH=1 skips the heartbeat loop entirely — emit_* is
    // also short-circuited so the outbox stays empty.
    if crate::auth::is_no_auth() {
        tracing::info!("telemetry: disabled (FLEETIFY_NOAUTH=1)");
    } else if let Err(e) = services::telemetry::outbox::init().await {
        tracing::warn!("telemetry: outbox init failed: {e} (telemetry disabled)");
    } else {
        tokio::spawn(services::telemetry::run_heartbeat_loop());
        // PostHog sink: independent from the Fleetify cloud outbox.
        // No-op if POSTHOG_API_KEY was unset at build time. The runtime
        // gate (telemetry.posthog_enabled in fleet.config.json) is
        // controlled by the Tauri shell via the
        // `telemetry_set_posthog_enabled` command and starts closed.
        if let Err(e) = services::telemetry::posthog::init().await {
            tracing::warn!("telemetry: posthog init failed: {e} (posthog sink disabled)");
        }
        // Backend lifecycle bookend. Fires AFTER posthog::init so the
        // worker is live to pick it up. No-op when the runtime gate
        // is closed — but if the user has opted in (set via the Tauri
        // shell after this returns), it becomes the very first event
        // of the session.
        let version = env!("CARGO_PKG_VERSION");
        let platform = if cfg!(target_os = "macos") {
            "darwin"
        } else if cfg!(windows) {
            "win32"
        } else if cfg!(target_os = "linux") {
            "linux"
        } else {
            "unknown"
        };
        services::telemetry::emitters::emit_app_started(version, platform).await;
    }

    // Fleet built-in MCP servers (fleet_memory / fleet_dispatch /
    // fleet_reveng) are NOT seeded into ~/.fleetify/mcp_servers.json.
    // ClaudeBridge::builtin_mcp_config splices them into the per-spawn
    // --mcp-config JSON instead, so the user-facing /api/mcp/servers
    // list shows ONLY the MCPs the user explicitly added — matching
    // the Python sdk_bridge.py behaviour where builtins live in-process
    // and never appear in the persisted registry. One-shot migration
    // strips stale `builtin: true` rows from registries written by
    // older builds so upgrades don't leave the user with phantom MCPs
    // they can't delete from the UI.
    if std::env::var("FLEET_DB_URL")
        .ok()
        .as_deref()
        .unwrap_or("")
        .ne("sqlite::memory:")
    {
        services::mcp_registry::purge_legacy_builtin_seeds();
    }

    tracing::info!("fleetify-backend listening on http://{local_addr}");
    Ok(ServerHandle {
        local_addr,
        shutdown_tx: Some(shutdown_tx),
    })
}

#[cfg(test)]
mod db_path_tests {
    use super::resolve_db_path_in;
    use std::path::PathBuf;

    #[test]
    fn relative_path_isolated_under_home() {
        let got = resolve_db_path_in("fleet.db", PathBuf::from("/home/.fleetify-wt-07"), true);
        assert_eq!(got, PathBuf::from("/home/.fleetify-wt-07").join("fleet.db"));
    }

    #[test]
    fn relative_path_kept_relative_when_not_isolated() {
        // Prod: no FLEETIFY_HOME / no NOAUTH -> historical CWD-relative path.
        assert_eq!(
            resolve_db_path_in("fleet.db", PathBuf::from("/home/.fleetify"), false),
            PathBuf::from("fleet.db")
        );
    }

    #[test]
    fn absolute_path_used_verbatim_regardless_of_isolation() {
        let abs = if cfg!(windows) {
            r"C:\data\fleet.db"
        } else {
            "/data/fleet.db"
        };
        assert_eq!(
            resolve_db_path_in(abs, PathBuf::from("/home/.fleetify"), true),
            PathBuf::from(abs)
        );
        assert_eq!(
            resolve_db_path_in(abs, PathBuf::from("/home/.fleetify"), false),
            PathBuf::from(abs)
        );
    }
}
