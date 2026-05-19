export type SessionStatus =
  | "running"
  | "waiting"
  | "idle"
  | "error"
  | "starting"
  | "stopped";

export type AgentTool =
  | "claude"
  | "gemini"
  | "codex"
  | "aider"
  | "opencode"
  | "custom";

export interface Session {
  id: string;
  title: string;
  project_path: string;
  group_path: string;
  tool: AgentTool;
  command: string;
  status: SessionStatus;
  pinned: boolean;
  parent_id: string | null;
  worktree_path: string | null;
  worktree_branch: string | null;
  claude_session_id: string | null;
  model_name: string | null;
  permission_mode: string;
  session_mode: string;
  order_idx: number;
  created_at: string;
  last_accessed: string | null;
  notes: string | null;
  archived_at?: string | null;
  budget_limit?: number | null;
  budget_used?: number;
  use_worktree?: boolean;
  /** Renderer-only flag: this session was created client-side by
   *  `beginDraft` and has no backend row yet. `commitDraft` swaps it
   *  out for a server-issued Session (which never carries this flag)
   *  the moment the user fires the first message. The backend never
   *  sees this field — SessionCreate doesn't model it, so extra keys
   *  get dropped silently. Every code path that touches the backend
   *  (WS subscribe, /detail polling, history fetch, infinite scroll)
   *  must early-out when `local_only` is true. */
  local_only?: boolean;
}

export interface Group {
  path: string;
  name: string;
  parent_path: string | null;
  order_idx: number;
  default_path: string | null;
}
