//! Headless e2e for the single-origin contract: the embedded backend serves
//! the REAL built React bundle AND `/healthz` on one origin (what the Tauri
//! webview loads in release). Ignored by default (needs `npm run build`);
//! run explicitly: `cargo test -p fleet-backend --test serves_real_dist -- --ignored`.

use std::net::SocketAddr;
use std::path::PathBuf;

#[tokio::test]
#[ignore = "requires dist/ from `npm run build`; run with --ignored"]
async fn serves_real_react_bundle_and_healthz_same_origin() {
    std::env::set_var("FLEET_DB_URL", "sqlite::memory:");
    let dist = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../dist");
    assert!(
        dist.join("index.html").exists(),
        "dist/ not built at {dist:?} — run `npm run build` first"
    );

    let addr: SocketAddr = "127.0.0.1:0".parse().unwrap();
    let h = fleet_backend::serve(addr, Some(dist)).await.unwrap();
    let base = format!("http://{}", h.local_addr());

    // /healthz coexists with static serving.
    let hz = reqwest::get(format!("{base}/healthz")).await.unwrap();
    assert_eq!(hz.status(), 200);
    assert!(hz.text().await.unwrap().contains("\"status\":\"ok\""));

    // The real SPA index is served at / (single origin → relative /api works).
    let idx = reqwest::get(format!("{base}/")).await.unwrap();
    assert_eq!(idx.status(), 200);
    let html = idx.text().await.unwrap();
    assert!(
        html.contains("Fleetify \u{2014} AI Agent Orchestrator"),
        "served index is not the real React app: {}",
        &html[..html.len().min(160)]
    );
    assert!(
        html.contains("/assets/"),
        "index should reference Vite-built /assets/* bundles"
    );

    h.shutdown();
}
