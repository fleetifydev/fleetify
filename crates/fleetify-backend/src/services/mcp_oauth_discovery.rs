//! MCP OAuth auto-discovery (RFC 9728 + RFC 8414) and dynamic client
//! registration (RFC 7591) for remote MCP servers that ship no manual
//! `oauth` block. Given the 401 `WWW-Authenticate` challenge (or just the
//! server URL), resolve the authorize/token endpoints and register a public
//! PKCE client so the existing PKCE flow can run.

use std::time::Duration;

use anyhow::{anyhow, Result};
use serde_json::Value;

const HTTP_TIMEOUT: Duration = Duration::from_secs(15);

/// Resolved OAuth config for a server, ready to persist into its registry
/// `oauth` block and drive the PKCE flow.
#[derive(Debug, Clone)]
pub struct DiscoveredOauth {
    pub authorize_url: String,
    pub token_url: String,
    pub client_id: String,
    pub scopes: Option<String>,
    pub resource: String,
}

/// Run discovery + DCR. `server_url` is the MCP server URL; `www_authenticate`
/// is the raw 401 challenge (may carry `resource_metadata="..."`);
/// `redirect_uri` is the loopback callback we register.
pub async fn discover(
    server_url: &str,
    www_authenticate: Option<&str>,
    redirect_uri: &str,
) -> Result<DiscoveredOauth> {
    let client = reqwest::Client::new();

    // 1. Protected Resource Metadata (RFC 9728).
    let prm_url = www_authenticate
        .and_then(resource_metadata_from_challenge)
        .or_else(|| default_prm_url(server_url))
        .ok_or_else(|| anyhow!("could not determine protected-resource-metadata URL"))?;
    let prm = get_json(&client, &prm_url)
        .await
        .map_err(|e| anyhow!("protected-resource-metadata ({prm_url}): {e}"))?;
    let resource = prm
        .get("resource")
        .and_then(|v| v.as_str())
        .unwrap_or(server_url)
        .to_string();
    let as_url = prm
        .get("authorization_servers")
        .and_then(|v| v.as_array())
        .and_then(|a| a.first())
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow!("no authorization_servers in protected-resource-metadata"))?
        .to_string();

    // 2. Authorization Server Metadata (RFC 8414).
    let asm = fetch_as_metadata(&client, &as_url).await?;
    let authorize_url = asm
        .get("authorization_endpoint")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow!("AS metadata missing authorization_endpoint"))?
        .to_string();
    let token_url = asm
        .get("token_endpoint")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow!("AS metadata missing token_endpoint"))?
        .to_string();
    let scopes = prm
        .get("scopes_supported")
        .or_else(|| asm.get("scopes_supported"))
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|s| s.as_str())
                .collect::<Vec<_>>()
                .join(" ")
        })
        .filter(|s| !s.is_empty());

    // 3. Dynamic Client Registration (RFC 7591).
    let client_id = match asm.get("registration_endpoint").and_then(|v| v.as_str()) {
        Some(reg) => register_client(&client, reg, redirect_uri).await?,
        None => {
            return Err(anyhow!(
                "authorization server has no registration_endpoint (a manual client_id is required)"
            ))
        }
    };

    Ok(DiscoveredOauth {
        authorize_url,
        token_url,
        client_id,
        scopes,
        resource,
    })
}

async fn get_json(client: &reqwest::Client, url: &str) -> Result<Value> {
    let resp = client.get(url).timeout(HTTP_TIMEOUT).send().await?;
    if !resp.status().is_success() {
        return Err(anyhow!("HTTP {}", resp.status().as_u16()));
    }
    Ok(resp.json().await?)
}

/// RFC 8414: try `/.well-known/oauth-authorization-server`, then fall back to
/// `/.well-known/openid-configuration`.
async fn fetch_as_metadata(client: &reqwest::Client, as_url: &str) -> Result<Value> {
    let base = as_url.trim_end_matches('/');
    for wk in [
        "/.well-known/oauth-authorization-server",
        "/.well-known/openid-configuration",
    ] {
        if let Ok(v) = get_json(client, &format!("{base}{wk}")).await {
            return Ok(v);
        }
    }
    Err(anyhow!(
        "could not fetch authorization-server metadata from {as_url}"
    ))
}

/// RFC 7591 dynamic client registration as a public client (PKCE, no secret).
async fn register_client(
    client: &reqwest::Client,
    registration_endpoint: &str,
    redirect_uri: &str,
) -> Result<String> {
    let body = serde_json::json!({
        "client_name": "Fleetify",
        "redirect_uris": [redirect_uri],
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "token_endpoint_auth_method": "none",
    });
    let resp = client
        .post(registration_endpoint)
        .json(&body)
        .timeout(HTTP_TIMEOUT)
        .send()
        .await
        .map_err(|e| anyhow!("client registration request failed: {e}"))?;
    if !resp.status().is_success() {
        let code = resp.status().as_u16();
        let txt = resp.text().await.unwrap_or_default();
        return Err(anyhow!("client registration returned {code}: {txt}"));
    }
    let v: Value = resp
        .json()
        .await
        .map_err(|e| anyhow!("registration decode: {e}"))?;
    v.get("client_id")
        .and_then(|c| c.as_str())
        .map(String::from)
        .ok_or_else(|| anyhow!("registration response missing client_id"))
}

/// Parse `resource_metadata="<url>"` out of a `WWW-Authenticate` header.
pub(crate) fn resource_metadata_from_challenge(www_authenticate: &str) -> Option<String> {
    let needle = "resource_metadata=";
    let start = www_authenticate.find(needle)? + needle.len();
    let rest = www_authenticate[start..].trim_start_matches('"');
    let end = rest.find('"').unwrap_or(rest.len());
    let url = rest[..end].to_string();
    if url.is_empty() {
        None
    } else {
        Some(url)
    }
}

/// RFC 9728 default protected-resource-metadata URL for a server URL:
/// `https://host/.well-known/oauth-protected-resource` (+ path suffix).
/// Parses the origin by hand (scheme + host[:port]) to avoid adding a
/// new `url` dependency (reqwest uses it internally but doesn't publicly
/// re-export `Url` in our feature set).
pub(crate) fn default_prm_url(server_url: &str) -> Option<String> {
    let (scheme, after_scheme) = server_url.split_once("://")?;
    // Drop any ?query / #fragment before splitting authority from path — the
    // well-known segment goes between the authority and the path, and neither
    // a query nor a fragment belongs in the metadata URL (RFC 9728 §3.1).
    let after_scheme = after_scheme
        .split(['?', '#'])
        .next()
        .unwrap_or(after_scheme);
    // Everything up to the first '/' is host[:port]; the rest is the path.
    let (host_port, path) = match after_scheme.split_once('/') {
        Some((h, p)) => (h, format!("/{p}")),
        None => (after_scheme, String::new()),
    };
    if host_port.is_empty() {
        return None;
    }
    let origin = format!("{scheme}://{host_port}");
    let path = path.trim_end_matches('/');
    if path.is_empty() {
        Some(format!("{origin}/.well-known/oauth-protected-resource"))
    } else {
        Some(format!(
            "{origin}/.well-known/oauth-protected-resource{path}"
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_resource_metadata_from_challenge() {
        let h = r#"Bearer resource_metadata="https://mcp.x/.well-known/oauth-protected-resource", error="invalid_token""#;
        assert_eq!(
            resource_metadata_from_challenge(h).as_deref(),
            Some("https://mcp.x/.well-known/oauth-protected-resource")
        );
        assert!(resource_metadata_from_challenge("Bearer error=\"invalid_token\"").is_none());
    }

    #[test]
    fn default_prm_url_inserts_well_known_after_host() {
        assert_eq!(
            default_prm_url("https://mcp.neon.tech/mcp").as_deref(),
            Some("https://mcp.neon.tech/.well-known/oauth-protected-resource/mcp")
        );
        assert_eq!(
            default_prm_url("https://mcp.x").as_deref(),
            Some("https://mcp.x/.well-known/oauth-protected-resource")
        );
        // Query / fragment must be stripped (they belong to neither the
        // authority nor the metadata path).
        assert_eq!(
            default_prm_url("https://mcp.x/mcp?foo=bar").as_deref(),
            Some("https://mcp.x/.well-known/oauth-protected-resource/mcp")
        );
        assert_eq!(
            default_prm_url("https://mcp.x:8443?q=1").as_deref(),
            Some("https://mcp.x:8443/.well-known/oauth-protected-resource")
        );
        assert!(default_prm_url("not-a-url").is_none());
    }

    #[tokio::test]
    async fn discover_resolves_endpoints_and_registers_client() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};
        let server = MockServer::start().await;
        let base = server.uri();

        // RFC 9728 protected resource metadata → points back at this server as the AS.
        Mock::given(method("GET"))
            .and(path("/.well-known/oauth-protected-resource/mcp"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "resource": format!("{base}/mcp"),
                "authorization_servers": [base],
                "scopes_supported": ["read", "write"]
            })))
            .mount(&server)
            .await;
        // RFC 8414 AS metadata.
        Mock::given(method("GET"))
            .and(path("/.well-known/oauth-authorization-server"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "authorization_endpoint": format!("{base}/authorize"),
                "token_endpoint": format!("{base}/token"),
                "registration_endpoint": format!("{base}/register")
            })))
            .mount(&server)
            .await;
        // RFC 7591 dynamic client registration.
        Mock::given(method("POST"))
            .and(path("/register"))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
                "client_id": "dyn-client-123"
            })))
            .mount(&server)
            .await;

        let challenge =
            format!("Bearer resource_metadata=\"{base}/.well-known/oauth-protected-resource/mcp\"");
        let d = discover(
            &format!("{base}/mcp"),
            Some(&challenge),
            "http://127.0.0.1:8765/cb",
        )
        .await
        .unwrap();
        assert_eq!(d.client_id, "dyn-client-123");
        assert_eq!(d.authorize_url, format!("{base}/authorize"));
        assert_eq!(d.token_url, format!("{base}/token"));
        assert_eq!(d.resource, format!("{base}/mcp"));
        assert_eq!(d.scopes.as_deref(), Some("read write"));
    }
}
