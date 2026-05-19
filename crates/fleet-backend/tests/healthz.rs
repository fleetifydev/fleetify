use std::net::SocketAddr;

#[tokio::test]
async fn healthz_returns_ok_json() {
    let addr: SocketAddr = "127.0.0.1:0".parse().unwrap();
    let handle = fleet_backend::serve(addr, None).await.expect("serve");
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
