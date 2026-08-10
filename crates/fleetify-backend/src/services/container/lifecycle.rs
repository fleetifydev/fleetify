//! Container lifecycle: probing, provisioning, aborting, tearing down.
//!
//! Two flavours share one code path, and the difference matters at every
//! step here:
//!
//! * `docker-attach` — the user's own container. We exec into it and touch
//!   nothing else. Deleting the session must NOT stop it.
//! * `docker-run` — Fleetify provisions it from an image with the session's
//!   host workdir bind-mounted, so the agent edits the user's real checkout
//!   and host git keeps working. We own it, so we tear it down.
//!
//! The argv builders are pure so the whole shape is unit-testable with no
//! daemon; only the thin `async` wrappers talk to `docker`.

use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use crate::routers::docker::{container_id_re, run_docker};
use crate::services::exec_target::DOCKER_SCHEME as DOCKER_MARKER;

/// Last non-blank line of a docker error, which is where its actual message
/// lives — the rest is usually a usage dump.
fn last_line(text: &str) -> Option<String> {
    text.trim()
        .lines()
        .rev()
        .find(|l| !l.trim().is_empty())
        .map(|l| l.trim().to_string())
}

/// How long a probe answer stays good. The picker's answer goes stale the
/// moment a container is stopped or replaced, but re-asking on every single
/// turn cost a `docker exec` round trip with an 8-second timeout on the hot
/// path of every message.
const PROBE_TTL: Duration = Duration::from_secs(60);

/// The path a provisioned container's workspace is mounted at. Fixed rather
/// than mirroring the host path: host paths are frequently Windows
/// (`C:\Users\…`), which is not a legal container path at all.
pub const WORKSPACE_MOUNT: &str = "/workspace";

/// Home to assume when `echo $HOME` gives nothing useful. A plain `docker
/// run` container is root, so this is right far more often than not — and
/// the alternative (refusing to mount) is worse than a wrong guess we log.
const DEFAULT_CONTAINER_HOME: &str = "/root";

type Cache<V> = std::sync::Mutex<HashMap<String, (V, Instant)>>;

fn probe_cache() -> &'static Cache<bool> {
    static C: OnceLock<Cache<bool>> = OnceLock::new();
    C.get_or_init(Default::default)
}

fn facts_cache() -> &'static Cache<String> {
    static C: OnceLock<Cache<String>> = OnceLock::new();
    C.get_or_init(Default::default)
}

fn cache_get<V: Clone>(cache: &Cache<V>, key: &str) -> Option<V> {
    let guard = cache.lock().ok()?;
    let (v, at) = guard.get(key)?;
    (at.elapsed() < PROBE_TTL).then(|| v.clone())
}

fn cache_put<V>(cache: &Cache<V>, key: &str, value: V) {
    if let Ok(mut guard) = cache.lock() {
        guard.insert(key.to_string(), (value, Instant::now()));
    }
}

/// Drop every cached answer about `container_id`.
///
/// Called when an exec fails in a way that means the container is gone —
/// otherwise a stopped-and-recreated container keeps answering from a cache
/// that describes the old one for up to a minute.
pub fn invalidate(container_id: &str) {
    let prefix = format!("{container_id}\u{1}");
    for_each_cache(|keys| keys.retain(|k, _| !k.starts_with(&prefix)));
}

fn for_each_cache(mut f: impl FnMut(&mut HashMap<String, (String, Instant)>)) {
    if let Ok(mut g) = facts_cache().lock() {
        f(&mut g);
    }
    if let Ok(mut g) = probe_cache().lock() {
        // Same key shape, different value type — retain by key only.
        g.retain(|k, _| !k.starts_with(&format!("{}\u{1}", k.split('\u{1}').next().unwrap_or(""))));
    }
}

fn key(container_id: &str, what: &str) -> String {
    format!("{container_id}\u{1}{what}")
}

/// Is `agent` installed inside `container_id`? Cached for [`PROBE_TTL`] per
/// (container, agent) pair — a different agent in the same container is a
/// different question.
pub async fn probe_agent_cached(container_id: &str, agent: &str) -> bool {
    let k = key(container_id, agent);
    if let Some(v) = cache_get(probe_cache(), &k) {
        return v;
    }
    let present = crate::routers::docker::probe_agent_in_container(container_id, agent).await;
    cache_put(probe_cache(), &k, present);
    present
}

/// Read one fact out of the container via `sh -c`, cached.
async fn container_fact(container_id: &str, what: &str, script: &str, fallback: &str) -> String {
    let k = key(container_id, what);
    if let Some(v) = cache_get(facts_cache(), &k) {
        return v;
    }
    if !container_id_re().is_match(container_id) {
        return fallback.to_string();
    }
    let (rc, out, _) = run_docker(&["exec", container_id, "sh", "-c", script], 8).await;
    let value = match (rc, out.trim()) {
        (0, v) if !v.is_empty() => v.to_string(),
        _ => {
            tracing::warn!(
                target: "fleetify::container",
                container = container_id,
                what,
                "container probe gave nothing; assuming '{fallback}'"
            );
            fallback.to_string()
        }
    };
    cache_put(facts_cache(), &k, value.clone());
    value
}

/// `$HOME` inside the container. Needed for the Tier B credential mount
/// target, which is not knowable statically: a `node`-style image is
/// `/home/node`, a plain one is `/root`.
pub async fn container_home(container_id: &str) -> String {
    container_fact(
        container_id,
        "home",
        "printf %s \"$HOME\"",
        DEFAULT_CONTAINER_HOME,
    )
    .await
}

/// The user the container runs as.
///
/// claude-code refuses `--dangerously-skip-permissions` when it is root, so
/// the flag can only be added once this is known — and a plain `docker run`
/// container IS root, which is why the flag cannot be static.
pub async fn container_user(container_id: &str) -> String {
    container_fact(container_id, "user", "id -un", "root").await
}

/// Is the container running right now? Uncached — this is the liveness
/// question the UI's dead-container indicator asks, and a stale "yes" is the
/// one answer that helps nobody.
pub async fn is_alive(container_id: &str) -> bool {
    if !container_id_re().is_match(container_id) {
        return false;
    }
    let (rc, out, _) = run_docker(&["inspect", "-f", "{{.State.Running}}", container_id], 6).await;
    rc == 0 && out.trim() == "true"
}

/// What to provision.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RunSpec {
    pub image: String,
    /// Host directory to bind-mount as the workspace — the git worktree when
    /// the session has one, so the agent edits the user's real checkout.
    pub host_workdir: String,
    /// Extra `-v host:container` specs (Tier B credential mounts).
    pub mounts: Vec<String>,
    pub envs: Vec<(String, String)>,
    /// Linux does not resolve `host.docker.internal` without an explicit
    /// mapping; Docker Desktop provides it automatically.
    pub add_host_gateway: bool,
    /// Deterministic container name so a restarted app can find its own
    /// container instead of orphaning it and provisioning a second.
    pub name: String,
}

/// Build the `docker run` argv. Pure — the daemon is not involved.
pub fn run_argv(spec: &RunSpec) -> Vec<String> {
    let mut v: Vec<String> = vec![
        "docker".into(),
        "run".into(),
        // Detached: each turn is still a `docker exec`, so the Stage 1 spawn
        // path is untouched by provisioning.
        "-d".into(),
        "--name".into(),
        spec.name.clone(),
    ];
    v.push("-v".into());
    v.push(format!("{}:{}", spec.host_workdir, WORKSPACE_MOUNT));
    v.push("-w".into());
    v.push(WORKSPACE_MOUNT.to_string());
    for m in &spec.mounts {
        v.push("-v".into());
        v.push(m.clone());
    }
    for (k, val) in &spec.envs {
        v.push("-e".into());
        v.push(format!("{k}={val}"));
    }
    if spec.add_host_gateway {
        v.push("--add-host".into());
        v.push(format!("{}:host-gateway", super::credentials::HOST_GATEWAY));
    }
    v.push(spec.image.clone());
    // Keep it alive between turns. Without this the container exits as soon
    // as its entrypoint returns and every turn would pay a cold provision.
    v.push("sleep".into());
    v.push("infinity".into());
    v
}

/// A deterministic container name for a session. Prefixed so a stray one is
/// obviously ours, and truncated because Docker names have a length limit.
pub fn container_name_for(session_id: &str) -> String {
    let short: String = session_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(12)
        .collect();
    format!("fleetify-{short}")
}

/// One step of getting a container ready, reported live to the session.
///
/// Provisioning can take minutes — `docker pull` of an image the user has
/// never used is the slow one — and doing it silently meant the first
/// message just sat there with no explanation. These are the steps worth
/// naming; the renderer shows them inline the same way compaction does.
#[derive(Debug, Clone, serde::Serialize)]
pub struct SetupEvent {
    /// `pull` | `start` | `verify`
    pub step: &'static str,
    /// Human-readable detail, already phrased for the user.
    pub detail: String,
    /// 0.0–1.0 within the step, when it is measurable. Only `pull` is.
    pub pct: Option<f32>,
}

pub type SetupTx = tokio::sync::mpsc::UnboundedSender<SetupEvent>;

fn report(tx: Option<&SetupTx>, step: &'static str, detail: impl Into<String>, pct: Option<f32>) {
    if let Some(tx) = tx {
        let _ = tx.send(SetupEvent {
            step,
            detail: detail.into(),
            pct,
        });
    }
}

/// Is the image already on this machine?
async fn image_present(image: &str) -> bool {
    let (rc, _, _) = run_docker(&["image", "inspect", image], 15).await;
    rc == 0
}

/// `docker pull`, reporting layer progress as it goes.
///
/// Run explicitly rather than letting `docker run` pull implicitly: the
/// implicit pull is buffered inside the run call, so a five-minute download
/// looks identical to a hang. Without a TTY docker emits discrete lines, so
/// counting `Pull complete` against the number of layers it announced gives
/// an honest progress fraction.
async fn pull_image(image: &str, tx: Option<&SetupTx>) -> anyhow::Result<()> {
    use tokio::io::{AsyncBufReadExt, BufReader};

    report(tx, "pull", format!("Downloading {image}…"), Some(0.0));
    let mut child = tokio::process::Command::new("docker")
        .args(["pull", image])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| anyhow::anyhow!("couldn't run docker pull: {e}"))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow::anyhow!("docker pull: no stdout"))?;
    let mut layers: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut done: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut lines = BufReader::new(stdout).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let Some((id, state)) = line.split_once(": ") else {
            continue;
        };
        let id = id.trim();
        if !is_layer_id(id) {
            continue;
        }
        layers.insert(id.to_string());
        let state = state.trim();
        if state.starts_with("Pull complete") || state.starts_with("Already exists") {
            done.insert(id.to_string());
        }
        let pct = if layers.is_empty() {
            0.0
        } else {
            done.len() as f32 / layers.len() as f32
        };
        report(
            tx,
            "pull",
            format!(
                "Downloading {image} — {}/{} layers",
                done.len(),
                layers.len()
            ),
            Some(pct),
        );
    }
    let status = child
        .wait()
        .await
        .map_err(|e| anyhow::anyhow!("docker pull: {e}"))?;
    if !status.success() {
        let mut err = String::new();
        if let Some(mut e) = child.stderr.take() {
            use tokio::io::AsyncReadExt;
            let _ = e.read_to_string(&mut err).await;
        }
        anyhow::bail!(
            "Couldn't pull '{image}': {}",
            last_line(&err).unwrap_or_else(|| "docker pull failed".into())
        );
    }
    Ok(())
}

/// Is this the id of a real image layer?
///
/// `docker pull` emits `<something>: <state>` for three things that are NOT
/// layers — the tag header (`3.19: Pulling from library/alpine`), the
/// `Digest:` line and the `Status:` line. Counting those inflated the
/// denominator, so a single-layer image reported 1/4 instead of 1/1. Real
/// layer ids are 12 lowercase hex characters, which excludes all three.
fn is_layer_id(s: &str) -> bool {
    s.len() == 12
        && s.chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
}

/// Make sure a `docker-run` session has a live container, and return the
/// `docker://<id>/<workdir>` marker the bridges parse.
///
/// Provisioning happens on the **first turn**, not when the user picks an
/// image: a picker click should not start a container the user may abandon,
/// and on a draft session there is no row to attach one to yet. Same timing
/// as the worktree carve.
///
/// `Ok(None)` for anything that is not `docker-run` — a host session, or an
/// attach session whose `project_path` is already the marker.
///
/// Idempotent across turns: an existing container is reused, a stopped one is
/// restarted, and only a genuinely missing one is created.
pub async fn ensure_ready(
    pool: &sqlx::SqlitePool,
    session: &crate::models::session::Session,
    host_workdir: &str,
    tx: Option<&SetupTx>,
) -> anyhow::Result<Option<String>> {
    if session.exec_mode != "docker-run" {
        return Ok(None);
    }
    let workdir = session
        .container_workdir
        .clone()
        .filter(|w| !w.is_empty())
        .unwrap_or_else(|| WORKSPACE_MOUNT.to_string());

    // Reuse what we already provisioned, restarting it if the user (or a
    // reboot) stopped it. Recreating instead would orphan the old container
    // and lose whatever the agent had installed inside.
    if let Some(id) = session.container_id.as_deref().filter(|i| !i.is_empty()) {
        if is_alive(id).await {
            return Ok(Some(format!("{DOCKER_MARKER}{id}{workdir}")));
        }
        report(tx, "start", "Restarting the container…", None);
        let (rc, _, err) = run_docker(&["start", id], 20).await;
        if rc == 0 {
            invalidate(id);
            return Ok(Some(format!("{DOCKER_MARKER}{id}{workdir}")));
        }
        tracing::warn!(
            target: "fleetify::container",
            session_id = %session.id, container = id,
            "could not restart the session's container ({}); provisioning a fresh one",
            err.trim()
        );
    }

    let Some(image) = session.container_image.as_deref().filter(|i| !i.is_empty()) else {
        anyhow::bail!(
            "This session is set to run in a container but no image was chosen. \
             Pick one from the container chip, or switch it back to this machine."
        );
    };
    if host_workdir.trim().is_empty() || !crate::services::exec_target::is_host_path(host_workdir) {
        anyhow::bail!(
            "There's no folder to mount into the container. Pick a local folder or repo first."
        );
    }

    // Tier B credential mounts have to be decided HERE: mounts are fixed when
    // a container starts and cannot be added to a running one.
    let creds = super::credentials::resolve(
        &session.tool,
        session.container_mount_credentials,
        Some(fleetify_core::user_home().as_path()),
        DEFAULT_CONTAINER_HOME,
    );

    // Pull explicitly so a slow download reports progress instead of
    // hiding inside `docker run`, where it is indistinguishable from a hang.
    if !image_present(image).await {
        pull_image(image, tx).await?;
    }

    report(tx, "start", format!("Starting {image}…"), None);
    let name = container_name_for(&session.id);
    // A container from a previous run of this session may still exist under
    // the same deterministic name (app killed before teardown). Clear it so
    // `docker run --name` does not collide.
    let _ = run_docker(&["rm", "-f", &name], 20).await;

    let spec = RunSpec {
        image: image.to_string(),
        host_workdir: host_workdir.to_string(),
        mounts: creds.mounts,
        envs: Vec::new(),
        // Docker Desktop resolves host.docker.internal on its own; Linux
        // needs the explicit mapping, and adding it where it already works is
        // harmless.
        add_host_gateway: true,
        name: name.clone(),
    };
    let argv = run_argv(&spec);
    let refs: Vec<&str> = argv[1..].iter().map(|s| s.as_str()).collect();
    let (rc, out, err) = run_docker(&refs, 120).await;
    if rc != 0 {
        anyhow::bail!(
            "Couldn't start a container from '{image}': {}",
            last_line(&err).unwrap_or_else(|| format!("docker run exited with code {rc}"))
        );
    }
    // `docker run -d` prints the full id; fall back to the name we chose,
    // which addresses the same container.
    let id = out.trim().lines().last().unwrap_or("").trim().to_string();
    let id = if id.is_empty() { name } else { id };

    sqlx::query("UPDATE sessions SET container_id = ?, container_workdir = ? WHERE id = ?")
        .bind(&id)
        .bind(&workdir)
        .bind(&session.id)
        .execute(pool)
        .await?;
    // Say whether the agent is actually in there. The turn's own pre-flight
    // refuses if it is not, but naming it during setup is what turns "the
    // agent errored" into "your image doesn't have codex installed".
    if let Some(spec) = super::providers::spec_for(&session.tool) {
        report(
            tx,
            "verify",
            format!("Looking for {} inside…", spec.binary),
            None,
        );
        if !probe_agent_cached(&id, spec.binary).await {
            report(
                tx,
                "verify",
                format!("{} isn't installed in this image", spec.binary),
                None,
            );
        }
    }

    tracing::info!(
        target: "fleetify::container",
        session_id = %session.id, container = %id, image,
        credential_mounts = spec.mounts.len(),
        "provisioned a container for this session"
    );
    Ok(Some(format!("{DOCKER_MARKER}{id}{workdir}")))
}

/// Wrap the first character in a bracket expression: `claude` → `[c]laude`.
///
/// The regex still matches `claude`, but the literal string in the pkill
/// command line does not — which is the whole point. `pkill -f` matches
/// against full command lines, and the wrapper's own line
/// (`sh -c pkill -TERM -f claude`) contains `claude`, so an unbracketed
/// pattern makes pkill SIGTERM its own parent shell. Verified against a live
/// BusyBox container: the unbracketed form exits 143 (128+SIGTERM) even when
/// there is nothing to kill; the bracketed form exits 0 and still kills a
/// real match. Same trick as `ps | grep "[s]leep"`.
fn self_excluding_pattern(binary: &str) -> String {
    let mut chars = binary.chars();
    match chars.next() {
        Some(first) => format!("[{first}]{}", chars.as_str()),
        None => String::new(),
    }
}

/// Argv that kills the agent process INSIDE the container.
///
/// Killing the host `docker exec` client does not stop the process on the
/// other side — `docker exec` does not propagate client death — so Stop left
/// the agent running and billing.
///
/// `-f` (full command line) rather than `-x` (exact process name) because the
/// node-based CLIs run as `node` with the agent as an argument, so the
/// process *name* is not the binary name. That makes the self-match above
/// unavoidable without the bracket.
pub fn kill_in_container_argv(container_id: &str, binary: &str) -> Vec<String> {
    let pattern = self_excluding_pattern(binary);
    vec![
        "docker".into(),
        "exec".into(),
        container_id.to_string(),
        "sh".into(),
        "-c".into(),
        // `|| true` so a turn that already finished does not surface a
        // non-zero exit as an abort failure.
        format!("pkill -TERM -f \"{pattern}\" || true"),
    ]
}

/// Stop the agent inside a container, best-effort.
pub async fn kill_in_container(container_id: &str, binary: &str) {
    if !container_id_re().is_match(container_id) {
        return;
    }
    let argv = kill_in_container_argv(container_id, binary);
    let refs: Vec<&str> = argv[1..].iter().map(|s| s.as_str()).collect();
    let (rc, _, err) = run_docker(&refs, 6).await;
    if rc != 0 {
        tracing::warn!(
            target: "fleetify::container",
            container = container_id,
            rc,
            "in-container kill failed: {}",
            err.trim()
        );
        invalidate(container_id);
    }
}

/// Tear down a container Fleetify provisioned.
///
/// Only ever called for `docker-run`. An attached container belongs to the
/// user and is deliberately left alone — deleting a Fleetify session must not
/// stop something they started themselves.
pub async fn teardown_provisioned(container_id: &str) {
    if !container_id_re().is_match(container_id) {
        return;
    }
    let (_rc, _, _) = run_docker(&["rm", "-f", container_id], 20).await;
    invalidate(container_id);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec() -> RunSpec {
        RunSpec {
            image: "node:22".into(),
            host_workdir: "/home/me/repo/.claude/worktrees/feat-x".into(),
            mounts: vec![],
            envs: vec![],
            add_host_gateway: true,
            name: "fleetify-abc123".into(),
        }
    }

    /// The mount is what makes docker-run orthogonal to Git: the container
    /// works on the HOST checkout (the worktree when there is one), so host
    /// git keeps working and the agent's edits land in the real repository.
    #[test]
    fn run_argv_mounts_the_session_workdir_at_a_stable_path() {
        let argv = run_argv(&spec());
        assert!(
            argv.windows(2).any(
                |w| w[0] == "-v" && w[1] == "/home/me/repo/.claude/worktrees/feat-x:/workspace"
            ),
            "{argv:?}"
        );
        assert!(
            argv.windows(2).any(|w| w == ["-w", "/workspace"]),
            "{argv:?}"
        );
    }

    /// Detached + `sleep infinity`: the container outlives the turn, so each
    /// turn is still a plain `docker exec` and the spawn path is unchanged.
    #[test]
    fn run_argv_detaches_and_keeps_the_container_alive() {
        let argv = run_argv(&spec());
        assert!(argv.contains(&"-d".to_string()), "{argv:?}");
        assert_eq!(
            &argv[argv.len() - 2..],
            &["sleep".to_string(), "infinity".to_string()]
        );
    }

    /// Linux does not resolve host.docker.internal without this, so a
    /// loopback-rewritten base URL would point at nothing.
    #[test]
    fn run_argv_maps_the_host_gateway_when_asked() {
        let argv = run_argv(&spec());
        assert!(
            argv.windows(2)
                .any(|w| w[0] == "--add-host" && w[1] == "host.docker.internal:host-gateway"),
            "{argv:?}"
        );
        let mut no_gw = spec();
        no_gw.add_host_gateway = false;
        assert!(!run_argv(&no_gw).iter().any(|a| a == "--add-host"));
    }

    /// The image is the last thing before the command, and every flag
    /// precedes it — anything after the image is an argument to the
    /// container's command, not to docker.
    #[test]
    fn every_flag_precedes_the_image() {
        let mut s = spec();
        s.mounts = vec!["/home/me/.codex:/root/.codex".into()];
        s.envs = vec![("OPENAI_API_KEY".into(), "sk-x".into())];
        let argv = run_argv(&s);
        let image_at = argv.iter().position(|a| a == "node:22").unwrap();
        for flag in ["-v", "-e", "--add-host", "-w", "--name", "-d"] {
            if let Some(at) = argv.iter().rposition(|a| a == flag) {
                assert!(at < image_at, "{flag} must precede the image: {argv:?}");
            }
        }
    }

    /// The credential mount is scoped. The whole home and ~/.ssh are never
    /// mounted, whatever else changes.
    #[test]
    fn run_argv_never_mounts_the_whole_home_or_ssh() {
        let mut s = spec();
        s.mounts = vec!["/home/me/.codex:/root/.codex".into()];
        for a in run_argv(&s) {
            assert!(!a.starts_with("/home/me:"), "whole-home mount: {a}");
            assert!(!a.contains(".ssh"), "ssh mount: {a}");
        }
    }

    /// Killing the host docker client leaves the agent running — docker exec
    /// does not propagate client death. The kill has to happen inside.
    #[test]
    fn abort_kills_the_process_inside_the_container() {
        let argv = kill_in_container_argv("c1", "claude");
        assert_eq!(&argv[..3], &["docker", "exec", "c1"]);
        assert!(
            argv.last().unwrap().contains("pkill"),
            "must kill inside: {argv:?}"
        );
        assert!(
            argv.last().unwrap().contains("]laude"),
            "must name the agent binary (bracketed, see self_excluding_pattern): {argv:?}"
        );
    }

    /// A finished turn has nothing to kill; that must not read as a failure.
    #[test]
    fn abort_tolerates_an_already_finished_turn() {
        assert!(kill_in_container_argv("c1", "codex")
            .last()
            .unwrap()
            .contains("|| true"));
    }

    /// The pattern must NOT appear literally in the command line it is part
    /// of. `pkill -f` matches full command lines, so an unbracketed pattern
    /// makes pkill SIGTERM the very shell running it — verified against a
    /// live BusyBox container, where the unbracketed form exits 143 even
    /// with nothing to kill.
    #[test]
    fn the_kill_pattern_does_not_match_its_own_command_line() {
        let script = kill_in_container_argv("c1", "claude").pop().unwrap();
        assert!(script.contains("[c]laude"), "script: {script}");
        assert!(
            !script.contains("f \"claude\"") && !script.contains("-f claude"),
            "an unbracketed pattern kills the wrapper shell: {script}"
        );
    }

    #[test]
    fn the_kill_pattern_still_matches_the_real_binary() {
        // `[c]laude` as a regex matches the literal `claude`.
        for (binary, expected) in [
            ("claude", "[c]laude"),
            ("codex", "[c]odex"),
            ("agent", "[a]gent"),
        ] {
            assert_eq!(self_excluding_pattern(binary), expected);
        }
    }

    #[test]
    fn an_empty_binary_name_produces_an_empty_pattern_not_a_panic() {
        assert_eq!(self_excluding_pattern(""), "");
    }

    #[test]
    fn container_names_are_deterministic_and_prefixed() {
        let a = container_name_for("3f2a9b1c-4d5e-6789-abcd-ef0123456789");
        assert_eq!(
            a,
            container_name_for("3f2a9b1c-4d5e-6789-abcd-ef0123456789")
        );
        assert!(a.starts_with("fleetify-"));
        // Docker names allow [a-zA-Z0-9][a-zA-Z0-9_.-]*; the hyphens in a
        // uuid are stripped so the tail can never start one.
        assert!(a
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.'));
    }
}

#[cfg(test)]
mod pull_progress_tests {
    use super::is_layer_id;

    /// Verbatim non-TTY output from a live `docker pull alpine:3.19`. The
    /// parser is written against this, not against a guess at the format.
    const REAL_PULL_OUTPUT: &str = "\
3.19: Pulling from library/alpine
17a39c0ba978: Pulling fs layer
fd18d7b2aa35: Download complete
ef1614f30685: Download complete
17a39c0ba978: Download complete
17a39c0ba978: Pull complete
Digest: sha256:6baf43584bcb78f2e5847d1de515f23499913ac9f12bdf834811a3145eb11ca1
Status: Downloaded newer image for alpine:3.19
docker.io/library/alpine:3.19";

    /// The tag header, `Digest:` and `Status:` all match `<x>: <y>` but are
    /// not layers. Counting them inflated the denominator, so a one-layer
    /// image reported 1/4 and the bar never reached 100%.
    #[test]
    fn only_real_layer_ids_count_toward_progress() {
        let mut layers = std::collections::HashSet::new();
        let mut done = std::collections::HashSet::new();
        for line in REAL_PULL_OUTPUT.lines() {
            let Some((id, state)) = line.split_once(": ") else {
                continue;
            };
            let id = id.trim();
            if !is_layer_id(id) {
                continue;
            }
            layers.insert(id.to_string());
            if state.trim().starts_with("Pull complete")
                || state.trim().starts_with("Already exists")
            {
                done.insert(id.to_string());
            }
        }
        assert_eq!(layers.len(), 3, "layers found: {layers:?}");
        assert_eq!(done.len(), 1, "completed: {done:?}");
        assert!(!layers.contains("3.19"), "the tag header is not a layer");
        assert!(!layers.contains("Digest"), "Digest: is not a layer");
        assert!(!layers.contains("Status"), "Status: is not a layer");
    }

    #[test]
    fn layer_ids_are_twelve_lowercase_hex_characters() {
        assert!(is_layer_id("17a39c0ba978"));
        assert!(is_layer_id("fd18d7b2aa35"));
        assert!(!is_layer_id("3.19"));
        assert!(!is_layer_id("Digest"));
        assert!(!is_layer_id("Status"));
        // Too short, too long, and uppercase hex (docker prints lowercase).
        assert!(!is_layer_id("17a39c0ba97"));
        assert!(!is_layer_id("17a39c0ba9780"));
        assert!(!is_layer_id("17A39C0BA978"));
    }
}
