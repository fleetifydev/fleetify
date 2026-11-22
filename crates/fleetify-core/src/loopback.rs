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
//!
//! WebKitGTK, the webview on Linux, sends its page loads, the app's own
//! included, through the proxy in `http_proxy` or `HTTP_PROXY` too, unless
//! the host is in the no-proxy list. So on Linux the shell adds the loopback
//! hosts to `NO_PROXY` and `no_proxy` with [`no_proxy_with_loopback`] before
//! the first webview starts. The processes the app starts inherit the list.

/// A reqwest client builder for calls to a service the app runs on this
/// machine. It never uses a proxy, whatever the environment says.
pub fn http_client_builder() -> reqwest::ClientBuilder {
    reqwest::Client::builder().no_proxy()
}

/// The hosts the app's own services are reached at, as no-proxy entries.
pub const LOOPBACK_NO_PROXY: [&str; 3] = ["localhost", "127.0.0.1", "::1"];

/// A no-proxy list that keeps the user's entries and adds
/// [`LOOPBACK_NO_PROXY`].
///
/// It holds the entries of `upper` (`NO_PROXY`), then those of `lower`
/// (`no_proxy`), then the loopback hosts, joined with `,`. Entries are
/// trimmed and ASCII-lowercased, and empty or repeated ones are dropped.
/// Lowercase is the form that matches: libproxy compares host names
/// case-sensitively, and a parsed URL's host is lowercase.
///
/// If either list has an entry that is exactly `*`, the result is `*` alone.
/// That already exempts every host, and curl (git too) treats the list as
/// match-all only when the whole value is `*`.
pub fn no_proxy_with_loopback(upper: Option<&str>, lower: Option<&str>) -> String {
    let listed: Vec<&str> = upper
        .into_iter()
        .chain(lower)
        .flat_map(|list| list.split(','))
        .map(str::trim)
        .collect();
    if listed.contains(&"*") {
        return "*".to_owned();
    }
    let mut entries: Vec<String> = Vec::new();
    for entry in listed.into_iter().chain(LOOPBACK_NO_PROXY) {
        let entry = entry.to_ascii_lowercase();
        if !entry.is_empty() && !entries.contains(&entry) {
            entries.push(entry);
        }
    }
    entries.join(",")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::process::command;

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
        let mut child = command(std::env::current_exe().unwrap());
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

    #[test]
    fn no_proxy_without_a_list_is_the_loopback_hosts() {
        assert_eq!(
            no_proxy_with_loopback(None, None),
            "localhost,127.0.0.1,::1"
        );
    }

    #[test]
    fn no_proxy_keeps_the_users_entries_first() {
        assert_eq!(
            no_proxy_with_loopback(Some("corp.example"), None),
            "corp.example,localhost,127.0.0.1,::1"
        );
    }

    #[test]
    fn no_proxy_takes_the_upper_case_list_then_the_lower_case_one() {
        assert_eq!(
            no_proxy_with_loopback(Some("a"), Some("b")),
            "a,b,localhost,127.0.0.1,::1"
        );
    }

    #[test]
    fn no_proxy_trims_entries_and_drops_empty_and_repeated_ones() {
        assert_eq!(
            no_proxy_with_loopback(Some(" localhost , 127.0.0.1,,x "), None),
            "localhost,127.0.0.1,x,::1"
        );
    }

    #[test]
    fn no_proxy_with_a_wildcard_is_the_wildcard_alone() {
        assert_eq!(no_proxy_with_loopback(Some("*"), None), "*");
    }

    #[test]
    fn no_proxy_with_a_wildcard_among_other_entries_is_the_wildcard_alone() {
        assert_eq!(no_proxy_with_loopback(Some("a, * ,b"), Some("c")), "*");
        assert_eq!(no_proxy_with_loopback(Some("a"), Some(" * ")), "*");
    }

    #[test]
    fn no_proxy_treats_a_wildcard_inside_an_entry_as_an_ordinary_entry() {
        assert_eq!(
            no_proxy_with_loopback(Some("*.corp.example"), None),
            "*.corp.example,localhost,127.0.0.1,::1"
        );
    }

    #[test]
    fn no_proxy_lowercases_entries_so_a_repeat_in_another_case_is_dropped() {
        assert_eq!(
            no_proxy_with_loopback(Some("LOCALHOST"), None),
            "localhost,127.0.0.1,::1"
        );
        assert_eq!(
            no_proxy_with_loopback(Some("Corp.Example,LOCALHOST"), Some("corp.example,::1")),
            "corp.example,localhost,::1,127.0.0.1"
        );
    }

    #[test]
    fn no_proxy_is_unchanged_when_both_variables_already_hold_it() {
        let set = "corp.example,localhost,127.0.0.1,::1";
        assert_eq!(no_proxy_with_loopback(Some(set), Some(set)), set);
    }
}
