use std::net::SocketAddr;

use fleetify_backend::access::ApiToken;
use fleetify_backend::ServeOptions;

/// `/healthz` answers `{"status":"ok"}` with the version the backend was
/// built as: the workspace version every crate inherits, which each release
/// bumps along with the app's other version files. A literal there would go
/// on saying the old version after the first bump.
#[tokio::test]
async fn healthz_returns_ok_json_with_the_crate_version() {
    std::env::set_var("FLEET_DB_URL", "sqlite::memory:");
    let addr: SocketAddr = "127.0.0.1:0".parse().unwrap();
    let handle = fleetify_backend::serve(addr, ServeOptions::api_only(ApiToken::generate()))
        .await
        .expect("serve");
    let bound = handle.local_addr();

    let body: serde_json::Value = reqwest::get(format!("http://{bound}/healthz"))
        .await
        .unwrap()
        .json()
        .await
        .unwrap();

    assert_eq!(body["status"], "ok", "got: {body}");
    assert_eq!(body["version"], env!("CARGO_PKG_VERSION"), "got: {body}");
    handle.shutdown();
}
