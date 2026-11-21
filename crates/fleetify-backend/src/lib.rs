//! Embedded Fleetify backend (FastAPI 1:1). `serve()` builds config + the
//! sqlx pool + JWKS auth + the SessionManager, runs the lifespan stale-reset,
//! then binds an axum server on a background tokio task; the Tauri shell
//! calls it from its setup hook.

mod http;
mod log_budget;

pub mod access;
pub mod agentic;
pub mod auth;
pub mod bridges;
pub mod config;
pub mod db;
pub mod models;
pub mod open_external;
pub mod providers;
pub mod routers;
pub mod services;
pub mod session_manager;
pub mod studio;
#[cfg(test)]
pub mod test_support;
pub mod ui;

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use tokio::net::TcpListener;
use tokio::sync::oneshot;

pub use http::{app, HEALTH_PATH};

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
/// `canonicalize` sites. Without this, some ACP agents reject the
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

/// What [`serve`] starts with.
pub struct ServeOptions {
    /// The release UI's files, which the shell embeds in the binary and the
    /// backend serves on its own origin ([`ui`]). `None` serves the API
    /// only: a debug build loads its UI from the Vite dev server.
    pub ui: Option<ui::UiAssets>,
    /// The external routers to hydrate the routing orchestrator with. The
    /// Tauri shell composes it from `fleet.config.json` + the per-user
    /// keychain, so the backend stays Tauri-agnostic.
    pub routing_setup: services::routing::setup::RoutingSetup,
    /// This run's API token. The shell gives the same token to the renderer.
    pub api_token: access::ApiToken,
}

impl ServeOptions {
    /// For callers that don't have hydrated router credentials (tests,
    /// headless dev runs): no UI files, and external routers stay
    /// un-registered — only builtin + DirectGateway are available, and the
    /// master toggle defaults to OFF.
    pub fn api_only(api_token: access::ApiToken) -> Self {
        Self {
            ui: None,
            routing_setup: services::routing::setup::RoutingSetup::default(),
            api_token,
        }
    }
}

/// Resolve the file-backed sessions DB path. Delegates the policy to
/// [`noauth_on_shared_home`] and [`resolve_db_path_in`] so it's unit-testable
/// without touching the process environment.
fn resolve_db_path(configured: &str) -> PathBuf {
    let fleetify_home_var = std::env::var("FLEETIFY_HOME").ok();
    resolve_db_path_in(
        configured,
        &fleetify_core::fleetify_home(),
        noauth_on_shared_home(auth::is_no_auth(), fleetify_home_var.as_deref()),
    )
}

/// Whether a no-auth run (`FLEETIFY_NOAUTH=1`, debug-only) is on the shared
/// home: `FLEETIFY_HOME` is unset or empty, as [`fleetify_core::fleetify_home`]
/// reads it. A `dev:tauri:wt` instance is no-auth by default but sets
/// `FLEETIFY_HOME`, so its home, and the `fleet.db` in it, are its own.
fn noauth_on_shared_home(no_auth: bool, fleetify_home_var: Option<&str>) -> bool {
    no_auth && fleetify_home_var.is_none_or(str::is_empty)
}

/// Pure resolution: an absolute configured path is used verbatim; a relative
/// one goes under `home`, never the working directory. With
/// `noauth_on_shared_home` the file name becomes `<stem>-noauth.<ext>`
/// (`fleet.db` → `fleet-noauth.db`), which keeps the no-auth "John Doe" stub
/// user's sessions out of the signed-in user's DB. Sharing one DB broke
/// cross-session dispatch: a dispatch target owned by one identity is
/// invisible to a caller scoped to the other.
fn resolve_db_path_in(configured: &str, home: &Path, noauth_on_shared_home: bool) -> PathBuf {
    let configured = Path::new(configured);
    if configured.is_absolute() {
        return configured.to_path_buf();
    }
    let path = home.join(configured);
    if !noauth_on_shared_home {
        return path;
    }
    let Some(stem) = path.file_stem() else {
        return path;
    };
    let mut name = stem.to_os_string();
    name.push("-noauth");
    if let Some(ext) = path.extension() {
        name.push(".");
        name.push(ext);
    }
    path.with_file_name(name)
}

/// Whether startup loads a `.env` file into the process environment. Only
/// debug builds do. `dotenvy` searches the working directory and its
/// ancestors, so a release build launched from a terminal inside some
/// project would otherwise pick up that project's `.env`.
pub(crate) fn should_load_dotenv(release_build: bool) -> bool {
    !release_build
}

/// `FLEETIFY_REQUIRE_API_TOKEN=1`: a debug build asks for the API token even
/// when it runs with `FLEETIFY_NOAUTH=1`. A release build never reads the
/// variable; it always asks ([`access::token_required`]).
fn api_token_forced() -> bool {
    cfg!(debug_assertions) && std::env::var("FLEETIFY_REQUIRE_API_TOKEN").as_deref() == Ok("1")
}

/// Bind `addr` and start serving on a background task, with the UI files,
/// external routers and API token in `opts`. The access guard
/// ([`access::guard`]) answers only requests addressed to the port actually
/// bound, and asks API requests for the token unless this is a debug build
/// running with `FLEETIFY_NOAUTH=1` (and without
/// `FLEETIFY_REQUIRE_API_TOKEN=1`). Both are read once, here.
pub async fn serve(addr: SocketAddr, opts: ServeOptions) -> anyhow::Result<ServerHandle> {
    let ServeOptions {
        ui,
        routing_setup,
        api_token,
    } = opts;
    // Debug builds load the first `.env` found walking up from the working
    // directory (the workspace root's under `npm run dev:tauri`) into the
    // process environment. Existing env vars are NOT overridden — a real
    // shell-set value wins over the file. Powers single-source dev config
    // for POSTHOG_API_KEY and similar without forcing a wrapper shell
    // script. Release builds never read `.env`: a project's `.env` in the
    // launch directory must not configure Fleetify.
    if should_load_dotenv(!cfg!(debug_assertions)) {
        let _ = dotenvy::dotenv();
    }

    // Lifespan parity: one-shot ~/.fleet → ~/.fleetify migration.
    services::migration::migrate_fleet_to_fleetify();

    // The built-in config: nothing comes from the working directory, which
    // for an installed app is wherever it was launched from.
    let cfg = config::AppConfig::load(None)?;
    // Sessions DB. Tests pin FLEET_DB_URL=sqlite::memory:. Otherwise a file
    // under the Fleetify home (`~/.fleetify/fleet.db`, or `$FLEETIFY_HOME`),
    // with its own name for a no-auth run on the shared home (see
    // `resolve_db_path_in`).
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

        // Capability matrix is best-effort: the built-in config/agents.toml
        // is pinned by a unit test, but a parse failure still shouldn't kill
        // the backend. The built-in router degrades to "no candidates"
        // (still returns a defensive fallback decision) when its matrix is
        // empty.
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
    // Pin the loopback URL the spawned MCP sidecars (and the in-process
    // fleet_permission MCP-over-HTTP server) resolve, to the port we ACTUALLY
    // bound. Worktree dev runs on a non-default port (e.g. 8862), so the
    // `http://127.0.0.1:8765` fallback in `mcp_dispatch::builtin_mcp_config`
    // pointed ask_user / permission loopbacks at the wrong port. Only set it
    // when the shell hasn't already provided one (CI / prod injection wins).
    if std::env::var("FLEETIFY_BACKEND_URL").is_err() {
        std::env::set_var(
            "FLEETIFY_BACKEND_URL",
            format!("http://127.0.0.1:{}", local_addr.port()),
        );
    }
    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();

    let agent_scan_cache = state.agent_scan_cache.clone();
    // Captured before `state` is moved into `app(..)` so the background-agent
    // poller (spawned below) can reconcile sessions off the same pool / manager.
    let bg_pool = state.auth.pool.clone();
    let bg_sm = state.sm;
    let bg_cfg = state.app_cfg.clone();
    let token_required = access::token_required(
        !cfg!(debug_assertions),
        auth::is_no_auth(),
        api_token_forced(),
    );
    tracing::info!(
        target: "fleet-backend",
        api_token_required = token_required,
        "access policy"
    );
    let policy = access::AccessPolicy {
        port: local_addr.port(),
        token: api_token,
        token_required,
        refusal_log: Default::default(),
    };
    let router = app(state, ui, policy);
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

    // Auto-surface backgrounded Claude Code CLI sessions as Fleetify rows.
    // When a user runs `/background` (`/bg`) in the Claude CLI, the session
    // detaches under Claude's supervisor; `claude agents --json` lists the live
    // roster. This poller reconciles `kind=="background"` entries into the
    // sessions table (origin='claude-bg'), and the renderer's existing ~5 s
    // session poll surfaces them in the Fleet panel — no broadcast needed.
    // Opt out with FLEETIFY_CLAUDE_BG_AUTODETECT=0; tune cadence with
    // FLEETIFY_CLAUDE_BG_POLL_MS (default 5000, floored at 2000).
    if std::env::var("FLEETIFY_CLAUDE_BG_AUTODETECT").as_deref() != Ok("0") {
        tokio::spawn(async move {
            let ms: u64 = std::env::var("FLEETIFY_CLAUDE_BG_POLL_MS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(5000)
                .max(2000);
            let mut tick = tokio::time::interval(std::time::Duration::from_millis(ms));
            loop {
                tick.tick().await;
                match crate::services::claude_agents::reconcile_once(
                    &bg_pool,
                    bg_sm,
                    bg_cfg.as_ref(),
                )
                .await
                {
                    Ok(n) if n > 0 => tracing::debug!("claude bg poller: surfaced {n} session(s)"),
                    Ok(_) => {}
                    Err(e) => tracing::debug!("claude bg poller: reconcile error: {e}"),
                }
            }
        });
    }

    // Warm the remote model catalog (fleetify.dev/api → jsDelivr) at boot so the
    // composer's model picker shows the live, up-to-date lineup on first open
    // instead of the embedded snapshot baseline until the lazy on-open fetch
    // returns. Own task (not chained after the agent scan above) so the network
    // fan-out runs in parallel with the local agent probing. Best-effort +
    // non-blocking: offline self-degrades to the snapshot, never stalls boot.
    tokio::spawn(async {
        routers::providers::prewarm_remote_catalog().await;
        tracing::debug!("remote_catalog_cache: warmed at startup");
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
        // No-op without a project key: POSTHOG_API_KEY from the
        // environment, else the one compiled in at build time
        // (`posthog::project_key`). The runtime gate
        // (telemetry.posthog_enabled in fleet.config.json) is
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
    use super::{noauth_on_shared_home, resolve_db_path_in};
    use std::path::{Path, PathBuf};

    #[test]
    fn no_auth_is_on_the_shared_home_unless_fleetify_home_is_set() {
        // A `dev:tauri:wt` instance is no-auth by default but sets
        // FLEETIFY_HOME, so it keeps `fleet.db` in a home of its own.
        for (no_auth, fleetify_home_var, want) in [
            (true, None, true),
            (true, Some(""), true),
            (true, Some("/x/.fleetify-wt-07"), false),
            (false, None, false),
        ] {
            assert_eq!(
                noauth_on_shared_home(no_auth, fleetify_home_var),
                want,
                "no_auth = {no_auth}, FLEETIFY_HOME = {fleetify_home_var:?}"
            );
        }
    }

    #[test]
    fn relative_path_goes_under_home() {
        let home = Path::new("/h/.fleetify");
        assert_eq!(
            resolve_db_path_in("fleet.db", home, false),
            home.join("fleet.db")
        );
    }

    #[test]
    fn no_auth_on_the_shared_home_gets_its_own_file() {
        let home = Path::new("/h/.fleetify");
        assert_eq!(
            resolve_db_path_in("fleet.db", home, true),
            home.join("fleet-noauth.db")
        );
        // Only the file name changes; without an extension it is `<stem>-noauth`.
        assert_eq!(
            resolve_db_path_in("db/sessions", home, true),
            home.join("db").join("sessions-noauth")
        );
    }

    #[test]
    fn absolute_path_used_verbatim() {
        let abs = if cfg!(windows) {
            r"C:\data\fleet.db"
        } else {
            "/data/fleet.db"
        };
        assert_eq!(
            resolve_db_path_in(abs, Path::new("/home/.fleetify"), true),
            PathBuf::from(abs)
        );
        assert_eq!(
            resolve_db_path_in(abs, Path::new("/home/.fleetify"), false),
            PathBuf::from(abs)
        );
    }
}

#[cfg(test)]
mod dotenv_tests {
    use super::should_load_dotenv;

    #[test]
    fn dotenv_is_read_only_by_debug_builds() {
        assert!(!should_load_dotenv(true));
        assert!(should_load_dotenv(false));
    }
}

#[cfg(test)]
mod api_token_tests {
    use super::api_token_forced;

    #[test]
    fn only_require_api_token_1_forces_the_token_and_only_in_debug_builds() {
        // The variable is process-wide: change it only under the crate's
        // env lock, and put back whatever was there before asserting.
        let _g = crate::test_support::home_lock()
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let prev = std::env::var_os("FLEETIFY_REQUIRE_API_TOKEN");
        std::env::set_var("FLEETIFY_REQUIRE_API_TOKEN", "1");
        let one = api_token_forced();
        std::env::set_var("FLEETIFY_REQUIRE_API_TOKEN", "true");
        let other = api_token_forced();
        std::env::remove_var("FLEETIFY_REQUIRE_API_TOKEN");
        let unset = api_token_forced();
        match prev {
            Some(v) => std::env::set_var("FLEETIFY_REQUIRE_API_TOKEN", v),
            None => std::env::remove_var("FLEETIFY_REQUIRE_API_TOKEN"),
        }
        assert_eq!(one, cfg!(debug_assertions));
        assert!(!other);
        assert!(!unset);
    }
}
