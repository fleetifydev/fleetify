//! MCP server status: orchestration + in-memory cache.
//!
//! `status_for` turns a registry entry into a [`ProbeResult`] (auth
//! short-circuit → refresh-if-near-expiry → splice bearer → probe). The
//! latest result per server is held in a process-global map, warmed at
//! backend startup so Settings → Tools & MCPs and the composer show real
//! connection state on first open without a manual "Test connection". The
//! cache is ephemeral (rebuilt each boot), so — unlike `mcp_registry` /
//! `mcp_secrets` — it is not persisted to disk.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use crate::services::mcp_prober::{McpStatus, ProbeResult};
use crate::services::{mcp_auth, mcp_dispatch, mcp_prober, mcp_registry, mcp_secrets};

fn store() -> &'static Mutex<HashMap<String, ProbeResult>> {
    static M: OnceLock<Mutex<HashMap<String, ProbeResult>>> = OnceLock::new();
    M.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Latest cached status for one server, if it has been probed since boot.
pub fn cached(name: &str) -> Option<ProbeResult> {
    store().lock().ok()?.get(name).cloned()
}

/// Drop a server's cached status (e.g. after it's removed from the registry).
pub fn forget(name: &str) {
    if let Ok(mut g) = store().lock() {
        g.remove(name);
    }
}

/// Compute one server's live status. Unknown name → failed; a remote
/// (http/sse) server with an `oauth` block but no stored token →
/// auth_needed instantly (no network round trip); otherwise refresh a
/// near-expiry token, splice the bearer, and probe.
pub async fn status_for(name: &str) -> ProbeResult {
    let Some(cfg) = mcp_registry::get(name) else {
        return ProbeResult {
            name: name.to_string(),
            status: McpStatus::Failed,
            tool_count: 0,
            tools: vec![],
            error: Some(format!("no MCP server named {name:?} in registry")),
            auth_hint: None,
            probed_at: chrono::Utc::now().to_rfc3339(),
        };
    };
    let kind = cfg.get("type").and_then(|v| v.as_str()).unwrap_or("stdio");
    let is_remote = matches!(kind, "http" | "sse");
    let has_oauth = cfg.get("oauth").is_some();
    let has_token = mcp_secrets::get(name)
        .and_then(|s| s.access_token)
        .is_some();
    if is_remote && has_oauth && !has_token {
        return ProbeResult {
            name: name.to_string(),
            status: McpStatus::AuthNeeded,
            tool_count: 0,
            tools: vec![],
            error: None,
            auth_hint: None,
            probed_at: chrono::Utc::now().to_rfc3339(),
        };
    }
    mcp_auth::ensure_fresh(name).await;
    let spliced = mcp_dispatch::splice_for_probe(name, &cfg);
    mcp_prober::probe(name, &spliced).await
}

/// `status_for` + write the result into the cache. Returns the result so
/// the probe endpoints can echo it back to the renderer.
pub async fn probe_and_cache(name: &str) -> ProbeResult {
    let result = status_for(name).await;
    if let Ok(mut g) = store().lock() {
        g.insert(name.to_string(), result.clone());
    }
    result
}

/// Probe every registered MCP server once and fill the cache. Spawned at
/// backend startup; best-effort (a failed probe just caches a `failed` /
/// `auth_needed` status the UI surfaces honestly).
pub async fn warm_all() {
    let names: Vec<String> = mcp_registry::list_all().into_keys().collect();
    let futs = names.into_iter().map(|n| async move {
        let _ = probe_and_cache(&n).await;
    });
    futures_util::future::join_all(futs).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(status: McpStatus) -> ProbeResult {
        ProbeResult {
            name: "x".into(),
            status,
            tool_count: 0,
            tools: vec![],
            error: None,
            auth_hint: None,
            probed_at: "t".into(),
        }
    }

    #[test]
    fn cache_get_forget_round_trip() {
        // Exercise the cache directly via a unique key so the process-global
        // map can't collide with sibling tests.
        if let Ok(mut g) = store().lock() {
            g.insert("status-cache-rt".into(), sample(McpStatus::Connected));
        }
        assert_eq!(
            cached("status-cache-rt").unwrap().status,
            McpStatus::Connected
        );
        forget("status-cache-rt");
        assert!(cached("status-cache-rt").is_none());
    }

    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn warm_all_caches_a_failed_status_for_a_bogus_stdio_server() {
        // home_lock + tempdir isolates the file-backed registry; the guard
        // must span warm_all's awaits (the probe spawns a process). Tests are
        // serialized by this lock + --test-threads=1, so there's no deadlock.
        let _g = crate::test_support::home_lock()
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let tmp = tempfile::tempdir().unwrap();
        std::env::remove_var("FLEETIFY_HOME");
        std::env::set_var("HOME", tmp.path());
        std::env::set_var("USERPROFILE", tmp.path());

        mcp_registry::add(
            "warmtest",
            serde_json::json!({ "type": "stdio", "command": "definitely-not-a-real-binary-xyzzy" }),
        )
        .unwrap();
        warm_all().await;
        let result = cached("warmtest").expect("warm_all should cache the server");
        assert_eq!(result.status, McpStatus::Failed);
        forget("warmtest");
    }
}
