//! Waiting for the embedded backend at startup, before the warm-up talks
//! to it.
//!
//! The wait used to poll `/health`, which the backend never served, so
//! every launch sat out the whole timeout before the warm-up ran. It now
//! polls the backend's own health route, `fleetify_backend::HEALTH_PATH`,
//! and counts the backend up when that answers `{"status":"ok"}`. The
//! timeout stays as the fallback: the warm-up then runs anyway.

use std::time::Duration;

/// How long one poll may take. The backend answers its health route at
/// once; this only bounds a port that accepts and never answers.
const POLL_TIMEOUT: Duration = Duration::from_millis(500);

/// The backend's health URL on `port`.
pub fn health_url(port: &str) -> String {
    format!("http://127.0.0.1:{port}{}", fleetify_backend::HEALTH_PATH)
}

/// Polls `url` up to `attempts` times, `interval` apart, until the backend
/// answers. True once it did; false when the time ran out.
pub async fn wait_for_backend(url: &str, attempts: u32, interval: Duration) -> bool {
    let client = reqwest::Client::builder()
        .timeout(POLL_TIMEOUT)
        .build()
        .unwrap_or_default();
    for _ in 0..attempts {
        if answers_ok(&client, url).await {
            return true;
        }
        tokio::time::sleep(interval).await;
    }
    false
}

/// True when `url` answers 2xx with the backend's `{"status":"ok"}`: a
/// 200 from something else on the port doesn't count.
async fn answers_ok(client: &reqwest::Client, url: &str) -> bool {
    let Ok(response) = client.get(url).send().await else {
        return false;
    };
    if !response.status().is_success() {
        return false;
    }
    response
        .json::<serde_json::Value>()
        .await
        .is_ok_and(|body| body["status"] == "ok")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// How a stub server answers each request.
    #[derive(Clone, Copy)]
    enum Stub {
        /// As the backend does: `{"status":"ok",…}` on its health route,
        /// 404 elsewhere.
        Backend,
        /// 200 with a web page on every path: something else on the port.
        WebPage,
        /// Accepts the connection and never answers.
        Silent,
    }

    /// A local HTTP server answering like `stub`. Returns its port and a
    /// count of the requests it got.
    async fn serve(stub: Stub) -> (u16, Arc<AtomicUsize>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let requests = Arc::new(AtomicUsize::new(0));
        let count = Arc::clone(&requests);
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    return;
                };
                let count = Arc::clone(&count);
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 4096];
                    let n = socket.read(&mut buf).await.unwrap_or(0);
                    count.fetch_add(1, Ordering::SeqCst);
                    let request = String::from_utf8_lossy(&buf[..n]).into_owned();
                    let path = request.split_whitespace().nth(1).unwrap_or("").to_string();
                    let (status, body) = match stub {
                        Stub::Silent => {
                            tokio::time::sleep(Duration::from_secs(30)).await;
                            return;
                        }
                        Stub::Backend if path == "/healthz" => {
                            ("200 OK", r#"{"status":"ok","version":"0.1.0"}"#)
                        }
                        Stub::Backend => ("404 Not Found", ""),
                        Stub::WebPage => ("200 OK", "<!doctype html><title>other</title>"),
                    };
                    let response = format!(
                        "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = socket.write_all(response.as_bytes()).await;
                });
            }
        });
        (port, requests)
    }

    #[test]
    fn polls_the_route_the_backend_serves() {
        assert_eq!(health_url("8765"), "http://127.0.0.1:8765/healthz");
        assert!(health_url("8765").ends_with(fleetify_backend::HEALTH_PATH));
    }

    #[tokio::test]
    async fn returns_as_soon_as_the_backend_answers() {
        let (port, requests) = serve(Stub::Backend).await;
        let started = std::time::Instant::now();
        let ready = wait_for_backend(
            &health_url(&port.to_string()),
            5,
            Duration::from_millis(200),
        )
        .await;
        assert!(ready, "the backend answered, so the wait must end ready");
        assert_eq!(requests.load(Ordering::SeqCst), 1, "one poll was enough");
        assert!(
            started.elapsed() < Duration::from_millis(200),
            "{:?}",
            started.elapsed()
        );
    }

    #[tokio::test]
    async fn a_200_from_something_else_is_not_the_backend() {
        let (port, requests) = serve(Stub::WebPage).await;
        let ready =
            wait_for_backend(&health_url(&port.to_string()), 3, Duration::from_millis(10)).await;
        assert!(!ready);
        assert_eq!(requests.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn gives_up_after_its_attempts_when_the_health_route_is_missing() {
        // The old startup polled /health, which the backend never served:
        // every launch waited out the whole timeout. Here the stub serves
        // only /healthz and the wait asks a path it doesn't serve.
        let (port, requests) = serve(Stub::Backend).await;
        let ready = wait_for_backend(
            &format!("http://127.0.0.1:{port}/health"),
            3,
            Duration::from_millis(10),
        )
        .await;
        assert!(!ready);
        assert_eq!(requests.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn a_backend_that_never_answers_is_given_up_on() {
        let (port, _) = serve(Stub::Silent).await;
        let url = health_url(&port.to_string());
        let wait = wait_for_backend(&url, 2, Duration::from_millis(10));
        let ready = tokio::time::timeout(Duration::from_secs(5), wait)
            .await
            .expect("each poll must time out on its own");
        assert!(!ready);
    }
}
