import { useEffect, useRef, useCallback, useState, useMemo, memo } from "react";
import { useAppStore } from "@/stores/app-store";
import { useChatStore, selectSession, typeOutAssistantMessage } from "@/stores/chat-store";
import { wsManager, compactionOptimisticId } from "@/services/ws-manager";
import { ChatInput, type Attachment } from "./chat-input";
import { MessageContent, StreamingMessage } from "./message-content";
import { CompactionPill } from "./compaction-pill";
import { PermissionDialog } from "./permission-dialog";
import { SessionToolbar } from "./session-toolbar";
import { fetchMessages, fetchClaudeHistory, createSession, clearSessionMessages, updateSession as apiUpdateSession, stopSession, restartSession, analyzeFleetResponse } from "@/lib/api";
import { isWindowsPlatform, folderName } from "@/lib/utils";
import { FleetDecisionCard } from "./fleet-decision-card";
import { useFleetStore, AUTO_CHAIN_CAP } from "@/stores/fleet-store";
import { LogoMark } from "@/components/brand/logo-mark";
import { PanelLeft, PanelRight, Trash2, X, Check, CheckCircle2, AlertCircle, GitCompareArrows, ListTodo, Terminal as TerminalIcon, ChevronDown, Keyboard, Folder, Play, FolderOpen, Layers, Monitor, Github, Server, Box, ArrowRight, ExternalLink } from "lucide-react";
import type { ContentBlock, ChatMessage } from "@/types/chat";
import type { Session } from "@/types/session";
import type { WorkspaceView } from "@/stores/app-store";

/** Memoised message list — the filter + lastUserIdx + map() block
 *  was an inline IIFE inside ChatView, which re-renders on every
 *  streaming-token delta (it subscribes to streamingText to drive
 *  the live bubble below). 30 deltas/sec × full re-walk of every
 *  message (with content-block scan for the auto-intro marker)
 *  burns CPU producing JSX that React then has to diff against
 *  itself. Splitting into its own memo'd component means the work
 *  runs only when `messages` actually changes. MessageContent is
 *  React.memo'd downstream so the rows themselves bail out cheaply.
 *
 *  `latestUserMsgRef` is a ref object — stable across renders, so
 *  passing it as a prop doesn't invalidate memo. */
const MessageList = memo(function MessageList({
  messages,
  latestUserMsgRef,
}: {
  messages: ChatMessage[];
  latestUserMsgRef: React.RefObject<HTMLDivElement | null>;
}) {
  // Filter out the silent auto-intro marker prompt even if a session
  // was created before the backend skip-persistence fix landed (those
  // rows still live in the DB). Belt-and-suspenders so the
  // [fleet:auto-intro] payload never shows in chat.
  const visible = messages.filter(m => {
    if (m.role !== "user") return true;
    const firstText = m.content.find(b => (b as { type: string }).type === "text") as { text?: string } | undefined;
    return !firstText?.text?.startsWith("[fleet:auto-intro]");
  });
  const lastUserIdx = visible.map((m) => m.role).lastIndexOf("user");
  return (
    <>
      {visible.map((m, i) => (
        <MessageContent
          key={m.id}
          message={m}
          msgRef={i === lastUserIdx ? latestUserMsgRef : undefined}
        />
      ))}
    </>
  );
});

export function ChatView({ paneSessionId, paneIdx, onClosePane }: {
  /** When set, this ChatView instance is rendering inside a split-
   *  pane grid and is bound to THIS sessionId rather than the global
   *  activeSessionId. The store's activeSessionId still drives the
   *  sidebar's "selected" state and any Fleet-wide actions, but every
   *  internal session-scoped read inside this ChatView (messages,
   *  toolbar, input) routes through the override. */
  paneSessionId?: string | null;
  /** Pane's index in splitPaneIds — used to wire close/focus
   *  affordances back to the store. */
  paneIdx?: number;
  /** Click handler for the pane's close button — only rendered
   *  when this ChatView is inside the split grid. */
  onClosePane?: () => void;
} = {}) {
  // ── Granular app-store selectors ──
  // Was: a single destructure of useAppStore() — Zustand returns the
  // entire state, so every notification push, sidebar toggle, status
  // change, and session-list refresh re-rendered the chat surface.
  // With no React.memo on MessageContent (now fixed), each of those
  // re-renders cascaded through every message, every dispatch card,
  // and the input area. Per-field selectors return primitives or
  // function references (stable across renders) → re-render only
  // when the specific field actually changes.
  const storeActiveSessionId = useAppStore((s) => s.activeSessionId);
  // When mounted as a split-pane child, the prop wins; the global
  // activeSessionId is used as the fallback (i.e., legacy single
  // ChatView path remains unchanged).
  const activeSessionId    = paneSessionId !== undefined
    ? paneSessionId
    : storeActiveSessionId;
  const staffSessionId     = useAppStore((s) => s.staffSessionId);
  const sessions           = useAppStore((s) => s.sessions);
  const toggleSidebar      = useAppStore((s) => s.toggleSidebar);
  const setActiveSession   = useAppStore((s) => s.setActiveSession);
  const setStaffSessionId  = useAppStore((s) => s.setStaffSessionId);
  const updateSession      = useAppStore((s) => s.updateSession);
  const addSession         = useAppStore((s) => s.addSession);
  const toggleRightPanel   = useAppStore((s) => s.toggleRightPanel);
  const addWorkspaceView   = useAppStore((s) => s.addWorkspaceView);
  const removeWorkspaceView = useAppStore((s) => s.removeWorkspaceView);
  const openWorkspaceViews = useAppStore((s) => s.openWorkspaceViews);
  // Pane-scoped right panel state — only used when this ChatView
  // is rendered inside a split-pane. The PanelViewMenu below
  // routes its toggle / view-pick through these instead of the
  // global ones in pane mode.
  const paneRightOpenById  = useAppStore((s) => s.paneRightOpen);
  const paneViewsById      = useAppStore((s) => s.paneWorkspaceViews);
  const togglePaneRight    = useAppStore((s) => s.togglePaneRightPanel);
  const paneAddView        = useAppStore((s) => s.paneAddWorkspaceView);
  const paneRemoveView     = useAppStore((s) => s.paneRemoveWorkspaceView);
  const transcriptFontScale = useAppStore((s) => s.transcriptFontScale);
  const rightPanelOpen     = useAppStore((s) => s.rightPanelOpen);
  // workspaceView (single-active legacy field) is no longer read here —
  // PanelViewMenu drives off the openWorkspaceViews multi-pick array.
  const sidebarCollapsed   = useAppStore((s) => s.sidebarCollapsed);
  // On Windows the dedicated title bar above the shell already owns
  // a sidebar toggle, so the chat-header toggle (and the macOS
  // traffic-light inset it lives in) is suppressed there.
  const isWindows          = useMemo(() => isWindowsPlatform(), []);
  const fleetAutoMode      = useAppStore((s) => s.fleetAutoMode);
  const toggleFleetAutoMode = useAppStore((s) => s.toggleFleetAutoMode);
  const beginDraft         = useAppStore((s) => s.beginDraft);
  const commitDraft        = useAppStore((s) => s.commitDraft);

  const effectiveSessionId = activeSessionId || staffSessionId;

  const sessionState = useChatStore(selectSession(effectiveSessionId));
  const { messages, streamingText, streamingThinking, isStreaming, permissionRequest, compactionPill } = sessionState;
  // True while the inline compaction status owns the feedback surface.
  // Lets us hide the streaming "Thinking…" UI for /compact since the
  // flow never runs an agent turn — it's app-owned summarisation.
  const compactionPillActive = compactionPill?.state === "running";

  const setMessages = useChatStore((s) => s.setMessages);
  const clearAllForSession = useChatStore((s) => s.clearAll);
  const ensureSession = useChatStore((s) => s.ensureSession);

  // Active session — direct lookup. Local-only (draft) sessions now
  // live in `sessions[]` carrying `local_only: true`, so the old
  // draft-singleton fallback branch is gone. Header title, chip
  // strip, toolbar all read the same shape regardless of whether
  // the user has committed yet.
  const activeSession = useMemo<Session | undefined>(
    () => sessions.find((s) => s.id === activeSessionId),
    [sessions, activeSessionId],
  );
  const isLocalOnlyActive = activeSession?.local_only === true;

  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const latestUserMsgRef = useRef<HTMLDivElement>(null);
  const staffIdRef = useRef(staffSessionId);
  const creatingStaffRef = useRef(false);
  const loadedSessionsRef = useRef<Set<string>>(new Set());
  // ── Pagination state, per session ──
  // hasMoreRef[sid] = true means there's likely older history on the
  // server. Set to false once a fetch returns less than `limit`.
  // loadingMoreRef[sid] gates concurrent scroll-up fetches.
  // effectiveSessionIdRef carries the CURRENT session id for closures
  // (the scroll handler) that registered before the user navigated;
  // without it the closure reads the stale id from first mount and
  // paginates against the wrong session.
  const hasMoreRef = useRef<Map<string, boolean>>(new Map());
  const loadingMoreRef = useRef<Map<string, boolean>>(new Map());
  const effectiveSessionIdRef = useRef<string | null>(null);
  // Sessions that already had their auto-intro prompt fired. Without
  // this guard the effect below would re-fire every render the moment
  // its dependencies churned (e.g. activeSession reference changes
  // on store updates).
  const autoIntroFiredRef = useRef<Set<string>>(new Set());
  // Sessions whose auto-intro response has already been parsed for
  // a title. Without this guard the title-parse effect would fire on
  // every messages change forever.
  const autoIntroTitleParsedRef = useRef<Set<string>>(new Set());
  // Sessions that already got the post-analysis "ready when you are"
  // typewriter card appended. Same idea as the title-parsed guard —
  // we need a "fired-once" flag so a streaming-state churn doesn't
  // print the card a second time.
  const autoIntroReadyShownRef = useRef<Set<string>>(new Set());
  // Per-draft fired flag for the 10s welcome typewriter. Without it
  // the effect would re-fire every time the draft object reference
  // churned (every setDraftField call rebuilds the object), spamming
  // the chat with duplicate welcome messages.
  const draftWelcomeFiredRef = useRef<Set<string>>(new Set());

  const [scrollSpacer, setScrollSpacer] = useState(0);
  const userScrolledUp = useRef(false);
  const scrollToUserMsg = useRef(false);
  const pinnedToExchange = useRef(false);
  const sendLock = useRef(false);

  useEffect(() => { staffIdRef.current = staffSessionId; }, [staffSessionId]);

  // ── Prune the per-session ref Sets when sessions go away ──
  // Without this, autoIntroFiredRef / autoIntroTitleParsedRef /
  // autoIntroReadyShownRef / loadedSessionsRef accumulate every
  // session id this client has ever opened. Across weeks of use
  // (hundreds of session opens) the Sets become an unbounded leak.
  // Pruning is cheap: build a hash of currently-known ids, drop any
  // tracked id that isn't there. Runs only when the session-id list
  // actually changes (we hash to a string for the dep so a status
  // update doesn't churn this effect).
  const sessionIdSig = sessions.map(s => s.id).join(",");
  useEffect(() => {
    const live = new Set(sessions.map(s => s.id));
    const prune = (ref: React.MutableRefObject<Set<string>>) => {
      let dropped = false;
      for (const id of ref.current) {
        if (!live.has(id)) { ref.current.delete(id); dropped = true; }
      }
      return dropped;
    };
    prune(autoIntroFiredRef);
    prune(draftWelcomeFiredRef);
    prune(autoIntroTitleParsedRef);
    prune(autoIntroReadyShownRef);
    prune(loadedSessionsRef);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionIdSig]);

  // ── Traffic-light auto-align disabled ──
  // This effect used to measure the chat-header toggle's rendered
  // position and push the OS traffic lights to match its center.
  // The user wants the lights at the canonical top-left corner
  // (x:14, y:14) — set by Electron's BrowserWindow config — and
  // for them to STAY there. The renderer override silently moved
  // them back to (22, ~32) on every layout change, which is why
  // the main-process update kept "not taking effect". We leave
  // the IPC handler in main.cjs in case some future surface needs
  // it, but this hook no longer calls it.
  useEffect(() => {
    return; // intentional no-op — see comment above
  }, []);
  useEffect(() => { effectiveSessionIdRef.current = effectiveSessionId; }, [effectiveSessionId]);

  // Detect manual scroll so we can unpin and resume auto-scroll
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      if (sendLock.current) return;
      const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      userScrolledUp.current = distFromBottom > 80;
      if (distFromBottom < 80) pinnedToExchange.current = false;

      // ── Infinite scroll: load older history when near top ──
      // Trigger when scrollTop drops below 200px AND we believe
      // there are more messages on the server AND no fetch is in
      // flight for this session. Preserves scroll position by
      // measuring scrollHeight before/after the prepend so the
      // user's reading anchor doesn't jump.
      const sid = effectiveSessionIdRef.current;
      // Local-only (compose-phase) sessions have no backend row;
      // fetching older history would 404. The welcome message's
      // timestamp would otherwise satisfy `oldest.timestamp` below
      // and fire one request. Look up via useAppStore.getState() so
      // the closure stays stable when activeSession identity churns.
      const sidIsLocalOnly = sid
        ? !!useAppStore.getState().sessions.find(s => s.id === sid)?.local_only
        : false;
      if (
        el.scrollTop < 200 &&
        sid &&
        !sidIsLocalOnly &&
        hasMoreRef.current.get(sid) !== false &&
        !loadingMoreRef.current.get(sid)
      ) {
        const cur = useChatStore.getState().sessions[sid]?.messages ?? [];
        if (cur.length === 0) return;
        const oldest = cur[0]!;
        if (!oldest.timestamp) return;
        loadingMoreRef.current.set(sid, true);
        const prevHeight = el.scrollHeight;
        const prevTop = el.scrollTop;
        fetchMessages(sid, { limit: 50, before: oldest.timestamp })
          .then((older) => {
            if (!Array.isArray(older) || older.length === 0) {
              hasMoreRef.current.set(sid, false);
              return;
            }
            const parsed = older.map(parseContent);
            const stillCur = useChatStore.getState().sessions[sid]?.messages ?? [];
            // Prepend; dedupe by id in case of overlap.
            const seen = new Set(stillCur.map((m) => m.id));
            const merged = [...parsed.filter((m) => !seen.has(m.id)), ...stillCur];
            useChatStore.getState().setMessages(sid, merged);
            if (older.length < 50) {
              hasMoreRef.current.set(sid, false);
            }
            // Restore scroll position so the user's reading anchor stays
            // put. Without this, prepending shoves their content down
            // the screen and the chat appears to "teleport".
            requestAnimationFrame(() => {
              const elNow = scrollRef.current;
              if (elNow) {
                const delta = elNow.scrollHeight - prevHeight;
                elNow.scrollTop = prevTop + delta;
              }
            });
          })
          .catch(() => { /* silent — next scroll-up will retry */ })
          .finally(() => { loadingMoreRef.current.set(sid, false); });
      }
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  // effectiveSessionId is read inside the handler — ESLint flags this
  // as a missing dep but we DON'T want to rebind the listener on every
  // session switch (it'd remount the scroll surface state). The closure
  // reads from store-fresh refs so always sees the current session.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // When a new message arrives: pin to user message (fresh exchange feel)
  useEffect(() => {
    if (scrollToUserMsg.current) {
      scrollToUserMsg.current = false;
      userScrolledUp.current = false;
      // Single rAF for layout flush — then instant jump (no smooth, no lag)
      requestAnimationFrame(() => {
        const el = latestUserMsgRef.current;
        const container = scrollRef.current;
        if (!el || !container) return;
        const elRect = el.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();
        const targetScrollTop = container.scrollTop + (elRect.top - containerRect.top) - 20;
        container.scrollTop = Math.max(0, targetScrollTop);
      });
    } else if (!userScrolledUp.current && !pinnedToExchange.current) {
      bottomRef.current?.scrollIntoView({ block: "end" });
    }
  }, [messages]);

  useEffect(() => {
    if (!isStreaming && scrollSpacer > 0) {
      setScrollSpacer(0);
      pinnedToExchange.current = false;
      // Instant jump to bottom — smooth scroll here feels slow and anticlimactic
      requestAnimationFrame(() => {
        const el = scrollRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      });
    }
  }, [isStreaming, scrollSpacer]);

  // Direct scrollTop avoids layout-sync from scrollIntoView on every streamed token
  useEffect(() => {
    if (isStreaming && !pinnedToExchange.current) {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }
  }, [streamingText, isStreaming]);

  // Reset scroll tracking when switching sessions — state itself persists.
  useEffect(() => {
    userScrolledUp.current = false;
    pinnedToExchange.current = false;
    scrollToUserMsg.current = false;
    sendLock.current = false;
  }, [effectiveSessionId]);

  // Shared message parser — lifted so both effects below can use it
  const parseContent = useCallback((m: { content: string | ContentBlock[]; [k: string]: unknown }) => {
    let content: ContentBlock[];
    try {
      content = typeof m.content === "string" ? JSON.parse(m.content as string) : (m.content as ContentBlock[]);
    } catch {
      content = [{ type: "text" as const, text: typeof m.content === "string" ? m.content : "" }];
    }
    return { ...m, content } as ChatMessage;
  }, []);

  // Load message history every time the user opens a session.
  //
  // Why this re-fetches every time (instead of caching per-session):
  // background dispatches land user messages in the target agent's DB
  // while that agent's chat isn't currently the active view (and so
  // its WebSocket isn't connected to receive `dispatch_incoming`).
  // If we trusted the in-memory cache, those messages would be
  // invisible to the user when they navigated back — a real bug,
  // observed in practice. Refetching on every session-open costs one
  // DB round-trip and keeps the chat truthful.
  //
  // Deps deliberately include only `effectiveSessionId` — previous
  // versions also depended on `sessions`, which changed on every SSE
  // status update (every ~5s) and caused refetch storms.
  useEffect(() => {
    if (!effectiveSessionId) return;
    ensureSession(effectiveSessionId);

    // Local-only guard: a draft (compose-phase) session has no
    // backend row yet, so fetchMessages would 404 and flash a
    // per-session error state inside an otherwise-empty surface.
    const here = useAppStore.getState().sessions.find(s => s.id === effectiveSessionId);
    if (here?.local_only) {
      loadedSessionsRef.current.add(effectiveSessionId);
      return;
    }

    const state = useChatStore.getState().sessions[effectiveSessionId];
    // Skip refetch ONLY while a stream is in flight — overwriting the
    // store with stale DB state would clobber live message_delta tokens.
    if (state && state.isStreaming) {
      loadedSessionsRef.current.add(effectiveSessionId);
      return;
    }

    const ac = new AbortController();
    let cancelled = false;
    (async () => {
      try {
        // Initial load: latest 50 messages only. Older history is fetched
        // lazily when the user scrolls near the top (see the
        // scroll-up-to-load handler below). Cuts the chat-open render cost
        // on long conversations from "render 500 messages with markdown
        // re-parse" to "render 50".
        const msgs = await fetchMessages(effectiveSessionId, { limit: 50 });
        if (cancelled) return;
        if (Array.isArray(msgs) && msgs.length > 0) {
          setMessages(effectiveSessionId, msgs.map(parseContent));
          // Mark that there might be more to fetch when user scrolls up.
          // The exact "older messages exist" determination happens on the
          // first scroll-up fetch — if it returns < limit, we know we hit
          // the head and stop trying.
          hasMoreRef.current.set(effectiveSessionId, msgs.length >= 50);
        } else {
          // Read sessions via getState() so this effect doesn't depend
          // on the `sessions` array (avoids refetch storms on every
          // SSE status update).
          const allSessions = useAppStore.getState().sessions;
          const session = allSessions.find((s) => s.id === effectiveSessionId);
          // Preserve any locally-added messages (e.g. the AI welcome
          // injected by createDraftSession, or validation warnings)
          // when the server has nothing to return. Without this guard
          // the empty-array path would wipe the welcome the user just
          // saw flash on screen.
          const localMsgs = useChatStore.getState().sessions[effectiveSessionId]?.messages ?? [];
          if (session?.claude_session_id) {
            const history = await fetchClaudeHistory(effectiveSessionId).catch(() => []);
            if (cancelled) return;
            // Backend can return mixed shapes during a migration. Filter to
            // anything that at least looks like a ChatMessage so the UI
            // doesn't crash on malformed entries.
            const safe: ChatMessage[] = Array.isArray(history)
              ? (history as unknown[]).flatMap((h) =>
                  h && typeof h === "object" && "role" in (h as object)
                    ? [h as ChatMessage]
                    : [],
                )
              : [];
            if (safe.length > 0 || localMsgs.length === 0) {
              setMessages(effectiveSessionId, safe);
            }
          } else if (localMsgs.length === 0) {
            setMessages(effectiveSessionId, []);
          }
        }
      } catch {
        const localMsgs = useChatStore.getState().sessions[effectiveSessionId]?.messages ?? [];
        if (!cancelled && localMsgs.length === 0) setMessages(effectiveSessionId, []);
      } finally {
        if (!cancelled) loadedSessionsRef.current.add(effectiveSessionId);
      }
    })();
    return () => { cancelled = true; ac.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveSessionId]);

  // Pre-warm the WebSocket for the session the user is currently viewing so
  // there's no handshake delay when they press send. The manager keeps the
  // socket alive across navigation, which is the whole point of this refactor.
  //
  // Local-only guard: a compose-phase session lives only in renderer
  // state — the backend has never seen its id. Subscribing to
  // /ws/sessions for it makes the multiplex socket immediately reply
  // "Session not found", which the renderer surfaces as a system
  // "Task failed" message inside the empty draft. We skip the connect
  // entirely until commitDraft swaps in a real backend row.
  useEffect(() => {
    if (!effectiveSessionId) return;
    if (isLocalOnlyActive) return;
    wsManager.ensureConnected(effectiveSessionId).catch(() => {});
    // Race-recovery for Fleet → target dispatches. If this session is
    // currently the target of an in-flight dispatch (global
    // `dispatchPreviews[sid]` entry exists, set by the staff's
    // dispatch_ack handler in ws-manager), bootstrap `isStreaming` here
    // even if the per-target `dispatch_incoming` event was missed —
    // which used to happen when the target was unsubscribed at
    // dispatch time and the proactive ensureConnected from dispatch_ack
    // landed milliseconds after the bridge had already emitted its
    // `dispatch_incoming`. The defense-in-depth pair (proactive
    // subscribe + this mount-time bootstrap) closes the window.
    // Without this, the "Thinking…" indicator stayed invisible inside
    // the target's chat even though the agent was clearly working.
    const chat = useChatStore.getState();
    if (chat.dispatchPreviews[effectiveSessionId] && !chat.sessions[effectiveSessionId]?.isStreaming) {
      chat.setIsStreaming(effectiveSessionId, true);
    }
  }, [effectiveSessionId, isLocalOnlyActive]);

  const sendViaWs = useCallback(async (text: string, sessionId: string, attachments?: Attachment[]) => {
    scrollToUserMsg.current = true;
    pinnedToExchange.current = true;
    sendLock.current = true;
    setTimeout(() => { sendLock.current = false; }, 600);
    setScrollSpacer(typeof window !== "undefined" ? window.innerHeight : 900);
    try {
      await wsManager.send(sessionId, text, attachments);
    } catch (err) {
      console.error("send failed:", err);
    }
  }, []);

  const handleStop = useCallback(() => {
    if (effectiveSessionId) wsManager.abort(effectiveSessionId);
  }, [effectiveSessionId]);

  // Global ESC to abort streaming
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isStreaming) { e.preventDefault(); handleStop(); }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isStreaming, handleStop]);

  const handleModelChange = useCallback((sessionId: string, modelId: string) => {
    updateSession(sessionId, { model_name: modelId });
    apiUpdateSession(sessionId, { model_name: modelId }).catch(() => {});
  }, [updateSession]);

  const handleClearChat = useCallback(async () => {
    if (!effectiveSessionId) return;
    try {
      await clearSessionMessages(effectiveSessionId);
    } catch { /* best effort */ }
    clearAllForSession(effectiveSessionId);
    loadedSessionsRef.current.delete(effectiveSessionId);
  }, [effectiveSessionId, clearAllForSession]);

  // Staff agent send — creates the session lazily if it doesn't exist yet.
  const handleStaffSend = useCallback(async (text: string, attachments?: Attachment[]) => {
    if (text.trim() === "/new") { void beginDraft(); return; }

    // Compaction takes priority over any of the fleet send wrapping
    // below. The chat-input has already tagged the payload with
    // [fleet:compaction]; we must send it through verbatim — adding
    // FLEET STATUS / AUTO MODE prefixes would push the marker off the
    // start of the string and break the backend's startswith() detect.
    const isCompactionPayload = text.startsWith("[fleet:compaction]");

    const _nowStr = () => new Date().toISOString();
    const _addReply = (sid: string | null, msg: string) => {
      // The previous version wrote under a fake sessionId of "fleet"
      // when staffSessionId was null — those messages went into a
      // store key no view ever read, so /status etc. silently
      // disappeared. If the staff session doesn't exist yet, surface
      // the reply as a transient toast instead and trigger the lazy
      // create flow upstream.
      if (!sid) {
        // Last-ditch surface: write to console + push a notification so
        // the user at least sees the slash-command response.
        console.warn("[staff slash] no staff session yet — reply suppressed:", msg);
        useAppStore.getState().pushNotification({
          id: crypto.randomUUID(),
          sessionId: "",
          title: "Fleetify",
          summary: msg.slice(0, 200),
          success: true,
          timestamp: Date.now(),
        });
        return;
      }
      useChatStore.getState().addMessage(sid, {
        id: crypto.randomUUID(), role: "assistant",
        content: [{ type: "text", text: msg }], timestamp: _nowStr(),
      });
    };

    // ── Slash command: /status ───────────────────────────────────────────────
    if (text.trim() === "/status") {
      const { sessions: ss, staffSessionId: sid } = useAppStore.getState();
      const agents = ss.filter(s => s.id !== sid && !(s as Session & { archived_at?: string | null }).archived_at && (s.title || "").trim() !== "New chat");
      const lines = agents.length === 0
        ? ["No agents running."]
        : agents.map(s => `${s.status === "running" ? "●" : "○"} ${s.title} — ${s.status}`);
      _addReply(sid, `Fleet Status\n\n${lines.join("\n")}`);
      return;
    }

    // ── Slash command: /stop ─────────────────────────────────────────────────
    const stopMatch = text.trim().match(/^\/stop\s*(all|@\S+)?$/i);
    if (stopMatch) {
      const { sessions: ss, staffSessionId: sid } = useAppStore.getState();
      const agents = ss.filter(s => s.id !== sid && !(s as Session & { archived_at?: string | null }).archived_at && (s.title || "").trim() !== "New chat");
      const target = stopMatch[1]?.toLowerCase();
      const toStop = target === "all" || !target
        ? agents.filter(s => s.status === "running" || s.status === "starting" || s.status === "waiting")
        : agents.filter(s => s.title.toLowerCase() === target?.replace("@", ""));
      if (toStop.length === 0) {
        _addReply(sid, "No matching running agents found.");
      } else {
        await Promise.all(toStop.map(s => { wsManager.abort(s.id); return stopSession(s.id).catch(() => {}); }));
        _addReply(sid, `Stopped: ${toStop.map(s => s.title).join(", ")}`);
      }
      return;
    }

    // ── Slash command: /restart ──────────────────────────────────────────────
    const restartMatch = text.trim().match(/^\/restart\s*(@\S+)?$/i);
    if (restartMatch) {
      const { sessions: ss, staffSessionId: sid } = useAppStore.getState();
      const agents = ss.filter(s => s.id !== sid && !(s as Session & { archived_at?: string | null }).archived_at && (s.title || "").trim() !== "New chat");
      const target = restartMatch[1]?.toLowerCase().replace("@", "");
      const toRestart = target ? agents.filter(s => s.title.toLowerCase() === target) : [];
      if (toRestart.length === 0) {
        _addReply(sid, target ? `No agent named "${target}" found.` : "Usage: /restart @agentName");
      } else {
        await Promise.all(toRestart.map(s => restartSession(s.id).catch(() => {})));
        _addReply(sid, `Restarted: ${toRestart.map(s => s.title).join(", ")}`);
      }
      return;
    }

    const { fleetAutoMode, sessions: currentSessions, staffSessionId: currentStaffId } = useAppStore.getState();
    const currentAgentSessions = currentSessions.filter(
      s => s.id !== currentStaffId && !(s as Session & { archived_at?: string | null }).archived_at
    );

    // ── Lazy staff-session create + optimistic user-message append ─────────
    // Originally the user message wasn't pushed to the chat store until
    // wsManager.send() ran at the very END of this callback — AFTER the
    // 5–6s autoPlan() round-trip. From the user's view the input went
    // empty but no bubble appeared for 5 seconds. Now we:
    //   1. Make sure the staff session exists (create lazily on first send)
    //   2. Push the raw user text to the store IMMEDIATELY
    //   3. Run the planner / mention-context / dispatch wiring in the
    //      background — finalText is sent via sendInternal at the end so
    //      the ws-manager doesn't add a duplicate user bubble.
    let sid: string | null = staffIdRef.current;
    if (!sid) {
      if (creatingStaffRef.current) return;
      creatingStaffRef.current = true;
      try {
        const session = await createSession({
          title: "Staff Agent", project_path: "",
          tool: "claude", permission_mode: "bypassPermissions",
          // Pin the staff model so emit_session_start carries a real
          // value into the telemetry pipeline instead of `null`. The
          // staff coordinator is read-only routing; sonnet is more
          // than enough and matches what the rest of the UI lists.
          model_name: "claude-sonnet-4-6",
        });
        addSession(session);
        setStaffSessionId(session.id);
        staffIdRef.current = session.id;
        sid = session.id;
      } catch (e) {
        console.error("Failed to create staff session:", e);
        creatingStaffRef.current = false;
        return;
      } finally {
        creatingStaffRef.current = false;
      }
    }
    // Sanity guard: every branch above either assigned sid or returned.
    if (!sid) return;
    const sessionId: string = sid;

    // Optimistic append — happens BEFORE any await. Renders in <16ms.
    {
      const imageBlocks = (attachments ?? []).map(a => ({
        type: "image" as const,
        media_type: a.mimeType,
        data: a.data,
        preview: a.preview,
        name: a.name,
      }));
      const content: ContentBlock[] = [
        ...imageBlocks,
        ...(text ? [{ type: "text" as const, text }] : []),
      ];
      // Compaction submits get a stable ID so the compaction_done
      // handler can target-remove this exact row when the canonical
      // synthetic /compact lands. See COMPACTION_MARKER / compactionOptimisticId
      // in ws-manager for the contract — duplicating the literal here
      // would let the two surfaces drift.
      const messageId = isCompactionPayload
        ? compactionOptimisticId(sessionId)
        : crypto.randomUUID();
      if (isCompactionPayload) {
        // Idempotent: drop a stale optimistic from a prior compaction
        // that never received compaction_done before we add this one.
        useChatStore.getState().removeMessage(sessionId, messageId);
      }
      useChatStore.getState().addMessage(sessionId, {
        id: messageId,
        role: "user",
        content,
        timestamp: new Date().toISOString(),
      });
      // Trigger the same scroll/lock behaviour sendViaWs would have.
      scrollToUserMsg.current = true;
      pinnedToExchange.current = true;
      sendLock.current = true;
      setTimeout(() => { sendLock.current = false; }, 600);
      setScrollSpacer(typeof window !== "undefined" ? window.innerHeight : 900);
    }

    // ── Build the message we send to the staff agent ──────────────────────
    // Architecture note (the simplification):
    //
    // The OLD pipeline ran all of this on the FRONTEND before sending to
    // the staff:
    //   • regex extraction of @mentions
    //   • fuzzy resolution of name → agent.id (resolveMention)
    //   • injection of [[DIRECT_DISPATCH:id|task]] tokens
    //   • a separate Claude call (autoPlan) to decompose multi-intent
    //   • per-mention "context injection" (fetchMessages from each)
    //   • back-fill heuristics for "@a @b @c shared-task" patterns
    //   • "looksLikeSeparateRequest" gating
    //
    // The user's complaint, verbatim: "ai'in bunu anlaması lazım çok
    // saçma bir mantık var burada" — the AI should figure this out, not
    // a regex maze on the client. They were right.
    //
    // The staff agent ALREADY has:
    //   • the dispatch_to_agent MCP tool (fuzzy match, ambiguity handling,
    //     cycle detection, rate limit) — see backend/app/services/dispatch_mcp.py
    //   • parallel tool-call support (so it can dispatch to N agents at once)
    //   • visibility into the fleet via the FLEET STATUS block we still
    //     append below — that's all the AI needs to map "@maestro" to the
    //     agent whose project folder is named maestro.
    //
    // So: we send the user's RAW text plus a status snapshot and let the
    // staff Claude do its job. No more frontend regex, no more autoPlan
    // round-trip, no more hallucinated dispatch confirmations.
    const statusLines = currentAgentSessions.map(s => {
      const folder = s.project_path
        ? (folderName(s.project_path) || s.project_path)
        : "none";
      return `- ${s.title} (id: ${s.id}, project: ${folder}, status: ${s.status ?? "idle"})`;
    }).join("\n");
    const statusSnapshot = currentAgentSessions.length > 0
      ? `\n\n---\n[FLEET STATUS]\n${statusLines}\n[END STATUS]`
      : "";
    const finalText = isCompactionPayload
      ? text
      : ((fleetAutoMode && text.trim() ? `[AUTO MODE] ${text}` : text) + statusSnapshot);

    // ── Broadcast shortcut (kept — pure UI feature, not dispatch logic) ──
    const broadcastPhrases = /\ball agents\b|tüm agentlar|hepsi\b|everyone\b|herkese\b/i;
    const isBroadcast = broadcastPhrases.test(text) || text.trim().startsWith("/broadcast");
    if (isBroadcast && currentAgentSessions.length > 0) {
      const broadcastText = text.trim().startsWith("/broadcast")
        ? text.trim().replace(/^\/broadcast\s*/, "").trim()
        : text;
      currentAgentSessions.forEach(agent => {
        wsManager.sendInternal(agent.id, broadcastText).catch(err =>
          console.error(`Broadcast to ${agent.title} failed:`, err)
        );
      });
      useAppStore.getState().pushNotification({
        id: crypto.randomUUID(),
        sessionId: currentStaffId ?? "fleet",
        title: "Broadcast",
        summary: `Broadcasting to ${currentAgentSessions.length} agent${currentAgentSessions.length !== 1 ? "s" : ""}`,
        success: true,
        timestamp: Date.now(),
      });
    }

    // ── Send to staff agent ───────────────────────────────────────────────
    // Optimistic user bubble was already pushed at the top, so we use
    // sendInternal here — ws-manager would otherwise add a duplicate.
    try {
      await wsManager.sendInternal(sessionId, finalText, attachments);
    } catch (err) {
      console.error("Fleet send failed:", err);
    }
  }, [addSession, setStaffSessionId]);

  const handleAgentSend = useCallback(async (text: string, attachments?: Attachment[]) => {
    if (text.trim() === "/new") { void beginDraft(); return; }
    if (!activeSessionId) return;

    // ── Draft → real session bridge ──
    // If the active surface is the in-flight draft, the user just
    // sent the first message. Promote the draft to a real Session
    // row, swap the active id to the freshly-minted one, and route
    // the WS send through the real id. Until this moment NOTHING
    // has been written to the DB — no row, no message, no spend.
    let targetSessionId = activeSessionId;
    let targetSession: Session | undefined = activeSession;
    // Single-warning policy: one stable warn id per session. Sending
    // again without a folder pins the user's attempt to chat but does
    // NOT add a second warning card. The previous Date.now() id stacked
    // a fresh warning on every send, producing the duplicate cards the
    // user saw in chat.
    const surfaceFolderWarning = (sid: string, attemptText: string) => {
      const cs = useChatStore.getState();
      // Echo the user's typed message so they can see what they tried
      // to send (the bridge never received it, so it would otherwise
      // be invisible).
      if (attemptText.trim()) {
        cs.addMessage(sid, {
          id: `attempt-folder-${Date.now()}`,
          role: "user",
          content: [{ type: "text", text: attemptText }],
          timestamp: new Date().toISOString(),
        });
      }
      const warnId = `warn-folder-${sid}`;
      const existing = (cs.sessions[sid]?.messages ?? []).some(m => m.id === warnId);
      if (existing) return;  // dedupe — already shown for this session
      const warnText =
        "I can't start without a folder.\n\n" +
        "Please **click the folder chip above** and pick the project I should work in. " +
        "Once it's set, send your task again and I'll get to it.";
      cs.addMessage(sid, {
        id: warnId,
        role: "assistant",
        content: [{ type: "text", text: "" }],
        timestamp: new Date().toISOString(),
      });
      typeOutAssistantMessage(sid, warnId, warnText);
    };

    if (isLocalOnlyActive && activeSession) {
      if (!activeSession.project_path) {
        surfaceFolderWarning(activeSessionId, text);
        return;
      }
      const committedId = await commitDraft();
      if (!committedId) return;
      targetSessionId = committedId;
      // Re-read targetSession from the store; commitDraft just
      // swapped the local-only entry for the backend row so our
      // closure-captured `activeSession` is now stale.
      targetSession = useAppStore.getState().sessions.find(s => s.id === committedId);
    } else if (!activeSession?.project_path) {
      // Non-draft sessions missing a project_path hit the same path.
      surfaceFolderWarning(activeSessionId, text);
      return;
    }

    if (
      (targetSession?.title === "New agent" || targetSession?.title === "New chat")
      && !text.startsWith("[fleet:compaction]")
    ) {
      const title = text.slice(0, 50) + (text.length > 50 ? "..." : "");
      updateSession(targetSessionId, { title });
      apiUpdateSession(targetSessionId, { title }).catch(() => {});
    }

    // ── Invalidate stale Fleet decisions on user-initiated send ──
    // If Fleet had pushed a pending "continue / ask" card for this
    // session and the user typed something themselves instead of
    // clicking the card, that suggestion is dead — their new prompt
    // supersedes it. Drop the pending decision so the "Pending
    // decisions" badge doesn't keep an ever-growing count of stale
    // cards. Auto-fired decisions (auto: true) clean themselves up
    // via the analyze effect's own setTimeout AND need to keep the
    // auto chain depth bump intact — skip both housekeeping steps
    // in that case.
    const fleetStore = useFleetStore.getState();
    const pending = fleetStore.pendingForSession(targetSessionId);
    const isAutoFiredSend = !!pending?.auto;
    if (pending && !isAutoFiredSend) {
      fleetStore.resolveDecision(pending.id);
    }
    if (!isAutoFiredSend) {
      // A manual send breaks the auto-continue chain — the user
      // took the wheel, so the next Fleet auto-iteration should
      // start counting from zero, not stack on top of the previous
      // run.
      fleetStore.resetAutoChain(targetSessionId);
    }

    sendViaWs(text, targetSessionId, attachments);
  }, [activeSessionId, activeSession, isLocalOnlyActive, commitDraft, updateSession, sendViaWs, beginDraft]);

  // Pre-compute "has the user actually sent something" — used by the
  // auto-intro guard below AND the toolbar / BranchStrip swap further
  // down. Welcome and validation-warning messages are assistant-role
  // and don't count.
  // `attempt-folder-*` is the echoed text the user typed before
  // picking a folder. It's chat-only (the bridge never received it),
  // so it must not count as a real user message — otherwise the
  // chip strip would swap to BranchStrip the moment the user types
  // anything in a folderless draft.
  const hasUserMessageEarly = messages.some(m =>
    m.role === "user" && !m.id.startsWith("attempt-")
  );
  // "Is there any real (non-synthetic) message in the chat yet?" —
  // the auto-intro response is assistant-role so hasUserMessage stays
  // false; we still want the toolbar to swap out for BranchStrip the
  // moment the agent's first real reply lands. Synthetic IDs use the
  // welcome- / warn- / attempt- prefix and are filtered here.
  const hasRealMessage = messages.some(m =>
    !m.id.startsWith("welcome-")
    && !m.id.startsWith("warn-")
    && !m.id.startsWith("attempt-")
  );

  // ── Auto-intro on folder pick ──
  // The moment a draft session gets its project_path filled in (via
  // the folder chip), automatically send a small bootstrap prompt so
  // the agent gets the first word — examines the project, summarises
  // what it finds, and waits for the user's actual task. Without this
  // the user has to manually type "what's in this project" or
  // similar; with it the chat opens with real agent output.
  //
  // Guards:
  //   - draft session only (no user-role messages yet)
  //   - not currently streaming
  //   - per-session "fired" flag so this effect can't double-trigger
  //     when the surrounding state churns
  useEffect(() => {
    if (!activeSessionId || !activeSession) return;
    if (!activeSession.project_path) return;
    if (hasUserMessageEarly) return;
    if (isStreaming) return;
    if (autoIntroFiredRef.current.has(activeSessionId)) return;
    // Local-only skip — the session isn't in the DB yet (no real
    // id, no claude_session_id, no bridge to talk to). The local
    // welcome-typewriter effect below handles this case with a
    // local-only assistant message.
    if (isLocalOnlyActive) return;

    autoIntroFiredRef.current.add(activeSessionId);
    // Tight, structured prompt. Asks the agent for a 2–4 word
    // project name on the first line (we parse it for the session
    // title) and a single-sentence summary right after. NO deep
    // exploration — README + maybe a glance at package.json /
    // pyproject. Speed matters more than thoroughness here.
    //
    // The [fleet:auto-intro] prefix is a hidden marker the backend
    // recognises (chat.py): it strips the marker before the prompt
    // hits the bridge AND skips persisting this user message to
    // the DB, so the prompt never appears in chat history.
    const prompt =
      "[fleet:auto-intro]\n" +
      "Quickly identify this project. Don't explore deeply — " +
      "look at README / package.json / pyproject.toml only.\n\n" +
      "Reply EXACTLY in this format:\n\n" +
      "**<2–4 word project name>**\n" +
      "<one short sentence describing what it is>";

    // Pre-set a placeholder title from folder basename so the
    // session appears in the sidebar immediately. The auto-intro-
    // response watcher below replaces it with the agent's parsed
    // name once the response lands.
    const folderTitle = folderName(activeSession.project_path) || "Session";
    updateSession(activeSessionId, { title: folderTitle });
    apiUpdateSession(activeSessionId, { title: folderTitle }).catch(() => {});

    // Drop the local welcome placeholder before the real response
    // streams — otherwise the chat would start with an obsolete
    // "pick a folder" hint sitting above the agent's intro.
    useChatStore.getState().removeMessage(activeSessionId, `welcome-${activeSessionId}`);

    // ── Pre-flight typewriter cards ──
    // Two short assistant-role cards land BEFORE the agent's actual
    // analysis so the user sees a smooth "I see what you picked,
    // I'm taking a look" beat instead of staring at an empty thread
    // for a few seconds while the auto-intro round-trips.
    //   1. Context summary  — folder + model + permission, single
    //      compact line typed out fast.
    //   2. "Quick look"     — the human-y "let me peek at what's
    //      here" beat that bridges into the agent's real reply.
    //
    // Both messages get welcome- prefix IDs so the existing real-
    // message gate (hasRealMessage) and the title-parser ignore
    // them. They use the typewriter helper → land char-by-char.
    const sid = activeSessionId;
    const provider = activeSession.tool || "claude";
    const modelLabelMap: Record<string, string> = {
      "claude-opus-4-7": "Opus 4.7",
      "claude-sonnet-4-6": "Sonnet 4.6",
      "claude-haiku-4-5-20251001": "Haiku 4.5",
    };
    const modelLabel = activeSession.model_name
      ? (modelLabelMap[activeSession.model_name] || activeSession.model_name)
      : "default model";
    const permLabelMap: Record<string, string> = {
      default: "Ask permission",
      acceptEdits: "Auto-accept edits",
      bypassPermissions: "Full auto",
      plan: "Plan only",
    };
    const permLabel = permLabelMap[activeSession.permission_mode] || activeSession.permission_mode;
    const providerCap = provider.charAt(0).toUpperCase() + provider.slice(1);

    const ctxId = `welcome-ctx-${sid}`;
    const peekId = `welcome-peek-${sid}`;

    useChatStore.getState().addMessage(sid, {
      id: ctxId, role: "assistant",
      content: [{ type: "text", text: "" }],
      timestamp: new Date().toISOString(),
    });
    typeOutAssistantMessage(
      sid, ctxId,
      `Working in **${folderTitle}** with **${providerCap} ${modelLabel}** · ${permLabel}.`,
      14,
    );

    // The "quick look" card lands a beat after the context card so
    // both messages don't race the same setInterval ticks. 700ms is
    // enough for the context line (~70 chars × 14ms ≈ 1s) to be
    // mostly done before the second one starts typing.
    const peekT = setTimeout(() => {
      useChatStore.getState().addMessage(sid, {
        id: peekId, role: "assistant",
        content: [{ type: "text", text: "" }],
        timestamp: new Date().toISOString(),
      });
      typeOutAssistantMessage(
        sid, peekId,
        "Taking a quick look at the project before we get started…",
        16,
      );
    }, 700);

    // sendInternal pushes the prompt over the WS WITHOUT echoing
    // it as a user-role message in the chat — exactly what we need
    // for a silent background ping. We delay the bridge call by ~2s
    // so the two pre-flight cards finish typing before the agent's
    // streaming reply starts piling on top of them.
    const t = setTimeout(() => {
      void wsManager.sendInternal(sid, prompt);
    }, 2000);
    return () => { clearTimeout(t); clearTimeout(peekT); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId, activeSession?.project_path, hasUserMessageEarly, isStreaming]);

  // ── Fleet panel → "Send this" channel ──
  // The right-panel SessionRow's inline decision card dispatches
  // fleet:send-prompt {sessionId, text} when the user clicks
  // "Send this" on a continue decision. If the event targets the
  // current active session, route the text through handleAgentSend
  // as if the user typed it themselves. Other sessions are out of
  // scope for this chat-view instance — they'll be handled by
  // whichever chat-view is active for that session.
  useEffect(() => {
    const handler = (e: Event) => {
      const ev = e as CustomEvent<{ sessionId: string; text: string }>;
      const detail = ev.detail;
      if (!detail || typeof detail.text !== "string") return;
      if (detail.sessionId !== activeSessionId) return;
      void handleAgentSend(detail.text);
    };
    window.addEventListener("fleet:send-prompt", handler);
    return () => window.removeEventListener("fleet:send-prompt", handler);
  }, [activeSessionId, handleAgentSend]);

  // ── Fleet co-pilot: analyze on stream-end ──
  // When an agent session finishes streaming a response, hand the
  // last assistant text plus the prior user prompt to Fleet brain.
  // Fleet returns one of {continue, ask, done} which lands in
  // fleet-store and surfaces as a FleetDecisionCard in slotAbove.
  // Trigger is a strict true→false transition on isStreaming for
  // the SAME session id — guards re-entry on session-switch and
  // double-resolution races.
  //
  // Policy + cost-cap gates:
  //   - mode "manual" or "refine-only" → skip analysis entirely
  //   - cost cap exceeded             → skip (Fleet paused)
  //
  // Auto-iteration: when mode is "auto" AND the decision is
  // "continue" AND we haven't hit AUTO_CHAIN_CAP for this session,
  // fire the next prompt as an agent send automatically and mark
  // the decision as `auto: true` (the card renders as a status
  // pill, not action buttons).
  const fleetPrevStreamRef = useRef<{ id: string | null; streaming: boolean }>({ id: null, streaming: false });
  // Per-session record of the last user-message id we already handed
  // to Fleet brain. Guards against the analyze effect firing twice
  // for the same turn — e.g. when the WS auto-reconnect flips
  // isStreaming false→true→false mid-stream and the stream-end
  // transition trips again on the same (user, assistant) pair. Each
  // analyze call costs ~$0.0008 and potentially auto-fires another
  // prompt, so double-firing is both a cost-leak and a
  // double-stream risk.
  const fleetAnalyzedUserMsgRef = useRef<Record<string, string>>({});
  useEffect(() => {
    const sid = effectiveSessionId;
    const prev = fleetPrevStreamRef.current;
    fleetPrevStreamRef.current = { id: sid, streaming: isStreaming };

    if (!sid) return;
    if (!activeSessionId) return;
    if (prev.id !== sid) return;
    if (!prev.streaming) return;
    if (isStreaming) return;

    const fleetState = useFleetStore.getState().getSession(sid);
    if (!useFleetStore.getState().isFleetLiveFor(sid)) return;
    if (fleetState.mode === "refine-only") return;

    // Pull the latest user prompt + assistant response from the
    // chat store. Bypass the React snapshot so this effect doesn't
    // have to depend on `messages` (which fires on every token).
    const state = useChatStore.getState().sessions[sid];
    const msgs = state?.messages ?? [];
    if (msgs.length === 0) return;

    // ── Abort / mid-stream guard ──
    // A pending permission request means the SDK paused on a
    // ToolUse — the assistant text we'd analyze is a half-formed
    // turn, not a real response. Letting analyze fire here pollutes
    // the decisions queue AND, in auto-mode, could auto-prompt
    // BEFORE the user has even seen the permission card.
    if (state?.permissionRequest) return;

    let userText = "";
    let userMsgId = "";
    let assistantText = "";
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (!m) continue;
      if (!assistantText && m.role === "assistant") {
        assistantText = m.content
          .filter(b => b.type === "text")
          .map(b => (b as { type: "text"; text: string }).text)
          .join("\n");
      } else if (assistantText && m.role === "user") {
        userText = m.content
          .filter(b => b.type === "text")
          .map(b => (b as { type: "text"; text: string }).text)
          .join("\n");
        userMsgId = m.id;
        break;
      }
    }
    if (!assistantText.trim() || !userText.trim()) return;

    // ── Aborted / very-short response guard ──
    // A response under 20 chars is almost always an abort, an SDK
    // init blip, or a "ok"/"done" one-liner that's not worth a
    // Fleet round-trip. Skip — the next real turn will analyze.
    if (assistantText.trim().length < 20) return;

    // ── Per-turn idempotency guard ──
    // If we already analyzed for THIS user message, don't re-run.
    // Catches the WS-reconnect double-stream pattern: stream A
    // ends → analyze fires → auto-prompt sent → stream B starts →
    // WS drops mid-stream B → isStreaming flips false → effect
    // re-enters → without this gate it would analyze stream B's
    // partial text against the SAME user prompt, potentially
    // auto-firing again and stacking cost / streams.
    if (userMsgId && fleetAnalyzedUserMsgRef.current[sid] === userMsgId) return;
    if (userMsgId) fleetAnalyzedUserMsgRef.current[sid] = userMsgId;

    const fleet = useFleetStore.getState();
    fleet.setStatus(sid, "thinking", "Analyzing response");

    analyzeFleetResponse({
      priorPrompt: userText,
      agentText: assistantText,
      projectPath: activeSession?.project_path ?? null,
    })
      .then(result => {
        // Approximate cost — analyze averages ~$0.0008.
        fleet.recordCost(sid, 0.0008);

        // Backend signalled "couldn't analyze this turn" — silently
        // drop. The user was already mid-chat; the worst thing we can
        // do is plant a fake "ask" card that says "Fleet couldn't
        // analyze. Continue manually" on top of their conversation.
        // Treat it as a no-op and let them keep typing.
        if (result.degraded) {
          fleet.setStatus(sid, "idle", null);
          return;
        }

        const modeNow = useFleetStore.getState().getSession(sid).mode;
        const chainDepth = useFleetStore.getState().getSession(sid).autoChainDepth;
        const autoEligible =
          result.decision === "continue"
          && modeNow === "auto"
          && !!result.next_prompt
          && chainDepth < AUTO_CHAIN_CAP;

        const decisionId = (typeof crypto !== "undefined" && crypto.randomUUID)
          ? crypto.randomUUID()
          : `dec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

        fleet.pushDecision({
          id: decisionId,
          sessionId: sid,
          kind: result.decision,
          reasoning: result.reasoning,
          nextPrompt: result.next_prompt ?? undefined,
          question: result.question ?? undefined,
          summary: result.summary ?? undefined,
          createdAt: Date.now(),
          auto: autoEligible,
        });

        if (result.decision === "done") {
          // Map backend snake_case sections to fleet-store camelCase.
          const rawSections = result.sections;
          const reportSections = rawSections ? {
            whatDone:  rawSections.what_done  ?? undefined,
            decisions: rawSections.decisions  ?? undefined,
            uncertain: rawSections.uncertain  ?? undefined,
            options:   rawSections.options    ?? undefined,
          } : undefined;
          fleet.pushReport({
            id: (typeof crypto !== "undefined" && crypto.randomUUID)
              ? crypto.randomUUID()
              : `rpt-${Date.now()}`,
            sessionId: sid,
            title: userText.slice(0, 80),
            body: result.summary || result.reasoning,
            sections: reportSections,
            outcome: "done",
            createdAt: Date.now(),
          });
          // Completion clears the auto chain so the next user
          // prompt starts a fresh count.
          fleet.resetAutoChain(sid);
        } else if (result.decision === "ask") {
          fleet.resetAutoChain(sid);
        }

        if (autoEligible && result.next_prompt) {
          fleet.bumpAutoChain(sid);
          fleet.setStatus(sid, "auto-continuing", "Auto-firing next prompt");
          // Fire next prompt as if the user had sent it. The agent
          // session's own onSend goes through wsManager — no
          // refine for auto-continue (Fleet wrote it itself).
          handleAgentSend(result.next_prompt);
          // Auto-fired decisions don't need to linger in the queue.
          // Resolve immediately so the user's pending list stays
          // focused on things that actually need their input.
          setTimeout(() => fleet.resolveDecision(decisionId), 1200);
        }
      })
      .catch(() => {
        fleet.setStatus(sid, "idle", "Analysis unavailable");
        // Clear the idempotency mark so a subsequent retry path
        // (e.g. user re-sends the same message) isn't blocked by a
        // failed previous attempt.
        if (userMsgId && fleetAnalyzedUserMsgRef.current[sid] === userMsgId) {
          delete fleetAnalyzedUserMsgRef.current[sid];
        }
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isStreaming, effectiveSessionId, activeSessionId, activeSession?.project_path]);

  // ── Local-only welcome typewriter ──
  // Replaces the (DB-bound) auto-intro flow for compose-phase
  // sessions. When the user finishes configuring a local-only session
  // (folder + tool + model are settled) but doesn't type for 10
  // seconds, drop a local-only assistant message into the chat to
  // break the silence. NO backend call, NO token spend — just a
  // typewriter card. The moment the user sends, commitDraft() runs
  // and the local-only entry is replaced with the backend row, which
  // tears this effect down and cancels the timer.
  useEffect(() => {
    if (!isLocalOnlyActive || !activeSession || !activeSessionId) return;
    if (!activeSession.project_path || !activeSession.tool || !activeSession.model_name) return;
    if (hasUserMessageEarly) return;
    if (draftWelcomeFiredRef.current.has(activeSessionId)) return;

    const did = activeSessionId;
    const t = setTimeout(() => {
      // Re-check just before firing — the user may have started
      // typing in the last frame, or commitDraft may have swapped
      // the entry for a real backend row.
      const fresh = useAppStore.getState().sessions.find(s => s.id === did);
      if (!fresh?.local_only) return;
      const currentMessages = useChatStore.getState().sessions[did]?.messages ?? [];
      if (currentMessages.some(m => m.role === "user")) return;
      draftWelcomeFiredRef.current.add(did);
      const welcomeId = `welcome-${did}`;
      useChatStore.getState().addMessage(did, {
        id: welcomeId,
        role: "assistant",
        content: [{ type: "text", text: "" }],
        timestamp: new Date().toISOString(),
      });
      const projectName = folderName(fresh.project_path) || "your project";
      const providerLabel =
        fresh.tool === "claude" ? "Claude"
        : fresh.tool === "codex" ? "Codex"
        : fresh.tool === "gemini" ? "Gemini"
        : fresh.tool.charAt(0).toUpperCase() + fresh.tool.slice(1);
      const text = `Ready when you are — I'll be working in **${projectName}** with **${providerLabel}**. What would you like to do?`;
      typeOutAssistantMessage(did, welcomeId, text, 14);
    }, 10_000);
    return () => clearTimeout(t);
  }, [isLocalOnlyActive, activeSession, activeSessionId, hasUserMessageEarly]);

  // ── Auto-intro title parser ──
  // Once the auto-intro response has fully streamed, look at the
  // latest assistant message and pull the bolded "**<name>**" out of
  // the structured reply we asked for. That becomes the session
  // title (replacing the folder-name placeholder). Falls back to
  // doing nothing if the agent didn't comply with the format —
  // folder name stays as a sensible default.
  useEffect(() => {
    if (!activeSessionId) return;
    if (!autoIntroFiredRef.current.has(activeSessionId)) return;
    if (autoIntroTitleParsedRef.current.has(activeSessionId)) return;
    if (isStreaming) return;
    const lastAssistant = [...messages].reverse().find(m =>
      m.role === "assistant"
      && !m.id.startsWith("welcome-")
      && !m.id.startsWith("warn-")
    );
    if (!lastAssistant) return;
    const text = lastAssistant.content
      .flatMap(b => (b as { type: string; text?: string }).type === "text"
        ? [(b as { text: string }).text]
        : [])
      .join("\n");
    const match = text.match(/\*\*([^*\n]{1,60})\*\*/);
    if (match && match[1]) {
      const name = match[1].trim();
      if (name && name !== activeSession?.title) {
        updateSession(activeSessionId, { title: name });
        apiUpdateSession(activeSessionId, { title: name }).catch(() => {});
      }
    }
    autoIntroTitleParsedRef.current.add(activeSessionId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId, messages, isStreaming]);

  // ── Auto-intro "ready" follow-up ──
  // Once the agent's analysis has fully streamed in (isStreaming
  // flips back to false AND there's a real assistant message in
  // the thread), drop a short "Ready when you are" typewriter card
  // beneath it. Same welcome- prefix so it doesn't count as a real
  // message — the toolbar / BranchStrip swap is gated on a non-
  // synthetic message landing, so this card is invisible to that
  // logic. Fires once per session.
  useEffect(() => {
    if (!activeSessionId) return;
    if (!autoIntroFiredRef.current.has(activeSessionId)) return;
    if (autoIntroReadyShownRef.current.has(activeSessionId)) return;
    if (isStreaming) return;
    // If the user has already typed anything, they're already engaged
    // — dropping a "Ready when you are" card AFTER they've sent
    // "Hello" reads as the app talking past them. The card is only a
    // useful prompt when no real exchange has happened yet.
    if (messages.some(m => m.role === "user")) {
      autoIntroReadyShownRef.current.add(activeSessionId);
      return;
    }
    // We need the analysis to actually be there — at least one
    // assistant message that ISN'T one of our welcome- placeholders.
    const hasAnalysis = messages.some(m =>
      m.role === "assistant"
      && !m.id.startsWith("welcome-")
      && !m.id.startsWith("warn-")
    );
    if (!hasAnalysis) return;

    autoIntroReadyShownRef.current.add(activeSessionId);
    const sid = activeSessionId;
    const readyId = `welcome-ready-${sid}`;
    // 350ms breath after the agent stops streaming so the "ready"
    // card doesn't crash into the tail of the analysis message.
    const t = setTimeout(() => {
      useChatStore.getState().addMessage(sid, {
        id: readyId, role: "assistant",
        content: [{ type: "text", text: "" }],
        timestamp: new Date().toISOString(),
      });
      typeOutAssistantMessage(
        sid, readyId,
        "Ready when you are — what should we work on?",
        16,
      );
    }, 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId, messages, isStreaming]);

  // Lazy-connect agent WebSockets — was: open ALL agent WS in
  // parallel the moment the user landed on Control Center, which
  // produced the connection storm + backend log spam the user
  // reported. New behaviour: connect ONLY the running / waiting /
  // starting agents (the ones whose status actually streams). Idle
  // agents stay disconnected until the user clicks one OR the
  // backend pushes a status change for them.
  //
  // Net effect on a 20-session control center: typical 2-3 active
  // agents stay live, the other 17 don't open WS until needed.
  // Backend log volume drops proportionally; control center cold
  // start is ~1.5 s → <100 ms.
  // eslint-disable-next-line react-hooks/rules-of-hooks
  useEffect(() => {
    if (!activeSessionId) {
      // Also disconnect when the OS tab is hidden. Browser keeps
      // the WS open in the background otherwise — no wins, just
      // chat-store updates burning CPU on a window the user isn't
      // looking at. Reconnects automatically on next visibility
      // change because the store gates ensureConnected internally.
      const isVisible = typeof document === "undefined" ? true : !document.hidden;
      if (!isVisible) return;

      const liveStatuses = new Set(["running", "starting", "waiting"]);
      sessions
        .filter(s => s.id !== staffSessionId && !(s as { archived_at?: string | null }).archived_at && (s.title || "").trim() !== "New chat")
        .filter(s => liveStatuses.has(s.status))
        .forEach(s => wsManager.ensureConnected(s.id).catch(() => {}));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId, sessions.map(s => `${s.id}:${s.status}`).join(","), staffSessionId]);

  const isControlCenter = !activeSessionId;
  // Draft sessions ("New chat" placeholder title — created by the
  // sidebar's New session button before any folder/message is set)
  // are hidden from the sidebar list. They shouldn't show up in the
  // active-fleet count either. Match the sidebar filter rule
  // (chat-view <-> sidebar.tsx must agree on what counts).
  const agentSessions = sessions.filter(s =>
    s.id !== staffSessionId
    && !(s as Session & { archived_at?: string | null }).archived_at
    && (s.title || "").trim() !== "New chat"
  );

  // When Fleet is open, pre-load messages for ALL agents in the background
  // so IdleRow and RunningPanel can show last activity without user navigating.
  // eslint-disable-next-line react-hooks/rules-of-hooks
  useEffect(() => {
    if (!isControlCenter) return;
    agentSessions.forEach(s => {
      if (loadedSessionsRef.current.has(s.id)) return;
      const state = useChatStore.getState().sessions[s.id];
      if (state && (state.messages.length > 0 || state.isStreaming)) {
        loadedSessionsRef.current.add(s.id);
        return;
      }
      ensureSession(s.id);
      fetchMessages(s.id)
        .then(msgs => {
          if (msgs.length > 0) setMessages(s.id, msgs.map(parseContent));
          loadedSessionsRef.current.add(s.id); // only mark loaded on success
        })
        .catch(() => { /* will retry on next render */ });
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isControlCenter, agentSessions.map(s => s.id).join(","), ensureSession, setMessages, parseContent]);

  return (
    <div style={{
      flex: 1, display: "flex", background: "var(--card)", overflow: "hidden", position: "relative",
      // Transcript font scale — exposed as a CSS variable so any
      // descendant that opts in (`font-size: calc(13px * var(--chat-font-scale))`)
      // responds, plus we set the root font-size so rem-based
      // rules pick it up automatically. Three steps: 0.875 / 1 / 1.125.
      ["--chat-font-scale" as string]: String(transcriptFontScale ?? 1),
      fontSize: `calc(1em * ${transcriptFontScale ?? 1})`,
    }}>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0, position: "relative" }}>
        {/* Top bar — solid header. Below it sits a small gradient
            strip (rendered after this div) that softens the transition
            into the messages below. No blur, no mask, no overlay. */}
        <div className="drag-region" style={{
          height: 44, flexShrink: 0, position: "relative", zIndex: 2,
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "0 16px",
          background: "var(--card)",
        }}>
          {/* ── Symmetric layout when sidebar is collapsed ──
              Traffic lights: 12px circles at chat-x: 28/48/68
              (centers), 8px edge-to-edge gap. Green right edge x:74.

              Goal: toggle button visually scaled like the lights
              (not a chunky chip) AND spaced like one — same ~10px
              gap on both sides.

              Toggle button 22×22 with PanelLeft size 14 (icon
              visually similar to a traffic-light circle).
              22×22 button + 14px icon → icon visual edges sit
              4px inside on each side.

              Want icon visual left at x:74 + 10 = x:84.
              ⇒ button_left = 84 - 4 = 80.
              parent .drag-region has padding 0 16px, so paddingLeft
              on no-drag = 80 - 16 = 64.
              gap:14 in flex → outer-edge to outer-edge between the
              button and the next item. After the IBtn's 4px right
              padding, that yields ~10px icon-to-text visual gap. */}
          <div className="no-drag" style={{
            display: "flex", alignItems: "center", gap: 14,
            // 84px inset reserves room for the macOS traffic lights
            // when the sidebar is collapsed (they'd otherwise overlap
            // the chat-header content). Windows has no traffic lights,
            // so the inset stays 0 and the header content starts flush.
            paddingLeft: !isWindows && sidebarCollapsed ? 84 : 0,
            minWidth: 0,
          }}>
            {/* Sidebar toggle (collapsed state only). Sized down to
                22×22 with a 14px icon so it visually matches the
                traffic-light scale and reads as part of the same
                left-edge control row, not a separate chip.
                Suppressed in non-leading panes — the sidebar is
                global, so showing the toggle inside every pane
                duplicates the same affordance N times for no
                reason. paneIdx === undefined is the legacy single
                view; paneIdx === 0 is the leftmost pane in the
                first row of the split grid. */}
            {!isWindows && sidebarCollapsed && (paneIdx === undefined || paneIdx === 0) && (
              <span data-align-anchor="traffic-lights" style={{ display: "inline-flex" }}>
                <IBtn onClick={toggleSidebar} style={{ width: 22, height: 22, borderRadius: 5 }}>
                  <PanelLeft size={14} />
                </IBtn>
              </span>
            )}
            {/* ── Agent identity cluster ──
                For agent chats: provider logo · title · project chip · status dot.
                Mirrors the right Hub card so the chat header carries the
                same context the user sees in the sidebar. The previous
                version showed nothing but the title — high-traffic
                surface, zero information density. */}
            {!isControlCenter && activeSession && (
              // ── Breadcrumb identity ──
              //   📁 project_name / session_title  ⌄
              // A single tappable cluster that opens a session menu
              // (rename, archive, switch session within project, etc.).
              // Replaces the previous logo + title + chip + dot + cost
              // pile-up — too many tiers competed for attention. Status
              // and cost moved to the right side as small monospace
              // metas, where ambient state belongs. The model dropdown
              // already lives in the input toolbar; this header is for
              // identity only.
              (() => {
                const proj = activeSession.project_path
                  ? folderName(activeSession.project_path)
                  : null;
                const sessionTitle = activeSession.title || "Untitled session";
                return (
                  <button
                    title={activeSession.project_path ?? sessionTitle}
                    onClick={(e) => {
                      // Replicate the sidebar's session right-click menu:
                      // dispatch a custom event the right panel / agent
                      // list can wire up later. For now it's purely
                      // visual — the breadcrumb is informational.
                      e.preventDefault();
                    }}
                    style={{
                      display: "inline-flex", alignItems: "center", gap: 7,
                      padding: "4px 8px", borderRadius: 6, flexShrink: 1, minWidth: 0,
                      background: "none", border: "none", cursor: "pointer",
                      color: "var(--c-high)",
                      transition: "background 0.12s",
                    }}
                    onMouseEnter={ev => { ev.currentTarget.style.background = "var(--c-srf)"; }}
                    onMouseLeave={ev => { ev.currentTarget.style.background = "none"; }}
                  >
                    <Folder size={13} strokeWidth={1.75} style={{ color: "var(--c-low)", flexShrink: 0 }} />
                    {proj && (
                      <>
                        <span style={{
                          fontSize: 13.5, fontWeight: 500, color: "var(--c-high)",
                          whiteSpace: "nowrap", flexShrink: 0,
                          fontFamily: "var(--font-mono)",
                        }}>
                          {proj}
                        </span>
                        <span style={{ color: "var(--c-dim)", fontSize: 13, flexShrink: 0 }}>/</span>
                      </>
                    )}
                    <span style={{
                      fontSize: 13.5, fontWeight: 400, color: "var(--c-med)",
                      whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                      minWidth: 0,
                    }}>
                      {sessionTitle}
                    </span>
                    <ChevronDown size={12} strokeWidth={2} style={{ color: "var(--c-low)", flexShrink: 0, marginLeft: 1 }} />
                  </button>
                );
              })()
            )}
            {/* Fleet hub: header reads as empty wordmark space — the
                "Fleet" label + running/idle stat strip were removed
                per the user. The right Fleet panel carries identity
                + state now; the chat header just holds controls. */}
          </div>
          <div className="no-drag" style={{ display: "flex", alignItems: "center", gap: 4 }}>
            {/* All right-cluster icons normalized to 22×22 / size:14 so
                they match the left chat-header toggle. Previously they
                inherited IBtn's default 30×30 which made them look
                visibly larger than the PanelLeft toggle on the left
                edge of the same row. */}
            {messages.length > 0 && (
              <IBtn onClick={handleClearChat} title="Clear chat" style={{ width: 22, height: 22, borderRadius: 5 }}>
                <Trash2 size={14} />
              </IBtn>
            )}
            {isControlCenter && <ShortcutsPopover />}
            {/* Agent run-state controls (Stop / Restart) removed
                from the header — the chat-input's own send button
                already flips into a Stop affordance while
                streaming, so the duplicate red square in the
                top-right was just clutter. Restart is rare enough
                that it lives in the sidebar right-click menu. */}
            {/* Right-panel toggle.
                Control-center (Fleet hub, no agent open) → plain
                toggle: the right panel just IS the Fleet hub sidebar,
                there's no per-view picker. The dropdown listing
                Preview/Diff/Terminal/Files/Tasks/Memories only makes
                sense when a workspace is attached to an active agent.
                Agent session → full PanelViewMenu picker.
                Pane mode follows the pane's own right-state. */}
            {isControlCenter ? (
              <IBtn
                onClick={toggleRightPanel}
                title={rightPanelOpen ? "Hide Fleet panel" : "Show Fleet panel"}
                style={{ width: 22, height: 22, borderRadius: 5 }}
              >
                <PanelRight size={14} />
              </IBtn>
            ) : (() => {
              // Pane mode → use the pane-scoped state; single-view
              // → fall through to the global wiring (legacy path).
              const inPane = paneSessionId !== undefined && paneSessionId !== null;
              const sid = inPane ? (paneSessionId as string) : null;
              const paneOpen = sid != null ? !!paneRightOpenById[sid] : false;
              const paneViews = sid != null ? (paneViewsById[sid] ?? []) : [];
              const activeViews: WorkspaceView[] = inPane && sid != null
                ? paneViews
                : openWorkspaceViews;
              return (
                <PanelViewMenu
                  open={inPane ? paneOpen : rightPanelOpen}
                  activeViews={activeViews}
                  onToggle={inPane && sid != null
                    ? () => togglePaneRight(sid)
                    : toggleRightPanel}
                  onSelectView={inPane && sid != null
                    ? (v) => paneAddView(sid, v)
                    : addWorkspaceView}
                  onRemoveView={inPane && sid != null
                    ? (v) => paneRemoveView(sid, v)
                    : removeWorkspaceView}
                />
              );
            })()}
            {/* Split-pane button removed — splitting now happens
                purely via drag-and-drop: drag a session from the
                sidebar onto the chat surface, the edge drop-zones
                (left/right) appear, drop creates a new pane. The
                button felt redundant once the drop flow worked. */}
            {/* ChatMoreMenu (the "..." popover with Export options)
                removed from the header. The user wanted the chat
                top-bar trimmed of buttons that aren't a primary
                action; export now lives on the sidebar's
                right-click menu where it sits next to the other
                session-management actions (rename, fork, archive). */}
            {/* Pane close — only when this ChatView is rendered
                inside the split grid. Lives in the chat header
                so it has DEDICATED space (no overlap with the
                workspace panel buttons or the breadcrumb at the
                top-left of the pane). */}
            {onClosePane && (
              <button
                onClick={onClosePane}
                onMouseDown={(e) => e.preventDefault()}
                title="Close pane"
                style={{
                  width: 22, height: 22, padding: 0, borderRadius: 5,
                  display: "inline-flex", alignItems: "center", justifyContent: "center",
                  background: "transparent",
                  border: "none", outline: "none", cursor: "pointer",
                  color: "var(--c-low)",
                  transition: "color 0.12s, background 0.12s",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "rgba(var(--fg-rgb), 0.08)";
                  e.currentTarget.style.color = "var(--c-fg)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "transparent";
                  e.currentTarget.style.color = "var(--c-low)";
                }}
              >
                <X size={12} strokeWidth={2.25} />
              </button>
            )}
          </div>
        </div>

        {/* ── Header → messages transition strip ──
            16px tall, sits IMMEDIATELY below the solid header. Pure
            gradient from the chat surface color down to transparent —
            no blur, no overlay over content, just a soft tail on the
            header itself. Messages scroll BEHIND it (z-index 1 vs
            messages 0). Pointer-events: none so it doesn't intercept
            scroll/clicks meant for the messages. */}
        <div aria-hidden style={{
          position: "absolute", left: 0, right: 0, top: 44,
          height: 16, zIndex: 1, pointerEvents: "none",
          background: "linear-gradient(to bottom, var(--card) 0%, color-mix(in srgb, var(--card) 60%, transparent) 50%, transparent 100%)",
        }} />

        {/* Messages scroll surface.
         *
         * overflowX: "hidden" — the previous setting (only `overflowY: "auto"`)
         * implicitly left horizontal overflow as `visible`, but with
         * ::-webkit-scrollbar height:4px set globally, ANY inner content
         * that nudged past the container width (a long unwrapped URL,
         * a wide tool output, a long inline code span) painted a
         * horizontal scrollbar across the bottom of the messages area
         * even though we never actually want horizontal scrolling here.
         * Force-clip it so the bar appears only when the user genuinely
         * overflows vertically. */}
        <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", overflowX: "hidden" }}>
          {isControlCenter && messages.length === 0 && !isStreaming ? (
            <FleetChatEmptyState
              agents={agentSessions}
              onNewAgent={() => window.dispatchEvent(new Event("fleet:new-agent"))}
              onSelectAgent={(id) => setActiveSession(id)}
            />
          ) : (
            <div style={{ maxWidth: 920, margin: "0 auto", width: "100%", padding: "24px 32px 8px" }}>
              <MessageList messages={messages} latestUserMsgRef={latestUserMsgRef} />
              {/* Suppress StreamingMessage while a compaction pill is
                  active — /compact runs entirely server-side (no agent
                  turn, no thinking, no tools), so the idle "Thinking…"
                  / shimmer would be misleading. The inline status pill
                  below is the only feedback surface for this flow. */}
              {isStreaming && !compactionPillActive && (
                <StreamingMessage text={streamingText} thinking={streamingThinking} />
              )}
              {effectiveSessionId && <CompactionPill sessionId={effectiveSessionId} />}
              <div ref={bottomRef} />
              <div style={{ height: scrollSpacer }} />
            </div>
          )}
        </div>

        {/* ── Messages → chat-input transition strip ──
            Mirror of the header's tail strip, flipped. 16px gradient
            from transparent (top) to var(--card) (bottom) so messages
            scrolling down fade out instead of slamming into the input.
            Negative marginTop pulls the strip UP into the messages
            area; flex-shrink:0 + relative positioning keeps it on top
            of message content (z-index 1 vs messages 0). No absolute
            positioning needed — the strip rides naturally on top of
            the messages flex item just before the ChatInput. */}
        <div aria-hidden style={{
          height: 16, marginTop: -16,
          flexShrink: 0, zIndex: 1, position: "relative",
          pointerEvents: "none",
          background: "linear-gradient(to top, var(--card) 0%, color-mix(in srgb, var(--card) 60%, transparent) 50%, transparent 100%)",
        }} />

        <ChatInput
          // ── Per-session input state ──
          // ChatInput holds its own `value` state. Without `key`, React
          // keeps the same instance across session switches, so a
          // half-typed message in agent A leaks into agent B's input
          // box. Keying by effectiveSessionId remounts the component
          // when the active session changes, giving each session its
          // own draft. Trade-off: typing in A then switching to B
          // discards A's draft instead of preserving it. Acceptable
          // — that's the standard mental model for chat apps.
          key={effectiveSessionId ?? "fleet-empty"}
          onSend={isControlCenter ? handleStaffSend : handleAgentSend}
          onStop={handleStop}
          disabled={isStreaming}
          streaming={isStreaming}
          locked={!!permissionRequest}
          placeholder={
            permissionRequest
              ? permissionRequest.tool_name === "AskUserQuestion"
                ? "Respond above to continue…"
                : permissionRequest.tool_name === "ExitPlanMode" || permissionRequest.tool_name === "EnterPlanMode"
                  ? "Review the plan above to continue…"
                  : "Approve or deny above to continue…"
              : isControlCenter
                ? fleetAutoMode
                  ? "Fleetify will route this automatically…  @ to target an agent"
                  : "Talk to Fleetify…  @ to target a specific agent"
                : "Send a message…"
          }
          model={isControlCenter ? undefined : (activeSession?.model_name ?? undefined)}
          tool={isControlCenter ? "claude" : (activeSession?.tool ?? "claude")}
          // Real context-fill + cumulative session stats — both
          // derived from the in-store messages array. The arc
          // shows the LATEST assistant turn's input fill (so the
          // user sees how much room remains for the next prompt);
          // the popover's "Session usage" section shows totals
          // across every assistant turn so far.
          {...(() => {
            // Cumulative totals — every assistant turn that ever
            // reported usage (cost-tracked).
            let inputTotal = 0, outputTotal = 0;
            let cacheReadTotal = 0, cacheWriteTotal = 0;
            let turns = 0;
            let lastUsage: typeof messages[number]["usage"] = undefined;
            for (const msg of messages) {
              if (msg.role !== "assistant" || !msg.usage) continue;
              const mu = msg.usage;
              inputTotal       += mu.input_tokens       ?? 0;
              outputTotal      += mu.output_tokens      ?? 0;
              cacheReadTotal   += mu.cache_read_tokens  ?? 0;
              cacheWriteTotal  += mu.cache_write_tokens ?? 0;
              turns += 1;
              lastUsage = mu;
            }
            // Latest turn's "what the model saw" — input + both
            // cache lanes. The arc tracks how close THIS request
            // was to the cap, not the cumulative total.
            const lastInputView = lastUsage
              ? (lastUsage.input_tokens ?? 0)
                + (lastUsage.cache_read_tokens ?? 0)
                + (lastUsage.cache_write_tokens ?? 0)
              : 0;
            const m = (activeSession?.model_name ?? "").toLowerCase();
            // 1M for Gemini Pro / models tagged 1M, 200K everywhere
            // else. Claude Opus 4.7's 1M variant gets the wide cap.
            const max = m.includes("gemini") || m.includes("1m") ? 1_000_000 : 200_000;
            return {
              contextPercent: lastInputView / max,
              contextUsedTokens: lastInputView,
              contextMaxTokens: max,
              sessionUsage: {
                inputTotal, outputTotal,
                cacheReadTotal, cacheWriteTotal,
                turns,
                costUsd: activeSession?.budget_used,
                startedAt: activeSession?.created_at,
              },
            };
          })()}
          projectPath={isControlCenter ? undefined : activeSession?.project_path}
          worktreePath={isControlCenter ? undefined : activeSession?.worktree_path}
          branch={isControlCenter ? undefined : activeSession?.worktree_branch}
          sessionId={effectiveSessionId}
          permissionMode={isControlCenter ? undefined : (activeSession?.permission_mode ?? "default")}
          // BranchStrip is the POST-DEPLOY surface — it shows
          // base ← fleet/<slug>-<sid> + diff + Create PR once the
          // session is actually running. Pre-deploy we hide it: the
          // SessionToolbar's chip strip is the setup surface and a
          // dimmed BranchStrip floating above an empty chat reads as
          // noise. Same gate as before: hide while we have no real
          // message yet AND the agent isn't streaming.
          hideBranchStrip={!isControlCenter && !!activeSession && !hasRealMessage && !isStreaming}
          sessionTitle={isControlCenter ? undefined : (activeSession?.title ?? null)}
          onModelChange={activeSessionId ? (m) => handleModelChange(activeSessionId, m) : undefined}
          autoMode={isControlCenter ? fleetAutoMode : undefined}
          onToggleAutoMode={isControlCenter ? toggleFleetAutoMode : undefined}
          controlCenter={isControlCenter}
          slotAbove={
            <>
              {permissionRequest && effectiveSessionId ? (
                <PermissionDialog
                  request={permissionRequest}
                  sessionId={effectiveSessionId}
                  onAllow={(id, toolName) => wsManager.sendPermissionResponse(effectiveSessionId, id, true, false, toolName)}
                  onAllowAlways={(id, toolName) => wsManager.sendPermissionResponse(effectiveSessionId, id, true, true, toolName)}
                  onDeny={(id, toolName) => wsManager.sendPermissionResponse(effectiveSessionId, id, false, false, toolName)}
                />
              ) : null}
              {/* Fleet decision card — surfaces what the co-pilot
                  thinks should happen after the last agent turn.
                  Self-gated: returns null when the session is in
                  manual mode or has no pending decision. */}
              {!isControlCenter && effectiveSessionId && (
                <FleetDecisionCard
                  sessionId={effectiveSessionId}
                  onSend={(text) => handleAgentSend(text)}
                  onAnswer={(question) => {
                    // Pre-fill the user's input with the question
                    // verbatim so they can edit or append before
                    // sending. Fires through the same custom event
                    // the @-mention picker uses to nudge the input.
                    window.dispatchEvent(new CustomEvent("fleet:focus-input", {
                      detail: { text: question },
                    }));
                  }}
                />
              )}
              {/* Session toolbar — pre-deploy setup row with folder /
                  git+worktree / model / perms / notes. Shown WHILE
                  the session has no messages yet (creation phase).
                  Once the user sends their first message and the
                  chat goes live, the toolbar unmounts and BranchStrip
                  takes over with the full base ← branch / diff / PR
                  view. */}
              {!isControlCenter && effectiveSessionId && activeSession
                && !hasRealMessage && !isStreaming && (
                <SessionToolbar
                  sessionId={effectiveSessionId}
                  projectPath={activeSession.project_path || null}
                  tool={activeSession.tool ?? "claude"}
                  model={activeSession.model_name ?? null}
                  permissionMode={activeSession.permission_mode ?? "default"}
                  claudeSessionId={activeSession.claude_session_id}
                  useWorktree={activeSession.use_worktree ?? true}
                />
              )}
            </>
          }
          agentMentions={isControlCenter ? (() => {
            const agents = agentSessions.map(s => ({
              id: s.id, name: s.title, status: s.status,
              project_path: s.project_path || undefined,
              kind: "agent" as const,
            }));
            const seenPaths = new Set<string>();
            const folders = agentSessions
              .map(s => s.project_path)
              .filter((p): p is string => !!p)
              .filter(p => { if (seenPaths.has(p)) return false; seenPaths.add(p); return true; })
              .map(p => ({
                id: `folder:${p}`,
                name: folderName(p) || p,
                status: "",
                project_path: p,
                kind: "folder" as const,
              }));
            return [...agents, ...folders];
          })() : undefined}
        />
      </div>
      <NotificationStack onSelectSession={setActiveSession} />
    </div>
  );
}

/* ══════════════════════════════════════
   FLEET — control-center surface (dashboard or empty welcome)
══════════════════════════════════════ */

function FleetChatEmptyState({ agents, onNewAgent, onSelectAgent: _onSelectAgent }: {
  agents: Session[];
  onNewAgent: () => void;
  onSelectAgent: (id: string) => void;
}) {
  // Whenever the chat canvas is empty on the Fleet hub, show the
  // welcome composition — regardless of whether agents already exist
  // elsewhere. The user wants the canvas to have something to land
  // on every time it opens with no messages, not just on first run.
  return <EmptyFleetWelcome onNewAgent={onNewAgent} hasAgents={agents.length > 0} />;
}

/* ── Empty fleet welcome ──────────────────────────────────────────
   Shown on the Fleet hub when the user has no agents yet. Goal:
   make the surface feel deliberate — not "screen left blank because
   there's nothing to render" — and give the user 4 obvious entry
   points to the source picker (Local / Git / Remote / Container)
   without forcing them through the sidebar to discover them.

   Each source card spawns a draft session AND tells the toolbar to
   pre-open the source picker on the matching tab via the
   `fleet:open-source-tab` window event the toolbar listens for. */
type SourceKind = "local" | "git" | "remote" | "container";
function EmptyFleetWelcome({ onNewAgent, hasAgents = false }: { onNewAgent: () => void; hasAgents?: boolean }) {
  const launchOnTab = useCallback((tab: SourceKind) => {
    onNewAgent();
    // Defer one frame so the new session has time to mount its
    // toolbar before we ask it to open a tab.
    requestAnimationFrame(() => {
      window.dispatchEvent(new CustomEvent("fleet:open-source-tab", { detail: { tab } }));
    });
  }, [onNewAgent]);

  return (
    <div style={{
      display: "flex", flexDirection: "column",
      alignItems: "center", justifyContent: "center",
      minHeight: "60vh",
      padding: "32px 32px 48px",
      textAlign: "center",
    }}>
      {/* Single cluster — brand + headline + tagline read as one
          masthead. Compact gaps so it doesn't break apart into
          three floating pieces (the user's "ayrı gözüküyor"
          complaint). The whole thing is capped to 480px so the
          tagline doesn't sprawl across the canvas. */}
      <div style={{
        display: "flex", flexDirection: "column",
        alignItems: "center", gap: 6,
        marginBottom: 18,
        maxWidth: 480,
      }}>
        <BrandLockup compact />
        <h2 style={{
          marginTop: 6, marginBottom: 0,
          fontSize: 20, fontWeight: 600, letterSpacing: "-0.025em",
          color: "var(--foreground)", lineHeight: 1.2,
        }}>
          {hasAgents ? "Spawn a new agent" : "Your fleet is empty"}
        </h2>
        <p style={{
          margin: 0,
          fontSize: 12.5, color: "var(--c-dim)", lineHeight: 1.5,
          maxWidth: 360,
        }}>
          {hasAgents
            ? "Pick how you'd like to start the next one."
            : "Spawn an agent and point it at a project. Pick how you'd like to start."}
        </p>
      </div>

      {/* Source-kind grid — 4 cards in a 2×2 (or wraps to 1×4 on
          narrow widths). Each row spawns a fresh draft session AND
          deep-links straight into the matching source-picker tab. */}
      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
        gap: 8,
        width: "100%",
        maxWidth: 520,
      }}>
        <SourceCard
          icon={<Monitor size={14} />}
          title="Local folder"
          desc="A project already on this machine"
          onClick={() => launchOnTab("local")}
        />
        <SourceCard
          icon={<Github size={14} />}
          title="Clone from Git"
          desc="A GitHub repo or git URL"
          onClick={() => launchOnTab("git")}
        />
        <SourceCard
          icon={<Server size={14} />}
          title="Remote SSH"
          desc="A workspace on a remote box"
          onClick={() => launchOnTab("remote")}
        />
        <SourceCard
          icon={<Box size={14} />}
          title="Docker container"
          desc="A running container's filesystem"
          onClick={() => launchOnTab("container")}
        />
      </div>

      {/* Footnote — sits closer to the cards now so it reads as a
          tail of the same composition rather than a stranded line. */}
      <div style={{
        marginTop: 14,
        display: "inline-flex", alignItems: "center", gap: 6,
        fontSize: 11.5, color: "var(--c-ghost, #6a6a6a)",
      }}>
        <span>or press</span>
        <Kbd>⌘</Kbd>
        <Kbd>N</Kbd>
        <span>for a fresh session</span>
      </div>
    </div>
  );
}

function SourceCard({
  icon, title, desc, onClick,
}: {
  icon: React.ReactNode;
  title: string;
  desc: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      onMouseDown={e => e.preventDefault()}
      style={{
        display: "flex", flexDirection: "column", alignItems: "flex-start",
        gap: 4, padding: "12px 14px", textAlign: "left",
        borderRadius: 8,
        background: "rgba(255,255,255,0.025)",
        border: "1px solid rgba(255,255,255,0.06)",
        color: "var(--foreground)",
        cursor: "pointer", outline: "none",
        fontFamily: "var(--font-sans)",
        transition: "background 0.14s, border-color 0.14s, transform 0.08s",
      }}
      onMouseEnter={e => {
        e.currentTarget.style.background = "rgba(255,255,255,0.05)";
        e.currentTarget.style.borderColor = "rgba(255,255,255,0.14)";
      }}
      onMouseLeave={e => {
        e.currentTarget.style.background = "rgba(255,255,255,0.025)";
        e.currentTarget.style.borderColor = "rgba(255,255,255,0.06)";
      }}
    >
      <div style={{
        display: "flex", alignItems: "center", gap: 7, width: "100%",
      }}>
        <span style={{ display: "inline-flex", color: "var(--c-dim)", flexShrink: 0 }}>
          {icon}
        </span>
        <span style={{
          flex: 1,
          fontSize: 13, fontWeight: 500,
          color: "var(--foreground)",
        }}>
          {title}
        </span>
        <ArrowRight size={11} style={{ color: "var(--c-ghost, #6a6a6a)", flexShrink: 0 }} />
      </div>
      <span style={{
        fontSize: 11.5, color: "var(--c-dim)",
        lineHeight: 1.4,
      }}>
        {desc}
      </span>
    </button>
  );
}

/* ── Kbd — small key-cap pill used by the empty-state footnote ──
   Single character per pill so a multi-key combo reads as a real
   keyboard rather than one mashed pill. Tabular numerals so digits
   sit on the same baseline as letters. */
function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", justifyContent: "center",
      minWidth: 18, height: 18,
      padding: "0 5px",
      borderRadius: 4,
      fontSize: 10.5, fontWeight: 500,
      lineHeight: 1,
      color: "var(--c-low, #b5b5b5)",
      background: "var(--c-srf2, rgba(255,255,255,0.05))",
      border: "1px solid var(--c-brd, rgba(255,255,255,0.10))",
      borderBottomWidth: 2,
      fontFamily: "var(--font-sans)",
      fontVariantNumeric: "tabular-nums",
    }}>
      {children}
    </span>
  );
}

/* ── Brand lockup (reused) ─────────────────────────────────── */
function BrandLockup({
  marginBottom = 0,
  compact = false,
}: {
  marginBottom?: number;
  compact?: boolean;
}) {
  // compact = empty-state size (matches the rest of the app's chrome,
  // not a 22px hero treatment).
  const logo = compact ? 18 : 26;
  const text = compact ? 15 : 22;
  return (
    <div style={{
      display: "inline-flex", alignItems: "center", gap: compact ? 8 : 10,
      marginBottom, color: "var(--foreground)",
    }}>
      <LogoMark size={logo} color="currentColor" />
      <span style={{
        fontFamily: "'Geist Variable', 'Geist', system-ui, sans-serif",
        fontWeight: 700, fontSize: text, letterSpacing: "-0.025em", lineHeight: 1,
      }}>
        Fleetify
      </span>
    </div>
  );
}


/* ══════════════════════════════════════
   NOTIFICATION STACK
══════════════════════════════════════ */

function NotificationStack({ onSelectSession }: { onSelectSession: (id: string) => void }) {
  // Granular selectors — same reason as ChatView. Was: a destructure
  // of the entire app-store, so the toast stack re-rendered on EVERY
  // store change (status updates, session-list polls, sidebar toggle,
  // active-session navigation) even when no notification field
  // changed. The dismiss loop would then re-arm every timer.
  const notifications      = useAppStore((s) => s.notifications);
  const dismissNotification = useAppStore((s) => s.dismissNotification);
  const sessions           = useAppStore((s) => s.sessions);
  const staffSessionId     = useAppStore((s) => s.staffSessionId);
  const activeSessionId    = useAppStore((s) => s.activeSessionId);

  // ── Per-id auto-dismiss timers ──
  // The previous implementation deps-keyed the effect on the joined id
  // list. Every new notification arrived → all existing timers were
  // cleared and re-armed for a fresh 6s. Under busy fleets (5+
  // dispatches finishing in 30s) notifications never auto-dismissed
  // because each one kept resetting the others' clocks. Fix: keep a
  // ref-keyed Map<id, timeoutHandle> and only arm a timer for ids we
  // haven't already armed; clear timers for ids that disappeared.
  const dismissTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  useEffect(() => {
    const timers = dismissTimersRef.current;
    const liveIds = new Set(notifications.map(n => n.id));
    // Arm timers for newly-arrived notifications.
    // Action-bearing toasts (e.g. "View on GitHub", "Open github.com/new")
    // get 12s so the user has time to read the message and click the link
    // before it auto-dismisses. Plain toasts keep the 6s baseline. Spec §8.2.
    for (const n of notifications) {
      if (timers.has(n.id)) continue;
      const ttl = n.action ? 12000 : 6000;
      timers.set(n.id, setTimeout(() => {
        dismissNotification(n.id);
        timers.delete(n.id);
      }, ttl));
    }
    // Clear timers for notifications that disappeared (dismissed,
    // cleared) — drop their pending dismiss callbacks.
    for (const [id, t] of timers.entries()) {
      if (!liveIds.has(id)) {
        clearTimeout(t);
        timers.delete(id);
      }
    }
  }, [notifications, dismissNotification]);
  // Final cleanup on unmount — drop any straggler timers.
  useEffect(() => {
    const timers = dismissTimersRef.current;
    return () => {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    };
  }, []);

  // Click handler: instead of yanking the user to the dispatched
  // agent's chat, keep them on Fleet and scroll-highlight the matching
  // dispatch_result card. The card already lives in the staff chat —
  // the notification just helps the user find it. If they're not
  // currently on Fleet, switch them there first, then scroll.
  const handleNotifClick = (n: { id: string; sessionId: string }) => {
    dismissNotification(n.id);
    const onStaff = !activeSessionId || activeSessionId === staffSessionId;
    const scrollAndHighlight = () => {
      // Find every dispatch_result card for this target agent; the
      // newest is the one the notification just announced.
      const cards = document.querySelectorAll<HTMLElement>(
        `[data-dispatch-result-agent="${n.sessionId}"]`,
      );
      const card = cards[cards.length - 1];
      if (!card) return;
      card.scrollIntoView({ behavior: "smooth", block: "center" });
      // Brief flash so the eye lands on it. Solid theme color (not rgba)
      // per the contrast pattern rule. Reverts after 1.6s.
      const original = card.style.background;
      card.style.background = "var(--c-srf2)";
      card.style.boxShadow = "0 0 0 2px var(--c-brd2)";
      setTimeout(() => {
        card.style.background = original;
        card.style.boxShadow = "";
      }, 1600);
    };
    if (onStaff) {
      // Already on Fleet — scroll on the next tick so any pending
      // re-render commits first (e.g. a freshly-added result card).
      setTimeout(scrollAndHighlight, 50);
    } else {
      // Switch to staff first, then wait for chat to mount + load.
      onSelectSession(staffSessionId ?? n.sessionId);
      setTimeout(scrollAndHighlight, 350);
    }
  };

  if (notifications.length === 0) return null;

  return (
    <div style={{
      position: "absolute", bottom: 100, right: 20, zIndex: 50,
      display: "flex", flexDirection: "column", gap: 8,
      maxWidth: 360, pointerEvents: "none",
    }}>
      {notifications.map((n) => {
        const session = sessions.find((s) => s.id === n.sessionId);
        const title = session?.title ?? n.title;
        return (
          <div
            key={n.id}
            onClick={() => handleNotifClick(n)}
            style={{
              pointerEvents: "auto",
              padding: "11px 14px", borderRadius: 10,
              background: "var(--card)", border: `1px solid ${n.success ? "var(--c-brd)" : "rgba(248,113,113,0.25)"}`,
              boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
              cursor: "pointer", animation: "slideInNotif 0.3s cubic-bezier(0.22,1,0.36,1)",
              display: "flex", gap: 10, alignItems: "flex-start",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.transform = "translateY(-1px)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.transform = "none"; }}
          >
            <span style={{ color: n.success ? "var(--c-med)" : "rgba(248,113,113,0.9)", flexShrink: 0, marginTop: 1 }}>
              {n.success ? <CheckCircle2 size={14} /> : <AlertCircle size={14} />}
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--c-high)", marginBottom: 2,
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {/* " finished" only makes sense when the notification
                    is an agent-task completion (sessionId resolves to a
                    real agent). System notifications already include
                    their own verb in the title — appending "finished"
                    produced things like "PR creation failed finished". */}
                {session ? `${title} finished` : title}
              </div>
              <div style={{ fontSize: 11.5, color: "var(--c-low)", lineHeight: 1.4,
                display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical",
                overflow: "hidden" }}>
                {n.summary}
              </div>
              {n.action && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    const w = window as unknown as { electronAPI?: { openExternal?: (url: string) => Promise<unknown> } };
                    w.electronAPI?.openExternal?.(n.action!.url);
                  }}
                  style={{
                    marginTop: 6,
                    background: "transparent", border: "none",
                    color: "var(--c-fg)", cursor: "pointer",
                    fontSize: 11.5, padding: 0,
                    display: "inline-flex", alignItems: "center", gap: 4,
                    fontFamily: "inherit",
                  }}
                >
                  {n.action.label}
                  <ExternalLink size={10} />
                </button>
              )}
            </div>
            <button
              onClick={(e) => { e.stopPropagation(); dismissNotification(n.id); }}
              style={{
                background: "none", border: "none", padding: 2, cursor: "pointer",
                color: "var(--c-dim)", display: "flex", alignItems: "center",
                borderRadius: 4, flexShrink: 0,
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "var(--c-srf)"; e.currentTarget.style.color = "var(--c-high)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "none"; e.currentTarget.style.color = "var(--c-dim)"; }}
            >
              <X size={12} />
            </button>
          </div>
        );
      })}
      <style>{`
        @keyframes slideInNotif {
          from { opacity: 0; transform: translateX(20px); }
          to   { opacity: 1; transform: translateX(0); }
        }
      `}</style>
    </div>
  );
}

/* ── Panel view menu ──
 *
 * Claude Code-style dropdown anchored to the panel-toggle button in
 * the chat header. Six entries with right-aligned keyboard shortcut
 * hints. Selecting any item opens the right panel and switches it
 * to that view. Same shortcuts also fire globally via
 * use-keyboard-shortcuts so the user never needs the menu open to
 * reach them.
 *
 * Order matches the reference: Preview, Diff, Terminal, Files,
 * Tasks, Plan. The four with shortcuts use the modifier hints that
 * Claude Code Desktop ships (⌘P / ⌘D / ` / ⌘F). */
const PANEL_VIEWS: {
  id: WorkspaceView;
  label: string;
  Icon: React.ComponentType<{ size: number; strokeWidth?: number }>;
  /** Keyboard shortcut display — strings rendered as small Kbd chips
   *  on the right of the row. Order matches modifier-then-key. */
  shortcut?: string[];
}[] = [
  { id: "preview",  label: "Preview",  Icon: Play,             shortcut: ["⇧", "⌘", "P"] },
  { id: "diff",     label: "Diff",     Icon: GitCompareArrows, shortcut: ["⇧", "⌘", "D"] },
  { id: "terminal", label: "Terminal", Icon: TerminalIcon,     shortcut: ["⌃", "`"] },
  { id: "files",    label: "Files",    Icon: FolderOpen,       shortcut: ["⇧", "⌘", "F"] },
  { id: "tasks",    label: "Tasks",    Icon: ListTodo },
  { id: "memories", label: "Memories", Icon: Layers },
  // Agent panel intentionally NOT listed — it's auto-spawned by
  // sub-agent dispatch lifecycle events (subagent_start in ws-manager),
  // not something the user opens manually. Adding a menu entry made
  // it look like an idle workspace pane, which it isn't.
];

function PanelViewMenu({
  open, activeViews, onSelectView, onRemoveView,
}: {
  open: boolean;
  activeViews: WorkspaceView[];
  /** Kept for back-compat with callers that still pass an onToggle.
   *  The "Close panel" footer was dropped — toggling open/closed is
   *  now an emergent property of having any view in activeViews,
   *  not a separate row in the picker. */
  onToggle?: () => void;
  onSelectView: (v: WorkspaceView) => void;
  onRemoveView: (v: WorkspaceView) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const click = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setMenuOpen(false); };
    document.addEventListener("mousedown", click);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", click); document.removeEventListener("keydown", esc); };
  }, [menuOpen]);

  const toggle = useCallback((v: WorkspaceView) => {
    if (activeViews.includes(v)) onRemoveView(v);
    else                          onSelectView(v);
    setMenuOpen(false);
  }, [activeViews, onSelectView, onRemoveView]);

  return (
    <div ref={wrapRef} style={{ position: "relative", display: "flex" }}>
      <button
        onClick={() => setMenuOpen(v => !v)}
        onContextMenu={(e) => { e.preventDefault(); setMenuOpen(v => !v); }}
        title="Open panel section"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        style={{
          width: 22, height: 22, borderRadius: 5,
          display: "flex", alignItems: "center", justifyContent: "center",
          background: menuOpen ? "var(--c-brd)" : "none",
          border: "none", outline: "none",
          color: menuOpen ? "var(--c-med)" : "var(--c-dim)", cursor: "pointer",
          transition: "background 0.1s, color 0.1s",
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = "var(--c-brd)"; e.currentTarget.style.color = "var(--c-med)"; }}
        onMouseLeave={(e) => {
          if (!menuOpen) { e.currentTarget.style.background = "none"; e.currentTarget.style.color = "var(--c-dim)"; }
        }}
      >
        <PanelRight size={14} />
      </button>

      {menuOpen && (
        <div
          role="menu"
          style={{
            position: "absolute", top: "calc(100% + 5px)", right: 0,
            minWidth: 198, zIndex: 1000,
            background: "#1a1a1a",
            border: "1px solid rgba(255,255,255,0.07)",
            borderRadius: 9,
            padding: 4,
            boxShadow:
              "0 12px 28px rgba(0,0,0,0.55), " +
              "0 2px 6px rgba(0,0,0,0.35)",
            fontFamily: "-apple-system,BlinkMacSystemFont,'Inter',system-ui,sans-serif",
            animation: "fleetMenuIn 0.12s cubic-bezier(0.4, 0, 0.2, 1)",
          }}
        >
          {PANEL_VIEWS.map(({ id, label, Icon, shortcut }) => {
            const active = open && activeViews.includes(id);
            return (
              <button
                key={id}
                role="menuitemcheckbox"
                aria-checked={active}
                onClick={() => toggle(id)}
                onMouseDown={(e) => e.preventDefault()}
                style={{
                  display: "flex", alignItems: "center", gap: 8,
                  width: "100%", padding: "4px 8px",
                  background: "transparent",
                  border: "none", outline: "none", borderRadius: 5,
                  color: "#e3e3e3",
                  cursor: "pointer", textAlign: "left",
                  transition: "background 0.08s, color 0.08s",
                  fontSize: 12, fontWeight: 500, letterSpacing: "-0.005em",
                  fontFamily: "inherit", lineHeight: 1.3,
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.05)";
                  (e.currentTarget as HTMLElement).style.color = "#ffffff";
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLElement).style.background = "transparent";
                  (e.currentTarget as HTMLElement).style.color = "#e3e3e3";
                }}
              >
                <span style={{
                  width: 13, height: 13,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  color: active ? "#ffffff" : "#a8a8a8",
                  flexShrink: 0,
                }}>
                  <Icon size={12} strokeWidth={1.7} />
                </span>
                <span style={{ flex: 1, minWidth: 0 }}>{label}</span>
                {/* Check + shortcut sit in a fixed right-side cluster
                    so columns line up across rows. Check sits BEFORE
                    the shortcut, matching Claude Code Desktop. */}
                <span style={{
                  width: 10, marginRight: shortcut ? 6 : 0,
                  display: "inline-flex", alignItems: "center", justifyContent: "center",
                  color: active ? "#d4d4d4" : "transparent",
                  flexShrink: 0,
                }}>
                  <Check size={10} strokeWidth={2.5} />
                </span>
                {shortcut && (
                  <span style={{
                    display: "inline-flex", alignItems: "center", gap: 0,
                    color: "#7a7a7a",
                    fontSize: 11,
                    fontFamily: "-apple-system,BlinkMacSystemFont,system-ui,sans-serif",
                    flexShrink: 0,
                    fontVariantNumeric: "tabular-nums",
                  }}>
                    {shortcut.map((k, i) => (
                      <span key={i} style={{ minWidth: 9, textAlign: "center" }}>{k}</span>
                    ))}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

      <style>{`
        @keyframes fleetMenuIn {
          from { opacity: 0; transform: translateY(-4px) scale(0.98); }
          to   { opacity: 1; transform: translateY(0) scale(1); }
        }
      `}</style>
    </div>
  );
}


/* ── Keyboard shortcuts popover ── */
const SHORTCUT_GROUPS = [
  {
    label: "Navigation",
    items: [
      { keys: ["⌘", "1–9"], desc: "Switch to agent by number" },
      { keys: ["⌘⇧", "F"], desc: "Go to Fleet overview" },
      { keys: ["Esc"], desc: "Back to Fleet (when not streaming)" },
    ],
  },
  {
    label: "Interface",
    items: [
      { keys: ["⌘⇧", "S"], desc: "Toggle sidebar" },
      { keys: ["⌘⇧", "."], desc: "Toggle right panel" },
      { keys: ["⌘⇧", "N"], desc: "New agent" },
    ],
  },
  {
    label: "Fleetify",
    items: [
      { keys: ["⌘⇧", "A"], desc: "Abort all running agents" },
    ],
  },
];

function ShortcutsPopover() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        onClick={() => setOpen(v => !v)}
        title="Keyboard shortcuts"
        style={{
          width: 22, height: 22, borderRadius: 5,
          display: "flex", alignItems: "center", justifyContent: "center",
          background: open ? "var(--c-brd)" : "none", border: "none", outline: "none",
          color: open ? "var(--c-med)" : "var(--c-dim)", cursor: "pointer",
          transition: "background 0.1s, color 0.1s",
        }}
        onMouseEnter={e => { e.currentTarget.style.background = "var(--c-brd)"; e.currentTarget.style.color = "var(--c-med)"; }}
        onMouseLeave={e => {
          if (!open) { e.currentTarget.style.background = "none"; e.currentTarget.style.color = "var(--c-dim)"; }
        }}
      >
        <Keyboard size={14} />
      </button>

      {open && (
        <div style={{
          position: "absolute", right: 0, top: 34, zIndex: 9999,
          width: 260, borderRadius: 10, padding: "8px",
          background: "var(--popover)",
          border: "1px solid var(--c-brd2)",
          boxShadow: "0 8px 28px rgba(0,0,0,0.55), 0 2px 8px rgba(0,0,0,0.2)",
        }}>
          <div style={{ fontSize: 10.5, fontWeight: 700, color: "var(--c-ghost)", letterSpacing: "0.07em", textTransform: "uppercase", padding: "2px 4px 8px" }}>
            Keyboard shortcuts
          </div>
          {SHORTCUT_GROUPS.map(group => (
            <div key={group.label} style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 9.5, fontWeight: 700, color: "var(--c-ghost)", letterSpacing: "0.06em", textTransform: "uppercase", padding: "2px 4px 4px", opacity: 0.6 }}>
                {group.label}
              </div>
              {group.items.map(item => (
                <div key={item.desc} style={{
                  display: "flex", alignItems: "center", justifyContent: "space-between",
                  padding: "4px 4px", borderRadius: 5,
                  gap: 8,
                }}>
                  <span style={{ fontSize: 11.5, color: "var(--c-low)", flex: 1 }}>{item.desc}</span>
                  <div style={{ display: "flex", alignItems: "center", gap: 2, flexShrink: 0 }}>
                    {item.keys.map((k, ki) => (
                      <span key={ki} style={{
                        fontSize: 10, fontFamily: "var(--font-mono, monospace)",
                        color: "var(--c-dim)",
                        background: "var(--c-srf)",
                        border: "1px solid var(--c-brd2)",
                        borderRadius: 4, padding: "1px 5px",
                        lineHeight: "16px",
                      }}>
                        {k}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function IBtn({ children, onClick, title, style }: { children: React.ReactNode; onClick?: () => void; title?: string; style?: React.CSSProperties }) {
  return (
    <button onClick={onClick} title={title} style={{
      width: 30, height: 30, borderRadius: 6,
      display: "flex", alignItems: "center", justifyContent: "center",
      background: "none", border: "none", outline: "none",
      color: "var(--c-dim)", cursor: "pointer",
      ...style,
    }}
      onMouseEnter={(e) => { e.currentTarget.style.background = "var(--c-brd)"; e.currentTarget.style.color = "var(--c-med)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = "none"; e.currentTarget.style.color = "var(--c-dim)"; }}
    >{children}</button>
  );
}
