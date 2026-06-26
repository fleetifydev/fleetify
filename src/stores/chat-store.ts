import { create } from "zustand";
import type { ChatMessage, ContentBlock } from "@/types/chat";

export interface PermissionRequest {
  id: string;
  tool_name: string;
  tool_description?: string;
  command: string;
  /** Wall-clock millis at which the request was registered. Captured
   *  ONCE in setPermissionRequest so any consumer rendering relative
   *  time ("3s ago", "1m ago") gets a stable origin. Without this,
   *  LivePulse synthesised `ts: Date.now()` on every recompute and
   *  the row's "now" label kept resetting, jumping it to the top of
   *  any time-sorted list. */
  requestedAt?: number;
}

/* ── Cursor blocking extension requests ──────────────────────────────────
 * Cursor's `cursor/ask_question` + `cursor/create_plan` ACP methods block
 * the agent until the user answers. The backend ships them as
 * `cursor_ask_question` / `cursor_create_plan` WS events (keyed by `id`),
 * the renderer shows a card, and `wsManager.sendQuestionResponse` /
 * `sendPlanResponse` round-trips the outcome back. Mirrors PermissionRequest.
 */
export interface CursorQuestionItem {
  id: string;
  prompt: string;
  options: { id: string; label: string }[];
  allowMultiple?: boolean;
}
export interface CursorQuestion {
  /** req_id the WS response must echo back. */
  id: string;
  title?: string;
  questions: CursorQuestionItem[];
}
export interface CursorPlanTodo {
  id: string;
  content: string;
  status: string;
}
export interface CursorPlanPhase {
  name: string;
  todos: CursorPlanTodo[];
}
export interface CursorPlan {
  /** req_id the WS response must echo back. */
  id: string;
  name?: string;
  overview?: string;
  /** Markdown plan body. */
  plan: string;
  todos: CursorPlanTodo[];
  phases: CursorPlanPhase[];
}

/* ── Claude AskUserQuestion ───────────────────────────────────────────────
 * Claude Code's built-in `AskUserQuestion` tool can't render headlessly, so
 * the backend routes it through the fleet_permission loopback and ships it as
 * an `ask_user_question` WS event. The renderer shows an interactive card and
 * `wsManager.sendAskQuestionResponse` round-trips the chosen labels back as
 * the tool result. Schema mirrors Claude Code's tool input verbatim. */
export interface AskQuestionOption {
  label: string;
  description?: string;
}
export interface AskQuestionItem {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: AskQuestionOption[];
}
export interface AskQuestion {
  /** req_id the WS response must echo back. */
  id: string;
  questions: AskQuestionItem[];
}

export interface ProcessEvent {
  id: string;
  tool_id: string;
  name: string;
  input: Record<string, unknown>;
  startedAt: number;
  endedAt: number | null;
  status: "running" | "completed" | "errored";
  output?: string;
}

/** A dispatched sub-agent's live state — one entry per sub-agent the
 *  parent has spawned (via Claude SDK's Task tool / equivalent on other
 *  providers). Populated from the SDK's first-class lifecycle messages
 *  (TaskStartedMessage → TaskProgressMessage → TaskNotificationMessage)
 *  so we get real per-sub-agent token/tool/duration counts straight
 *  from the source — no tool-name string matching, no aggregation of
 *  parent stats.
 *
 *  Sub-agents run in parallel and their events interleave on the
 *  same query() stream, distinguished by `task_id`. The map is keyed
 *  by task_id so concurrent runs each get their own row.
 */
export interface SubagentTask {
  /** Stable task identifier from TaskStartedMessage.task_id. */
  id: string;
  /** The tool_use.id in the parent's content that triggered this
   *  sub-agent. Lets us link the "Ran agent X" inline chat row to its
   *  side-panel detail view. Nullable because some legacy payloads
   *  may omit it. */
  toolUseId: string | null;
  /** Human-readable task title from TaskStartedMessage.description. */
  description: string;
  /** Agent type (general-purpose / code-reviewer / custom name).
   *  Used for the "Agent" badge on the card. */
  taskType: string | null;
  /** Lifecycle status. "running" until TaskNotificationMessage lands. */
  status: "running" | "completed" | "failed" | "stopped";
  /** Wall-clock millis of TaskStartedMessage receipt — anchors the
   *  live "elapsed" counter on the Running card before the first
   *  TaskProgressMessage arrives. */
  startedAt: number;
  /** Wall-clock millis of TaskNotificationMessage receipt. */
  endedAt: number | null;
  /** Live metrics from TaskProgressMessage.usage — overwritten on every
   *  progress event so the card stays in sync. Finalized by the usage
   *  field on TaskNotificationMessage when the task ends. */
  totalTokens: number;
  toolUses: number;
  durationMs: number;
  /** Name of the most recent tool the sub-agent invoked — drives the
   *  "Running <ToolName>" subtitle on the live card. From
   *  TaskProgressMessage.last_tool_name. */
  lastToolName: string | null;
  /** Final summary text the sub-agent returned. Populated from
   *  TaskNotificationMessage.summary. */
  summary: string | null;
  /** Inner activity log for this sub-agent — every tool_use /
   *  tool_result / text / thinking block from events carrying this
   *  task's parent_tool_use_id ends up here. Renders as the body of
   *  the Agent pane when this task is selected. */
  content: ContentBlock[];
  /** Live token-by-token text for the sub-agent's in-flight assistant
   *  turn. Flushed into `content` as a text block when the turn
   *  completes. Mirrors the session-level streamingText pattern. */
  streamingText: string;
  /** Live thinking deltas for the in-flight sub-agent turn. */
  streamingThinking: string;
  /** Tool calls currently mid-flight inside this sub-agent. */
  activeToolCalls: Record<string, { name: string; input: Record<string, unknown> }>;
}

/** Inline status pill for a running /compact (Claude+Codex) or /compress
 *  (Gemini) flow. The chat-view renders this between the messages list
 *  and the streaming preview while a compaction is in flight, and keeps
 *  the finalized "✓ Compacted: X → Y tokens" state visible until the next
 *  user message clears it (or until clearCompactionPill is called).
 *
 *  Token numbers stay null for Codex+Gemini by design — only Claude's
 *  compact_boundary event yields a structured pre_tokens value, and we'd
 *  rather show "✓ Compacted" than guess. */
export interface CompactionPill {
  state: "running" | "done" | "failed";
  /** Which provider is doing the compaction — kept for debug/telemetry
   *  even though the inline status text no longer branches on it. */
  provider: string;
  /** Provider command we actually sent (always "/compact" since the
   *  compactor became app-owned). */
  command: string;
  /** Character counts before/after summarisation. Replaces the legacy
   *  pre/postTokens fields — the app-owned compactor measures input
   *  size by char length, not by provider token usage. */
  preChars?: number | null;
  postChars?: number | null;
  preMessageCount?: number | null;
  /** Backend timestamp (ISO) when the compaction was committed. Used
   *  by ws-manager to drop pre-compact messages from the local store
   *  in sync with the server's hard-delete. */
  compactAt?: string | null;
  /** Model that produced the summary (e.g. "claude-haiku-4-5"). */
  model?: string | null;
  trigger?: string;
  /** Live 0–100 progress while state="running", driven by
   *  compaction_progress events. Undefined until the first event. */
  pct?: number;
  /** Current compaction phase ("prepare" | "summarize" | "persist"). */
  phase?: string;
  /** Wall-clock millis when the pill was inserted — anchors the
   *  relative "Compacting Ns" suffix on the inline status text. */
  startedAt: number;
  /** Wall-clock millis when compaction_done landed. Undefined while
   *  state="running". */
  endedAt?: number;
  /** Failure reason — only populated when state="failed". */
  error?: string;
}

export interface SessionChatState {
  messages: ChatMessage[];
  streamingText: string;
  streamingThinking: string;
  isStreaming: boolean;
  /** True once the SDK's init event arrives — false during cold-start subprocess spawn. */
  sdkReady: boolean;
  streamStartTime: number | null;
  activeToolCalls: Record<string, { name: string; input: Record<string, unknown> }>;
  contentSoFar: ContentBlock[];
  permissionRequest: PermissionRequest | null;
  /** Pending Cursor blocking extension requests (one of each at most). */
  cursorQuestion: CursorQuestion | null;
  cursorPlan: CursorPlan | null;
  /** Pending Claude AskUserQuestion card (at most one). */
  askQuestion: AskQuestion | null;
  processLog: ProcessEvent[];
  /** Map of dispatched sub-agents keyed by task_id. Backed by the
   *  Claude Agent SDK's TaskStartedMessage / TaskProgressMessage /
   *  TaskNotificationMessage lifecycle so every entry has real
   *  per-sub-agent metrics. */
  subagentTasks: Record<string, SubagentTask>;
  /** Which sub-agent the Agent pane is currently focused on. Null
   *  means "auto-pick the most recent" — set by user click on a
   *  Tasks card or on a "Ran agent X" chat row. */
  selectedSubagentTaskId: string | null;
  /** Inline compaction status pill — see CompactionPill. Non-null while
   *  a /compact or /compress flow is running or its result is still
   *  on-screen waiting to be cleared. */
  compactionPill: CompactionPill | null;
}

const emptySession = (): SessionChatState => ({
  messages: [],
  streamingText: "",
  streamingThinking: "",
  isStreaming: false,
  sdkReady: false,
  streamStartTime: null,
  activeToolCalls: {},
  contentSoFar: [],
  permissionRequest: null,
  cursorQuestion: null,
  cursorPlan: null,
  askQuestion: null,
  processLog: [],
  subagentTasks: {},
  selectedSubagentTaskId: null,
  compactionPill: null,
});

// Shared stable reference used by selectSession when the requested session
// hasn't been initialised yet. Returning a fresh object on every selector call
// causes React's useSyncExternalStore to loop ("Maximum update depth exceeded")
// because Zustand compares snapshots with Object.is. Keep this frozen so
// consumers can't accidentally mutate the shared instance.
const EMPTY_SESSION: SessionChatState = Object.freeze(emptySession()) as SessionChatState;

/** Live preview buffer for an in-flight dispatch — appended to as the
 *  target agent streams text/thinking deltas. Keyed by target session id
 *  globally (not per-session) since dispatch previews are always shown
 *  in the staff/control-center chat. Cleared when dispatch_result arrives. */
export interface DispatchPreview {
  text: string;
  thinking: string;
  lastTool: string | null;
  startedAt: number;
  updatedAt: number;
  errored: boolean;
  /** Lifecycle phase emitted by `dispatch_progress` events from the
   *  backend. Drives the status badge on the pending card so the user
   *  sees which stage the dispatch is in:
   *    "received" — task accepted, agent already idle/running
   *    "starting" — agent was stopped/error/idle, auto-waking up
   *    "running"  — bridge has yielded its first stream event
   *  Undefined until the backend emits the first dispatch_progress. */
  phase?: "received" | "starting" | "running";
  /** True when the backend had to auto-wake a stopped/error/idle agent
   *  to deliver this dispatch. Surfaced in the card so the user knows
   *  why the first 1-2s look quieter than usual. */
  autoWoken?: boolean;
}

interface ChatState {
  sessions: Record<string, SessionChatState>;
  /** Per-target dispatch live previews — see DispatchPreview. */
  dispatchPreviews: Record<string, DispatchPreview>;
  /** Per-session live model catalogs for agents that source their model
   *  list at runtime (OpenCode), keyed by session id. Populated by the
   *  ws-manager's `available_models_update` handler; consumed by the
   *  composer's model picker. Empty for static-catalog agents. */
  dynamicModels: Record<string, { models: { id: string; label: string }[]; current: string }>;
  /** Per-session runtime slash commands advertised by the agent (OpenCode),
   *  keyed by session id. Merged into the composer's slash menu. */
  dynamicCommands: Record<string, { name: string; description: string }[]>;

  ensureSession: (sessionId: string) => void;
  getSession: (sessionId: string) => SessionChatState;
  /** Drop ALL state for a session — messages, streaming flags, tool calls,
   *  process log, permission request. Called by app-store.removeSession
   *  when a session is archived/deleted, so a future re-creation of the
   *  same id starts clean instead of inheriting orphan state. */
  clearSession: (sessionId: string) => void;
  /** Reclaim renderer memory: empty the message arrays + stream scratch of
   *  every session whose id is NOT in `keepIds` and which is not currently
   *  streaming. chat-view re-fetches the last 50 messages from SQLite when the
   *  user returns to a session (chat-view.tsx:723), so this is lossless from
   *  the user's point of view. Sub-agent transcripts / process log / tool
   *  state are intentionally PRESERVED — they have no re-fetch path, so
   *  dropping them would lose data the user can't get back. */
  evictInactive: (keepIds: string[]) => void;
  /** Patch cost/usage/model onto the most-recent assistant message —
   *  used when a `cost` event arrives after `status:done` already
   *  finalized the content. Without this, cost is lost on that
   *  ordering. */
  attachCostToLastAssistant: (
    sessionId: string,
    costUsd?: number,
    usage?: Record<string, number>,
    model?: string,
  ) => void;
  appendDispatchPreview: (
    targetId: string,
    patch: Partial<Omit<DispatchPreview, "startedAt" | "updatedAt">>,
  ) => void;
  clearDispatchPreview: (targetId: string) => void;
  /** Replace a session's live model catalog (OpenCode). */
  setDynamicModels: (
    sessionId: string,
    models: { id: string; label: string }[],
    current: string,
  ) => void;
  /** Replace a session's runtime slash command list (OpenCode). */
  setDynamicCommands: (
    sessionId: string,
    commands: { name: string; description: string }[],
  ) => void;

  setMessages: (sessionId: string, messages: ChatMessage[]) => void;
  addMessage: (sessionId: string, message: ChatMessage) => void;
  removeMessage: (sessionId: string, messageId: string) => void;
  appendStreamingText: (sessionId: string, text: string) => void;
  /** Combined action — appends text to BOTH streamingText AND contentSoFar
   *  in a single immutable update. Used by ws-manager's flushDelta which
   *  was previously calling appendStreamingText + appendContentText
   *  back-to-back: each delta produced TWO patches of the giant
   *  `sessions` record, so every store subscriber rendered twice per
   *  16ms tick. This action collapses the two into one set(). */
  appendStreamAndContent: (sessionId: string, text: string) => void;
  setStreamingThinking: (sessionId: string, text: string) => void;
  /** Wipe the streaming-thinking buffer to empty. Used when a reasoning
   *  blob has been pushed to contentSoFar as a thinking block — the
   *  next tokens belong to a fresh reasoning item, not a continuation. */
  clearStreamingThinking: (sessionId: string) => void;
  setIsStreaming: (sessionId: string, streaming: boolean) => void;
  setSdkReady: (sessionId: string, ready: boolean) => void;
  addToolCall: (sessionId: string, toolId: string, name: string, input: Record<string, unknown>) => void;
  resolveToolCall: (sessionId: string, toolId: string) => void;
  appendContentText: (sessionId: string, text: string) => void;
  pushContentBlock: (sessionId: string, block: ContentBlock) => void;
  resetContent: (sessionId: string) => void;
  finalizeAssistantMessage: (
    sessionId: string,
    id: string,
    content: ContentBlock[],
    model?: string,
    costUsd?: number,
    usage?: ChatMessage["usage"],
  ) => void;
  clearStreaming: (sessionId: string) => void;
  clearAll: (sessionId: string) => void;
  setPermissionRequest: (sessionId: string, req: PermissionRequest | null) => void;
  setCursorQuestion: (sessionId: string, q: CursorQuestion | null) => void;
  setAskQuestion: (sessionId: string, q: AskQuestion | null) => void;
  setCursorPlan: (sessionId: string, p: CursorPlan | null) => void;

  /** Start the inline compaction pill — fired by ws-manager on the
   *  backend's `compaction_status` (state="starting") event. Sets the
   *  pill to running with a fresh startedAt anchor. */
  startCompactionPill: (
    sessionId: string,
    args: { provider: string; command: string },
  ) => void;
  /** Patch the running pill's live progress — fired by ws-manager on each
   *  `compaction_progress` event. No-op if no pill is running. */
  updateCompactionProgress: (
    sessionId: string,
    args: { pct: number; phase: string },
  ) => void;
  /** Patch the pill to its terminal state when `compaction_done` lands.
   *  The backend now drives the character counts + summary timestamp
   *  uniformly across providers, so all fields are present on every
   *  successful run. */
  finalizeCompactionPill: (
    sessionId: string,
    args: {
      preChars?: number | null;
      postChars?: number | null;
      preMessageCount?: number | null;
      compactAt?: string | null;
      model?: string | null;
      trigger?: string;
    },
  ) => void;
  /** Wipe the pill — called when the user sends a new message after a
   *  finished compaction, or on session reload. */
  clearCompactionPill: (sessionId: string) => void;
  /** Drop every message in this session whose timestamp is strictly
   *  before `cutoffMs`. Used by the compaction flow to mirror the
   *  backend's hard-delete of pre-compact messages — without this the
   *  scrollback would keep showing rows that no longer exist server-side. */
  dropMessagesBefore: (sessionId: string, cutoffMs: number) => void;

  pushProcessEvent: (sessionId: string, event: ProcessEvent) => void;
  updateProcessEvent: (sessionId: string, toolId: string, inputPatch: Record<string, unknown>) => void;
  completeProcessEvent: (sessionId: string, toolId: string, output: string, isError: boolean) => void;
  clearProcessLog: (sessionId: string) => void;

  resolveDispatchPermission: (sessionId: string, requestId: string, approved: boolean) => void;

  // ── Sub-agent lifecycle ───────────────────────────────────────────
  // Each action mutates ONE entry in session.subagentTasks. Keyed by
  // task_id so parallel sub-agents stay isolated. Designed so the
  // WS handler can call them 1:1 with backend events:
  //   subagent_start  → startSubagent
  //   subagent_progress → updateSubagentProgress
  //   subagent_end    → endSubagent
  //   tool_start (parent_task_id set) → addSubagentToolCall + pushSubagentContent
  //   tool_end   (parent_task_id set) → resolveSubagentToolCall + pushSubagentContent
  //   message_delta (parent_task_id set) → appendSubagentStreamingText
  //   thinking   (parent_task_id set) → appendSubagentStreamingThinking

  /** Register a freshly-dispatched sub-agent. Idempotent — re-calling
   *  with the same task_id is a no-op so a duplicate TaskStartedMessage
   *  (rare but possible on reconnect) won't clobber an in-flight task. */
  startSubagent: (
    sessionId: string,
    task: {
      id: string;
      toolUseId: string | null;
      description: string;
      taskType: string | null;
    },
  ) => void;
  /** Update live metrics from a TaskProgressMessage. */
  updateSubagentProgress: (
    sessionId: string,
    taskId: string,
    usage: { totalTokens: number; toolUses: number; durationMs: number },
    lastToolName: string | null,
  ) => void;
  /** Terminal event for a sub-agent — flips status + records the
   *  summary. usage may be null on stopped/failed tasks. */
  endSubagent: (
    sessionId: string,
    taskId: string,
    status: "completed" | "failed" | "stopped",
    summary: string | null,
    usage: { totalTokens: number; toolUses: number; durationMs: number } | null,
  ) => void;
  /** Append a parsed content block (tool_use / tool_result / text /
   *  thinking) to the sub-agent's activity log. */
  pushSubagentContent: (
    sessionId: string,
    taskId: string,
    block: ContentBlock,
  ) => void;
  /** Stream a text delta into the sub-agent's live buffer. */
  appendSubagentStreamingText: (
    sessionId: string,
    taskId: string,
    text: string,
  ) => void;
  /** Stream a thinking delta into the sub-agent's live buffer. */
  appendSubagentStreamingThinking: (
    sessionId: string,
    taskId: string,
    text: string,
  ) => void;
  /** Register an in-flight tool call inside a sub-agent. */
  addSubagentToolCall: (
    sessionId: string,
    taskId: string,
    toolId: string,
    name: string,
    input: Record<string, unknown>,
  ) => void;
  /** Resolve an in-flight tool call inside a sub-agent. */
  resolveSubagentToolCall: (
    sessionId: string,
    taskId: string,
    toolId: string,
  ) => void;
  /** User picked a Tasks card or a "Ran agent X" chat row — focus the
   *  Agent pane on this task. Pass null to clear (auto-pick mode). */
  setSelectedSubagentTask: (sessionId: string, taskId: string | null) => void;
  /** Drop all finished (non-running) sub-agent tasks — "Clear" in the
   *  Tasks panel. Running tasks are kept. */
  clearFinishedSubagents: (sessionId: string) => void;
}

// Deep-patch a single session entry immutably so React re-renders pick up the change.
/** Structural equality for the fields <MessageContent>'s memo compares (id,
 *  content, cost, duration, usage). Lets `setMessages` reuse a prior object
 *  reference when a re-fetched message is unchanged, so the memo bails instead
 *  of re-parsing its markdown. Content/usage are compared by value because the
 *  fetch path rebuilds them fresh each time. */
function sameMessage(a: ChatMessage, b: ChatMessage): boolean {
  if (a.id !== b.id) return false;
  if (a.cost_usd !== b.cost_usd) return false;
  if (a.duration_ms !== b.duration_ms) return false;
  if (a.content !== b.content) {
    if (JSON.stringify(a.content) !== JSON.stringify(b.content)) return false;
  }
  if (a.usage !== b.usage) {
    if (JSON.stringify(a.usage) !== JSON.stringify(b.usage)) return false;
  }
  return true;
}

const patch = (
  state: ChatState,
  sessionId: string,
  updater: (s: SessionChatState) => Partial<SessionChatState>,
): Partial<ChatState> => {
  const current = state.sessions[sessionId] ?? emptySession();
  return {
    sessions: {
      ...state.sessions,
      [sessionId]: { ...current, ...updater(current) },
    },
  };
};

export const useChatStore = create<ChatState>((set, get) => ({
  sessions: {},
  dispatchPreviews: {},
  dynamicModels: {},
  dynamicCommands: {},

  ensureSession: (sessionId) =>
    set((state) =>
      state.sessions[sessionId]
        ? state
        : { sessions: { ...state.sessions, [sessionId]: emptySession() } },
    ),

  getSession: (sessionId) => get().sessions[sessionId] ?? EMPTY_SESSION,

  clearSession: (sessionId) =>
    set((state) => {
      // Drop the session row entirely. Anyone selecting via getSession()
      // will fall through to EMPTY_SESSION — same shape, no leaked state.
      // Also evict any dispatchPreview keyed by this id (typically only
      // present when this session was a dispatch target).
      if (!state.sessions[sessionId] && !state.dispatchPreviews[sessionId]) {
        return state;
      }
      const { [sessionId]: _gone, ...rest } = state.sessions;
      const { [sessionId]: _alsoGone, ...restPreviews } = state.dispatchPreviews;
      void _gone; void _alsoGone;
      return { sessions: rest, dispatchPreviews: restPreviews };
    }),

  evictInactive: (keepIds) =>
    set((state) => {
      const keep = new Set(keepIds);
      let changed = false;
      const next: Record<string, SessionChatState> = {};
      for (const [sid, s] of Object.entries(state.sessions)) {
        // Untouched: visible (active + split panes), mid-stream, or already
        // lean. Only a session still holding a retained transcript gets reset
        // — and only its re-fetchable parts (messages + stream scratch).
        // Sub-agent tasks, process log, tool/permission state are preserved.
        if (
          keep.has(sid) ||
          s.isStreaming ||
          (s.messages.length === 0 &&
            s.contentSoFar.length === 0 &&
            !s.streamingText &&
            !s.streamingThinking)
        ) {
          next[sid] = s;
          continue;
        }
        next[sid] = {
          ...s,
          messages: [],
          contentSoFar: [],
          streamingText: "",
          streamingThinking: "",
        };
        changed = true;
      }
      return changed ? { sessions: next } : {};
    }),

  appendDispatchPreview: (targetId, p) =>
    set((state) => {
      const now = Date.now();
      const cur = state.dispatchPreviews[targetId] ?? {
        text: "",
        thinking: "",
        lastTool: null,
        startedAt: now,
        updatedAt: now,
        errored: false,
      };
      return {
        dispatchPreviews: {
          ...state.dispatchPreviews,
          [targetId]: {
            ...cur,
            // Append-style merging for text/thinking; replace for lastTool.
            text: p.text !== undefined ? cur.text + p.text : cur.text,
            thinking: p.thinking !== undefined ? cur.thinking + p.thinking : cur.thinking,
            lastTool: p.lastTool !== undefined ? p.lastTool : cur.lastTool,
            errored: p.errored !== undefined ? p.errored : cur.errored,
            updatedAt: now,
          },
        },
      };
    }),

  clearDispatchPreview: (targetId) =>
    set((state) => {
      if (!state.dispatchPreviews[targetId]) return state;
      const next = { ...state.dispatchPreviews };
      delete next[targetId];
      return { dispatchPreviews: next };
    }),

  setDynamicModels: (sessionId, models, current) =>
    set((state) => ({
      dynamicModels: {
        ...state.dynamicModels,
        [sessionId]: { models, current },
      },
    })),

  setDynamicCommands: (sessionId, commands) =>
    set((state) => ({
      dynamicCommands: {
        ...state.dynamicCommands,
        [sessionId]: commands,
      },
    })),

  setMessages: (sessionId, messages) =>
    set((state) => {
      // Preserve client-only `dispatch_pending` blocks across a server
      // refresh. The "Dispatching to X" pill is added optimistically by
      // ws-manager's dispatch_ack handler under id `pending-<target_id>`
      // — the backend never persists it (the row is replaced by a
      // `dispatch_result` block once the agent finishes). chat-view's
      // mount effect re-fetches messages from DB on every session-open
      // (intentional, see chat-view.tsx — covers a separate bug where
      // background-dispatch user messages weren't visible). Without
      // this carry-over, the naive `messages: incoming` overwrite
      // wipes the pending pill the moment the user pops away from
      // Fleet and back; the dispatch keeps running on the backend but
      // the UI shows nothing until the result lands. We keep only the
      // pending blocks whose corresponding dispatch is still active
      // (their target_id has a live `dispatchPreviews` entry); once
      // `dispatch_result` clears the preview, a stale pending block
      // gets dropped here on the next refresh as expected.
      const cur = state.sessions[sessionId];
      if (!cur) {
        return patch(state, sessionId, () => ({ messages }));
      }
      const incomingIds = new Set(messages.map((m) => m.id));
      const carryOver = cur.messages.filter((m) => {
        if (typeof m.id !== "string" || !m.id.startsWith("pending-")) return false;
        if (incomingIds.has(m.id)) return false; // already in fetched set (defensive)
        const targetId = m.id.slice("pending-".length);
        return state.dispatchPreviews[targetId] !== undefined;
      });
      // Reference-stabilise unchanged messages. chat-view re-fetches + re-parses
      // on every session open, handing us fresh objects with identical content;
      // because <MessageContent>'s memo compares `content` by REFERENCE, those
      // fresh arrays defeat it and every message re-parses its markdown (~10ms
      // each → a few hundred ms per open, 2-3× over). Reusing the prior object
      // when nothing changed lets the memo bail, so an open re-parses at most
      // once. The equality check runs a handful of times per open (cheap), not
      // per render.
      const prevById = new Map(cur.messages.map((m) => [m.id, m]));
      const stabilized = messages.map((m) => {
        const old = prevById.get(m.id);
        return old && sameMessage(old, m) ? old : m;
      });
      // Pending blocks are stamped at dispatch_ack time (now) so they're
      // always newer than fetched DB rows — appending keeps chronology.
      const merged = carryOver.length === 0 ? stabilized : [...stabilized, ...carryOver];
      return patch(state, sessionId, () => ({ messages: merged }));
    }),

  addMessage: (sessionId, message) =>
    set((state) =>
      patch(state, sessionId, (s) => ({ messages: [...s.messages, message] })),
    ),

  removeMessage: (sessionId, messageId) =>
    set((state) =>
      patch(state, sessionId, (s) => ({
        messages: s.messages.filter((m) => m.id !== messageId),
      })),
    ),

  appendStreamingText: (sessionId, text) =>
    set((state) =>
      patch(state, sessionId, (s) => ({ streamingText: s.streamingText + text })),
    ),

  appendStreamAndContent: (sessionId, text) =>
    set((state) =>
      patch(state, sessionId, (s) => {
        // Update streamingText (live preview source) AND contentSoFar
        // (finalisation source) in one pass. The contentSoFar path
        // mirrors appendContentText: append to the last text block if
        // any, else open a new one.
        const last = s.contentSoFar[s.contentSoFar.length - 1];
        let nextContent: ContentBlock[];
        if (last && last.type === "text") {
          nextContent = [...s.contentSoFar.slice(0, -1), { type: "text", text: last.text + text }];
        } else {
          nextContent = [...s.contentSoFar, { type: "text", text }];
        }
        return {
          streamingText: s.streamingText + text,
          contentSoFar: nextContent,
        };
      }),
    ),

  setStreamingThinking: (sessionId, text) =>
    set((state) =>
      patch(state, sessionId, (s) => ({ streamingThinking: s.streamingThinking + text })),
    ),

  clearStreamingThinking: (sessionId) =>
    set((state) =>
      patch(state, sessionId, () => ({ streamingThinking: "" })),
    ),

  setIsStreaming: (sessionId, streaming) =>
    set((state) =>
      patch(state, sessionId, (s) => ({
        isStreaming: streaming,
        sdkReady: streaming ? false : s.sdkReady,
        streamStartTime: streaming ? Date.now() : s.streamStartTime,
      })),
    ),

  setSdkReady: (sessionId, ready) =>
    set((state) => patch(state, sessionId, () => ({ sdkReady: ready }))),

  addToolCall: (sessionId, toolId, name, input) =>
    set((state) =>
      patch(state, sessionId, (s) => ({
        activeToolCalls: { ...s.activeToolCalls, [toolId]: { name, input } },
      })),
    ),

  resolveToolCall: (sessionId, toolId) =>
    set((state) =>
      patch(state, sessionId, (s) => {
        const next = { ...s.activeToolCalls };
        delete next[toolId];
        return { activeToolCalls: next };
      }),
    ),

  appendContentText: (sessionId, text) =>
    set((state) =>
      patch(state, sessionId, (s) => {
        const last = s.contentSoFar[s.contentSoFar.length - 1];
        if (last && last.type === "text") {
          const updated: ContentBlock = { type: "text", text: last.text + text };
          return { contentSoFar: [...s.contentSoFar.slice(0, -1), updated] };
        }
        return { contentSoFar: [...s.contentSoFar, { type: "text", text }] };
      }),
    ),

  pushContentBlock: (sessionId, block) =>
    set((state) =>
      patch(state, sessionId, (s) => ({ contentSoFar: [...s.contentSoFar, block] })),
    ),

  resetContent: (sessionId) =>
    set((state) => patch(state, sessionId, () => ({ contentSoFar: [] }))),

  finalizeAssistantMessage: (sessionId, id, content, model, costUsd, usage) =>
    set((state) =>
      patch(state, sessionId, (s) => {
        const duration_ms = s.streamStartTime ? Date.now() - s.streamStartTime : undefined;
        return {
          messages: [
            ...s.messages,
            {
              id,
              role: "assistant" as const,
              content,
              model,
              cost_usd: costUsd,
              usage,
              duration_ms,
              timestamp: new Date().toISOString(),
            },
          ],
          contentSoFar: [],
        };
      }),
    ),

  // Patch cost / usage / model onto the most-recent assistant message in
  // a session — used by ws-manager when the `cost` WS event arrives AFTER
  // a `status:done` already finalized the content. Without this, cost
  // data was lost on that ordering. Idempotent + safe if no assistant
  // message exists (no-op).
  attachCostToLastAssistant: (sessionId, costUsd, usage, model) =>
    set((state) =>
      patch(state, sessionId, (s) => {
        // Walk from the end to find the latest assistant message.
        for (let i = s.messages.length - 1; i >= 0; i--) {
          const m = s.messages[i];
          if (!m || m.role !== "assistant") continue;
          // Don't overwrite an already-recorded cost (defensive).
          if (typeof m.cost_usd === "number" && m.cost_usd > 0 && !costUsd) return s;
          const updated = { ...m,
            cost_usd: costUsd ?? m.cost_usd,
            usage: usage ?? m.usage,
            model: model ?? m.model,
          };
          const next = s.messages.slice();
          next[i] = updated;
          return { messages: next };
        }
        return s; // no assistant message to patch
      }),
    ),

  clearStreaming: (sessionId) =>
    set((state) =>
      patch(state, sessionId, () => ({
        streamingText: "",
        streamingThinking: "",
        activeToolCalls: {},
        isStreaming: false,
        sdkReady: false,
        streamStartTime: null,
        contentSoFar: [],
      })),
    ),

  clearAll: (sessionId) =>
    set((state) => ({
      sessions: { ...state.sessions, [sessionId]: emptySession() },
    })),

  setPermissionRequest: (sessionId, req) =>
    set((state) =>
      patch(state, sessionId, () => ({
        // Stamp requestedAt at registration time so consumers like
        // LivePulse have a stable origin for "X ago" labels. If the
        // caller already provided one (e.g. a backend timestamp), keep it.
        permissionRequest: req
          ? { ...req, requestedAt: req.requestedAt ?? Date.now() }
          : null,
      })),
    ),

  setCursorQuestion: (sessionId, q) =>
    set((state) => patch(state, sessionId, () => ({ cursorQuestion: q }))),

  setAskQuestion: (sessionId, q) =>
    set((state) => patch(state, sessionId, () => ({ askQuestion: q }))),

  setCursorPlan: (sessionId, p) =>
    set((state) => patch(state, sessionId, () => ({ cursorPlan: p }))),

  startCompactionPill: (sessionId, { provider, command }) =>
    set((state) =>
      patch(state, sessionId, () => ({
        compactionPill: {
          state: "running",
          provider,
          command,
          preChars: null,
          postChars: null,
          preMessageCount: null,
          compactAt: null,
          model: null,
          pct: 0,
          phase: "prepare",
          startedAt: Date.now(),
        },
      })),
    ),

  updateCompactionProgress: (sessionId, { pct, phase }) =>
    set((state) =>
      patch(state, sessionId, (s) =>
        s.compactionPill && s.compactionPill.state === "running"
          ? {
              compactionPill: {
                ...s.compactionPill,
                // Keep the bar monotonic — never let a late event rewind it.
                pct: Math.max(s.compactionPill.pct ?? 0, pct),
                phase,
              },
            }
          : {},
      ),
    ),

  finalizeCompactionPill: (
    sessionId,
    { preChars, postChars, preMessageCount, compactAt, model, trigger },
  ) =>
    set((state) =>
      patch(state, sessionId, (s) =>
        s.compactionPill
          ? {
              compactionPill: {
                ...s.compactionPill,
                state: "done",
                preChars: preChars ?? null,
                postChars: postChars ?? null,
                preMessageCount: preMessageCount ?? null,
                compactAt: compactAt ?? null,
                model: model ?? null,
                trigger,
                endedAt: Date.now(),
              },
            }
          : {},
      ),
    ),

  clearCompactionPill: (sessionId) =>
    set((state) =>
      patch(state, sessionId, () => ({ compactionPill: null })),
    ),

  dropMessagesBefore: (sessionId, cutoffMs) =>
    set((state) =>
      patch(state, sessionId, (s) => ({
        messages: s.messages.filter(m => {
          const t = Date.parse(m.timestamp);
          if (Number.isNaN(t)) return true; // keep messages with malformed ts
          return t >= cutoffMs;
        }),
      })),
    ),

  pushProcessEvent: (sessionId, event) =>
    set((state) =>
      patch(state, sessionId, (s) => ({
        // Cap the log so long-running sessions don't balloon memory or force the
        // UI to render thousands of rows at once.
        processLog: [...s.processLog, event].slice(-200),
      })),
    ),

  updateProcessEvent: (sessionId, toolId, inputPatch) =>
    set((state) =>
      patch(state, sessionId, (s) => ({
        processLog: s.processLog.map((e) =>
          e.tool_id === toolId
            ? { ...e, input: { ...e.input, ...inputPatch } }
            : e,
        ),
        activeToolCalls: s.activeToolCalls[toolId]
          ? {
              ...s.activeToolCalls,
              [toolId]: {
                ...s.activeToolCalls[toolId]!,
                input: { ...s.activeToolCalls[toolId]!.input, ...inputPatch },
              },
            }
          : s.activeToolCalls,
        contentSoFar: s.contentSoFar.map((b) =>
          b.type === "tool_use" && b.tool_id === toolId
            ? { ...b, input: { ...(b.input as Record<string, unknown>), ...inputPatch } }
            : b,
        ),
      })),
    ),

  completeProcessEvent: (sessionId, toolId, output, isError) =>
    set((state) =>
      patch(state, sessionId, (s) => ({
        processLog: s.processLog.map((e) =>
          e.tool_id === toolId && e.status === "running"
            ? { ...e, status: isError ? "errored" : "completed", endedAt: Date.now(), output }
            : e,
        ),
      })),
    ),

  clearProcessLog: (sessionId) =>
    set((state) => patch(state, sessionId, () => ({ processLog: [] }))),

  resolveDispatchPermission: (sessionId, requestId, approved) =>
    set((state) =>
      patch(state, sessionId, (s) => ({
        messages: s.messages.map((m) => {
          let changed = false;
          const nextContent = m.content.map((b) => {
            if (b.type === "dispatch_permission" && b.request_id === requestId) {
              changed = true;
              return { ...b, status: approved ? ("approved" as const) : ("denied" as const) };
            }
            return b;
          });
          return changed ? { ...m, content: nextContent } : m;
        }),
      })),
    ),

  // ── Sub-agent actions ────────────────────────────────────────────
  // Each action reads from session.subagentTasks[taskId], applies a
  // patch, and writes back. The map-of-maps shape keeps parallel
  // sub-agents isolated and lets the reducer stay flat.

  startSubagent: (sessionId, task) =>
    set((state) =>
      patch(state, sessionId, (s) => {
        // Idempotent: if the task already exists (duplicate
        // TaskStartedMessage), preserve its accumulated state.
        if (s.subagentTasks[task.id]) return {};
        const now = Date.now();
        const fresh: SubagentTask = {
          id: task.id,
          toolUseId: task.toolUseId,
          description: task.description,
          taskType: task.taskType,
          status: "running",
          startedAt: now,
          endedAt: null,
          totalTokens: 0,
          toolUses: 0,
          durationMs: 0,
          lastToolName: null,
          summary: null,
          content: [],
          streamingText: "",
          streamingThinking: "",
          activeToolCalls: {},
        };
        return {
          subagentTasks: { ...s.subagentTasks, [task.id]: fresh },
          // Auto-focus this task if no other is selected yet. Lets
          // the Agent pane snap to the newest dispatch without the
          // user clicking.
          selectedSubagentTaskId: s.selectedSubagentTaskId ?? task.id,
        };
      }),
    ),

  updateSubagentProgress: (sessionId, taskId, usage, lastToolName) =>
    set((state) =>
      patch(state, sessionId, (s) => {
        const cur = s.subagentTasks[taskId];
        if (!cur) return {};
        return {
          subagentTasks: {
            ...s.subagentTasks,
            [taskId]: {
              ...cur,
              totalTokens: usage.totalTokens,
              toolUses: usage.toolUses,
              durationMs: usage.durationMs,
              lastToolName,
            },
          },
        };
      }),
    ),

  endSubagent: (sessionId, taskId, status, summary, usage) =>
    set((state) =>
      patch(state, sessionId, (s) => {
        const cur = s.subagentTasks[taskId];
        if (!cur) return {};
        return {
          subagentTasks: {
            ...s.subagentTasks,
            [taskId]: {
              ...cur,
              status,
              summary,
              endedAt: Date.now(),
              // Prefer the terminal usage; fall back to the last
              // progress snapshot if the notification omits it.
              totalTokens: usage?.totalTokens ?? cur.totalTokens,
              toolUses: usage?.toolUses ?? cur.toolUses,
              durationMs: usage?.durationMs ?? cur.durationMs,
              // Drop any in-flight tool calls — they're done.
              activeToolCalls: {},
              streamingText: "",
              streamingThinking: "",
            },
          },
        };
      }),
    ),

  pushSubagentContent: (sessionId, taskId, block) =>
    set((state) =>
      patch(state, sessionId, (s) => {
        const cur = s.subagentTasks[taskId];
        if (!cur) return {};
        // Coalesce consecutive text blocks the same way the main
        // session does — avoids the Agent pane fragmenting prose
        // into many tiny <p> chunks.
        const last = cur.content[cur.content.length - 1];
        let nextContent: ContentBlock[];
        if (
          last && last.type === "text" &&
          block.type === "text"
        ) {
          nextContent = [
            ...cur.content.slice(0, -1),
            { type: "text", text: last.text + block.text },
          ];
        } else {
          nextContent = [...cur.content, block];
        }
        return {
          subagentTasks: {
            ...s.subagentTasks,
            [taskId]: { ...cur, content: nextContent },
          },
        };
      }),
    ),

  appendSubagentStreamingText: (sessionId, taskId, text) =>
    set((state) =>
      patch(state, sessionId, (s) => {
        const cur = s.subagentTasks[taskId];
        if (!cur) return {};
        return {
          subagentTasks: {
            ...s.subagentTasks,
            [taskId]: { ...cur, streamingText: cur.streamingText + text },
          },
        };
      }),
    ),

  appendSubagentStreamingThinking: (sessionId, taskId, text) =>
    set((state) =>
      patch(state, sessionId, (s) => {
        const cur = s.subagentTasks[taskId];
        if (!cur) return {};
        return {
          subagentTasks: {
            ...s.subagentTasks,
            [taskId]: { ...cur, streamingThinking: cur.streamingThinking + text },
          },
        };
      }),
    ),

  addSubagentToolCall: (sessionId, taskId, toolId, name, input) =>
    set((state) =>
      patch(state, sessionId, (s) => {
        const cur = s.subagentTasks[taskId];
        if (!cur) return {};
        return {
          subagentTasks: {
            ...s.subagentTasks,
            [taskId]: {
              ...cur,
              activeToolCalls: {
                ...cur.activeToolCalls,
                [toolId]: { name, input },
              },
            },
          },
        };
      }),
    ),

  resolveSubagentToolCall: (sessionId, taskId, toolId) =>
    set((state) =>
      patch(state, sessionId, (s) => {
        const cur = s.subagentTasks[taskId];
        if (!cur) return {};
        const next = { ...cur.activeToolCalls };
        delete next[toolId];
        return {
          subagentTasks: {
            ...s.subagentTasks,
            [taskId]: { ...cur, activeToolCalls: next },
          },
        };
      }),
    ),

  setSelectedSubagentTask: (sessionId, taskId) =>
    set((state) =>
      patch(state, sessionId, () => ({ selectedSubagentTaskId: taskId })),
    ),

  clearFinishedSubagents: (sessionId) =>
    set((state) =>
      patch(state, sessionId, (s) => {
        const kept: Record<string, SubagentTask> = {};
        for (const [id, t] of Object.entries(s.subagentTasks)) {
          if (t.status === "running") kept[id] = t;
        }
        const selStillThere = s.selectedSubagentTaskId && kept[s.selectedSubagentTaskId];
        return {
          subagentTasks: kept,
          selectedSubagentTaskId: selStillThere ? s.selectedSubagentTaskId : null,
        };
      }),
    ),
}));

// Convenience selector for components that read only one session's state.
// Returns a stable EMPTY_SESSION reference when the session isn't in the
// store yet — returning a fresh object each call would thrash zustand's
// equality check and trigger an infinite re-render.
export const selectSession = (sessionId: string | null | undefined) =>
  (state: ChatState): SessionChatState =>
    (sessionId && state.sessions[sessionId]) || EMPTY_SESSION;

/** Surface an error as a red message-bubble inside the session's chat.
 *  Replaces the retired toast/notification system for failures the user
 *  needs to see (Create PR errors, branch op errors, WS task failures,
 *  …). The `error-` id prefix keeps `hasRealMessage` in chat-view from
 *  treating it as proof of conversation, so a fresh draft that hits a
 *  failure still shows the folder picker / compose surface rather than
 *  flipping into "Create PR" mode.
 *
 *  No dedupe by design — every failed attempt produces a fresh bubble
 *  so the user sees that the second click ALSO failed (matches the
 *  user's explicit "1 kerelik değil" requirement for the folder
 *  warning). */
export function pushChatError(sessionId: string, message: string): void {
  if (!sessionId) return;
  const text = message.startsWith("Task failed:") ? message : `Task failed: ${message}`;
  useChatStore.getState().addMessage(sessionId, {
    id: `error-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    role: "system",
    content: [{ type: "text", text }],
    timestamp: new Date().toISOString(),
  });
}

/**
 * Push an auth-required system message into the session's transcript.
 * Used when the bridge emits BridgeEvent::AuthRequired (e.g. agy's
 * OAuth has expired). The renderer's AuthRequiredCard component
 * looks for ContentBlock.type === "auth_required" and renders the
 * info card with provider + url + opened_in_browser.
 */
export function pushChatAuthRequired(
  sessionId: string,
  args: { provider: string; url: string; openedInBrowser: boolean },
): void {
  if (!sessionId) return;
  useChatStore.getState().addMessage(sessionId, {
    id: `auth-required-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    role: "system",
    content: [{
      type: "auth_required",
      provider: args.provider,
      url: args.url,
      opened_in_browser: args.openedInBrowser,
      session_id: sessionId,
    }],
    timestamp: new Date().toISOString(),
  });
}

/**
 * Push a CLI-login recovery card into the session's transcript. Used when the
 * bridge emits `login_required` (e.g. Grok's `session/new` `-32000
 * Authentication required`). The renderer's GrokLoginCard looks for
 * ContentBlock.type === "grok_login", runs `<bin> login` in a PTY, and resumes
 * the original prompt on success. De-dupes: a still-pending card for the same
 * session is left in place rather than stacking a second one.
 */
export function pushGrokLogin(sessionId: string, provider: string): void {
  if (!sessionId) return;
  const messages = useChatStore.getState().sessions[sessionId]?.messages;
  const hasPending = messages?.some((m) =>
    m.content.some((c) => c.type === "grok_login"),
  );
  if (hasPending) return;
  useChatStore.getState().addMessage(sessionId, {
    id: `grok-login-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    role: "system",
    content: [{ type: "grok_login", provider, session_id: sessionId }],
    timestamp: new Date().toISOString(),
  });
}

/**
 * Mark any pending sign-in card in a session as completed. Called when
 * the bridge delivers a reply (a sign-in that produced an answer must
 * have succeeded), so the AuthRequiredCard can flip from its in-progress
 * "Signing in…" / "Code sent…" state to a "Signed in" success line.
 *
 * Cheap no-op for the common case: returns without a state update unless
 * the session actually has an auth_required block that isn't signed in
 * yet, so it's safe to call on every reply.
 */
export function markAuthSignedIn(sessionId: string): void {
  if (!sessionId) return;
  const state = useChatStore.getState();
  const messages = state.sessions[sessionId]?.messages;
  if (!messages?.length) return;
  // Only the MOST RECENT sign-in card corresponds to this reply. Flip
  // just that one (if it's still pending) so an earlier failed-sign-in
  // card in the same session isn't wrongly marked succeeded.
  let lastIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.content.some(c => c.type === "auth_required")) {
      lastIdx = i;
      break;
    }
  }
  if (lastIdx === -1) return;
  const msg = messages[lastIdx]!;
  if (!msg.content.some(c => c.type === "auth_required" && !c.signed_in)) return;
  const next = messages.slice();
  next[lastIdx] = {
    ...msg,
    content: msg.content.map(c =>
      c.type === "auth_required" && !c.signed_in ? { ...c, signed_in: true } : c,
    ),
  };
  state.setMessages(sessionId, next);
}

/**
 * Type out an existing assistant message char-by-char so it reads
 * like the agent is composing it live. Drops the full text into
 * `content[0].text` one character at a time, on a setInterval,
 * stopping early if the message gets removed (e.g. a real reply
 * lands and clears it). Caller must have already added the empty
 * placeholder message via addMessage.
 *
 * Re-calling for the same (sessionId, messageId) cancels the prior
 * in-flight run and restarts from the first character, so a re-type
 * (e.g. the composer welcome after the folder changes) never runs two
 * intervals into the same message and garbles it.
 *
 * @param sessionId  chat session that owns the message
 * @param messageId  id of the placeholder assistant message
 * @param fullText   final text to land character by character
 * @param speedMs    delay between characters (default 18ms). Pass 0 (or
 *                   less) to drop the full text instantly with no
 *                   typewriter — used when refreshing an already-seen line.
 */
const typewriterIntervals = new Map<string, ReturnType<typeof setInterval>>();

export function typeOutAssistantMessage(
  sessionId: string,
  messageId: string,
  fullText: string,
  speedMs = 18,
) {
  const key = `${sessionId}::${messageId}`;
  const inflight = typewriterIntervals.get(key);
  if (inflight) { clearInterval(inflight); typewriterIntervals.delete(key); }

  // Instant mode (speedMs <= 0): set the full text in one shot, no
  // animation. Used to REFRESH a line the user has already watched type
  // out (e.g. the composer welcome after the folder changes) — replaying
  // the typewriter from the first character on every change reads as a
  // glitch. The in-flight run is cancelled above, so a change landing
  // mid-type still resolves cleanly to the final text.
  if (speedMs <= 0) {
    const state = useChatStore.getState();
    const messages = state.sessions[sessionId]?.messages ?? [];
    const idx = messages.findIndex(m => m.id === messageId);
    if (idx === -1) return;
    const next = messages.slice();
    next[idx] = { ...messages[idx]!, content: [{ type: "text", text: fullText }] };
    state.setMessages(sessionId, next);
    return;
  }

  let i = 0;
  const interval = setInterval(() => {
    const state = useChatStore.getState();
    const messages = state.sessions[sessionId]?.messages ?? [];
    const idx = messages.findIndex(m => m.id === messageId);
    // If the placeholder is gone (removed by the auto-intro path
    // or by clearAllForSession), the interval has nothing to update
    // and should self-cancel rather than keep ticking.
    if (idx === -1) { clearInterval(interval); typewriterIntervals.delete(key); return; }

    i += 1;
    const partial = fullText.slice(0, i);
    const next = messages.slice();
    next[idx] = {
      ...messages[idx]!,
      content: [{ type: "text", text: partial }],
    };
    state.setMessages(sessionId, next);

    if (i >= fullText.length) { clearInterval(interval); typewriterIntervals.delete(key); }
  }, speedMs);
  typewriterIntervals.set(key, interval);
}
