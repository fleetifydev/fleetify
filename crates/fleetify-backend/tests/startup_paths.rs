//! The backend takes nothing from the folder it is started in. An installed
//! app's working directory is wherever it was launched from, so the config
//! is the one built into the binary and the sessions DB goes under the
//! Fleetify home.
//!
//! This must stay the binary's only test: it changes the process's working
//! directory and environment, which every other test in the same binary
//! would see.

use std::net::SocketAddr;

use fleetify_backend::access::ApiToken;
use fleetify_backend::services::routing::capability_matrix::CapabilityMatrix;
use fleetify_backend::ServeOptions;

/// The repo's config, which the launch folder's copy changes in one line.
const REPO_CONFIG: &str = include_str!("../../../config/default.toml");
const REPO_DB_LINE: &str = r#"path = "fleet.db""#;

/// A capability matrix with only an agent the built-in one doesn't have.
const HOSTILE_AGENTS: &str = r#"
[agents.hostile-agent]
supports_tool_use = true
supports_vision = false
max_context = 1000
mcp_support = false
default_model = "hostile-model"
tiers = ["hostile-model"]
"#;

#[tokio::test]
async fn starts_from_built_in_config_with_db_under_home() -> anyhow::Result<()> {
    // One temp folder holds both: `home/` stands in for the user's home and
    // `launch/` for the folder Fleetify is started in.
    let root = tempfile::Builder::new()
        .prefix("fleetify-startup-paths")
        .tempdir()?;
    let home = root.path().join("home");
    let launch = root.path().join("launch");
    std::fs::create_dir_all(&home)?;
    std::fs::create_dir_all(launch.join("config"))?;

    // The launch folder carries a config of its own: the repo's, with
    // another sessions DB, and a matrix with only an agent of its own.
    assert!(
        REPO_CONFIG.contains(REPO_DB_LINE),
        "config/default.toml no longer has {REPO_DB_LINE}"
    );
    std::fs::write(
        launch.join("config").join("default.toml"),
        REPO_CONFIG.replace(REPO_DB_LINE, r#"path = "hostile.db""#),
    )?;
    std::fs::write(launch.join("config").join("agents.toml"), HOSTILE_AGENTS)?;

    std::env::set_var("HOME", &home);
    std::env::set_var("USERPROFILE", &home);
    for name in ["FLEETIFY_HOME", "FLEET_DB_URL", "FLEETIFY_NOAUTH"] {
        std::env::remove_var(name);
    }
    // Nothing at startup reaches the identity provider or the model catalog,
    // and the Claude background-session poller stays off.
    std::env::set_var("FLEETIFY_ISSUER", "http://127.0.0.1:1");
    std::env::set_var("FLEETIFY_MODELS_API", "http://127.0.0.1:1");
    std::env::set_var("FLEETIFY_CLAUDE_BG_AUTODETECT", "0");
    // Never changed back: a task the backend leaves running could otherwise
    // write into the crate's folder.
    std::env::set_current_dir(&launch)?;

    let matrix = CapabilityMatrix::load_default()?;
    assert!(
        !matrix.agents.contains_key("hostile-agent"),
        "the capability matrix came from the working directory"
    );
    assert!(
        matrix.agents.contains_key("claude-code"),
        "the built-in capability matrix has no claude-code"
    );

    let addr: SocketAddr = "127.0.0.1:0".parse()?;
    let handle =
        fleetify_backend::serve(addr, ServeOptions::api_only(ApiToken::generate())).await?;
    let status = reqwest::Client::builder()
        .no_proxy()
        .build()?
        .get(format!("http://{}/healthz", handle.local_addr()))
        .send()
        .await?
        .status();
    assert_eq!(status, reqwest::StatusCode::OK);

    assert!(
        home.join(".fleetify").join("fleet.db").is_file(),
        "fleet.db is not in the Fleetify home"
    );
    for name in ["hostile.db", "fleet.db"] {
        assert!(
            !launch.join(name).exists(),
            "{name} was created in the working directory"
        );
    }

    handle.shutdown();
    Ok(())
}
