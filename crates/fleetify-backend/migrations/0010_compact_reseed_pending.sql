-- Transient flag set by the compactor after a /compact. When 1, the next
-- turn starts a FRESH provider session (claude_session_id is nulled in the
-- same transaction) seeded with the compact summary, then the flag is
-- cleared. This is what makes /compact actually free the model's context
-- for CLI providers (claude-code / codex-cli / gemini-cli, …) rather than
-- only shrinking Fleetify's mirror transcript. 0 = normal, 1 = reseed pending.
ALTER TABLE sessions ADD COLUMN compact_reseed_pending INTEGER NOT NULL DEFAULT 0;
