-- Phase 3 foundation: OS-sandbox axis and per-tool allow/deny matrix.
-- Both columns are nullable TEXT; no consumer yet — additive only.
ALTER TABLE sessions ADD COLUMN sandbox TEXT;
ALTER TABLE sessions ADD COLUMN tool_overrides TEXT;
