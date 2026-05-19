import { create } from "zustand";
import type { Session } from "@/types/session";
import { wsManager } from "@/services/ws-manager";
import { useChatStore, typeOutAssistantMessage } from "@/stores/chat-store";
import { createSession as apiCreateSession } from "@/lib/api";
import { folderName } from "@/lib/utils";

export interface AgentNotification {
  id: string;
  sessionId: string;
  title: string;
  summary: string;
  success: boolean;
  timestamp: number;
  /** Optional CTA link rendered as a small button beneath the
   *  summary. Click → shell.openExternal(action.url). Used by
   *  notifications that benefit from a one-click jump (e.g. the
   *  auto-branch-push toast's "View on GitHub", or the
   *  REPO_CREATE_FORBIDDEN error's "Open github.com/new"). */
  action?: { label: string; url: string };
}

// View ids for the chat-side panel picker. Matches the Claude Code-
// style dropdown the user pinned: Preview, Diff, Terminal, Files,
// Tasks, Memories. "editor" kept temporarily as an internal
// fallback. "process" is back — auto-opens when the agent dispatches
// a sub-agent (Task tool), matching Claude Code Desktop's pattern.
// "plan" was removed — the user explicitly asked for it to go since
// it didn't fit the design language.
export type WorkspaceView =
  | "preview"
  | "diff"
  | "terminal"
  | "files"
  | "file"      // singular — single-file viewer; reads openFilePath
  | "tasks"
  | "memories"  // session memory list (read + add via API)
  | "process"   // live sub-agent activity; auto-opens on Task tool dispatch
  // Legacy id — superseded by the list above. Kept so the big
  // workspace-panel.tsx (2.8k lines) compiles while we refactor it
  // incrementally. Will be removed once each panel is rebuilt.
  | "editor";
export type MainView = "fleet" | "workflows" | "marketplace";

/** Draft session — a NOT-YET-PERSISTED chat the user is configuring.
 *  Implemented as a regular `Session` entry in `sessions[]` carrying
 *  `local_only: true`. Lives entirely in renderer state: zero DB
 *  rows, zero backend calls, zero token spend. Promoted to a real
 *  Session row via `commitDraft()` the moment the user fires the
 *  first message — the local-only entry is removed and replaced with
 *  the server-issued one.
 *
 *  Why a flag on Session vs. a separate "draft" singleton: pre-2026
 *  this lived as `draft: DraftSession | null` with a `draft-<random>`
 *  id prefix used as the discriminator. Every backend-touching
 *  surface (WS subscribe, /detail poll, history fetch, infinite
 *  scroll) had to remember to early-out on `id.startsWith("draft-")`,
 *  and two of them forgot, spamming 404s every 8s. Folding the draft
 *  into `sessions[]` with an explicit `local_only` flag means the
 *  discriminator IS session data — derivable, greppable, robust to
 *  the chip-strip writing real values (project_path, claude_session_id)
 *  onto a draft before commit.
 *
 *  Backwards-compat alias only — callers of `setDraftField` accept
 *  this shape; new code should reach for `Partial<Session>`. */
export type DraftSession = Partial<Session>;
/** Right-panel surface — "hub" stays the operations center (vision: always
 *  reachable); "workspace" is the per-agent file/diff/terminal drill-down. */
export type RightPanelTab = "hub" | "workspace";

/** Maximum simultaneous panes in the workspace grid. Layouts:
 *    1 → full
 *    2 → top / bottom
 *    3 → 2 stacked left + 1 full right
 *    4 → 2x2
 *    5 → 2x2 left + 1 full right
 *    6 → 3x2
 *  Past 6 the columns get too narrow for code/diff to be readable
 *  in a side panel. */
export const WORKSPACE_VIEW_LIMIT = 6;

/** Hard cap on simultaneous chat panes. 4 is the practical max
 *  before each pane gets cramped on a typical 1440-wide laptop —
 *  also matches the user's spec ("4 tane aynı anda"). */
export const SPLIT_PANE_LIMIT = 4;

interface AppState {
  sessions: Session[];
  activeSessionId: string | null;
  staffSessionId: string | null;
  /** Multi-pane chat layout. When this array has more than 1 entry
   *  the main pane renders SplitPaneGrid (instead of a single
   *  ChatView), with one pane per id. Length 0 or 1 falls back to
   *  the standard single-ChatView layout (the legacy path). Order
   *  is layout order; ids must be unique. */
  splitPaneIds: string[];
  /** Pane currently focused for keyboard / sidebar interactions.
   *  Drives which pane gets future "set active session" calls and
   *  which pane the input toolbar's chips bind to. */
  focusedPaneIdx: number;
  /** Per-pane right-panel toggle. Keyed by sessionId so panel
   *  state persists across pane reorderings AND survives pane
   *  close → reopen of the same session. Each pane in the split
   *  grid renders its own embedded WorkspacePanel scoped to that
   *  session — terminal, diff, files etc. all isolate properly. */
  paneRightOpen: Record<string, boolean>;
  /** Per-pane workspace view stack — mirrors the global
   *  openWorkspaceViews but keyed per session. Drives WHICH view
   *  (Terminal / Diff / Files / …) the pane's embedded workspace
   *  shows. Empty stack means "no workspace selected yet"; the
   *  pane's right column stays closed even if paneRightOpen flips. */
  paneWorkspaceViews: Record<string, WorkspaceView[]>;
  /** Transcript view mode — which content blocks the chat
   *  surface renders. Mirrors Claude Code's "Transcript view"
   *  popover (the user's reference):
   *    normal   → text + tool summaries (default)
   *    thinking → text + tool summaries + always-expanded thinking blocks
   *    verbose  → everything raw, including tool inputs & outputs
   *    summary  → text only, collapse tools + thinking
   */
  transcriptView: "normal" | "thinking" | "verbose" | "summary";
  /** Chat font scale multiplier (0.875 / 1.0 / 1.125). Applied
   *  via CSS variable on the chat surface so message body, tool
   *  cards, etc. all respond. Three steps matches the popover's
   *  Aa / Aa / Aa control. */
  transcriptFontScale: number;
  sidebarCollapsed: boolean;
  /** Sidebar agent-list search overlay open/closed. Lifted to the
   *  store because on Windows the toggle button now lives in the
   *  title bar but the overlay (and its filtered list) still
   *  renders inside the sidebar — so the two surfaces need a
   *  shared truth. macOS keeps the original in-sidebar button as
   *  the same store-driven control. */
  sidebarSearchOpen: boolean;
  /** Current search query for the sidebar agent list. */
  sidebarSearchVal: string;
  /** Sidebar agent-list sort key. Persisted across reloads through
   *  localStorage so the user's preference survives restarts. */
  sidebarSortBy: "recent" | "status" | "name";
  rightPanelOpen: boolean;
  rightPanelTab: RightPanelTab;
  /** Active grid of workspace views (the right panel). Replaces the
   *  old single-string `workspaceView` so the user can have, e.g.,
   *  Diff + Terminal side-by-side. Order = layout order. Length is
   *  clamped to [0, WORKSPACE_VIEW_LIMIT]. We keep `workspaceView`
   *  in sync with `openWorkspaceViews[0]` so the 28 legacy callers
   *  reading `workspaceView` keep working without a flag-day migration. */
  openWorkspaceViews: WorkspaceView[];
  workspaceView: WorkspaceView;
  /** Path of the file currently displayed by the singleton "file"
   *  view. Set when a row in Files is clicked; the FileView reads
   *  this and re-fetches when it changes. Null when no file is
   *  pinned (FileView shows an empty state). */
  openFilePath: string | null;
  mainView: MainView;
  newAgentDialogOpen: boolean;
  notifications: AgentNotification[];
  fleetAutoMode: boolean;
  _removedIds: Set<string>;

  setSessions: (sessions: Session[]) => void;
  addSession: (session: Session) => void;
  removeSession: (id: string) => void;
  /** Drop ids from `_removedIds` that the server no longer returns —
   *  prevents the Set from growing unbounded over a long session.
   *  Called by app-shell's poll effect with the latest server id list.
   *  CRITICAL: builds a NEW Set every call (never mutates state). The
   *  in-place version was racy with removeSession which also creates
   *  fresh Sets, so reference equality never matched and consumers
   *  comparing by reference saw stale data. */
  pruneRemovedIds: (currentServerIds: string[]) => void;
  updateSession: (id: string, updates: Partial<Session>) => void;
  setActiveSession: (id: string | null) => void;
  setStaffSessionId: (id: string | null) => void;
  toggleSidebar: () => void;
  setSidebarSearchOpen: (open: boolean) => void;
  toggleSidebarSearch: () => void;
  setSidebarSearchVal: (val: string) => void;
  setSidebarSortBy: (sort: "recent" | "status" | "name") => void;
  toggleRightPanel: () => void;
  /** Replace the entire grid with the supplied view (legacy single-pane
   *  behaviour). */
  setWorkspaceView: (view: WorkspaceView) => void;
  /** Add a view to the grid. If already present → focus / no-op.
   *  When the grid is full, replaces the LAST slot (most recent).
   *  Always opens the right panel. */
  addWorkspaceView: (view: WorkspaceView) => void;
  /** Remove a view from the grid. Closes the right panel when removing
   *  the last view, mirroring the user's expectation that "X on the
   *  last pane closes the whole panel". */
  removeWorkspaceView: (view: WorkspaceView) => void;
  /** Swap two views' positions in the grid. Powers the drag-to-reorder
   *  affordance — dropping pane A onto pane B's slot puts A where B was
   *  and B where A was, so users can rearrange without an intermediate
   *  trip through close + re-add. */
  reorderWorkspaceView: (from: WorkspaceView, to: WorkspaceView) => void;
  /** Legacy single-view open helper. Now equivalent to
   *  setWorkspaceView + open panel — kept so existing callers compile. */
  openWorkspaceView: (view: WorkspaceView) => void;
  /** Open a specific file in the File pane. Sets openFilePath +
   *  ensures the "file" view is in the grid (adds without
   *  disrupting other panes). */
  openFile: (path: string) => void;
  setRightPanelTab: (tab: RightPanelTab) => void;
  setMainView: (view: MainView) => void;
  setNewAgentDialogOpen: (open: boolean) => void;
  /** Begin a new draft session — pure client-side, no DB write.
   *  Pushes a `local_only: true` entry into `sessions[]` and points
   *  `activeSessionId` at it so the chat surface renders the compose
   *  view. The entry stays out of the sidebar list (filtered by
   *  `local_only`) until commitDraft() swaps it for the real row. */
  beginDraft: () => Promise<void>;
  /** Patch fields on the currently-active local-only session. No-op
   *  when there isn't one. Used by the chip strip to settle folder /
   *  tool / model / permission / claude_session_id during compose. */
  setDraftField: (patch: Partial<Session>) => void;
  /** Promote the active local-only session into a real backend row.
   *  Returns the new server-issued id so the caller can fire the
   *  first message through the WS, or null on failure. Removes the
   *  local-only entry from `sessions[]` and updates activeSessionId. */
  commitDraft: () => Promise<string | null>;
  /** Throw the active local-only session away (user clicked Back /
   *  closed Settings / switched to a real session). No-op when there
   *  isn't one. */
  discardDraft: () => void;
  /** First-launch variant: same draft session, but the assistant's
   *  opening line is a personal "welcome to Fleet" instead of the
   *  routine "pick a folder" stub. Triggered once from AppShell when
   *  the tour flag is unset. Returns the estimated typing duration
   *  in ms (so AppShell can sequence the tour AFTER the message has
   *  finished typing out), or null if session creation failed. */
  createWelcomeSession: (userName?: string | null) => Promise<{ sessionId: string; durationMs: number } | null>;
  toggleFleetAutoMode: () => void;

  /** Add a session to the split-pane grid. No-op if the id is
   *  already in splitPaneIds or the grid is full (>= SPLIT_PANE_LIMIT).
   *  When called on a single-session view (splitPaneIds is empty),
   *  also seeds the grid with the current activeSessionId so we
   *  end up with TWO panes (current + new) instead of just one. */
  addPane: (sessionId: string) => void;
  /** Remove a session from the grid. When the result has 0 or 1
   *  panes, the grid auto-collapses back to the single-view layout. */
  removePane: (sessionId: string) => void;
  /** Reorder panes — used by the drag-to-rearrange affordance. */
  movePane: (from: number, to: number) => void;
  /** Swap one pane's session for another (drag a sidebar item
   *  ONTO an existing pane). Replaces the pane's session in-place
   *  rather than appending. */
  setPaneSession: (paneIdx: number, sessionId: string) => void;
  /** Mark which pane is the "focused" one for keyboard navigation
   *  / chip-strip target. */
  setFocusedPaneIdx: (idx: number) => void;
  /** Tear down the split layout entirely — back to single-ChatView. */
  exitSplitMode: () => void;
  /** Toggle the embedded right panel for a specific pane (keyed by
   *  sessionId). When the pane is the only one, this proxies to
   *  toggleRightPanel so the global panel still tracks state. */
  togglePaneRightPanel: (sessionId: string) => void;
  /** Add a view to the pane's workspace stack (and open it). */
  paneAddWorkspaceView: (sessionId: string, view: WorkspaceView) => void;
  /** Remove a view from the pane's workspace stack. When the stack
   *  empties, the pane's right column auto-closes — same UX as
   *  the global removeWorkspaceView. */
  paneRemoveWorkspaceView: (sessionId: string, view: WorkspaceView) => void;
  /** Replace the pane's workspace stack with a single view —
   *  used by the "Just open panel" menu item to clear and pin one. */
  paneSetWorkspaceView: (sessionId: string, view: WorkspaceView) => void;
  setTranscriptView: (v: AppState["transcriptView"]) => void;
  setTranscriptFontScale: (n: number) => void;

  pushNotification: (n: AgentNotification) => void;
  dismissNotification: (id: string) => void;
  clearNotifications: () => void;
}

export const useAppStore = create<AppState>((set) => ({
  sessions: [],
  activeSessionId: null,
  staffSessionId: localStorage.getItem("fleet:staffSessionId"),
  splitPaneIds: [],
  focusedPaneIdx: 0,
  paneRightOpen: {},
  paneWorkspaceViews: {},
  transcriptView: (localStorage.getItem("fleet:transcriptView") as AppState["transcriptView"]) || "normal",
  transcriptFontScale: parseFloat(localStorage.getItem("fleet:transcriptFontScale") || "1"),
  sidebarCollapsed: false,
  sidebarSearchOpen: false,
  sidebarSearchVal: "",
  sidebarSortBy: ((): "recent" | "status" | "name" => {
    const raw = localStorage.getItem("fleet:sidebarSortBy");
    return raw === "status" || raw === "name" || raw === "recent" ? raw : "recent";
  })(),
  rightPanelOpen: false,
  rightPanelTab: "workspace",
  workspaceView: "editor",
  openWorkspaceViews: [],
  openFilePath: null,
  mainView: "fleet",
  newAgentDialogOpen: false,
  notifications: [],
  fleetAutoMode: localStorage.getItem("fleet:autoMode") === "true",

  setSessions: (sessions) => set({ sessions }),

  addSession: (session) =>
    set((state) => ({ sessions: [...state.sessions, session] })),

  // IDs optimistically removed by the user — used by app-shell to filter poll
  // results until the server confirms the deletion.
  _removedIds: new Set<string>(),

  removeSession: (id) => {
    // Tear down side-effectful state BEFORE the store update so any
    // pending callbacks (orphan timers, delta flushes) running on the
    // old session id don't fire into a half-removed store. Also drop
    // the per-session chat state so a re-created session of the same
    // id starts fresh instead of inheriting orphaned messages /
    // streaming flags.
    try { wsManager.disconnect(id); } catch { /* noop */ }
    try { useChatStore.getState().clearSession(id); } catch { /* noop */ }
    set((state) => {
      const removed = new Set(state._removedIds);
      removed.add(id);
      return {
        _removedIds: removed,
        sessions: state.sessions.filter((s) => s.id !== id),
        activeSessionId: state.activeSessionId === id ? null : state.activeSessionId,
        notifications: state.notifications.filter((n) => n.sessionId !== id),
      };
    });
  },

  pruneRemovedIds: (currentServerIds) =>
    set((state) => {
      // Only build a new Set when there's something to prune. Avoids
      // every poll cycle producing a fresh reference and triggering
      // re-renders downstream.
      const serverHas = new Set(currentServerIds);
      let prunedAny = false;
      const next = new Set<string>();
      for (const id of state._removedIds) {
        if (serverHas.has(id)) {
          // Server still echoing it back — keep filtering it out.
          next.add(id);
        } else {
          // Server no longer reports this id; the archive/delete has
          // landed and we can forget it.
          prunedAny = true;
        }
      }
      return prunedAny ? { _removedIds: next } : state;
    }),

  updateSession: (id, updates) =>
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === id ? { ...s, ...updates } : s,
      ),
    })),

  setActiveSession: (id) =>
    set((state) => {
      // When in split mode, "set active" updates the focused pane's
      // session rather than the global activeSessionId — the user's
      // mental model is "I clicked a session in the sidebar, put it
      // in the pane I'm looking at".
      if (state.splitPaneIds.length > 1 && id) {
        const idx = Math.min(state.focusedPaneIdx, state.splitPaneIds.length - 1);
        const next = state.splitPaneIds.slice();
        next[idx] = id;
        return { activeSessionId: id, splitPaneIds: next };
      }
      return { activeSessionId: id };
    }),

  // ── Split-pane actions ──
  addPane: (sessionId) =>
    set((state) => {
      // Already on the grid? Don't duplicate.
      if (state.splitPaneIds.includes(sessionId)) return state;
      // Single-view → bootstrap to a 2-pane grid using the current
      // activeSessionId as the first pane (so we don't lose what the
      // user was looking at when they click "Split").
      if (state.splitPaneIds.length === 0) {
        const seed = state.activeSessionId;
        if (!seed || seed === sessionId) {
          return { splitPaneIds: [sessionId], focusedPaneIdx: 0 };
        }
        return {
          splitPaneIds: [seed, sessionId],
          focusedPaneIdx: 1,
          activeSessionId: sessionId,
        };
      }
      if (state.splitPaneIds.length >= SPLIT_PANE_LIMIT) return state;
      return {
        splitPaneIds: [...state.splitPaneIds, sessionId],
        focusedPaneIdx: state.splitPaneIds.length,
      };
    }),

  removePane: (sessionId) =>
    set((state) => {
      const next = state.splitPaneIds.filter((id) => id !== sessionId);
      // Strip pane-scoped right-panel state for the closed session.
      // Without this, paneRightOpen + paneWorkspaceViews accumulated
      // stale entries every time a pane was closed and reopened —
      // the new pane would then come up with whatever workspace
      // view the previous incarnation had pinned, surprising the
      // user and (when paneWorkspaceViews lingered for a freshly
      // mounted ChatView) making toggles look broken.
      const { [sessionId]: _ro, ...paneRightOpenRest } = state.paneRightOpen;
      const { [sessionId]: _vw, ...paneWorkspaceViewsRest } = state.paneWorkspaceViews;

      // Last pane out → exit split mode and surface that pane as the
      // active single view, so the user doesn't lose their place.
      if (next.length <= 1) {
        return {
          splitPaneIds: [],
          focusedPaneIdx: 0,
          activeSessionId: next[0] ?? state.activeSessionId,
          paneRightOpen: paneRightOpenRest,
          paneWorkspaceViews: paneWorkspaceViewsRest,
        };
      }
      return {
        splitPaneIds: next,
        focusedPaneIdx: Math.min(state.focusedPaneIdx, next.length - 1),
        paneRightOpen: paneRightOpenRest,
        paneWorkspaceViews: paneWorkspaceViewsRest,
      };
    }),

  movePane: (from, to) =>
    set((state) => {
      if (from === to) return state;
      if (from < 0 || from >= state.splitPaneIds.length) return state;
      if (to < 0 || to >= state.splitPaneIds.length) return state;
      const next = state.splitPaneIds.slice();
      const moved = next.splice(from, 1)[0];
      if (moved === undefined) return state;
      next.splice(to, 0, moved);
      return { splitPaneIds: next, focusedPaneIdx: to };
    }),

  setPaneSession: (paneIdx, sessionId) =>
    set((state) => {
      if (paneIdx < 0 || paneIdx >= state.splitPaneIds.length) return state;
      // Dropping a session that's ALREADY in the grid swaps the two
      // panes' sessions instead of leaving a duplicate.
      const dupIdx = state.splitPaneIds.indexOf(sessionId);
      const next = state.splitPaneIds.slice();
      if (dupIdx >= 0 && dupIdx !== paneIdx) {
        next[dupIdx] = next[paneIdx]!;
      }
      next[paneIdx] = sessionId;
      return {
        splitPaneIds: next,
        focusedPaneIdx: paneIdx,
        activeSessionId: sessionId,
      };
    }),

  setFocusedPaneIdx: (idx) =>
    set((state) => {
      if (idx < 0 || idx >= state.splitPaneIds.length) return state;
      return {
        focusedPaneIdx: idx,
        activeSessionId: state.splitPaneIds[idx] ?? state.activeSessionId,
      };
    }),

  exitSplitMode: () =>
    set((state) => ({
      splitPaneIds: [],
      focusedPaneIdx: 0,
      activeSessionId:
        state.splitPaneIds[state.focusedPaneIdx] ?? state.activeSessionId,
    })),

  togglePaneRightPanel: (sessionId) =>
    set((state) => ({
      paneRightOpen: {
        ...state.paneRightOpen,
        [sessionId]: !state.paneRightOpen[sessionId],
      },
    })),

  paneAddWorkspaceView: (sessionId, view) =>
    set((state) => {
      const cur = state.paneWorkspaceViews[sessionId] ?? [];
      // No-op duplicate add — but always make sure the pane's
      // panel is open so the user sees the view they picked.
      if (cur.includes(view)) {
        return {
          paneRightOpen: { ...state.paneRightOpen, [sessionId]: true },
        };
      }
      const next = cur.length >= WORKSPACE_VIEW_LIMIT
        ? [...cur.slice(0, -1), view]   // replace last slot when full
        : [...cur, view];
      return {
        paneWorkspaceViews: {
          ...state.paneWorkspaceViews,
          [sessionId]: next,
        },
        paneRightOpen: { ...state.paneRightOpen, [sessionId]: true },
      };
    }),

  paneRemoveWorkspaceView: (sessionId, view) =>
    set((state) => {
      const cur = state.paneWorkspaceViews[sessionId] ?? [];
      const next = cur.filter(v => v !== view);
      const wasLast = cur.length > 0 && next.length === 0;
      return {
        paneWorkspaceViews: {
          ...state.paneWorkspaceViews,
          [sessionId]: next,
        },
        ...(wasLast
          ? { paneRightOpen: { ...state.paneRightOpen, [sessionId]: false } }
          : {}),
      };
    }),

  paneSetWorkspaceView: (sessionId, view) =>
    set((state) => ({
      paneWorkspaceViews: {
        ...state.paneWorkspaceViews,
        [sessionId]: [view],
      },
      paneRightOpen: { ...state.paneRightOpen, [sessionId]: true },
    })),

  setTranscriptView: (v) => {
    try { localStorage.setItem("fleet:transcriptView", v); } catch { /* ignore */ }
    set({ transcriptView: v });
  },
  setTranscriptFontScale: (n) => {
    try { localStorage.setItem("fleet:transcriptFontScale", String(n)); } catch { /* ignore */ }
    set({ transcriptFontScale: n });
  },
  setStaffSessionId: (id) => {
    if (id) localStorage.setItem("fleet:staffSessionId", id);
    else localStorage.removeItem("fleet:staffSessionId");
    set({ staffSessionId: id });
  },
  toggleSidebar: () =>
    set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),

  setSidebarSearchOpen: (open) => set({ sidebarSearchOpen: open }),
  toggleSidebarSearch: () =>
    set((state) => ({ sidebarSearchOpen: !state.sidebarSearchOpen })),
  setSidebarSearchVal: (val) => set({ sidebarSearchVal: val }),
  setSidebarSortBy: (sort) => {
    try { localStorage.setItem("fleet:sidebarSortBy", sort); } catch { /* ignore quota */ }
    set({ sidebarSortBy: sort });
  },
  toggleRightPanel: () =>
    set((state) => {
      const opening = !state.rightPanelOpen;
      // If opening with no views configured, default to Files so the
      // panel never reads as blank. WorkspaceGrid returns null on an
      // empty view list and the right panel ends up showing nothing —
      // disorienting for a user who just toggled it on.
      if (opening && state.openWorkspaceViews.length === 0) {
        return {
          rightPanelOpen: true,
          openWorkspaceViews: ["files"],
          workspaceView: "files",
        };
      }
      return { rightPanelOpen: opening };
    }),
  setWorkspaceView: (view) => set({
    workspaceView: view,
    openWorkspaceViews: view === "editor" ? [] : [view],
  }),
  addWorkspaceView: (view) =>
    set((state) => {
      const present = state.openWorkspaceViews.includes(view);
      let next = state.openWorkspaceViews;
      if (!present) {
        next = next.length >= WORKSPACE_VIEW_LIMIT
          // Grid is full — replace the LAST slot with the new view so
          // the user always gets feedback that their click did something.
          // Picking last (rather than first) feels least surprising —
          // the older / "more pinned" panes stay where they are.
          ? [...next.slice(0, -1), view]
          : [...next, view];
      }
      const first = next[0] ?? "editor";
      return {
        openWorkspaceViews: next,
        workspaceView: first,
        rightPanelOpen: true,
        rightPanelTab: "workspace",
      };
    }),
  removeWorkspaceView: (view) =>
    set((state) => {
      const next = state.openWorkspaceViews.filter(v => v !== view);
      const first = next[0] ?? "editor";
      return {
        openWorkspaceViews: next,
        workspaceView: first,
        // Closing the LAST pane closes the whole panel. Matches
        // user expectation that "X on the only pane should hide the
        // panel" — otherwise we'd leave an empty card behind.
        rightPanelOpen: next.length > 0,
      };
    }),
  reorderWorkspaceView: (from, to) =>
    set((state) => {
      const i = state.openWorkspaceViews.indexOf(from);
      const j = state.openWorkspaceViews.indexOf(to);
      if (i === -1 || j === -1 || i === j) return state;
      const next = [...state.openWorkspaceViews];
      // Swap rather than insert-and-shift — keeps cursor focus on
      // both panes deterministic and avoids cascading the layout.
      [next[i], next[j]] = [next[j]!, next[i]!];
      return {
        openWorkspaceViews: next,
        workspaceView: next[0] ?? state.workspaceView,
      };
    }),
  openWorkspaceView: (view) =>
    set({
      workspaceView: view,
      openWorkspaceViews: [view],
      rightPanelOpen: true,
      rightPanelTab: "workspace",
    }),
  openFile: (path) =>
    set((state) => {
      // Same add-or-keep semantics as addWorkspaceView, but always
      // updates openFilePath so an already-open File pane refreshes
      // to the newly clicked file instead of staying on the old one.
      const present = state.openWorkspaceViews.includes("file");
      let next = state.openWorkspaceViews;
      if (!present) {
        next = next.length >= WORKSPACE_VIEW_LIMIT
          ? [...next.slice(0, -1), "file"]
          : [...next, "file"];
      }
      return {
        openFilePath: path,
        openWorkspaceViews: next,
        workspaceView: next[0] ?? "file",
        rightPanelOpen: true,
        rightPanelTab: "workspace",
      };
    }),
  setRightPanelTab: (tab) => set({ rightPanelTab: tab }),
  // Right panel auto-closes when switching to a non-fleet surface.
  // Routines / Marketplace don't have a session-scoped right panel to
  // show, so leaving it open just steals horizontal space from those
  // pages. Fleet view preserves the existing rightPanelOpen state.
  setMainView: (view) => set((state) => ({
    mainView: view,
    activeSessionId: view === "fleet" ? null : state.activeSessionId,
    rightPanelOpen: view === "fleet" ? state.rightPanelOpen : false,
  })),
  setNewAgentDialogOpen: (open) => set({ newAgentDialogOpen: open }),
  beginDraft: async () => {
    // Pure client-side draft — NO DB write, NO backend call, NO
    // token spend. The chip strip above the chat input mutates this
    // object until the user fires the first message, at which point
    // commitDraft() turns it into a real Session row.
    let defaultModel = "claude-sonnet-4-6";
    try {
      const cfg = await window.electronAPI?.getConfig?.();
      if (cfg?.defaultModel) defaultModel = cfg.defaultModel;
    } catch { /* keep fallback */ }
    let defaultProvider = "claude";
    try {
      const cfg = await window.electronAPI?.getConfig?.();
      if (cfg?.defaultProvider) defaultProvider = cfg.defaultProvider;
    } catch { /* keep fallback */ }

    // Real UUID (matches backend uuid.uuid4() format) so callers
    // can't accidentally use the id as a "is this a draft?" check —
    // they MUST look at `session.local_only` instead. crypto.randomUUID
    // is available in all Electron/Chromium renderers we ship to.
    const id = crypto.randomUUID();
    const draftSession: Session = {
      id,
      // Placeholder shown in the toolbar / breadcrumb until the user
      // sends their first message. commitDraft treats this literal as
      // "user hasn't picked a title" and falls back to folderName.
      title: "New chat",
      project_path: "",
      group_path: "",
      tool: defaultProvider as Session["tool"],
      command: "",
      status: "idle",
      pinned: false,
      parent_id: null,
      worktree_path: null,
      worktree_branch: null,
      claude_session_id: null,
      model_name: defaultModel,
      permission_mode: "default",
      session_mode: "interactive",
      order_idx: 0,
      created_at: new Date().toISOString(),
      last_accessed: null,
      notes: null,
      use_worktree: true,
      local_only: true,
    };
    set((state) => ({
      sessions: [...state.sessions, draftSession],
      activeSessionId: id,           // chat-view picks this up and renders the compose surface
      mainView: "fleet",
      splitPaneIds: [],              // exit split mode while composing
      focusedPaneIdx: 0,
    }));

    // Short typewriter greeting so the chat isn't a blank wall while
    // the user picks a folder. As soon as project_path lands, the
    // auto-intro effect in chat-view fires the real first prompt and
    // removes this placeholder (chat-view:844, removeMessage on
    // `welcome-${sid}`). Local-only — no WS round-trip, no token cost.
    const welcomeId = `welcome-${id}`;
    useChatStore.getState().addMessage(id, {
      id: welcomeId,
      role: "assistant",
      content: [{ type: "text", text: "" }],
      timestamp: new Date().toISOString(),
    });
    typeOutAssistantMessage(
      id, welcomeId,
      "Pick a folder above and I'll take a look at the project before you send your first task.",
      14,
    );
  },

  setDraftField: (patch) =>
    set((state) => {
      const activeId = state.activeSessionId;
      if (!activeId) return {};
      // Only the currently-active session is editable via the chip
      // strip, and only when it's still local-only. Real sessions go
      // through the normal `updateSession` PATCH path.
      const idx = state.sessions.findIndex(s => s.id === activeId && s.local_only);
      if (idx < 0) return {};
      const next = [...state.sessions];
      next[idx] = { ...next[idx], ...patch } as Session;
      return { sessions: next };
    }),

  commitDraft: async () => {
    const state = useAppStore.getState();
    const activeId = state.activeSessionId;
    if (!activeId) return null;
    const draft = state.sessions.find(s => s.id === activeId && s.local_only);
    if (!draft) return null;
    try {
      // Coerce the "New chat" placeholder back to the folder basename
      // (or "Session" as a last-resort label). Treating "New chat" as
      // "user didn't customise the title" mirrors the pre-refactor
      // contract where draft.title started as "" and the same fallback
      // ladder kicked in. After the first send, chat-view's send
      // handler will overwrite this with the message's first 50 chars.
      const customTitle = draft.title && draft.title !== "New chat"
        ? draft.title
        : (draft.project_path
          ? (folderName(draft.project_path) || "Session")
          : "New chat");
      const session = await apiCreateSession({
        title: customTitle,
        project_path: draft.project_path,
        tool: draft.tool,
        permission_mode: draft.permission_mode,
        model_name: draft.model_name ?? undefined,
        // Pre-seed --resume target if the user picked one from History.
        claude_session_id: draft.claude_session_id ?? undefined,
        use_worktree: draft.use_worktree,
      });
      // The welcome typewriter (and any auto-intro echoes) wrote to
      // chatStore under the local-only id. That id is about to
      // disappear — clear its chat slot so we don't leak the
      // assistant placeholder under a now-orphan key.
      try { useChatStore.getState().clearSession(draft.id); } catch { /* noop */ }
      set((s) => ({
        // Replace the local-only entry with the backend-issued one
        // in-place; the new row has a fresh UUID and no `local_only`
        // flag, so all the early-out guards naturally release.
        sessions: s.sessions.map(x => x.id === draft.id ? session : x),
        activeSessionId: session.id,
        mainView: "fleet",
      }));
      return session.id;
    } catch (err) {
      console.error("commitDraft failed:", err);
      return null;
    }
  },

  discardDraft: () =>
    set((state) => {
      const activeId = state.activeSessionId;
      if (!activeId) return {};
      const draft = state.sessions.find(s => s.id === activeId && s.local_only);
      if (!draft) return {};
      try { useChatStore.getState().clearSession(draft.id); } catch { /* noop */ }
      return {
        sessions: state.sessions.filter(s => s.id !== draft.id),
        // Active surface was the discarded draft → fall back to Fleet hub.
        activeSessionId: null,
      };
    }),

  createWelcomeSession: async (userName) => {
    // ── Idempotent guard ──
    // If the first-launch flow re-fires (rapid restart, cleared
    // tour-done flag, dev hot-reload), don't spawn a second staff
    // session and orphan the first one. Reuse what we have AND
    // re-type the welcome message into it so the user still sees
    // the intro.
    const existingStaffId = (() => {
      try {
        const s = useAppStore.getState();
        return s.staffSessionId
          ?? s.sessions.find(x => (x.title || "").trim() === "Staff Agent")?.id
          ?? null;
      } catch {
        return null;
      }
    })();
    // ── Why Staff Agent and not a "Welcome" session ──
    // The user explicitly asked: don't spawn a visible Welcome agent
    // in the sidebar. Staff Agent is already filtered out of the
    // sidebar list AND chat-view falls back to staffSessionId when
    // activeSessionId is null — so typing the welcome message into
    // the staff session shows it in the Fleet hub WITHOUT making it
    // look like a real agent the user has to manage.
    let session;
    if (existingStaffId) {
      // Synthetic shape — only sessionId is read by anything that
      // matters past this point.
      session = { id: existingStaffId } as Session;
    } else {
      try {
        session = await apiCreateSession({
          title: "Staff Agent",
          project_path: "",
          tool: "claude",
          permission_mode: "bypassPermissions",
          // Same as chat-view.tsx's lazy staff create — emit a real
          // model name so the cloud telemetry pipeline gets a valid
          // `model` field and the Sessions tab can show what the
          // coordinator runs on.
          model_name: "claude-sonnet-4-6",
        });
      } catch (err) {
        console.error("[Fleet] createWelcomeSession: API rejected:", err);
        return null;
      }
    }
    // Add to sessions[] (so app-shell's sessionsData refresh doesn't
    // drop it) and register as the staff session. activeSessionId
    // stays null on purpose — the user lands on the Fleet hub view,
    // and the welcome message renders there because the chat surface
    // falls back to staffSessionId for messages when no agent is
    // active.
    set((state) => ({
      // Don't double-add if we reused an existing staff row.
      sessions: existingStaffId
        ? state.sessions
        : [...state.sessions, session],
      staffSessionId: session.id,
      mainView: "fleet",
    }));
    try { localStorage.setItem("fleet:staffSessionId", session.id); } catch { /* noop */ }

    const firstName = (userName ?? "").trim().split(/\s+/)[0] || "";
    const greeting = firstName ? `Welcome to Fleet, ${firstName}.` : "Welcome aboard.";
    const welcomeText =
      `${greeting} Your account is ready and Fleet is set up to drive multiple coding agents from one cockpit — Claude, Codex, Gemini, and the rest, all behind one transcript with shared memory and a shared budget.\n\n` +
      `Spawn an agent from the sidebar whenever you have a task, or just tell me what you need right here and I'll route it to the right model.\n\n` +
      `Quick tour of the interface starting in a sec.`;
    const speedMs = 12;
    const welcomeId = `welcome-${session.id}`;
    const sid = session.id;

    // Race-proof typing — idempotently overwrite the staff session's
    // messages every tick so chat-view's initial fetch (which races
    // with us and resolves to []) can't steal the welcome.
    //
    // Self-cleaning interval: if the user logs out / removes the
    // staff session / refreshes mid-stream, the session disappears
    // from app-store. We notice on the next tick and bail. Without
    // this guard the interval kept firing forever, hammering the
    // chat store with stale ids and orphaning a small bit of
    // memory per dropped session.
    let i = 0;
    const interval = setInterval(() => {
      const stillThere = useAppStore.getState().sessions.some(s => s.id === sid);
      if (!stillThere) { clearInterval(interval); return; }
      i += 1;
      const partial = welcomeText.slice(0, i);
      useChatStore.getState().setMessages(sid, [{
        id: welcomeId,
        role: "assistant",
        content: [{ type: "text", text: partial }],
        timestamp: new Date().toISOString(),
      }]);
      if (i >= welcomeText.length) clearInterval(interval);
    }, speedMs);

    return { sessionId: sid, durationMs: welcomeText.length * speedMs };
  },

  toggleFleetAutoMode: () =>
    set((state) => {
      const next = !state.fleetAutoMode;
      localStorage.setItem("fleet:autoMode", String(next));
      return { fleetAutoMode: next };
    }),

  pushNotification: (n) =>
    set((state) => {
      // Dedupe by session_id — a new notification for the same agent replaces
      // the older one, keeping the stack focused on the latest update per agent.
      const filtered = state.notifications.filter((x) => x.sessionId !== n.sessionId);
      return { notifications: [n, ...filtered].slice(0, 8) };
    }),

  dismissNotification: (id) =>
    set((state) => ({ notifications: state.notifications.filter((n) => n.id !== id) })),

  clearNotifications: () => set({ notifications: [] }),
}));
