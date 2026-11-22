//! Faithful port of `app/routers/docker.py`. Wraps the local `docker`
//! CLI so the Docker tab in the new-session toolbar can probe daemon
//! health, list running containers, and browse a container's
//! filesystem — same shape as the SSH router.
//!
//! Agent execution inside the container is no longer a follow-up: see
//! `services::exec_target` for the `docker exec` argv and
//! `bridges::claude` for the spawn path. `probe_agent` here is what tells
//! the picker whether the CLI is actually installed in the target.

use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::routers::{ApiError, AppState};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/docker/status", get(status))
        .route("/docker/containers", get(containers))
        .route("/docker/images", get(images))
        .route("/docker/compose-scaffold", post(compose_scaffold))
        .route("/docker/list-dir", post(list_dir))
        .route("/docker/probe-agent", post(probe_agent))
}

pub(crate) fn container_id_re() -> &'static regex::Regex {
    static R: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    R.get_or_init(|| regex::Regex::new(r"^[A-Za-z0-9][A-Za-z0-9._-]*$").expect("container_id_re"))
}

#[derive(Deserialize)]
struct ListDirReq {
    container_id: String,
    #[serde(default = "default_path")]
    path: String,
}
fn default_path() -> String {
    "/".into()
}

fn docker_path() -> Option<std::path::PathBuf> {
    which::which("docker").ok()
}

/// Run a docker subprocess and return `(rc, stdout, stderr)`. Times
/// out at `timeout_secs`; on timeout returns 124 + the same
/// "Timed out talking to the Docker daemon." message Python emits.
pub(crate) async fn run_docker(cmd: &[&str], timeout_secs: u64) -> (i32, String, String) {
    let started = std::time::Instant::now();
    let logged = sanitize_docker_argv(cmd);
    let child = match fleetify_core::process::tokio_command("docker")
        .args(cmd)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => return (-1, String::new(), format!("spawn docker failed: {e}")),
    };
    let wait = tokio::time::timeout(
        std::time::Duration::from_secs(timeout_secs),
        child.wait_with_output(),
    )
    .await;
    let out = match wait {
        Err(_) => (
            124,
            String::new(),
            "Timed out talking to the Docker daemon.".into(),
        ),
        Ok(Err(e)) => (-1, String::new(), e.to_string()),
        Ok(Ok(o)) => (
            o.status.code().unwrap_or(0),
            String::from_utf8_lossy(&o.stdout).into_owned(),
            String::from_utf8_lossy(&o.stderr).into_owned(),
        ),
    };
    // Every docker CLI call the app makes, one greppable line each
    // (`fleetify::docker`) — argv, exit code, duration. Failures at warn so
    // a broken flow stands out of a default info-level terminal; successes
    // at debug to keep the hot path quiet. Env VALUES are redacted before
    // logging: exec/run argv carries -e API_KEY=… pairs.
    //
    // An expected miss is not a failure: `command -v claude` answering
    // "absent" exits 1/127 with NOTHING on stderr, and every provisioning
    // pass probes like that on purpose — logging those as `docker FAILED`
    // filled the terminal with warnings for a flow that was working
    // exactly as designed. Real failures say why on stderr and stay warn.
    if out.0 == 0 || is_expected_miss(out.0, &out.2) {
        tracing::debug!(
            target: "fleetify::docker",
            argv = %logged,
            rc = out.0,
            ms = started.elapsed().as_millis() as u64,
            "docker"
        );
    } else {
        tracing::warn!(
            target: "fleetify::docker",
            argv = %logged,
            rc = out.0,
            ms = started.elapsed().as_millis() as u64,
            stderr = %out.2.trim().lines().last().unwrap_or(""),
            "docker FAILED"
        );
    }
    out
}

/// A non-zero exit that answers a question rather than reporting a
/// failure: probe-style commands (`command -v`, `test -f`) exit 1/127 with
/// an empty stderr when the answer is simply "no".
fn is_expected_miss(rc: i32, stderr: &str) -> bool {
    matches!(rc, 1 | 127) && stderr.trim().is_empty()
}

/// The argv as one loggable string, with env VALUES masked.
///
/// `docker exec -e XAI_API_KEY=xai-… id claude` must never reach the log
/// with the key intact — names are enough to debug ("was the key passed at
/// all?"), matching the header-names-only precedent in the claude bridge.
fn sanitize_docker_argv(cmd: &[&str]) -> String {
    let mut parts: Vec<String> = Vec::with_capacity(cmd.len() + 1);
    parts.push("docker".to_string());
    let mut mask_next = false;
    for a in cmd {
        if mask_next {
            mask_next = false;
            match a.split_once('=') {
                Some((k, _)) => parts.push(format!("{k}=***")),
                None => parts.push("***".to_string()),
            }
            continue;
        }
        if *a == "-e" || *a == "--env" {
            mask_next = true;
        }
        parts.push((*a).to_string());
    }
    parts.join(" ")
}

async fn status() -> Json<Value> {
    if docker_path().is_none() {
        return Json(json!({ "installed": false, "running": false, "error": null }));
    }
    let (rc, _out, err) = run_docker(&["info"], 4).await;
    if rc != 0 {
        let short = last_line(&err).unwrap_or_else(|| "Docker daemon is not reachable".into());
        return Json(json!({ "installed": true, "running": false, "error": short }));
    }
    Json(json!({ "installed": true, "running": true, "error": null }))
}

async fn containers() -> Result<Json<Value>, ApiError> {
    if docker_path().is_none() {
        return Err(ApiError::BadRequest("Docker is not installed.".into()));
    }
    let (rc, out, err) = run_docker(&["ps", "--format", "{{json .}}"], 6).await;
    if rc != 0 {
        let short = last_line(&err).unwrap_or_else(|| format!("docker ps exited with code {rc}"));
        return Err(ApiError::BadRequest(short));
    }
    let mut items: Vec<Value> = Vec::new();
    for raw in out.lines() {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(row) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        items.push(json!({
            "id":     row.get("ID").and_then(|x| x.as_str()).unwrap_or(""),
            "name":   row.get("Names").and_then(|x| x.as_str()).unwrap_or(""),
            "image":  row.get("Image").and_then(|x| x.as_str()).unwrap_or(""),
            "status": row.get("Status").and_then(|x| x.as_str()).unwrap_or(""),
            "state":  row.get("State").and_then(|x| x.as_str()).unwrap_or("running"),
        }));
    }
    Ok(Json(json!({ "containers": items })))
}

/// Local images, for the run-from-image picker. Untagged build layers
/// (`<none>`) are noise there and are dropped.
async fn images() -> Result<Json<Value>, ApiError> {
    if docker_path().is_none() {
        return Err(ApiError::BadRequest("Docker is not installed.".into()));
    }
    let (rc, out, err) = run_docker(&["image", "ls", "--format", "{{json .}}"], 10).await;
    if rc != 0 {
        let short =
            last_line(&err).unwrap_or_else(|| format!("docker image ls exited with code {rc}"));
        return Err(ApiError::BadRequest(short));
    }
    let mut items: Vec<Value> = Vec::new();
    for raw in out.lines() {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(row) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let repo = row.get("Repository").and_then(|x| x.as_str()).unwrap_or("");
        let tag = row.get("Tag").and_then(|x| x.as_str()).unwrap_or("");
        if repo.is_empty() || repo == "<none>" || tag == "<none>" {
            continue;
        }
        items.push(json!({
            "name": format!("{repo}:{tag}"),
            "size": row.get("Size").and_then(|x| x.as_str()).unwrap_or(""),
            "id":   row.get("ID").and_then(|x| x.as_str()).unwrap_or(""),
        }));
    }
    Ok(Json(json!({ "images": items })))
}

async fn list_dir(Json(req): Json<ListDirReq>) -> Result<Json<Value>, ApiError> {
    if req.container_id.is_empty()
        || req.container_id.len() > 128
        || !container_id_re().is_match(&req.container_id)
    {
        return Err(ApiError::BadRequest("invalid container_id".into()));
    }
    if req.path.len() > 2048 {
        return Err(ApiError::BadRequest("path too long".into()));
    }
    if docker_path().is_none() {
        return Err(ApiError::BadRequest("Docker is not installed.".into()));
    }
    let quoted = sh_quote(&req.path);
    let script = format!(
        "cd {quoted} 2>/dev/null && \
        for f in $(ls -A); do \
          printf '%s\\t' \"$f\"; \
          stat -c '%F\\t%s' -- \"$f\" 2>/dev/null \
          || stat -f '%HT\\t%z' -- \"$f\" 2>/dev/null \
          || printf 'unknown\\t0'; \
          printf '\\n'; \
        done"
    );
    let (rc, out, err) = run_docker(&["exec", &req.container_id, "sh", "-c", &script], 8).await;
    if rc != 0 {
        let short = last_line(&err).unwrap_or_else(|| format!("docker exec exited with code {rc}"));
        return Err(ApiError::BadRequest(short));
    }
    let mut entries: Vec<Value> = Vec::new();
    for line in out.lines() {
        let parts: Vec<&str> = line.split('\t').collect();
        if parts.len() < 3 {
            continue;
        }
        let name = parts[0];
        let kind_raw = parts[1].to_lowercase();
        let size_raw = parts[2];
        if name.is_empty() || name == "." || name == ".." {
            continue;
        }
        let kind = if kind_raw.contains("directory") {
            "folder"
        } else {
            "file"
        };
        let size: i64 = size_raw.parse().unwrap_or(0);
        let size_v: Value = if kind == "file" {
            json!(size)
        } else {
            Value::Null
        };
        entries.push(json!({ "name": name, "type": kind, "size": size_v }));
    }
    entries.sort_by(|a, b| {
        let a_folder = a["type"] == "folder";
        let b_folder = b["type"] == "folder";
        let a_name = a["name"].as_str().unwrap_or("").to_lowercase();
        let b_name = b["name"].as_str().unwrap_or("").to_lowercase();
        match (a_folder, b_folder) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a_name.cmp(&b_name),
        }
    });
    Ok(Json(json!({ "path": req.path, "entries": entries })))
}

#[derive(Deserialize)]
struct ScaffoldReq {
    /// Host project directory the file is written into.
    dir: String,
    /// The service image the user picked (e.g. `typesense/typesense:30.2`).
    image: String,
}

/// A service name docker compose will accept, derived from the image:
/// the repo leaf without registry/tag, squashed to `[a-z0-9-]`. `dev` is
/// reserved for the agent's own service.
fn scaffold_service_name(image: &str) -> String {
    let leaf = image.rsplit('/').next().unwrap_or(image);
    let base = leaf.split(':').next().unwrap_or(leaf);
    let mut name: String = base
        .to_ascii_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    name = name.trim_matches('-').to_string();
    if name.is_empty() || name == "dev" {
        "service".to_string()
    } else {
        name
    }
}

/// Write a starter compose file: the picked image as a service, plus a
/// `dev` service the agent runs in.
///
/// This is the answer to "I picked typesense as the image and claude can't
/// install there": the agent's runtime and the service are two different
/// containers, and Compose is how they sit side by side. Generating the
/// file — rather than layering node onto an arbitrary base image — is
/// deterministic: no distro detection, no package-manager roulette, no
/// distroless dead ends, and the result is a plain file in the repo the
/// user can read and edit. Never overwrites: an existing compose file is
/// the user's, whatever its content.
async fn compose_scaffold(Json(req): Json<ScaffoldReq>) -> Result<Json<Value>, ApiError> {
    let dir = req.dir.trim();
    let image = req.image.trim();
    if dir.is_empty() || image.is_empty() {
        return Err(ApiError::BadRequest("dir and image are required".into()));
    }
    if !crate::services::exec_target::is_host_path(dir) {
        return Err(ApiError::BadRequest(
            "The compose file has to live in a local project folder.".into(),
        ));
    }
    let root = std::path::Path::new(dir);
    if !root.is_dir() {
        return Err(ApiError::BadRequest(format!(
            "Project folder does not exist: {dir}"
        )));
    }
    for existing in [
        "docker-compose.yml",
        "docker-compose.yaml",
        "compose.yml",
        "compose.yaml",
    ] {
        if root.join(existing).exists() {
            return Err(ApiError::BadRequest(format!(
                "{existing} already exists in this folder — pick it in Compose mode instead \
                 of generating a new one."
            )));
        }
    }
    let service = scaffold_service_name(image);
    // Built line-by-line: YAML is indentation-sensitive, and a multi-line
    // Rust string literal would smuggle the source code's own indentation
    // into the file.
    let content = [
        format!("# Generated by Fleetify: the agent runs in `dev`; `{service}` runs beside it."),
        format!("# The agent reaches it over the compose network, e.g. http://{service}:<port>."),
        "# Edit freely — Fleetify only ever starts this stack, it never tears it down.".to_string(),
        "services:".to_string(),
        "  dev:".to_string(),
        "    image: node:22".to_string(),
        "    command: sleep infinity".to_string(),
        "    working_dir: /workspace".to_string(),
        "    volumes:".to_string(),
        "      - .:/workspace".to_string(),
        format!("  {service}:"),
        format!("    image: {image}"),
        "    # TODO: add the service's own command/ports/volumes here, e.g.".to_string(),
        "    # command: \"--data-dir /data --api-key=xyz\"".to_string(),
        "    # ports: [\"8108:8108\"]".to_string(),
        String::new(),
    ]
    .join("\n");
    let path = root.join("docker-compose.yml");
    std::fs::write(&path, content)
        .map_err(|e| ApiError::BadRequest(format!("couldn't write {}: {e}", path.display())))?;
    Ok(Json(json!({
        "ok": true,
        "file": "docker-compose.yml",
        "agent_service": "dev",
        "service": service,
    })))
}

#[derive(Deserialize)]
struct ProbeReq {
    container_id: String,
    #[serde(default = "default_agent")]
    agent: String,
}
fn default_agent() -> String {
    "claude".into()
}

fn agent_name_ok(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
}

/// `command` is a POSIX shell builtin and `docker exec` does not start a
/// shell, so the probe has to go through `sh -c`. A bare
/// `docker exec <id> command -v claude` fails with "executable file not
/// found" regardless of whether the CLI is installed.
fn probe_script(agent: &str) -> String {
    format!("command -v {}", sh_quote(agent))
}

/// Run the agent-presence probe inside a container. Exposed to the
/// bridges so the spawn path can re-check just before a turn — the
/// picker's answer goes stale the moment the container is stopped or
/// replaced. The argv shape stays owned by this module.
pub(crate) async fn probe_agent_in_container(container_id: &str, agent: &str) -> bool {
    if !container_id_re().is_match(container_id) || !agent_name_ok(agent) {
        return false;
    }
    if docker_path().is_none() {
        return false;
    }
    let script = probe_script(agent);
    let (rc, _out, _err) = run_docker(&["exec", container_id, "sh", "-c", &script], 8).await;
    rc == 0
}

/// Is the agent CLI actually installed inside this container? Answers the
/// picker so the user finds out at selection time rather than one failed
/// turn later.
async fn probe_agent(Json(req): Json<ProbeReq>) -> Result<Json<Value>, ApiError> {
    if req.container_id.is_empty()
        || req.container_id.len() > 128
        || !container_id_re().is_match(&req.container_id)
    {
        return Err(ApiError::BadRequest("invalid container_id".into()));
    }
    if !agent_name_ok(&req.agent) {
        return Err(ApiError::BadRequest("invalid agent name".into()));
    }
    if docker_path().is_none() {
        return Err(ApiError::BadRequest("Docker is not installed.".into()));
    }
    let script = probe_script(&req.agent);
    let (rc, out, _err) = run_docker(&["exec", &req.container_id, "sh", "-c", &script], 8).await;
    Ok(Json(json!({
        "present": rc == 0,
        "path": out.trim(),
    })))
}

fn sh_quote(value: &str) -> String {
    if value.is_empty() {
        return "''".into();
    }
    let escaped = value.replace('\'', r"'\''");
    format!("'{escaped}'")
}

fn last_line(text: &str) -> Option<String> {
    text.trim()
        .lines()
        .rev()
        .find(|l| !l.trim().is_empty())
        .map(|l| l.trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn container_id_charset_rejects_shell_chars_and_leading_dash() {
        assert!(container_id_re().is_match("abc123"));
        assert!(container_id_re().is_match("name_with-stuff.1"));
        assert!(!container_id_re().is_match("-malicious-flag"));
        assert!(!container_id_re().is_match(";rm -rf /"));
        assert!(!container_id_re().is_match(""));
    }

    #[test]
    fn sh_quote_escapes_single_quotes_and_handles_empty() {
        assert_eq!(sh_quote(""), "''");
        assert_eq!(sh_quote("abc"), "'abc'");
        assert_eq!(sh_quote("/path/with spaces"), "'/path/with spaces'");
        assert_eq!(sh_quote("it's"), r"'it'\''s'");
    }

    #[test]
    fn agent_name_charset_rejects_shell_metacharacters() {
        // The name is interpolated into `sh -c`, so it is quoted — the
        // charset is the belt to that suspenders.
        assert!(agent_name_ok("claude"));
        assert!(agent_name_ok("cursor-agent"));
        assert!(!agent_name_ok("claude; rm -rf /"));
        assert!(!agent_name_ok("$(whoami)"));
        assert!(!agent_name_ok(""));
    }

    /// `command` is a shell builtin, so the probe needs a shell. A bare
    /// `docker exec <id> command -v claude` fails with "executable file
    /// not found" whether or not the CLI is installed — a probe that
    /// always reports missing.
    #[test]
    fn probe_script_quotes_the_agent_name() {
        assert_eq!(probe_script("claude"), "command -v 'claude'");
    }

    /// A probe answering "absent" is a data point, not a failure — it must
    /// not warn. A command that actually broke says why on stderr and must.
    #[test]
    fn probe_misses_are_not_failures() {
        assert!(is_expected_miss(127, ""));
        assert!(is_expected_miss(
            1, "  
"
        ));
        // Same codes WITH a reason are real failures.
        assert!(!is_expected_miss(127, "sh: 1: npm: not found"));
        // Other codes are failures regardless.
        assert!(!is_expected_miss(125, ""));
        assert!(!is_expected_miss(-1, ""));
    }

    /// Secrets must never reach the terminal. `-e KEY=VALUE` pairs are the
    /// one place the docker argv carries them.
    #[test]
    fn env_values_are_masked_in_logged_argv() {
        let logged = sanitize_docker_argv(&[
            "exec",
            "-i",
            "-e",
            "XAI_API_KEY=xai-supersecret",
            "-e",
            "OPENAI_BASE_URL=http://host.docker.internal:4000",
            "abc123",
            "grok",
        ]);
        assert!(!logged.contains("supersecret"), "{logged}");
        assert!(logged.contains("XAI_API_KEY=***"), "{logged}");
        assert!(logged.contains("OPENAI_BASE_URL=***"), "{logged}");
        // Everything that is not an env value stays legible.
        assert!(logged.starts_with("docker exec -i"), "{logged}");
        assert!(logged.ends_with("abc123 grok"), "{logged}");
    }

    /// Only the argument AFTER -e is a secret; a later positional that
    /// happens to contain '=' (sh -c scripts do) must stay readable.
    #[test]
    fn non_env_arguments_keep_their_equals_signs() {
        let logged = sanitize_docker_argv(&["exec", "c1", "sh", "-c", "export FOO=bar; echo done"]);
        assert!(logged.contains("FOO=bar"), "{logged}");
    }

    /// The generated service name must be compose-legal and never collide
    /// with the agent's own `dev` service.
    #[test]
    fn scaffold_service_names_are_compose_legal() {
        assert_eq!(
            scaffold_service_name("typesense/typesense:30.2"),
            "typesense"
        );
        assert_eq!(scaffold_service_name("postgres"), "postgres");
        assert_eq!(scaffold_service_name("ghcr.io/acme/My_App:1.0"), "my-app");
        assert_eq!(scaffold_service_name("dev:1"), "service");
        assert_eq!(scaffold_service_name(":::"), "service");
    }

    #[test]
    fn last_line_drops_blank_trailing_lines() {
        assert_eq!(last_line("a\nb\n\n").as_deref(), Some("b"));
        assert!(last_line("\n\n").is_none());
        assert!(last_line("").is_none());
    }
}
