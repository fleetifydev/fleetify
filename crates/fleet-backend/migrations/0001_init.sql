-- Faithful reproduction of the original SQLModel schema
-- (backend/app/models/*.py + database.py). Booleans = INTEGER 0/1,
-- datetimes = TEXT (RFC3339 UTC), server_default=func.now() ->
-- DEFAULT (CURRENT_TIMESTAMP).

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL,
  project_path TEXT NOT NULL DEFAULT '',
  group_path TEXT NOT NULL DEFAULT '',
  tool TEXT NOT NULL,
  command TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'stopped',
  parent_id TEXT,
  worktree_path TEXT,
  worktree_branch TEXT,
  use_worktree INTEGER NOT NULL DEFAULT 1,
  claude_session_id TEXT,
  model_name TEXT,
  permission_mode TEXT NOT NULL DEFAULT 'default',
  session_mode TEXT NOT NULL DEFAULT 'new',
  effort TEXT,
  user_id TEXT,
  pinned INTEGER NOT NULL DEFAULT 0,
  order_idx INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_accessed TEXT,
  notes TEXT,
  archived_at TEXT,
  budget_limit REAL,
  budget_used REAL NOT NULL DEFAULT 0.0,
  agent_template TEXT,
  compact_summary TEXT,
  compact_at TEXT,
  compacted_message_count INTEGER
);
CREATE INDEX IF NOT EXISTS ix_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS ix_sessions_user_archived ON sessions(user_id, archived_at);

CREATE TABLE IF NOT EXISTS groups (
  path TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  parent_path TEXT,
  order_idx INTEGER NOT NULL DEFAULT 0,
  default_path TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  model TEXT,
  usage_json TEXT,
  cost_usd REAL NOT NULL DEFAULT 0.0,
  timestamp TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_messages_session_id ON messages(session_id);
CREATE INDEX IF NOT EXISTS ix_messages_session_ts ON messages(session_id, timestamp);

CREATE TABLE IF NOT EXISTS cost_events (
  id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read INTEGER NOT NULL DEFAULT 0,
  cache_write INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0.0,
  timestamp TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_cost_events_session_id ON cost_events(session_id);

CREATE TABLE IF NOT EXISTS session_activity (
  id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  project_path TEXT,
  kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  payload_json TEXT,
  ts TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_session_activity_session_id ON session_activity(session_id);
CREATE INDEX IF NOT EXISTS ix_session_activity_project_path ON session_activity(project_path);
CREATE INDEX IF NOT EXISTS ix_session_activity_kind ON session_activity(kind);
CREATE INDEX IF NOT EXISTS ix_session_activity_ts ON session_activity(ts);
CREATE INDEX IF NOT EXISTS ix_activity_session_ts ON session_activity(session_id, ts);

CREATE TABLE IF NOT EXISTS session_memory (
  id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  project_path TEXT,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'note',
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL DEFAULT 'user'
);
CREATE INDEX IF NOT EXISTS ix_session_memory_session_id ON session_memory(session_id);
CREATE INDEX IF NOT EXISTS ix_session_memory_project_path ON session_memory(project_path);
CREATE INDEX IF NOT EXISTS ix_session_memory_kind ON session_memory(kind);
CREATE INDEX IF NOT EXISTS ix_session_memory_created_at ON session_memory(created_at);
CREATE INDEX IF NOT EXISTS ix_memory_session_created ON session_memory(session_id, created_at);
CREATE INDEX IF NOT EXISTS ix_memory_project_created ON session_memory(project_path, created_at);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT,
  email TEXT,
  external_sub TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ix_users_email ON users(email);
CREATE UNIQUE INDEX IF NOT EXISTS ix_users_external_sub ON users(external_sub);

CREATE TABLE IF NOT EXISTS marketplace_sources (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  description TEXT,
  repo_url TEXT NOT NULL,
  is_official INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  added_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  CONSTRAINT uq_msrc_user_url UNIQUE (user_id, repo_url)
);
CREATE INDEX IF NOT EXISTS ix_marketplace_sources_user_id ON marketplace_sources(user_id);

CREATE TABLE IF NOT EXISTS plugin_installs (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  source_id TEXT NOT NULL REFERENCES marketplace_sources(id),
  plugin_name TEXT NOT NULL,
  version TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  install_path TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  auto_update INTEGER NOT NULL DEFAULT 0,
  master_enabled INTEGER NOT NULL DEFAULT 1,
  installed_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  last_updated_at TEXT,
  CONSTRAINT uq_pi_user_name UNIQUE (user_id, plugin_name)
);
CREATE INDEX IF NOT EXISTS ix_plugin_installs_user_id ON plugin_installs(user_id);

CREATE TABLE IF NOT EXISTS plugin_enablements (
  id TEXT PRIMARY KEY NOT NULL,
  install_id TEXT NOT NULL REFERENCES plugin_installs(id) ON DELETE CASCADE,
  scope_type TEXT NOT NULL,
  scope_id TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  CONSTRAINT uq_pe_install_scope UNIQUE (install_id, scope_type, scope_id)
);
CREATE INDEX IF NOT EXISTS ix_plugin_enablements_install_id ON plugin_enablements(install_id);
