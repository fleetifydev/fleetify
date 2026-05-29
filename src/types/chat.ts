export interface TextBlock {
  type: "text";
  text: string;
}

export interface ThinkingBlock {
  type: "thinking";
  text: string;
  /** Wall-clock duration of the reasoning burst that produced this
   *  block — captured by ws-manager at flush time (first delta → flush).
   *  Lets the collapsed chip render `▸ Thought 12s` without needing a
   *  separate live timer once the block is finalized. */
  duration_ms?: number;
}

export interface ToolUseBlock {
  type: "tool_use";
  tool_id: string;
  tool_name: string;
  /** ACP tool kind for Gemini tools (read/edit/execute/search/fetch/move/delete/think/other).
   *  Absent for Claude tools — those route through tool_name-based icon mapping. */
  tool_kind?: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_id: string;
  output: string;
  is_error: boolean;
}

export interface DispatchResultBlock {
  type: "dispatch_result";
  agent_id: string;
  agent_name: string;
  task: string;
  success: boolean;
  summary: string;
  /** Absolute path of the target agent's working folder. Persisted by
   *  the backend so the DispatchResultCard can still render the folder
   *  on reload even after the session row is archived or evicted. */
  project_path?: string;
}

/** Inline permission card dispatched agents use to ask the user from the staff chat. */
export interface DispatchPermissionBlock {
  type: "dispatch_permission";
  request_id: string;
  agent_id: string;
  agent_name: string;
  tool_name: string;
  command: string;
  status: "pending" | "approved" | "denied" | "expired";
}

export interface ImageBlock {
  type: "image";
  media_type: string;
  data: string;       // base64
  preview?: string;   // data URL for display
  name?: string;
}

/** Proactive report from a dispatched agent back to the Fleet chat. */
export interface AgentReportBlock {
  type: "agent_report";
  agent_id: string;
  agent_name: string;
  message: string;
  level: "info" | "warn" | "error";
}

/** Shown immediately after dispatch, before the result comes back. */
export interface DispatchPendingBlock {
  type: "dispatch_pending";
  agent_id: string;
  agent_name: string;
  task: string;
}

/** Named output produced by an agent — file, report, code, data, or image. */
export interface ArtifactBlock {
  type: "artifact";
  artifact_id: string;
  artifact_type: "code" | "file" | "data" | "report" | "image";
  name: string;           // filename or title
  content: string;        // the actual content
  language?: string;      // for code artifacts: "python", "typescript", etc.
  size_bytes?: number;
  created_by?: string;    // agent_id that created it
  agent_name?: string;
}

/** Staff-message card produced by an in-app slash command (/skills,
 *  /hooks, /commands, /prompts, /usage, /mcp, /init, /effort,
 *  /permissions). These never round-trip through the underlying CLI —
 *  the data is fetched from Fleetify's own API and the message is
 *  pushed straight into the local chat-store transcript so the user
 *  has a visible record of what they ran. `data` shape is owned by
 *  the renderer for each card_kind. */
export interface ResourceCardBlock {
  type: "resource_card";
  card_kind:
    | "skills" | "hooks" | "commands" | "prompts"
    | "usage" | "mcp"
    | "init_pending" | "init_done" | "info";
  data: unknown;
}

/** Web citation / search result block — emitted by search-grounded
 *  providers (Perplexity Sonar). Collected during streaming and
 *  rendered as a CitationCard underneath the assistant bubble. The
 *  block carries the full list rather than one entry per block so the
 *  card renders as a single cohesive footer instead of N stacked
 *  pills. */
export interface CitationBlock {
  type: "citations";
  items: Array<{
    url: string;
    title?: string;
    snippet?: string;
    date?: string;
    /** "citation" | "search_result" — drives which icon the card uses. */
    kind: "citation" | "search_result";
  }>;
}

/**
 * Surfaces when a bridge needs the user to complete external
 * sign-in before producing a reply. Backend opens the OS browser
 * to `url` and flips `opened_in_browser` to true on success; the
 * renderer's auth-required info card uses that flag to decide
 * whether to show "Open sign-in" as the primary CTA or as a
 * de-emphasised "Re-open sign-in" link.
 */
export interface AuthRequiredBlock {
  type: "auth_required";
  provider: string;
  url: string;
  opened_in_browser: boolean;
  /** Session this sign-in belongs to. Stamped by `pushChatAuthRequired`
   *  so the card can route a pasted OOB auth code back to the right live
   *  bridge via `wsManager.sendAuthCode`. */
  session_id?: string;
  /** Flipped true once the sign-in completes — set by `markAuthSignedIn`
   *  when the bridge delivers a reply for this session. The card then
   *  swaps its "Signing in…" / "Code sent" state for a success line. */
  signed_in?: boolean;
}

export type ContentBlock =
  | TextBlock
  | ThinkingBlock
  | ToolUseBlock
  | ToolResultBlock
  | DispatchResultBlock
  | DispatchPermissionBlock
  | ImageBlock
  | AgentReportBlock
  | DispatchPendingBlock
  | ArtifactBlock
  | ResourceCardBlock
  | CitationBlock
  | AuthRequiredBlock;

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: ContentBlock[];
  model?: string;
  cost_usd?: number;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_tokens?: number; cache_write_tokens?: number };
  duration_ms?: number;
  timestamp: string;
}

// WebSocket message types
export interface WSInitMessage {
  type: "init";
  session_id: string;
  model?: string;
}

export interface WSMessageDelta {
  type: "message_delta";
  delta: { type: "text"; text: string };
  /** When set, this delta belongs to a dispatched sub-agent and should
   *  be appended to that sub-agent's streaming buffer instead of the
   *  parent session. None / absent → parent session (default). */
  parent_task_id?: string | null;
}

export interface WSThinking {
  type: "thinking";
  text: string;
  parent_task_id?: string | null;
}

export interface WSToolStart {
  type: "tool_start";
  tool_id: string;
  name: string;
  tool_kind?: string;
  input: Record<string, unknown>;
  parent_task_id?: string | null;
}

export interface WSToolUpdate {
  type: "tool_update";
  tool_id: string;
  input: Record<string, unknown>;
  parent_task_id?: string | null;
}

export interface WSToolEnd {
  type: "tool_end";
  tool_id: string;
  output: string;
  is_error: boolean;
  parent_task_id?: string | null;
}

/** Sub-agent dispatched — bridge maps the SDK's TaskStartedMessage to
 *  this event so the frontend can spin up a Tasks card + Agent pane
 *  the moment dispatch begins. */
export interface WSSubagentStart {
  type: "subagent_start";
  task_id: string;
  /** The parent's tool_use.id that triggered this dispatch. Lets the
   *  chat "Ran agent X" inline row link to the right pane. */
  tool_use_id: string | null;
  description: string;
  task_type: string | null;
}

/** Live progress beat from the SDK's TaskProgressMessage — fires every
 *  few seconds while the sub-agent runs. Carries the cumulative usage
 *  totals so the card metadata can update without re-aggregating. */
export interface WSSubagentProgress {
  type: "subagent_progress";
  task_id: string;
  description: string;
  total_tokens: number;
  tool_uses: number;
  duration_ms: number;
  last_tool_name: string | null;
}

/** Terminal event from TaskNotificationMessage. status is the SDK's
 *  enum: completed | failed | stopped. usage is null for stopped or
 *  errored tasks that didn't report finals. */
export interface WSSubagentEnd {
  type: "subagent_end";
  task_id: string;
  status: "completed" | "failed" | "stopped";
  summary: string | null;
  total_tokens: number | null;
  tool_uses: number | null;
  duration_ms: number | null;
}

export interface WSCost {
  type: "cost";
  usage: Record<string, number>;
  cost_usd: number;
  /** Optional model name — backend includes when known so the
   *  frontend can show "claude-sonnet-4-6" on the message. */
  model?: string;
}

export interface WSStatus {
  type: "status";
  status: string;
}

export interface WSError {
  type: "error";
  error: string;
}

export interface WSAuthRequired {
  type: "auth_required";
  provider: string;
  url: string;
  opened_in_browser: boolean;
}

export interface WSDispatchAck {
  type: "dispatch_ack";
  target_id: string;
  task: string;
  success: boolean;
  message: string;
}

export interface WSDispatchResult {
  type: "dispatch_result";
  target_id: string;
  /** Target agent's title (was looked up via app-store on the live event;
   *  backend now includes it so the card renders correctly even before
   *  the sessions list has hydrated). */
  target_name?: string;
  /** Absolute path of the target agent's working folder. */
  project_path?: string;
  task: string;
  success: boolean;
  summary: string;
  artifacts?: Array<{
    artifact_id: string;
    artifact_type: "code" | "file" | "data" | "report" | "image";
    name: string;
    content: string;
    language?: string;
    size_bytes?: number;
    created_by?: string;
    agent_name?: string;
  }>;
}

export interface WSDispatchIncoming {
  type: "dispatch_incoming";
  text: string;
  timestamp?: string;
}

/** Live mirror of a target agent's stream while a dispatch is in flight.
 *  Backend filters to the high-signal event kinds — text/thinking deltas,
 *  tool starts/ends, errors — so the staff chat can render a glance
 *  preview under the dispatch_pending card without leaving the Fleet view. */
export interface WSDispatchStream {
  type: "dispatch_stream";
  target_id: string;
  kind: "message_delta" | "thinking" | "tool_start" | "tool_end" | "error";
  text?: string;
  tool_name?: string;
  tool_id?: string;
  is_error?: boolean;
  error?: string;
}

/** Lifecycle status update from the backend dispatch handler. Fires on
 *  three transitions:
 *    "received"  — task accepted, target was already idle/running
 *    "starting"  — target was stopped/error/idle, auto-waking up
 *    "running"   — bridge yielded its first stream event
 *  The pending card reads `phase` to render a status badge so the
 *  user can tell which stage the dispatch is in instead of staring at
 *  a silent spinner during the 2-5s bridge boot window. */
export interface WSDispatchProgress {
  type: "dispatch_progress";
  target_id: string;
  agent_name: string;
  phase: "received" | "starting" | "running";
  /** True when the backend had to auto-wake a stopped/error agent. */
  auto_woken?: boolean;
}

export interface WSPermissionRequest {
  type: "tool_permission_request";
  id: string;
  tool_name: string;
  tool_description?: string;
  command: string;
}

/** Emitted by the agentic loop's permission gate when the session's mode
 *  flags a tool as Ask. Distinct event type from `tool_permission_request`
 *  (the CLI-MCP flow) so the renderer can keep the two surfaces apart,
 *  even though both feed into the same store entry + dialog component. */
export interface WSAgenticPermissionRequest {
  type: "permission_request";
  id: string;
  tool_name: string;
  input: Record<string, unknown>;
}

export interface WSDispatchPermissionRequest {
  type: "dispatch_permission_request";
  request_id: string;
  agent_id: string;
  agent_name: string;
  tool_name: string;
  command: string;
}

export interface WSDispatchPermissionResolved {
  type: "dispatch_permission_resolved";
  request_id: string;
  approved: boolean;
}

export interface WSAgentReport {
  type: "agent_report";
  agent_id: string;
  agent_name: string;
  message: string;
  level: "info" | "warn" | "error";
}

export interface WSAgentStopped {
  type: "agent_stopped";
  target_id: string;
  name: string;
}

export interface WSAgentRestarted {
  type: "agent_restarted";
  target_id: string;
  name: string;
}

/** Backend → frontend "enhance_done" event. Fired by the
 *  prompt-enhance flow (wand button) instead of persisting an
 *  assistant chat message. The text field IS the rewrite the
 *  chat-input should adopt. ws-manager catches this and resolves
 *  its pending enhance promise. */
export interface WSEnhanceDone {
  type: "enhance_done";
  text: string;
}

/** Fired when a /compact (claude+codex) or /compress (gemini) flow
 *  enters the running phase. The frontend uses it to insert an
 *  inline "Compacting…" / "Compressing…" status pill (role=system,
 *  type=compaction_status) and lock the input.
 *  `command` is the actual provider command that was sent so the
 *  UI label can mention "/compact" or "/compress" if it wants to. */
export interface WSCompactionStatus {
  type: "compaction_status";
  state: "starting";
  provider: string;
  command: string;
}

/** Fired when the app-owned compactor finishes. `pre_chars`/`post_chars`
 *  measure transcript size before/after summarisation (the prior token-
 *  based metric was Claude-only; switching to char counts gives every
 *  provider a comparable number). `pre_message_count` is the row count
 *  the compactor hard-deleted. `compact_at` is the ISO timestamp the
 *  backend stamped on the session row — the frontend uses it to drop
 *  pre-compact messages from the local store in lockstep with the
 *  server. `error` is non-null when the summariser model failed; the
 *  inline status flips to "Compact failed" and the message hard-delete
 *  is skipped. */
/** Web citation emitted by search-grounded providers (Perplexity Sonar).
 *  ws-manager buffers these during streaming and pushes a single
 *  CitationBlock onto the assistant message when the stream finalizes. */
export interface WSCitation {
  type: "citation";
  url: string;
  title?: string | null;
  snippet?: string | null;
}

/** Richer search-result row from Perplexity's `search_results` field. */
export interface WSSearchResult {
  type: "search_result";
  url: string;
  title: string;
  snippet?: string | null;
  date?: string | null;
}

export interface WSCompactionDone {
  type: "compaction_done";
  provider: string;
  pre_chars: number | null;
  post_chars: number | null;
  pre_message_count: number | null;
  compact_at: string | null;
  model: string | null;
  trigger: string;
  /** The generated summary text. Persisted as an assistant message on
   *  the backend (tagged with `[fleet:compact-summary]`) and echoed here
   *  so the frontend can render the "Conversation summary" card without
   *  a follow-up fetch. */
  summary?: string | null;
  /** ID of the persisted summary message row — matches what the backend
   *  wrote to the DB, so reloads agree with the live state. */
  summary_message_id?: string | null;
  /** ISO timestamp the summary message was stamped at. Always slightly
   *  after `compact_at` (by ~1ms) so the chat sorts as /compact then
   *  summary on reload. */
  summary_at?: string | null;
  error?: string | null;
}

export type WSServerMessage =
  | WSInitMessage
  | WSMessageDelta
  | WSThinking
  | WSToolStart
  | WSToolUpdate
  | WSToolEnd
  | WSSubagentStart
  | WSSubagentProgress
  | WSSubagentEnd
  | WSCost
  | WSStatus
  | WSError
  | WSDispatchAck
  | WSDispatchResult
  | WSDispatchIncoming
  | WSDispatchStream
  | WSDispatchProgress
  | WSPermissionRequest
  | WSAgenticPermissionRequest
  | WSDispatchPermissionRequest
  | WSDispatchPermissionResolved
  | WSAgentReport
  | WSAgentStopped
  | WSAgentRestarted
  | WSEnhanceDone
  | WSCompactionStatus
  | WSCompactionDone
  | WSCitation
  | WSSearchResult
  | WSAuthRequired;
