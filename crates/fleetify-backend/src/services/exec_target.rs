//! Where a session's agent process actually runs.
//!
//! The session's `project_path` carries the target. A plain filesystem
//! path means the host. A `docker://` marker means inside an already
//! running container — the marker is produced by the Container tab of
//! the source picker (`docker-container-panel.tsx`).
//!
//! Anything we cannot execute (an `ssh://` target, a malformed marker)
//! becomes `Unsupported` carrying a user-facing reason. It deliberately
//! does NOT fall back to `Local`: treating `docker://x/srv` as a local
//! directory is how a session silently runs in the wrong place, which is
//! the bug this module exists to remove.

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExecTarget {
    /// Spawn on the host, in `project_path`.
    Local,
    /// Spawn via `docker exec` inside `id`, working in `workdir`.
    Container { id: String, workdir: String },
    /// Recognised but not executable. The string is shown to the user.
    Unsupported(String),
}

pub const DOCKER_SCHEME: &str = "docker://";
pub const SSH_SCHEME: &str = "ssh://";

/// Mirrors `routers::docker::container_id_re`. Kept in sync on purpose:
/// an unvalidated id reaching `docker exec` could inject CLI flags
/// (`-v`, `--privileged`, …) into the argv we build.
fn valid_container_id(s: &str) -> bool {
    let mut chars = s.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphanumeric() => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
}

/// The schemes this module recognises. Anything else shaped like a URL
/// scheme is refused rather than treated as a host path — see `scheme_of`.
const KNOWN_SCHEMES: &[&str] = &[DOCKER_SCHEME, SSH_SCHEME];

/// The `<scheme>://` prefix of `s`, when it has one.
///
/// Deliberately strict: the head must be non-empty and pure ASCII
/// alphanumeric. That keeps every real filesystem path out — a Windows drive
/// (`C:\…`), a verbatim prefix (`\\?\C:\…`) and a POSIX filename containing a
/// colon all lack the `://`, and a path that somehow contained one would
/// still need an alphanumeric-only head to be mistaken for a scheme.
fn scheme_of(s: &str) -> Option<&str> {
    let i = s.find("://")?;
    let head = &s[..i];
    (!head.is_empty() && head.chars().all(|c| c.is_ascii_alphanumeric())).then(|| &s[..i + 3])
}

pub fn parse(project_path: &str) -> ExecTarget {
    if project_path.starts_with(SSH_SCHEME) {
        return ExecTarget::Unsupported(
            "Remote SSH sessions can't run the agent yet — only the file browser works. \
             Pick a local folder or a container."
                .into(),
        );
    }
    let Some(rest) = project_path.strip_prefix(DOCKER_SCHEME) else {
        // An unrecognised scheme must NOT fall through to `Local`. Before
        // this guard a `podman://c1/work` silently became a host path, which
        // is the exact bug class the module exists to prevent — and the
        // reason the doc comment above promises it never degrades.
        return match scheme_of(project_path) {
            Some(other) if !KNOWN_SCHEMES.contains(&other) => ExecTarget::Unsupported(format!(
                "'{other}' targets aren't supported yet. Pick a local folder or a Docker container."
            )),
            _ => ExecTarget::Local,
        };
    };
    // `docker://<id>/<abs path>` — no colon, despite what the picker's
    // doc comment used to claim. Container ids cannot contain `/` (see
    // `valid_container_id`), so the first slash is an unambiguous split.
    let (id, workdir) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, "/"),
    };
    if !valid_container_id(id) {
        return ExecTarget::Unsupported(format!(
            "'{id}' is not a valid container id. Re-pick the container from the source menu."
        ));
    }
    ExecTarget::Container {
        id: id.to_string(),
        workdir: workdir.to_string(),
    }
}

/// True when host-side filesystem work — git, worktree carving — makes
/// sense for this path. False for a container (the files live inside it,
/// and the host git knows nothing about them) and for anything we cannot
/// execute at all.
pub fn is_host_path(project_path: &str) -> bool {
    matches!(parse(project_path), ExecTarget::Local)
}

/// Validate a session's `project_path` at create/patch time and return the
/// exact string to persist.
///
/// This replaces the raw `is_dir()` guard the session router used to inline.
/// `Path::new("docker://abc123/work").is_dir()` is always `false`, so that
/// guard made a container session impossible to create — the only way in was
/// a PATCH, which validated nothing at all.
///
/// Host paths are still canonicalised, and still stripped of the Windows
/// verbatim (`\\?\`) prefix, which several ACP agents reject. Container
/// markers are stored verbatim. Anything we cannot execute is refused with
/// the parser's own user-facing reason instead of a misleading "not a
/// directory".
pub fn validate_project_path(raw: &str) -> Result<String, String> {
    match parse(raw) {
        ExecTarget::Unsupported(reason) => Err(reason),
        ExecTarget::Container { .. } => Ok(raw.to_string()),
        ExecTarget::Local => {
            let resolved = fleetify_core::canonicalize_or_keep(std::path::Path::new(raw));
            if !resolved.is_dir() {
                return Err(format!(
                    "Project path does not exist or is not a directory: {raw}"
                ));
            }
            Ok(resolved.to_string_lossy().to_string())
        }
    }
}

/// Build the full argv for a spawn.
///
/// Local returns `[program, args…]` and ignores `envs` — the caller sets
/// those on the `Command` directly. Container wraps everything in
/// `docker exec`, where env vars must become `-e` flags positioned
/// **before** the container id; anything after the id is an argument to
/// the in-container program instead of to docker.
///
/// Returning a plain `Vec<String>` rather than a configured `Command`
/// keeps this pure, so the whole container path is unit-testable with no
/// Docker daemon anywhere in sight.
pub fn build_argv(
    target: &ExecTarget,
    program: &str,
    args: &[String],
    envs: &[(String, String)],
) -> Result<Vec<String>, String> {
    match target {
        ExecTarget::Local => {
            let mut v = Vec::with_capacity(args.len() + 1);
            v.push(program.to_string());
            v.extend(args.iter().cloned());
            Ok(v)
        }
        ExecTarget::Container { id, workdir } => {
            let mut v = vec![
                "docker".to_string(),
                "exec".to_string(),
                "-i".to_string(),
                "-w".to_string(),
                workdir.clone(),
            ];
            for (k, val) in envs {
                v.push("-e".to_string());
                v.push(format!("{k}={val}"));
            }
            v.push(id.clone());
            v.push(program.to_string());
            v.extend(args.iter().cloned());
            Ok(v)
        }
        ExecTarget::Unsupported(reason) => Err(reason.clone()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_paths_are_local() {
        assert_eq!(parse(r"C:\Users\me\proj"), ExecTarget::Local);
        assert_eq!(parse("/home/me/proj"), ExecTarget::Local);
        assert_eq!(parse(""), ExecTarget::Local);
    }

    #[test]
    fn docker_marker_splits_at_first_slash() {
        assert_eq!(
            parse("docker://abc123/work/repo"),
            ExecTarget::Container {
                id: "abc123".into(),
                workdir: "/work/repo".into()
            }
        );
    }

    /// The format the picker ACTUALLY emits. `buildContainerUrl` in
    /// docker-container-panel.tsx is `docker://${id}${cleanPath}` with
    /// cleanPath forced to a leading slash — there is no colon, even
    /// though the doc comment claimed one. A parser written against the
    /// comment would never match a real path; this test pins the code.
    #[test]
    fn parses_exactly_what_the_picker_emits() {
        let id = "f3a9b2c1d4e5";
        let path = "/usr/src/app";
        let emitted = format!("docker://{id}{path}");
        assert_eq!(
            parse(&emitted),
            ExecTarget::Container {
                id: id.into(),
                workdir: path.into()
            }
        );
    }

    #[test]
    fn id_with_no_path_defaults_to_root() {
        assert_eq!(
            parse("docker://abc123"),
            ExecTarget::Container {
                id: "abc123".into(),
                workdir: "/".into()
            }
        );
    }

    #[test]
    fn container_names_may_contain_dot_dash_underscore() {
        assert_eq!(
            parse("docker://my_app-1.2/srv"),
            ExecTarget::Container {
                id: "my_app-1.2".into(),
                workdir: "/srv".into()
            }
        );
    }

    /// A malformed marker must NOT degrade to Local — that is precisely
    /// the silent-wrong-directory bug this work exists to remove.
    #[test]
    fn malformed_ids_are_unsupported_never_local() {
        for bad in [
            "docker://-flag/x",
            "docker://;rm -rf //x",
            "docker:///x",
            "docker://",
        ] {
            match parse(bad) {
                ExecTarget::Unsupported(_) => {}
                other => panic!("{bad} parsed as {other:?}, expected Unsupported"),
            }
        }
    }

    #[test]
    fn ssh_is_unsupported_with_a_readable_reason() {
        match parse("ssh://me@host:22/home/me/proj") {
            ExecTarget::Unsupported(reason) => {
                assert!(
                    reason.to_lowercase().contains("ssh"),
                    "reason was: {reason}"
                );
            }
            other => panic!("expected Unsupported, got {other:?}"),
        }
    }

    /// A scheme we do not execute must NOT degrade to `Local`. `parse` used
    /// to `strip_prefix("docker://")` and return `Local` on failure, so a
    /// future `podman://c1/work` became a host path — precisely the
    /// silent-wrong-directory bug this module exists to prevent.
    #[test]
    fn unknown_schemes_are_unsupported_never_local() {
        for s in ["podman://c1/work", "wsl://distro/home", "k8s://ns/pod"] {
            match parse(s) {
                ExecTarget::Unsupported(_) => {}
                other => panic!("{s} parsed as {other:?}, expected Unsupported"),
            }
        }
    }

    /// The flip side: a colon in a real path is not a scheme. A Windows
    /// drive letter and a POSIX filename containing `:` must stay `Local`,
    /// or the scheme guard above would break every Windows session.
    #[test]
    fn colons_that_are_not_schemes_stay_local() {
        assert_eq!(parse(r"C:\Users\me\proj"), ExecTarget::Local);
        assert_eq!(parse("/home/me/a:b"), ExecTarget::Local);
        assert_eq!(parse(r"\\?\C:\Users\me\proj"), ExecTarget::Local);
        assert_eq!(parse("relative/path"), ExecTarget::Local);
    }

    #[test]
    fn validate_accepts_a_container_marker_unchanged() {
        assert_eq!(
            validate_project_path("docker://abc123/work/repo"),
            Ok("docker://abc123/work/repo".to_string())
        );
    }

    #[test]
    fn validate_rejects_ssh_with_the_parsers_own_reason() {
        let err = validate_project_path("ssh://me@host/srv").unwrap_err();
        assert!(err.to_lowercase().contains("ssh"), "reason was: {err}");
    }

    #[test]
    fn validate_rejects_a_malformed_container_marker() {
        let err = validate_project_path("docker://-flag/x").unwrap_err();
        assert!(err.contains("container id"), "reason was: {err}");
    }

    #[test]
    fn validate_rejects_a_host_path_that_is_not_a_directory() {
        let err = validate_project_path("/definitely/not/a/real/dir/xyzzy").unwrap_err();
        assert!(err.contains("does not exist"), "reason was: {err}");
    }

    /// The canonicalising behaviour the old inline `is_dir()` guard had must
    /// survive the move into the validator: a real host dir comes back
    /// canonical (and free of the Windows verbatim prefix), not verbatim.
    #[test]
    fn validate_canonicalises_a_real_host_directory() {
        let tmp = std::env::temp_dir();
        let got = validate_project_path(&tmp.to_string_lossy()).expect("temp dir is a directory");
        assert!(!got.starts_with(r"\\?\"), "verbatim prefix leaked: {got}");
        assert!(!got.is_empty());
    }

    #[test]
    fn only_local_paths_are_host_paths() {
        assert!(is_host_path("/home/me/proj"));
        assert!(is_host_path(r"C:\proj"));
        // Files live inside the container; host git has nothing to carve.
        assert!(!is_host_path("docker://abc123/work"));
        // Not executable at all, so certainly not a host path.
        assert!(!is_host_path("ssh://me@host/srv"));
        assert!(!is_host_path("docker://-bad/x"));
    }

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn local_argv_is_program_then_args_and_ignores_envs() {
        // Local mode sets env on the Command itself, not in argv.
        let envs = vec![("K".to_string(), "V".to_string())];
        let argv = build_argv(&ExecTarget::Local, "claude", &s(&["-p", "hi"]), &envs).unwrap();
        assert_eq!(argv, s(&["claude", "-p", "hi"]));
    }

    #[test]
    fn container_argv_places_env_flags_before_the_id() {
        let target = ExecTarget::Container {
            id: "abc123".into(),
            workdir: "/work".into(),
        };
        let envs = vec![
            ("ANTHROPIC_BASE_URL".to_string(), "http://x".to_string()),
            ("FOO".to_string(), "bar".to_string()),
        ];
        let argv = build_argv(&target, "claude", &s(&["-p", "hi"]), &envs).unwrap();
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
                "-e",
                "FOO=bar",
                "abc123",
                "claude",
                "-p",
                "hi",
            ])
        );
        // The ordering is load-bearing: an `-e` after the id would be
        // passed to the in-container program instead of to docker.
        let id_at = argv.iter().position(|a| a == "abc123").unwrap();
        let last_e = argv.iter().rposition(|a| a == "-e").unwrap();
        assert!(
            last_e < id_at,
            "every -e flag must precede the container id"
        );
    }

    #[test]
    fn env_values_with_newlines_survive_intact() {
        // ANTHROPIC_CUSTOM_HEADERS is newline-separated `Name: Value`
        // pairs. argv is NUL-delimited so newlines pass through untouched.
        let target = ExecTarget::Container {
            id: "c1".into(),
            workdir: "/w".into(),
        };
        let envs = vec![(
            "ANTHROPIC_CUSTOM_HEADERS".to_string(),
            "A: 1\nB: 2".to_string(),
        )];
        let argv = build_argv(&target, "claude", &[], &envs).unwrap();
        assert!(argv.contains(&"ANTHROPIC_CUSTOM_HEADERS=A: 1\nB: 2".to_string()));
    }

    #[test]
    fn env_values_containing_equals_are_not_split() {
        let target = ExecTarget::Container {
            id: "c1".into(),
            workdir: "/w".into(),
        };
        let envs = vec![("TOKEN".to_string(), "a=b=c".to_string())];
        let argv = build_argv(&target, "claude", &[], &envs).unwrap();
        assert!(argv.contains(&"TOKEN=a=b=c".to_string()));
    }

    #[test]
    fn unsupported_targets_error_rather_than_building_an_argv() {
        let t = ExecTarget::Unsupported("nope".into());
        assert_eq!(build_argv(&t, "claude", &[], &[]), Err("nope".to_string()));
    }
}
