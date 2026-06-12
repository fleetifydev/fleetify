-- Provider-id rename: the Claude Code CLI's provider id changed from
-- "claude" to "claude-code" (display name was already "Claude Code"). The
-- CLI *binary* is unchanged (still `claude` — the @anthropic-ai/claude-code
-- npm package installs it under that name); this only touches the id used
-- for routing, account scoping, and the UI.
--
-- Migrate persisted state so sessions/pins/routing/accounts created before
-- the rename keep resolving. Read-time canonicalisation in
-- providers::helpers::canonical_provider_id + the dual-accept match arms in
-- accounts.rs / routing/persist.rs are the belt-and-braces for any row this
-- misses (or external callers that still send "claude").

UPDATE sessions          SET tool         = 'claude-code' WHERE tool         = 'claude';
UPDATE sessions          SET pinned_agent = 'claude-code' WHERE pinned_agent = 'claude';
UPDATE routing_decisions SET agent        = 'claude-code' WHERE agent        = 'claude';
UPDATE accounts          SET provider_id  = 'claude-code' WHERE provider_id  = 'claude';
