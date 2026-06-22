-- USER-scoped personal memory — what Fleet knows about the user across ALL
-- projects/sessions: preferences, stack, goals, working style, interests,
-- life context, ongoing threads. Distinct from `session_memory` (which is
-- per-project, dev-oriented). No FK on user_id (repo convention — sessions
-- and accounts also avoid it so no-auth / multi-tenant rows stay flexible).
CREATE TABLE IF NOT EXISTS user_memory (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'fact',          -- see USER_MEMORY_KINDS
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  importance INTEGER NOT NULL DEFAULT 3,       -- 1..5, drives retrieval order
  source TEXT NOT NULL DEFAULT 'explicit',     -- 'explicit' | 'auto'
  created_at TEXT NOT NULL,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_user_memory_user_id ON user_memory(user_id);
CREATE INDEX IF NOT EXISTS ix_user_memory_user_imp ON user_memory(user_id, importance, created_at);
CREATE INDEX IF NOT EXISTS ix_user_memory_kind ON user_memory(kind);
