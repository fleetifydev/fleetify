//! HTTP clients for the services the app runs on this machine: its embedded
//! backend, and in debug builds the Vite dev server.
//!
//! reqwest sends requests through the proxy named in `HTTP_PROXY`,
//! `HTTPS_PROXY` or `ALL_PROXY` (or their lowercase forms), and hyper-util's
//! proxy matcher exempts no loopback address: only `NO_PROXY` does. With a
//! proxy set that isn't running, the startup poll would never reach the
//! backend and the window would stay on "Starting Fleetify…"; with one that
//! is, provider keys and the internal secret would cross it in plaintext.
//!
//! Every client that talks to the app's own backend, in the shell and in the
//! MCP sidecars, starts from [`http_client_builder`]. Clients that reach the
//! internet (providers, the issuer, GitHub) don't: they keep honouring the
//! user's proxy.

/// A reqwest client builder for calls to a service the app runs on this
/// machine. It never uses a proxy, whatever the environment says.
pub fn http_client_builder() -> reqwest::ClientBuilder {
    reqwest::Client::builder().no_proxy()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// Set in the child process the proxy test re-runs itself in.
    const CHILD: &str = "FLEETIFY_LOOPBACK_PROXY_TEST_CHILD";

    /// The test the child process runs, by its full name.
    const CHILD_TEST: &str = "loopback::tests::child_requests_through_the_builder_with_a_proxy_set";

    /// A port on 127.0.0.1 nothing listens on.
    fn closed_port() -> u16 {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.local_addr().unwrap().port()
    }

    #[test]
    fn a_proxy_in_the_environment_is_never_used() {
        // The proxy variables are set only in a child process (this test
        // binary, running the one test below), so no other test sees them.
        let proxy = format!("http://127.0.0.1:{}", closed_port());
        let mut child = Command::new(std::env::current_exe().unwrap());
        child
            .args(["--exact", CHILD_TEST, "--ignored", "--test-threads=1"])
            .env(CHILD, "1");
        for name in [
            "HTTP_PROXY",
            "http_proxy",
            "HTTPS_PROXY",
            "https_proxy",
            "ALL_PROXY",
            "all_proxy",
        ] {
            child.env(name, &proxy);
        }
        // An exemption or a CGI environment would turn the proxy off.
        for name in ["NO_PROXY", "no_proxy", "REQUEST_METHOD"] {
            child.env_remove(name);
        }
        let out = child.output().unwrap();
        let stdout = String::from_utf8_lossy(&out.stdout);
        let stderr = String::from_utf8_lossy(&out.stderr);
        assert!(
            out.status.success(),
            "with HTTP_PROXY={proxy}, a request through the builder failed:\n{stdout}\n{stderr}"
        );
        assert!(
            stdout.contains("1 passed"),
            "the child process didn't run {CHILD_TEST}:\n{stdout}\n{stderr}"
        );
    }

    /// Run by [`a_proxy_in_the_environment_is_never_used`] in a child process
    /// whose proxy variables point at a closed port. Run any other way, it
    /// checks nothing.
    #[test]
    #[ignore = "run by a_proxy_in_the_environment_is_never_used, with a proxy set"]
    fn child_requests_through_the_builder_with_a_proxy_set() {
        if std::env::var_os(CHILD).is_none() {
            return;
        }
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            // The parent picked the proxy's port by binding it and letting it
            // go, so the OS may hand that same port to this server. A second
            // bind made while the first listener still holds it gets another.
            let proxy = std::env::var("HTTP_PROXY").unwrap();
            let proxy_port = reqwest::Url::parse(&proxy).unwrap().port().unwrap();
            let first = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let listener = if first.local_addr().unwrap().port() == proxy_port {
                let second = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
                drop(first);
                second
            } else {
                first
            };
            let url = format!("http://127.0.0.1:{}/", listener.local_addr().unwrap().port());
            tokio::spawn(async move {
                while let Ok((mut socket, _)) = listener.accept().await {
                    let mut request = [0u8; 1024];
                    let _ = socket.read(&mut request).await;
                    let _ = socket
                        .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 8\r\nConnection: close\r\n\r\nloopback")
                        .await;
                }
            });

            // reqwest's default client goes through the proxy, which isn't
            // there: otherwise this test would prove nothing.
            let default = reqwest::Client::builder().build().unwrap();
            assert!(
                default.get(&url).send().await.is_err(),
                "reqwest didn't use the proxy in the environment"
            );

            let client = http_client_builder().build().unwrap();
            let response = client.get(&url).send().await.expect("the request failed");
            assert_eq!(response.text().await.unwrap(), "loopback");
        });
    }
}
