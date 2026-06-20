-- Provider-id rename: the Grok Build CLI agent moves from the placeholder
-- `grok-cli` id to `grok-build`, matching xAI's own product id (the docs scope
-- is `grok-build`) and the catalog `display_name` "Grok Build". Mirrors the
-- round-2 CLI-suffix rename (migration 0009) and the earlier `claude` ->
-- `claude-code` rename (0007).
--
-- The CLI *binary* is unchanged (`grok`, catalog `bin`) and the shared xAI
-- keyring entry stays `grok`; this only touches the routing id used by sessions,
-- accounts, and the UI. Clean break: every source (this DB, the marketplace, the
-- model catalog, and all code paths) now uses `grok-build`, so there is no
-- read-time canonicalisation shim — this migration is the single mechanism that
-- moves persisted rows forward.

-- sessions.tool
UPDATE sessions          SET tool         = 'grok-build' WHERE tool         = 'grok-cli';

-- sessions.pinned_agent
UPDATE sessions          SET pinned_agent = 'grok-build' WHERE pinned_agent = 'grok-cli';

-- routing_decisions.agent (Grok Build is a manual-only CLI agent that is never
-- auto-routed, so this is defensive — it keeps any historical row resolving.)
UPDATE routing_decisions SET agent        = 'grok-build' WHERE agent        = 'grok-cli';

-- accounts.provider_id
UPDATE accounts          SET provider_id  = 'grok-build' WHERE provider_id  = 'grok-cli';
