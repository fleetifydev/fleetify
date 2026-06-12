//! Translation from Fleetify telemetry payloads to PostHog event shapes.
//!
//! Privacy floor: NEVER emit `project_path`, `session_title`,
//! `activity_summary`, or anything else that may carry user content.
//! IDs (`local_session_id`, `project_path`) are SHA-256-hashed and
//! truncated to 16 hex chars so PostHog can group events without
//! learning Fleetify's internal identifiers.
//!
//! `to_posthog_event` returns `None` for kinds we deliberately drop
//! (e.g. `device_heartbeat` fires every 60 s and would chew through
//! PostHog quota — heartbeat presence stays in the Fleetify cloud).

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

/// Translate one Fleetify outbox payload into a PostHog event shape.
/// Returns `None` for kinds the sink intentionally drops.
pub fn to_posthog_event(distinct_id: &str, fleetify: &Value) -> Option<Value> {
    let kind = fleetify.get("kind").and_then(Value::as_str)?;
    let occurred_at = fleetify.get("occurred_at").and_then(Value::as_str);

    let (event_name, properties) = match kind {
        "session_start" => {
            let mut p = json!({
                "provider": fleetify.get("tool"),
                "model": fleetify.get("model"),
                "status": fleetify.get("status"),
            });
            if let Some(pp) = fleetify.get("project_path").and_then(Value::as_str) {
                p["project_id_hash"] = json!(hash_short(pp));
            }
            if let Some(sid) = fleetify.get("local_session_id").and_then(Value::as_str) {
                p["session_id_hash"] = json!(hash_short(sid));
            }
            ("session_started", p)
        }
        "session_stop" => {
            let mut p = json!({
                "provider": fleetify.get("tool"),
                "status": fleetify.get("status"),
            });
            if let Some(sid) = fleetify.get("local_session_id").and_then(Value::as_str) {
                p["session_id_hash"] = json!(hash_short(sid));
            }
            ("session_ended", p)
        }
        "cost" => {
            // Backend stores cost_usd as a string for NUMERIC(20,8) precision
            // (emitters.rs:138). Parse back to f64 for PostHog so dashboards
            // can sum/avg without string gymnastics.
            let cost_usd = fleetify
                .get("cost_usd")
                .and_then(Value::as_str)
                .and_then(|s| s.parse::<f64>().ok());
            let mut p = json!({
                "model": fleetify.get("model"),
                "input_tokens": fleetify.get("input_tokens"),
                "output_tokens": fleetify.get("output_tokens"),
                "cache_read": fleetify.get("cache_read"),
                "cache_write": fleetify.get("cache_write"),
                "cost_usd": cost_usd,
            });
            if let Some(sid) = fleetify.get("local_session_id").and_then(Value::as_str) {
                p["session_id_hash"] = json!(hash_short(sid));
            }
            ("tokens_used", p)
        }
        "status_change" => {
            let mut p = json!({ "status": fleetify.get("status") });
            if let Some(sid) = fleetify.get("local_session_id").and_then(Value::as_str) {
                p["session_id_hash"] = json!(hash_short(sid));
            }
            ("session_status_changed", p)
        }
        "activity" => {
            // activity_summary may contain user content — drop it.
            let mut p = json!({ "activity_kind": fleetify.get("activity_kind") });
            if let Some(sid) = fleetify.get("local_session_id").and_then(Value::as_str) {
                p["session_id_hash"] = json!(hash_short(sid));
            }
            ("agent_activity", p)
        }
        "provider_connected" => (
            "provider_connected",
            json!({ "provider": fleetify.get("provider") }),
        ),
        "provider_disconnected" => (
            "provider_disconnected",
            json!({ "provider": fleetify.get("provider") }),
        ),
        "provider_test_connection" => (
            "provider_tested",
            json!({
                "provider": fleetify.get("provider"),
                "ok": fleetify.get("ok"),
                "code": fleetify.get("code"),
                "latency_ms": fleetify.get("latency_ms"),
            }),
        ),
        "agent_detected" => (
            "agent_detected",
            json!({
                "agent": fleetify.get("agent"),
                "installed": fleetify.get("installed"),
                "authenticated": fleetify.get("authenticated"),
            }),
        ),
        "app_started" => (
            "app_started",
            json!({
                "version": fleetify.get("version"),
                "platform": fleetify.get("platform"),
            }),
        ),
        "device_heartbeat" => return None,
        _ => return None,
    };

    let mut event = json!({
        "event": event_name,
        "distinct_id": distinct_id,
        "properties": properties,
    });
    if let Some(ts) = occurred_at {
        event["timestamp"] = json!(ts);
    }
    Some(event)
}

fn hash_short(s: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(s.as_bytes());
    let digest = hasher.finalize();
    let hex = format!("{digest:x}");
    hex.chars().take(16).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drops_device_heartbeat() {
        let p = json!({ "kind": "device_heartbeat", "occurred_at": "2026-05-27T12:00:00Z" });
        assert!(to_posthog_event("device-1", &p).is_none());
    }

    #[test]
    fn drops_unknown_kind() {
        let p = json!({ "kind": "future_event_kind", "occurred_at": "2026-05-27T12:00:00Z" });
        assert!(to_posthog_event("device-1", &p).is_none());
    }

    #[test]
    fn session_start_maps_and_hashes_sensitive_fields() {
        let p = json!({
            "kind": "session_start",
            "local_session_id": "abc-123",
            "tool": "claude-code",
            "model": "claude-sonnet-4-6",
            "status": "running",
            "session_title": "Refactor auth module",
            "project_path": "/Users/alice/code/secret-project",
            "occurred_at": "2026-05-27T12:00:00Z",
        });
        let event = to_posthog_event("device-1", &p).unwrap();
        assert_eq!(event["event"], "session_started");
        assert_eq!(event["distinct_id"], "device-1");
        assert_eq!(event["properties"]["provider"], "claude-code");
        assert_eq!(event["properties"]["model"], "claude-sonnet-4-6");
        assert_eq!(event["timestamp"], "2026-05-27T12:00:00Z");
        // Sensitive fields MUST NOT appear anywhere in the payload.
        let s = event.to_string();
        assert!(!s.contains("Refactor auth module"), "session_title leaked!");
        assert!(!s.contains("/Users/alice"), "project_path leaked!");
        assert!(!s.contains("secret-project"), "project name leaked!");
        // But the hashed forms should be present.
        assert!(event["properties"]["project_id_hash"].is_string());
        assert!(event["properties"]["session_id_hash"].is_string());
        assert_eq!(
            event["properties"]["project_id_hash"]
                .as_str()
                .unwrap()
                .len(),
            16
        );
    }

    #[test]
    fn activity_drops_summary() {
        let p = json!({
            "kind": "activity",
            "local_session_id": "s1",
            "activity_kind": "tool_call",
            "activity_summary": "Read /home/user/.ssh/id_rsa to inspect key",
            "occurred_at": "2026-05-27T12:00:00Z",
        });
        let event = to_posthog_event("device-1", &p).unwrap();
        assert_eq!(event["event"], "agent_activity");
        assert_eq!(event["properties"]["activity_kind"], "tool_call");
        let s = event.to_string();
        assert!(!s.contains(".ssh"), "activity_summary leaked!");
        assert!(!s.contains("id_rsa"), "activity_summary leaked!");
    }

    #[test]
    fn cost_parses_numeric_string_back_to_f64() {
        let p = json!({
            "kind": "cost",
            "local_session_id": "s1",
            "model": "claude-sonnet-4-6",
            "input_tokens": 100,
            "output_tokens": 200,
            "cache_read": 0,
            "cache_write": 0,
            "cost_usd": "0.001234",
            "occurred_at": "2026-05-27T12:00:00Z",
        });
        let event = to_posthog_event("device-1", &p).unwrap();
        assert_eq!(event["event"], "tokens_used");
        assert_eq!(event["properties"]["input_tokens"], 100);
        let cost = event["properties"]["cost_usd"].as_f64().unwrap();
        assert!((cost - 0.001234).abs() < 1e-9);
    }

    #[test]
    fn session_stop_carries_hashed_session_id() {
        let p = json!({
            "kind": "session_stop",
            "local_session_id": "abc-123",
            "tool": "openai",
            "status": "stopped",
            "occurred_at": "2026-05-27T12:00:00Z",
        });
        let event = to_posthog_event("device-1", &p).unwrap();
        assert_eq!(event["event"], "session_ended");
        assert_eq!(event["properties"]["provider"], "openai");
        assert!(event["properties"]["session_id_hash"].is_string());
        assert!(!event.to_string().contains("abc-123"));
    }

    #[test]
    fn provider_connected_maps_with_provider_only() {
        let p = json!({
            "kind": "provider_connected",
            "provider": "openai",
            "occurred_at": "2026-05-27T12:00:00Z",
        });
        let event = to_posthog_event("device-1", &p).unwrap();
        assert_eq!(event["event"], "provider_connected");
        assert_eq!(event["properties"]["provider"], "openai");
        assert_eq!(event["timestamp"], "2026-05-27T12:00:00Z");
    }

    #[test]
    fn provider_test_connection_carries_outcome_fields() {
        let p = json!({
            "kind": "provider_test_connection",
            "provider": "deepseek",
            "ok": false,
            "code": "401",
            "latency_ms": 1234,
            "occurred_at": "2026-05-27T12:00:00Z",
        });
        let event = to_posthog_event("device-1", &p).unwrap();
        assert_eq!(event["event"], "provider_tested");
        assert_eq!(event["properties"]["provider"], "deepseek");
        assert_eq!(event["properties"]["ok"], false);
        assert_eq!(event["properties"]["code"], "401");
        assert_eq!(event["properties"]["latency_ms"], 1234);
    }

    #[test]
    fn app_started_carries_version_and_platform() {
        let p = json!({
            "kind": "app_started",
            "version": "0.1.0",
            "platform": "darwin",
            "occurred_at": "2026-05-27T12:00:00Z",
        });
        let event = to_posthog_event("device-1", &p).unwrap();
        assert_eq!(event["event"], "app_started");
        assert_eq!(event["properties"]["version"], "0.1.0");
        assert_eq!(event["properties"]["platform"], "darwin");
    }

    #[test]
    fn agent_detected_carries_install_and_auth_flags() {
        let p = json!({
            "kind": "agent_detected",
            "agent": "claude-code",
            "installed": true,
            "authenticated": false,
            "occurred_at": "2026-05-27T12:00:00Z",
        });
        let event = to_posthog_event("device-1", &p).unwrap();
        assert_eq!(event["event"], "agent_detected");
        assert_eq!(event["properties"]["agent"], "claude-code");
        assert_eq!(event["properties"]["installed"], true);
        assert_eq!(event["properties"]["authenticated"], false);
    }

    #[test]
    fn hash_short_is_deterministic_and_16_hex_chars() {
        let a = hash_short("hello");
        let b = hash_short("hello");
        assert_eq!(a, b);
        assert_eq!(a.len(), 16);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(hash_short("hello"), hash_short("world"));
    }
}
