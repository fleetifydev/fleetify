//! Routing layer that sends each PR op to the gh-CLI backend or the
//! token-auth'd REST/GraphQL backend, per the user's auth method.
//!
//! Why: the app's `keyring` crate uses the kernel keyring on Linux, and the
//! gh-CLI path requires the gh binary — so an OAuth-only user without gh could
//! create a PR (REST) but not list/status/ready/merge (gh-only). This module
//! gives every PR op a backend chosen from the user's auth method, so the full
//! lifecycle works on whichever way they signed in.
//!
//! See docs/superpowers/specs/2026-06-06-create-pr-flow-design.md §5.4 (C1).

use std::path::Path;

use serde_json::{json, Value};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthMethod {
    /// gh CLI (binary required; `gh()` injects the OAuth token as GH_TOKEN).
    Gh,
    /// Token-auth'd REST/GraphQL via `github_pr` (no binary needed).
    Rest,
}

/// Pure decision: which backend to use given probed auth state.
///
/// - `requested`: caller's explicit method (`"gh"`/`"cli"` | `"oauth"`/`"link"`).
/// - `has_oauth_link`: an in-app GitHub OAuth link exists in the keychain.
/// - `gh_ready`: the gh binary is installed AND authenticated.
/// - `stored`: the renderer's remembered choice (`"cli"`/`"oauth"`).
///
/// Returns `None` when no usable auth exists — the caller then opens the
/// AuthChoicePopover. When neither a request nor a stored choice applies, an
/// OAuth link wins over gh (matches "signed in with GitHub in-app → OAuth").
pub fn pick_method(
    requested: Option<&str>,
    has_oauth_link: bool,
    gh_ready: bool,
    stored: Option<&str>,
) -> Option<AuthMethod> {
    if matches!(requested, Some("oauth") | Some("link")) {
        return has_oauth_link.then_some(AuthMethod::Rest);
    }
    if matches!(requested, Some("gh") | Some("cli")) {
        return gh_ready.then_some(AuthMethod::Gh);
    }
    match stored {
        Some("oauth") if has_oauth_link => return Some(AuthMethod::Rest),
        Some("cli") if gh_ready => return Some(AuthMethod::Gh),
        _ => {}
    }
    if has_oauth_link {
        Some(AuthMethod::Rest)
    } else if gh_ready {
        Some(AuthMethod::Gh)
    } else {
        None
    }
}

/// Outcome of the *pre-probe* decision: can we pick a backend from the
/// caller's explicit request / remembered choice WITHOUT spawning the slow
/// `gh auth status`?
///
/// - `Gh` — a `"gh"`/`"cli"` preference. The gh backend is trusted; the actual
///   data call (`gh pr view` / `gh pr list`) validates the token, and the
///   renderer keeps prior state on a transient failure. No probe.
/// - `RestIfLinked` — an `"oauth"`/`"link"` preference. Resolves to `Rest`
///   only if a keychain link exists (a cheap async keychain read, NOT a gh
///   spawn). If no link, fall through to auto-detect.
/// - `AutoDetect` — no decisive preference; the full live probe + [`pick_method`]
///   is required (this is the only path that may spawn `gh auth status`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DecidedAuth {
    Gh,
    RestIfLinked,
    AutoDetect,
}

/// The auth method decided purely from the caller's explicit request and the
/// renderer's remembered choice, BEFORE any gh probing. Pure + unit-tested so
/// the "skip the gh spawn for a configured user" rule can't silently regress.
///
/// `Gh` is returned without any I/O. `RestIfLinked` still needs a cheap
/// keychain read (no gh spawn). `AutoDetect` means we have no usable signal and
/// must run the full probe. Mirrors [`pick_method`]'s preference ordering:
/// an explicit `requested` wins, else the `stored` choice, else auto-detect.
pub fn decided_from_request(requested: Option<&str>, stored: Option<&str>) -> DecidedAuth {
    match requested {
        Some("gh") | Some("cli") => return DecidedAuth::Gh,
        Some("oauth") | Some("link") => return DecidedAuth::RestIfLinked,
        _ => {}
    }
    match stored {
        Some("cli") => DecidedAuth::Gh,
        Some("oauth") => DecidedAuth::RestIfLinked,
        _ => DecidedAuth::AutoDetect,
    }
}

// ── Auth-method cache codec (PR status/list hot path) ──
//
// `integrations_cache` stores the auto-detected method as a small `u8`
// discriminant behind a TTL. These map `AuthMethod` ⇄ that code so the
// cache module stays decoupled from this enum.

fn auth_to_code(m: AuthMethod) -> u8 {
    match m {
        AuthMethod::Gh => 1,
        AuthMethod::Rest => 2,
    }
}

fn code_to_auth(code: u8) -> Option<AuthMethod> {
    match code {
        1 => Some(AuthMethod::Gh),
        2 => Some(AuthMethod::Rest),
        _ => None,
    }
}

/// Probe live auth state, then [`pick_method`]. `stored` comes through the IPC
/// from the renderer's `localStorage["fleet:github-auth-method"]`.
///
/// Fast paths first: when the request/stored choice is decisive we skip the
/// `gh auth status` spawn entirely (a `"cli"`/`"gh"` user never pays it). Only
/// the auto-detect branch — reached when no decisive preference exists — runs
/// the live probe, and its result is cached globally with a short TTL
/// (`integrations_cache::{get,set}_auth_method`) so a burst of PR polls pays at
/// most one `gh auth status` per TTL window.
pub async fn resolve_auth_method(
    folder: &Path,
    requested: Option<&str>,
    stored: Option<&str>,
) -> Option<AuthMethod> {
    match decided_from_request(requested, stored) {
        // Trust the explicit gh/cli choice — no probe. The data call
        // validates the token; the renderer tolerates a transient miss.
        DecidedAuth::Gh => return Some(AuthMethod::Gh),
        // oauth/link choice: cheap keychain read only, still no gh spawn.
        DecidedAuth::RestIfLinked => {
            if super::github_link::get_link().await.is_some() {
                return Some(AuthMethod::Rest);
            }
            // No link despite an oauth preference — fall through to
            // auto-detect (gh may still be usable).
        }
        DecidedAuth::AutoDetect => {}
    }

    // Auto-detect: the only branch that may spawn `gh auth status`. Serve a
    // cached result within TTL to keep the spawn off the PR-poll hot path.
    if let Some(code) = super::integrations_cache::get_auth_method() {
        if let Some(m) = code_to_auth(code) {
            return Some(m);
        }
    }

    let has_link = super::github_link::get_link().await.is_some();
    let gh_ready = super::git::gh_is_ready(folder).await;
    let resolved = pick_method(requested, has_link, gh_ready, stored);

    // Cache only a positive resolution. A `None` (no usable auth) is left
    // uncached so a user who connects mid-session sees it next poll, not
    // after the TTL.
    if let Some(m) = resolved {
        super::integrations_cache::set_auth_method(auth_to_code(m));
    }
    resolved
}

// ─── Dispatch: route each PR op to the chosen backend ───

async fn oauth_token() -> Option<String> {
    super::github_link::get_link().await.and_then(|l| {
        l.get("access_token")
            .and_then(|v| v.as_str())
            .map(String::from)
    })
}

fn no_auth() -> Value {
    json!({
        "ok": false,
        "code": "NO_AUTH",
        "error": "No GitHub authentication. Connect GitHub in Settings → Integrations or install the gh CLI."
    })
}

/// Case-insensitive `error`-string signatures that mean "the GitHub auth is no
/// longer valid" — emitted by either backend when a PR op fails on a logged-out
/// / expired / bad token. Deliberately narrow: network/rate-limit/merge-block
/// errors carry none of these, so they never trip the reset.
const AUTH_ERROR_SIGNATURES: &[&str] = &[
    "not logged in",
    "gh auth login",
    "authentication failed",
    "bad credentials",
    "http 401",
    "401 unauthorized",
    "requires authentication",
    "could not read username",
    "token expired",
];

/// True when a PR-op result indicates the GitHub auth is no longer valid
/// (logged out / expired / bad credentials) — as opposed to a transient
/// network/rate-limit error or success. Keyed off the result's `code` and a
/// case-insensitive scan of `error` for auth signatures. Pure + tested.
pub fn is_auth_failure(result: &serde_json::Value) -> bool {
    // Only failures count. A success (or a missing/true `ok`) is never an auth
    // failure — guard first so we never reset on a healthy result.
    if result.get("ok").and_then(Value::as_bool) != Some(false) {
        return false;
    }
    // Explicit auth codes the backends already emit.
    if let Some(code) = result.get("code").and_then(Value::as_str) {
        if code == "NO_AUTH" || code == "AUTH_FAILED" {
            return true;
        }
    }
    // Otherwise scan the human-readable error for an auth signature.
    if let Some(err) = result.get("error").and_then(Value::as_str) {
        let lower = err.to_lowercase();
        return AUTH_ERROR_SIGNATURES.iter().any(|sig| lower.contains(sig));
    }
    false
}

/// Detect a stale-auth failure on a PR-op result and, if so, reset the shared
/// auth state: drop the cached auto-detected method (so the next call re-probes
/// or re-routes) and tag the result `AUTH_FAILED` (unless it already carries an
/// auth code) so the renderer can uniformly reset its GitHub connection state.
/// A no-op on success / transient failures. Returns `r` for call-site chaining.
fn tag_and_reset_on_auth_failure(mut r: Value) -> Value {
    if is_auth_failure(&r) {
        super::integrations_cache::invalidate_auth_method();
        if let Some(obj) = r.as_object_mut() {
            // Normalize so the renderer can react uniformly. Leave an existing
            // code (e.g. NO_AUTH) untouched — it already signals auth.
            obj.entry("code").or_insert(json!("AUTH_FAILED"));
        }
    }
    r
}

pub async fn host_list_prs(
    folder: &Path,
    requested: Option<&str>,
    stored: Option<&str>,
    limit: u32,
) -> Value {
    let r = match resolve_auth_method(folder, requested, stored).await {
        Some(AuthMethod::Gh) => super::git::list_prs(folder, limit).await,
        Some(AuthMethod::Rest) => match oauth_token().await {
            Some(t) => super::github_pr::list_prs_rest(folder, &t, limit).await,
            None => no_auth(),
        },
        None => no_auth(),
    };
    tag_and_reset_on_auth_failure(r)
}

pub async fn host_get_pr_status(
    folder: &Path,
    requested: Option<&str>,
    stored: Option<&str>,
    n: Option<u64>,
) -> Value {
    let r = match resolve_auth_method(folder, requested, stored).await {
        Some(AuthMethod::Gh) => super::git::get_pr_status(folder, n).await,
        Some(AuthMethod::Rest) => match oauth_token().await {
            Some(t) => super::github_pr::get_pr_status_rest(folder, &t, n).await,
            None => no_auth(),
        },
        None => no_auth(),
    };
    tag_and_reset_on_auth_failure(r)
}

pub async fn host_pr_ready(
    folder: &Path,
    requested: Option<&str>,
    stored: Option<&str>,
    n: u64,
) -> Value {
    let r = match resolve_auth_method(folder, requested, stored).await {
        Some(AuthMethod::Gh) => super::git::pr_ready(folder, n).await,
        Some(AuthMethod::Rest) => match oauth_token().await {
            Some(t) => super::github_pr::pr_ready_rest(folder, &t, n).await,
            None => no_auth(),
        },
        None => no_auth(),
    };
    tag_and_reset_on_auth_failure(r)
}

pub async fn host_merge_pr(
    folder: &Path,
    requested: Option<&str>,
    stored: Option<&str>,
    n: u64,
    method: &str,
) -> Value {
    let auth = resolve_auth_method(folder, requested, stored).await;
    let backend = match auth {
        Some(AuthMethod::Gh) => "gh",
        Some(AuthMethod::Rest) => "rest",
        None => "no-auth",
    };
    tracing::info!(target: "merge", "dispatch · {backend} · #{n}");
    let r = match auth {
        Some(AuthMethod::Gh) => super::git::merge_pr(folder, n, method).await,
        Some(AuthMethod::Rest) => match oauth_token().await {
            Some(t) => super::github_pr::merge_pr_rest(folder, &t, n, method).await,
            None => no_auth(),
        },
        None => no_auth(),
    };
    tag_and_reset_on_auth_failure(r)
}

pub async fn host_rerun_check_job(
    folder: &Path,
    requested: Option<&str>,
    stored: Option<&str>,
    job_id: u64,
) -> Value {
    let r = match resolve_auth_method(folder, requested, stored).await {
        Some(AuthMethod::Gh) => super::git::rerun_check_job(folder, job_id).await,
        Some(AuthMethod::Rest) => match oauth_token().await {
            Some(t) => super::github_pr::rerun_check_job_rest(folder, &t, job_id).await,
            None => no_auth(),
        },
        None => no_auth(),
    };
    tag_and_reset_on_auth_failure(r)
}

pub async fn host_rerun_failed_checks(
    folder: &Path,
    requested: Option<&str>,
    stored: Option<&str>,
    run_ids: &[u64],
) -> Value {
    let r = match resolve_auth_method(folder, requested, stored).await {
        Some(AuthMethod::Gh) => super::git::rerun_failed_checks(folder, run_ids).await,
        Some(AuthMethod::Rest) => match oauth_token().await {
            Some(t) => super::github_pr::rerun_failed_checks_rest(folder, &t, run_ids).await,
            None => no_auth(),
        },
        None => no_auth(),
    };
    tag_and_reset_on_auth_failure(r)
}

pub async fn host_delete_remote_branch(
    folder: &Path,
    requested: Option<&str>,
    stored: Option<&str>,
    branch: &str,
) -> Value {
    let r = match resolve_auth_method(folder, requested, stored).await {
        Some(AuthMethod::Gh) => super::git::delete_remote_branch_gh(folder, branch).await,
        Some(AuthMethod::Rest) => match oauth_token().await {
            Some(t) => super::github_pr::delete_remote_branch_rest(folder, &t, branch).await,
            None => no_auth(),
        },
        // No auth → the branch may already be gone via the merge; not fatal.
        // `ok:true` here, so `is_auth_failure` correctly treats it as success.
        None => json!({ "ok": true, "noop": true, "code": "NO_AUTH" }),
    };
    tag_and_reset_on_auth_failure(r)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requested_method_is_honored_when_available() {
        assert_eq!(
            pick_method(Some("oauth"), true, true, None),
            Some(AuthMethod::Rest)
        );
        assert_eq!(
            pick_method(Some("gh"), true, true, None),
            Some(AuthMethod::Gh)
        );
    }

    #[test]
    fn requested_method_unavailable_returns_none() {
        assert_eq!(pick_method(Some("oauth"), false, true, None), None);
        assert_eq!(pick_method(Some("gh"), true, false, None), None);
    }

    #[test]
    fn stored_choice_wins_then_link_then_gh() {
        assert_eq!(
            pick_method(None, true, true, Some("cli")),
            Some(AuthMethod::Gh)
        );
        assert_eq!(
            pick_method(None, true, true, Some("oauth")),
            Some(AuthMethod::Rest)
        );
        // No stored choice: OAuth link beats gh.
        assert_eq!(pick_method(None, true, true, None), Some(AuthMethod::Rest));
        assert_eq!(pick_method(None, false, true, None), Some(AuthMethod::Gh));
        assert_eq!(pick_method(None, false, false, None), None);
    }

    #[test]
    fn no_auth_envelope_shape() {
        let v = no_auth();
        assert_eq!(v["ok"], false);
        assert_eq!(v["code"], "NO_AUTH");
    }

    #[test]
    fn decided_requested_cli_or_gh_skips_probe() {
        // An explicit gh/cli request resolves to Gh with NO probing — this is
        // the perf fix's whole point: a configured CLI user never spawns
        // `gh auth status`.
        assert_eq!(decided_from_request(Some("gh"), None), DecidedAuth::Gh);
        assert_eq!(decided_from_request(Some("cli"), None), DecidedAuth::Gh);
        // The request wins even over a conflicting stored choice.
        assert_eq!(
            decided_from_request(Some("gh"), Some("oauth")),
            DecidedAuth::Gh
        );
    }

    #[test]
    fn decided_requested_oauth_needs_link() {
        // oauth/link requests need the cheap keychain check (RestIfLinked),
        // never a gh spawn.
        assert_eq!(
            decided_from_request(Some("oauth"), None),
            DecidedAuth::RestIfLinked
        );
        assert_eq!(
            decided_from_request(Some("link"), Some("cli")),
            DecidedAuth::RestIfLinked
        );
    }

    #[test]
    fn decided_stored_cli_skips_probe_oauth_needs_link() {
        // No request → fall back to the remembered choice.
        assert_eq!(decided_from_request(None, Some("cli")), DecidedAuth::Gh);
        assert_eq!(
            decided_from_request(None, Some("oauth")),
            DecidedAuth::RestIfLinked
        );
    }

    #[test]
    fn decided_nothing_or_skip_needs_autodetect() {
        // Neither a request nor a usable stored choice → the full probe path.
        assert_eq!(decided_from_request(None, None), DecidedAuth::AutoDetect);
        // The onboarding "skip" sentinel is not a backend choice → auto-detect
        // (matches pick_method, which ignores unknown stored values).
        assert_eq!(
            decided_from_request(None, Some("skip")),
            DecidedAuth::AutoDetect
        );
        assert_eq!(
            decided_from_request(Some("nonsense"), Some("skip")),
            DecidedAuth::AutoDetect
        );
    }

    #[test]
    fn auth_code_round_trips() {
        assert_eq!(
            code_to_auth(auth_to_code(AuthMethod::Gh)),
            Some(AuthMethod::Gh)
        );
        assert_eq!(
            code_to_auth(auth_to_code(AuthMethod::Rest)),
            Some(AuthMethod::Rest)
        );
        // Unknown codes decode to None (defensive — never cached by us).
        assert_eq!(code_to_auth(0), None);
        assert_eq!(code_to_auth(99), None);
    }

    #[test]
    fn auth_failure_detected_from_codes() {
        // The REST `no_auth()` shape and the normalized tag both count.
        assert!(is_auth_failure(&json!({ "ok": false, "code": "NO_AUTH" })));
        assert!(is_auth_failure(
            &json!({ "ok": false, "code": "AUTH_FAILED" })
        ));
    }

    #[test]
    fn auth_failure_detected_from_each_error_phrase() {
        // Every signature phrase must trip the detector (case-insensitively),
        // mixed into realistic backend error strings.
        let phrases = [
            "You are not logged in to any GitHub hosts.",
            "To get started with GitHub CLI, please run: gh auth login",
            "authentication failed for 'https://github.com/...'",
            "HTTP 401: Bad credentials (https://api.github.com/...)",
            "remote: HTTP 401 — token rejected",
            "pull view: 401 Unauthorized",
            "GraphQL: Resource not accessible, requires authentication",
            "fatal: could not read Username for 'https://github.com'",
            "Your token expired; sign in again.",
        ];
        for p in phrases {
            assert!(
                is_auth_failure(&json!({ "ok": false, "error": p })),
                "expected auth-failure for error: {p}"
            );
            // Same string upper-cased — the scan is case-insensitive.
            assert!(
                is_auth_failure(&json!({ "ok": false, "error": p.to_uppercase() })),
                "expected auth-failure for upper-cased error: {p}"
            );
        }
    }

    #[test]
    fn transient_and_network_failures_are_not_auth() {
        // A timeout / dial error must NOT reset auth.
        assert!(!is_auth_failure(
            &json!({ "ok": false, "error": "dial tcp: i/o timeout" })
        ));
        // reqwest NETWORK fail shape.
        assert!(!is_auth_failure(
            &json!({ "ok": false, "code": "NETWORK", "error": "error sending request" })
        ));
        // A 403 rate-limit is auth-adjacent but NOT a stale-credential signal.
        assert!(!is_auth_failure(
            &json!({ "ok": false, "error": "HTTP 403: API rate limit exceeded" })
        ));
    }

    #[test]
    fn merge_block_failure_is_not_auth() {
        // A blocked / conflicting merge is a real failure but not an auth one.
        assert!(!is_auth_failure(&json!({
            "ok": false,
            "code": "MERGE_BLOCKED",
            "error": "Pull request is not mergeable: merge conflict"
        })));
    }

    #[test]
    fn success_is_never_auth_failure() {
        assert!(!is_auth_failure(&json!({ "ok": true })));
        // Even a success that happens to mention an auth word in some field.
        assert!(!is_auth_failure(
            &json!({ "ok": true, "error": "bad credentials" })
        ));
        // `noop` delete path (ok:true with a NO_AUTH code) is NOT a failure.
        assert!(!is_auth_failure(
            &json!({ "ok": true, "noop": true, "code": "NO_AUTH" })
        ));
    }

    #[test]
    fn missing_fields_are_not_auth_failure() {
        // No `ok` at all → not a failure (we only act on explicit ok:false).
        assert!(!is_auth_failure(&json!({})));
        assert!(!is_auth_failure(&json!({ "error": "bad credentials" })));
        // ok:false but no recognizable code/error → not an auth failure.
        assert!(!is_auth_failure(&json!({ "ok": false })));
        assert!(!is_auth_failure(
            &json!({ "ok": false, "error": "something unrelated broke" })
        ));
        // Non-string error / code fields are ignored, not panicked on.
        assert!(!is_auth_failure(
            &json!({ "ok": false, "code": 401, "error": 42 })
        ));
    }

    #[test]
    fn tag_and_reset_normalizes_code_on_auth_failure() {
        // A code-less auth failure (error-phrase only) gets tagged AUTH_FAILED.
        let tagged = tag_and_reset_on_auth_failure(json!({
            "ok": false,
            "error": "HTTP 401: Bad credentials"
        }));
        assert_eq!(tagged["code"], "AUTH_FAILED");
        assert_eq!(tagged["ok"], false);

        // An existing NO_AUTH code is preserved (already signals auth).
        let preserved = tag_and_reset_on_auth_failure(json!({ "ok": false, "code": "NO_AUTH" }));
        assert_eq!(preserved["code"], "NO_AUTH");

        // A transient failure is returned untouched — no `code` injected.
        let untouched =
            tag_and_reset_on_auth_failure(json!({ "ok": false, "error": "i/o timeout" }));
        assert_eq!(untouched.get("code"), None);

        // A success passes through unchanged.
        let ok = tag_and_reset_on_auth_failure(json!({ "ok": true, "prNumber": 7 }));
        assert_eq!(ok["ok"], true);
        assert_eq!(ok["prNumber"], 7);
    }
}
