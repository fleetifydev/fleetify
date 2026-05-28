import { create } from "zustand";
import type { Session } from "@/types/session";
import { wsManager } from "@/services/ws-manager";
import { useChatStore, typeOutAssistantMessage } from "@/stores/chat-store";

/** Sentinel chat-store key used for compose-time messages (welcome
 *  typewriter, "pick a folder" warnings, etc.). The composer doesn't
 *  have a session id yet, so these messages live under this fixed key
 *  in chat-store. They are NOT migrated to the real session id on
 *  commitComposer — by design, they're transient compose-mode UX and
 *  disappear the moment the surface flips to the real session. */
export const COMPOSER_CHAT_KEY = "__composer__";
import { createSession as apiCreateSession, cloneRepository } from "@/lib/api";
import { folderName } from "@/lib/utils";


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

/** Composer state — a NOT-YET-PERSISTED setup screen for a new session.
 *  Lives entirely in renderer state, OUTSIDE `sessions[]` (it isn't a
 *  session — a session only exists after `commitComposer` creates the
 *  backend row). While the composer is open, `activeSessionId` is null
 *  and chat-view renders the compose surface (welcome typewriter +
 *  folder picker + chat input bound to composer fields). On first send,
 *  `commitComposer` calls `apiCreateSession`, sets `activeSessionId` to
 *  the new id, closes the composer, and lets the caller fire the first
 *  user message over the WS.
 *
 *  Why composer-state vs the old "draft session in sessions[]" pattern:
 *  the old shape (`local_only: true` flag on a Session row) created a
 *  phantom session entity that every backend-touching surface had to
 *  remember to skip — WS subscribe, /detail poll, history fetch, etc.
 *  A miss anywhere produced "Forbidden or not found" errors that
 *  leaked into the compose UI, surfacing a Create PR button before the
 *  session existed. With the composer split out, "session" always means
 *  "real backend-backed row," and the WS multiplex never sees the
 *  compose surface at all. */
export interface ComposerState {
  open: boolean;
  projectPath: string;
  tool: Session["tool"];
  /** Default model to seed the new session with — same shape the
   *  backend expects in `SessionCreate.model_name`. */
  modelName: string | null;
  permissionMode: Session["permission_mode"];
  useWorktree: boolean;
  /** Title the user has typed (or "New chat" placeholder). commitComposer
   *  treats the placeholder as "user didn't customise the title" and
   *  falls back to the folder basename, matching the legacy contract. */
  title: string;
  /** Pre-seeded `--resume` target if the user picked one from History
   *  before sending the first message. */
  claudeSessionId: string | null;
  /** A git URL the user has selected via the Git source picker but
   *  HASN'T cloned yet. Set when the user picks from the repo list or
   *  pastes + validates a URL; cleared once commitComposer clones it
   *  and writes the resolved path into projectPath. The deferred
   *  clone lets the user keep tweaking the composer (model, perms,
   *  branch, …) without paying the clone cost up front — the actual
   *  `git clone` runs at the moment they fire their first message. */
  pendingCloneUrl: string | null;
}

/** @deprecated kept only so external imports (tests, callers that
 *  unwrap the patch object) continue to compile. New code should
 *  reach for `Partial<ComposerState>` or `Partial<Session>` directly. */
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
  fleetAutoMode: boolean;
  _removedIds: Set<string>;
  /** Compose surface state — see ComposerState docs. `open: false` means
   *  the user is either on the Control Center (`activeSessionId === null`)
   *  or in a real session (`activeSessionId !== null`); `open: true` AND
   *  `activeSessionId === null` is the compose mode. */
  composer: ComposerState;

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
  /** Open the compose surface — pure client-side, no DB write, no
   *  Session entry in `sessions[]`. Sets `composer.open = true` and
   *  `activeSessionId = null`; chat-view detects the combination and
   *  renders the compose UI (welcome typewriter + chat input bound to
   *  composer fields). The session itself only comes into existence
   *  when `commitComposer` runs on first send. */
  openComposer: () => Promise<void>;
  /** Patch fields on the open composer. No-op when the composer is
   *  closed. Used by the chip strip to settle folder / tool / model /
   *  permission / claudeSessionId during compose. */
  setComposerField: (patch: Partial<ComposerState>) => void;
  /** Promote the open composer into a real backend session row.
   *  Returns the new server-issued id so the caller can fire the
   *  first message through the WS, or null on failure. Closes the
   *  composer and points activeSessionId at the new row. */
  commitComposer: () => Promise<string | null>;
  /** Throw the open composer away (user clicked Back / closed Settings
   *  / switched to a real session). No-op when the composer is closed. */
  closeComposer: () => void;

  // ── Legacy draft API — thin aliases over the composer ──
  // The old "draft session in sessions[]" model has been retired (see
  // ComposerState docs). These wrappers translate the old call sites
  // (App.tsx, use-keyboard-shortcuts, app-shell, sidebar, …) to the
  // composer actions so we don't have to flag-day every consumer at
  // once. New code should reach for the openComposer/etc. surface
  // directly; these will be removed once the call sites are migrated.
  /** @deprecated use `openComposer` */
  beginDraft: () => Promise<void>;
  /** @deprecated use `setComposerField` (patch is mapped from Session shape) */
  setDraftField: (patch: Partial<Session>) => void;
  /** @deprecated use `commitComposer` */
  commitDraft: () => Promise<string | null>;
  /** @deprecated use `closeComposer` */
  discardDraft: () => void;
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
}

export const useAppStore = create<AppState>((set, get) => ({
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
  fleetAutoMode: localStorage.getItem("fleet:autoMode") === "true",
  composer: {
    open: false,
    projectPath: "",
    tool: "claude",
    modelName: null,
    permissionMode: "default",
    useWorktree: true,
    title: "New chat",
    claudeSessionId: null,
    pendingCloneUrl: null,
  },

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
      // ANY explicit navigation closes the composer — clicking a
      // session row, the Fleet hub button (id=null), the command
      // palette, etc. The compose surface is an explicit user mode,
      // not a passive fallback; once the user goes anywhere else they
      // mean to leave it. Without this clamp, opening "New session"
      // then clicking the Fleet rail button traps the user on the
      // compose surface instead of the Fleet hub.
      if (state.composer.open) {
        try { useChatStore.getState().clearSession(COMPOSER_CHAT_KEY); } catch { /* noop */ }
      }
      // Staff Agent IS the Fleet hub. If the user somehow lands on
      // a click that targets the staff session id (sidebar row that
      // slipped past the filter, command-palette match, etc.), route
      // it to Fleet hub instead of rendering the staff as a regular
      // agent surface. Staff was never meant to be a navigable
      // session — it's an execution context for the hub UI.
      const targetId = id && state.staffSessionId && id === state.staffSessionId ? null : id;
      // When in split mode, "set active" updates the focused pane's
      // session rather than the global activeSessionId — the user's
      // mental model is "I clicked a session in the sidebar, put it
      // in the pane I'm looking at".
      if (state.splitPaneIds.length > 1 && targetId) {
        const idx = Math.min(state.focusedPaneIdx, state.splitPaneIds.length - 1);
        const next = state.splitPaneIds.slice();
        next[idx] = targetId;
        return {
          activeSessionId: targetId,
          splitPaneIds: next,
          composer: { ...state.composer, open: false },
        };
      }
      return {
        activeSessionId: targetId,
        composer: { ...state.composer, open: false },
      };
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
  setMainView: (view) => {
    // Same composer-closing semantics as setActiveSession: navigating
    // to any main view (Fleet hub, Workflows, Marketplace) is an
    // explicit "leave compose mode" signal.
    if (get().composer.open) {
      try { useChatStore.getState().clearSession(COMPOSER_CHAT_KEY); } catch { /* noop */ }
    }
    set((state) => ({
      mainView: view,
      activeSessionId: view === "fleet" ? null : state.activeSessionId,
      rightPanelOpen: view === "fleet" ? state.rightPanelOpen : false,
      composer: { ...state.composer, open: false },
    }));
  },
  setNewAgentDialogOpen: (open) => set({ newAgentDialogOpen: open }),
  // ── Composer state (new) ──
  // The compose surface is NOT a session. Opening it sets composer.open
  // and clears activeSessionId; chat-view renders the welcome / folder
  // picker / chat input UI from composer fields. A backend Session row
  // is created only when the user fires their first message
  // (commitComposer → apiCreateSession). This replaces the old
  // "local_only draft session in sessions[]" mechanism so the WS layer,
  // sidebar reconcile, history fetch, /detail poll, etc. never have to
  // remember to skip a phantom entry.
  openComposer: async () => {
    let defaultModel = "claude-sonnet-4-6";
    let defaultProvider: Session["tool"] = "claude";
    try {
      const cfg = await window.electronAPI?.getConfig?.();
      if (cfg?.defaultModel) defaultModel = cfg.defaultModel;
      if (cfg?.defaultProvider) defaultProvider = cfg.defaultProvider as Session["tool"];
    } catch { /* keep fallbacks */ }
    set({
      composer: {
        open: true,
        projectPath: "",
        tool: defaultProvider,
        modelName: defaultModel,
        permissionMode: "default",
        useWorktree: true,
        title: "New chat",
        claudeSessionId: null,
        pendingCloneUrl: null,
      },
      activeSessionId: null,   // chat-view + composer.open == compose surface
      mainView: "fleet",
      splitPaneIds: [],        // exit split mode while composing
      focusedPaneIdx: 0,
    });
    // Seed the compose-mode welcome typewriter under the sentinel
    // chat-store key. Anything written here (welcome line, folder
    // warnings on attempted-send-without-folder, …) is purely
    // compose-time UX — clearComposer / commitComposer wipe it the
    // moment the surface flips away.
    try { useChatStore.getState().clearSession(COMPOSER_CHAT_KEY); } catch { /* noop */ }
    const welcomeId = `welcome-${COMPOSER_CHAT_KEY}`;
    useChatStore.getState().addMessage(COMPOSER_CHAT_KEY, {
      id: welcomeId,
      role: "assistant",
      content: [{ type: "text", text: "" }],
      timestamp: new Date().toISOString(),
    });
    typeOutAssistantMessage(
      COMPOSER_CHAT_KEY,
      welcomeId,
      "Pick a folder above and I'll take a look at the project before you send your first task.",
      14,
    );
  },

  setComposerField: (patch) =>
    set((state) => {
      if (!state.composer.open) return {};
      return { composer: { ...state.composer, ...patch } };
    }),

  commitComposer: async () => {
    const state = get();
    const c = state.composer;
    if (!c.open) return null;
    try {
      // If the user picked a git URL via the source picker but hasn't
      // cloned it yet, run the clone now (this is the moment the
      // session goes from "draft" to "real backend row"). The resolved
      // absolute path becomes the session's project_path and the
      // pending URL gets cleared. A clone failure aborts the commit so
      // the user can pick a different repo / fix the URL — the
      // composer stays open and the chat input shows the thrown error.
      let resolvedProjectPath = c.projectPath;
      if (c.pendingCloneUrl) {
        const cloneResult = await cloneRepository(c.pendingCloneUrl);
        resolvedProjectPath = cloneResult.path;
        set((s) => ({
          composer: { ...s.composer, projectPath: cloneResult.path, pendingCloneUrl: null },
        }));
      }
      // Coerce the "New chat" placeholder back to the folder basename
      // (or "Session" as a last-resort label) — matches the pre-Phase-7
      // contract where commitDraft normalised "New chat" the same way.
      const customTitle = c.title && c.title !== "New chat"
        ? c.title
        : (resolvedProjectPath ? (folderName(resolvedProjectPath) || "Session") : "New chat");
      const session = await apiCreateSession({
        title: customTitle,
        project_path: resolvedProjectPath,
        tool: c.tool,
        permission_mode: c.permissionMode,
        model_name: c.modelName ?? undefined,
        claude_session_id: c.claudeSessionId ?? undefined,
        use_worktree: c.useWorktree,
      });
      // Wipe compose-time messages (welcome typewriter, folder
      // warnings, …) before the surface flips to the real session —
      // they're transient compose-mode UX, not part of the new
      // session's conversation.
      try { useChatStore.getState().clearSession(COMPOSER_CHAT_KEY); } catch { /* noop */ }
      set((s) => ({
        sessions: [...s.sessions, session],
        activeSessionId: session.id,
        composer: { ...s.composer, open: false },
        mainView: "fleet",
      }));
      return session.id;
    } catch (err) {
      console.error("commitComposer failed:", err);
      return null;
    }
  },

  closeComposer: () => {
    // Drop any compose-time chat-store entries (welcome / warnings)
    // so a fresh openComposer doesn't inherit them.
    try { useChatStore.getState().clearSession(COMPOSER_CHAT_KEY); } catch { /* noop */ }
    set((state) => ({
      composer: { ...state.composer, open: false },
      activeSessionId: state.activeSessionId,
    }));
  },

  // ── Legacy draft aliases ──
  // beginDraft/setDraftField/commitDraft/discardDraft are thin
  // adapters around the composer actions so existing call sites keep
  // working without a flag-day migration. The internal mechanism (no
  // Session row created at "new session" click) is the new one.
  beginDraft: async () => {
    await get().openComposer();
  },
  setDraftField: (patch) => {
    // Translate Session-shape keys → ComposerState keys.
    const c: Partial<ComposerState> = {};
    if (patch.project_path !== undefined) c.projectPath = patch.project_path;
    if (patch.tool !== undefined) c.tool = patch.tool;
    if (patch.model_name !== undefined) c.modelName = patch.model_name ?? null;
    if (patch.permission_mode !== undefined) c.permissionMode = patch.permission_mode;
    if (patch.use_worktree !== undefined) c.useWorktree = patch.use_worktree;
    if (patch.title !== undefined) c.title = patch.title;
    if (patch.claude_session_id !== undefined) c.claudeSessionId = patch.claude_session_id ?? null;
    if (patch.pending_clone_url !== undefined) c.pendingCloneUrl = patch.pending_clone_url ?? null;
    get().setComposerField(c);
  },
  commitDraft: async () => get().commitComposer(),
  discardDraft: () => get().closeComposer(),

  toggleFleetAutoMode: () =>
    set((state) => {
      const next = !state.fleetAutoMode;
      localStorage.setItem("fleet:autoMode", String(next));
      return { fleetAutoMode: next };
    }),
}));
