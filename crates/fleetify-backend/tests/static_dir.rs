use std::net::SocketAddr;

use fleetify_backend::access::ApiToken;
use fleetify_backend::ServeOptions;

#[tokio::test]
async fn serves_index_from_static_dir() {
    std::env::set_var("FLEET_DB_URL", "sqlite::memory:");
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("index.html"), "<!doctype html>FLEET").unwrap();

    let addr: SocketAddr = "127.0.0.1:0".parse().unwrap();
    let h = fleetify_backend::serve(
        addr,
        ServeOptions {
            static_dir: Some(dir.path().to_path_buf()),
            ..ServeOptions::api_only(ApiToken::generate())
        },
    )
    .await
    .unwrap();

    let body = reqwest::get(format!("http://{}/", h.local_addr()))
        .await
        .unwrap()
        .text()
        .await
        .unwrap();

    assert!(body.contains("FLEET"), "got: {body}");
    h.shutdown();
}
