//! Multiple accounts per provider/agent. A row here is metadata only — the
//! secret never lives in the DB. For HTTP providers the API key sits in the
//! OS keychain keyed by this row's `id`; for CLI agents the credentials live
//! under `home_dir` (an isolated fake HOME the agent's own login flow wrote
//! into). The synthetic "System" account is NOT a row — it is synthesized at
//! list time and represents the real HOME / legacy keychain key.

use serde::{Deserialize, Serialize};

/// Reserved id for the synthetic System account (the user's pre-existing,
/// out-of-Fleetify login). Never inserted into the DB; resolution treats it —
/// and a NULL `session.account_id` — as "use the real HOME / legacy key".
pub const SYSTEM_ACCOUNT_ID: &str = "system";

/// HTTP providers store a labeled API key in the keychain; CLI agents store an
/// isolated HOME dir with the agent's own credential files.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AccountKind {
    /// CLI agent (claude, codex, gemini, …): isolated via a HOME override.
    Cli,
    /// HTTP provider (openai, deepseek, …): a labeled keychain API key.
    Http,
}

impl AccountKind {
    pub fn as_str(self) -> &'static str {
        match self {
            AccountKind::Cli => "cli",
            AccountKind::Http => "http",
        }
    }
    pub fn parse_kind(s: &str) -> Self {
        match s {
            "cli" => AccountKind::Cli,
            _ => AccountKind::Http,
        }
    }
}

/// `accounts` row.
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct Account {
    pub id: String,
    pub user_id: Option<String>,
    pub provider_id: String,
    pub label: String,
    /// "cli" | "http" (stored as TEXT; use [`AccountKind::parse_kind`]).
    pub kind: String,
    pub home_dir: Option<String>,
    pub is_default: bool,
    pub created_at: String,
}

/// A provider/agent account as surfaced to the renderer — includes the
/// synthetic System account and a live `authenticated` flag.
#[derive(Debug, Clone, Serialize)]
pub struct AccountView {
    pub id: String,
    pub provider_id: String,
    /// Friendly name — the account's email when readable (e.g. Claude's
    /// `oauthAccount.emailAddress`), else the user-given or directory label.
    pub label: String,
    /// Secondary line: the config-dir name, "System", or the user's custom
    /// label. `None` when there's nothing extra to show.
    pub detail: Option<String>,
    pub kind: String,
    pub is_default: bool,
    /// True when the account currently has usable credentials (CLI: auth
    /// indicators fire against its HOME; HTTP: a keychain key is present —
    /// resolved shell-side, so the backend reports CLI auth and leaves HTTP
    /// `authenticated` to the caller that can read the keychain).
    pub authenticated: bool,
    /// True for the synthetic System account, which can never be deleted.
    pub system: bool,
}

/// POST /api/providers/{id}/accounts body.
#[derive(Debug, Clone, Deserialize)]
pub struct AccountCreate {
    pub label: String,
    /// "cli" | "http". Inferred from the provider kind when omitted.
    #[serde(default)]
    pub kind: Option<String>,
}

/// PATCH /api/providers/{id}/accounts/{account_id} body.
#[derive(Debug, Clone, Deserialize, Default)]
pub struct AccountUpdate {
    pub label: Option<String>,
}
