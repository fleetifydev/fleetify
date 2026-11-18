//! Who the embedded backend answers.
//!
//! The backend listens on `127.0.0.1:<port>` for the app alone: its window,
//! the shell and the agents' helper processes. A request has to be addressed
//! to that host, `127.0.0.1:<port>` or `localhost:<port>`; any other gets a
//! plain-text 403. [`guard`] is the router's outermost layer
//! (`http::app`), so this holds for every path: the API, `/healthz`, the UI
//! files and the 404s.
//!
//! Each run also has an [`ApiToken`]. The shell makes it at startup, passes
//! it to [`crate::serve`] and gives it to the renderer over IPC
//! (`backend_api_token`).

use std::fmt;
use std::fmt::Write as _;
use std::sync::Arc;

use axum::extract::{Request, State};
use axum::http::{header, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use rand::RngCore;

/// The request header that carries the per-run token.
pub const API_TOKEN_HEADER: &str = "x-fleetify-token";
/// The query parameter that carries it on URLs that can't set a header
/// (WebSocket and EventSource).
pub const API_TOKEN_QUERY: &str = "api_token";

/// This run's API token. Its `Debug` never shows the value.
#[derive(Clone)]
pub struct ApiToken(Arc<str>);

impl ApiToken {
    /// 32 random bytes, as 64 lowercase hex characters.
    pub fn generate() -> Self {
        let mut bytes = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut bytes);
        let mut hex = String::with_capacity(64);
        for b in bytes {
            let _ = write!(hex, "{b:02x}");
        }
        Self(Arc::from(hex))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// Whether `candidate` is this token, compared in constant time.
    pub fn matches(&self, candidate: &str) -> bool {
        constant_time_eq(self.0.as_bytes(), candidate.as_bytes())
    }
}

impl fmt::Debug for ApiToken {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("ApiToken(..)")
    }
}

/// What [`guard`] checks requests against.
#[derive(Clone)]
pub struct AccessPolicy {
    /// The port the backend bound.
    pub port: u16,
    /// This run's token.
    pub token: ApiToken,
}

/// Whether `host`, a request's `Host` (or its URI authority), is the
/// backend's own address: `127.0.0.1:<port>` or `localhost:<port>`, in any
/// letter case. Another port, no port, another name or no host is refused.
pub fn host_allowed(host: Option<&str>, port: u16) -> bool {
    host.is_some_and(|host| {
        ["127.0.0.1", "localhost"]
            .iter()
            .any(|name| host.eq_ignore_ascii_case(&format!("{name}:{port}")))
    })
}

/// Constant-time byte-slice equality. Tiny implementation — fine for
/// 32-byte secrets like the loopback token.
pub(crate) fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff: u8 = 0;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// The router's outermost layer: a request that isn't addressed to the
/// backend's own host gets a plain-text 403.
pub async fn guard(State(policy): State<AccessPolicy>, req: Request, next: Next) -> Response {
    if !host_allowed(request_host(&req), policy.port) {
        return refuse("host", &req);
    }
    next.run(req).await
}

/// The host a request is addressed to: its `Host` header, or the URI's
/// authority when it has no `Host` header. A request with two `Host`
/// headers has none.
fn request_host(req: &Request) -> Option<&str> {
    let mut hosts = req.headers().get_all(header::HOST).iter();
    match (hosts.next(), hosts.next()) {
        (Some(host), None) => host.to_str().ok(),
        (None, _) => req.uri().authority().map(|authority| authority.as_str()),
        (Some(_), Some(_)) => None,
    }
}

/// The 403. The log line has the path without its query string, which can
/// carry a token.
fn refuse(reason: &'static str, req: &Request) -> Response {
    tracing::warn!(
        target: "fleetify.access",
        reason,
        method = %req.method(),
        path = req.uri().path(),
        "request refused"
    );
    (StatusCode::FORBIDDEN, "forbidden").into_response()
}

#[cfg(test)]
mod tests {
    use axum::body::Body;
    use axum::http::Request;
    use axum::middleware::from_fn_with_state;
    use axum::routing::get;
    use axum::Router;
    use tower::ServiceExt;

    use super::*;
    use crate::test_support::LogCapture;

    #[test]
    fn the_backends_own_address_is_allowed_in_any_letter_case() {
        for host in ["127.0.0.1:8765", "localhost:8765", "LOCALHOST:8765"] {
            assert!(host_allowed(Some(host), 8765), "{host} was refused");
        }
    }

    #[test]
    fn any_other_host_is_refused() {
        for host in [
            "127.0.0.1:8766",
            "127.0.0.1",
            "evil.example:8765",
            "127.0.0.1.evil.example:8765",
            "[::1]:8765",
        ] {
            assert!(!host_allowed(Some(host), 8765), "{host} was allowed");
        }
        assert!(!host_allowed(None, 8765), "a missing host was allowed");
    }

    // The token assertions never print a token: a failure message says what
    // is wrong, not the value.

    #[test]
    fn a_generated_token_is_64_lowercase_hex_characters_and_new_each_time() {
        let token = ApiToken::generate();
        assert_eq!(token.as_str().len(), 64);
        assert!(
            token
                .as_str()
                .chars()
                .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c)),
            "the token is not lowercase hex"
        );
        assert!(
            token.as_str() != ApiToken::generate().as_str(),
            "two generated tokens are equal"
        );
    }

    #[test]
    fn a_token_matches_only_itself() {
        let token = ApiToken::generate();
        assert!(token.matches(token.as_str()), "the token itself");
        assert!(!token.matches(""), "the empty string");
        assert!(
            !token.matches(&token.as_str()[..63]),
            "a 63-character prefix"
        );
        assert!(
            !token.matches(ApiToken::generate().as_str()),
            "another token"
        );
    }

    #[test]
    fn debug_never_shows_the_token() {
        let token = ApiToken::generate();
        let shown = format!("{token:?}");
        assert!(!shown.contains(token.as_str()), "Debug shows the token");
        assert!(shown == "ApiToken(..)", "Debug isn't ApiToken(..)");
    }

    #[test]
    fn constant_time_eq_handles_length_mismatch_and_match() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"abcd"));
        assert!(constant_time_eq(b"", b""));
    }

    /// One route behind the guard, for a backend bound to port 8765.
    async fn through_guard(req: Request<Body>) -> (StatusCode, String) {
        let policy = AccessPolicy {
            port: 8765,
            token: ApiToken::generate(),
        };
        let app = Router::new()
            .route("/api/x", get(|| async { "ok" }).post(|| async { "ok" }))
            .layer(from_fn_with_state(policy, guard));
        let resp = app.oneshot(req).await.unwrap();
        let status = resp.status();
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        (status, String::from_utf8_lossy(&body).into_owned())
    }

    fn request(uri: &str, hosts: &[&str]) -> Request<Body> {
        let mut req = Request::builder().uri(uri);
        for host in hosts {
            req = req.header("host", *host);
        }
        req.body(Body::empty()).unwrap()
    }

    #[tokio::test]
    async fn the_guard_checks_the_host_header_or_else_the_uri_authority() {
        let ok = (StatusCode::OK, "ok".to_string());
        let forbidden = (StatusCode::FORBIDDEN, "forbidden".to_string());

        assert_eq!(
            through_guard(request("/api/x", &["127.0.0.1:8765"])).await,
            ok
        );
        assert_eq!(
            through_guard(request("/api/x", &["evil.example:8765"])).await,
            forbidden
        );
        // No Host header: the URI's authority is checked instead.
        assert_eq!(
            through_guard(request("http://localhost:8765/api/x", &[])).await,
            ok
        );
        assert_eq!(
            through_guard(request("http://evil.example:8765/api/x", &[])).await,
            forbidden
        );
        assert_eq!(through_guard(request("/api/x", &[])).await, forbidden);
        // Two Host headers count as none.
        assert_eq!(
            through_guard(request("/api/x", &["127.0.0.1:8765", "evil.example:8765"])).await,
            forbidden
        );
    }

    #[tokio::test]
    async fn a_refusal_is_logged_with_its_path_and_never_its_query() {
        let logs = LogCapture::start();
        let req = Request::builder()
            .method("POST")
            .uri("/api/x?api_token=query-SECRET")
            .header("host", "evil.example:8765")
            .body(Body::empty())
            .unwrap();
        let (status, _) = through_guard(req).await;
        let text = logs.text();

        assert_eq!(status, StatusCode::FORBIDDEN);
        assert!(text.contains("WARN fleetify.access:"), "{text}");
        assert!(text.contains(r#"reason="host""#), "{text}");
        assert!(text.contains("method=POST"), "{text}");
        assert!(text.contains(r#"path="/api/x""#), "{text}");
        assert!(!text.contains("SECRET"), "the query string was logged");
    }
}
