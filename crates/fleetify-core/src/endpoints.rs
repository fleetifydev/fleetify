//! Auth endpoints shared by the desktop shell and the embedded backend.
//!
//! The shell's OAuth client and the backend's token validator must agree:
//! the shell asks the identity provider for an access token whose `aud` is
//! the API resource it names, and the backend accepts only tokens whose
//! `iss` is `{issuer}/api/auth` and whose `aud` is that same resource.
//! Both sides resolve the values here so they cannot drift apart.
//!
//! Release builds pin production `fleetify.dev` and ignore the environment,
//! so a variable left in a user's shell can neither break sign-in nor point
//! the app at another identity provider. Debug builds read the environment
//! (`npm run dev:tauri` sets it) so development can use a local IdP.

/// Production identity-provider origin. better-auth serves under
/// `{origin}/api/auth` and stamps that base into every token's `iss`.
pub const PROD_ISSUER: &str = "https://fleetify.dev";

/// Production API resource indicator (RFC 8707): the `aud` of every access
/// token the shell requests and the embedded backend accepts.
pub const PROD_API_RESOURCE: &str = "https://fleetify.dev/api";

/// Debug default issuer: a local identity provider.
const DEV_ISSUER: &str = "http://localhost:3001";

/// Debug default resource: the embedded backend's loopback origin.
const DEV_API_RESOURCE: &str = "http://127.0.0.1:8765";

/// Identity-provider origin, without the `/api/auth` suffix. Release builds
/// return [`PROD_ISSUER`]; debug builds read `FLEETIFY_ISSUER` through `env`
/// and fall back to a local IdP.
pub fn issuer_origin_for(release: bool, env: &dyn Fn(&str) -> Option<String>) -> String {
    if release {
        return PROD_ISSUER.to_string();
    }
    env("FLEETIFY_ISSUER").unwrap_or_else(|| DEV_ISSUER.to_string())
}

/// API resource indicator, which is also the expected token audience.
/// Release builds return [`PROD_API_RESOURCE`]; debug builds read
/// `FLEETIFY_RESOURCE`, then `FLEETIFY_AUDIENCE`, through `env` and fall
/// back to the embedded backend's loopback origin.
pub fn api_resource_for(release: bool, env: &dyn Fn(&str) -> Option<String>) -> String {
    if release {
        return PROD_API_RESOURCE.to_string();
    }
    env("FLEETIFY_RESOURCE")
        .or_else(|| env("FLEETIFY_AUDIENCE"))
        .unwrap_or_else(|| DEV_API_RESOURCE.to_string())
}

/// [`issuer_origin_for`] for this build profile and the process environment.
pub fn issuer_origin() -> String {
    issuer_origin_for(!cfg!(debug_assertions), &|k| std::env::var(k).ok())
}

/// [`api_resource_for`] for this build profile and the process environment.
pub fn api_resource() -> String {
    api_resource_for(!cfg!(debug_assertions), &|k| std::env::var(k).ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn release_pins_prod_issuer_even_when_env_is_set() {
        let env = |k: &str| (k == "FLEETIFY_ISSUER").then(|| "http://evil.test".to_string());
        assert_eq!(issuer_origin_for(true, &env), "https://fleetify.dev");
    }

    #[test]
    fn debug_issuer_defaults_to_local_idp_and_honours_env() {
        assert_eq!(issuer_origin_for(false, &|_| None), "http://localhost:3001");
        assert_eq!(
            issuer_origin_for(false, &|_| Some("http://idp.test".into())),
            "http://idp.test"
        );
    }

    #[test]
    fn release_pins_prod_resource() {
        assert_eq!(
            api_resource_for(true, &|_| Some("http://evil.test".into())),
            "https://fleetify.dev/api"
        );
    }

    #[test]
    fn debug_resource_prefers_resource_then_audience_then_default() {
        let both = |k: &str| match k {
            "FLEETIFY_RESOURCE" => Some("a".into()),
            "FLEETIFY_AUDIENCE" => Some("b".into()),
            _ => None,
        };
        let aud = |k: &str| (k == "FLEETIFY_AUDIENCE").then(|| "b".to_string());
        assert_eq!(api_resource_for(false, &both), "a");
        assert_eq!(api_resource_for(false, &aud), "b");
        assert_eq!(api_resource_for(false, &|_| None), "http://127.0.0.1:8765");
    }
}
