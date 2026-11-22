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

/// Why the last auto-install into a container failed, per (container, agent).
///
/// The failure detail streams into the session as a transient setup step —
/// visible for a second, then gone — while the error that PERSISTS is the
/// spawn pre-flight's generic "not installed". So the one message that
/// explains the situation ("this image has no npm…") evaporated and the one
/// that stays taught nothing. The pre-flight reads this memory to say both.
/// No TTL: the reason stays true until an install succeeds, which clears it.
fn install_failures() -> &'static std::sync::Mutex<HashMap<String, String>> {
    static C: OnceLock<std::sync::Mutex<HashMap<String, String>>> = OnceLock::new();
    C.get_or_init(Default::default)
}

/// The remembered reason the agent could not be auto-installed here, if any.
pub fn last_install_failure(container_id: &str, provider_id: &str) -> Option<String> {
    let binary = super::providers::spec_for(provider_id)?.binary;
    install_failures()
        .lock()
        .ok()?
        .get(&key(container_id, binary))
        .cloned()
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
        // `--entrypoint sleep` rather than a trailing `sleep infinity`
        // command. On an image with an ENTRYPOINT (every service image:
        // typesense, postgres, redis…) a trailing command is passed as
        // ARGUMENTS to that entrypoint — verified live: the container ran
        // `<entrypoint> sleep infinity` and exited instantly, so the very
        // first exec found it dead. Overriding the entrypoint makes every
        // image behave identically: an inert box we exec the agent into.
        // That is also the honest contract — Image mode is the agent's
        // runtime, not a way to run the image's own service (a service
        // belongs beside the agent, via Compose).
        "--entrypoint".into(),
        "sleep".into(),
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
    // The overridden entrypoint's argument: sleep forever, so the container
    // outlives the turn and every turn is a plain `docker exec`.
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
    let detail = detail.into();
    // Every setup step also lands in the terminal, so a container session's
    // whole preparation is greppable (`fleetify::container`) after the
    // transient in-session pill has moved on. Per-layer pull ticks carry a
    // pct and go to debug — dozens per pull; the milestones go to info.
    if pct.is_some() {
        tracing::debug!(target: "fleetify::container::setup", step, detail = %detail, pct = ?pct);
    } else {
        tracing::info!(target: "fleetify::container::setup", step, detail = %detail);
    }
    if let Some(tx) = tx {
        let _ = tx.send(SetupEvent { step, detail, pct });
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
    let mut child = fleetify_core::process::tokio_command("docker")
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
        let reason = last_line(&err).unwrap_or_else(|| "docker pull failed".into());
        match pull_error_hint(image, &reason) {
            Some(hint) => anyhow::bail!("Couldn't pull '{image}': {reason}. {hint}"),
            None => anyhow::bail!("Couldn't pull '{image}': {reason}"),
        }
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

/// Deterministic tag for an image built from a session's Dockerfile, so a
/// rebuild replaces it and session delete can remove it.
pub fn image_name_for(session_id: &str) -> String {
    let short: String = session_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(12)
        .collect();
    format!("fleetify-img-{short}")
}

/// Resolve a Dockerfile / compose path against the session's host workdir.
/// Relative paths are the normal case ("Dockerfile", "docker-compose.yml");
/// absolute ones are accepted as-is.
fn resolve_project_file(host_workdir: &str, file: &str) -> std::path::PathBuf {
    let p = std::path::Path::new(file);
    if p.is_absolute() {
        p.to_path_buf()
    } else {
        std::path::Path::new(host_workdir).join(p)
    }
}

/// `docker build` with the project as context, streaming step headers.
///
/// BuildKit (the default builder) writes its progress to STDERR in plain
/// mode; step headers look like `#7 [3/5] RUN npm ci`. Streaming those —
/// and only those — gives the user "which layer am I on" without drowning
/// the session in raw build noise.
async fn build_image(
    tag: &str,
    dockerfile: &std::path::Path,
    context_dir: &str,
    tx: Option<&SetupTx>,
) -> anyhow::Result<()> {
    use tokio::io::{AsyncBufReadExt, BufReader};

    report(
        tx,
        "build",
        "Building the image from your Dockerfile…",
        None,
    );
    let mut child = fleetify_core::process::tokio_command("docker")
        .args([
            "build",
            "-t",
            tag,
            "-f",
            &dockerfile.to_string_lossy(),
            context_dir,
        ])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| anyhow::anyhow!("couldn't run docker build: {e}"))?;

    // Keep a bounded tail of stderr for the failure message while streaming
    // the step headers out of it.
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| anyhow::anyhow!("docker build: no stderr"))?;
    let mut tail: std::collections::VecDeque<String> = std::collections::VecDeque::new();
    let mut lines = BufReader::new(stderr).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        if tail.len() >= 30 {
            tail.pop_front();
        }
        tail.push_back(line.clone());
        if let Some(step) = build_step_header(&line) {
            report(tx, "build", step, None);
        }
    }
    let status = child
        .wait()
        .await
        .map_err(|e| anyhow::anyhow!("docker build: {e}"))?;
    if !status.success() {
        let detail = tail
            .iter()
            .rev()
            .find(|l| l.contains("ERROR") || l.contains("error"))
            .cloned()
            .or_else(|| tail.back().cloned())
            .unwrap_or_else(|| "docker build failed".into());
        anyhow::bail!("Building the Dockerfile failed: {}", detail.trim());
    }
    Ok(())
}

/// Turn docker's tag-not-found into advice the user can act on.
///
/// `docker pull name` silently means `name:latest`, and a real, existing
/// repository that publishes only versioned tags (Typesense is the live
/// example — 1300+ tags, deliberately no `latest`) then fails with
/// "not found", which reads as "this image doesn't exist" when the actual
/// problem is one missing tag. Only fires when the user wrote no tag —
/// an explicit `name:29.0` failing really does mean what docker said.
fn pull_error_hint(image: &str, err: &str) -> Option<String> {
    // A tag separator after the last `/` means the user chose a tag
    // themselves (the check skips registry ports, as in `host:5000/img`).
    let named_a_tag = image
        .rsplit('/')
        .next()
        .is_some_and(|seg| seg.contains(':'));
    if named_a_tag || !err.contains("not found") {
        return None;
    }
    // One line on purpose: a continuation (`\` + newline) here has twice
    // been flattened into literal space runs by patch tooling, and the
    // mangled text shipped to the user's screen. The double-space test
    // below pins it either way.
    Some(format!(
        "'{image}' means '{image}:latest', and that tag doesn't exist — some repositories only publish versioned tags. Try a specific version, e.g. '{image}:<version>'."
    ))
}

/// The `[x/y] STEP` part of a BuildKit progress line, when the line is a
/// step header. `#7 [3/5] RUN npm ci` → `[3/5] RUN npm ci`; timing/output
/// lines (`#7 0.412 …`, `#7 DONE 1.2s`) return None so they are not
/// streamed into the session.
fn build_step_header(line: &str) -> Option<String> {
    let rest = line.strip_prefix('#')?;
    let (num, rest) = rest.split_once(' ')?;
    if num.is_empty() || !num.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let rest = rest.trim();
    rest.starts_with('[').then(|| rest.to_string())
}

/// Is the `docker compose` v2 plugin available? The v1 standalone
/// `docker-compose` binary is EOL and its flags differ; refusing with a
/// clear message beats half-working against it.
async fn compose_available() -> bool {
    let (rc, _, _) = run_docker(&["compose", "version"], 10).await;
    rc == 0
}

/// The services a compose file defines — for the "which one?" error.
async fn compose_services(file: &std::path::Path) -> Vec<String> {
    let (rc, out, _) = run_docker(
        &[
            "compose",
            "-f",
            &file.to_string_lossy(),
            "config",
            "--services",
        ],
        30,
    )
    .await;
    if rc != 0 {
        return Vec::new();
    }
    out.lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect()
}

/// The running container id of one compose service, if it is up.
async fn compose_service_container(file: &std::path::Path, service: &str) -> Option<String> {
    let (rc, out, _) = run_docker(
        &[
            "compose",
            "-f",
            &file.to_string_lossy(),
            "ps",
            "-q",
            service,
        ],
        30,
    )
    .await;
    if rc != 0 {
        return None;
    }
    out.lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .map(str::to_string)
}

/// Install the provider's CLI into a container Fleetify started, when it is
/// missing. Never runs against an attached container — that one belongs to
/// the user, and installing software into it uninvited is not ours to do.
///
/// Best-effort by design: a failure is reported as a setup step (naming the
/// real blocker, e.g. "npm: not found") and the turn's own pre-flight then
/// refuses with the standard not-installed message. The alternative —
/// failing provisioning outright — would brick the session for something
/// the user can fix by hand inside the container.
async fn auto_install_agent(container_id: &str, provider_id: &str, tx: Option<&SetupTx>) {
    let Some(spec) = super::providers::spec_for(provider_id) else {
        return;
    };
    if probe_agent_cached(container_id, spec.binary).await {
        return;
    }
    let Some(cmd) = spec.install_sh else {
        return;
    };
    report(
        tx,
        "install",
        format!("Installing {} (this can take a minute)…", spec.binary),
        None,
    );
    // Generous timeout: a global npm install of a large CLI on a cold image
    // is minutes, not seconds.
    tracing::info!(
        target: "fleetify::container",
        container = container_id,
        binary = spec.binary,
        install_cmd = cmd,
        "auto-install: agent missing, installing"
    );
    let (rc, _out, err) = run_docker(&["exec", container_id, "sh", "-c", cmd], 420).await;
    invalidate(container_id);
    if rc == 0 && probe_agent_cached(container_id, spec.binary).await {
        if let Ok(mut m) = install_failures().lock() {
            m.remove(&key(container_id, spec.binary));
        }
        tracing::info!(
            target: "fleetify::container",
            container = container_id,
            binary = spec.binary,
            "auto-install: succeeded"
        );
        report(tx, "install", format!("{} installed", spec.binary), None);
    } else {
        let why = last_line(&err).unwrap_or_else(|| format!("exit code {rc}"));
        let detail = install_failure_detail(spec.binary, cmd, &why);
        tracing::warn!(
            target: "fleetify::container",
            container = container_id,
            binary = spec.binary,
            rc,
            reason = %why,
            "auto-install: FAILED"
        );
        if let Ok(mut m) = install_failures().lock() {
            m.insert(key(container_id, spec.binary), detail.clone());
        }
        report(tx, "install", detail, None);
    }
}

/// Phrase an auto-install failure so it names the actual blocker.
///
/// The common real-world case: the picked image is a *service* image — a
/// database, a search engine — that ships no package tooling at all, so the
/// install dies on `npm: not found` (or curl/pip). Reporting that line raw
/// reads like a bug in the install; what it means is "this image cannot host
/// the agent", and the fix is a dev image for the agent — with the service
/// beside it via Compose when they need each other.
fn install_failure_detail(binary: &str, install_cmd: &str, why: &str) -> String {
    let missing_tool = ["npm", "node", "curl", "bash", "pip", "python3"]
        .iter()
        .find(|t| {
            let w = why.to_ascii_lowercase();
            (w.contains(&format!("{t}: not found"))
                || w.contains(&format!("{t}: command not found"))
                || w.contains(&format!("\"{t}\": executable file not found")))
                && install_cmd.contains(*t)
        });
    match missing_tool {
        Some(tool) => format!(
            "Couldn't install {binary}: this image has no `{tool}`, so it can't host the agent. Pick a dev image (e.g. node:22) for the agent — if you need this image's service too, run it beside the agent with Compose."
        ),
        None => format!("Couldn't install {binary} automatically: {why}"),
    }
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
    // A compose stack manages its own containers — ids change when compose
    // recreates a service — so it gets a dedicated flow that re-resolves the
    // service container every time instead of trusting the stored id.
    if session.container_source == "compose" {
        return ensure_compose(pool, session, host_workdir, tx)
            .await
            .map(Some);
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
            // The reuse shortcut must still ensure the agent. Skipping it
            // here made the install a one-shot: a container provisioned
            // before auto-install existed — or whose install failed once
            // (network blip, image fixed since) — stayed agentless FOREVER,
            // because every later turn took this early return. The call is
            // near-free when the agent is present (one cached probe).
            auto_install_agent(id, &session.tool, tx).await;
            return Ok(Some(format!("{DOCKER_MARKER}{id}{workdir}")));
        }
        report(tx, "start", "Restarting the container…", None);
        let (rc, _, err) = run_docker(&["start", id], 20).await;
        if rc == 0 {
            invalidate(id);
            auto_install_agent(id, &session.tool, tx).await;
            return Ok(Some(format!("{DOCKER_MARKER}{id}{workdir}")));
        }
        tracing::warn!(
            target: "fleetify::container",
            session_id = %session.id, container = id,
            "could not restart the session's container ({}); provisioning a fresh one",
            err.trim()
        );
    }

    if host_workdir.trim().is_empty() || !crate::services::exec_target::is_host_path(host_workdir) {
        anyhow::bail!(
            "There's no folder to mount into the container. Pick a local folder or repo first."
        );
    }
    // Which image to run: a named one, or one built from the project's own
    // Dockerfile. A build happens only when provisioning a fresh container
    // (this code path); rebuilding after an edited Dockerfile is what the
    // user expects, and layer caching keeps the unchanged case fast.
    let built_tag;
    let image: &str = if session.container_source == "dockerfile" {
        let file = session
            .container_file
            .clone()
            .filter(|f| !f.trim().is_empty())
            .unwrap_or_else(|| "Dockerfile".to_string());
        let resolved = resolve_project_file(host_workdir, &file);
        if !resolved.is_file() {
            anyhow::bail!(
                "Couldn't find the Dockerfile at {} — check the path in the container settings.",
                resolved.display()
            );
        }
        built_tag = image_name_for(&session.id);
        build_image(&built_tag, &resolved, host_workdir, tx).await?;
        &built_tag
    } else {
        let Some(image) = session.container_image.as_deref().filter(|i| !i.is_empty()) else {
            anyhow::bail!(
                "This session is set to run in a container but no image was chosen. \
                 Pick one from the container settings, or switch it back to this machine."
            );
        };
        image
    };

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
    // A tag we just built exists only locally — pulling it would 404.
    if session.container_source != "dockerfile" && !image_present(image).await {
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
    // This container is Fleetify's own (image or Dockerfile), so installing
    // the missing CLI into it is fair game — an attached container never
    // reaches this code path.
    auto_install_agent(&id, &session.tool, tx).await;

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

/// The compose flavour of [`ensure_ready`].
///
/// The stack belongs to the user: `docker compose up -d` is idempotent (a
/// running stack is a fast no-op), Fleetify only ever *starts* it, and
/// session delete leaves it alone entirely. The one container Fleetify
/// touches beyond that is the chosen service's — to exec the agent, and to
/// install the CLI into it when missing (which the user opted into by
/// picking compose as the source).
async fn ensure_compose(
    pool: &sqlx::SqlitePool,
    session: &crate::models::session::Session,
    host_workdir: &str,
    tx: Option<&SetupTx>,
) -> anyhow::Result<String> {
    if host_workdir.trim().is_empty() || !crate::services::exec_target::is_host_path(host_workdir) {
        anyhow::bail!(
            "There's no project folder for the compose file to live in. Pick a local folder first."
        );
    }
    if !compose_available().await {
        anyhow::bail!(
            "Docker Compose v2 isn't available (`docker compose version` failed). \
             Install the compose plugin, or start the session from an image instead."
        );
    }
    let file = session
        .container_file
        .clone()
        .filter(|f| !f.trim().is_empty())
        .unwrap_or_else(|| "docker-compose.yml".to_string());
    let resolved = resolve_project_file(host_workdir, &file);
    if !resolved.is_file() {
        anyhow::bail!(
            "Couldn't find the compose file at {} — check the path in the container settings.",
            resolved.display()
        );
    }
    let file_str = resolved.to_string_lossy().into_owned();

    report(tx, "start", "Starting your compose stack…", None);
    let (rc, _, err) = run_docker(&["compose", "-f", &file_str, "up", "-d"], 600).await;
    if rc != 0 {
        anyhow::bail!(
            "`docker compose up` failed: {}",
            last_line(&err).unwrap_or_else(|| format!("exit code {rc}"))
        );
    }

    // Which service the agent lives in. With exactly one service the answer
    // is obvious; with several, refuse by NAME so the fix is a copy-paste.
    let service = match session
        .container_service
        .clone()
        .filter(|v| !v.trim().is_empty())
    {
        Some(s) => s,
        None => {
            let services = compose_services(&resolved).await;
            match services.as_slice() {
                [only] => only.clone(),
                [] => anyhow::bail!("The compose file defines no services Fleetify can see."),
                many => anyhow::bail!(
                    "The compose file defines several services ({}). Name the one the agent \
                     should run in, in the container settings.",
                    many.join(", ")
                ),
            }
        }
    };
    let Some(id) = compose_service_container(&resolved, &service).await else {
        let services = compose_services(&resolved).await;
        anyhow::bail!(
            "Service '{service}' has no running container after `compose up`. Services in this \
             file: {}.",
            if services.is_empty() {
                "(none)".to_string()
            } else {
                services.join(", ")
            }
        );
    };

    // The service's own working directory — compose owns the container's
    // config, including its mounts, so /workspace does not exist here unless
    // the user's file created it.
    let (rc, wd_out, _) = run_docker(&["inspect", "-f", "{{.Config.WorkingDir}}", &id], 10).await;
    let workdir = match (rc, wd_out.trim()) {
        (0, w) if !w.is_empty() => w.to_string(),
        _ => "/".to_string(),
    };

    sqlx::query("UPDATE sessions SET container_id = ?, container_workdir = ? WHERE id = ?")
        .bind(&id)
        .bind(&workdir)
        .bind(&session.id)
        .execute(pool)
        .await?;

    // We started this service, and the user chose compose as the source —
    // installing the missing CLI into it is what they asked for.
    auto_install_agent(&id, &session.tool, tx).await;
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
                format!("{} isn't installed in the '{service}' service", spec.binary),
                None,
            );
        }
    }

    Ok(format!("{DOCKER_MARKER}{id}{workdir}"))
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

/// Remove the image a session's Dockerfile build produced. Best-effort —
/// a shared layer being in use is not an error worth surfacing.
pub async fn remove_built_image(session_id: &str) {
    let tag = image_name_for(session_id);
    let _ = run_docker(&["image", "rm", "-f", &tag], 30).await;
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

    /// Detached and kept alive via an ENTRYPOINT OVERRIDE, not a trailing
    /// command. A trailing `sleep infinity` is passed as arguments to any
    /// entrypoint the image defines — verified live on an ENTRYPOINT image:
    /// the container exited instantly and the first exec found it dead.
    #[test]
    fn run_argv_detaches_and_keeps_the_container_alive() {
        let argv = run_argv(&spec());
        assert!(argv.contains(&"-d".to_string()), "{argv:?}");
        assert!(
            argv.windows(2)
                .any(|w| w[0] == "--entrypoint" && w[1] == "sleep"),
            "the entrypoint must be overridden, or service images die at start: {argv:?}"
        );
        assert_eq!(argv.last().unwrap(), "infinity");
        // And the image comes right before its single argument.
        let image_at = argv.iter().position(|a| a == "node:22").unwrap();
        assert_eq!(image_at + 2, argv.len());
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
        for flag in [
            "-v",
            "-e",
            "--add-host",
            "-w",
            "--name",
            "-d",
            "--entrypoint",
        ] {
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

#[cfg(test)]
mod build_source_tests {
    use super::*;

    /// BuildKit interleaves step headers with timing and output lines under
    /// the same `#N` prefix. Only the headers belong in the session — the
    /// rest is build noise that would drown the status.
    #[test]
    fn only_step_headers_stream_into_the_session() {
        assert_eq!(
            build_step_header("#7 [3/5] RUN npm ci").as_deref(),
            Some("[3/5] RUN npm ci")
        );
        assert_eq!(
            build_step_header("#2 [internal] load build definition from Dockerfile").as_deref(),
            Some("[internal] load build definition from Dockerfile")
        );
        for noise in [
            "#7 0.412 added 231 packages",
            "#7 DONE 1.2s",
            "#7 CACHED",
            "Sending build context to Docker daemon",
            "Step 3/5 : RUN npm ci",
            "#abc [x] not a number",
        ] {
            assert!(
                build_step_header(noise).is_none(),
                "streamed noise: {noise}"
            );
        }
    }

    #[test]
    fn built_image_tags_are_deterministic_and_session_scoped() {
        let a = image_name_for("3f2a9b1c-4d5e-6789-abcd-ef0123456789");
        assert_eq!(a, image_name_for("3f2a9b1c-4d5e-6789-abcd-ef0123456789"));
        assert!(a.starts_with("fleetify-img-"));
        assert_ne!(a, image_name_for("00000000-1111-2222-3333-444444444444"));
    }

    /// Relative is the normal case ("Dockerfile", "docker-compose.yml");
    /// an absolute path must pass through untouched rather than being
    /// glued onto the project dir.
    #[test]
    fn project_files_resolve_relative_to_the_workdir() {
        let rel = resolve_project_file("/home/me/proj", "docker/Dockerfile.dev");
        assert_eq!(
            rel,
            std::path::Path::new("/home/me/proj/docker/Dockerfile.dev")
        );
        let abs = if cfg!(windows) {
            r"C:\x\Dockerfile"
        } else {
            "/x/Dockerfile"
        };
        assert_eq!(
            resolve_project_file("/home/me/proj", abs),
            std::path::Path::new(abs)
        );
    }
}

#[cfg(test)]
mod pull_hint_tests {
    use super::pull_error_hint;

    /// The live case: typesense/typesense exists with 1300+ tags and no
    /// `latest`. Docker's "not found" reads as "no such image"; the hint
    /// names the actual problem — the implied tag.
    #[test]
    fn a_tagless_not_found_gets_the_latest_tag_hint() {
        let hint = pull_error_hint(
            "typesense/typesense",
            "docker.io/typesense/typesense:latest: not found",
        )
        .expect("should hint");
        assert!(hint.contains("typesense/typesense:latest"), "{hint}");
        assert!(hint.contains("versioned tags"), "{hint}");
        assert!(!hint.contains("  "), "double spaces leaked into: {hint}");
    }

    /// An explicit tag failing really does mean what docker said.
    #[test]
    fn an_explicit_tag_gets_no_hint() {
        assert!(pull_error_hint(
            "typesense/typesense:99.9",
            "typesense/typesense:99.9: not found"
        )
        .is_none());
    }

    /// A registry PORT is not a tag: `host:5000/img` still implies latest.
    #[test]
    fn a_registry_port_is_not_mistaken_for_a_tag() {
        assert!(pull_error_hint(
            "registry.local:5000/team/img",
            "registry.local:5000/team/img:latest: not found"
        )
        .is_some());
    }

    /// Other failures (auth, network) keep their own message unpolluted.
    #[test]
    fn non_not_found_errors_get_no_hint() {
        assert!(pull_error_hint("busybox", "unauthorized: authentication required").is_none());
    }
}

#[cfg(test)]
mod install_failure_tests {
    use super::install_failure_detail;

    /// The real-world shape: a service image (database, search engine) with
    /// no package tooling. The raw `npm: not found` reads like an installer
    /// bug; the message must say the image cannot host the agent and point
    /// at the two actual fixes.
    #[test]
    fn a_missing_tool_names_the_image_as_the_problem() {
        let d = install_failure_detail(
            "claude",
            "npm install -g @anthropic-ai/claude-code",
            "sh: npm: not found",
        );
        assert!(d.contains("no `npm`"), "{d}");
        assert!(d.contains("node:22"), "{d}");
        assert!(d.contains("Compose"), "{d}");
        // The python patch tooling once collapsed Rust line-continuations
        // into literal space runs, and the mangled text shipped to the
        // user's screen ("host the              agent"). Never again.
        assert!(!d.contains("  "), "double spaces leaked into: {d}");
    }

    /// docker's own phrasing for a missing exec target must match too.
    #[test]
    fn dockers_executable_not_found_phrasing_matches() {
        let d = install_failure_detail(
            "cursor",
            "curl https://cursor.com/install -fsS | bash",
            r#"OCI runtime exec failed: "curl": executable file not found in $PATH"#,
        );
        assert!(d.contains("no `curl`"), "{d}");
    }

    /// A tool the command never uses must not be blamed for the failure.
    #[test]
    fn only_tools_the_command_uses_are_considered() {
        let d = install_failure_detail(
            "codex",
            "npm install -g @openai/codex",
            "sh: curl: not found",
        );
        assert!(!d.contains("no `curl`"), "{d}");
        assert!(d.contains("automatically"), "{d}");
    }

    /// Network/auth failures keep the raw reason — they are not the image's
    /// fault and the dev-image advice would be wrong.
    #[test]
    fn other_failures_keep_the_raw_reason() {
        let d = install_failure_detail(
            "codex",
            "npm install -g @openai/codex",
            "npm ERR! network request failed",
        );
        assert!(d.contains("network request failed"), "{d}");
        assert!(!d.contains("Compose"), "{d}");
    }
}

#[cfg(test)]
mod install_memory_tests {
    use super::*;

    /// The pre-flight's generic "not installed" persists while the setup
    /// step that EXPLAINS it is transient — so the reason has to be
    /// rememberable after the pill is gone.
    #[test]
    fn a_recorded_failure_is_readable_until_cleared() {
        let k = key("memtest-c1", "claude");
        install_failures()
            .lock()
            .unwrap()
            .insert(k.clone(), "this image has no `npm`".into());
        assert_eq!(
            last_install_failure("memtest-c1", "claude-code").as_deref(),
            Some("this image has no `npm`")
        );
        // Success clears it — the reason stops being true.
        install_failures().lock().unwrap().remove(&k);
        assert!(last_install_failure("memtest-c1", "claude-code").is_none());
    }

    /// Keyed per agent: codex failing must not explain a claude refusal.
    #[test]
    fn failures_are_scoped_to_the_agent_that_failed() {
        install_failures()
            .lock()
            .unwrap()
            .insert(key("memtest-c2", "codex"), "no npm".into());
        assert!(last_install_failure("memtest-c2", "claude-code").is_none());
        assert!(last_install_failure("memtest-c2", "codex-cli").is_some());
        install_failures()
            .lock()
            .unwrap()
            .remove(&key("memtest-c2", "codex"));
    }
}
