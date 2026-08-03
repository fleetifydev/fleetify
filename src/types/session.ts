export type SessionStatus =
  | "running"
  | "waiting"
  | "idle"
  | "error"
  | "starting"
  | "stopped";

export type AgentTool =
  // ── "Auto" routing sentinel ──
  // Not a real agent. When a session's tool/model is "auto", the dispatch
  // layer routes to the best (provider, model) per turn via the router
  // (Not Diamond, or the offline built-in router as fallback). The renderer
  // surfaces it as a neutral "Auto" chip — never dispatched as a literal agent.
  | "auto"
  | "claude-code"
  | "codex-cli"
  | "aider"
  | "opencode"
  | "cursor-cli"
  | "custom"
  // ── Cloud HTTP providers from the registry (Settings → Models) ──
  // These map to the same `session.tool` column the CLI agents use;
  // chat.rs's dispatch keys off the bare string so the backend doesn't
  // need to know about the union — only the renderer does.
  | "openai"
  | "deepseek"
  | "grok"
  | "nvidia-nim"
  | "kimi-api"
  | "gemini-api"
  | "perplexity"
  | "openrouter"
  | "ollama"
  | "ollama-cloud"
  | "kimi-code";

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
  /** Which provider/agent account drives this session (null ⇒ System). */
  account_id?: string | null;
  /** Provenance. null/undefined ⇒ a normal Fleetify-created session.
   *  'claude-bg' ⇒ auto-surfaced from a backgrounded Claude Code CLI
   *  session (`/background`) by the backend poller. The Fleet panel
   *  badges these so the user knows the row mirrors an external CLI run. */
  origin?: string | null;
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
  effort?: "low" | "medium" | "high" | "extra_high" | "max" | "ultra_code";
  sandbox?: string | null;
  tool_overrides?: string | null;
  /** Renderer-only flag: this session was created client-side by
   *  `beginDraft` and has no backend row yet. `commitDraft` swaps it
   *  out for a server-issued Session (which never carries this flag)
   *  the moment the user fires the first message. The backend never
   *  sees this field — SessionCreate doesn't model it, so extra keys
   *  get dropped silently. Every code path that touches the backend
   *  (WS subscribe, /detail polling, history fetch, infinite scroll)
   *  must early-out when `local_only` is true. */
  local_only?: boolean;
  /** Renderer-only: a git URL the user picked via the Git source
   *  picker but hasn't cloned yet. `commitComposer` clones it and
   *  drops this field before the session lands in the backend; never
   *  shipped over the wire. Co-exists with `project_path`: the chip
   *  prefers this URL while the clone is deferred. */
  pending_clone_url?: string | null;
  /** Renderer-only: branch picked for the pending clone (ls-remote fed).
   *  Consumed by `commitComposer` (clone `--branch` when worktree is off,
   *  `base_branch` on createSession when it's on); never persisted. */
  pending_clone_branch?: string | null;
}

export interface Group {
  path: string;
  name: string;
  parent_path: string | null;
  order_idx: number;
  default_path: string | null;
}
