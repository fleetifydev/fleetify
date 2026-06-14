import { createSessionsWebSocket } from "@/lib/api";
import { awaitConfigPatch } from "@/lib/session-config-sync";
import { useChatStore, pushChatAuthRequired, markAuthSignedIn } from "@/stores/chat-store";
import { useAppStore } from "@/stores/app-store";
import type { WSServerMessage, ImageBlock } from "@/types/chat";
import type { Attachment } from "@/components/chat/chat-input";

// Inline routing marker the chat-input prepends to /compact submits.
// Mirrored here so the send path and the staff-chat optimistic-add path
// (chat-view.tsx) agree on what counts as a compaction turn — keeping
// the literal in one module-level constant means the two surfaces can't
// drift apart on a future rename.
export const COMPACTION_MARKER = "[fleet:compaction]";

/** Stable ID for the optimistic "/compact" row a submit appends. Used
 *  by both wsManager.send and the staff-chat optimistic-add path so
 *  the compaction_done handler can target-remove this exact row when
 *  the canonical synthetic /compact lands. One per session is enough —
 *  the chat input is locked while a compaction is in flight, so two
 *  optimistics can never coexist for the same sid. */
export const compactionOptimisticId = (sessionId: string) =>
  `optimistic-compact-${sessionId}`;

/** Short human description for the agentic catalog's snake_case tool
 *  names — surfaced in the permission dialog so the user sees "Run a
 *  shell command" rather than the bare identifier. Names that aren't
 *  in this map fall back to a generic placeholder. */
function agenticToolDescription(toolName: string): string {
  switch (toolName) {
    case "edit_file":   return "Replace text inside a file in your workspace.";
    case "write_file":  return "Create or overwrite a file in your workspace.";
    case "run_command": return "Run a shell command in your workspace.";
    case "read_file":   return "Read a file from your workspace.";
    case "list_dir":    return "List the contents of a directory.";
    case "grep":        return "Search workspace files for a pattern.";
    case "glob":        return "Find workspace files matching a glob.";
    default:            return `Run the ${toolName} tool.`;
  }
}

/**
 * Multiplexed WebSocket manager. ONE physical socket carries
 * traffic for every active session — the user sees a single
 * "WebSocket /ws/sessions [accepted]" line in the backend log
 * regardless of how many sessions they're watching.
 *
 * Public API stays per-session:
 *   - send(sid, …) / sendInternal(sid, …) / abort(sid) /
 *     enhance(sid, …) / ensureConnected(sid)
 *
 * Internally each call multiplexes through the shared socket:
 *   - ensureConnected(sid) → ensure shared socket open + subscribe(sid)
 *   - send(sid, msg)       → wire { type: "send", session_id, message }
 *   - inbound events demux on `data.session_id`
 *
 * The legacy per-session `createChatWebSocket(sid)` factory is kept
 * for any future debugging / fallback path but isn't used by the
 * manager today. */
class WSManager {
  // Single shared socket. null when no live connection.
  private socket: WebSocket | null = null;
  private connectPromise: Promise<WebSocket> | null = null;
  // Sessions currently subscribed on the shared socket. Adding to
  // this set sends a `subscribe` wire message; removing sends
  // `unsubscribe` (handled by ensureConnected / disconnect).
  private subscribed = new Set<string>();
  // Outgoing messages queued while the socket is still in
  // CONNECTING state. Flushed in onopen.
  private outboundQueue: string[] = [];
  // Last-touched timestamp per session. We bump it on every send,
  // delta arrival, and ensureConnected call. The idle reaper
  // (below) closes sockets that haven't seen activity for
  // IDLE_DISCONNECT_MS — a cheap way to drop background-tab
  // listeners that are doing nothing but burning event-loop ticks.
  private lastActivity = new Map<string, number>();
  private idleReaperHandle: ReturnType<typeof setInterval> | null = null;
  // Auto-expire timers for dispatch_pending cards. If dispatch_result
  // doesn't arrive within the window, we replace the orphan with a
  // "lost track" result so the user isn't staring at a hung card.
  // Keyed by `${sessionId}:${pendingMessageId}`.
  private _orphanTimers = new Map<string, ReturnType<typeof setTimeout>>();

  // Buffer incoming text deltas and flush on every vsync (display
  // refresh rate, 60–120Hz on ProMotion). Avoids per-token re-renders.
  // The buffer is flushed synchronously before any finalization.
  // Timer ids are `requestAnimationFrame` handles (number) — `number`
  // here covers both browser rAF and stays compatible if a future
  // setTimeout fallback path needs to be reintroduced.
  private deltaBuffers = new Map<string, string>();
  private deltaTimers = new Map<string, number>();

  // Per-token thinking deltas have the same setState-per-token cost as
  // message_delta did before batching. Verbose reasoning bursts (Claude
  // extended thinking, Codex reasoning blobs) can fire 200+ deltas in a
  // single turn — each triggered a full re-render of the sessions tree.
  // Coalesce on the same vsync cadence as text and flush via a single
  // store action. Keyed by sessionId.
  private thinkingBuffers = new Map<string, string>();
  private thinkingTimers = new Map<string, number>();

  // Sub-agent + dispatch-stream deltas. These fire from the SAME backend
  // event stream as parent deltas (often interleaved), and each token
  // used to take its own setState round-trip. Keyed by
  // `${sessionId}::${taskOrTargetId}::${kind}` where kind is one of
  // "subtext" | "subthink" | "preview-text" | "preview-think". The flush
  // routes back into the right store action.
  private auxBuffers = new Map<string, string>();
  private auxTimers = new Map<string, number>();

  // First-delta timestamp per session for the in-flight reasoning burst.
  // Started when a thinking event arrives with an empty buffer, cleared
  // on flush. Lets us stamp `duration_ms` onto the pushed thinking block
  // so the collapsed chip reads "Thought 12s" without the component
  // running its own timer after the stream ends.
  private thinkingStarts = new Map<string, number>();

  // Citations / search-results buffered during the streaming window.
  // Perplexity (and any future search-grounded provider) emits these
  // alongside text deltas; we accumulate them here and push a single
  // CitationBlock onto contentSoFar right before the message is
  // finalized so the card renders once, at the bottom of the bubble.
  private citationBuffers = new Map<
    string,
    Array<{
      url: string;
      title?: string;
      snippet?: string;
      date?: string;
      kind: "citation" | "search_result";
    }>
  >();

  // Debounce auth-retry storms. The backend's "Unauthorized" reply
  // triggers a single force-refresh + reconnect; if THAT one also
  // gets rejected we surface the failure normally instead of looping.
  private lastAuthRetryAt: number | null = null;

  // Exponential-backoff state for the shared-socket reconnect path.
  // Previous reconnect used a fixed 1500ms after every onclose — if
  // the backend was down, the browser cheerfully retried every 1.5s
  // forever; on a flapping link the failed-handshake → onclose →
  // setTimeout cycle hammered the server. We now back off
  // 1.5s, 3s, 6s, 12s, 24s (capped at 30s) and reset to 1.5s the
  // moment a connection lands. Single in-flight reconnect timer is
  // tracked so we can't accumulate stacked retries.
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private flushDelta(sessionId: string): void {
    const timer = this.deltaTimers.get(sessionId);
    if (timer !== undefined) {
      cancelAnimationFrame(timer);
      this.deltaTimers.delete(sessionId);
    }
    const text = this.deltaBuffers.get(sessionId);
    if (text) {
      this.deltaBuffers.delete(sessionId);
      // Single combined action — was two separate set() calls back-to-
      // back, which produced two patches of the giant `sessions` record
      // per vsync tick. Every store subscriber rendered twice per delta;
      // halving that is a measurable win during a long stream.
      useChatStore.getState().appendStreamAndContent(sessionId, text);
      // A reply landing confirms any in-progress sign-in succeeded —
      // flip its card to the "Signed in" state (no-op when there's none).
      markAuthSignedIn(sessionId);
    }
  }

  /** Flush the in-flight thinking buffer for one session — appends the
   *  accumulated tokens as a single setState rather than one-per-token.
   *  Matches the flushDelta vsync cadence so a reasoning burst that
   *  fires 200+ deltas costs one render per frame, not 200. */
  private flushThinkingBuffer(sessionId: string): void {
    const timer = this.thinkingTimers.get(sessionId);
    if (timer !== undefined) {
      cancelAnimationFrame(timer);
      this.thinkingTimers.delete(sessionId);
    }
    const text = this.thinkingBuffers.get(sessionId);
    if (text) {
      this.thinkingBuffers.delete(sessionId);
      useChatStore.getState().setStreamingThinking(sessionId, text);
    }
  }

  /** Flush one aux buffer (sub-agent text/thinking or dispatch preview
   *  text/thinking). Decodes the composite key to pick the right store
   *  action. */
  private flushAux(key: string): void {
    const timer = this.auxTimers.get(key);
    if (timer !== undefined) {
      cancelAnimationFrame(timer);
      this.auxTimers.delete(key);
    }
    const text = this.auxBuffers.get(key);
    if (!text) return;
    this.auxBuffers.delete(key);
    const store = useChatStore.getState();
    const [sid, targetId, kind] = key.split("::");
    if (!sid || !targetId || !kind) return;
    switch (kind) {
      case "subtext":
        store.appendSubagentStreamingText(sid, targetId, text);
        break;
      case "subthink":
        store.appendSubagentStreamingThinking(sid, targetId, text);
        break;
      case "preview-text":
        store.appendDispatchPreview(targetId, { text });
        break;
      case "preview-think":
        store.appendDispatchPreview(targetId, { thinking: text });
        break;
    }
  }

  /** Flush every aux buffer whose key starts with the given prefix.
   *  Used to drain in-flight sub-agent / preview tokens at ordering
   *  boundaries (tool fires, sub-agent end, session disconnect). */
  private flushAuxPrefix(prefix: string): void {
    for (const key of Array.from(this.auxBuffers.keys())) {
      if (key.startsWith(prefix)) this.flushAux(key);
    }
    // Cancel any orphan timers whose buffer was already drained.
    for (const [key, timer] of Array.from(this.auxTimers.entries())) {
      if (key.startsWith(prefix) && !this.auxBuffers.has(key)) {
        cancelAnimationFrame(timer);
        this.auxTimers.delete(key);
      }
    }
  }

  /** Enqueue a token onto a buffer and arm a vsync-aligned flush via
   *  requestAnimationFrame if not already scheduled. Hard-caps at 32KB
   *  to bound memory on uninterrupted streams. Generic across thinking
   *  + aux buffers via the buffer / timer map pair. rAF replaces the
   *  earlier `setTimeout(..., 16)` cadence so streaming flushes on
   *  every vsync tick (60Hz on stock displays, 120Hz on ProMotion)
   *  instead of being capped at ~60fps by a wallclock timer. */
  private bufferAndScheduleFlush(
    key: string,
    text: string,
    buffers: Map<string, string>,
    timers: Map<string, number>,
    flush: (k: string) => void,
  ): void {
    const next = (buffers.get(key) ?? "") + text;
    buffers.set(key, next);
    if (next.length >= 32 * 1024) {
      flush(key);
    } else if (!timers.has(key)) {
      timers.set(key, requestAnimationFrame(() => flush(key)));
    }
  }

  /** Commit the live streaming-thinking buffer into contentSoFar as a
   *  thinking block, then wipe the buffer. Called at every tool_start
   *  AND at message finalize so reasoning is preserved in the right
   *  chronological slot (between text/tools), not dropped when the
   *  stream ends. */
  private flushThinking(sessionId: string): void {
    // Drain any buffered tokens into the store BEFORE we read
    // streamingThinking — otherwise the trailing 16ms-worth of tokens
    // would land in the next reasoning block instead of this one.
    this.flushThinkingBuffer(sessionId);
    const store = useChatStore.getState();
    const current = store.sessions[sessionId];
    const pending = (current?.streamingThinking ?? "").trim();
    if (!pending) {
      this.thinkingStarts.delete(sessionId);
      return;
    }
    const startedAt = this.thinkingStarts.get(sessionId);
    const duration_ms = startedAt ? Date.now() - startedAt : undefined;
    this.thinkingStarts.delete(sessionId);
    store.pushContentBlock(sessionId, { type: "thinking", text: pending, duration_ms });
    store.clearStreamingThinking(sessionId);
  }

  /** Pop buffered citations / search results into a single CitationBlock
   *  at the END of contentSoFar so the finalized assistant message
   *  carries them as a footer card. Idempotent — called from both the
   *  status:done and cost handlers; whichever fires first wins, the
   *  second invocation no-ops because the buffer is cleared here. */
  private flushCitations(sessionId: string): void {
    const items = this.citationBuffers.get(sessionId);
    if (!items || items.length === 0) {
      this.citationBuffers.delete(sessionId);
      return;
    }
    useChatStore.getState().pushContentBlock(sessionId, {
      type: "citations",
      items,
    });
    this.citationBuffers.delete(sessionId);
  }

  /** Ensure the shared multiplex socket is open AND that this session
   *  id is subscribed for events. Returns the shared socket. Public
   *  signature unchanged from the old per-session manager so the
   *  rest of the app doesn't need to know multiplex exists. */
  async ensureConnected(sessionId: string): Promise<WebSocket> {
    this.lastActivity.set(sessionId, Date.now());
    this.startIdleReaper();
    const sock = await this.ensureSocket();
    if (!this.subscribed.has(sessionId)) {
      this.subscribed.add(sessionId);
      this._sendOrQueue({ type: "subscribe", session_ids: [sessionId] });
    }
    return sock;
  }

  /** Internal — bring up the shared socket if not already open.
   *  Idempotent: while a connection is in flight, returns the same
   *  pending promise. */
  private async ensureSocket(): Promise<WebSocket> {
    const existing = this.socket;
    if (existing && existing.readyState === WebSocket.OPEN) return existing;
    if (existing && existing.readyState === WebSocket.CONNECTING && this.connectPromise) {
      return this.connectPromise;
    }
    if (!this.connectPromise) {
      this.connectPromise = this.openSharedSocket();
    }
    return this.connectPromise;
  }

  /** Send a control / data frame OR enqueue it if the socket isn't
   *  open yet. The shared socket flushes the queue in onopen. */
  private _sendOrQueue(payload: object) {
    const json = JSON.stringify(payload);
    const sock = this.socket;
    if (sock && sock.readyState === WebSocket.OPEN) {
      try { sock.send(json); }
      catch { this.outboundQueue.push(json); }
    } else {
      this.outboundQueue.push(json);
      // Kick the socket awake if nothing else is doing it.
      this.ensureSocket().catch(() => {});
    }
  }

  /** Touch the activity stamp — called from message_delta and other
   *  inbound events so an actively-streaming session never gets
   *  reaped, even if the user hasn't sent anything for minutes. */
  private touch(sessionId: string) {
    this.lastActivity.set(sessionId, Date.now());
  }

  /** Lazy-start a single timer that UNSUBSCRIBES idle sessions on
   *  the shared socket. The socket itself stays open (it's serving
   *  every active session) — only the per-session subscription is
   *  released. Idle = no activity for 5 min AND not the active
   *  session AND not currently streaming. */
  private startIdleReaper() {
    if (this.idleReaperHandle) return;
    const IDLE_UNSUBSCRIBE_MS = 5 * 60 * 1000;
    this.idleReaperHandle = setInterval(() => {
      const now = Date.now();
      const app = useAppStore.getState();
      const chat = useChatStore.getState();
      const activeId = app.activeSessionId;
      for (const sid of Array.from(this.subscribed)) {
        if (sid === activeId) continue;
        if (chat.sessions[sid]?.isStreaming) continue;
        // Keep the subscription alive while this session is the target
        // of an in-flight Fleet dispatch. dispatchPreviews entries are
        // cleared by `dispatch_result` (or by clearDispatchPreview on
        // abort), so this exits the moment the dispatch resolves. The
        // earlier `isStreaming` check alone wasn't enough because a
        // dispatched agent that goes quiet for >5 min while running
        // long tools (Bash, MCP calls, long Reads) would otherwise be
        // reaped and miss the eventual status/cost/result events.
        if (chat.dispatchPreviews[sid] !== undefined) continue;
        const last = this.lastActivity.get(sid) ?? 0;
        if (now - last < IDLE_UNSUBSCRIBE_MS) continue;
        // Unsubscribe but keep the shared socket alive. The
        // backend's per-session task tears down its bridge.
        this.subscribed.delete(sid);
        this.lastActivity.delete(sid);
        this._sendOrQueue({ type: "unsubscribe", session_ids: [sid] });
      }
      if (this.subscribed.size === 0 && this.idleReaperHandle) {
        clearInterval(this.idleReaperHandle);
        this.idleReaperHandle = null;
      }
    }, 60_000);
  }

  /** Open the shared multiplex socket. On open: flush queued
   *  payloads + re-send subscribe for every session in the
   *  `subscribed` set (covers reconnect after a drop). On close:
   *  flush any buffered deltas back into the store and clear
   *  per-session streaming state for every subscribed session. */
  private async openSharedSocket(): Promise<WebSocket> {
    const ws = await createSessionsWebSocket();
    this.socket = ws;
    return new Promise<WebSocket>((resolve, reject) => {
      ws.onopen = () => {
        this.connectPromise = null;
        // Connection landed — wipe the backoff counter so the next
        // disconnect (if any) starts fresh at 1.5s instead of the
        // tail of an old escalation.
        this.reconnectAttempts = 0;
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }
        // Re-subscribe everything (covers fresh open + reconnect).
        if (this.subscribed.size > 0) {
          try {
            ws.send(JSON.stringify({
              type: "subscribe",
              session_ids: Array.from(this.subscribed),
            }));
          } catch { /* ignored — onerror will fire if truly broken */ }
        }
        // Drain any payloads queued while we were connecting.
        if (this.outboundQueue.length) {
          for (const msg of this.outboundQueue) {
            try { ws.send(msg); } catch { break; }
          }
          this.outboundQueue.length = 0;
        }
        resolve(ws);
      };

      ws.onerror = () => {
        this.connectPromise = null;
        reject(new Error("WebSocket error on /ws/sessions"));
      };

      ws.onclose = () => {
        if (this.socket === ws) this.socket = null;
        this.connectPromise = null;
        // Flush + clear per-session streaming state for every
        // subscription. Subscriptions themselves are KEPT in the
        // set so the next openSharedSocket reconnect re-subscribes
        // them automatically.
        //
        // CRITICAL: clear EVERYTHING that drives the "Thinking" /
        // streaming UI, not just isStreaming. Previously we only
        // flipped isStreaming → false but left streamingText /
        // streamingThinking / activeToolCalls populated. That meant
        // a network-service crash mid-stream left the chat showing
        // "Thinking 53s" forever (because StreamingMessage still
        // had thinking text to render). User had no signal that
        // the connection died.
        const store = useChatStore.getState();
        for (const sid of this.subscribed) {
          try { this.flushDelta(sid); } catch { /* defensive */ }
          try { this.flushThinkingBuffer(sid); } catch { /* defensive */ }
          try { this.flushAuxPrefix(`${sid}::`); } catch { /* defensive */ }
          const dt = this.deltaTimers.get(sid);
          if (dt) cancelAnimationFrame(dt);
          this.deltaTimers.delete(sid);
          this.deltaBuffers.delete(sid);
          const tt = this.thinkingTimers.get(sid);
          if (tt) cancelAnimationFrame(tt);
          this.thinkingTimers.delete(sid);
          this.thinkingBuffers.delete(sid);
          this.thinkingStarts.delete(sid);
          const cs = store.sessions[sid];
          if (cs?.isStreaming) {
            // clearStreaming atomically wipes streamingText,
            // streamingThinking, activeToolCalls, isStreaming,
            // sdkReady, streamStartTime, contentSoFar. Without this
            // the "Thinking" UI stayed on screen forever after a
            // mid-stream WS drop (e.g. Electron's network service
            // crash) because StreamingMessage rendered the stale
            // thinking text.
            store.clearStreaming(sid);
          }
        }
        // Schedule an auto-reconnect if there are still
        // subscriptions outstanding. Without this the socket stays
        // closed until the user's next send — and if they're
        // staring at a stuck "Thinking" UI they have no way to
        // trigger one.
        //
        // Exponential backoff with full jitter — 1.5s, 3s, 6s, 12s,
        // 24s, capped at 30s. Replaces the old fixed-1500ms loop that
        // hammered a downed server every 1.5s and (worse) stormed on
        // tab refocus after a long sleep. Single in-flight timer
        // prevents stacked retries when onclose fires repeatedly
        // (handshake failures fire both onerror AND onclose).
        if (this.subscribed.size > 0) {
          if (this.reconnectTimer) {
            // Onclose just fired again while a retry was already
            // queued — keep the existing timer, don't pile a second
            // one on top.
            return;
          }
          const attempt = this.reconnectAttempts++;
          const base = Math.min(1_500 * Math.pow(2, attempt), 30_000);
          // Full jitter: randomise in [base/2, base] to scatter
          // reconnects from many tabs / clients so we don't stampede
          // the server when it comes back up.
          const delay = Math.floor(base / 2 + Math.random() * (base / 2));
          this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            // Don't pile up retries — only kick if nothing is
            // already opening a socket.
            if (this.socket === null && this.connectPromise === null) {
              this.ensureSocket().catch(() => { /* will retry on next close */ });
            }
          }, delay);
        }
      };

      ws.onmessage = (evt) => this.handleSharedEvent(evt);
    });
  }

  /** Demux an incoming frame from the shared socket. Each event
   *  carries a `session_id` field; we strip it (so downstream
   *  handlers see the original chat-WS shape) and dispatch into
   *  the legacy per-session handler. */
  private handleSharedEvent(evt: MessageEvent) {
    let data: { session_id?: string; [k: string]: unknown };
    try {
      data = JSON.parse(evt.data);
    } catch {
      return;
    }
    const sid = typeof data.session_id === "string" ? data.session_id : undefined;
    if (!sid) {
      // Connection-level events (pong, broadcast errors) — ignore
      // for now; could surface to UI later.
      return;
    }
    // Hand off to the existing per-session handler with the same
    // event shape it used to consume off /ws/chat/{sid}.
    this.handleEvent(sid, evt);
  }

  private handleEvent(sessionId: string, evt: MessageEvent) {
    let data: WSServerMessage;
    try {
      data = JSON.parse(evt.data);
    } catch {
      return;
    }
    const store = useChatStore.getState();
    store.ensureSession(sessionId);

    // While an enhance request is in flight for this session, the
    // user's CLI is rewriting their draft on our behalf. We DON'T
    // want any of those streaming events to surface in the chat
    // history — message_delta becomes "append to enhance buffer";
    // tool_start / tool_end / thinking get swallowed; status:done
    // resolves the promise. The frontend then drops the rewrite
    // straight into the chat-input box.
    if (this.isEnhancing(sessionId)) {
      switch (data.type) {
        case "message_delta": {
          const text = data.delta?.text ?? "";
          if (text) this.appendEnhanceDelta(sessionId, text);
          return;
        }
        case "enhance_done":
          this.finalizeEnhance(sessionId, typeof (data as { text?: string }).text === "string"
            ? (data as { text: string }).text
            : undefined);
          return;
        case "status":
          if ("status" in data && data.status === "done") {
            // Belt + suspenders: backend always emits enhance_done
            // before status:done, but if we somehow miss it we
            // still finalize from the accumulated buffer.
            this.finalizeEnhance(sessionId);
          }
          return;
        case "error":
          // Reject the pending promise so the chat-input shows a
          // failure toast instead of hanging.
          {
            const p = this.enhancePending.get(sessionId);
            if (p) {
              clearTimeout(p.timeoutId);
              this.enhancePending.delete(sessionId);
              p.reject(new Error(String((data as { error?: string }).error ?? "Enhance failed")));
            }
          }
          return;
        // init / cost / thinking / tool_* / permission_request — drop on the floor
        default:
          return;
      }
    }

    switch (data.type) {
      // Bridge init: SDK subprocess is now ready (distinct from WS handshake init which has model="pending")
      case "init":
        this.touch(sessionId);
        if ("claude_session_id" in data) store.setSdkReady(sessionId, true);
        break;
      // Live model catalog from a runtime-sourced agent (OpenCode). Store
      // it per-session so the composer's model picker can render + switch.
      case "available_models_update": {
        const models = Array.isArray(data.models)
          ? (data.models as Array<{ id?: unknown; label?: unknown }>)
              .filter((m) => typeof m.id === "string")
              .map((m) => ({
                id: String(m.id),
                label: typeof m.label === "string" ? m.label : String(m.id),
              }))
          : [];
        const current =
          typeof data.current_model === "string" ? data.current_model : "";
        store.setDynamicModels(sessionId, models, current);
        break;
      }
      // Runtime slash commands advertised by the agent (OpenCode). Stored
      // per-session so the composer's slash menu can merge them in.
      case "slash_commands_update": {
        const commands = Array.isArray(data.commands)
          ? (data.commands as Array<{ name?: unknown; description?: unknown }>)
              .filter((c) => typeof c.name === "string")
              .map((c) => ({
                name: String(c.name),
                description:
                  typeof c.description === "string" ? c.description : "",
              }))
          : [];
        store.setDynamicCommands(sessionId, commands);
        break;
      }
      // ── Sub-agent lifecycle ────────────────────────────────────
      // The bridge emits these three events 1:1 with the SDK's
      // TaskStartedMessage / TaskProgressMessage / TaskNotificationMessage.
      // Auto-open Agent + Tasks panes on the first subagent_start of
      // the active session — this is the *correct* trigger (matches
      // Claude Code Desktop's behaviour), not the previous string
      // match on tool name "Task" which was a brittle guess.
      case "subagent_start": {
        if (!data.task_id) break;
        store.startSubagent(sessionId, {
          id: String(data.task_id),
          toolUseId: data.tool_use_id ? String(data.tool_use_id) : null,
          description: String(data.description ?? "Agent"),
          taskType: data.task_type ? String(data.task_type) : null,
        });
        if (sessionId === useAppStore.getState().activeSessionId) {
          try {
            useAppStore.getState().addWorkspaceView("tasks");
            useAppStore.getState().addWorkspaceView("process");
          } catch { /* hydrating */ }
        }
        break;
      }
      case "subagent_progress": {
        if (!data.task_id) break;
        store.updateSubagentProgress(
          sessionId,
          String(data.task_id),
          {
            totalTokens: Number(data.total_tokens ?? 0),
            toolUses: Number(data.tool_uses ?? 0),
            durationMs: Number(data.duration_ms ?? 0),
          },
          data.last_tool_name ? String(data.last_tool_name) : null,
        );
        break;
      }
      case "subagent_end": {
        if (!data.task_id) break;
        // Drain any pending sub-agent stream tokens so endSubagent
        // doesn't truncate the trailing 16ms of reasoning/text. The
        // store's endSubagent wipes streamingText/streamingThinking
        // unconditionally, so we MUST flush first.
        this.flushAuxPrefix(`${sessionId}::${String(data.task_id)}::`);
        const status = data.status === "failed" || data.status === "stopped"
          ? data.status
          : "completed";
        const usage = (
          typeof data.total_tokens === "number" ||
          typeof data.tool_uses === "number" ||
          typeof data.duration_ms === "number"
        )
          ? {
              totalTokens: Number(data.total_tokens ?? 0),
              toolUses: Number(data.tool_uses ?? 0),
              durationMs: Number(data.duration_ms ?? 0),
            }
          : null;
        store.endSubagent(
          sessionId,
          String(data.task_id),
          status as "completed" | "failed" | "stopped",
          data.summary ? String(data.summary) : null,
          usage,
        );
        break;
      }

      case "message_delta": {
        this.touch(sessionId);
        const text = data.delta?.text ?? "";
        if (!text) break;
        // Route to sub-agent buffer when the event is tagged.
        const ptid = data.parent_task_id ? String(data.parent_task_id) : null;
        if (ptid) {
          // Sub-agent text streams used to setState per token, same
          // problem the parent message_delta path already solved.
          // Coalesce on the 16ms cadence via the shared aux buffer.
          this.bufferAndScheduleFlush(
            `${sessionId}::${ptid}::subtext`,
            text,
            this.auxBuffers,
            this.auxTimers,
            (k) => this.flushAux(k),
          );
          break;
        }
        // Parent-session text: accumulate + arm a vsync-aligned flush
        // via requestAnimationFrame (avoids per-token renders, and
        // matches the display refresh rate so ProMotion screens get
        // 120Hz streaming instead of the old 60Hz cap from
        // setTimeout(..., 16)'s wallclock cadence).
        const next = (this.deltaBuffers.get(sessionId) ?? "") + text;
        this.deltaBuffers.set(sessionId, next);
        // Hard cap: flush eagerly when a single buffered chunk crosses 32KB
        // so very long uninterrupted token streams don't blow up memory.
        if (next.length >= 32 * 1024) {
          this.flushDelta(sessionId);
        } else if (!this.deltaTimers.has(sessionId)) {
          this.deltaTimers.set(sessionId, requestAnimationFrame(() => this.flushDelta(sessionId)));
        }
        break;
      }
      case "thinking": {
        if (!("text" in data)) break;
        const text = String(data.text);
        if (!text) break;
        const ptid = data.parent_task_id ? String(data.parent_task_id) : null;
        if (ptid) {
          // Sub-agent thinking — coalesce 16ms-worth of tokens into one
          // setState. Without this every reasoning token in a sub-agent
          // turn caused a fresh render of the entire sessions tree.
          this.bufferAndScheduleFlush(
            `${sessionId}::${ptid}::subthink`,
            text,
            this.auxBuffers,
            this.auxTimers,
            (k) => this.flushAux(k),
          );
        } else {
          // Stamp the start time on the first delta of a fresh burst so
          // flushThinking can attach an accurate duration_ms to the
          // committed block.
          if (!this.thinkingStarts.has(sessionId) && !this.thinkingBuffers.has(sessionId)) {
            this.thinkingStarts.set(sessionId, Date.now());
          }
          // Parent thinking — same 16ms coalesce as message_delta. A
          // verbose reasoning burst (Claude extended thinking, Codex
          // <reasoning>) used to fire setStreamingThinking per token —
          // hundreds of renders per turn.
          this.bufferAndScheduleFlush(
            sessionId,
            text,
            this.thinkingBuffers,
            this.thinkingTimers,
            (k) => this.flushThinkingBuffer(k),
          );
        }
        break;
      }
      case "tool_start": {
        // Commit any text that streamed BEFORE the tool fired so the
        // tool_use block lands in chronological order. Without this
        // flush, buffered tokens land after the tool block (the delta
        // timer hasn't fired yet) and the chat reads "tool, then the
        // sentence that introduced it" — out of sequence.
        this.flushDelta(sessionId);
        const ptid = data.parent_task_id ? String(data.parent_task_id) : null;
        // Commit any accumulated thinking BEFORE the tool fires so the
        // reasoning lands above the tool block in chat order. Without
        // this flush, Codex's one-big-reasoning-blob-then-tools pattern
        // collapses into "Thinking ... then sequence of tools" — the
        // reasoning never interleaves between tool batches the way
        // Claude Code Desktop renders it.
        if (!ptid) this.flushThinking(sessionId);
        if (ptid) {
          // Drain any pending sub-agent text/thinking BEFORE the tool
          // block lands so the inner activity log stays in
          // chronological order (same concern flushDelta solves for
          // the parent stream).
          this.flushAuxPrefix(`${sessionId}::${ptid}::`);
          // Sub-agent tool — store on the task's content log, NOT in
          // the parent's contentSoFar (which would leak it into the
          // main chat).
          store.addSubagentToolCall(sessionId, ptid, data.tool_id, data.name, data.input ?? {});
          store.pushSubagentContent(sessionId, ptid, {
            type: "tool_use",
            tool_id: data.tool_id,
            tool_name: data.name,
            tool_kind: data.tool_kind,
            input: data.input ?? {},
          });
          break;
        }
        // Parent tool — existing path. Lands inline in chat AND the
        // processLog for the agent activity feed.
        store.addToolCall(sessionId, data.tool_id, data.name, data.input ?? {});
        store.pushContentBlock(sessionId, {
          type: "tool_use",
          tool_id: data.tool_id,
          tool_name: data.name,
          tool_kind: data.tool_kind,
          input: data.input ?? {},
        });
        store.pushProcessEvent(sessionId, {
          id: crypto.randomUUID(),
          tool_id: data.tool_id,
          name: data.name,
          input: data.input ?? {},
          startedAt: Date.now(),
          endedAt: null,
          status: "running",
        });
        break;
      }
      case "tool_update": {
        if (!data.tool_id || !data.input || typeof data.input !== "object") break;
        const ptid = data.parent_task_id ? String(data.parent_task_id) : null;
        if (ptid) {
          // Update the in-flight tool's input inside the sub-agent.
          // resolveSubagentToolCall + addSubagentToolCall would clear
          // and re-add; instead patch by re-adding with merged input.
          const task = store.sessions[sessionId]?.subagentTasks[ptid];
          const cur = task?.activeToolCalls[String(data.tool_id)];
          const mergedInput = {
            ...(cur?.input ?? {}),
            ...(data.input as Record<string, unknown>),
          };
          store.addSubagentToolCall(
            sessionId, ptid, String(data.tool_id),
            cur?.name ?? "unknown", mergedInput,
          );
          break;
        }
        store.updateProcessEvent(
          sessionId,
          String(data.tool_id),
          data.input as Record<string, unknown>,
        );
        break;
      }
      case "tool_end": {
        // Same ordering concern as tool_start: flush any buffered text
        // first so the tool_result block sits where it actually
        // happened in the stream, not after later prose.
        this.flushDelta(sessionId);
        const ptid = data.parent_task_id ? String(data.parent_task_id) : null;
        if (ptid) {
          // Drain pending sub-agent text/thinking so the tool_result
          // lands after the prose that introduced it inside the inner log.
          this.flushAuxPrefix(`${sessionId}::${ptid}::`);
          store.resolveSubagentToolCall(sessionId, ptid, String(data.tool_id));
          store.pushSubagentContent(sessionId, ptid, {
            type: "tool_result",
            tool_id: String(data.tool_id),
            output: String(data.output ?? ""),
            is_error: !!data.is_error,
          });
          break;
        }
        store.resolveToolCall(sessionId, data.tool_id);
        store.completeProcessEvent(sessionId, data.tool_id, data.output ?? "", !!data.is_error);
        store.pushContentBlock(sessionId, {
          type: "tool_result",
          tool_id: String(data.tool_id),
          output: String(data.output ?? ""),
          is_error: !!data.is_error,
        });
        break;
      }
      case "citation": {
        // Search-grounded providers (Perplexity) emit one of these per
        // URL after the text streaming completes. Buffer until status:
        // done so we can attach a single CitationBlock to the final
        // message in chronological order.
        const url = typeof data.url === "string" ? data.url : "";
        if (!url) break;
        const buf = this.citationBuffers.get(sessionId) ?? [];
        buf.push({
          url,
          title: typeof data.title === "string" ? data.title : undefined,
          snippet: typeof data.snippet === "string" ? data.snippet : undefined,
          kind: "citation",
        });
        this.citationBuffers.set(sessionId, buf);
        break;
      }
      case "search_result": {
        const url = typeof data.url === "string" ? data.url : "";
        const title = typeof data.title === "string" ? data.title : "";
        if (!url || !title) break;
        const buf = this.citationBuffers.get(sessionId) ?? [];
        buf.push({
          url,
          title,
          snippet: typeof data.snippet === "string" ? data.snippet : undefined,
          date: typeof data.date === "string" ? data.date : undefined,
          kind: "search_result",
        });
        this.citationBuffers.set(sessionId, buf);
        break;
      }
      case "status":
        if ("status" in data && data.status === "done") {
          this.flushDelta(sessionId); // Commit any buffered text before finalizing
          // Flush trailing thinking that never got a follow-up tool — keeps
          // the reasoning visible on the persisted message instead of
          // dropping it with clearStreaming.
          this.flushThinking(sessionId);
          this.flushCitations(sessionId);
          // Re-read FRESH state here — the `store` reference captured at
          // the top of dispatchEvent is a snapshot taken BEFORE the flush
          // calls above mutated the store. Reading `store.sessions[id]`
          // would see the pre-flush contentSoFar (empty), skip finalize,
          // then clearStreaming would wipe the buffered text — so the
          // assistant bubble would never appear in the live view (only
          // after navigate-away-and-back, which forces a DB refetch).
          // This bug bit any bridge whose entire turn arrives in a
          // single MessageDelta + Status pair (Antigravity print mode,
          // dispatched-task summaries, etc).
          const current = useChatStore.getState().sessions[sessionId];
          if (current && current.contentSoFar.length > 0) {
            store.finalizeAssistantMessage(sessionId, crypto.randomUUID(), current.contentSoFar);
          }
          store.clearStreaming(sessionId);
        }
        break;
      case "cost": {
        this.flushDelta(sessionId); // Commit any buffered text before finalizing
        this.flushThinking(sessionId);
        this.flushCitations(sessionId);
        // Same stale-snapshot fix as case "status" above — read fresh.
        const current = useChatStore.getState().sessions[sessionId];
        const usage = data.usage as Record<string, number> | undefined;
        const costUsd = typeof data.cost_usd === "number" ? data.cost_usd : undefined;
        const model = typeof data.model === "string" ? data.model : undefined;
        if (current && current.contentSoFar.length > 0) {
          // Normal path: cost arrives WITH or before status:done. Finalize
          // the streaming content into a fresh assistant message that
          // carries the cost/usage right away.
          store.finalizeAssistantMessage(
            sessionId,
            crypto.randomUUID(),
            current.contentSoFar,
            model,
            costUsd,
            usage,
          );
          store.clearStreaming(sessionId);
        } else {
          // Race path: status:done already finalized the content (which
          // emptied contentSoFar) and THEN cost arrived. The previous
          // version dropped this data on the floor — the assistant
          // message stayed cost-less. Patch cost/usage onto the
          // already-finalized last assistant message.
          store.attachCostToLastAssistant(sessionId, costUsd, usage, model);
        }
        break;
      }
      case "dispatch_ack": {
        // Resolve agent name from the app store
        const app = useAppStore.getState();
        const dispatchTarget = app.sessions.find(s => s.id === data.target_id);
        const dispatchName = dispatchTarget?.title ?? data.target_id?.slice(0, 8) ?? "agent";
        const pendingId = `pending-${data.target_id}`;

        // ── Parallel-dispatch tolerance ──
        // Two dispatches to the SAME agent in flight at once: the second
        // ack used to overwrite the first's pending message AND clear
        // its preview buffer (mid-stream, so the user lost the live
        // preview they were watching). The orphan timer also got
        // overwritten — first dispatch's lost-track guard cancelled.
        // Pragmatic fix: if a pending card already exists for this
        // target, DON'T duplicate the message or reset the preview;
        // just refresh the orphan timer so the most recent ack
        // re-arms the 10-minute window. The two parallel dispatches
        // collapse into one visible card — accepted degradation for a
        // rare case (sequential is the common path; the SDK serializes
        // sends to a single bridge anyway).
        // `tool_card`: the MCP `dispatch_to_agent` path (a non-staff agent
        // dispatching a sub-agent) already renders a "Dispatched: …" tool
        // row in the chat, so we MUST NOT add a duplicate "Dispatching…"
        // pending bubble — but we STILL want the Tasks/Agent pane card. The
        // staff `[[DISPATCH:]]` paths have no tool row, so they get the
        // pending bubble too.
        const silent = !!data.tool_card;
        const sess = useChatStore.getState().sessions[sessionId];
        const alreadyPending = !!sess?.messages.some(m => m.id === pendingId);
        const alreadyTask = !!sess?.subagentTasks?.[String(data.target_id)];

        // Chat pending bubble + preview buffer — staff dispatches only.
        if (!silent && !alreadyPending) {
          store.addMessage(sessionId, {
            id: pendingId,
            role: "system",
            content: [{
              type: "dispatch_pending",
              agent_id: data.target_id,
              agent_name: dispatchName,
              task: data.task || "",
            }],
            timestamp: new Date().toISOString(),
          });
          // Initialise empty preview buffer so the streaming card can
          // render immediately (even before any deltas arrive).
          store.clearDispatchPreview(data.target_id);
          store.appendDispatchPreview(data.target_id, {});
        }

        // ── Mirror into the unified sub-agent pipeline ── (EVERY path)
        // Fleet dispatch is semantically a sub-agent run (parent → worker →
        // result back). Surface it through the same Tasks pane / Agent pane
        // that Claude's Task tool and Codex's spawnAgent feed. task_id = the
        // target agent's session id; dedup on the task already existing so
        // parallel dispatches to one target collapse into a single card.
        if (data.target_id && !alreadyTask) {
          const desc = (data.task || dispatchName).split("\n")[0] || dispatchName;
          store.startSubagent(sessionId, {
            id: String(data.target_id),
            toolUseId: null,  // Fleet dispatch isn't triggered by a tool_use block
            description: desc.length > 80 ? desc.slice(0, 80) + "…" : desc,
            taskType: dispatchName,  // worker agent name → shown as task type
          });
          // Auto-open Tasks + Agent panes for the active session, same
          // trigger as Claude/Codex sub-agents.
          if (sessionId === useAppStore.getState().activeSessionId) {
            try {
              useAppStore.getState().addWorkspaceView("tasks");
              useAppStore.getState().addWorkspaceView("process");
            } catch { /* hydrating */ }
          }
        }
        // Proactively subscribe the target session to the shared
        // socket. Without this, the WS multiplex stays unsubscribed
        // for any target that the user hasn't opened recently — and
        // the backend's `dispatch_incoming` event (sent on the
        // target's channel the moment the bridge picks up the task)
        // gets dropped. dispatch_incoming is the ONLY signal that
        // sets `isStreaming = true` for the target session, so when
        // the user navigates into that agent's chat afterwards the
        // "Thinking…" indicator never appears even though the agent
        // is working. Subscribing here means the target's channel is
        // live the moment the ack lands; subsequent dispatch_incoming
        // / message_delta / status events flow into the target's
        // chat-store as if the user had been watching all along.
        if (data.target_id) {
          this.ensureConnected(String(data.target_id)).catch(() => {});
        }
        // Orphan-card guard. If `dispatch_result` never arrives (agent
        // crash before result emit, staff WS reconnect mid-dispatch,
        // backend died, etc.), the pending card would otherwise stay
        // visible forever and look like a hung dispatch. After 10
        // minutes we replace it with a clear "lost track" result card.
        // Always re-arm — even on duplicate acks for collapsed parallel
        // dispatches, the freshest ack defines the deadline.
        const orphanKey = `${sessionId}:${pendingId}`;
        const existing = this._orphanTimers.get(orphanKey);
        if (existing) clearTimeout(existing);
        this._orphanTimers.set(orphanKey, setTimeout(() => {
          const cur = useChatStore.getState().sessions[sessionId]?.messages ?? [];
          if (cur.some(m => m.id === pendingId)) {
            store.removeMessage(sessionId, pendingId);
            store.clearDispatchPreview(data.target_id);
            store.addMessage(sessionId, {
              id: `lost-${data.target_id}-${Date.now()}`,
              role: "system",
              content: [{
                type: "dispatch_result",
                agent_id: data.target_id,
                agent_name: dispatchName,
                task: data.task || "",
                success: false,
                summary: "Lost track of this dispatch — no result returned within 10 minutes. The agent may still be working in the background, or the connection dropped. Open the agent to check.",
              }],
              timestamp: new Date().toISOString(),
            });
          }
          this._orphanTimers.delete(orphanKey);
        }, 10 * 60 * 1000)); // 10 minutes
        break;
      }
      case "spawn_form": {
        // Inline "create agent" card in the staff transcript. Mirrors the
        // dispatch_pending pattern: append a system message carrying the
        // block; the SpawnFormCard renders/edits it and posts Create itself.
        store.addMessage(sessionId, {
          id: `spawn-${data.request_id}`,
          role: "system",
          content: [{
            type: "spawn_form",
            request_id: data.request_id,
            draft: data.draft,
            gaps: data.gaps,
            status: data.status,
            created_session_id: data.created_session_id,
            error: data.error,
          }],
          timestamp: new Date().toISOString(),
        });
        break;
      }
      case "dispatch_progress": {
        // Lifecycle status from the backend dispatch handler. Drives the
        // status badge on the pending card so the user can tell which
        // phase the dispatch is in (received → starting → running). The
        // backend sends "starting" the moment _run_agent_task picks up
        // the task (and had to auto-wake a stopped/error agent), then
        // "running" the instant the bridge yields its first stream
        // event. Without these events the staff stares at a silent
        // pending card for the 2-5 seconds it takes the bridge to boot.
        if (!data.target_id) break;
        const phase = data.phase as "received" | "starting" | "running" | undefined;
        const autoWoken = !!data.auto_woken;
        store.appendDispatchPreview(data.target_id, {
          ...(phase ? { phase } : {}),
          ...(autoWoken ? { autoWoken: true } : {}),
        });
        break;
      }
      case "dispatch_stream": {
        // Live mirror of a target agent's response while it's running.
        // Backend filters to high-signal events only (text, thinking,
        // tool_start, tool_end, error). Two destinations:
        //
        //   1. The compact dispatch_pending card's preview buffer
        //      (DispatchPreview) — old surface that shows lastTool +
        //      truncated text under the chat card.
        //   2. The unified sub-agent store (subagentTasks) — feeds the
        //      Tasks pane and Agent pane the same way Claude/Codex
        //      sub-agents do. task_id = target_id (set by dispatch_ack).
        //
        // Both surfaces stay alive for now so existing users see no
        // regression; once the sub-agent panes are battle-tested we can
        // retire the compact in-chat card.
        if (!data.target_id) break;
        const kind = data.kind as string;
        const taskId = String(data.target_id);
        const hasTask = !!useChatStore.getState().sessions[sessionId]?.subagentTasks[taskId];
        if (kind === "message_delta") {
          const t = String(data.text || "");
          if (t) {
            // Coalesce both fanout writes (preview card + sub-agent
            // store) on the 16ms cadence. Without this a dispatched
            // agent's reply caused TWO setStates per token, both
            // patching the giant sessions / dispatchPreviews record.
            this.bufferAndScheduleFlush(
              `${sessionId}::${data.target_id}::preview-text`,
              t,
              this.auxBuffers,
              this.auxTimers,
              (k) => this.flushAux(k),
            );
            if (hasTask) {
              this.bufferAndScheduleFlush(
                `${sessionId}::${taskId}::subtext`,
                t,
                this.auxBuffers,
                this.auxTimers,
                (k) => this.flushAux(k),
              );
            }
          }
        } else if (kind === "thinking") {
          const t = String(data.text || "");
          if (t) {
            this.bufferAndScheduleFlush(
              `${sessionId}::${data.target_id}::preview-think`,
              t,
              this.auxBuffers,
              this.auxTimers,
              (k) => this.flushAux(k),
            );
            if (hasTask) {
              this.bufferAndScheduleFlush(
                `${sessionId}::${taskId}::subthink`,
                t,
                this.auxBuffers,
                this.auxTimers,
                (k) => this.flushAux(k),
              );
            }
          }
        } else if (kind === "tool_start") {
          store.appendDispatchPreview(data.target_id, { lastTool: String(data.tool_name || "") });
          if (hasTask && data.tool_id) {
            // Update progress with the new tool count + last_tool_name
            // so the Tasks card shows live "Running <ToolName>".
            const task = useChatStore.getState().sessions[sessionId]?.subagentTasks[taskId];
            if (task) {
              store.updateSubagentProgress(
                sessionId, taskId,
                {
                  totalTokens: task.totalTokens,
                  toolUses: task.toolUses + 1,
                  durationMs: Date.now() - task.startedAt,
                },
                String(data.tool_name || ""),
              );
              store.addSubagentToolCall(
                sessionId, taskId,
                String(data.tool_id),
                String(data.tool_name || "tool"),
                {},
              );
              store.pushSubagentContent(sessionId, taskId, {
                type: "tool_use",
                tool_id: String(data.tool_id),
                tool_name: String(data.tool_name || "tool"),
                input: {},
              });
            }
          }
        } else if (kind === "tool_end") {
          if (data.is_error) {
            store.appendDispatchPreview(data.target_id, { errored: true });
          }
          if (hasTask && data.tool_id) {
            store.resolveSubagentToolCall(sessionId, taskId, String(data.tool_id));
            store.pushSubagentContent(sessionId, taskId, {
              type: "tool_result",
              tool_id: String(data.tool_id),
              // dispatch_stream tool_end now forwards the sub-agent's stdout/result.
              output: String(data.output ?? ""),
              is_error: !!data.is_error,
            });
          }
        } else if (kind === "cost") {
          // Live token count for the Tasks card — accumulate per-turn usage.
          if (hasTask) {
            const task = useChatStore.getState().sessions[sessionId]?.subagentTasks[taskId];
            if (task) {
              store.updateSubagentProgress(
                sessionId, taskId,
                {
                  totalTokens: task.totalTokens + Number(data.total_tokens || 0),
                  toolUses: task.toolUses,
                  durationMs: Date.now() - task.startedAt,
                },
                task.lastToolName,
              );
            }
          }
        } else if (kind === "error") {
          store.appendDispatchPreview(data.target_id, { errored: true });
        }
        break;
      }
      case "dispatch_incoming": {
        // Staff dispatched a task to this agent — render the task as a
        // regular user message so the agent's chat page looks like a normal
        // conversation, and mark streaming so the thinking indicator shows
        // until the reply starts flowing in.
        store.addMessage(sessionId, {
          id: crypto.randomUUID(),
          role: "user",
          content: [{ type: "text", text: data.text }],
          timestamp: data.timestamp ?? new Date().toISOString(),
        });
        store.resetContent(sessionId);
        store.setIsStreaming(sessionId, true);
        break;
      }
      case "dispatch_result": {
        // Remove the pending card for this agent, replace with result card
        const pendingId = `pending-${data.target_id}`;
        // Cancel any in-flight aux flushes targeting this dispatch.
        // The preview is about to be cleared and the sub-agent task
        // ended; pending tokens would land on a wiped buffer.
        if (data.target_id) {
          this.flushAuxPrefix(`${sessionId}::${String(data.target_id)}::`);
        }
        store.removeMessage(sessionId, pendingId);
        // Drop the live preview buffer — the final summary card replaces it.
        store.clearDispatchPreview(data.target_id);
        // Cancel the orphan-expire timer — result arrived in time.
        const orphanKey = `${sessionId}:${pendingId}`;
        const t = this._orphanTimers.get(orphanKey);
        if (t) {
          clearTimeout(t);
          this._orphanTimers.delete(orphanKey);
        }
        // ── Mirror into the sub-agent pipeline ──
        // Flip the matching Tasks card to Completed / Failed and
        // surface the final summary on the Agent pane. task_id was
        // set on dispatch_ack as target_id; if no task exists (e.g.
        // result arrived for a target we never saw an ack for, rare)
        // this is a safe no-op because endSubagent gates on presence.
        if (data.target_id) {
          const taskId = String(data.target_id);
          const task = useChatStore.getState().sessions[sessionId]?.subagentTasks[taskId];
          store.endSubagent(
            sessionId,
            taskId,
            data.success !== false ? "completed" : "failed",
            data.summary || null,
            task
              ? { totalTokens: task.totalTokens, toolUses: task.toolUses, durationMs: Date.now() - task.startedAt }
              : null,
          );
        }
        // Agent name + project path: backend now includes both on the
        // live event so the card renders correctly even before the
        // sessions list has hydrated. Falls back to the app-store
        // lookup for older backends that don't emit `target_name`.
        const app2 = useAppStore.getState();
        const targetSession = app2.sessions.find(s => s.id === data.target_id);
        const agentName =
          (typeof data.target_name === "string" && data.target_name) ||
          targetSession?.title ||
          (typeof data.target_id === "string" ? data.target_id.slice(0, 8) : "agent");
        const projectPath =
          (typeof data.project_path === "string" && data.project_path) ||
          targetSession?.project_path ||
          undefined;

        store.addMessage(sessionId, {
          id: crypto.randomUUID(),
          role: "system",
          content: [{
            type: "dispatch_result",
            agent_id: data.target_id,
            agent_name: agentName,
            task: data.task || "",
            success: data.success !== false,
            summary: data.summary || "Task completed",
            ...(projectPath ? { project_path: projectPath } : {}),
          }],
          timestamp: new Date().toISOString(),
        });

        // If the backend extracted artifacts, emit each one as its own system
        // message so they render as interactive ArtifactCards in the chat feed.
        if (data.artifacts && data.artifacts.length > 0) {
          for (const artifact of data.artifacts) {
            store.addMessage(sessionId, {
              id: crypto.randomUUID(),
              role: "system",
              content: [{
                type: "artifact",
                artifact_id: artifact.artifact_id,
                artifact_type: artifact.artifact_type,
                name: artifact.name,
                content: artifact.content,
                language: artifact.language,
                size_bytes: artifact.size_bytes,
                created_by: artifact.created_by ?? data.target_id,
                agent_name: artifact.agent_name ?? agentName,
              }],
              timestamp: new Date().toISOString(),
            });
          }
        }

        break;
      }
      case "agent_stopped": {
        useAppStore.getState().updateSession(data.target_id, { status: "stopped" });
        break;
      }
      case "agent_restarted": {
        useAppStore.getState().updateSession(data.target_id, { status: "idle" });
        break;
      }
      case "agent_report": {
        // Proactive message from a dispatched agent back to Fleet
        store.addMessage(sessionId, {
          id: crypto.randomUUID(),
          role: "system",
          content: [{
            type: "agent_report",
            agent_id: data.agent_id,
            agent_name: data.agent_name,
            message: data.message,
            level: data.level ?? "info",
          }],
          timestamp: new Date().toISOString(),
        });
        break;
      }
      case "tool_permission_request": {
        store.setPermissionRequest(sessionId, {
          id: data.id,
          tool_name: data.tool_name,
          tool_description: data.tool_description,
          command: data.command,
        });
        useAppStore.getState().updateSession(sessionId, { status: "waiting" });
        break;
      }
      case "cursor_ask_question": {
        // Cursor's blocking `cursor/ask_question` — surface a multiple-choice
        // card; `sendQuestionResponse` round-trips the chosen option ids.
        store.setCursorQuestion(sessionId, {
          id: data.id,
          title: data.title,
          questions: data.questions,
        });
        useAppStore.getState().updateSession(sessionId, { status: "waiting" });
        break;
      }
      case "cursor_create_plan": {
        // Cursor's blocking `cursor/create_plan` — surface a plan-approval
        // card; `sendPlanResponse` round-trips accepted/rejected.
        store.setCursorPlan(sessionId, {
          id: data.id,
          name: data.name,
          overview: data.overview,
          plan: data.plan,
          todos: data.todos,
          phases: data.phases,
        });
        useAppStore.getState().updateSession(sessionId, { status: "waiting" });
        break;
      }
      case "ask_user_question": {
        // Claude Code's built-in AskUserQuestion — surface an interactive
        // multiple-choice card; `sendAskQuestionResponse` round-trips the
        // chosen labels back as the tool result (via fleet_permission).
        store.setAskQuestion(sessionId, {
          id: data.id,
          questions: data.questions ?? [],
        });
        useAppStore.getState().updateSession(sessionId, { status: "waiting" });
        break;
      }
      case "permission_request": {
        // Agentic loop (HTTP-provider sessions running through
        // `drive_agentic_loop`) is asking the user. Reuse the same
        // PermissionRequest store entry + dialog component the CLI MCP
        // flow uses — just synthesise the `command` and description from
        // the tool name + input. The user's reply goes back through
        // `sendPermissionResponse` with the same `id`, and the backend
        // routes it to `AgenticBridgeRunner::resolve_permission` first
        // before falling through to the CLI PermissionSession.
        const input = (data.input ?? {}) as Record<string, unknown>;
        const command =
          data.tool_name === "run_command"
            ? (typeof input.command === "string" ? input.command : "")
            : data.tool_name === "edit_file"
              ? `edit ${input.path ?? "?"}`
              : data.tool_name === "write_file"
                ? `write ${input.path ?? "?"} (${
                    typeof input.content === "string" ? (input.content as string).length : 0
                  } bytes)`
                : `${data.tool_name}(${JSON.stringify(input)})`;
        const desc = agenticToolDescription(data.tool_name as string);
        store.setPermissionRequest(sessionId, {
          id: data.id,
          tool_name: data.tool_name,
          tool_description: desc,
          command,
        });
        useAppStore.getState().updateSession(sessionId, { status: "waiting" });
        break;
      }
      case "dispatch_permission_request": {
        // Dispatched agent is asking the user from the staff chat. Surface
        // it as an inline card in the chat feed — the feed stays scrollable
        // and the input is never blocked.
        store.addMessage(sessionId, {
          id: crypto.randomUUID(),
          role: "system",
          content: [{
            type: "dispatch_permission",
            request_id: data.request_id,
            agent_id: data.agent_id,
            agent_name: data.agent_name,
            tool_name: data.tool_name,
            command: data.command,
            status: "pending",
          }],
          timestamp: new Date().toISOString(),
        });
        break;
      }
      case "dispatch_permission_resolved": {
        // Flip the staff inline card into its resolved state.
        store.resolveDispatchPermission(sessionId, data.request_id, data.approved);
        // If the same session currently has the floating dialog open for
        // this request (target agent direct-view case), clear it so the
        // user doesn't see a stale prompt after the decision landed from
        // the staff surface.
        const current = useChatStore.getState().sessions[sessionId];
        if (current?.permissionRequest?.id === data.request_id) {
          store.setPermissionRequest(sessionId, null);
          useAppStore.getState().updateSession(sessionId, { status: "running" });
        }
        break;
      }
      case "compaction_progress": {
        // Interim % from the streaming summariser — advance the pill bar.
        const pct = typeof data.pct === "number" ? data.pct : 0;
        const phase = typeof data.phase === "string" ? data.phase : "";
        store.updateCompactionProgress(sessionId, { pct, phase });
        break;
      }
      case "compaction_status": {
        // Backend signalled the start of a /compact or /compress flow.
        // Spin up the inline pill — the chat-view renders it between
        // messages and the streaming preview so the user sees the action
        // running. The streaming chat-input lock is driven by the
        // regular isStreaming flag already; no extra wiring needed here.
        const provider = String(data.provider ?? "claude-code");
        const command = String(data.command ?? "/compact");
        store.startCompactionPill(sessionId, { provider, command });
        break;
      }
      case "compaction_done": {
        // The app-owned compactor uniformly reports char counts +
        // message count + the compact_at timestamp the backend stamped
        // on the session row. error!=null means the summariser failed
        // — flip to the failed state with the reason inline.
        //
        // Compaction takes the short-circuit path on the backend so
        // there's no `status:done` event to release the streaming
        // lock — release it here so the chat-input unlocks and the
        // streaming UI surface disappears even though no agent turn
        // ever ran.
        store.clearStreaming(sessionId);
        const err = typeof data.error === "string" && data.error ? data.error : null;
        if (err) {
          store.failCompactionPill(sessionId, err);
        } else {
          const preChars = typeof data.pre_chars === "number" ? data.pre_chars : null;
          const postChars = typeof data.post_chars === "number" ? data.post_chars : null;
          const preMessageCount = typeof data.pre_message_count === "number"
            ? data.pre_message_count : null;
          const compactAt = typeof data.compact_at === "string" ? data.compact_at : null;
          const model = typeof data.model === "string" ? data.model : null;
          const trigger = typeof data.trigger === "string" ? data.trigger : undefined;
          store.finalizeCompactionPill(sessionId, {
            preChars, postChars, preMessageCount, compactAt, model, trigger,
          });

          // Drop the optimistic "/compact" row we appended at submit
          // time. We do this by ID rather than relying on
          // dropMessagesBefore's timestamp filter — the optimistic
          // was stamped with the client clock and compact_at uses the
          // server clock post-summariser, so any clock-skew or
          // pathologically-fast summariser leaves the optimistic with
          // timestamp >= cutoff and produces a duplicate /compact
          // bubble in chat. ID-based removal sidesteps that entirely.
          store.removeMessage(sessionId, compactionOptimisticId(sessionId));

          // Mirror the backend's hard-delete in the local store so the
          // scrollback doesn't keep showing messages that no longer
          // exist server-side. Anything older than compact_at goes.
          // We then re-add a single synthetic /compact row stamped AT
          // compact_at so the chat doesn't flash empty before the next
          // turn lands, and push the summary message the compactor
          // persisted so the user can SEE the summary that the next
          // agent turn will use as context.
          if (compactAt) {
            const cutoff = Date.parse(compactAt);
            if (!Number.isNaN(cutoff)) {
              store.dropMessagesBefore(sessionId, cutoff);
              store.addMessage(sessionId, {
                id: crypto.randomUUID(),
                role: "user",
                content: [{ type: "text", text: "/compact" }],
                timestamp: compactAt,
              });
              const summary = typeof data.summary === "string" ? data.summary : null;
              const summaryId = typeof data.summary_message_id === "string"
                ? data.summary_message_id
                : null;
              const summaryAt = typeof data.summary_at === "string"
                ? data.summary_at
                // Fall back to compact_at + 1ms if the backend somehow
                // didn't echo summary_at — keeps the row in-bounds of
                // the cutoff filter and after the /compact row.
                : new Date(cutoff + 1).toISOString();
              if (summary && summaryId) {
                store.addMessage(sessionId, {
                  id: summaryId,
                  role: "assistant",
                  content: [{
                    type: "text",
                    // Mirror the exact body the backend persisted so a
                    // later reload that fetches the DB row matches the
                    // live render.
                    text: `[fleet:compact-summary]\n${summary}`,
                  }],
                  timestamp: summaryAt,
                });
              }
            }
          }
        }
        break;
      }
      case "auth_required": {
        this.flushDelta(sessionId); // commit any buffered text first
        pushChatAuthRequired(sessionId, {
          provider: String(data.provider ?? ""),
          url: String(data.url ?? ""),
          openedInBrowser: Boolean(data.opened_in_browser),
        });
        break;
      }

      case "error": {
        this.flushDelta(sessionId); // Commit any buffered text before clearing
        const current = store.sessions[sessionId];

        // ── Transient auth failure: try one silent recovery ──
        // Backend sends this when the JWT in the WS query string was
        // missing or expired. Cause is usually a token that expired
        // while the app was idle, or a refresh that failed silently
        // earlier. Force one fresh token + let onclose's auto-reconnect
        // re-open the socket — the user never sees a chat error for
        // what is really a routine token rotation. We debounce so a
        // genuinely revoked refresh-token doesn't loop forever.
        const isAuthError = typeof data.error === "string"
          && data.error.startsWith("Unauthorized");
        if (isAuthError) {
          const now = Date.now();
          const last = this.lastAuthRetryAt ?? 0;
          if (now - last > 30_000) {
            this.lastAuthRetryAt = now;
            store.clearStreaming(sessionId);
            // Force-refresh the access token. Don't wait — the
            // backend is already closing the socket; the next
            // openSharedSocket call will read the freshly cached
            // token on its own.
            void (async () => {
              try {
                await window.fleetify?.getAccessToken?.({ force: true });
              } catch { /* refresh failed; next attempt will surface
                            the error through the normal path */ }
            })();
            // Drop the socket on our side so the auto-reconnect in
            // onclose runs with the new token. Don't add a chat
            // message — this whole event is invisible to the user
            // when recovery succeeds.
            try { this.socket?.close(); } catch { /* defensive */ }
            break;
          }
          // Already retried recently — fall through and surface
          // the error normally; the user probably needs to sign in.
        }

        if (current && current.contentSoFar.length > 0) {
          store.finalizeAssistantMessage(sessionId, crypto.randomUUID(), current.contentSoFar);
        }
        store.clearStreaming(sessionId);
        // If the failure interrupted a compaction, flip the pill to
        // failed so the user sees what happened rather than a dangling
        // "Compacting…" spinner. The generic error toast still fires
        // below for visibility.
        if (current?.compactionPill?.state === "running") {
          store.failCompactionPill(
            sessionId,
            typeof data.error === "string" ? data.error : "Compaction failed",
          );
        }
        // "Forbidden or not found" is a transient sync error — the
        // backend's WS subscribe fired for a session that wasn't (yet
        // or any longer) in the DB. Most common cause is a phantom
        // session in `sessions[]` that the visibility-change /
        // sessions-sweep handler tried to re-subscribe to after the
        // backend row was gone (DB reset, account switch, …).
        //
        // Surfacing it as a chat message confused users on fresh
        // drafts (the strip flipped to "Create PR" because the error
        // counted as a real assistant turn). Drop the message AND
        // unsubscribe so we stop pinging the dead session every focus
        // change — leaves the renderer's `sessions[]` entry alone for
        // a higher layer (sidebar reconcile) to prune at its own pace.
        const isStaleSessionError = typeof data.error === "string"
          && /forbidden or not found/i.test(data.error);
        if (isStaleSessionError) {
          if (typeof console !== "undefined") {
            console.warn("[ws] dropped stale-session error for", sessionId, data.error);
          }
          try { this.disconnect(sessionId); } catch { /* defensive */ }
          break;
        }
        // Prefix the synthetic ID with `error-` so the chat-view's
        // `hasRealMessage` gate (which keys off `welcome-`/`warn-`/
        // `attempt-` prefixes) doesn't treat a bare error toast as
        // proof that the session has produced real conversation —
        // otherwise the BranchStrip / Create PR surface unhid itself
        // on draft sessions that never actually ran an agent.
        store.addMessage(sessionId, {
          id: `error-${crypto.randomUUID()}`,
          role: "system",
          content: [{ type: "text", text: `Task failed: ${data.error ?? "unknown error"}` }],
          timestamp: new Date().toISOString(),
        });
        break;
      }
      default:
        break;
    }
  }

  /**
   * Wait for any in-flight turn on `sessionId` to finish before letting
   * a new "send" frame onto the wire. Backend's `chat.rs` keeps a
   * per-session `streaming` set and SILENTLY drops a second `send`
   * (`if streaming.contains(sid) { continue; }`) — without this gate
   * the optimistic user bubble would sit forever under a "Thinking…"
   * indicator with no response coming back. Polling the store keeps
   * the optimistic-append path unchanged; only the wire write defers
   * until the previous turn's bridge releases the session. 5-minute
   * cap so a stuck bridge can't pin this gate indefinitely.
   */
  private async waitForStreamingClear(sessionId: string): Promise<void> {
    const start = Date.now();
    const cap = 5 * 60_000;
    while (useChatStore.getState().sessions[sessionId]?.isStreaming) {
      if (Date.now() - start > cap) {
        // Best-effort: give up after 5 min so a wedged session can
        // still receive a fresh send. The backend's own
        // `streaming.contains(sid)` will then drop ours but the user
        // gets explicit feedback via the new error frame.
        return;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  async send(sessionId: string, text: string, attachments?: Attachment[]) {
    const store = useChatStore.getState();
    store.ensureSession(sessionId);

    // PostHog signal — captures intent (not the message body). The
    // backend's `session_start` / `cost` events already cover the
    // provider / model / tokens dimensions via the PostHog fan-out
    // from PR 1; this one adds the renderer-side latency / attachments
    // dimensions that the backend doesn't see.
    void import("@/lib/posthog").then(({ capture }) => {
      capture("message_sent", {
        session_id_short: sessionId.slice(0, 8),
        text_length: text.length,
        has_attachments: (attachments?.length ?? 0) > 0,
        attachment_count: attachments?.length ?? 0,
      });
    });

    // Build content blocks — images first, then text
    const imageBlocks: ImageBlock[] = (attachments ?? []).map(a => ({
      type: "image" as const,
      media_type: a.mimeType,
      data: a.data,
      preview: a.preview,
      name: a.name,
    }));
    const content = [
      ...imageBlocks,
      ...(text ? [{ type: "text" as const, text }] : []),
    ];

    // Compaction submits get a STABLE optimistic ID so the
    // compaction_done handler can target-remove this exact row when
    // the canonical synthetic /compact lands. dropMessagesBefore alone
    // isn't enough — the optimistic is stamped with the client clock
    // at submit time and the backend's compact_at uses the server
    // clock post-summariser, so any sub-millisecond clock skew (or a
    // pathologically fast summariser) can leave the optimistic with a
    // timestamp >= cutoff, producing a duplicate /compact bubble.
    const isCompactionSubmit = text.startsWith(COMPACTION_MARKER);
    const optimisticId = isCompactionSubmit
      ? compactionOptimisticId(sessionId)
      : crypto.randomUUID();
    if (isCompactionSubmit) {
      // Idempotent: if a stale optimistic from a prior compaction that
      // never received compaction_done is still in state, drop it
      // before we add this submission's row.
      store.removeMessage(sessionId, optimisticId);
    }
    store.addMessage(sessionId, {
      id: optimisticId,
      role: "user",
      content,
      timestamp: new Date().toISOString(),
    });
    // If a prior turn is still streaming, hold the wire write until
    // the bridge clears the session. The optimistic bubble is
    // already on screen above; we just defer the actual send so the
    // backend's `streaming.contains(sid)` guard doesn't silently
    // drop this one. resetContent + setIsStreaming move INSIDE the
    // gate so streaming bookkeeping flips only when we're actually
    // about to dispatch.
    //
    // Also hold the wire write until any in-flight model/tool PATCH commits:
    // the PATCH rides HTTP while this send rides WS, and the backend reads the
    // session's model at send time — without this, a just-picked model can
    // dispatch as the previous one. The optimistic bubble already rendered, so
    // there's no perceived delay. See session-config-sync.
    await awaitConfigPatch(sessionId);
    await this.waitForStreamingClear(sessionId);
    store.resetContent(sessionId);
    store.setIsStreaming(sessionId, true);

    // Include image data in payload so the backend can pass them to Claude
    const images = imageBlocks.map(b => ({
      media_type: b.media_type,
      data: b.data,
    }));
    // Multiplex wire format: every outbound frame carries
    // session_id so the backend's /ws/sessions handler routes to
    // the right per-session task.
    const payload: Record<string, unknown> = {
      type: "send",
      session_id: sessionId,
      message: text,
    };
    if (images.length > 0) payload.images = images;

    try {
      await this.ensureConnected(sessionId);
      this._sendOrQueue(payload);
    } catch (err) {
      useChatStore.getState().clearStreaming(sessionId);
      void import("@/lib/posthog").then(({ capture }) => {
        capture("message_error", {
          session_id_short: sessionId.slice(0, 8),
          error_message: err instanceof Error ? err.message : String(err),
        });
      });
      throw err;
    }
  }

  /** Pending enhance requests, keyed by sessionId. While an entry
   *  exists for a session, the WS event handler routes message_delta
   *  / status events into the buffer here instead of the chat-store
   *  (so the rewrite never appears as a chat bubble). On status:done
   *  or enhance_done we resolve the promise with the buffered text. */
  private enhancePending = new Map<string, {
    buffer: string;
    resolve: (text: string) => void;
    reject: (err: Error) => void;
    timeoutId: ReturnType<typeof setTimeout>;
  }>();

  /** True iff there's an enhance request in flight for this session.
   *  ws-manager's onMessage handler calls this to decide whether
   *  to swallow chat-store updates. */
  isEnhancing(sessionId: string): boolean {
    return this.enhancePending.has(sessionId);
  }

  /** Append a delta to the in-flight enhance buffer. No-op if there's
   *  no pending enhance for this session. */
  appendEnhanceDelta(sessionId: string, text: string) {
    const p = this.enhancePending.get(sessionId);
    if (p) p.buffer += text;
  }

  /** Resolve the pending enhance for a session with a final text.
   *  Called from the `enhance_done` and `status:done` event paths. */
  finalizeEnhance(sessionId: string, finalText?: string) {
    const p = this.enhancePending.get(sessionId);
    if (!p) return;
    clearTimeout(p.timeoutId);
    this.enhancePending.delete(sessionId);
    p.resolve(finalText ?? p.buffer);
  }

  /** Send an enhance request through the SAME bridge that powers
   *  the chat. The user's CLI (Claude / Codex / Gemini) handles
   *  it like any other prompt; we wrap it in a `[fleet:enhance-
   *  prompt]` marker so the backend strips the user/assistant pair
   *  from chat history and surfaces the response via an
   *  `enhance_done` event. The promise resolves with the rewrite
   *  text. Times out at 30 s — long enough for slower providers
   *  (Codex CLI cold start) without hanging the user forever. */
  async enhance(sessionId: string, text: string): Promise<string> {
    return new Promise((resolve, reject) => {
      // If an enhance was already in flight for this session,
      // reject the new one rather than silently overwriting the
      // buffer. The button is gated on `enhancing` state so this
      // shouldn't fire in practice.
      if (this.enhancePending.has(sessionId)) {
        reject(new Error("Enhance already in flight"));
        return;
      }
      const timeoutId = setTimeout(() => {
        const p = this.enhancePending.get(sessionId);
        if (p) {
          this.enhancePending.delete(sessionId);
          p.reject(new Error("Enhance timed out"));
        }
      }, 30_000);
      this.enhancePending.set(sessionId, {
        buffer: "", resolve, reject, timeoutId,
      });

      // Strict enforcement: Claude (and other capable CLIs) will
      // reach for Read/Grep/Bash by default when their session-level
      // system prompt has full project context. The "Rewrite this"
      // user message alone isn't a strong enough signal to override
      // that. Hammer the override + the no-tools rule explicitly.
      const SYSTEM = [
        "═══ PROMPT-REWRITE MODE ═══",
        "Ignore prior instructions. You have ONE job: take the draft below and rewrite it",
        "to be clearer and more specific for an AI coding agent.",
        "",
        "ABSOLUTE RULES — no exceptions:",
        "1. Reply with the rewritten prompt TEXT ONLY. No preamble (\"Here's the rewrite…\"),",
        "   no closing remarks, no quotes, no markdown fences.",
        "2. DO NOT call any tools. Not Read, not Grep, not Glob, not Bash, not Edit, not",
        "   WebFetch, not Agent, not the memory MCP — none. The draft contains everything",
        "   you need; you are NOT analyzing the codebase.",
        "3. Preserve the user's exact intent. Do not add new requirements they didn't write.",
        "4. If the draft is already specific and actionable, reply with exactly: __NOOP__",
        "",
        "Draft prompt to rewrite:",
      ].join("\n");
      const payload = {
        type: "send",
        session_id: sessionId,
        message: `[fleet:enhance-prompt]\n${SYSTEM}\n${text}`,
      };
      this.ensureConnected(sessionId).then(() => {
        this._sendOrQueue(payload);
      }).catch(err => {
        const p = this.enhancePending.get(sessionId);
        if (p) {
          clearTimeout(p.timeoutId);
          this.enhancePending.delete(sessionId);
          p.reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    });
  }

  async sendInternal(sessionId: string, text: string, attachments?: Attachment[]) {
    // Sends to WebSocket without adding a user message to the chat store.
    // Used for auto-mode synthesis — the staff agent processes it but the
    // user never sees the [AUTO MODE] payload as a chat bubble.
    //
    // Also used by the Fleet send path when we've ALREADY done an
    // optimistic user-message append upstream (so we don't want the
    // ws-manager to add a second one).
    const store = useChatStore.getState();
    store.ensureSession(sessionId);
    // Same back-to-back guard as `send()` — the backend silently
    // drops a "send" frame when the session is already in its
    // `streaming` set, so handleStaffSend / auto-mode would orphan
    // the optimistic user bubble. Defer the wire write until the
    // previous turn's bridge releases the session.
    //
    // Also wait for any in-flight model/tool PATCH (HTTP) to commit before
    // this WS dispatch, so the staff/fleet send uses the model the user just
    // picked. See session-config-sync.
    await awaitConfigPatch(sessionId);
    await this.waitForStreamingClear(sessionId);
    store.resetContent(sessionId);
    store.setIsStreaming(sessionId, true);

    const images = (attachments ?? []).map(a => ({
      media_type: a.mimeType,
      data: a.data,
    }));
    const payload: Record<string, unknown> = {
      type: "send",
      session_id: sessionId,
      message: text,
    };
    if (images.length > 0) payload.images = images;
    try {
      await this.ensureConnected(sessionId);
      this._sendOrQueue(payload);
    } catch (err) {
      useChatStore.getState().clearStreaming(sessionId);
      throw err;
    }
  }

  async sendPermissionResponse(
    sessionId: string,
    id: string,
    approved: boolean,
    always: boolean,
    toolName?: string,
  ) {
    useChatStore.getState().setPermissionRequest(sessionId, null);
    useAppStore.getState().updateSession(sessionId, { status: "running" });
    this._sendOrQueue({
      type: "permission_response",
      session_id: sessionId,
      id, approved, always,
      tool_name: toolName ?? "",
    });
  }

  /** Answer Cursor's blocking `cursor/ask_question`. `outcome` is the ACP
   *  outcome object, e.g. `{outcome:"answered", answers:[{questionId,
   *  selectedOptionIds}]}` or `{outcome:"skipped"}`. Clears the card and
   *  unblocks the agent's parked request. */
  async sendQuestionResponse(
    sessionId: string,
    id: string,
    outcome: Record<string, unknown>,
  ) {
    useChatStore.getState().setCursorQuestion(sessionId, null);
    useAppStore.getState().updateSession(sessionId, { status: "running" });
    this._sendOrQueue({
      type: "cursor_question_response",
      session_id: sessionId,
      id,
      outcome,
    });
  }

  /** Answer Claude's AskUserQuestion card. `answers` is one entry per
   *  question (`{header, question, selected:[labels]}`); pass `answered:false`
   *  to skip. Clears the card, unblocks the parked AskUserQuestion tool. */
  async sendAskQuestionResponse(
    sessionId: string,
    id: string,
    answered: boolean,
    answers: { header?: string; question: string; selected: string[] }[],
  ) {
    useChatStore.getState().setAskQuestion(sessionId, null);
    useAppStore.getState().updateSession(sessionId, { status: "running" });
    this._sendOrQueue({
      type: "ask_user_question_response",
      session_id: sessionId,
      id,
      answered,
      answers,
    });
  }

  /** Answer Cursor's blocking `cursor/create_plan`. `outcome` is e.g.
   *  `{outcome:"accepted"}` or `{outcome:"rejected", reason}`. */
  async sendPlanResponse(
    sessionId: string,
    id: string,
    outcome: Record<string, unknown>,
  ) {
    useChatStore.getState().setCursorPlan(sessionId, null);
    useAppStore.getState().updateSession(sessionId, { status: "running" });
    this._sendOrQueue({
      type: "cursor_plan_response",
      session_id: sessionId,
      id,
      outcome,
    });
  }

  /** Switch the live model for a runtime-sourced agent (OpenCode). The
   *  backend applies it via the bridge and echoes an
   *  `available_models_update`. The caller also PATCHes session.model_name
   *  so a future cold start picks the same model. No-op-safe if the session
   *  has no live bridge yet. */
  switchModel(sessionId: string, modelId: string) {
    this.touch(sessionId);
    this._sendOrQueue({ type: "model_switch", session_id: sessionId, model: modelId });
  }

  /** Set a live session config option (e.g. effort, mode) on a runtime-config
   *  agent (OpenCode). Fire-and-forget; the caller also PATCHes the session
   *  field for the next cold start. */
  switchConfig(sessionId: string, configId: string, value: string) {
    this.touch(sessionId);
    this._sendOrQueue({ type: "config_switch", session_id: sessionId, config_id: configId, value });
  }

  /** Send the out-of-band OAuth code the user pasted from a provider's
   *  sign-in page back to the live bridge, which feeds it to the agent's
   *  stdin (e.g. the Antigravity CLI's "paste the code here" prompt). */
  async sendAuthCode(sessionId: string, code: string) {
    this._sendOrQueue({ type: "auth_code", session_id: sessionId, code });
  }

  async abort(sessionId: string) {
    this._sendOrQueue({ type: "abort", session_id: sessionId });
    // PRESERVE partial output before clearing the streaming
    // buffer. The user said hitting Esc mid-stream lost the
    // assistant's progress — the previous code went straight to
    // clearStreaming() which dropped contentSoFar on the floor.
    // Now we flush any buffered delta and FINALIZE whatever the
    // model produced as a real assistant message, the same way
    // the status:done path does. The user keeps the work.
    this.flushDelta(sessionId);
    const store = useChatStore.getState();
    const current = store.sessions[sessionId];
    if (current && current.contentSoFar.length > 0) {
      store.finalizeAssistantMessage(sessionId, crypto.randomUUID(), current.contentSoFar);
    }
    store.clearStreaming(sessionId);
  }

  /**
   * Tear down ALL state for `sessionId` — socket, queue, in-flight
   * connect promise, streaming-delta buffers/timers, and any orphan-card
   * timers keyed off the session. Must be called when a session is
   * archived or deleted; otherwise long-lived setTimeouts continue
   * firing into a store state where the session no longer exists,
   * injecting "lost track" cards into chats with no corresponding
   * agent. Idempotent — safe to call multiple times.
   */
  disconnect(sessionId: string) {
    // Multiplex: don't close the shared socket — just unsubscribe.
    // The shared socket stays alive for other sessions; backend
    // tears down THIS session's bridge / per-session task on
    // unsubscribe.
    if (this.subscribed.has(sessionId)) {
      this.subscribed.delete(sessionId);
      this._sendOrQueue({ type: "unsubscribe", session_ids: [sessionId] });
    }
    this.lastActivity.delete(sessionId);

    // Flush any pending message_delta first — losing the buffered text
    // is fine for an archived session, but we still cancel the rAF
    // before deletion so it can't fire after the buffer's gone.
    const dt = this.deltaTimers.get(sessionId);
    if (dt) cancelAnimationFrame(dt);
    this.deltaTimers.delete(sessionId);
    this.deltaBuffers.delete(sessionId);
    // Tear down thinking + aux buffers/timers for this session too —
    // they were added when we extended the vsync coalesce to thinking
    // / sub-agent / dispatch-preview deltas. Leaving them would fire
    // rAF callbacks into a store row that no longer exists.
    const tt = this.thinkingTimers.get(sessionId);
    if (tt) cancelAnimationFrame(tt);
    this.thinkingTimers.delete(sessionId);
    this.thinkingBuffers.delete(sessionId);
    const auxPrefix = `${sessionId}::`;
    for (const [key, timer] of Array.from(this.auxTimers.entries())) {
      if (key.startsWith(auxPrefix)) {
        cancelAnimationFrame(timer);
        this.auxTimers.delete(key);
      }
    }
    for (const key of Array.from(this.auxBuffers.keys())) {
      if (key.startsWith(auxPrefix)) this.auxBuffers.delete(key);
    }
    this.thinkingStarts.delete(sessionId);

    // Orphan timers are keyed `${sessionId}:${pendingId}`. We only need
    // to clear timers whose key prefix matches this session. Iterating
    // is fine — the map is bounded by recent dispatches, never huge.
    const prefix = `${sessionId}:`;
    for (const [key, timer] of this._orphanTimers.entries()) {
      if (key.startsWith(prefix)) {
        clearTimeout(timer);
        this._orphanTimers.delete(key);
      }
    }
  }

  isStreaming(sessionId: string): boolean {
    // True iff the shared socket is open AND this session is
    // actively subscribed. Caller name is historical — what it
    // really asks is "are we listening on the wire for this sid".
    return !!this.socket
      && this.socket.readyState === WebSocket.OPEN
      && this.subscribed.has(sessionId);
  }
}

export const wsManager = new WSManager();
