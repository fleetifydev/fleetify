import { useEffect, useRef, useState, useCallback, lazy, Suspense } from "react";
import { useQuery } from "@tanstack/react-query";
import { Sidebar } from "./sidebar";
import { ChatSurface } from "@/components/chat/chat-surface";
import { RightPanelWrapper } from "./right-panel-wrapper";
import { NewAgentView } from "@/components/agent/new-agent-dialog";
import { FirstLaunchTour } from "@/components/onboarding/first-launch-tour";
import { WindowsTitleBar } from "./windows-title-bar";
// MarketplacePage and WorkflowsPage are lazy-loaded — they're
// rarely the first surface a user lands on (chat is), and pulling
// them out of the initial bundle measurably speeds up cold start.
// Suspense fallback is a quiet placeholder so the chunk download
// (~50-100ms on a warm cache, more on cold) doesn't flash blank.
const MarketplacePage = lazy(() =>
  import("@/components/marketplace/MarketplacePage").then(m => ({ default: m.MarketplacePage })),
);
const WorkflowsPage = lazy(() =>
  import("@/components/workflows/WorkflowsPage").then(m => ({ default: m.WorkflowsPage })),
);
import { useAppStore } from "@/stores/app-store";
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";
import { fetchSessions, deleteEmptyDrafts } from "@/lib/api";
import type { Session, SessionStatus } from "@/types/session";

const LEFT_MIN = 170;
const LEFT_MAX = 360;
const LEFT_DEFAULT = 224;

const RIGHT_MIN = 280;
// Upper bound is computed at drag-time from the live window width so
// the user can grow the right panel as far as the layout physically
// allows — we just reserve enough room for the sidebar + a usable
// chat column (CHAT_MIN). Without this the panel hard-stopped at
// 1100px even on wide monitors, which felt arbitrary.
const CHAT_MIN = 360;
const RIGHT_DEFAULT = 580;

function useDrag(
  onDelta: (dx: number) => void,
  setDragging: (v: boolean) => void,
) {
  const dragging = useRef(false);
  const lastX = useRef(0);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    lastX.current = e.clientX;
    setDragging(true);

    const onMove = (ev: MouseEvent) => {
      if (!dragging.current) return;
      const dx = ev.clientX - lastX.current;
      lastX.current = ev.clientX;
      onDelta(dx);
    };
    const onUp = () => {
      dragging.current = false;
      setDragging(false);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [onDelta, setDragging]);

  return onMouseDown;
}

export function AppShell({ introReveal = false }: { introReveal?: boolean }) {
  useKeyboardShortcuts();

  const {
    setSessions, updateSession, staffSessionId, setStaffSessionId,
    sidebarCollapsed, sessions, setActiveSession,
    rightPanelOpen, toggleRightPanel, _removedIds, pruneRemovedIds, mainView,
  } = useAppStore();

  // ── Cinematic reveal: sidebar slides in after chat content appears ──
  const [overlayVisible, setOverlayVisible] = useState(introReveal);
  const [sidebarIn, setSidebarIn] = useState(!introReveal);
  const [revealDone, setRevealDone] = useState(!introReveal);

  useEffect(() => {
    if (!introReveal) return;
    // Step 1: fade out overlay → chat content appears (200ms)
    const t1 = setTimeout(() => setOverlayVisible(false), 200);
    // Step 2: slide sidebar in (820ms — after content is visible)
    const t2 = setTimeout(() => setSidebarIn(true), 820);
    // Step 3: mark reveal done after sidebar animation finishes (~1800ms)
    const t3 = setTimeout(() => setRevealDone(true), 1900);
    return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); };
  }, [introReveal]);

  // Legacy modal flag — kept for the rare path that still opens it
  // explicitly (advanced "/new" command, plugin templates). The
  // sidebar + button and ⌘N now jump straight to a draft session.
  const [showNewAgent, setShowNewAgent] = useState(false);
  const beginDraft = useAppStore(s => s.beginDraft);
  const createWelcomeSession = useAppStore(s => s.createWelcomeSession);

  useEffect(() => {
    const handler = () => { void beginDraft(); };
    window.addEventListener("fleet:new-agent", handler);
    return () => window.removeEventListener("fleet:new-agent", handler);
  }, [beginDraft]);

  // ── First-launch experience ──
  // Order matters here, per the user's spec ("önce welcome mesajı,
  // sonra platform turu"): we create the welcome chat FIRST, let the
  // assistant's intro type itself out so the user has something
  // tangible to read, and ONLY THEN launch the spotlight tour. Tour
  // and welcome message can't start at the same time — that left the
  // user staring at an empty hub with a floating dialog and no
  // context for what they were looking at.
  const [tourActive, setTourActive] = useState(false);
  const tourBootstrapped = useRef(false);
  useEffect(() => {
    if (tourBootstrapped.current) return;
    if (!revealDone) return;
    let done = false;
    // Key matches FirstLaunchTour.TOUR_FLAG. Bumped from "fleet:tour-done"
    // to "-v2" so users whose old flag was set spuriously by failed
    // tests get a clean shot at the actual experience.
    try { done = localStorage.getItem("fleet:tour-done-v2") === "1"; } catch { /* noop */ }
    if (done) return;
    tourBootstrapped.current = true;

    let userName: string | null = null;
    try {
      const raw = localStorage.getItem("fleet:user");
      if (raw) userName = (JSON.parse(raw) as { name?: string }).name ?? null;
    } catch { /* ignore */ }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    (async () => {
      const result = await createWelcomeSession(userName);
      if (cancelled) return;
      // Wait for the typed-out greeting to land + a beat to read it.
      // If the API call failed (no backend, auth blip), fall back to
      // a fixed 1.5s delay so the tour still fires — better to teach
      // the user the UI than to leave them in limbo.
      const waitMs = result ? result.durationMs + 1400 : 1500;
      timer = setTimeout(() => { if (!cancelled) setTourActive(true); }, waitMs);
    })();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [revealDone, createWelcomeSession]);

  // ── Visibility-driven reconnect ──
  // When the user re-focuses Fleet (Electron window blur → focus,
  // or browser tab hidden → visible), reconnect any inactive WS
  // for currently-running agents so the user lands on fresh state
  // instead of stale buffers. Idle agents stay disconnected — the
  // chat-view effect above only opens WS for live-status sessions
  // anyway, so this is a no-op for those.
  useEffect(() => {
    const onVisible = () => {
      if (document.hidden) return;
      // Defer to next tick so the store has fully settled first.
      const liveStatuses = new Set(["running", "starting", "waiting"]);
      const live = useAppStore.getState().sessions
        .filter(s => liveStatuses.has(s.status));
      // Lazy import — avoids circular at module load.
      import("@/services/ws-manager").then(m => {
        for (const s of live) m.wsManager.ensureConnected(s.id).catch(() => {});
      });
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  const [leftWidth, setLeftWidth] = useState(LEFT_DEFAULT);
  const [rightWidth, setRightWidth] = useState(RIGHT_DEFAULT);
  const [leftDragging, setLeftDragging] = useState(false);
  const [rightDragging, setRightDragging] = useState(false);

  // Pause polling when the window isn't focused. React Query supports
  // a function for refetchInterval — return false to skip the tick.
  // Cuts wasted backend hits + Zustand updates while the user is in
  // another app (where polled data wouldn't be visible anyway). The
  // tab-back refocus event triggers React Query's stale-on-window-focus
  // refetch automatically, so the user never sees old data.
  // One-shot zombie purge on mount: deletes any "New chat" / blank-title
  // session rows that have no project_path and no messages. These
  // accumulated under an old eager-commit code path; cleaning them up
  // automatically on every boot is safe — the rows carry no work.
  useEffect(() => {
    void deleteEmptyDrafts().catch(() => { /* noop — best effort */ });
    // Start the routines scheduler. Idempotent; fires the first tick
    // on the next macro task so any UI subscribers mount first.
    void import("@/services/routines-runtime").then(m => m.init());
  }, []);

  const { data: sessionsData } = useQuery({
    queryKey: ["sessions"],
    queryFn: fetchSessions,
    refetchInterval: () =>
      (typeof document !== "undefined" && document.visibilityState === "visible") ? 5000 : false,
    refetchIntervalInBackground: false,
  });

  useEffect(() => {
    // The backend can briefly return non-array payloads during a 5xx — guard
    // before we feed it to .filter()/.find() so a bad fetch doesn't crash the
    // shell and force a refresh.
    if (!Array.isArray(sessionsData)) return;
    const serverData = sessionsData as Session[];
    // Filter out any IDs the user just removed locally — they may not have
    // propagated to the server yet (archive POST is async).
    //
    // CRITICAL: the previous version mutated `_removedIds` in place inside
    // a render-effect with `_removedIds.delete(id)`. Mutations on the
    // Set held by Zustand state don't trigger consumers (they compare by
    // reference) and they race with `removeSession` which builds a fresh
    // Set. The race window: user archives → removeSession adds id to a
    // NEW Set; this poll runs the next instant, sees the server still
    // returning the session (server hasn't processed the archive yet)
    // BUT the in-place loop here checks `serverData.some(...)` and finds
    // it, so .delete is skipped — fine. The dangerous race is the
    // opposite: server already dropped it, this loop deletes from the
    // Set just-built by removeSession, dropping intent before server
    // confirms — and on the very next poll the deleted session's row
    // reappears for a tick (when server's eventually-consistent view
    // briefly shows it again, e.g. read replica lag).
    //
    // Fix: only filter; never mutate. Set growth is bounded — even
    // archiving thousands of sessions keeps it in the low MB. Cleanup
    // happens in app-store.removeSession on next mount.
    const filtered = serverData.filter(s => !_removedIds.has(s.id));
    setSessions(filtered);
    // Immutable cleanup: ask the store to prune any tombstoned ids the
    // server has stopped echoing back. Internally this builds a fresh
    // Set only when there's something to drop.
    pruneRemovedIds(serverData.map(s => s.id));
    if (!staffSessionId) {
      const existing = serverData.find(s => s.title === "Staff Agent");
      if (existing) setStaffSessionId(existing.id);
    } else {
      const stillExists = serverData.some(s => s.id === staffSessionId);
      if (!stillExists) {
        const fallback = serverData.find(s => s.title === "Staff Agent");
        setStaffSessionId(fallback ? fallback.id : null);
      }
    }
  }, [sessionsData, setSessions, staffSessionId, setStaffSessionId, pruneRemovedIds, _removedIds]);

  // SSE connection for real-time status updates.
  //
  // Reconnect on error: native EventSource auto-reconnects only after a
  // CLEAN disconnect (server-sent close). Network blips, dev-server
  // restarts, and intermittent 5xx leave the EventSource in `CLOSED`
  // state forever — silently. The agent list status indicators then
  // freeze: a session that finished mid-blip stays "running" in the
  // sidebar until the user reloads. We restart the connection ourselves
  // on error with a small backoff so the indicators recover.
  const sseRef = useRef<EventSource | null>(null);
  useEffect(() => {
    let cancelled = false;
    let backoffMs = 1000;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const open = () => {
      if (cancelled) return;
      const es = new EventSource("/events/status");
      sseRef.current = es;
      es.onopen = () => { backoffMs = 1000; }; // reset on success
      es.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data) as { session_id: string; status: SessionStatus };
          updateSession(data.session_id, { status: data.status });
        } catch { /* ignore malformed events */ }
      };
      es.onerror = () => {
        // Browser already moved the connection toward CLOSED. Tear it
        // down explicitly and schedule a reconnect with backoff capped
        // at 30s — enough to weather a server restart without piling
        // up a thousand connection attempts.
        try { es.close(); } catch { /* noop */ }
        if (sseRef.current === es) sseRef.current = null;
        if (cancelled) return;
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(open, backoffMs);
        backoffMs = Math.min(backoffMs * 2, 30_000);
      };
    };
    open();

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      const es = sseRef.current;
      if (es) { try { es.close(); } catch { /* noop */ } sseRef.current = null; }
    };
  }, [updateSession]);

  // Left sidebar drag — moves right edge
  const onLeftDrag = useDrag(useCallback((dx: number) => {
    setLeftWidth(w => Math.min(LEFT_MAX, Math.max(LEFT_MIN, w + dx)));
  }, []), setLeftDragging);

  // Right panel drag — moves left edge (dx is inverted).
  // Max grows with the window: window width minus sidebar minus
  // CHAT_MIN. This is what lets the user pull the terminal panel
  // out as wide as their monitor allows.
  const onRightDrag = useDrag(useCallback((dx: number) => {
    setRightWidth(w => {
      const sidebar = sidebarIn && !sidebarCollapsed ? leftWidth : 0;
      const max = Math.max(RIGHT_MIN, window.innerWidth - sidebar - CHAT_MIN - 24 /* gutters */);
      return Math.min(max, Math.max(RIGHT_MIN, w - dx));
    });
  }, [leftWidth, sidebarIn, sidebarCollapsed]), setRightDragging);

  // Effective sidebar width — 0 when collapsed or during reveal
  const sidebarWidth = sidebarIn && !sidebarCollapsed ? leftWidth : 0;

  return (
    <div style={{
      display: "flex",
      flexDirection: "column",
      height: "100vh",
      overflow: "hidden",
      background: "var(--card)",
    }}>
      {/* Windows-only custom title bar — full width, sits above the
          sidebar/chat/right-panel grid. macOS renders nothing here. */}
      <WindowsTitleBar />

      <div style={{
        display: "flex",
        flex: 1,
        minHeight: 0,
        overflow: "hidden",
        /* Outer page is the chat-surface dark (#0C0C0C). The sidebar
           AND the right panel become inset cards floating on top of it
           — same treatment, symmetrical 8px gutters on the left and
           right when both are open. */
        background: "var(--card)",
        /* CRITICAL on macOS: NO top padding on the outer shell.
           macOS draws the traffic lights at window-y coordinates
           (independent of CSS padding). If the chat-header is pushed
           down by an outer padding, the lights and the chat-header
           toggle end up on different horizontal lines no matter what
           trafficLightPosition value we pick. By keeping the chat
           flush against the window's top edge, the lights and the
           44px chat-header naturally share the same y-row.
           On Windows the dedicated title-bar row above already owns
           the top chrome, so the inner grid simply starts beneath it.
           Inset spacing for the sidebar / right-panel cards is moved
           to those cards' own marginTop instead. */
        padding: sidebarCollapsed ? "0 8px 0 0" : "0 8px 0 8px",
        transition: "padding 0.2s ease",
      }}>

      {/* ── Reveal overlay: covers the hard-cut from SetupScreen ── */}
      {introReveal && (
        <div style={{
          position: "fixed", inset: 0, zIndex: 9000,
          background: "var(--background)",
          opacity: overlayVisible ? 1 : 0,
          transition: "opacity 0.55s ease",
          pointerEvents: "none",
        }} />
      )}

      {/* Left sidebar — fully inset card on all four sides, slides in
          during intro reveal. Top + bottom margins replicate what the
          outer shell padding used to provide, since that padding is
          now zero (so the chat can flush against the window edge and
          align with the macOS traffic lights). */}
      <div style={{
        width: sidebarWidth,
        flexShrink: 0,
        overflow: "hidden",
        background: sidebarCollapsed ? "transparent" : "var(--sidebar)",
        borderRadius: sidebarCollapsed ? 0 : 8,
        border: sidebarCollapsed ? "none" : "1px solid var(--c-brd)",
        marginTop: sidebarCollapsed ? 0 : 8,
        marginBottom: sidebarCollapsed ? 0 : 8,
        transition: leftDragging
          ? "none"
          : !revealDone && sidebarIn
            ? "width 0.9s cubic-bezier(0.22, 1, 0.36, 1)"
            : "width 0.2s ease",
        position: "relative",
      }}>
        {!sidebarCollapsed && <Sidebar />}

        {/* Left resize handle — only active when expanded */}
        {!sidebarCollapsed && (
          <div
            onMouseDown={onLeftDrag}
            style={{
              position: "absolute", top: 0, right: 0, bottom: 0,
              width: 4, cursor: "col-resize", zIndex: 10,
            }}
            onMouseEnter={e => (e.currentTarget.style.background = "var(--c-brd)")}
            onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
          />
        )}
      </div>

      {/* Main content — fills the page surface, no card chrome */}
      <div style={{
        flex: 1, overflow: "hidden",
        display: "flex", flexDirection: "column",
        background: "var(--card)",
        opacity: introReveal && overlayVisible ? 0 : 1,
        transition: introReveal ? "opacity 0.5s ease 0.15s" : "none",
      }}>
        {mainView === "marketplace" ? (
          <Suspense fallback={<div style={{ flex: 1, background: "var(--card)" }} />}>
            <MarketplacePage />
          </Suspense>
        ) : mainView === "workflows" ? (
          <Suspense fallback={<div style={{ flex: 1, background: "var(--card)" }} />}>
            <WorkflowsPage />
          </Suspense>
        ) : (
          // ChatSurface picks single vs multi-pane internally and
          // owns the drag-driven split flow (no Split button).
          <ChatSurface />
        )}
      </div>

      {/* Right panel — same inset-card treatment as the sidebar so
          the two flank the chat as a symmetrical pair: rounded
          corners, 1px border, 8px bottom margin. Collapsed state
          drops the chrome to zero so the chat reclaims the width. */}
      <div style={{
        width: rightPanelOpen ? rightWidth : 0,
        flexShrink: 0,
        overflow: "hidden",
        // No outer card chrome any more — the workspace panes draw
        // their OWN cards (border + radius + shadow) and need to be
        // visually independent. Keeping a wrapping card here made
        // multi-pane look like "panes nested inside one big card",
        // which the user explicitly rejected. The only thing this
        // container carries now is the resize transition + margins
        // that hold content away from the window edges.
        background: "transparent",
        marginLeft: rightPanelOpen ? 8 : 0,
        marginTop: rightPanelOpen ? 8 : 0,
        marginBottom: rightPanelOpen ? 8 : 0,
        // Animate only when the panel is being toggled inside the fleet
        // surface. On Routines / Marketplace the panel is auto-closed
        // by setMainView, and animating that close drags the page-load
        // for a quarter second — feels laggy when the user just wants
        // to jump to the other surface. Snap instantly there.
        transition: rightDragging || mainView !== "fleet"
          ? "none"
          : "width 0.25s cubic-bezier(0.4, 0, 0.2, 1)",
        position: "relative",
      }}>
        {/* Right resize handle — sits on the LEFT inner edge of the card.
            Slightly inset so it doesn't paint over the rounded corner. */}
        {rightPanelOpen && (
          <div
            onMouseDown={onRightDrag}
            style={{
              position: "absolute", top: 0, left: -4, bottom: 0,
              width: 8, cursor: "col-resize", zIndex: 10,
            }}
          />
        )}

        <RightPanelWrapper
          sessions={sessions}
          onSelectAgent={id => setActiveSession(id)}
          onNewAgent={() => setShowNewAgent(true)}
          onClose={toggleRightPanel}
        />
      </div>

      {/* New Agent modal — rendered as overlay, not replacing content */}
      {showNewAgent && <NewAgentView onClose={() => setShowNewAgent(false)} />}

      {/* First-launch tour — runs once per machine */}
      {tourActive && <FirstLaunchTour onDone={() => setTourActive(false)} />}
      </div>
    </div>
  );
}
