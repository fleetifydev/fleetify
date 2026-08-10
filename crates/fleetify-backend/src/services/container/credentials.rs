//! Getting a session authenticated on the other side of the container
//! boundary.
//!
//! Three tiers, tried in order. This is deliberately NOT "mount the host
//! home" — that hands every provider's session token to a container running
//! repository code, which is the failure Anthropic's own dev-container
//! guidance calls out (and it breaks anyway: those CLIs write to their home,
//! so a read-only mount fails and a read-write one lets the container corrupt
//! the host's login).
//!
//! * **Tier A — env injection (always on).** Forward the provider's own
//!   documented key/token variable and rewrite host-loopback base URLs so
//!   they resolve from inside. Narrow, auditable, no host state exposed.
//! * **Tier B — scoped provider-home mount (opt-in per session).** Mount only
//!   that provider's credential directory. Never `$HOME`, never `~/.ssh`.
//!   The only path that carries an OAuth subscription login rather than an
//!   API key.
//! * **Tier C — in-container login (fallback).** Nothing crosses. When Tier A
//!   found no credential and Tier B is off, say so BEFORE spawning, naming
//!   the container and the fix, instead of letting the CLI fail mid-stream.

use crate::services::container::providers::{spec_for, ContainerSupport};

/// What crosses the boundary for one (provider, session) pair.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Resolved {
    /// `-e` pairs to place ahead of the container id.
    pub envs: Vec<(String, String)>,
    /// `-v host:container` mount specs (Tier B).
    pub mounts: Vec<String>,
    /// Set when nothing usable crossed. A user-facing message, not an error:
    /// the caller turns it into a pre-flight refusal so the reason is visible
    /// instead of the CLI's own opaque auth failure.
    pub missing_credential: Option<String>,
}

/// The name a container resolves to reach a service on the host.
///
/// Docker Desktop provides it automatically; on Linux the daemon needs
/// `--add-host=host.docker.internal:host-gateway`, which the provisioning
/// path adds.
pub const HOST_GATEWAY: &str = "host.docker.internal";

/// Rewrite a URL whose host is the loopback interface so it resolves from
/// inside a container.
///
/// `ANTHROPIC_BASE_URL=http://127.0.0.1:4000` means *the container itself*
/// once inside, so a proxy-backed session silently talks to nothing and the
/// agent runs unauthenticated — no error, just wrong answers. Non-loopback
/// URLs pass through untouched.
///
/// The host is compared exactly, never by substring: a naive
/// `replace("localhost", …)` would rewrite `https://localhost.evil.com` too.
pub fn rewrite_loopback(url: &str) -> String {
    const LOOPBACK: &[&str] = &["127.0.0.1", "localhost", "0.0.0.0", "[::1]", "::1"];

    let Some(scheme_end) = url.find("://") else {
        return url.to_string();
    };
    let after = scheme_end + 3;
    // The authority runs to the first `/`, `?` or `#`.
    let auth_end = url[after..]
        .find(['/', '?', '#'])
        .map(|i| after + i)
        .unwrap_or(url.len());
    let authority = &url[after..auth_end];
    // Strip any userinfo, then split the port off the host.
    let (userinfo, hostport) = match authority.rfind('@') {
        Some(i) => (&authority[..=i], &authority[i + 1..]),
        None => ("", authority),
    };
    let (host, port) = match hostport.rfind(':') {
        // Only treat the tail as a port when it is all digits, so an IPv6
        // literal's internal colons are not mistaken for one.
        Some(i) if hostport[i + 1..].chars().all(|c| c.is_ascii_digit()) => {
            (&hostport[..i], &hostport[i..])
        }
        _ => (hostport, ""),
    };
    if !LOOPBACK.contains(&host) {
        return url.to_string();
    }
    format!(
        "{}{}{}{}{}",
        &url[..after],
        userinfo,
        HOST_GATEWAY,
        port,
        &url[auth_end..]
    )
}

/// Rewrite every loopback URL in an env list in place. Applied to the pairs a
/// bridge already built (proxy base URLs, `FLEETIFY_BACKEND_URL`, …) before
/// they become `-e` flags.
pub fn rewrite_loopback_envs(envs: &mut [(String, String)]) {
    for (_, v) in envs.iter_mut() {
        if v.contains("://") {
            *v = rewrite_loopback(v);
        }
    }
}

/// A GitHub Actions installation token. Copilot CLI requires a *user-scoped*
/// token and rejects these with a confusing error, so we catch it ourselves
/// rather than forwarding a credential we know cannot work.
fn is_actions_installation_token(value: &str) -> bool {
    value.starts_with("ghs_")
}

/// Look a credential up for `var`: the host process env first (this is how
/// CI and `.env` supply them), then Fleetify's keyring under the provider's
/// key id.
fn lookup(var: &str, keyring_id: Option<&str>) -> Option<String> {
    if let Ok(v) = std::env::var(var) {
        if !v.trim().is_empty() {
            return Some(v);
        }
    }
    keyring_id.and_then(crate::providers::keys::get_key)
}

/// The keyring id a provider's API key is stored under, when it has one.
/// These are the ids `providers::keys` already uses — not the routing ids.
fn keyring_id_for(provider_id: &str) -> Option<&'static str> {
    match provider_id {
        "grok-build" => Some("grok"),
        _ => None,
    }
}

/// Resolve everything that crosses the boundary for one turn.
///
/// `host_home` is the host's home directory (for Tier B mount sources);
/// `container_home` is the home inside the container, probed by the caller —
/// it is not knowable statically and differs between `root` and a
/// `node`-style non-root image.
pub fn resolve(
    provider_id: &str,
    mount_credentials: bool,
    host_home: Option<&std::path::Path>,
    container_home: &str,
) -> Resolved {
    let mut out = Resolved::default();
    let Some(spec) = spec_for(provider_id) else {
        out.missing_credential = Some(format!(
            "Fleetify has no container profile for '{provider_id}', so it can't tell what \
             credentials that agent needs inside a container."
        ));
        return out;
    };
    if let ContainerSupport::Unsupported(reason) = spec.support {
        out.missing_credential = Some(reason.to_string());
        return out;
    }

    // ── Tier A ──────────────────────────────────────────────────────
    let keyring_id = keyring_id_for(provider_id);
    let mut forwarded: Option<&str> = None;
    for var in spec.auth_env {
        let Some(value) = lookup(var, keyring_id) else {
            continue;
        };
        if provider_id == "github-copilot" && is_actions_installation_token(&value) {
            // Keep looking — a later variable may hold a real PAT — but
            // remember why this one was skipped.
            out.missing_credential = Some(
                "The GitHub token in your environment is an Actions installation token \
                 (ghs_…), which Copilot CLI rejects. Set COPILOT_GITHUB_TOKEN to a \
                 user-scoped fine-grained PAT with the \"Copilot Requests\" permission, or \
                 run `copilot login` inside the container."
                    .to_string(),
            );
            continue;
        }
        out.envs.push(((*var).to_string(), value));
        forwarded = Some(var);
        break;
    }
    if forwarded.is_some() {
        // A working Tier A credential clears any earlier skip note.
        out.missing_credential = None;
    }

    // ── Tier B ──────────────────────────────────────────────────────
    if mount_credentials {
        if let (Some(home), Some(rel)) = (host_home, spec.credential_home) {
            let src = home.join(rel);
            // Read-write on purpose: these CLIs write session state, refresh
            // tokens and transcripts into their own directory, and a
            // read-only mount fails in a way that looks like a login bug.
            // Scoped to the ONE directory — never $HOME, never ~/.ssh.
            out.mounts.push(format!(
                "{}:{}/{}",
                src.to_string_lossy(),
                container_home.trim_end_matches('/'),
                rel
            ));
            out.missing_credential = None;
        }
    }

    // ── Tier C ──────────────────────────────────────────────────────
    if out.envs.is_empty() && out.mounts.is_empty() && out.missing_credential.is_none() {
        out.missing_credential = Some(tier_c_message(provider_id, spec.auth_env));
    }

    rewrite_loopback_envs(&mut out.envs);
    out
}

/// The "nothing crossed" message. Names the variable to set AND the in-
/// container login, because which one applies depends on whether the user has
/// an API key or a subscription.
fn tier_c_message(provider_id: &str, auth_env: &[&str]) -> String {
    let login = match provider_id {
        "claude-code" => "run `claude` inside the container and sign in",
        "codex-cli" => "run `codex login` inside the container",
        "kimi-code" => "run `kimi` inside the container and send `/login`",
        "cursor-cli" => "run `cursor-agent login` inside the container",
        "grok-build" => "run `grok login` inside the container",
        "opencode" => "run `opencode auth login` inside the container",
        "github-copilot" => "run `copilot login` inside the container",
        "hermes-agent" => "run `hermes setup` inside the container",
        _ => "sign the agent in inside the container",
    };
    match auth_env.first() {
        Some(var) => format!(
            "No credential to pass into the container for this agent. Either set {var} on \
             Fleetify's environment, turn on \"Mount my credentials\" for this session, or \
             {login}."
        ),
        None => format!(
            "This agent has no environment-variable login, so nothing can be passed into the \
             container. Turn on \"Mount my credentials\" for this session, or {login}."
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    /// These tests mutate PROCESS env, which every other test in the binary
    /// shares. Serialise them against each other so a sibling's `set_var`
    /// can't land between this test's own set and read.
    fn env_guard() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// 127.0.0.1 inside a container IS the container. A proxy-backed session
    /// silently reaches nothing without this — the agent just runs
    /// unauthenticated, which is the worst failure available.
    #[test]
    fn loopback_hosts_are_rewritten_to_the_host_gateway() {
        assert_eq!(
            rewrite_loopback("http://127.0.0.1:4000/v1"),
            "http://host.docker.internal:4000/v1"
        );
        assert_eq!(
            rewrite_loopback("http://localhost:8765"),
            "http://host.docker.internal:8765"
        );
        assert_eq!(
            rewrite_loopback("https://0.0.0.0:443/x?y=1"),
            "https://host.docker.internal:443/x?y=1"
        );
        // No port at all.
        assert_eq!(
            rewrite_loopback("http://localhost/v1"),
            "http://host.docker.internal/v1"
        );
    }

    #[test]
    fn non_loopback_urls_are_left_alone() {
        for url in [
            "https://api.anthropic.com",
            "https://api.openai.com/v1",
            // A host that merely CONTAINS the string must not be rewritten —
            // this is why the host is compared exactly rather than replaced.
            "https://localhost.evil.com/x",
            "https://my-localhost:9000/v1",
            "not a url at all",
        ] {
            assert_eq!(rewrite_loopback(url), url, "should not rewrite {url}");
        }
    }

    #[test]
    fn userinfo_survives_the_rewrite() {
        assert_eq!(
            rewrite_loopback("http://user:pass@127.0.0.1:4000/v1"),
            "http://user:pass@host.docker.internal:4000/v1"
        );
    }

    /// Tier A forwards the provider's own key and nothing else.
    #[test]
    fn tier_a_forwards_the_providers_own_key() {
        let _g = env_guard();
        std::env::set_var("MOONSHOT_API_KEY", "moon-secret");
        let r = resolve("kimi-code", false, None, "/root");
        assert!(r
            .envs
            .iter()
            .any(|(k, v)| k == "MOONSHOT_API_KEY" && v == "moon-secret"));
        assert!(r.missing_credential.is_none());
        std::env::remove_var("MOONSHOT_API_KEY");
    }

    /// Tier B mounts ONLY that provider's credential dir — never $HOME,
    /// never ~/.ssh.
    #[test]
    fn tier_b_mounts_only_the_providers_own_credential_dir() {
        let home = Path::new("/home/me");
        let r = resolve("codex-cli", true, Some(home), "/root");
        assert_eq!(r.mounts.len(), 1, "mounts: {:?}", r.mounts);
        let m = &r.mounts[0];
        assert!(m.contains(".codex"), "mount was: {m}");
        assert!(m.ends_with(":/root/.codex"), "mount was: {m}");
        assert!(!m.contains(".ssh"));
        // The whole home must never be the mount source.
        assert!(!m.starts_with("/home/me:"), "mount was: {m}");
    }

    #[test]
    fn tier_b_off_mounts_nothing() {
        let r = resolve("codex-cli", false, Some(Path::new("/home/me")), "/root");
        assert!(r.mounts.is_empty());
    }

    /// A non-root image has a different home, so the mount target has to
    /// follow the probe rather than assume /root.
    #[test]
    fn tier_b_targets_the_probed_container_home() {
        let r = resolve(
            "claude-code",
            true,
            Some(Path::new("/home/me")),
            "/home/node",
        );
        assert!(
            r.mounts[0].ends_with(":/home/node/.claude"),
            "mount was: {}",
            r.mounts[0]
        );
    }

    /// Tier C says so BEFORE the spawn, naming both fixes — which one applies
    /// depends on whether the user has a key or a subscription.
    #[test]
    fn tier_c_reports_the_gap_with_both_remedies() {
        let _g = env_guard();
        std::env::remove_var("MOONSHOT_API_KEY");
        let r = resolve("kimi-code", false, None, "/root");
        let msg = r.missing_credential.expect("should report the gap");
        assert!(msg.contains("MOONSHOT_API_KEY"), "msg: {msg}");
        assert!(msg.contains("kimi"), "msg should name the login: {msg}");
        assert!(msg.contains("Mount my credentials"), "msg: {msg}");
    }

    /// A GitHub Actions installation token is not user-scoped and Copilot CLI
    /// rejects it with a confusing error. Catch it here instead.
    #[test]
    fn copilot_refuses_an_actions_installation_token() {
        let _g = env_guard();
        for v in ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"] {
            std::env::remove_var(v);
        }
        std::env::set_var("GH_TOKEN", "ghs_aninstallationtoken");
        let r = resolve("github-copilot", false, None, "/root");
        assert!(
            !r.envs.iter().any(|(k, _)| k == "GH_TOKEN"),
            "a ghs_ token must not be forwarded: {:?}",
            r.envs
        );
        let msg = r.missing_credential.expect("should explain why");
        assert!(msg.contains("ghs_"), "msg: {msg}");
        assert!(msg.contains("user-scoped"), "msg: {msg}");
        std::env::remove_var("GH_TOKEN");
    }

    /// …but a real user token later in the preference order still wins.
    #[test]
    fn copilot_prefers_a_real_token_over_an_installation_token() {
        let _g = env_guard();
        for v in ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"] {
            std::env::remove_var(v);
        }
        std::env::set_var("GH_TOKEN", "ghs_installation");
        std::env::set_var("GITHUB_TOKEN", "github_pat_real");
        let r = resolve("github-copilot", false, None, "/root");
        assert!(r
            .envs
            .iter()
            .any(|(k, v)| k == "GITHUB_TOKEN" && v == "github_pat_real"));
        assert!(r.missing_credential.is_none(), "{:?}", r.missing_credential);
        std::env::remove_var("GH_TOKEN");
        std::env::remove_var("GITHUB_TOKEN");
    }

    /// A provider with no env-var login at all (antigravity) must say that
    /// plainly rather than name a variable that does not exist.
    #[test]
    fn a_provider_with_no_env_auth_is_refused_by_its_own_reason() {
        let r = resolve("antigravity-cli", false, None, "/root");
        let msg = r.missing_credential.expect("should report");
        assert!(msg.contains("terminal"), "msg: {msg}");
    }

    /// Whatever crosses gets its loopback URLs rewritten on the way out —
    /// otherwise a forwarded base URL points the agent at itself.
    #[test]
    fn forwarded_urls_are_loopback_rewritten() {
        let _g = env_guard();
        std::env::set_var("ANTHROPIC_API_KEY", "http://127.0.0.1:4000");
        let r = resolve("claude-code", false, None, "/root");
        assert!(
            r.envs
                .iter()
                .any(|(_, v)| v == "http://host.docker.internal:4000"),
            "{:?}",
            r.envs
        );
        std::env::remove_var("ANTHROPIC_API_KEY");
    }
}
