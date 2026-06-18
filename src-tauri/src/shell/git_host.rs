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

/// Probe live auth state, then [`pick_method`]. `stored` comes through the IPC
/// from the renderer's `localStorage["fleet:github-auth-method"]`.
pub async fn resolve_auth_method(
    folder: &Path,
    requested: Option<&str>,
    stored: Option<&str>,
) -> Option<AuthMethod> {
    let has_link = super::github_link::get_link().await.is_some();
    let gh_ready = super::git::gh_is_ready(folder).await;
    pick_method(requested, has_link, gh_ready, stored)
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

pub async fn host_list_prs(
    folder: &Path,
    requested: Option<&str>,
    stored: Option<&str>,
    limit: u32,
) -> Value {
    match resolve_auth_method(folder, requested, stored).await {
        Some(AuthMethod::Gh) => super::git::list_prs(folder, limit).await,
        Some(AuthMethod::Rest) => match oauth_token().await {
            Some(t) => super::github_pr::list_prs_rest(folder, &t, limit).await,
            None => no_auth(),
        },
        None => no_auth(),
    }
}

pub async fn host_get_pr_status(
    folder: &Path,
    requested: Option<&str>,
    stored: Option<&str>,
    n: Option<u64>,
) -> Value {
    match resolve_auth_method(folder, requested, stored).await {
        Some(AuthMethod::Gh) => super::git::get_pr_status(folder, n).await,
        Some(AuthMethod::Rest) => match oauth_token().await {
            Some(t) => super::github_pr::get_pr_status_rest(folder, &t, n).await,
            None => no_auth(),
        },
        None => no_auth(),
    }
}

pub async fn host_pr_ready(
    folder: &Path,
    requested: Option<&str>,
    stored: Option<&str>,
    n: u64,
) -> Value {
    match resolve_auth_method(folder, requested, stored).await {
        Some(AuthMethod::Gh) => super::git::pr_ready(folder, n).await,
        Some(AuthMethod::Rest) => match oauth_token().await {
            Some(t) => super::github_pr::pr_ready_rest(folder, &t, n).await,
            None => no_auth(),
        },
        None => no_auth(),
    }
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
    match auth {
        Some(AuthMethod::Gh) => super::git::merge_pr(folder, n, method).await,
        Some(AuthMethod::Rest) => match oauth_token().await {
            Some(t) => super::github_pr::merge_pr_rest(folder, &t, n, method).await,
            None => no_auth(),
        },
        None => no_auth(),
    }
}

pub async fn host_delete_remote_branch(
    folder: &Path,
    requested: Option<&str>,
    stored: Option<&str>,
    branch: &str,
) -> Value {
    match resolve_auth_method(folder, requested, stored).await {
        Some(AuthMethod::Gh) => super::git::delete_remote_branch_gh(folder, branch).await,
        Some(AuthMethod::Rest) => match oauth_token().await {
            Some(t) => super::github_pr::delete_remote_branch_rest(folder, &t, branch).await,
            None => no_auth(),
        },
        // No auth → the branch may already be gone via the merge; not fatal.
        None => json!({ "ok": true, "noop": true, "code": "NO_AUTH" }),
    }
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
}
