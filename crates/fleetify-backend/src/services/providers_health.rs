//! HTTP-provider health probe. Test-runs every provider in CATALOG
//! (kind = Api) in parallel and writes the result to HttpHealthCache.
//!
//! Same logic the renderer's "Test" button has invoked since PR #18,
//! but driven from the boot warm-up so Settings → Models renders with
//! final pills on first paint.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use crate::providers::{ProviderKind, CATALOG};
use crate::routers::providers::{HealthSnapshot, HttpHealthCache};

const HEALTH_TIMEOUT: Duration = Duration::from_secs(8);

/// Fan-out probe of every API-kind provider in the catalog. Writes the
/// resulting snapshot to `cache` (replacing any previous content).
pub async fn warm_all(cache: &HttpHealthCache) {
    let mut joins = Vec::new();
    for spec in CATALOG.iter() {
        if !matches!(spec.kind, ProviderKind::Api) {
            continue;
        }
        let id = spec.id.to_string();
        joins.push(tokio::spawn(async move {
            let snap = probe_one(&id).await;
            (id, snap)
        }));
    }
    let mut map = HashMap::new();
    for j in joins {
        match j.await {
            Ok((id, snap)) => {
                map.insert(id, snap);
            }
            Err(e) => {
                tracing::error!(target: "fleet-backend", error = %e, "warm_all: probe task panicked")
            }
        }
    }
    cache.set(map).await;
}

async fn probe_one(provider_id: &str) -> HealthSnapshot {
    let Some(key) = crate::providers::keys::get_key(provider_id) else {
        return HealthSnapshot::NoKey;
    };
    let Some(spec) = crate::providers::find_provider(provider_id) else {
        return HealthSnapshot::Failed {
            code: "UNKNOWN_PROVIDER".into(),
            message: None,
        };
    };
    let base = spec.default_base_url.trim_end_matches('/');
    let url = format!("{}/models", base);
    let client = match reqwest::Client::builder().timeout(HEALTH_TIMEOUT).build() {
        Ok(c) => c,
        Err(e) => {
            return HealthSnapshot::Failed {
                code: "NETWORK".into(),
                message: Some(e.to_string()),
            }
        }
    };
    let started = Instant::now();
    // FIXME: Hardcoded Bearer. Every current ProviderKind::Api entry in
    // CATALOG uses AuthSpec::Bearer, but AuthSpec::ApiKey { header, .. }
    // exists. When the first ApiKey-auth provider lands, switch to a
    // `match spec.auth` here.
    let resp = client.get(&url).bearer_auth(&key).send().await;
    let latency_ms = started.elapsed().as_millis() as u64;
    match resp {
        Ok(r) if r.status().is_success() => {
            let body = r.json::<serde_json::Value>().await.unwrap_or_default();
            let model_count = body.get("data").and_then(|v| v.as_array()).map(|a| a.len());
            HealthSnapshot::Ok {
                latency_ms,
                model_count,
            }
        }
        Ok(r)
            if r.status() == reqwest::StatusCode::UNAUTHORIZED
                || r.status() == reqwest::StatusCode::FORBIDDEN =>
        {
            HealthSnapshot::Failed {
                code: "AUTH".into(),
                message: Some(r.status().to_string()),
            }
        }
        Ok(r) if r.status() == reqwest::StatusCode::NOT_FOUND => HealthSnapshot::Failed {
            code: "NOT_FOUND".into(),
            message: Some(r.status().to_string()),
        },
        Ok(r) => HealthSnapshot::Failed {
            code: "HTTP".into(),
            message: Some(format!("{}", r.status())),
        },
        Err(e) if e.is_timeout() => HealthSnapshot::Failed {
            code: "TIMEOUT".into(),
            message: None,
        },
        Err(e) => HealthSnapshot::Failed {
            code: "NETWORK".into(),
            message: Some(e.to_string()),
        },
    }
}
