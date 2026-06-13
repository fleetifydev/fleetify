-- Provider-id rename, round 2: the remaining CLI agents get explicit
-- `-cli` / `-agent` suffixed ids, mirroring the earlier `claude` -> `claude-code`
-- rename (migration 0007).
--   gemini -> gemini-cli
--   codex  -> codex-cli
--   cursor -> cursor-cli
--   hermes -> hermes-agent
--   agy    -> antigravity-cli
--   kimi   -> kimi-code
--
-- The CLI *binaries* are unchanged (catalog `bin`); this only touches the id
-- used for routing, account scoping, and the UI. This is a clean break: every
-- source (this DB, the marketplace, the model catalog, and all code paths) uses
-- the new id, so there is no read-time canonicalisation shim — this migration is
-- the single mechanism that moves persisted rows forward.

-- sessions.tool
UPDATE sessions          SET tool        = 'gemini-cli'      WHERE tool        = 'gemini';
UPDATE sessions          SET tool        = 'codex-cli'       WHERE tool        = 'codex';
UPDATE sessions          SET tool        = 'cursor-cli'      WHERE tool        = 'cursor';
UPDATE sessions          SET tool        = 'hermes-agent'    WHERE tool        = 'hermes';
UPDATE sessions          SET tool        = 'antigravity-cli' WHERE tool        = 'agy';
UPDATE sessions          SET tool        = 'kimi-code'       WHERE tool        = 'kimi';

-- sessions.pinned_agent
UPDATE sessions          SET pinned_agent = 'gemini-cli'      WHERE pinned_agent = 'gemini';
UPDATE sessions          SET pinned_agent = 'codex-cli'       WHERE pinned_agent = 'codex';
UPDATE sessions          SET pinned_agent = 'cursor-cli'      WHERE pinned_agent = 'cursor';
UPDATE sessions          SET pinned_agent = 'hermes-agent'    WHERE pinned_agent = 'hermes';
UPDATE sessions          SET pinned_agent = 'antigravity-cli' WHERE pinned_agent = 'agy';
UPDATE sessions          SET pinned_agent = 'kimi-code'       WHERE pinned_agent = 'kimi';

-- routing_decisions.agent (cursor/hermes are manual-only and never auto-routed,
-- but codex/gemini/agy historical rows must keep resolving)
UPDATE routing_decisions SET agent        = 'gemini-cli'      WHERE agent        = 'gemini';
UPDATE routing_decisions SET agent        = 'codex-cli'       WHERE agent        = 'codex';
UPDATE routing_decisions SET agent        = 'antigravity-cli' WHERE agent        = 'agy';
UPDATE routing_decisions SET agent        = 'kimi-code'       WHERE agent        = 'kimi';

-- accounts.provider_id
UPDATE accounts          SET provider_id  = 'gemini-cli'      WHERE provider_id  = 'gemini';
UPDATE accounts          SET provider_id  = 'codex-cli'       WHERE provider_id  = 'codex';
UPDATE accounts          SET provider_id  = 'cursor-cli'      WHERE provider_id  = 'cursor';
UPDATE accounts          SET provider_id  = 'hermes-agent'    WHERE provider_id  = 'hermes';
UPDATE accounts          SET provider_id  = 'antigravity-cli' WHERE provider_id  = 'agy';
UPDATE accounts          SET provider_id  = 'kimi-code'       WHERE provider_id  = 'kimi';
