import { useEffect } from "react";
import { useAppStore } from "@/stores/app-store";
import { useChatStore } from "@/stores/chat-store";
import { wsManager } from "@/services/ws-manager";
import { stopSession } from "@/lib/api";
import { git } from "@/lib/git-api";

/** Resolve the active session's project folder, or null if Fleet view. */
function activeFolder(): string | null {
  const { sessions, activeSessionId, staffSessionId } = useAppStore.getState();
  if (!activeSessionId || activeSessionId === staffSessionId) return null;
  const s = sessions.find(x => x.id === activeSessionId);
  return s?.project_path ?? null;
}

/** Toast helper — routes through the console (the notification system was removed). */
function toast(title: string, summary: string, success: boolean) {
  const line = `[shortcut] ${title}: ${summary}`;
  if (success) console.info(line); else console.warn(line);
}

interface ShortcutCtx {
  state: ReturnType<typeof useAppStore.getState>;
  chatState: ReturnType<typeof useChatStore.getState>;
}

interface ShortcutBinding {
  /** Shared with KEYBOARD_SHORTCUTS (source:"hook") — guarded by a drift test. */
  id: string;
  matches: (e: KeyboardEvent, mod: boolean, shift: boolean) => boolean;
  run: (e: KeyboardEvent, ctx: ShortcutCtx) => void;
}

/**
 * Global Fleet keyboard bindings, in evaluation order (first match wins — the
 * same semantics as the previous if/else chain). Each `run` body is the exact
 * handler that used to live inline; state is read fresh per event via `ctx`.
 */
export const SHORTCUT_BINDINGS: ShortcutBinding[] = [
  {
    // Cmd+1–9 — switch to nth agent session (excluding staff session)
    id: "switch-agent",
    matches: (e, mod, shift) => mod && !shift && e.key >= "1" && e.key <= "9",
    run: (e, { state }) => {
      const idx = parseInt(e.key, 10) - 1;
      const agentSessions = state.sessions.filter(s => s.id !== state.staffSessionId);
      const target = agentSessions[idx];
      if (target) {
        e.preventDefault();
        state.setMainView("fleet");
        state.setActiveSession(target.id);
      }
    },
  },
  {
    // Cmd+Shift+S — toggle sidebar
    id: "toggle-sidebar",
    matches: (e, mod, shift) => mod && shift && e.key === "S",
    run: (e, { state }) => { e.preventDefault(); state.toggleSidebar(); },
  },
  {
    // Cmd+Shift+P — preview panel
    id: "panel-preview",
    matches: (e, mod, shift) => mod && shift && (e.key === "P" || e.key === "p"),
    run: (e, { state }) => { e.preventDefault(); state.openWorkspaceView("preview"); },
  },
  {
    // Cmd+Shift+D — diff panel
    id: "panel-diff",
    matches: (e, mod, shift) => mod && shift && (e.key === "D" || e.key === "d"),
    run: (e, { state }) => { e.preventDefault(); state.openWorkspaceView("diff"); },
  },
  {
    // Cmd+Shift+F — files panel
    id: "panel-files",
    matches: (e, mod, shift) => mod && shift && (e.key === "F" || e.key === "f"),
    run: (e, { state }) => { e.preventDefault(); state.openWorkspaceView("files"); },
  },
  {
    // Ctrl+` — terminal panel (guarded by ctrlKey directly, NOT meta, so ⌘`
    // — macOS window switching — never fires it)
    id: "panel-terminal",
    matches: (e) => e.ctrlKey && !e.metaKey && e.key === "`",
    run: (e, { state }) => { e.preventDefault(); state.openWorkspaceView("terminal"); },
  },
  {
    // Cmd+N — create a draft session inline
    id: "new-draft",
    matches: (e, mod, shift) => mod && !shift && (e.key === "n" || e.key === "N"),
    run: (e, { state }) => { e.preventDefault(); void state.beginDraft(); },
  },
  {
    // Cmd+Shift+. — toggle right panel
    id: "toggle-right-panel",
    matches: (e, mod, shift) => mod && shift && e.key === ".",
    run: (e, { state }) => { e.preventDefault(); state.toggleRightPanel(); },
  },
  {
    // Cmd+Shift+Y — commit & push (scoped to the active agent session)
    id: "commit-push",
    matches: (e, mod, shift) => mod && shift && (e.key === "Y" || e.key === "y"),
    run: (e) => {
      e.preventDefault();
      const folder = activeFolder();
      if (!folder) return;
      (async () => {
        const ctx = await (window as unknown as {
          electronAPI?: { getGitContext?: (f: string) => Promise<{ branch?: string }> }
        }).electronAPI?.getGitContext?.(folder);
        const msg = `wip: ${ctx?.branch ?? "session"} update`;
        const c = await git.commit(folder, msg);
        if (!c.ok) { toast("Commit failed", c.error, false); return; }
        const p = await git.push(folder);
        if (!p.ok) { toast("Push failed", p.error, false); return; }
        toast("Pushed", `${ctx?.branch ?? "branch"} → origin`, true);
      })();
    },
  },
  {
    // Cmd+Shift+M — merge the open PR
    id: "merge-pr",
    matches: (e, mod, shift) => mod && shift && (e.key === "M" || e.key === "m"),
    run: (e) => {
      e.preventDefault();
      const folder = activeFolder();
      if (!folder) return;
      (async () => {
        const r = await git.prStatus(folder);
        if (!r.ok || !r.pr || r.pr.state !== "OPEN") {
          toast("No open PR", "Create one first.", false);
          return;
        }
        const m = await git.mergePR(folder, r.pr.number, "squash");
        if (!m.ok) { toast("Merge failed", m.error, false); return; }
        toast("Merged", `#${r.pr.number} squashed`, true);
      })();
    },
  },
  {
    // Cmd+Shift+L — pull latest from base branch
    id: "pull-latest",
    matches: (e, mod, shift) => mod && shift && (e.key === "L" || e.key === "l"),
    run: (e) => {
      e.preventDefault();
      const folder = activeFolder();
      if (!folder) return;
      (async () => {
        const ctx = await (window as unknown as {
          electronAPI?: { getGitContext?: (f: string) => Promise<{ baseBranch?: string }> }
        }).electronAPI?.getGitContext?.(folder);
        const r = await git.pullLatest(folder, ctx?.baseBranch);
        if (!r.ok) {
          toast(r.inConflict ? "Merge conflicts" : "Pull failed",
                r.error + (r.inConflict ? " — run /resolve-merge-conflicts" : ""),
                false);
          return;
        }
        toast("Pulled", `Up to date with ${ctx?.baseBranch ?? "base"}`, true);
      })();
    },
  },
  {
    // Cmd+Shift+G — open the PR (or new-PR page) in GitHub
    id: "open-pr",
    matches: (e, mod, shift) => mod && shift && (e.key === "G" || e.key === "g"),
    run: (e) => {
      e.preventDefault();
      const folder = activeFolder();
      if (!folder) return;
      git.openPR(folder);
    },
  },
  {
    // Cmd+Shift+A — abort all running agents
    id: "abort-all",
    matches: (e, mod, shift) => mod && shift && e.key === "A",
    run: (e, { state }) => {
      e.preventDefault();
      const running = state.sessions.filter(
        s =>
          (s.status === "running" || s.status === "waiting" || s.status === "starting") &&
          s.id !== state.staffSessionId,
      );
      for (const s of running) {
        wsManager.abort(s.id).catch(() => {});
        stopSession(s.id).catch(() => {});
      }
    },
  },
  {
    // Escape — go back to Fleet if in an agent view and not streaming. Skips
    // when focus is in an editable / dialog / keep-focus element (those own
    // their Esc), so it never destroys a draft mid-compose.
    id: "back-to-fleet",
    matches: (e, mod, shift) => e.key === "Escape" && !mod && !shift,
    run: (e, { state, chatState }) => {
      const target = e.target as HTMLElement | null;
      const inEditable =
        !!target && (
          target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable === true ||
          !!target.closest("[role='dialog']") ||
          !!target.closest("[data-keep-focus='true']")
        );
      if (inEditable) return;
      const { activeSessionId, staffSessionId } = state;
      if (activeSessionId && activeSessionId !== staffSessionId) {
        const cs = chatState.sessions[activeSessionId];
        if (!(cs?.isStreaming)) {
          e.preventDefault();
          state.setActiveSession(null);
        }
      }
    },
  },
];

/** Ids the hook actually handles — compared against the registry by the drift test. */
export const HANDLED_SHORTCUT_IDS: string[] = SHORTCUT_BINDINGS.map(b => b.id);

/**
 * Global keyboard shortcuts for Fleet. Registered once; state is read fresh
 * from the stores inside the handler. First matching binding wins.
 */
export function useKeyboardShortcuts() {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const shift = e.shiftKey;
      const ctx: ShortcutCtx = {
        state: useAppStore.getState(),
        chatState: useChatStore.getState(),
      };
      for (const b of SHORTCUT_BINDINGS) {
        if (b.matches(e, mod, shift)) { b.run(e, ctx); return; }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
}
