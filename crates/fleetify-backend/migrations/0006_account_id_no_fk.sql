-- 0004 added `sessions.account_id TEXT REFERENCES accounts(id)`, but
-- `account_id` holds SYNTHETIC resolver keys — the `"system"` sentinel and
-- discovered-config ids like `"dir:.claude-2"` — which are NOT rows in
-- `accounts`. With `foreign_keys=ON`, writing any of those (pinning an account,
-- or the session-default flow) hard-failed the INSERT/UPDATE with
-- "FOREIGN KEY constraint failed (787)", which the renderer swallowed as a
-- silent "nothing happens" on send. Recreate the column WITHOUT the FK so it's
-- a free-form resolver key. account_id is brand-new (this feature), so the few
-- existing values dropped here are non-load-bearing.
ALTER TABLE sessions DROP COLUMN account_id;
ALTER TABLE sessions ADD COLUMN account_id TEXT;
