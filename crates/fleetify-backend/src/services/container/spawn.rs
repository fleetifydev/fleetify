//! The one spawn path every bridge uses.
//!
//! Before this module each bridge built its own
//! `Command::new(which(bin)).current_dir(cwd)`, which is why `claude-code`
//! was the only provider that ever worked in a container:
//!
//! * `current_dir("docker://abc/work")` fails with an opaque OS error, and
//! * a host-resolved binary path (or a Windows `.cmd` shim) does not exist on
//!   the other side of the boundary anyway.
//!
//! `argv_for` is deliberately pure so the whole container path stays
//! unit-testable with no Docker daemon in sight; `command` is the thin
//! wrapper that turns it into a configured process.

use crate::services::container::providers::{spec_for, ContainerSupport};
use crate::services::exec_target::{build_argv, ExecTarget};

pub struct SpawnRequest<'a> {
    pub target: &'a ExecTarget,
    /// Canonical provider id (`codex-cli`, `claude-code`, …). Used to look up
    /// the in-container binary — ignored entirely for a `Local` target.
    pub provider_id: &'a str,
    /// Host-resolved program. Used verbatim for `Local`; never for a
    /// container, which uses the provider spec's bare binary name.
    pub host_program: &'a str,
    pub args: &'a [String],
    /// For `Local` these are set on the `Command`; for a container they
    /// become `-e` flags ahead of the container id. Either way they must be
    /// known before the argv exists.
    pub envs: &'a [(String, String)],
    /// Host working directory. Ignored for a container, whose working
    /// directory rides `docker exec -w`.
    pub cwd: &'a str,
    /// ACP bridges hold a long-lived JSON-RPC conversation over stdin, and
    /// `docker exec -i` carries it — but only if we actually pipe stdin.
    /// claude-code got away without it because it spawns one-shot.
    pub pipe_stdin: bool,
}

/// Resolve the program name to exec, refusing anything we cannot run.
fn program_for<'a>(req: &'a SpawnRequest<'a>) -> anyhow::Result<&'a str> {
    match req.target {
        ExecTarget::Local => Ok(req.host_program),
        ExecTarget::Unsupported(reason) => anyhow::bail!("{reason}"),
        ExecTarget::Container { .. } => {
            let Some(spec) = spec_for(req.provider_id) else {
                // Refuse by name. Passing the host argv through `docker exec`
                // instead yields "executable file not found", which names
                // neither the provider nor the reason.
                anyhow::bail!(
                    "'{}' has no container profile yet, so Fleetify can't run it inside a \
                     container. Switch this session to a local folder.",
                    req.provider_id
                );
            };
            if let ContainerSupport::Unsupported(reason) = spec.support {
                anyhow::bail!("{reason}");
            }
            Ok(spec.binary)
        }
    }
}

/// Windows batch shims (`cursor-agent.cmd`, `copilot.cmd`, …) cannot be
/// exec'd by `CreateProcess`, so on the host they have to run through
/// `cmd /C`.
///
/// Strictly host-only, which is why it lives on this branch rather than in
/// each bridge: inside a container the binary is a real executable on PATH,
/// and a `cmd /C` prefix would try to run Windows' shell inside a Linux
/// container. Bridges that used to build the shim themselves leaked it into
/// the container argv.
fn wrap_host_shim(program: &str, args: &[String]) -> (String, Vec<String>) {
    if cfg!(windows) && program.to_ascii_lowercase().ends_with(".cmd") {
        let mut wrapped = Vec::with_capacity(args.len() + 2);
        wrapped.push("/C".to_string());
        wrapped.push(program.to_string());
        wrapped.extend(args.iter().cloned());
        return ("cmd".to_string(), wrapped);
    }
    (program.to_string(), args.to_vec())
}

/// Pure argv construction. `Local` → `[program, args…]` (through `cmd /C`
/// when the host program is a batch shim); `Container` →
/// `docker exec -i -w <dir> -e K=V … <id> <binary> args…`.
pub fn argv_for(req: &SpawnRequest) -> anyhow::Result<Vec<String>> {
    let program = program_for(req)?;
    match req.target {
        ExecTarget::Local => {
            let (prog, args) = wrap_host_shim(program, req.args);
            build_argv(req.target, &prog, &args, req.envs).map_err(|e| anyhow::anyhow!(e))
        }
        _ => build_argv(req.target, program, req.args, req.envs).map_err(|e| anyhow::anyhow!(e)),
    }
}

/// The working directory to hand to the **agent**, as opposed to the one we
/// hand to `docker exec`.
///
/// Several bridges tell the agent its own cwd a second time, over the
/// protocol rather than through the process — codex via `thread/start`,
/// other ACP agents via a session `cwd` field. Passing the host path there
/// points the agent at a directory that does not exist inside the container,
/// and the failure is a confusing "no such file" for the *project*, long
/// after the spawn appeared to succeed.
pub fn agent_workdir(target: &ExecTarget, host_cwd: &str) -> String {
    match target {
        ExecTarget::Container { workdir, .. } => workdir.clone(),
        _ => host_cwd.to_string(),
    }
}

/// The persistent not-installed refusal.
///
/// When auto-install already tried and failed, the WHY is folded in — the
/// setup step that carried it is transient, and "not installed. Install it
/// there" on an image that cannot host the agent sent the user in a circle.
fn missing_agent_message(binary: &str, container_id: &str, remembered: Option<&str>) -> String {
    match remembered {
        Some(reason) => format!(
            "The {binary} CLI is not installed in container '{container_id}', and installing it \
             automatically failed — {reason}"
        ),
        None => format!(
            "The {binary} CLI is not installed in container '{container_id}'. Install it there, \
             or switch this session to a local folder."
        ),
    }
}

/// What a container turn needs on top of what the bridge already built.
#[derive(Debug, Default, Clone)]
pub struct Preflight {
    /// Credential `-e` pairs to append before building the argv.
    pub envs: Vec<(String, String)>,
    /// Extra argv the CLI needs because the container replaced its sandbox.
    pub args: Vec<String>,
}

/// Everything that must be true before a container turn is worth spawning.
///
/// Runs three checks the bridges used to skip, duplicate, or discover the
/// hard way:
///
/// 1. **Is the CLI installed there?** The picker probed it at selection time,
///    but that answer goes stale the moment the container is stopped or
///    replaced. Cached for a minute per (container, agent) so this is not a
///    `docker exec` round trip on every message.
/// 2. **Can it authenticate?** Resolve the credential tiers and refuse HERE,
///    naming the fix, rather than letting the CLI fail mid-stream with its
///    own opaque auth error.
/// 3. **Does it need container-specific flags?** claude's
///    `--dangerously-skip-permissions` is the interesting one: the CLI
///    rejects it as root, and a plain `docker run` container is root, so the
///    flag depends on a probe rather than being static.
///
/// A `Local` target returns an empty `Preflight` without touching Docker.
pub async fn preflight(
    target: &ExecTarget,
    provider_id: &str,
    mount_credentials: bool,
) -> anyhow::Result<Preflight> {
    let ExecTarget::Container { id, .. } = target else {
        return Ok(Preflight::default());
    };
    let Some(spec) = spec_for(provider_id) else {
        anyhow::bail!(
            "'{provider_id}' has no container profile yet, so Fleetify can't run it inside a \
             container. Switch this session to a local folder."
        );
    };
    if let ContainerSupport::Unsupported(reason) = spec.support {
        anyhow::bail!("{reason}");
    }

    if !super::lifecycle::probe_agent_cached(id, spec.binary).await {
        super::lifecycle::invalidate(id);
        anyhow::bail!(
            "{}",
            missing_agent_message(
                spec.binary,
                id,
                super::lifecycle::last_install_failure(id, provider_id).as_deref(),
            )
        );
    }

    let container_home = super::lifecycle::container_home(id).await;
    let host_home = fleetify_core::user_home();
    let creds = super::credentials::resolve(
        provider_id,
        mount_credentials,
        Some(host_home.as_path()),
        &container_home,
    );
    if let Some(reason) = creds.missing_credential {
        anyhow::bail!("{reason}");
    }
    // Mounts cannot be added to a container that is already running. For
    // `docker-attach` the credential mount has to have happened at
    // provision time, so a resolved mount here is only meaningful for
    // `docker-run` — where `lifecycle::run_argv` already consumed it.
    // Nothing to do with it on the exec path.

    let mut args: Vec<String> = spec.sandbox_args.iter().map(|s| s.to_string()).collect();
    if provider_id == "claude-code" {
        // claude-code refuses --dangerously-skip-permissions when it runs as
        // root, and a plain `docker run` container IS root. Adding it blindly
        // would break the common case with an error that reads like a CLI
        // bug, so it waits on the probe.
        let user = super::lifecycle::container_user(id).await;
        if user != "root" {
            args.push("--dangerously-skip-permissions".to_string());
        } else {
            tracing::info!(
                target: "fleetify::container",
                container = %id,
                "container runs as root — withholding --dangerously-skip-permissions (the CLI rejects it as root)"
            );
        }
    }

    Ok(Preflight {
        envs: creds.envs,
        args,
    })
}

/// Build the configured `Command`.
///
/// `Local` keeps every host-only behaviour — working directory, env on the
/// `Command`, and the canonical-PATH fix that stops cmd.exe's 8191-character
/// truncation from stripping `node`/`git` out of a `.cmd` shim. A container
/// keeps none of them: the working directory rides `-w`, the env rides `-e`,
/// and the host's PATH is irrelevant to a process on the other side.
pub fn command(req: &SpawnRequest) -> anyhow::Result<tokio::process::Command> {
    let argv = argv_for(req)?;
    let mut cmd = tokio::process::Command::new(&argv[0]);
    cmd.args(&argv[1..])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    if req.pipe_stdin {
        cmd.stdin(std::process::Stdio::piped());
    }
    if matches!(req.target, ExecTarget::Local) {
        if !req.cwd.is_empty() {
            cmd.current_dir(req.cwd);
        }
        for (k, v) in req.envs {
            cmd.env(k, v);
        }
        crate::bridges::apply_clean_path(&mut cmd);
    }
    Ok(cmd)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    fn container() -> ExecTarget {
        ExecTarget::Container {
            id: "c1".into(),
            workdir: "/work".into(),
        }
    }

    fn req<'a>(
        target: &'a ExecTarget,
        provider_id: &'a str,
        host_program: &'a str,
        args: &'a [String],
        envs: &'a [(String, String)],
    ) -> SpawnRequest<'a> {
        SpawnRequest {
            target,
            provider_id,
            host_program,
            args,
            envs,
            cwd: "",
            pipe_stdin: true,
        }
    }

    /// The whole point of Stage 1: an ACP bridge's long-lived stdin/stdout
    /// JSON-RPC has to survive the docker wrapper. `docker exec -i` carries
    /// it; claude only got away without stdin because it spawns one-shot.
    #[test]
    fn container_argv_keeps_the_dash_i_that_carries_acp_stdin() {
        let t = container();
        let args = s(&["app-server", "--listen", "stdio://"]);
        let argv = argv_for(&req(
            &t,
            "codex-cli",
            r"C:\Program Files\nodejs\codex.cmd",
            &args,
            &[],
        ))
        .unwrap();
        assert_eq!(&argv[..3], &s(&["docker", "exec", "-i"])[..]);
    }

    /// A host-resolved absolute path — or a Windows `.cmd` shim — does not
    /// exist inside the container. The provider spec's bare name does.
    #[test]
    fn container_argv_uses_the_in_container_binary_not_the_host_path() {
        let t = container();
        let args = s(&["-p", "hi"]);
        let argv = argv_for(&req(
            &t,
            "cursor-cli",
            r"C:\Users\me\.local\bin\cursor-agent.cmd",
            &args,
            &[],
        ))
        .unwrap();
        let prog_at = argv.iter().position(|a| a == "c1").unwrap() + 1;
        assert_eq!(argv[prog_at], "agent");
        assert!(
            !argv.iter().any(|a| a.contains("cursor-agent")),
            "host shim leaked into the container argv: {argv:?}"
        );
        assert!(!argv.iter().any(|a| a.ends_with(".cmd")));
    }

    /// Local is untouched by all of this: host program verbatim, env on the
    /// Command rather than in the argv, no docker anywhere.
    #[test]
    fn local_argv_is_the_host_program_verbatim() {
        let t = ExecTarget::Local;
        let args = s(&["app-server"]);
        let envs = vec![("K".to_string(), "V".to_string())];
        let argv = argv_for(&req(&t, "codex-cli", "/usr/local/bin/codex", &args, &envs)).unwrap();
        assert_eq!(argv, s(&["/usr/local/bin/codex", "app-server"]));
    }

    /// Env must reach the process INSIDE the container, which means `-e`
    /// flags ahead of the id. Set on the Command instead, they would attach
    /// to the docker client — a silent failure where the agent simply runs
    /// unauthenticated.
    #[test]
    fn container_env_becomes_dash_e_flags_before_the_id() {
        let t = container();
        let envs = vec![("OPENAI_API_KEY".to_string(), "sk-x".to_string())];
        let argv = argv_for(&req(&t, "codex-cli", "codex", &[], &envs)).unwrap();
        let id_at = argv.iter().position(|a| a == "c1").unwrap();
        let e_at = argv.iter().position(|a| a == "-e").unwrap();
        assert!(e_at < id_at, "every -e must precede the id: {argv:?}");
        assert!(argv.contains(&"OPENAI_API_KEY=sk-x".to_string()));
    }

    #[test]
    fn an_unsupported_provider_is_refused_with_its_reason() {
        let t = container();
        let err = argv_for(&req(&t, "antigravity-sdk", "python", &[], &[])).unwrap_err();
        assert!(err.to_string().contains("Python"), "err: {err}");
    }

    /// A provider with no spec must not silently run the host argv through
    /// docker — that produces "executable file not found" with no hint which
    /// of the ten agents is unmapped.
    #[test]
    fn an_unknown_provider_is_refused_by_name() {
        let t = container();
        let err = argv_for(&req(&t, "made-up-agent", "x", &[], &[])).unwrap_err();
        assert!(err.to_string().contains("made-up-agent"), "err: {err}");
    }

    /// An `ssh://` path is also a valid POSIX path, so an Unsupported target
    /// must fail the spawn rather than fall through to a local one.
    #[test]
    fn an_unsupported_target_fails_rather_than_running_locally() {
        let t = ExecTarget::Unsupported("no ssh yet".into());
        let err = argv_for(&req(&t, "claude-code", "claude", &[], &[])).unwrap_err();
        assert_eq!(err.to_string(), "no ssh yet");
    }

    /// A `.cmd` shim needs `cmd /C` on the host — CreateProcess cannot exec a
    /// batch file directly.
    #[test]
    #[cfg(windows)]
    fn a_windows_shim_runs_through_cmd_on_the_host() {
        let t = ExecTarget::Local;
        let args = s(&["acp"]);
        let argv = argv_for(&req(
            &t,
            "cursor-cli",
            r"C:\Users\me\AppData\Local\cursor-agent\cursor-agent.cmd",
            &args,
            &[],
        ))
        .unwrap();
        assert_eq!(argv[0], "cmd");
        assert_eq!(argv[1], "/C");
        assert!(argv[2].ends_with("cursor-agent.cmd"));
        assert_eq!(argv[3], "acp");
    }

    /// …and must NOT inside one. `cmd /C` would try to run Windows' shell in
    /// a Linux container; the bridges that built the shim themselves leaked
    /// exactly this.
    #[test]
    fn a_windows_shim_never_leaks_into_the_container_argv() {
        let t = container();
        let args = s(&["acp"]);
        let argv = argv_for(&req(
            &t,
            "cursor-cli",
            r"C:\Users\me\AppData\Local\cursor-agent\cursor-agent.cmd",
            &args,
            &[],
        ))
        .unwrap();
        assert!(!argv.iter().any(|a| a == "cmd" || a == "/C"), "{argv:?}");
        let id_at = argv.iter().position(|a| a == "c1").unwrap();
        assert_eq!(argv[id_at + 1], "agent");
        assert_eq!(argv[id_at + 2], "acp");
    }

    /// A real executable is spawned directly on either side.
    #[test]
    fn a_real_executable_is_not_wrapped() {
        let t = ExecTarget::Local;
        let args = s(&["acp"]);
        let argv = argv_for(&req(
            &t,
            "cursor-cli",
            "/home/me/.local/bin/agent",
            &args,
            &[],
        ))
        .unwrap();
        assert_eq!(argv, s(&["/home/me/.local/bin/agent", "acp"]));
    }

    /// The cwd the agent is TOLD about must be the in-container one. Handing
    /// it the host path points it at a directory that does not exist on its
    /// side, and the error surfaces long after the spawn looked fine.
    #[test]
    fn agent_workdir_is_the_in_container_path() {
        assert_eq!(agent_workdir(&container(), r"C:\Users\me\proj"), "/work");
    }

    #[test]
    fn agent_workdir_is_the_host_path_for_a_local_target() {
        assert_eq!(
            agent_workdir(&ExecTarget::Local, r"C:\Users\me\proj"),
            r"C:\Users\me\proj"
        );
    }

    /// Characterisation: the argv for the one provider that already worked
    /// must be byte-identical to what PR #278 produced, so migrating
    /// claude.rs onto this helper is provably behaviour-preserving.
    #[test]
    fn claude_container_argv_matches_the_pre_refactor_shape() {
        let t = ExecTarget::Container {
            id: "abc123".into(),
            workdir: "/work".into(),
        };
        let args = s(&["-p", "hi"]);
        let envs = vec![("ANTHROPIC_BASE_URL".to_string(), "http://x".to_string())];
        let argv = argv_for(&req(&t, "claude-code", "claude", &args, &envs)).unwrap();
        assert_eq!(
            argv,
            s(&[
                "docker",
                "exec",
                "-i",
                "-w",
                "/work",
                "-e",
                "ANTHROPIC_BASE_URL=http://x",
                "abc123",
                "claude",
                "-p",
                "hi",
            ])
        );
    }
}

#[cfg(test)]
mod missing_agent_tests {
    use super::missing_agent_message;

    /// With a remembered install failure the error must explain, not
    /// circle: "install it there" on an image with no npm is a dead end.
    #[test]
    fn a_remembered_failure_replaces_the_circular_advice() {
        let m = missing_agent_message(
            "claude",
            "abc",
            Some("Couldn't install claude: this image has no `npm`, so it can't host the agent."),
        );
        assert!(m.contains("no `npm`"), "{m}");
        assert!(
            !m.contains("Install it there"),
            "circular advice must be gone: {m}"
        );
    }

    #[test]
    fn no_memory_keeps_the_plain_refusal() {
        let m = missing_agent_message("codex", "abc", None);
        assert!(m.contains("Install it there"), "{m}");
    }
}
