//! Integration: `POST /api/sessions/spawn` (the form's Create) and
//! `POST /api/internal/spawn` (the `spawn_agent` MCP loopback). Uses
//! `FLEETIFY_NOAUTH=1` so the user-facing endpoint needs no bearer; the
//! internal endpoint is gated by the loopback secret (read from env after
//! `serve()` latches it into the process environment).

use std::net::SocketAddr;

fn enable_noauth() {
    std::env::set_var("FLEETIFY_NOAUTH", "1");
    std::env::set_var("FLEETIFY_ISSUER", "http://127.0.0.1:1");
    std::env::set_var("FLEETIFY_AUDIENCE", "http://127.0.0.1:8765");
    std::env::set_var("FLEET_DB_URL", "sqlite::memory:");
    // first_task is required, and a present task normally kicks the agent's
    // first bridge turn (a real CLI subprocess). The seam skips the kick so
    // the test exercises create+seed without burning a real model turn.
    std::env::set_var("FLEETIFY_SPAWN_NO_KICK", "1");
}

#[tokio::test]
async fn spawn_endpoints() {
    enable_noauth();
    let addr: SocketAddr = "127.0.0.1:0".parse().unwrap();
    let handle = fleetify_backend::serve(addr, None).await.expect("serve");
    let base = format!("http://{}", handle.local_addr());
    let client = reqwest::Client::new();
    let tmp = std::env::temp_dir().to_string_lossy().to_string();

    // 1. Happy path: a fully-specified spec (incl. the required first task)
    //    creates a session, with worktree isolation defaulted OFF.
    let res = client
        .post(format!("{base}/api/sessions/spawn"))
        .json(&serde_json::json!({
            "title": "reviewer",
            "project_path": tmp,
            "tool": "claude",
            "permission_mode": "bypassPermissions",
            "first_task": "review the open PR"
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status().as_u16(), 200, "spawn happy path");
    let s: serde_json::Value = res.json().await.unwrap();
    assert_eq!(s["title"], "reviewer");
    assert_eq!(s["permission_mode"], "bypassPermissions");
    assert_ne!(s["title"], "Staff Agent", "spawned agent must not be staff");
    assert_eq!(
        s["use_worktree"], false,
        "worktree must default OFF for spawned agents"
    );

    // 2. Missing project_path → 400.
    let res = client
        .post(format!("{base}/api/sessions/spawn"))
        .json(&serde_json::json!({ "title": "x", "first_task": "do x" }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status().as_u16(), 400, "missing project must 400");

    // 2b. Missing first_task → 200: the user-facing path substitutes the
    //     default kickoff task so the agent is created started, never idle.
    let res = client
        .post(format!("{base}/api/sessions/spawn"))
        .json(&serde_json::json!({
            "title": "no-task-given", "project_path": tmp, "tool": "claude"
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(
        res.status().as_u16(),
        200,
        "missing first_task auto-fills the kickoff"
    );

    // 3. Internal spawn without the loopback secret → 403.
    let res = client
        .post(format!("{base}/api/internal/spawn"))
        .json(&serde_json::json!({ "caller_session_id": "x" }))
        .send()
        .await
        .unwrap();
    assert_eq!(
        res.status().as_u16(),
        403,
        "internal spawn needs the secret"
    );

    // Create a `default`-permission caller for the clamp checks.
    let caller: serde_json::Value = client
        .post(format!("{base}/api/sessions/spawn"))
        .json(&serde_json::json!({
            "title": "worker", "project_path": tmp, "tool": "claude",
            "permission_mode": "default", "first_task": "stand by for clamp checks"
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let caller_id = caller["id"].as_str().unwrap().to_string();
    let secret = std::env::var("FLEETIFY_INTERNAL_SECRET").expect("secret in env after serve()");

    // 4. K3 clamp: a `default` caller cannot spawn a `bypassPermissions`
    //    agent. The task is supplied so the gap check (which runs first)
    //    passes and the clamp is what rejects.
    let res = client
        .post(format!("{base}/api/internal/spawn"))
        .header("X-Fleet-Internal", &secret)
        .json(&serde_json::json!({
            "caller_session_id": caller_id,
            "project_path": tmp,
            "tool": "claude",
            "permission_mode": "bypassPermissions",
            "task": "escalate"
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status().as_u16(), 403, "permission clamp must reject");

    // 5. Within the clamp: a `default` spawn under a `default` caller → 200.
    let res = client
        .post(format!("{base}/api/internal/spawn"))
        .header("X-Fleet-Internal", &secret)
        .json(&serde_json::json!({
            "caller_session_id": caller_id,
            "project_path": tmp,
            "tool": "claude",
            "permission_mode": "default",
            "task": "run the smoke suite"
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status().as_u16(), 200, "in-clamp spawn should succeed");
    let body: serde_json::Value = res.json().await.unwrap();
    assert_eq!(body["ok"], true);
    assert!(body["session_id"].as_str().is_some());

    handle.shutdown();
}
