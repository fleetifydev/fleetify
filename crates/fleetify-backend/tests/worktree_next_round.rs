//! Integration: `POST /api/sessions/{id}/worktree/next-round`. Mirrors the
//! `tests/spawn_endpoint.rs` harness (real `serve()` over loopback, NOAUTH,
//! shared in-memory `FLEET_DB_URL`). Creates a `use_worktree=true` session in
//! a fresh temp git repo so `attach_git_setup` carves round 1, then advances
//! it and asserts the create-before-remove semantics: the session is repointed
//! to the new `-r2` worktree/branch, the new dir exists, the OLD worktree dir
//! is gone, and the response reports the removed (old) branch.

use std::net::SocketAddr;
use std::process::Command;

fn enable_noauth() {
    std::env::set_var("FLEETIFY_NOAUTH", "1");
    std::env::set_var("FLEETIFY_ISSUER", "http://127.0.0.1:1");
    std::env::set_var("FLEETIFY_AUDIENCE", "http://127.0.0.1:8765");
    std::env::set_var("FLEET_DB_URL", "sqlite::memory:");
}

fn git_available() -> bool {
    Command::new("git")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Force-init a clean, isolated repo INSIDE `path` (Windows tempdirs can land
/// under an ancestor repo; a nested `.git` shadows it for queries inside).
fn clean_repo(path: &str) {
    let run = |args: &[&str]| {
        let _ = Command::new("git").args(args).current_dir(path).output();
    };
    run(&["init", "-b", "main"]);
    run(&["config", "user.email", "t@x"]);
    run(&["config", "user.name", "T"]);
    run(&["commit", "-m", "init", "--allow-empty"]);
}

#[tokio::test]
async fn next_round_advances_worktree_and_branch() {
    if !git_available() {
        eprintln!("git not available — skipping next_round_advances_worktree_and_branch");
        return;
    }
    enable_noauth();

    // Real temp git repo so attach_git_setup carves an actual round-1 worktree.
    let tmp = tempfile::tempdir().expect("tempdir");
    let project = tmp.path().to_string_lossy().to_string();
    clean_repo(&project);

    let addr: SocketAddr = "127.0.0.1:0".parse().unwrap();
    let handle = fleetify_backend::serve(addr, None).await.expect("serve");
    let base = format!("http://{}", handle.local_addr());
    let client = reqwest::Client::new();

    // 1. Create a worktree-on session. The create path eagerly carves round 1
    //    via session_manager::attach_git_setup → worktree::ensure_worktree.
    let s: serde_json::Value = client
        .post(format!("{base}/api/sessions"))
        .json(&serde_json::json!({
            "title": "Auth Fix",
            "project_path": project,
            "tool": "claude-code",
            "use_worktree": true
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();

    let id = s["id"].as_str().expect("session id").to_string();
    assert_eq!(s["use_worktree"], true, "session must be worktree-on");
    let old_path = s["worktree_path"]
        .as_str()
        .expect("round-1 worktree_path present")
        .to_string();
    let old_branch = s["worktree_branch"]
        .as_str()
        .expect("round-1 worktree_branch present")
        .to_string();
    assert!(
        std::path::Path::new(&old_path).is_dir(),
        "round-1 worktree dir should exist before advancing: {old_path}"
    );
    // Round-1 branch carries no `-rN` suffix.
    assert!(
        old_branch.starts_with("fleet/Auth-Fix-") && !old_branch.contains("-r2"),
        "round-1 branch shape unexpected: {old_branch}"
    );

    // 2. Advance to the next round. Empty body → base resolved server-side.
    let res = client
        .post(format!("{base}/api/sessions/{id}/worktree/next-round"))
        .json(&serde_json::json!({}))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status().as_u16(), 200, "next-round must 200");
    let body: serde_json::Value = res.json().await.unwrap();
    assert_eq!(body["ok"], true, "body.ok must be true");
    assert_eq!(
        body["removedBranch"], old_branch,
        "removedBranch must be the old (round-1) branch"
    );

    // 3. Re-fetch the session and assert it now points at round 2.
    let after: serde_json::Value = client
        .get(format!("{base}/api/sessions/{id}"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let new_branch = after["worktree_branch"].as_str().expect("new branch");
    let new_path = after["worktree_path"].as_str().expect("new path");
    assert!(
        new_branch.ends_with("-r2"),
        "new branch must end with -r2: {new_branch}"
    );
    assert!(
        new_path.ends_with(&format!("{id}-r2")),
        "new path must end with <id>-r2: {new_path}"
    );
    // The body's embedded session must agree with the re-fetched row.
    assert_eq!(body["session"]["worktree_branch"], after["worktree_branch"]);
    assert_eq!(body["session"]["worktree_path"], after["worktree_path"]);

    // 4. Create-before-remove: new dir exists, old dir is gone.
    assert!(
        std::path::Path::new(new_path).is_dir(),
        "new round-2 worktree dir must exist: {new_path}"
    );
    assert!(
        !std::path::Path::new(&old_path).exists(),
        "old round-1 worktree dir must be removed: {old_path}"
    );

    handle.shutdown();
}
