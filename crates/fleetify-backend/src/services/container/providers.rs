//! Per-provider container facts.
//!
//! Every value here comes from the vendor's own documentation (verified
//! 2026-08-10) and none of them are guessable from the host code, so each
//! non-obvious one carries the reason inline. A future editor who
//! "simplifies" `--sandbox danger-full-access` away, or swaps `agent` back to
//! the host's `cursor-agent`, breaks that provider in a container with an
//! error that points nowhere near this file.
//!
//! Pure data: no I/O, no daemon, fully unit-testable.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContainerSupport {
    /// Runs in a container with env-injected credentials (Tier A).
    Supported,
    /// Runs, but only off a credential directory carried in from the host
    /// (Tier B) — the CLI documents no environment-variable auth at all.
    NeedsCachedLogin,
    /// Cannot meaningfully run in a container. The string is shown to the user.
    Unsupported(&'static str),
}

#[derive(Debug, Clone, Copy)]
pub struct ProviderContainerSpec {
    /// The binary name **inside** the container. Never a host-resolved path:
    /// `which::which` answers about the host, and a `.cmd` shim or an
    /// absolute host path does not exist on the other side of the boundary.
    pub binary: &'static str,
    /// Auth env vars to forward, most-preferred first.
    pub auth_env: &'static [&'static str],
    /// Extra argv the CLI needs *because* it is in a container — normally
    /// because the container replaced the sandbox the CLI would have built
    /// for itself. Appended to the provider's normal args.
    pub sandbox_args: &'static [&'static str],
    /// `$HOME`-relative directory holding this CLI's credentials, for the
    /// opt-in scoped mount (Tier B). Relative on both sides of the boundary.
    pub credential_home: Option<&'static str>,
    /// Shell command that installs this CLI inside a container Fleetify
    /// provisioned, for the auto-install step. Sourced from each bridge's
    /// own "not found" error message — the same command we already tell
    /// users to run by hand. Executed via `sh -c`; None ⇒ nothing sensible
    /// to run (the provider is refused in containers anyway).
    ///
    /// Auto-install runs ONLY in containers Fleetify started (image /
    /// Dockerfile / compose services it brought up) — never in an attached
    /// container, which belongs to the user.
    pub install_sh: Option<&'static str>,
    pub support: ContainerSupport,
}

/// The sandbox tier codex must use inside a container.
///
/// Codex sandboxes itself with Landlock+seccomp on Linux and Seatbelt on
/// macOS; an ordinary container exposes neither, so every other tier fails to
/// start. This is not a loosening — the container IS the boundary, which is
/// exactly the arrangement the CLI's own documentation recommends for its
/// bypass modes.
///
/// It is a constant rather than a `sandbox_args` entry because Fleetify runs
/// `codex app-server` and passes the tier over the protocol (`thread/start`),
/// where an argv flag would simply be ignored.
pub const CODEX_CONTAINER_SANDBOX: &str = "danger-full-access";

/// The container profile for a canonical provider id, or `None` when the id
/// is unknown. Callers must treat `None` as "refuse by name" rather than
/// "fall through to the host argv" — running an unmapped provider through
/// `docker exec` yields "executable file not found" with no hint which of
/// the ten agents is unmapped.
pub fn spec_for(provider_id: &str) -> Option<&'static ProviderContainerSpec> {
    Some(match provider_id {
        "claude-code" => &ProviderContainerSpec {
            binary: "claude",
            // `claude setup-token` mints CLAUDE_CODE_OAUTH_TOKEN specifically
            // for headless/CI/container use; the API keys are the fallback.
            auth_env: &[
                "CLAUDE_CODE_OAUTH_TOKEN",
                "ANTHROPIC_API_KEY",
                "ANTHROPIC_AUTH_TOKEN",
            ],
            // Deliberately empty. `--dangerously-skip-permissions` is the
            // documented container flag, but the CLI REFUSES it when running
            // as root — and a plain `docker run` container is root by
            // default. It is added by `sandbox::args_for`, which knows the
            // probed container user; putting it here would break every
            // root container with an error that reads like a CLI bug.
            sandbox_args: &[],
            credential_home: Some(".claude"),
            install_sh: Some("npm install -g @anthropic-ai/claude-code"),
            support: ContainerSupport::Supported,
        },
        "codex-cli" => &ProviderContainerSpec {
            binary: "codex",
            auth_env: &["OPENAI_API_KEY"],
            // Empty on purpose: Fleetify drives codex as `codex app-server`,
            // which takes its sandbox over the protocol (`thread/start`), not
            // as argv. `--sandbox` on the command line would be ignored.
            // See CODEX_CONTAINER_SANDBOX for the value that actually applies.
            sandbox_args: &[],
            credential_home: Some(".codex"),
            install_sh: Some("npm install -g @openai/codex"),
            support: ContainerSupport::Supported,
        },
        "kimi-code" => &ProviderContainerSpec {
            binary: "kimi",
            // Kimi Code's own key; MOONSHOT_API_KEY serves its Moonshot
            // platform providers. Its device-flow login lives in
            // `~/.kimi-code/credentials/` (kimi-code 2.8), not `~/.kimi`.
            auth_env: &["KIMI_API_KEY", "MOONSHOT_API_KEY"],
            sandbox_args: &[],
            credential_home: Some(".kimi-code"),
            install_sh: Some("npm install -g @moonshot-ai/kimi-code@latest"),
            support: ContainerSupport::Supported,
        },
        "cursor-cli" => &ProviderContainerSpec {
            // Inside the container the binary on PATH is `agent`. The host
            // resolution prefers `cursor-agent` and wraps it in a cmd.exe
            // shim on Windows; neither may leak into the container argv.
            binary: "agent",
            auth_env: &["CURSOR_API_KEY"],
            // Empty on purpose. `--force` is the *print-mode* flag that lets
            // `agent -p` write files; Fleetify drives `agent acp`, where
            // permissions ride the protocol (`session/request_permission`)
            // instead. Passing a print-mode flag to ACP mode risks an
            // unknown-option exit that closes the stream before the
            // handshake — the same class of mistake as putting codex's
            // sandbox in argv.
            sandbox_args: &[],
            credential_home: Some(".cursor"),
            install_sh: Some("curl https://cursor.com/install -fsS | bash"),
            support: ContainerSupport::Supported,
        },
        "grok-build" => &ProviderContainerSpec {
            binary: "grok",
            // xAI's own SDK reads XAI_API_KEY. GROK_API_KEY is a
            // non-standard name that breaks SDK integrations — never emit it.
            auth_env: &["XAI_API_KEY"],
            sandbox_args: &[],
            credential_home: Some(".grok"),
            install_sh: Some("curl -fsSL https://x.ai/cli/install.sh | bash"),
            support: ContainerSupport::Supported,
        },
        "opencode" => &ProviderContainerSpec {
            binary: "opencode",
            auth_env: &["ANTHROPIC_API_KEY", "OPENAI_API_KEY"],
            sandbox_args: &[],
            // auth.json lives under the XDG *data* dir — NOT the
            // `~/.config/opencode` config home that
            // `plugins::providers::provider_home` returns. Mounting the
            // config home carries settings but no credentials, which fails
            // in the confusing "logged out despite the mount" way.
            credential_home: Some(".local/share/opencode"),
            install_sh: Some("npm install -g opencode-ai"),
            support: ContainerSupport::Supported,
        },
        "github-copilot" => &ProviderContainerSpec {
            binary: "copilot",
            auth_env: &["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"],
            sandbox_args: &[],
            credential_home: Some(".copilot"),
            install_sh: Some("npm install -g @github/copilot"),
            support: ContainerSupport::Supported,
        },
        "hermes-agent" => &ProviderContainerSpec {
            binary: "hermes",
            // Nous documents `-e` provider keys as the CI/secrets path, in
            // preference to the .env file inside the state volume.
            auth_env: &["ANTHROPIC_API_KEY", "OPENAI_API_KEY"],
            sandbox_args: &[],
            // Hermes keeps everything (config, keys, sessions, memory,
            // skills) in one state dir, mounted at /opt/data in its own
            // official image.
            credential_home: Some(".hermes"),
            install_sh: Some("pip install \"hermes-agent[acp]\""),
            support: ContainerSupport::Supported,
        },
        "antigravity-cli" => &ProviderContainerSpec {
            binary: "agy",
            // Documented headless auth is "cached credentials from a prior
            // interactive session" — `agy` exposes no environment-variable
            // auth path at all.
            auth_env: &[],
            sandbox_args: &["--dangerously-skip-permissions"],
            // Antigravity CLI stages under the shared Gemini namespace.
            credential_home: Some(".gemini"),
            // Unsupported for now, and not merely for lack of env auth. The
            // bridge is host-coupled in three ways that a `docker exec` argv
            // cannot carry: it runs agy through a PTY, it writes agy's
            // workspace-trust entry and the fleet MCP config into `agy_home`
            // on the host BEFORE spawning (without the trust entry agy
            // silently refuses — exit 0, empty stdout, no transcript), and it
            // reads the turn's output back out of a transcript JSONL on the
            // host afterwards. Making those three happen inside a container
            // is its own piece of work, and it depends on the opt-in
            // credential mount landing first since there is no key to inject.
            install_sh: None,
            support: ContainerSupport::Unsupported(
                "The Antigravity CLI agent can't run in a container yet: it needs a terminal, \
                 and Fleetify has to write its workspace-trust and MCP config next to the \
                 agent before each turn. Switch this session to a local folder, or pick a \
                 different agent for the container.",
            ),
        },
        "antigravity-sdk" => &ProviderContainerSpec {
            binary: "",
            auth_env: &[],
            sandbox_args: &[],
            credential_home: None,
            install_sh: None,
            support: ContainerSupport::Unsupported(
                "The Antigravity SDK agent drives a host Python SDK that provisions its own \
                 remote sandbox, so it can't run inside your container. Switch this session \
                 to a local folder, or pick the Antigravity CLI agent instead.",
            ),
        },
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every canonical provider id needs an explicit entry. A provider added
    /// later without one falls into `spec_for(..) == None`, which callers
    /// turn into a refusal — correct, but the point of Stage 1 is that all
    /// ten are answered deliberately rather than by omission.
    #[test]
    fn every_canonical_provider_has_a_spec() {
        for id in [
            "claude-code",
            "codex-cli",
            "kimi-code",
            "cursor-cli",
            "grok-build",
            "opencode",
            "github-copilot",
            "hermes-agent",
            "antigravity-cli",
            "antigravity-sdk",
        ] {
            assert!(spec_for(id).is_some(), "no container spec for {id}");
        }
    }

    #[test]
    fn an_unknown_provider_has_no_spec() {
        assert!(spec_for("made-up-agent").is_none());
    }

    /// Codex's own sandbox is Landlock/seccomp on Linux and Seatbelt on
    /// macOS. Neither exists inside an ordinary container, so any other tier
    /// refuses to start.
    #[test]
    fn codex_forces_full_access_because_landlock_is_unavailable_in_a_container() {
        assert_eq!(CODEX_CONTAINER_SANDBOX, "danger-full-access");
    }

    /// …and it must NOT ride argv. Fleetify runs `codex app-server`, which
    /// takes the tier over the protocol; a `--sandbox` flag on the command
    /// line is silently ignored, so a well-meaning "just add it to
    /// sandbox_args" edit would look right and change nothing.
    #[test]
    fn codex_sandbox_is_not_passed_as_argv() {
        assert!(
            spec_for("codex-cli").unwrap().sandbox_args.is_empty(),
            "codex takes its sandbox over thread/start, not argv"
        );
    }

    /// The host resolution prefers `cursor-agent` and wraps it in a cmd.exe
    /// shim on Windows. Inside the container the binary on PATH is `agent`.
    #[test]
    fn cursor_uses_the_in_container_binary_not_the_host_shim() {
        assert_eq!(spec_for("cursor-cli").unwrap().binary, "agent");
    }

    /// `--force` belongs to `agent -p` (print mode). Fleetify drives
    /// `agent acp`, where permissions ride the protocol — passing a
    /// print-mode flag there risks an unknown-option exit that closes the
    /// stream before the handshake.
    #[test]
    fn cursor_does_not_pass_print_mode_flags_to_acp_mode() {
        assert!(spec_for("cursor-cli").unwrap().sandbox_args.is_empty());
    }

    /// xAI's SDK reads XAI_API_KEY; GROK_API_KEY is a non-standard name.
    #[test]
    fn grok_forwards_the_standard_xai_key_name() {
        assert_eq!(spec_for("grok-build").unwrap().auth_env, &["XAI_API_KEY"]);
    }

    /// opencode keeps credentials in the XDG *data* dir, not the config home.
    #[test]
    fn opencode_credential_home_is_the_xdg_data_dir() {
        assert_eq!(
            spec_for("opencode").unwrap().credential_home,
            Some(".local/share/opencode")
        );
    }

    /// claude-code must NOT carry --dangerously-skip-permissions statically:
    /// the CLI rejects it as root, and a plain `docker run` container is
    /// root. The flag is added later, once the container user is known.
    #[test]
    fn claude_does_not_hardcode_skip_permissions() {
        assert!(spec_for("claude-code").unwrap().sandbox_args.is_empty());
    }

    /// `agy` documents no env-var auth at all — headless mode runs off a
    /// prior interactive login, so there is nothing to inject.
    #[test]
    fn antigravity_cli_has_no_env_auth_path() {
        assert!(spec_for("antigravity-cli").unwrap().auth_env.is_empty());
    }

    /// …and it is refused for now for a bigger reason than credentials: the
    /// bridge needs a PTY, writes agy's trust + MCP config into agy_home on
    /// the host before every turn, and reads the turn back out of a host
    /// transcript file. The refusal has to say what to do instead.
    #[test]
    fn antigravity_cli_is_refused_with_an_actionable_reason() {
        match spec_for("antigravity-cli").unwrap().support {
            ContainerSupport::Unsupported(reason) => {
                assert!(reason.contains("terminal"), "reason: {reason}");
                assert!(reason.contains("local folder"), "reason: {reason}");
            }
            other => panic!("expected Unsupported, got {other:?}"),
        }
    }

    #[test]
    fn antigravity_sdk_is_refused_with_a_reason() {
        match spec_for("antigravity-sdk").unwrap().support {
            ContainerSupport::Unsupported(reason) => {
                assert!(reason.contains("Python"), "reason: {reason}");
                assert!(
                    reason.contains("local folder"),
                    "the refusal must say what to do instead: {reason}"
                );
            }
            other => panic!("expected Unsupported, got {other:?}"),
        }
    }

    /// A binary name is what gets exec'd inside the container, so it must be
    /// a bare command — never a path, never a shim. This catches a
    /// well-meaning edit that pastes a host resolution in here.
    #[test]
    fn every_supported_binary_is_a_bare_command_name() {
        for id in [
            "claude-code",
            "codex-cli",
            "kimi-code",
            "cursor-cli",
            "grok-build",
            "opencode",
            "github-copilot",
            "hermes-agent",
            "antigravity-cli",
        ] {
            let b = spec_for(id).unwrap().binary;
            assert!(!b.is_empty(), "{id} has no binary");
            assert!(
                !b.contains('/')
                    && !b.contains('\\')
                    && !b.ends_with(".cmd")
                    && !b.ends_with(".exe"),
                "{id} binary '{b}' looks like a host path, not an in-container command"
            );
        }
    }

    /// Every provider that can run in a container must know how to install
    /// itself into one Fleetify provisions — otherwise "start from an image"
    /// only works for images that happen to pre-bundle the CLI. The commands
    /// come from each bridge's own "not found" error message, so the
    /// auto-install and the manual instruction can never disagree.
    #[test]
    fn every_supported_provider_has_an_install_command() {
        for id in [
            "claude-code",
            "codex-cli",
            "kimi-code",
            "cursor-cli",
            "grok-build",
            "opencode",
            "github-copilot",
            "hermes-agent",
        ] {
            let s = spec_for(id).unwrap();
            let cmd = s
                .install_sh
                .unwrap_or_else(|| panic!("{id} has no install_sh"));
            assert!(!cmd.trim().is_empty());
        }
        // The refused providers install nothing — there is no point.
        assert!(spec_for("antigravity-cli").unwrap().install_sh.is_none());
        assert!(spec_for("antigravity-sdk").unwrap().install_sh.is_none());
    }
}
