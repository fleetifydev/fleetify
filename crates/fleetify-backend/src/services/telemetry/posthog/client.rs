//! Thin reqwest wrapper for `POST <host>/batch/` on PostHog.
//!
//! HTTP semantics PostHog actually documents:
//!   - 2xx → success (PostHog occasionally returns 200 for events it
//!     later drops on its side — we treat the HTTP response as
//!     authoritative; can't second-guess silent invalid-event drops).
//!   - 4xx → deterministic rejection; drop the batch.
//!   - 5xx / network errors → transient; bump attempt counter and try
//!     again on the next worker tick.

use std::time::Duration;

use anyhow::{anyhow, Result};
use serde_json::{json, Value};

#[derive(Debug)]
pub enum BatchOutcome {
    Acked,
    Poison(String),
    Retry(String),
}

pub struct Client {
    http: reqwest::Client,
    api_key: String,
    batch_url: String,
}

impl Client {
    pub fn new(api_key: &str, host: &str) -> Result<Self> {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|e| anyhow!("posthog client build failed: {e}"))?;
        let batch_url = format!("{}/batch/", host.trim_end_matches('/'));
        Ok(Self {
            http,
            api_key: api_key.to_string(),
            batch_url,
        })
    }

    /// POST a batch of events. Each event is already a PostHog-shaped
    /// payload from `mapper::to_posthog_event` (or a synthesised
    /// `$identify` from `mod::identify_local`).
    pub async fn send_batch(&self, events: Vec<Value>) -> BatchOutcome {
        if events.is_empty() {
            return BatchOutcome::Acked;
        }
        let body = json!({
            "api_key": self.api_key,
            "historical_migration": false,
            "batch": events,
        });
        match self.http.post(&self.batch_url).json(&body).send().await {
            Ok(resp) => {
                let status = resp.status();
                if status.is_success() {
                    BatchOutcome::Acked
                } else if status.is_client_error() {
                    let body = resp.text().await.unwrap_or_default();
                    BatchOutcome::Poison(format!(
                        "HTTP {} from PostHog: {}",
                        status.as_u16(),
                        truncate(&body, 200)
                    ))
                } else {
                    let body = resp.text().await.unwrap_or_default();
                    BatchOutcome::Retry(format!(
                        "HTTP {} from PostHog: {}",
                        status.as_u16(),
                        truncate(&body, 200)
                    ))
                }
            }
            Err(e) => BatchOutcome::Retry(format!("posthog POST failed: {e}")),
        }
    }
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        s.chars().take(max).collect::<String>() + "…"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[tokio::test]
    async fn batch_body_shape_matches_posthog_spec() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/batch/"))
            .respond_with(ResponseTemplate::new(200))
            .mount(&server)
            .await;
        let client = Client::new("phc_test", &server.uri()).unwrap();
        let outcome = client
            .send_batch(vec![json!({
                "event": "session_started",
                "distinct_id": "device-1",
                "properties": { "provider": "claude-code" },
                "timestamp": "2026-05-27T12:00:00Z",
            })])
            .await;
        assert!(matches!(outcome, BatchOutcome::Acked));
        // Verify the wire body matches PostHog's documented schema.
        let received = &server.received_requests().await.unwrap()[0];
        let body: Value = serde_json::from_slice(&received.body).unwrap();
        assert_eq!(body["api_key"], "phc_test");
        assert_eq!(body["historical_migration"], false);
        assert_eq!(body["batch"][0]["event"], "session_started");
        assert_eq!(body["batch"][0]["distinct_id"], "device-1");
        assert_eq!(body["batch"][0]["properties"]["provider"], "claude-code");
    }

    #[tokio::test]
    async fn client_error_is_poison() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/batch/"))
            .respond_with(ResponseTemplate::new(400).set_body_string("invalid payload"))
            .mount(&server)
            .await;
        let client = Client::new("phc_test", &server.uri()).unwrap();
        let outcome = client
            .send_batch(vec![json!({ "event": "x", "distinct_id": "y" })])
            .await;
        assert!(matches!(outcome, BatchOutcome::Poison(_)));
    }

    #[tokio::test]
    async fn server_error_is_retry() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/batch/"))
            .respond_with(ResponseTemplate::new(503))
            .mount(&server)
            .await;
        let client = Client::new("phc_test", &server.uri()).unwrap();
        let outcome = client
            .send_batch(vec![json!({ "event": "x", "distinct_id": "y" })])
            .await;
        assert!(matches!(outcome, BatchOutcome::Retry(_)));
    }

    #[tokio::test]
    async fn empty_batch_returns_acked_without_a_request() {
        // No mock — if we hit the wire, the request fails and the test
        // catches it as a `Retry`.
        let client = Client::new("phc_test", "http://127.0.0.1:1").unwrap();
        let outcome = client.send_batch(vec![]).await;
        assert!(matches!(outcome, BatchOutcome::Acked));
    }

    #[tokio::test]
    async fn host_trailing_slash_does_not_double_up_path() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/batch/"))
            .respond_with(ResponseTemplate::new(200))
            .mount(&server)
            .await;
        let host_with_slash = format!("{}/", server.uri());
        let client = Client::new("phc_test", &host_with_slash).unwrap();
        let outcome = client
            .send_batch(vec![json!({ "event": "x", "distinct_id": "y" })])
            .await;
        assert!(matches!(outcome, BatchOutcome::Acked));
    }
}
