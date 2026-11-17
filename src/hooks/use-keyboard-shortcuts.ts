import { useEffect, type RefObject } from "react";
import { useAppStore } from "@/stores/app-store";
import { useChatStore } from "@/stores/chat-store";
import { wsManager } from "@/services/ws-manager";
import { stopSession, archiveSession } from "@/lib/api";
import { git } from "@/lib/git-api";
import { getPlatform, type Platform } from "@/lib/utils";
import { isOnScreen } from "@/hooks/use-escape-to-stop";

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
  /** `platform` lets a binding's key diverge per-OS (e.g. new session is
   *  Cmd+N on macOS, Ctrl+T on Windows/Linux). Bindings that don't care
   *  simply ignore the argument. */
  matches: (e: KeyboardEvent, mod: boolean, shift: boolean, platform: Platform) => boolean;
  run: (e: KeyboardEvent, ctx: ShortcutCtx) => void;
  /** Still runs while App.tsx parks the shell under `display: none` (Settings
   *  or Library open). Only for a binding that does not act on the hidden UI —
   *  today just the emergency abort-all. */
  worksWhileParked?: boolean;
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
    // Cmd+Shift+S — toggle sidebar. Case-insensitive like the other letter
    // bindings: Caps Lock, or Cmd+Shift on macOS, can deliver "s".
    id: "toggle-sidebar",
    matches: (e, mod, shift) => mod && shift && e.key.toLowerCase() === "s",
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
    // New draft session — Cmd+N on macOS, Ctrl+T (the new-tab convention) on
    // Windows / Linux. Key diverges per-OS; see KEYBOARD_SHORTCUTS.new-draft.
    id: "new-draft",
    matches: (e, mod, shift, platform) =>
      mod && !shift && e.key.toLowerCase() === (platform === "mac" ? "n" : "t"),
    run: (e, { state }) => { e.preventDefault(); void state.beginDraft(); },
  },
  {
    // Cmd+W / Ctrl+W — close the active agent session by archiving it (the
    // same action as the sidebar context-menu's archive: optimistic remove +
    // backend archive). No-op on the Fleet overview or the staff session.
    id: "close-session",
    matches: (e, mod, shift) => mod && !shift && (e.key === "w" || e.key === "W"),
    run: (e, { state }) => {
      const { activeSessionId, staffSessionId } = state;
      if (!activeSessionId || activeSessionId === staffSessionId) return;
      e.preventDefault();
      state.removeSession(activeSessionId);
      archiveSession(activeSessionId).catch(() => {});
    },
  },
  {
    // Cmd+Shift+. — toggle right panel. `key` includes Shift, so the chord
    // reports ">" on US-style layouts and Dvorak, "." on AZERTY (Shift+;) and
    // on macOS when Cmd hides Shift, and ":" where Shift+. is ":" — on the
    // Period key (German, Nordic, Spanish, Italian, Swiss, Czech, Hungarian,
    // Turkish F) or the Slash key (Turkish Q, Latvian modern; Brazilian
    // ABNT2's ;: key sends the same event, and nothing else binds it).
    // Nothing looser: on the Period key, AZERTY's Ctrl+/ reports "/" (the
    // Files editor's toggle-comment) and Dvorak's Ctrl+Shift+V reports "V"
    // (paste). Russian-style layouts, where Shift+. is ",", still miss it.
    id: "toggle-right-panel",
    matches: (e, mod, shift) =>
      mod && shift &&
      (e.key === "." || e.key === ">" || (e.key === ":" && (e.code === "Period" || e.code === "Slash"))),
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
    // Cmd+Shift+A — abort all running agents. An emergency stop, so it also
    // works while Settings or Library hides the shell, and it ignores case:
    // Caps Lock, or Cmd+Shift on macOS, can deliver "a".
    id: "abort-all",
    worksWhileParked: true,
    matches: (e, mod, shift) => mod && shift && e.key.toLowerCase() === "a",
    run: (e, { state, chatState }) => {
      e.preventDefault();
      // Every live agent: app-store status running / waiting / starting, plus
      // any chat still streaming, which the Fleet panel also shows as running.
      // A Set, so an agent that is both is stopped once.
      const ids = new Set<string>();
      for (const s of state.sessions) {
        if (s.status === "running" || s.status === "waiting" || s.status === "starting") ids.add(s.id);
      }
      for (const [id, chat] of Object.entries(chatState.sessions)) {
        if (chat.isStreaming) ids.add(id);
      }
      if (state.staffSessionId) ids.delete(state.staffSessionId);
      for (const id of ids) {
        wsManager.abort(id).catch(() => {});
        stopSession(id).catch(() => {});
      }
    },
  },
  {
    // Escape — go back to Fleet if in an agent view and not streaming. Skips
    // when focus is in an editable / dialog / keep-focus element (those own
    // their Esc), so it never destroys a draft mid-compose. Also skips an
    // Escape that a popover or menu already claimed to close itself.
    id: "back-to-fleet",
    matches: (e, mod, shift) => e.key === "Escape" && !mod && !shift,
    run: (e, { state, chatState }) => {
      // An Escape another handler already acted on is not ours. Mostly that
      // is a popover or menu claiming the Escape that closes it
      // (`claimEscape`) from a document listener or a React handler, both of
      // which run before this window listener. This one registers once, at
      // shell mount, so the chat's own window listeners (stop, permission
      // card) normally come after it. If one ever ran first, it acted on
      // this Escape too.
      if (e.defaultPrevented) return;
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
 *
 * `shell` is the AppShell root. App.tsx parks the shell under `display: none`
 * while Settings or Library is open, and nearly every binding here acts on
 * that hidden UI — so a parked shell ignores them. Without this, the Escape
 * that closed Library also ran `back-to-fleet` underneath it. Only a binding
 * marked `worksWhileParked` (the emergency abort-all) still runs.
 */
export function useKeyboardShortcuts(shell?: RefObject<Element | null>) {
  useEffect(() => {
    // Host platform is stable for the session — resolve once, not per keystroke.
    const platform = getPlatform();
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const shift = e.shiftKey;
      // Match first: most keystrokes are plain typing that no binding handles,
      // and they must not pay for the computed-style walk in isOnScreen.
      const binding = SHORTCUT_BINDINGS.find(b => b.matches(e, mod, shift, platform));
      if (!binding) return;
      // The flag goes first so abort-all skips that walk too.
      if (shell && !binding.worksWhileParked && !isOnScreen(shell.current)) return;
      binding.run(e, {
        state: useAppStore.getState(),
        chatState: useChatStore.getState(),
      });
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [shell]);
}
