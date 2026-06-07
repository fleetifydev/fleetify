import { useEffect, useRef, useState, useCallback, lazy, Suspense } from "react";
import { useQuery } from "@tanstack/react-query";
import { Sidebar } from "./sidebar";
import { ChatSurface } from "@/components/chat/chat-surface";
import { RightPanelWrapper } from "./right-panel-wrapper";
import { NewAgentView } from "@/components/agent/new-agent-dialog";
import { FirstLaunchTour } from "@/components/onboarding/first-launch-tour";
import { WindowsTitleBar } from "./windows-title-bar";
import { StudioSession } from "@/components/studio/StudioSession";
import { StudioComposer } from "@/components/studio/StudioComposer";
import { isStudioTool } from "@/lib/studio-tools";
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
import { fetchSessions, deleteEmptyDrafts, updateSession as apiUpdateSession } from "@/lib/api";
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
    rightPanelOpen, toggleRightPanel, _removedIds, pruneRemovedIds, mainView, activeSessionId,
    studioComposerOpen,
  } = useAppStore();

  // ── Reveal once data is ready ──
  // The first-entry overlay (it masks the hard cut from the onboarding
  // screen) used to lift on fixed timers — overlay 200ms → sidebar
  // 820ms → done 1900ms — which made the hub feel like it was "waiting"
  // before it was usable. Instead we lift it the moment the sessions
  // query settles, so the full hub appears as soon as its data is
  // loaded, with no artificial delay. `revealSafety` is a pure backstop:
  // if the backend is unusually slow (or the fetch never yields data),
  // reveal anyway after a few seconds so the overlay can't strand the
  // user on a blank screen.
  const { data: sessionsData, isError: sessionsError } = useQuery({
    queryKey: ["sessions"],
    queryFn: fetchSessions,
    refetchInterval: () =>
      (typeof document !== "undefined" && document.visibilityState === "visible") ? 5000 : false,
    refetchIntervalInBackground: false,
  });
  const [revealSafety, setRevealSafety] = useState(false);
  useEffect(() => {
    if (!introReveal) return;
    const t = setTimeout(() => setRevealSafety(true), 4000);
    return () => clearTimeout(t);
  }, [introReveal]);
  const dataReady = sessionsData !== undefined || sessionsError || revealSafety;
  // Gates the first-launch tour — fire it once the hub is actually on screen.
  const revealDone = !introReveal || dataReady;

  // Legacy modal flag — kept for the rare path that still opens it
  // explicitly (advanced "/new" command, plugin templates). The
  // sidebar + button and ⌘N now jump straight to a draft session.
  const [showNewAgent, setShowNewAgent] = useState(false);
  const beginDraft = useAppStore(s => s.beginDraft);

  useEffect(() => {
    const handler = () => { void beginDraft(); };
    window.addEventListener("fleet:new-agent", handler);
    return () => window.removeEventListener("fleet:new-agent", handler);
  }, [beginDraft]);

  // ── First-launch tour ──
  // The typed "Welcome to Fleet…" message and its "wait for the greeting
  // to finish typing, THEN start the tour" sequencing are gone — the user
  // lands directly in a usable Fleet hub with no animated intro text. The
  // guided tour still fires once per machine, right after the hub is
  // revealed (revealDone — i.e. once sessions have loaded), gated on the
  // same tour-done flag the tour itself sets on finish/skip.
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

    // A short beat after the reveal so the sidebar / chat-input the tour
    // spotlights have laid out before the first step measures them. The
    // tour also polls for its own targets, so this only needs to clear
    // the reveal's opacity fade.
    const timer = setTimeout(() => setTourActive(true), 450);
    return () => clearTimeout(timer);
  }, [revealDone]);

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
  // Only the setters are consumed: useDrag reports drag start/end through
  // them. The boolean values used to gate the panel width transitions, but
  // this PR makes those transitions `none` (snap, no animation), so the
  // values are no longer read — keep the setters, drop the value bindings.
  const [, setLeftDragging] = useState(false);
  const [, setRightDragging] = useState(false);

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
    // ── Staff-title recovery ──
    // Defense-in-depth for users whose staff session got renamed by a
    // prior bug (the breadcrumb auto-rename / handleAgentSend "New
    // chat" fallback / auto-intro markdown parser used to fire on the
    // Fleet hub's underlying staff row, leaving it titled "selam" or
    // whatever the user's first message was). All three paths are now
    // guarded against `targetSessionId === staffSessionId` going
    // forward, but the existing renamed row keeps showing up in the
    // right sidebar's Fleet entry until we force it back. Idempotent:
    // skips when the title is already canonical.
    if (staffSessionId) {
      const staffRow = serverData.find(s => s.id === staffSessionId);
      if (staffRow && staffRow.title !== "Staff Agent") {
        useAppStore.getState().updateSession(staffSessionId, { title: "Staff Agent" });
        apiUpdateSession(staffSessionId, { title: "Staff Agent" }).catch(() => {});
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
      const sidebar = !sidebarCollapsed ? leftWidth : 0;
      const max = Math.max(RIGHT_MIN, window.innerWidth - sidebar - CHAT_MIN - 24 /* gutters */);
      return Math.min(max, Math.max(RIGHT_MIN, w - dx));
    });
  }, [leftWidth, sidebarCollapsed]), setRightDragging);

  // Effective sidebar width — 0 only when collapsed. The hub (sidebar +
  // content) is revealed together once the data is ready; no slide-in.
  const sidebarWidth = !sidebarCollapsed ? leftWidth : 0;

  // A studio (Higgsfield) session renders the generation surface in EITHER
  // mode — the session list is shared, so a studio session can be opened from
  // Fleet in Workspace mode too.
  const activeStudio = activeSessionId
    ? sessions.find(s => s.id === activeSessionId && isStudioTool(s.tool))
    : undefined;

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
        transition: "none",
      }}>

      {/* ── Reveal overlay: masks the hard-cut from SetupScreen until
          the sessions data is ready, then fades to unveil the hub. ── */}
      {introReveal && (
        <div style={{
          position: "fixed", inset: 0, zIndex: 9000,
          background: "var(--background)",
          // main: reveal driven by `dataReady` (overlayVisible was removed).
          // #43: no transitions (snap reveal for the native/FPS feel).
          opacity: dataReady ? 0 : 1,
          transition: "none",
          pointerEvents: "none",
        }} />
      )}

      {/* Left sidebar — fully inset card on all four sides. Top + bottom
          margins replicate what the outer shell padding used to provide,
          since that padding is now zero (so the chat can flush against
          the window edge and align with the macOS traffic lights). It is
          unveiled together with the content when the reveal overlay
          lifts — no separate slide-in. */}
      <div style={{
        width: sidebarWidth,
        flexShrink: 0,
        overflow: "hidden",
        background: sidebarCollapsed ? "transparent" : "var(--sidebar)",
        borderRadius: sidebarCollapsed ? 0 : 8,
        border: sidebarCollapsed ? "none" : "1px solid var(--c-brd)",
        marginTop: sidebarCollapsed ? 0 : 8,
        marginBottom: sidebarCollapsed ? 0 : 8,
        // #43: sidebar width no longer animates (native/FPS feel).
        transition: "none",
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
        // main: gate on `dataReady`; #43: no fade transition.
        opacity: introReveal && !dataReady ? 0 : 1,
        transition: "none",
      }}>
        {studioComposerOpen ? (
          <StudioComposer />
        ) : activeStudio ? (
          <StudioSession sessionId={activeStudio.id} />
        ) : mainView === "marketplace" ? (
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
      {!studioComposerOpen && !activeStudio && (
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
        transition: "none",
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
      )}

      {/* New Agent modal — rendered as overlay, not replacing content */}
      {showNewAgent && <NewAgentView onClose={() => setShowNewAgent(false)} />}

      {/* First-launch tour — runs once per machine */}
      {tourActive && <FirstLaunchTour onDone={() => setTourActive(false)} />}
      </div>
    </div>
  );
}
