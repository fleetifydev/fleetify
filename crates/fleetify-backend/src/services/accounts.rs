//! Multiple accounts per provider/agent.
//!
//! A provider/agent can have several identities. Two flavors:
//!
//! * **CLI agent** (`claude`, `codex`, `gemini`, …): isolated by pointing the
//!   spawned subprocess at a private fake HOME via [`account_env`]. Each
//!   account's credentials live under
//!   `fleetify_home()/accounts/<provider_id>/<account_id>/`, written there by
//!   the agent's own login flow (run in a PTY with the same env override).
//! * **HTTP provider** (`openai`, `deepseek`, …): a labeled API key in the OS
//!   keychain (stored shell-side, keyed by the account `id`).
//!
//! The pre-existing, out-of-Fleetify login is surfaced as a synthetic
//! **System** account (id [`SYSTEM_ACCOUNT_ID`]) — the real HOME for CLI, the
//! legacy keychain key for HTTP. It is never a DB row, always listed first,
//! and can never be deleted. A `NULL` `session.account_id` resolves to it.

use std::path::{Path, PathBuf};

use sqlx::SqlitePool;

use crate::models::account::{Account, AccountCreate, AccountKind, AccountView, SYSTEM_ACCOUNT_ID};

/// Errors the accounts service can raise; the router maps these to HTTP codes.
#[derive(Debug)]
pub enum AccountError {
    /// Account is still referenced by a live session and `force` was not set.
    InUse(usize),
    /// No such account row.
    NotFound,
    /// The System account cannot be created, deleted, or renamed.
    SystemImmutable,
    Db(sqlx::Error),
    Io(std::io::Error),
}

impl From<sqlx::Error> for AccountError {
    fn from(e: sqlx::Error) -> Self {
        AccountError::Db(e)
    }
}
impl From<std::io::Error> for AccountError {
    fn from(e: std::io::Error) -> Self {
        AccountError::Io(e)
    }
}

impl std::fmt::Display for AccountError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AccountError::InUse(n) => write!(f, "account is in use by {n} session(s)"),
            AccountError::NotFound => write!(f, "account not found"),
            AccountError::SystemImmutable => write!(f, "the System account cannot be modified"),
            AccountError::Db(e) => write!(f, "db error: {e}"),
            AccountError::Io(e) => write!(f, "io error: {e}"),
        }
    }
}

/// Absolute path to a CLI account's isolated fake HOME.
/// `fleetify_home()/accounts/<provider_id>/<account_id>/`.
pub fn account_home_dir(provider_id: &str, account_id: &str) -> PathBuf {
    fleetify_core::fleetify_home()
        .join("accounts")
        .join(provider_id)
        .join(account_id)
}

/// The env-var bundle that relocates a CLI agent's entire credential surface
/// to an isolated `home`. Provider-independent on purpose — setting an env var
/// an agent ignores is harmless, and covering every layout (HOME, XDG, Windows
/// AppData) in one place means no bridge has to special-case isolation.
///
/// Covers: `HOME` / `USERPROFILE` (the base), `XDG_CONFIG_HOME` /
/// `XDG_DATA_HOME` (opencode, claude's `~/.config/anthropic`), and on Windows
/// `APPDATA` / `LOCALAPPDATA` (cursor, github-copilot, hermes).
pub fn account_env(home: &Path) -> Vec<(String, String)> {
    let h = home.to_string_lossy().into_owned();
    #[cfg_attr(not(windows), allow(unused_mut))]
    let mut env = vec![
        ("HOME".to_string(), h.clone()),
        ("USERPROFILE".to_string(), h.clone()),
        (
            "XDG_CONFIG_HOME".to_string(),
            home.join(".config").to_string_lossy().into_owned(),
        ),
        (
            "XDG_DATA_HOME".to_string(),
            home.join(".local")
                .join("share")
                .to_string_lossy()
                .into_owned(),
        ),
    ];
    #[cfg(windows)]
    {
        env.push((
            "APPDATA".to_string(),
            home.join("AppData")
                .join("Roaming")
                .to_string_lossy()
                .into_owned(),
        ));
        env.push((
            "LOCALAPPDATA".to_string(),
            home.join("AppData")
                .join("Local")
                .to_string_lossy()
                .into_owned(),
        ));
    }
    env
}

/// Is `account_id` the synthetic System account (or absent ⇒ System)?
pub fn is_system(account_id: Option<&str>) -> bool {
    matches!(account_id, None | Some(SYSTEM_ACCOUNT_ID) | Some(""))
}

/// Fetch a single account row by id (System / NULL ⇒ `None`).
pub async fn get(pool: &SqlitePool, account_id: &str) -> Result<Option<Account>, AccountError> {
    if is_system(Some(account_id)) {
        return Ok(None);
    }
    let row = sqlx::query_as::<_, Account>("SELECT * FROM accounts WHERE id = ?")
        .bind(account_id)
        .fetch_optional(pool)
        .await?;
    Ok(row)
}

/// Resolve a session's `account_id` to a CLI HOME override — used ONLY by the
/// antigravity bridge for its in-process disk reads. `None` for System, a
/// NULL/unknown id, an HTTP account, or a config-dir agent (which isolates via
/// an env var, not a HOME swap — see [`resolve_env`]).
pub async fn resolve_home(pool: &SqlitePool, account_id: Option<&str>) -> Option<PathBuf> {
    let id = account_id?;
    if is_system(Some(id)) || id.starts_with(DISCOVERED_PREFIX) {
        return None;
    }
    if config_dir_spec(account_provider(pool, id).await.as_deref().unwrap_or("")).is_some() {
        return None;
    }
    let acc = get(pool, id).await.ok().flatten()?;
    acc.home_dir.map(PathBuf::from)
}

/// Provider id of a managed account (for resolve_home's config-dir check).
async fn account_provider(pool: &SqlitePool, account_id: &str) -> Option<String> {
    get(pool, account_id)
        .await
        .ok()
        .flatten()
        .map(|a| a.provider_id)
}

/// Resolve a session's account to the env vars the spawned subprocess needs so
/// it reads that account's credentials. Empty for the System account.
///
/// Resolution of `account_id`:
///   * `Some("system")` ⇒ explicit System (empty env).
///   * `Some(specific)` ⇒ that pinned account.
///   * `None` ⇒ **the provider's current main account** — so setting a main
///     account takes effect for every session (existing chats, Fleet, new) that
///     didn't pin a specific one. The claude bridge handles the resulting
///     resume mismatch by checking the account's own config dir and starting
///     fresh there if needed (no "No conversation found").
///
/// For **config-dir agents** (claude/codex) the env is `CLAUDE_CONFIG_DIR=<dir>`
/// (a discovered `~/.claude-N` or a managed dir); for **HOME-isolation agents**
/// it's the full HOME/XDG/AppData bundle from [`account_env`].
pub async fn resolve_env(
    pool: &SqlitePool,
    provider_id: &str,
    account_id: Option<&str>,
    user_id: &str,
) -> Vec<(String, String)> {
    let effective: String = match account_id {
        Some(id) if is_system(Some(id)) => return Vec::new(), // explicit System
        Some(id) => id.to_string(),
        None => match default_account_for(pool, provider_id, user_id).await {
            Some(d) => d,
            None => return Vec::new(), // main is System
        },
    };
    let id = effective.as_str();
    // Discovered on-disk config dir: `dir:.claude-2` → CLAUDE_CONFIG_DIR.
    if let Some(name) = id.strip_prefix(DISCOVERED_PREFIX) {
        if let Some((env_var, _)) = config_dir_spec(provider_id) {
            let dir = fleetify_core::user_home().join(name);
            return vec![(env_var.to_string(), dir.to_string_lossy().into_owned())];
        }
        return Vec::new();
    }
    // Managed (DB) account.
    let Some(acc) = get(pool, id).await.ok().flatten() else {
        return Vec::new();
    };
    let Some(home) = acc.home_dir else {
        return Vec::new();
    };
    if let Some((env_var, _)) = config_dir_spec(provider_id) {
        // The managed dir IS the agent's config dir.
        vec![(env_var.to_string(), home)]
    } else {
        account_env(Path::new(&home))
    }
}

/// CLI account auth check: do the provider's catalog indicators fire against
/// this account's home? `false` for unknown providers or HTTP providers.
fn cli_authenticated(provider_id: &str, home: &Path) -> bool {
    match crate::providers::find_agent(provider_id) {
        Some(spec) => {
            crate::routers::providers::indicators_authenticated(home, spec.auth_indicators)
        }
        None => false,
    }
}

/// The account kind a provider defaults to: CLI agents → `Cli`, everything
/// else → `Http`.
pub fn default_kind(provider_id: &str) -> AccountKind {
    if crate::providers::find_agent(provider_id).is_some() {
        AccountKind::Cli
    } else {
        AccountKind::Http
    }
}

/// Agents that support a native *config-directory* env var (so multiple
/// accounts live in separate config dirs instead of separate fake HOMEs).
/// Returns `(env_var, primary_basename)`. Claude reads `CLAUDE_CONFIG_DIR`
/// (`~/.claude`, `~/.claude-2`, …); Codex reads `CODEX_HOME` (`~/.codex`).
/// `None` ⇒ the agent isolates via a HOME override instead.
pub fn config_dir_spec(provider_id: &str) -> Option<(&'static str, &'static str)> {
    match provider_id {
        // Accept the legacy "claude" id too — config dirs predate the rename.
        "claude" | "claude-code" => Some(("CLAUDE_CONFIG_DIR", ".claude")),
        "codex-cli" => Some(("CODEX_HOME", ".codex")),
        _ => None,
    }
}

/// Prefix that marks a discovered (on-disk, not Fleetify-managed) config-dir
/// account id: `dir:.claude-2`.
const DISCOVERED_PREFIX: &str = "dir:";

/// Best-effort friendly account name read from the agent's on-disk state.
/// Claude stores the signed-in identity in `<config>/.claude.json` (or
/// `~/.claude.json` for the default config) under `oauthAccount.emailAddress`.
/// `config_dir` is the account's config dir (`~/.claude-2`) or `None` for the
/// System account (which reads `~/.claude.json` at the home root).
fn friendly_label(provider_id: &str, config_dir: Option<&Path>) -> Option<String> {
    if !matches!(provider_id, "claude" | "claude-code") {
        return None;
    }
    let json_path = match config_dir {
        Some(dir) => dir.join(".claude.json"),
        None => fleetify_core::user_home().join(".claude.json"),
    };
    let raw = std::fs::read_to_string(&json_path).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    v.get("oauthAccount")
        .and_then(|o| o.get("emailAddress"))
        .and_then(|e| e.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

/// The provider's main account id to pin a NEW session to — the non-System
/// default if one is set, else `None` (use System). Called at session creation
/// so the account is fixed for the session's life and its conversation history
/// always lives in the same config dir.
pub async fn default_account_for(
    pool: &SqlitePool,
    provider_id: &str,
    user_id: &str,
) -> Option<String> {
    match default_account_id(pool, provider_id, user_id).await {
        Some(d) if !is_system(Some(&d)) => Some(d),
        _ => None,
    }
}

/// Read the per-provider default-account override (any account id, or `None`
/// ⇒ System is default).
async fn default_account_id(pool: &SqlitePool, provider_id: &str, user_id: &str) -> Option<String> {
    sqlx::query_scalar::<_, String>(
        "SELECT account_id FROM provider_default_account \
         WHERE provider_id = ? AND (user_id = ? OR user_id IS NULL) LIMIT 1",
    )
    .bind(provider_id)
    .bind(user_id)
    .fetch_optional(pool)
    .await
    .ok()
    .flatten()
}

/// Does a config directory look like a signed-in account? Creds live in the OS
/// keychain (not on disk) on macOS/Windows, so we treat the presence of the
/// agent's working files (`projects/`, `history.jsonl`, `.claude.json`, or a
/// `.credentials.json`) as "this dir is a real, used account".
fn config_dir_authenticated(dir: &Path) -> bool {
    dir.join("projects").is_dir()
        || dir.join("history.jsonl").exists()
        || dir.join(".claude.json").exists()
        || dir.join(".credentials.json").exists()
        || dir.join("auth.json").exists()
}

/// Scan the user's home for additional config dirs of a config-dir agent —
/// `~/<basename>-<suffix>` siblings of the primary `~/<basename>` (which is the
/// System account). Returns `(dir_name, abs_path, authenticated)` for each.
fn discovered_config_dirs(provider_id: &str) -> Vec<(String, PathBuf, bool)> {
    let Some((_, basename)) = config_dir_spec(provider_id) else {
        return Vec::new();
    };
    let home = fleetify_core::user_home();
    let prefix = format!("{basename}-"); // e.g. ".claude-"
    let mut out = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&home) {
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            // Match `~/.claude-2`, `~/.claude-work`, … but not the primary
            // `~/.claude` (System) nor unrelated dot-dirs.
            if name.starts_with(&prefix) && e.path().is_dir() {
                let dir = e.path();
                let auth = config_dir_authenticated(&dir);
                out.push((name, dir, auth));
            }
        }
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

/// List every account for a provider — the synthetic System account first,
/// then the user's saved accounts (oldest first). `authenticated` is computed
/// for CLI accounts (indicator check vs. each home); HTTP `authenticated` is
/// left `false` here and resolved shell-side from keychain key presence.
pub async fn list(
    pool: &SqlitePool,
    provider_id: &str,
    user_id: &str,
) -> Result<Vec<AccountView>, AccountError> {
    let rows = sqlx::query_as::<_, Account>(
        "SELECT * FROM accounts WHERE provider_id = ? AND (user_id = ? OR user_id IS NULL) \
         ORDER BY created_at ASC",
    )
    .bind(provider_id)
    .bind(user_id)
    .fetch_all(pool)
    .await?;

    let kind = default_kind(provider_id);
    // The default is whatever the override table says, else System.
    let default_id = default_account_id(pool, provider_id, user_id)
        .await
        .unwrap_or_else(|| SYSTEM_ACCOUNT_ID.to_string());

    let mut out = Vec::with_capacity(rows.len() + 1);
    // Synthetic System account. Its friendly label is the signed-in email.
    let system_email = friendly_label(provider_id, None);
    out.push(AccountView {
        id: SYSTEM_ACCOUNT_ID.to_string(),
        provider_id: provider_id.to_string(),
        label: system_email.clone().unwrap_or_else(|| "System".to_string()),
        detail: system_email.as_ref().map(|_| "System".to_string()),
        kind: kind.as_str().to_string(),
        is_default: default_id == SYSTEM_ACCOUNT_ID,
        authenticated: matches!(kind, AccountKind::Cli)
            && cli_authenticated(provider_id, &fleetify_core::user_home()),
        system: true,
    });

    // Auto-detected sibling config dirs (e.g. ~/.claude-2, ~/.claude-3) the user
    // already created with CLAUDE_CONFIG_DIR. Not DB rows — id is `dir:<name>`.
    // The label is the dir's signed-in email; can be made default via override.
    for (name, dir, authed) in discovered_config_dirs(provider_id) {
        let id = format!("{DISCOVERED_PREFIX}{name}");
        let email = friendly_label(provider_id, Some(&dir));
        out.push(AccountView {
            is_default: default_id == id,
            id,
            provider_id: provider_id.to_string(),
            label: email.clone().unwrap_or_else(|| name.clone()),
            detail: Some(name),
            kind: kind.as_str().to_string(),
            authenticated: authed,
            system: false,
        });
    }

    for r in rows {
        let authenticated = match AccountKind::parse_kind(&r.kind) {
            AccountKind::Cli => r
                .home_dir
                .as_deref()
                .map(|h| cli_authenticated(provider_id, Path::new(h)))
                .unwrap_or(false),
            AccountKind::Http => false,
        };
        // For CLI accounts, prefer the signed-in email; keep the user's label as
        // the detail line so a renamed account still shows who it is.
        let email = match AccountKind::parse_kind(&r.kind) {
            AccountKind::Cli => r
                .home_dir
                .as_deref()
                .and_then(|h| friendly_label(provider_id, Some(Path::new(h)))),
            AccountKind::Http => None,
        };
        out.push(AccountView {
            is_default: default_id == r.id,
            label: email.clone().unwrap_or_else(|| r.label.clone()),
            detail: email.as_ref().map(|_| r.label.clone()),
            id: r.id,
            provider_id: r.provider_id,
            kind: r.kind,
            authenticated,
            system: false,
        });
    }
    Ok(out)
}

/// Create a new account row. For CLI accounts, also create the isolated HOME
/// dir so the login flow can write into it. Does NOT make it the default.
pub async fn create(
    pool: &SqlitePool,
    provider_id: &str,
    body: &AccountCreate,
    user_id: &str,
) -> Result<Account, AccountError> {
    let kind = body
        .kind
        .as_deref()
        .map(AccountKind::parse_kind)
        .unwrap_or_else(|| default_kind(provider_id));
    let id = uuid::Uuid::new_v4().to_string();
    let created_at = chrono::Utc::now().to_rfc3339();

    let home_dir = match kind {
        AccountKind::Cli => {
            let dir = account_home_dir(provider_id, &id);
            std::fs::create_dir_all(&dir)?;
            Some(dir.to_string_lossy().into_owned())
        }
        AccountKind::Http => None,
    };

    sqlx::query(
        "INSERT INTO accounts (id,user_id,provider_id,label,kind,home_dir,is_default,created_at) \
         VALUES (?,?,?,?,?,?,0,?)",
    )
    .bind(&id)
    .bind(user_id)
    .bind(provider_id)
    .bind(body.label.trim())
    .bind(kind.as_str())
    .bind(&home_dir)
    .bind(&created_at)
    .execute(pool)
    .await?;

    Ok(Account {
        id,
        user_id: Some(user_id.to_string()),
        provider_id: provider_id.to_string(),
        label: body.label.trim().to_string(),
        kind: kind.as_str().to_string(),
        home_dir,
        is_default: false,
        created_at,
    })
}

/// Rename an account. The System account cannot be renamed.
pub async fn rename(pool: &SqlitePool, account_id: &str, label: &str) -> Result<(), AccountError> {
    if is_system(Some(account_id)) {
        return Err(AccountError::SystemImmutable);
    }
    let res = sqlx::query("UPDATE accounts SET label = ? WHERE id = ?")
        .bind(label.trim())
        .bind(account_id)
        .execute(pool)
        .await?;
    if res.rows_affected() == 0 {
        return Err(AccountError::NotFound);
    }
    Ok(())
}

/// Count non-archived sessions still bound to an account.
async fn sessions_using(pool: &SqlitePool, account_id: &str) -> Result<usize, AccountError> {
    let n: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sessions WHERE account_id = ? AND archived_at IS NULL",
    )
    .bind(account_id)
    .fetch_one(pool)
    .await?;
    Ok(n as usize)
}

/// Delete an account. Refuses (`InUse`) when a live session references it
/// unless `force`, in which case those sessions fall back to System
/// (`account_id = NULL`). Removes the CLI home dir; the HTTP keychain entry is
/// cleared shell-side by the IPC caller.
pub async fn delete(pool: &SqlitePool, account_id: &str, force: bool) -> Result<(), AccountError> {
    if is_system(Some(account_id)) {
        return Err(AccountError::SystemImmutable);
    }
    let acc = get(pool, account_id).await?.ok_or(AccountError::NotFound)?;

    let in_use = sessions_using(pool, account_id).await?;
    if in_use > 0 {
        if !force {
            return Err(AccountError::InUse(in_use));
        }
        sqlx::query("UPDATE sessions SET account_id = NULL WHERE account_id = ?")
            .bind(account_id)
            .execute(pool)
            .await?;
    }

    sqlx::query("DELETE FROM accounts WHERE id = ?")
        .bind(account_id)
        .execute(pool)
        .await?;

    if let Some(home) = acc.home_dir.as_deref() {
        // Best-effort: a missing dir is fine; we never want delete to fail
        // because the isolated home was already gone.
        let _ = std::fs::remove_dir_all(home);
    }
    Ok(())
}

/// Make `account_id` the provider's default. Works for ANY account — System,
/// a discovered `dir:.claude-2`, or a managed uuid — by upserting the
/// per-provider override row (one per user+provider).
pub async fn set_default(
    pool: &SqlitePool,
    provider_id: &str,
    account_id: &str,
    user_id: &str,
) -> Result<(), AccountError> {
    sqlx::query(
        "INSERT INTO provider_default_account (user_id, provider_id, account_id) \
         VALUES (?, ?, ?) \
         ON CONFLICT(user_id, provider_id) DO UPDATE SET account_id = excluded.account_id",
    )
    .bind(user_id)
    .bind(provider_id)
    .bind(account_id)
    .execute(pool)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn account_env_relocates_home_and_xdg() {
        let home = PathBuf::from("/tmp/acct/abc");
        let env = account_env(&home);
        let map: std::collections::HashMap<_, _> = env.into_iter().collect();
        assert_eq!(map.get("HOME").unwrap(), "/tmp/acct/abc");
        assert_eq!(map.get("USERPROFILE").unwrap(), "/tmp/acct/abc");
        assert_eq!(map.get("XDG_CONFIG_HOME").unwrap(), "/tmp/acct/abc/.config");
        assert_eq!(
            map.get("XDG_DATA_HOME").unwrap(),
            "/tmp/acct/abc/.local/share"
        );
    }

    #[test]
    fn is_system_covers_null_and_sentinel() {
        assert!(is_system(None));
        assert!(is_system(Some("system")));
        assert!(is_system(Some("")));
        assert!(!is_system(Some("abc-123")));
    }

    #[test]
    fn default_kind_classifies_cli_vs_http() {
        assert_eq!(default_kind("claude-code"), AccountKind::Cli);
        assert_eq!(default_kind("openai"), AccountKind::Http);
        assert_eq!(default_kind("unknown-xyz"), AccountKind::Http);
    }

    #[test]
    fn config_dir_agents_use_native_env_var() {
        assert_eq!(
            config_dir_spec("claude-code"),
            Some(("CLAUDE_CONFIG_DIR", ".claude"))
        );
        assert_eq!(config_dir_spec("codex-cli"), Some(("CODEX_HOME", ".codex")));
        // Gemini/kimi/agy isolate via HOME, not a config-dir env var.
        assert!(config_dir_spec("gemini-cli").is_none());
        assert!(config_dir_spec("antigravity-cli").is_none());
    }

    /// The "set main account" + "no conversation lost" model: the account is
    /// PINNED at session creation (via `default_account_for`), and `resolve_env`
    /// stays static — a NULL/legacy session always resolves to System so its
    /// Claude conversation history (in the System config dir) keeps resuming.
    #[tokio::test]
    async fn null_account_follows_main_dynamically() {
        let pool = crate::db::init_pool("sqlite::memory:").await.unwrap();
        // A managed claude account pointing at a fake config dir.
        sqlx::query(
            "INSERT INTO accounts (id,user_id,provider_id,label,kind,home_dir,is_default,created_at) \
             VALUES ('acc1','u1','claude-code','Work','cli','/tmp/acc1',0,'2026-01-01T00:00:00Z')",
        )
        .execute(&pool)
        .await
        .unwrap();

        // No main set → NULL resolves to System (empty env).
        assert!(resolve_env(&pool, "claude-code", None, "u1")
            .await
            .is_empty());

        // Make acc1 the main account.
        set_default(&pool, "claude-code", "acc1", "u1")
            .await
            .unwrap();

        // NULL now follows the main dynamically → CLAUDE_CONFIG_DIR=/tmp/acc1,
        // so every un-pinned chat + Fleet uses the new account.
        assert_eq!(
            resolve_env(&pool, "claude-code", None, "u1").await,
            vec![("CLAUDE_CONFIG_DIR".to_string(), "/tmp/acc1".to_string())]
        );
        // Explicit System overrides the main (stays on System).
        assert!(resolve_env(&pool, "claude-code", Some("system"), "u1")
            .await
            .is_empty());
        // An explicit pinned account always wins.
        assert_eq!(
            resolve_env(&pool, "claude-code", Some("acc1"), "u1").await,
            vec![("CLAUDE_CONFIG_DIR".to_string(), "/tmp/acc1".to_string())]
        );
    }
}
