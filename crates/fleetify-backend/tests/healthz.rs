use std::net::SocketAddr;

use fleetify_backend::access::ApiToken;
use fleetify_backend::ServeOptions;

#[tokio::test]
async fn healthz_returns_ok_json() {
    std::env::set_var("FLEET_DB_URL", "sqlite::memory:");
    let addr: SocketAddr = "127.0.0.1:0".parse().unwrap();
    let handle = fleetify_backend::serve(addr, ServeOptions::api_only(ApiToken::generate()))
        .await
        .expect("serve");
    let bound = handle.local_addr();

    let body = reqwest::get(format!("http://{bound}/healthz"))
        .await
        .unwrap()
        .text()
        .await
        .unwrap();

    assert!(body.contains("\"status\":\"ok\""), "got: {body}");
    handle.shutdown();
}
