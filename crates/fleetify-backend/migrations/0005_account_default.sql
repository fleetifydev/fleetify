-- Per-provider default account override. Unlike accounts.is_default (which can
-- only mark a managed DB row), this can point at ANY account id — the synthetic
-- "system", a discovered "dir:.claude-2", or a managed uuid — so the user can
-- make an auto-detected config dir their main account. One row per
-- (user_id, provider_id); absent ⇒ the System account is default.
CREATE TABLE provider_default_account (
    user_id     TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    account_id  TEXT NOT NULL,
    PRIMARY KEY (user_id, provider_id)
);
