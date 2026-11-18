//! Who the embedded backend answers.
//!
//! The backend listens on `127.0.0.1:<port>` for the app alone: its window,
//! the shell and the agents' helper processes. [`guard`] is the router's
//! outermost layer (`http::app`), so its checks hold for every path: the
//! API, `/healthz`, the UI files and the 404s. [`decide`] has the rules:
//!
//! - A request has to be addressed to the backend's own host,
//!   `127.0.0.1:<port>` or `localhost:<port>`.
//! - An API request also needs this run's [`ApiToken`]. The shell makes it
//!   at startup, passes it to [`crate::serve`] and gives it to the renderer
//!   over IPC (`backend_api_token`). It travels in the `X-Fleetify-Token`
//!   header. A WebSocket upgrade or the status stream, whose URLs the
//!   renderer can't give a header, may carry it in the `api_token` query
//!   parameter instead.
//!
//! Anything else gets a plain-text 403.

use std::borrow::Cow;
use std::fmt;
use std::fmt::Write as _;
use std::sync::Arc;

use axum::extract::{Request, State};
use axum::http::{header, HeaderMap, Method, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use rand::RngCore;

/// The request header that carries the per-run token.
pub const API_TOKEN_HEADER: &str = "x-fleetify-token";
/// The query parameter that carries it on URLs that can't set a header
/// (WebSocket and EventSource).
pub const API_TOKEN_QUERY: &str = "api_token";

/// The system browser's redirect at the end of an MCP server's OAuth flow.
/// It can't carry the token; the flow's `state` guards it.
const MCP_AUTH_CALLBACK_PATH: &str = "/api/mcp/auth/callback";
/// The status stream (an `EventSource`).
const STATUS_STREAM_PATH: &str = "/events/status";

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
    /// Whether API requests need the token; see [`token_required`].
    pub token_required: bool,
}

/// Whether API requests need the token: always in a release build
/// (`release`), and in a debug build unless it runs with `FLEETIFY_NOAUTH=1`
/// (`no_auth`). `force` (`FLEETIFY_REQUIRE_API_TOKEN=1`, which only a debug
/// build reads) asks for it even then.
pub fn token_required(release: bool, no_auth: bool, force: bool) -> bool {
    release || !no_auth || force
}

/// What [`decide`] needs to know about a request.
pub struct RequestFacts<'a> {
    pub method: &'a Method,
    /// The URI's path, without the query.
    pub path: &'a str,
    /// The `Host` header, or the URI's authority when there is none.
    pub host: Option<&'a str>,
    /// The `X-Fleetify-Token` header.
    pub header_token: Option<&'a str>,
    /// The `api_token` query parameter, percent-decoded.
    pub query_token: Option<&'a str>,
    /// Whether the request asks to upgrade to a WebSocket.
    pub websocket_upgrade: bool,
}

/// What [`decide`] answers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    Allow,
    /// Refused, with the reason the log line gives: `"host"` or `"token"`.
    Forbidden(&'static str),
}

/// Whether the backend answers a request. The rules, in order:
///
/// 1. A request addressed to another host is refused (`"host"`).
/// 2. Without the token requirement, everything else is allowed.
/// 3. These need no token:
///    - `GET`/`HEAD /healthz`;
///    - `GET`/`HEAD` of any path outside `/api/`, `/ws/` and `/events/` (the
///      UI);
///    - any method under `/api/internal/` (the handlers check the internal
///      secret);
///    - `GET /api/mcp/auth/callback`;
///    - `POST /api/csp-report` ([`crate::ui::CSP_REPORT_PATH`]): the browser
///      sends CSP violation reports itself, without the token.
/// 4. The token in the header is allowed.
/// 5. The token in the query is allowed on a WebSocket upgrade under `/ws/`
///    and on `GET /events/status`.
/// 6. Everything else is refused (`"token"`).
///
/// Every token comparison goes through [`ApiToken::matches`].
pub fn decide(facts: &RequestFacts<'_>, policy: &AccessPolicy) -> Verdict {
    if !host_allowed(facts.host, policy.port) {
        return Verdict::Forbidden("host");
    }
    if !policy.token_required || needs_no_token(facts) {
        return Verdict::Allow;
    }
    if facts
        .header_token
        .is_some_and(|token| policy.token.matches(token))
    {
        return Verdict::Allow;
    }
    if query_token_counts(facts)
        && facts
            .query_token
            .is_some_and(|token| policy.token.matches(token))
    {
        return Verdict::Allow;
    }
    Verdict::Forbidden("token")
}

/// Rule 3 of [`decide`].
fn needs_no_token(facts: &RequestFacts<'_>) -> bool {
    let (method, path) = (facts.method, facts.path);
    let read = *method == Method::GET || *method == Method::HEAD;
    let api = ["/api/", "/ws/", "/events/"]
        .iter()
        .any(|prefix| path.starts_with(prefix));
    (read && path == crate::HEALTH_PATH)
        || (read && !api)
        || path.starts_with("/api/internal/")
        || (*method == Method::GET && path == MCP_AUTH_CALLBACK_PATH)
        || (*method == Method::POST && path == crate::ui::CSP_REPORT_PATH)
}

/// Rule 5 of [`decide`]: where the query token counts.
fn query_token_counts(facts: &RequestFacts<'_>) -> bool {
    *facts.method == Method::GET
        && ((facts.websocket_upgrade && facts.path.starts_with("/ws/"))
            || facts.path == STATUS_STREAM_PATH)
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

/// The router's outermost layer: what [`decide`] refuses gets a plain-text
/// 403, and the rest goes on to the router.
pub async fn guard(State(policy): State<AccessPolicy>, req: Request, next: Next) -> Response {
    let verdict = {
        let query_token = single_query_param(req.uri().query(), API_TOKEN_QUERY);
        let facts = RequestFacts {
            method: req.method(),
            path: req.uri().path(),
            host: request_host(&req),
            header_token: single_header(req.headers(), API_TOKEN_HEADER),
            query_token: query_token.as_deref(),
            websocket_upgrade: is_websocket_upgrade(req.headers()),
        };
        decide(&facts, &policy)
    };
    match verdict {
        Verdict::Allow => next.run(req).await,
        Verdict::Forbidden(reason) => refuse(reason, &req),
    }
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

/// The value of a header the request has exactly once; twice counts as
/// none.
fn single_header<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    let mut values = headers.get_all(name).iter();
    match (values.next(), values.next()) {
        (Some(value), None) => value.to_str().ok(),
        _ => None,
    }
}

/// The percent-decoded value of a query parameter the request has exactly
/// once; twice counts as none.
fn single_query_param<'a>(query: Option<&'a str>, name: &str) -> Option<Cow<'a, str>> {
    let mut values = url::form_urlencoded::parse(query?.as_bytes())
        .filter(|(key, _)| key == name)
        .map(|(_, value)| value);
    match (values.next(), values.next()) {
        (Some(value), None) => Some(value),
        _ => None,
    }
}

/// Whether a request asks to upgrade to a WebSocket: `Upgrade: websocket`,
/// with `upgrade` among its `Connection` options, in any letter case.
fn is_websocket_upgrade(headers: &HeaderMap) -> bool {
    let upgrade = headers
        .get(header::UPGRADE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.trim().eq_ignore_ascii_case("websocket"));
    let connection = headers
        .get_all(header::CONNECTION)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .any(|option| option.trim().eq_ignore_ascii_case("upgrade"));
    upgrade && connection
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
    use axum::http::{Method, Request};
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

    #[test]
    fn the_token_is_required_unless_a_debug_build_runs_without_auth() {
        // (release, no_auth, force) → required
        for (release, no_auth, force, required) in [
            (true, true, false, true),
            (false, true, false, false),
            (false, false, false, true),
            (false, true, true, true),
            (true, false, false, true),
            (true, true, true, true),
            (true, false, true, true),
            (false, false, true, true),
        ] {
            assert_eq!(
                token_required(release, no_auth, force),
                required,
                "release={release} no_auth={no_auth} force={force}"
            );
        }
    }

    /// A policy for a backend bound to port 8765, with a new token.
    fn policy(token_required: bool) -> AccessPolicy {
        AccessPolicy {
            port: 8765,
            token: ApiToken::generate(),
            token_required,
        }
    }

    /// A request for `path` on the backend's own address, with no token.
    fn facts<'a>(method: &'a Method, path: &'a str) -> RequestFacts<'a> {
        RequestFacts {
            method,
            path,
            host: Some("127.0.0.1:8765"),
            header_token: None,
            query_token: None,
            websocket_upgrade: false,
        }
    }

    #[test]
    fn decide_applies_its_rules_in_order() {
        let policy = policy(true);
        let token = policy.token.as_str();
        let other = ApiToken::generate();
        let wrong = other.as_str();
        let (get, head, post) = (Method::GET, Method::HEAD, Method::POST);
        const ALLOW: Verdict = Verdict::Allow;
        const NO_TOKEN: Verdict = Verdict::Forbidden("token");
        const BAD_HOST: Verdict = Verdict::Forbidden("host");
        let evil = Some("evil.example:8765");

        let rows = [
            // 1. The host comes first, even with a valid token.
            (
                "a bad host, with the header token",
                RequestFacts {
                    host: evil,
                    header_token: Some(token),
                    ..facts(&get, "/api/fs/dir")
                },
                BAD_HOST,
            ),
            (
                "a bad host, for a UI file",
                RequestFacts {
                    host: evil,
                    ..facts(&get, "/")
                },
                BAD_HOST,
            ),
            (
                "no host, for /healthz",
                RequestFacts {
                    host: None,
                    ..facts(&get, "/healthz")
                },
                BAD_HOST,
            ),
            // 3. What needs no token.
            ("HEAD /healthz", facts(&head, "/healthz"), ALLOW),
            ("GET /healthz", facts(&get, "/healthz"), ALLOW),
            ("GET of the UI", facts(&get, "/"), ALLOW),
            ("GET of a UI asset", facts(&get, "/assets/index.js"), ALLOW),
            (
                "HEAD of a UI asset",
                facts(&head, "/assets/index.js"),
                ALLOW,
            ),
            (
                "an internal route",
                facts(&post, "/api/internal/dispatch"),
                ALLOW,
            ),
            (
                "the OAuth callback",
                facts(&get, "/api/mcp/auth/callback"),
                ALLOW,
            ),
            (
                "a CSP violation report",
                facts(&post, "/api/csp-report"),
                ALLOW,
            ),
            (
                "a GET of the CSP report path",
                facts(&get, "/api/csp-report"),
                NO_TOKEN,
            ),
            (
                "a CSP violation report from a bad host",
                RequestFacts {
                    host: evil,
                    ..facts(&post, "/api/csp-report")
                },
                BAD_HOST,
            ),
            ("a POST to the UI", facts(&post, "/"), NO_TOKEN),
            (
                "a POST to the OAuth callback",
                facts(&post, "/api/mcp/auth/callback"),
                NO_TOKEN,
            ),
            ("HEAD of an API path", facts(&head, "/api/fs/dir"), NO_TOKEN),
            // 4. The header token counts everywhere.
            (
                "an API path without a token",
                facts(&get, "/api/fs/dir"),
                NO_TOKEN,
            ),
            (
                "an API path with the header token",
                RequestFacts {
                    header_token: Some(token),
                    ..facts(&get, "/api/fs/dir")
                },
                ALLOW,
            ),
            (
                "an API path with a wrong header token",
                RequestFacts {
                    header_token: Some(wrong),
                    ..facts(&get, "/api/fs/dir")
                },
                NO_TOKEN,
            ),
            (
                "a socket upgrade with the header token",
                RequestFacts {
                    header_token: Some(token),
                    websocket_upgrade: true,
                    ..facts(&get, "/ws/sessions")
                },
                ALLOW,
            ),
            // 5. The query token counts on socket upgrades and the status
            //    stream only.
            (
                "an API path with only the query token",
                RequestFacts {
                    query_token: Some(token),
                    ..facts(&get, "/api/fs/dir")
                },
                NO_TOKEN,
            ),
            (
                "an upgrade on an API path with only the query token",
                RequestFacts {
                    query_token: Some(token),
                    websocket_upgrade: true,
                    ..facts(&get, "/api/fs/dir")
                },
                NO_TOKEN,
            ),
            (
                "a socket upgrade with the query token",
                RequestFacts {
                    query_token: Some(token),
                    websocket_upgrade: true,
                    ..facts(&get, "/ws/sessions")
                },
                ALLOW,
            ),
            (
                "a socket path with the query token, not upgrading",
                RequestFacts {
                    query_token: Some(token),
                    ..facts(&get, "/ws/sessions")
                },
                NO_TOKEN,
            ),
            (
                "a POST socket upgrade with the query token",
                RequestFacts {
                    query_token: Some(token),
                    websocket_upgrade: true,
                    ..facts(&post, "/ws/sessions")
                },
                NO_TOKEN,
            ),
            (
                "a socket upgrade with a wrong query token",
                RequestFacts {
                    query_token: Some(wrong),
                    websocket_upgrade: true,
                    ..facts(&get, "/ws/sessions")
                },
                NO_TOKEN,
            ),
            (
                "the status stream with the query token",
                RequestFacts {
                    query_token: Some(token),
                    ..facts(&get, "/events/status")
                },
                ALLOW,
            ),
            (
                "the status stream without a token",
                facts(&get, "/events/status"),
                NO_TOKEN,
            ),
            (
                "a POST to the status stream with the query token",
                RequestFacts {
                    query_token: Some(token),
                    ..facts(&post, "/events/status")
                },
                NO_TOKEN,
            ),
            (
                "another stream with the query token",
                RequestFacts {
                    query_token: Some(token),
                    ..facts(&get, "/events/other")
                },
                NO_TOKEN,
            ),
            // 6. Everything else.
            (
                "an unknown API path",
                facts(&get, "/api/no-such-route"),
                NO_TOKEN,
            ),
        ];
        for (name, facts, want) in rows {
            assert_eq!(decide(&facts, &policy), want, "{name}");
        }
    }

    #[test]
    fn without_the_token_requirement_only_the_host_is_checked() {
        let policy = policy(false);
        let (get, post) = (Method::GET, Method::POST);

        assert_eq!(decide(&facts(&get, "/api/fs/dir"), &policy), Verdict::Allow);
        assert_eq!(
            decide(&facts(&post, "/api/sessions"), &policy),
            Verdict::Allow
        );
        assert_eq!(
            decide(
                &RequestFacts {
                    host: Some("evil.example:8765"),
                    ..facts(&get, "/api/fs/dir")
                },
                &policy
            ),
            Verdict::Forbidden("host")
        );
    }

    /// A few routes behind the guard with `policy`: what it answers.
    async fn through(policy: &AccessPolicy, req: Request<Body>) -> (StatusCode, String) {
        let ok = || async { "ok" };
        let app = Router::new()
            .route("/api/x", get(ok).post(ok))
            .route("/ws/x", get(ok))
            .route("/events/status", get(ok))
            .layer(from_fn_with_state(policy.clone(), guard));
        let resp = app.oneshot(req).await.unwrap();
        let status = resp.status();
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        (status, String::from_utf8_lossy(&body).into_owned())
    }

    /// Through a guard that checks only the host.
    async fn through_guard(req: Request<Body>) -> (StatusCode, String) {
        through(&policy(false), req).await
    }

    fn request(uri: &str, hosts: &[&str]) -> Request<Body> {
        let mut req = Request::builder().uri(uri);
        for host in hosts {
            req = req.header("host", *host);
        }
        req.body(Body::empty()).unwrap()
    }

    /// `GET uri` on the backend's own address, with `headers`.
    fn get_with(uri: &str, headers: &[(&str, &str)]) -> Request<Body> {
        let mut req = Request::builder().uri(uri).header("host", "127.0.0.1:8765");
        for (name, value) in headers {
            req = req.header(*name, *value);
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
    async fn the_guard_reads_the_token_header_and_counts_two_as_none() {
        let policy = policy(true);
        let token = policy.token.as_str();
        let status = |req: Request<Body>| async { through(&policy, req).await.0 };

        assert_eq!(status(get_with("/api/x", &[])).await, StatusCode::FORBIDDEN);
        assert_eq!(
            status(get_with("/api/x", &[("x-fleetify-token", token)])).await,
            StatusCode::OK
        );
        assert_eq!(
            status(get_with("/api/x", &[("X-Fleetify-Token", token)])).await,
            StatusCode::OK
        );
        assert_eq!(
            status(get_with(
                "/api/x",
                &[(API_TOKEN_HEADER, token), (API_TOKEN_HEADER, token)]
            ))
            .await,
            StatusCode::FORBIDDEN
        );
    }

    #[tokio::test]
    async fn the_guard_takes_the_query_token_on_a_socket_upgrade_or_the_status_stream() {
        let policy = policy(true);
        let token = policy.token.as_str();
        let status = |req: Request<Body>| async { through(&policy, req).await.0 };
        let upgrade = [("connection", "Upgrade"), ("upgrade", "websocket")];
        let socket = format!("/ws/x?{API_TOKEN_QUERY}={token}");

        assert_eq!(status(get_with(&socket, &upgrade)).await, StatusCode::OK);
        // Connection is a list, and both values are case-insensitive.
        assert_eq!(
            status(get_with(
                &socket,
                &[
                    ("connection", "keep-alive, upgrade"),
                    ("upgrade", "WebSocket")
                ]
            ))
            .await,
            StatusCode::OK
        );
        // Not a WebSocket upgrade.
        for headers in [
            &[][..],
            &[("upgrade", "websocket")][..],
            &[("connection", "upgrade"), ("upgrade", "h2c")][..],
        ] {
            assert_eq!(
                status(get_with(&socket, headers)).await,
                StatusCode::FORBIDDEN
            );
        }
        // The value is percent-decoded, as any query value is.
        let encoded = format!(
            "/ws/x?other=1&{API_TOKEN_QUERY}=%{:02X}{}",
            token.as_bytes()[0],
            &token[1..]
        );
        assert_eq!(status(get_with(&encoded, &upgrade)).await, StatusCode::OK);
        // Twice counts as none.
        let twice = format!("/ws/x?{API_TOKEN_QUERY}={token}&{API_TOKEN_QUERY}={token}");
        assert_eq!(
            status(get_with(&twice, &upgrade)).await,
            StatusCode::FORBIDDEN
        );
        // The status stream takes it without an upgrade.
        let stream = format!("/events/status?{API_TOKEN_QUERY}={token}");
        assert_eq!(status(get_with(&stream, &[])).await, StatusCode::OK);
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

    #[tokio::test]
    async fn a_token_refusal_is_plain_text_and_its_log_line_has_neither_token() {
        let logs = LogCapture::start();
        let req = get_with(
            "/api/x?api_token=query-SECRET",
            &[(API_TOKEN_HEADER, "header-SECRET")],
        );
        let (status, body) = through(&policy(true), req).await;
        let text = logs.text();

        assert_eq!(
            (status, body.as_str()),
            (StatusCode::FORBIDDEN, "forbidden")
        );
        assert!(text.contains(r#"reason="token""#), "{text}");
        assert!(text.contains("method=GET"), "{text}");
        assert!(text.contains(r#"path="/api/x""#), "{text}");
        assert!(!text.contains("SECRET"), "a token was logged");
    }
}
