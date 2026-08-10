//! Container-mode session lifecycle over the real `serve()` stack.
//!
//! `crates/fleetify-backend/tests/` had zero container coverage before this
//! file, which is how PR #278 shipped a container mode whose sessions could
//! not be created: `POST /api/sessions` validated `project_path` with
//! `is_dir()`, and `Path::new("docker://abc/work").is_dir()` is always false.
//!
//! Uses the `FLEETIFY_NOAUTH` bypass (same shape as `auth_noauth.rs`) so the
//! tests exercise the router without a JWKS mock. No Docker daemon is
//! required — nothing here spawns an agent, it only asserts what the session
//! router accepts, stores and refuses.

use std::net::SocketAddr;

fn enable_noauth() {
    std::env::set_var("FLEETIFY_NOAUTH", "1");
    // Dead JWKS address: the bypass must never reach out. If it ever does,
    // the request fails fast instead of hanging the suite.
    std::env::set_var("FLEETIFY_ISSUER", "http://127.0.0.1:1");
    std::env::set_var("FLEETIFY_AUDIENCE", "http://127.0.0.1:8765");
    std::env::set_var("FLEET_DB_URL", "sqlite::memory:");
}

/// Boot the real backend and hand back both the base URL and the handle.
/// The handle MUST stay alive for the duration of the test — dropping it
/// shuts the server down, and every request then fails with a connection
/// reset that looks like a router bug but is not one.
async fn boot() -> (String, fleetify_backend::ServerHandle) {
    enable_noauth();
    let addr: SocketAddr = "127.0.0.1:0".parse().unwrap();
    let handle = fleetify_backend::serve(addr, None).await.expect("serve");
    (format!("http://{}", handle.local_addr()), handle)
}

/// `(status, body_text)`. The body is returned as text on purpose:
/// `ApiError::BadRequest` renders a **plain-text** body, not a
/// `{"detail": …}` envelope, and `apiCreateSession` in the renderer reads it
/// with `res.text()` for exactly that reason. Asserting on the text is what
/// the user actually sees.
async fn create_session(base: &str, body: serde_json::Value) -> (u16, String) {
    let resp = reqwest::Client::new()
        .post(format!("{base}/api/sessions"))
        .json(&body)
        .send()
        .await
        .unwrap();
    let status = resp.status().as_u16();
    (status, resp.text().await.unwrap_or_default())
}

fn as_json(body: &str) -> serde_json::Value {
    serde_json::from_str(body).unwrap_or(serde_json::Value::Null)
}

/// The blocker this work exists to remove. Before the target-aware
/// validator this was a hard 400 and the composer's Container flow could
/// never complete.
#[tokio::test]
async fn create_accepts_a_docker_target() {
    let (base, _handle) = boot().await;
    let (status, body) = create_session(
        &base,
        serde_json::json!({
            "title": "in a box",
            "project_path": "docker://abc123/work/repo",
            "tool": "claude-code",
            "use_worktree": false,
        }),
    )
    .await;
    assert_eq!(status, 200, "container create must not 400; body = {body}");
    assert_eq!(as_json(&body)["project_path"], "docker://abc123/work/repo");
}

/// `ssh://` is a valid POSIX path too, so a parser that fell through would
/// run the agent in a nonexistent host directory. The refusal must carry the
/// parser's own reason, not a misleading "not a directory".
#[tokio::test]
async fn create_rejects_an_ssh_target_with_a_readable_reason() {
    let (base, _handle) = boot().await;
    let (status, body) = create_session(
        &base,
        serde_json::json!({
            "title": "nope",
            "project_path": "ssh://me@host:22/srv/app",
            "tool": "claude-code",
            "use_worktree": false,
        }),
    )
    .await;
    assert_eq!(status, 400, "ssh must be refused; body = {body}");
    let detail = body.to_lowercase();
    assert!(detail.contains("ssh"), "detail should name ssh: {detail}");
}

/// A malformed marker must not degrade to a host path — that is the
/// silent-wrong-directory bug `exec_target` exists to prevent.
#[tokio::test]
async fn create_rejects_a_malformed_container_marker() {
    let (base, _handle) = boot().await;
    let (status, body) = create_session(
        &base,
        serde_json::json!({
            "title": "bad id",
            "project_path": "docker://-rm -rf/x",
            "tool": "claude-code",
            "use_worktree": false,
        }),
    )
    .await;
    assert_eq!(status, 400, "malformed id must be refused; body = {body}");
    assert!(
        body.contains("container id"),
        "detail should name the container id: {body}"
    );
}

/// Host git cannot carve a worktree from files that live inside a container.
/// `use_worktree: true` must be honoured as "no host git", not attempted.
#[tokio::test]
async fn git_setup_is_skipped_for_a_container_session() {
    let (base, _handle) = boot().await;
    let (status, body) = create_session(
        &base,
        serde_json::json!({
            "title": "boxed",
            "project_path": "docker://abc123/work",
            "tool": "claude-code",
            "use_worktree": true,
        }),
    )
    .await;
    assert_eq!(status, 200, "body = {body}");
    let created = as_json(&body);
    assert!(
        created["worktree_path"]
            .as_str()
            .unwrap_or_default()
            .is_empty(),
        "host git must never carve a worktree for a container path; got {}",
        created["worktree_path"]
    );
    assert!(
        created["worktree_branch"]
            .as_str()
            .unwrap_or_default()
            .is_empty(),
        "no branch name should be recorded for a repo the host cannot see; got {}",
        created["worktree_branch"]
    );
}

/// PATCH used to be the only way to reach the DB with a container path, and
/// it validated nothing at all — so the one endpoint that most needed a
/// guard had none. It now refuses the same targets create does.
#[tokio::test]
async fn patch_validates_the_project_path_it_never_used_to() {
    let (base, _handle) = boot().await;
    let (status, created) = create_session(
        &base,
        serde_json::json!({
            "title": "patch me",
            "project_path": "docker://abc123/work",
            "tool": "claude-code",
            "use_worktree": false,
        }),
    )
    .await;
    assert_eq!(status, 200, "body = {created}");
    let id = as_json(&created)["id"]
        .as_str()
        .expect("session id")
        .to_string();

    let resp = reqwest::Client::new()
        .patch(format!("{base}/api/sessions/{id}"))
        .json(&serde_json::json!({ "project_path": "ssh://me@host/srv" }))
        .send()
        .await
        .unwrap();
    assert_eq!(
        resp.status().as_u16(),
        400,
        "PATCH must refuse an unexecutable target too"
    );

    // And the stored path is untouched by the rejected PATCH.
    let after: serde_json::Value = reqwest::Client::new()
        .get(format!("{base}/api/sessions/{id}"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(after["project_path"], "docker://abc123/work");
}

/// A host path still has to be real, and still comes back canonical — the
/// validator replaced the `is_dir()` guard, it did not remove it.
#[tokio::test]
async fn create_still_rejects_a_missing_host_directory() {
    let (base, _handle) = boot().await;
    let (status, body) = create_session(
        &base,
        serde_json::json!({
            "title": "ghost",
            "project_path": "/definitely/not/a/real/dir/xyzzy",
            "tool": "claude-code",
            "use_worktree": false,
        }),
    )
    .await;
    assert_eq!(status, 400, "body = {body}");
    assert!(
        body.contains("does not exist"),
        "detail should say the directory is missing: {body}"
    );
}

/// Migration 0014 backfills the columns from the URL the pre-0014 composer
/// emitted, so an existing container session keeps working after the upgrade.
#[tokio::test]
async fn a_docker_path_is_derived_into_the_exec_columns() {
    let (base, _handle) = boot().await;
    let (status, body) = create_session(
        &base,
        serde_json::json!({
            "title": "legacy shape",
            "project_path": "docker://abc123/work/repo",
            "tool": "claude-code",
            "use_worktree": false,
        }),
    )
    .await;
    assert_eq!(status, 200, "body = {body}");
    let s = as_json(&body);
    assert_eq!(s["exec_mode"], "docker-attach");
    assert_eq!(s["container_id"], "abc123");
    assert_eq!(s["container_workdir"], "/work/repo");
}

/// The orthogonality this stage buys, and the reason Container stopped being
/// a source tab: a session can be a HOST git workspace and still execute
/// inside a container that mounts it.
#[tokio::test]
async fn a_host_repo_session_can_also_run_in_a_container() {
    let (base, _handle) = boot().await;
    let host_dir = std::env::temp_dir().to_string_lossy().to_string();
    let (status, body) = create_session(
        &base,
        serde_json::json!({
            "title": "both at once",
            "project_path": host_dir,
            "tool": "claude-code",
            "use_worktree": false,
            "exec_mode": "docker-run",
            "container_image": "node:22",
        }),
    )
    .await;
    assert_eq!(status, 200, "body = {body}");
    let s = as_json(&body);
    assert_eq!(s["exec_mode"], "docker-run");
    assert_eq!(s["container_image"], "node:22");
    // project_path stays the HOST path — that is what host git acts on and
    // what the container bind-mounts.
    assert!(
        !s["project_path"]
            .as_str()
            .unwrap_or_default()
            .starts_with("docker://"),
        "docker-run keeps a host project_path; got {}",
        s["project_path"]
    );
}

/// Tier B is opt-in. A container session must not carry a host login across
/// the boundary unless the user asked for it.
#[tokio::test]
async fn credential_mounting_is_off_unless_requested() {
    let (base, _handle) = boot().await;
    let (_, body) = create_session(
        &base,
        serde_json::json!({
            "title": "no creds",
            "project_path": "docker://abc123/work",
            "tool": "claude-code",
            "use_worktree": false,
        }),
    )
    .await;
    assert_eq!(as_json(&body)["container_mount_credentials"], false);

    let (_, opted) = create_session(
        &base,
        serde_json::json!({
            "title": "with creds",
            "project_path": "docker://abc123/work",
            "tool": "claude-code",
            "use_worktree": false,
            "container_mount_credentials": true,
        }),
    )
    .await;
    assert_eq!(as_json(&opted)["container_mount_credentials"], true);
}

/// A host session must never touch Docker. `ensure_ready` is called on every
/// turn, so an early-out that missed would put a daemon round trip on the hot
/// path of every local message.
#[tokio::test]
async fn ensure_ready_is_a_no_op_for_a_host_session() {
    let (base, _handle) = boot().await;
    let host_dir = std::env::temp_dir().to_string_lossy().to_string();
    let (status, body) = create_session(
        &base,
        serde_json::json!({
            "title": "local", "project_path": host_dir, "tool": "claude-code",
            "use_worktree": false,
        }),
    )
    .await;
    assert_eq!(status, 200, "body = {body}");
    assert_eq!(as_json(&body)["exec_mode"], "host");
    assert!(as_json(&body)["container_id"].is_null());
}

/// A `docker-run` session is created WITHOUT a container: provisioning waits
/// for the first turn, so picking an image never starts something the user
/// may abandon, and a draft has no row to attach one to yet.
#[tokio::test]
async fn a_run_session_is_created_without_a_container_yet() {
    let (base, _handle) = boot().await;
    let host_dir = std::env::temp_dir().to_string_lossy().to_string();
    let (status, body) = create_session(
        &base,
        serde_json::json!({
            "title": "deferred", "project_path": host_dir, "tool": "claude-code",
            "use_worktree": false, "exec_mode": "docker-run", "container_image": "node:22",
        }),
    )
    .await;
    assert_eq!(status, 200, "body = {body}");
    let s = as_json(&body);
    assert_eq!(s["exec_mode"], "docker-run");
    assert_eq!(s["container_image"], "node:22");
    assert!(
        s["container_id"].is_null(),
        "the container is provisioned on the first turn, not at create; got {}",
        s["container_id"]
    );
}
