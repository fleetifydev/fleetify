-- Multiple accounts per provider/agent. Metadata only — secrets stay in
-- the OS keychain (HTTP providers, account field = this row's id) and CLI
-- credentials stay under each account's HOME dir
-- (fleetify_home()/accounts/<provider_id>/<account_id>/). The synthetic
-- "System" account (real HOME for CLI / legacy keychain-sub key for HTTP)
-- is NOT stored here; it is always synthesized by services::accounts::list.

CREATE TABLE accounts (
    id           TEXT PRIMARY KEY NOT NULL,
    user_id      TEXT,                       -- owner (OIDC sub); NULL = unclaimed/legacy
    provider_id  TEXT NOT NULL,              -- catalog spec.id (e.g. "openai", "claude", "agy")
    label        TEXT NOT NULL,              -- user-facing name ("Work", "Personal")
    kind         TEXT NOT NULL,              -- 'cli' | 'http'
    home_dir     TEXT,                       -- CLI: absolute fake HOME; HTTP: NULL
    is_default   INTEGER NOT NULL DEFAULT 0, -- at most one default per (user_id, provider_id)
    created_at   TEXT NOT NULL
);

CREATE INDEX idx_accounts_provider ON accounts(provider_id, user_id);

-- Session → account binding. NULL ⇒ the synthetic System account
-- (real HOME for CLI / legacy keychain-sub key for HTTP).
ALTER TABLE sessions ADD COLUMN account_id TEXT REFERENCES accounts(id);
