//! Is a CLI agent installed, and is it signed in? One answer for every
//! surface that asks.
//!
//! Settings → Agents, onboarding, the per-account list and Auto routing all
//! read this module, so they can't disagree. Each agent is checked against
//! what the agent itself reads: its own `auth status` command where one
//! exists (Claude Code, Codex), otherwise the credential files, OS keychain
//! items, env vars and Fleetify-stored keys it authenticates with (the
//! catalog's `auth_indicators`). Usage artifacts such as `~/.claude/projects`
//! never count: a single signed-out run creates them.
//!
//! The login commands Fleetify runs on the user's behalf live here too
//! ([`login_spec`]), next to the binary resolution they share with the scan.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use fleetify_core::process::tokio_command;
use serde::Serialize;
use serde_json::Value;

use crate::providers::{AuthIndicator, ProviderSpec};

// ─── Where to look ───────────────────────────────────────────────────────

/// Where to evaluate an agent's sign-in state: the HOME its relative paths
/// resolve against, plus the env overrides the agent is spawned with (a
/// per-account `CLAUDE_CONFIG_DIR`, or the relocated HOME/XDG bundle).
#[derive(Debug, Clone)]
pub struct AuthCtx {
    pub home: PathBuf,
    pub env: HashMap<String, String>,
    /// Fall back to this process's environment for variables `env` doesn't
    /// set, as a spawned agent inherits it. Off in tests for hermetic checks.
    pub inherit_process_env: bool,
}

impl AuthCtx {
    /// The System account: the real HOME and the inherited environment.
    pub fn system() -> Self {
        Self {
            home: fleetify_core::user_home(),
            env: HashMap::new(),
            inherit_process_env: true,
        }
    }

    /// An account whose agent runs with `env` on top of the inherited
    /// environment. A `HOME` (or `USERPROFILE`) override relocates every
    /// home-relative path.
    pub fn with_env(env: impl IntoIterator<Item = (String, String)>) -> Self {
        let env: HashMap<String, String> = env.into_iter().collect();
        let home = env
            .get("HOME")
            .or_else(|| env.get("USERPROFILE"))
            .map(PathBuf::from)
            .unwrap_or_else(fleetify_core::user_home);
        Self {
            home,
            env,
            inherit_process_env: true,
        }
    }

    /// A variable as the agent would see it. Empty or blank counts as unset.
    pub fn var(&self, name: &str) -> Option<String> {
        let v = match self.env.get(name) {
            Some(v) => Some(v.clone()),
            None if self.inherit_process_env => std::env::var(name).ok(),
            None => None,
        };
        v.filter(|s| !s.trim().is_empty())
    }

    /// `$<env>/<env_subdir>` when `env` is set, else `~/<home_dir>`.
    fn config_dir(&self, env: &str, env_subdir: &str, home_dir: &str) -> PathBuf {
        match self.var(env) {
            Some(dir) if env_subdir.is_empty() => PathBuf::from(dir),
            Some(dir) => PathBuf::from(dir).join(env_subdir),
            None if home_dir.is_empty() => self.home.clone(),
            None => self.home.join(home_dir),
        }
    }
}

// ─── Indicators ──────────────────────────────────────────────────────────

/// Does any of `inds` fire for `ctx`? One is enough.
pub fn indicators_fire(ctx: &AuthCtx, inds: &[AuthIndicator]) -> bool {
    inds.iter().any(|ind| indicator_fires(ctx, ind))
}

fn indicator_fires(ctx: &AuthCtx, ind: &AuthIndicator) -> bool {
    match *ind {
        AuthIndicator::HomeDir { path } => ctx.home.join(path).exists(),
        AuthIndicator::EnvVar { name } => ctx.var(name).is_some(),
        AuthIndicator::JsonFieldPresent { path, field } => {
            json_field_holds_something(&ctx.home.join(path), field)
        }
        AuthIndicator::ConfigFile {
            env,
            env_subdir,
            home_dir,
            file,
            field,
        } => {
            let path = ctx.config_dir(env, env_subdir, home_dir).join(file);
            match field {
                Some(f) => json_field_holds_something(&path, f),
                None => file_holds_something(&path),
            }
        }
        AuthIndicator::ProviderKey {
            env,
            home_dir,
            file,
            names,
        } => {
            names.iter().any(|n| ctx.var(n).is_some())
                || dotenv_sets_any(&ctx.config_dir(env, "", home_dir).join(file), names)
        }
        AuthIndicator::YamlLocalEndpoint {
            env,
            home_dir,
            file,
            section,
        } => yaml_section_base_url_is_local(&ctx.config_dir(env, "", home_dir).join(file), section),
        AuthIndicator::OsCredential { service, user } => os_credential_exists(service, user),
        AuthIndicator::FleetifyKey { provider } => fleetify_key_saved(provider),
    }
}

#[cfg(test)]
thread_local! {
    /// Test seam: the providers tests pretend have a key saved in Fleetify,
    /// so they don't race other tests over the process-wide key cache.
    static TEST_FLEETIFY_KEYS: std::cell::RefCell<Option<Vec<String>>> =
        const { std::cell::RefCell::new(None) };
}

/// The user saved a key for `provider` in Fleetify (the shell pushes the
/// keychain's keys into `providers::keys` after every change).
fn fleetify_key_saved(provider: &str) -> bool {
    #[cfg(test)]
    {
        if let Some(found) = TEST_FLEETIFY_KEYS
            .with(|t| t.borrow().as_ref().map(|v| v.iter().any(|p| p == provider)))
        {
            return found;
        }
    }
    crate::providers::keys::get_key(provider).is_some_and(|k| !k.trim().is_empty())
}

/// Not null, blank, `[]` or `{}`. `false` and `0` hold nothing either.
fn holds_something(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0),
        Value::String(s) => !s.trim().is_empty(),
        Value::Array(a) => !a.is_empty(),
        Value::Object(o) => !o.is_empty(),
    }
}

fn read_json(path: &Path) -> Option<Value> {
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

/// `path` is JSON whose `field` holds something.
fn json_field_holds_something(path: &Path, field: &str) -> bool {
    read_json(path)
        .and_then(|v| v.get(field).cloned())
        .is_some_and(|f| holds_something(&f))
}

/// `path` holds something: non-empty JSON, or non-blank text.
fn file_holds_something(path: &Path) -> bool {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return false;
    };
    match serde_json::from_str::<Value>(&raw) {
        Ok(v) => holds_something(&v),
        Err(_) => !raw.trim().is_empty(),
    }
}

/// A dotenv file assigns a non-empty value to one of `names`. Comments,
/// `export ` prefixes and surrounding quotes are understood.
fn dotenv_sets_any(path: &Path, names: &[&str]) -> bool {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return false;
    };
    raw.lines().any(|line| {
        let line = line.trim();
        if line.starts_with('#') {
            return false;
        }
        let line = line.strip_prefix("export ").unwrap_or(line);
        let Some((key, value)) = line.split_once('=') else {
            return false;
        };
        let value = value.trim().trim_matches(|c| c == '"' || c == '\'');
        names.contains(&key.trim()) && !value.trim().is_empty()
    })
}

/// The YAML file's top-level `section:` block sets `base_url` to a loopback
/// address. A line scan, not a YAML parse: the block is the run of indented
/// lines after `section:` at column 0.
fn yaml_section_base_url_is_local(path: &Path, section: &str) -> bool {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return false;
    };
    let header = format!("{section}:");
    let mut in_section = false;
    for line in raw.lines() {
        if line.trim().is_empty() || line.trim_start().starts_with('#') {
            continue;
        }
        let indented = line.starts_with(' ') || line.starts_with('\t');
        if !indented {
            in_section = line.trim_end() == header;
            continue;
        }
        if !in_section {
            continue;
        }
        if let Some(rest) = line.trim_start().strip_prefix("base_url:") {
            let url = rest
                .split('#')
                .next()
                .unwrap_or("")
                .trim()
                .trim_matches(|c| c == '"' || c == '\'');
            return is_loopback_url(url);
        }
    }
    false
}

fn is_loopback_url(url: &str) -> bool {
    let rest = url
        .strip_prefix("http://")
        .or_else(|| url.strip_prefix("https://"))
        .unwrap_or("");
    let host = rest.split(['/', ':']).next().unwrap_or("");
    matches!(host, "localhost" | "127.0.0.1" | "0.0.0.0" | "[::1]") || host.starts_with("127.")
}

/// The GitHub CLI is signed in to github.com: Copilot's last-resort
/// credential (`gh auth token`). `hosts.yml` lives in `$GH_CONFIG_DIR`, else
/// `$XDG_CONFIG_HOME/gh`, else `~/.config/gh` (`%AppData%\GitHub CLI` on
/// Windows), and lists every host gh holds a login for.
fn gh_cli_signed_in(ctx: &AuthCtx) -> bool {
    if which::which("gh").is_err() {
        return false;
    }
    let dir = if let Some(d) = ctx.var("GH_CONFIG_DIR") {
        PathBuf::from(d)
    } else if cfg!(windows) {
        match ctx.var("APPDATA") {
            Some(appdata) => PathBuf::from(appdata).join("GitHub CLI"),
            None => ctx.home.join("AppData/Roaming/GitHub CLI"),
        }
    } else {
        ctx.config_dir("XDG_CONFIG_HOME", "gh", ".config/gh")
    };
    std::fs::read_to_string(dir.join("hosts.yml"))
        .map(|raw| raw.lines().any(|l| l.trim_end() == "github.com:"))
        .unwrap_or(false)
}

// ─── OS credential store ─────────────────────────────────────────────────

#[cfg(test)]
thread_local! {
    /// Test seam: the `(service, user)` pairs tests pretend are stored.
    static TEST_OS_CREDENTIALS: std::cell::RefCell<Option<Vec<(String, String)>>> =
        const { std::cell::RefCell::new(None) };
}

/// Is an item stored under (`service`, `user`) in the OS credential store,
/// in the layout go-keyring writes? The secret is never read, so this never
/// prompts.
fn os_credential_exists(service: &str, user: &str) -> bool {
    #[cfg(test)]
    {
        if let Some(found) = TEST_OS_CREDENTIALS.with(|t| {
            t.borrow()
                .as_ref()
                .map(|v| v.iter().any(|(s, u)| s == service && u == user))
        }) {
            return found;
        }
    }
    os_credential_exists_impl(service, user)
}

/// Linux: a Secret Service search on go-keyring's attributes. keyring-rs's
/// `Entry` adds a `target` attribute go-keyring doesn't write, so its
/// lookup would miss the item. Locked items count; nothing is unlocked.
#[cfg(target_os = "linux")]
fn os_credential_exists_impl(service: &str, user: &str) -> bool {
    use dbus_secret_service::{EncryptionType, SecretService};
    let Ok(ss) = SecretService::connect(EncryptionType::Plain) else {
        return false;
    };
    let attrs = HashMap::from([("service", service), ("username", user)]);
    ss.search_items(attrs)
        .map(|r| !r.unlocked.is_empty() || !r.locked.is_empty())
        .unwrap_or(false)
}

/// macOS: go-keyring drives `/usr/bin/security`; asking it for the item's
/// attributes (no `-w`) never shows a keychain prompt.
#[cfg(target_os = "macos")]
fn os_credential_exists_impl(service: &str, user: &str) -> bool {
    fleetify_core::process::command("/usr/bin/security")
        .args(["find-generic-password", "-s", service, "-a", user])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Windows: go-keyring stores a generic credential targeted `service:user`.
#[cfg(windows)]
fn os_credential_exists_impl(service: &str, user: &str) -> bool {
    use keyring::credential::CredentialApi;
    let target = format!("{service}:{user}");
    let Ok(cred) = keyring::windows::WinCredential::new_with_target(Some(&target), service, user)
    else {
        return false;
    };
    matches!(
        cred.get_secret(),
        Ok(_) | Err(keyring::Error::BadEncoding(_))
    )
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
fn os_credential_exists_impl(_service: &str, _user: &str) -> bool {
    false
}

// ─── The agent's own status command ──────────────────────────────────────

/// How an agent's own CLI reports its sign-in state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StatusProbe {
    /// Prints JSON whose boolean `field` is the answer
    /// (`claude auth status --json` → `loggedIn`).
    JsonBool {
        args: &'static [&'static str],
        field: &'static str,
    },
    /// Prints a sentence. `signed_out` is checked first: it usually
    /// contains `signed_in` ("Not logged in" ⊃ "logged in").
    Text {
        args: &'static [&'static str],
        signed_in: &'static str,
        signed_out: &'static str,
    },
}

/// The agent's own, read-only sign-in check, where it has one. Its answer
/// wins over the indicators, which are kept for builds without it.
pub fn status_probe_for(id: &str) -> Option<StatusProbe> {
    match id {
        // Exit 0/1, ~0.2 s, honours CLAUDE_CONFIG_DIR and counts
        // ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN / Bedrock / Vertex.
        "claude-code" => Some(StatusProbe::JsonBool {
            args: &["auth", "status", "--json"],
            field: "loggedIn",
        }),
        // "Logged in using ChatGPT" / "Not logged in"; honours CODEX_HOME.
        "codex-cli" => Some(StatusProbe::Text {
            args: &["login", "status"],
            signed_in: "Logged in",
            signed_out: "Not logged in",
        }),
        _ => None,
    }
}

const STATUS_PROBE_TIMEOUT: Duration = Duration::from_secs(5);

/// Read a status probe's output. `None` when it doesn't answer the question
/// (an older CLI without the command prints usage or an error instead).
pub fn parse_status_output(probe: &StatusProbe, stdout: &str, stderr: &str) -> Option<bool> {
    match *probe {
        StatusProbe::JsonBool { field, .. } => {
            let start = stdout.find('{')?;
            let v: Value = serde_json::from_str(stdout[start..].trim()).ok()?;
            v.get(field)?.as_bool()
        }
        StatusProbe::Text {
            signed_in,
            signed_out,
            ..
        } => {
            let text = format!("{stdout}\n{stderr}");
            if text.contains(signed_out) {
                Some(false)
            } else if text.contains(signed_in) {
                Some(true)
            } else {
                None
            }
        }
    }
}

/// Run the agent's status command with the account's env. `None` when it
/// can't run, times out, or gives no answer.
async fn run_status_probe(bin: &str, probe: &StatusProbe, ctx: &AuthCtx) -> Option<bool> {
    let args = match probe {
        StatusProbe::JsonBool { args, .. } | StatusProbe::Text { args, .. } => *args,
    };
    let mut cmd = tokio_command(bin);
    cmd.args(args)
        .envs(&ctx.env)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    let out = tokio::time::timeout(STATUS_PROBE_TIMEOUT, cmd.output())
        .await
        .ok()?
        .ok()?;
    parse_status_output(
        probe,
        &String::from_utf8_lossy(&out.stdout),
        &String::from_utf8_lossy(&out.stderr),
    )
}

// ─── The verdict ─────────────────────────────────────────────────────────

/// Does the agent need a sign-in before it can answer? OpenCode doesn't:
/// its free `opencode/*` models run with no credentials, and a paid provider
/// is an optional extra.
pub fn sign_in_required(id: &str) -> bool {
    id != "opencode"
}

/// Is `spec` signed in for `ctx`? `bin` is the resolved binary (the status
/// probe runs it); `None` means not installed, which is never signed in.
pub async fn agent_signed_in(spec: &ProviderSpec, bin: Option<&str>, ctx: &AuthCtx) -> bool {
    let Some(bin) = bin else {
        return false;
    };
    if !sign_in_required(spec.id) {
        return true;
    }
    if let Some(probe) = status_probe_for(spec.id) {
        if let Some(answer) = run_status_probe(bin, &probe, ctx).await {
            return answer;
        }
    }
    indicators_fire(ctx, spec.auth_indicators)
        || (spec.id == "github-copilot" && gh_cli_signed_in(ctx))
}

// ─── Binaries ────────────────────────────────────────────────────────────

/// Resolve an agent's binary the way its bridge does, so detection, login
/// and spawn agree. `None` when it isn't installed. The Antigravity SDK is a
/// Python module, not a binary: see [`detect_install`].
pub fn resolve_bin(id: &str, bin: &str) -> Option<String> {
    match id {
        "antigravity-cli" => crate::bridges::antigravity::resolve_agy_bin(),
        "cursor-cli" => crate::bridges::cursor::resolve_cursor_bin(),
        "github-copilot" => crate::bridges::github_copilot::resolve_copilot_bin(),
        "hermes-agent" => crate::bridges::hermes::resolve_hermes_bin(),
        "grok-build" => crate::bridges::grok_cli::resolve_grok_bin(),
        _ if bin.is_empty() => None,
        _ => which::which(bin)
            .ok()
            .map(|p| p.to_string_lossy().into_owned()),
    }
}

/// The path that proves `spec` is installed: its binary, or for the
/// Antigravity SDK the Python interpreter that can import it.
pub async fn detect_install(spec: &ProviderSpec) -> Option<String> {
    if spec.id == "antigravity-sdk" {
        let probe = python_module_installed("google.antigravity").await;
        return if probe.installed { probe.path } else { None };
    }
    resolve_bin(spec.id, spec.bin)
}

/// Shape of the python_module_installed probe result.
pub struct PythonProbe {
    pub installed: bool,
    pub path: Option<String>,
}

/// Resolve the first Python interpreter on PATH that actually executes
/// successfully (exit-success on `--version`). This filters out the
/// Microsoft Store stub on Windows (`python3.exe` / `python.exe` in
/// `%LOCALAPPDATA%\Microsoft\WindowsApps\`) which is on PATH and passes
/// `which::which` but exits non-zero when run without the Store package
/// installed behind it.
async fn working_python_path() -> Option<String> {
    for name in &["python3", "python", "py"] {
        let Ok(path) = which::which(name) else {
            continue;
        };
        let path = path.to_string_lossy().into_owned();
        let ok = tokio_command(&path)
            .arg("--version")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .await
            .map(|s| s.success())
            .unwrap_or(false);
        if ok {
            return Some(path);
        }
    }
    None
}

/// Probe whether `module` is importable under the first Python we can
/// resolve. Honours FLEETIFY_EMBEDDED_PYTHON for forward-compat with a
/// bundled interpreter. 5-second timeout — startup + stdlib import is
/// sub-second on real machines.
pub async fn python_module_installed(module: &str) -> PythonProbe {
    let python_path: Option<String> = match std::env::var("FLEETIFY_EMBEDDED_PYTHON") {
        Ok(p) if std::path::Path::new(&p).exists() => Some(p),
        _ => working_python_path().await,
    };
    let Some(py) = python_path else {
        return PythonProbe {
            installed: false,
            path: None,
        };
    };
    let installed = tokio::time::timeout(
        Duration::from_secs(5),
        tokio_command(&py)
            .args(["-c", &format!("import {module}")])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status(),
    )
    .await
    .map(|r| r.map(|s| s.success()).unwrap_or(false))
    .unwrap_or(false);
    PythonProbe {
        installed,
        path: Some(py),
    }
}

// ─── Signing in ──────────────────────────────────────────────────────────

/// How Fleetify signs an agent in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LoginKind {
    /// A login command that opens the browser and finishes on its own (a
    /// localhost callback or a device code). Runs without a terminal; its
    /// output carries the sign-in URL and, for device flows, a code.
    Browser,
    /// An interactive command (a menu or a TUI) that needs a terminal.
    Terminal,
    /// No login command: the user pastes an API key.
    ApiKey,
}

/// The command Fleetify runs to sign an agent in. `argv[0]` is the agent's
/// own binary name, which [`resolve_bin`] turns into a path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LoginSpec {
    pub kind: LoginKind,
    pub argv: &'static [&'static str],
}

/// How to sign `id` in. Verified against each CLI's own login command
/// (2026-11-28): `claude login` is not one (`claude auth login` is), Grok's
/// device flow prints a URL and code instead of needing a local browser,
/// `agy` has no login subcommand (its TUI signs in on first run), and
/// `hermes model` / `opencode auth login` are interactive menus.
pub fn login_spec(id: &str) -> Option<LoginSpec> {
    let (kind, argv): (LoginKind, &'static [&'static str]) = match id {
        "claude-code" => (LoginKind::Browser, &["claude", "auth", "login"]),
        "codex-cli" => (LoginKind::Browser, &["codex", "login"]),
        "kimi-code" => (LoginKind::Browser, &["kimi", "login"]),
        "github-copilot" => (LoginKind::Browser, &["copilot", "login"]),
        "cursor-cli" => (LoginKind::Browser, &["cursor-agent", "login"]),
        "grok-build" => (LoginKind::Browser, &["grok", "login", "--device-auth"]),
        "opencode" => (LoginKind::Terminal, &["opencode", "auth", "login"]),
        "hermes-agent" => (LoginKind::Terminal, &["hermes", "model"]),
        "antigravity-cli" => (LoginKind::Terminal, &["agy"]),
        "antigravity-sdk" => (LoginKind::ApiKey, &[]),
        _ => return None,
    };
    Some(LoginSpec { kind, argv })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx(home: &Path, env: &[(&str, &str)]) -> AuthCtx {
        AuthCtx {
            home: home.to_path_buf(),
            env: env
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
            inherit_process_env: false,
        }
    }

    fn write(path: &Path, body: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, body).unwrap();
    }

    fn spec(id: &str) -> &'static ProviderSpec {
        crate::providers::find_agent(id).unwrap()
    }

    fn fires(id: &str, c: &AuthCtx) -> bool {
        indicators_fire(c, spec(id).auth_indicators)
    }

    #[test]
    fn claude_usage_artifacts_alone_are_not_a_login() {
        // What one signed-out `claude -p` run leaves behind.
        let t = tempfile::tempdir().unwrap();
        let cfg = t.path().join(".claude");
        std::fs::create_dir_all(cfg.join("projects")).unwrap();
        std::fs::create_dir_all(cfg.join("sessions")).unwrap();
        write(&cfg.join("history.jsonl"), "{}\n");
        write(&t.path().join(".claude.json"), r#"{"numStartups":1}"#);
        assert!(!fires("claude-code", &ctx(t.path(), &[])));
    }

    #[test]
    fn claude_oauth_credentials_are_a_login_in_the_config_dir() {
        let t = tempfile::tempdir().unwrap();
        write(
            &t.path().join(".claude/.credentials.json"),
            r#"{"claudeAiOauth":{"accessToken":"x"},"mcpOAuth":{}}"#,
        );
        assert!(fires("claude-code", &ctx(t.path(), &[])));

        // With CLAUDE_CONFIG_DIR the same file is read from that dir instead.
        let other = tempfile::tempdir().unwrap();
        let dir = other.path().to_string_lossy().into_owned();
        assert!(!fires(
            "claude-code",
            &ctx(t.path(), &[("CLAUDE_CONFIG_DIR", &dir)])
        ));
        write(
            &other.path().join(".credentials.json"),
            r#"{"claudeAiOauth":{"accessToken":"y"}}"#,
        );
        assert!(fires(
            "claude-code",
            &ctx(t.path(), &[("CLAUDE_CONFIG_DIR", &dir)])
        ));
    }

    #[test]
    fn claude_mcp_only_credentials_file_is_not_a_login() {
        let t = tempfile::tempdir().unwrap();
        write(
            &t.path().join(".claude/.credentials.json"),
            r#"{"mcpOAuth":{"server":{}}}"#,
        );
        assert!(!fires("claude-code", &ctx(t.path(), &[])));
    }

    #[test]
    fn claude_oauth_account_in_home_claude_json_counts() {
        let t = tempfile::tempdir().unwrap();
        write(
            &t.path().join(".claude.json"),
            r#"{"oauthAccount":{"emailAddress":"a@b.c"}}"#,
        );
        assert!(fires("claude-code", &ctx(t.path(), &[])));
    }

    #[test]
    fn claude_api_key_env_counts_but_blank_does_not() {
        let t = tempfile::tempdir().unwrap();
        assert!(fires(
            "claude-code",
            &ctx(t.path(), &[("ANTHROPIC_API_KEY", "sk")])
        ));
        assert!(!fires(
            "claude-code",
            &ctx(t.path(), &[("ANTHROPIC_API_KEY", "  ")])
        ));
    }

    #[test]
    fn codex_needs_auth_json_tokens_or_stored_key_not_the_env_key() {
        let t = tempfile::tempdir().unwrap();
        assert!(!fires(
            "codex-cli",
            &ctx(t.path(), &[("OPENAI_API_KEY", "sk")])
        ));
        write(
            &t.path().join(".codex/auth.json"),
            r#"{"auth_mode":"chatgpt","tokens":null,"OPENAI_API_KEY":null}"#,
        );
        assert!(!fires("codex-cli", &ctx(t.path(), &[])));
        write(
            &t.path().join(".codex/auth.json"),
            r#"{"auth_mode":"chatgpt","tokens":{"id_token":"x"},"OPENAI_API_KEY":null}"#,
        );
        assert!(fires("codex-cli", &ctx(t.path(), &[])));
    }

    #[test]
    fn codex_home_relocates_auth_json() {
        let t = tempfile::tempdir().unwrap();
        let codex_home = t.path().join("acct");
        write(
            &codex_home.join("auth.json"),
            r#"{"OPENAI_API_KEY":"sk-x"}"#,
        );
        let home = codex_home.to_string_lossy().into_owned();
        assert!(!fires("codex-cli", &ctx(t.path(), &[])));
        assert!(fires("codex-cli", &ctx(t.path(), &[("CODEX_HOME", &home)])));
    }

    #[test]
    fn kimi_token_counts_and_a_revoked_tombstone_does_not() {
        let t = tempfile::tempdir().unwrap();
        let file = t.path().join(".kimi-code/credentials/kimi-code.json");
        write(
            &file,
            r#"{"access_token":"","refresh_token":"","expires_at":0}"#,
        );
        assert!(!fires("kimi-code", &ctx(t.path(), &[])));
        write(
            &file,
            r#"{"access_token":"tok","refresh_token":"r","expires_at":1}"#,
        );
        assert!(fires("kimi-code", &ctx(t.path(), &[])));
        // The old `~/.kimi/auth.json` guess is not Kimi Code's store.
        let t2 = tempfile::tempdir().unwrap();
        write(&t2.path().join(".kimi/auth.json"), r#"{"x":1}"#);
        assert!(!fires("kimi-code", &ctx(t2.path(), &[])));
    }

    #[test]
    fn copilot_config_needs_a_logged_in_user() {
        let t = tempfile::tempdir().unwrap();
        let cfg = t.path().join(".copilot/config.json");
        write(&cfg, r#"{"logged_in_users":[],"trusted_folders":["/x"]}"#);
        assert!(!fires("github-copilot", &ctx(t.path(), &[])));
        write(
            &cfg,
            r#"{"logged_in_users":[{"host":"https://github.com","login":"octo"}]}"#,
        );
        assert!(fires("github-copilot", &ctx(t.path(), &[])));
    }

    #[test]
    fn cursor_reads_auth_info_from_xdg_or_home() {
        let t = tempfile::tempdir().unwrap();
        write(
            &t.path().join(".cursor/cli-config.json"),
            r#"{"version":1}"#,
        );
        assert!(!fires("cursor-cli", &ctx(t.path(), &[])));
        write(
            &t.path().join(".cursor/cli-config.json"),
            r#"{"authInfo":{"email":"a@b.c"}}"#,
        );
        assert!(fires("cursor-cli", &ctx(t.path(), &[])));

        let t2 = tempfile::tempdir().unwrap();
        let xdg = t2.path().join("cfg");
        write(
            &xdg.join("cursor/cli-config.json"),
            r#"{"authInfo":{"email":"a@b.c"}}"#,
        );
        let xdg = xdg.to_string_lossy().into_owned();
        assert!(fires(
            "cursor-cli",
            &ctx(t2.path(), &[("XDG_CONFIG_HOME", &xdg)])
        ));
    }

    #[test]
    fn grok_auth_json_counts_after_grok_login() {
        let t = tempfile::tempdir().unwrap();
        TEST_FLEETIFY_KEYS.with(|k| *k.borrow_mut() = Some(vec![]));
        assert!(!fires("grok-build", &ctx(t.path(), &[])));
        write(&t.path().join(".grok/auth.json"), r#"{"access_token":"x"}"#);
        assert!(fires("grok-build", &ctx(t.path(), &[])));
        // An emptied file after `grok logout` does not.
        write(&t.path().join(".grok/auth.json"), "{}");
        assert!(!fires("grok-build", &ctx(t.path(), &[])));
        TEST_FLEETIFY_KEYS.with(|k| *k.borrow_mut() = None);
    }

    #[test]
    fn hermes_template_files_are_not_a_configured_provider() {
        let t = tempfile::tempdir().unwrap();
        let home = t.path().join(HERMES_HOME_DIR_FOR_TESTS);
        // What install.sh copies in: the template config and .env.
        write(
            &home.join("config.yaml"),
            "_config_version: 55\nmodel:\n  default: \"anthropic/claude-opus-4.6\"\n  provider: \"auto\"\n  base_url: \"https://openrouter.ai/api/v1\"\nterminal:\n  backend: local\n",
        );
        write(
            &home.join(".env"),
            "# OPENROUTER_API_KEY=\nTERMINAL_TIMEOUT=60\nFIRECRAWL_API_KEY=fc-123\n",
        );
        assert!(!fires("hermes-agent", &ctx(t.path(), &[])));
    }

    #[test]
    fn hermes_provider_key_oauth_login_or_local_model_counts() {
        let t = tempfile::tempdir().unwrap();
        let home = t.path().join(HERMES_HOME_DIR_FOR_TESTS);
        write(
            &home.join(".env"),
            "export OPENROUTER_API_KEY=\"sk-or-1\"\n",
        );
        assert!(fires("hermes-agent", &ctx(t.path(), &[])));

        let t2 = tempfile::tempdir().unwrap();
        let home2 = t2.path().join(HERMES_HOME_DIR_FOR_TESTS);
        write(
            &home2.join("auth.json"),
            r#"{"version":1,"providers":{"nous":{}},"active_provider":"nous"}"#,
        );
        assert!(fires("hermes-agent", &ctx(t2.path(), &[])));

        let t3 = tempfile::tempdir().unwrap();
        let home3 = t3.path().join(HERMES_HOME_DIR_FOR_TESTS);
        write(
            &home3.join("config.yaml"),
            "model:\n  provider: custom\n  base_url: http://localhost:11434/v1 # ollama\n",
        );
        assert!(fires("hermes-agent", &ctx(t3.path(), &[])));

        // A provider key in the inherited environment works too.
        let t4 = tempfile::tempdir().unwrap();
        assert!(fires(
            "hermes-agent",
            &ctx(t4.path(), &[("ANTHROPIC_API_KEY", "sk-ant")])
        ));
    }

    #[cfg(not(windows))]
    const HERMES_HOME_DIR_FOR_TESTS: &str = ".hermes";
    #[cfg(windows)]
    const HERMES_HOME_DIR_FOR_TESTS: &str = "AppData/Local/hermes";

    #[test]
    fn agy_login_is_the_os_credential_not_the_install_marker() {
        let t = tempfile::tempdir().unwrap();
        write(
            &t.path().join(".gemini/antigravity-cli/installation_id"),
            "id",
        );
        TEST_OS_CREDENTIALS.with(|c| *c.borrow_mut() = Some(vec![]));
        assert!(!fires("antigravity-cli", &ctx(t.path(), &[])));
        TEST_OS_CREDENTIALS
            .with(|c| *c.borrow_mut() = Some(vec![("gemini".into(), "antigravity".into())]));
        assert!(fires("antigravity-cli", &ctx(t.path(), &[])));
        TEST_OS_CREDENTIALS.with(|c| *c.borrow_mut() = None);
    }

    #[test]
    fn agy_legacy_oauth_creds_count_by_refresh_token_not_expiry() {
        let t = tempfile::tempdir().unwrap();
        TEST_OS_CREDENTIALS.with(|c| *c.borrow_mut() = Some(vec![]));
        // An expired access token with a refresh token is still a login.
        write(
            &t.path().join(".gemini/oauth_creds.json"),
            r#"{"access_token":"a","refresh_token":"r","expiry_date":1}"#,
        );
        assert!(fires("antigravity-cli", &ctx(t.path(), &[])));
        TEST_OS_CREDENTIALS.with(|c| *c.borrow_mut() = None);
    }

    #[test]
    fn antigravity_sdk_and_grok_count_a_key_saved_in_fleetify() {
        let t = tempfile::tempdir().unwrap();
        let c = ctx(t.path(), &[]);
        TEST_FLEETIFY_KEYS.with(|k| *k.borrow_mut() = Some(vec![]));
        assert!(!fires("antigravity-sdk", &c));
        assert!(!fires("grok-build", &c));
        TEST_FLEETIFY_KEYS
            .with(|k| *k.borrow_mut() = Some(vec!["antigravity-sdk".into(), "grok".into()]));
        assert!(fires("antigravity-sdk", &c));
        assert!(fires("grok-build", &c));
        TEST_FLEETIFY_KEYS.with(|k| *k.borrow_mut() = None);
    }

    #[test]
    fn status_probe_output_parses_both_shapes() {
        let claude = status_probe_for("claude-code").unwrap();
        assert_eq!(
            parse_status_output(&claude, r#"{"loggedIn":true,"authMethod":"claude.ai"}"#, ""),
            Some(true)
        );
        assert_eq!(
            parse_status_output(&claude, "{\n  \"loggedIn\": false\n}\n", ""),
            Some(false)
        );
        // An older claude without `auth status` prints something else.
        assert_eq!(
            parse_status_output(&claude, "", "error: unknown option '--json'"),
            None
        );

        let codex = status_probe_for("codex-cli").unwrap();
        assert_eq!(
            parse_status_output(&codex, "Logged in using ChatGPT\n", ""),
            Some(true)
        );
        assert_eq!(
            parse_status_output(&codex, "", "Not logged in\n"),
            Some(false)
        );
        assert_eq!(parse_status_output(&codex, "", "unknown command"), None);
    }

    #[test]
    fn opencode_needs_no_sign_in() {
        assert!(!sign_in_required("opencode"));
        assert!(sign_in_required("claude-code"));
    }

    #[test]
    fn every_cli_agent_has_a_login_spec_and_real_commands() {
        for s in crate::providers::list_cli_agents() {
            let l = login_spec(s.id).unwrap_or_else(|| panic!("{} has no login spec", s.id));
            match l.kind {
                LoginKind::ApiKey => assert!(l.argv.is_empty()),
                _ => assert!(!l.argv.is_empty(), "{} has an empty login argv", s.id),
            }
        }
        assert_eq!(
            login_spec("claude-code").unwrap().argv,
            &["claude", "auth", "login"]
        );
        assert_eq!(
            login_spec("grok-build").unwrap().argv,
            &["grok", "login", "--device-auth"]
        );
    }

    #[test]
    fn yaml_local_endpoint_scan_stays_inside_the_section() {
        let t = tempfile::tempdir().unwrap();
        let f = t.path().join("c.yaml");
        write(
            &f,
            "model:\n  provider: x\nother:\n  base_url: http://127.0.0.1:1/v1\n",
        );
        assert!(!yaml_section_base_url_is_local(&f, "model"));
        write(&f, "model:\n  base_url: 'http://127.0.0.1:1234/v1'\n");
        assert!(yaml_section_base_url_is_local(&f, "model"));
    }

    #[tokio::test]
    async fn uninstalled_agent_is_never_signed_in() {
        let t = tempfile::tempdir().unwrap();
        let c = ctx(t.path(), &[("ANTHROPIC_API_KEY", "sk")]);
        assert!(!agent_signed_in(spec("claude-code"), None, &c).await);
        assert!(!agent_signed_in(spec("opencode"), None, &c).await);
        assert!(agent_signed_in(spec("opencode"), Some("/usr/bin/opencode"), &c).await);
    }
}
