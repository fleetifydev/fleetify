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

/** Toast helper — the renderer used to push a one-off notification via
 *  the app store; the notification system has been removed so this
 *  routes through the console instead. The call sites keep the same
 *  signature so the surrounding control flow (early returns on failure)
 *  doesn't need to change. */
function toast(title: string, summary: string, success: boolean) {
  const line = `[shortcut] ${title}: ${summary}`;
  if (success) console.info(line); else console.warn(line);
}

/**
 * Global keyboard shortcuts for Fleet.
 * All state is read fresh from the store inside the handler so the effect
 * only needs to be registered once (empty deps).
 */
export function useKeyboardShortcuts() {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      const shift = e.shiftKey;

      const state = useAppStore.getState();
      const chatState = useChatStore.getState();

      // Cmd+1–9 — switch to nth agent session (excluding staff session)
      if (meta && !shift && e.key >= "1" && e.key <= "9") {
        const idx = parseInt(e.key, 10) - 1;
        const agentSessions = state.sessions.filter(s => s.id !== state.staffSessionId);
        const target = agentSessions[idx];
        if (target) {
          e.preventDefault();
          state.setMainView("fleet");
          state.setActiveSession(target.id);
        }
        return;
      }

      // Cmd+Shift+S — toggle sidebar
      if (meta && shift && e.key === "S") {
        e.preventDefault();
        state.toggleSidebar();
        return;
      }

      // ── Panel view shortcuts ──
      // Match the Claude Code menu order: ⇧⌘P / ⇧⌘D / ⌃` / ⇧⌘F.
      // Each one opens the right panel and switches it to that view.
      // No-ops when on Fleet/staff view (no workspace there yet).
      if (meta && shift && (e.key === "P" || e.key === "p")) {
        e.preventDefault();
        state.openWorkspaceView("preview");
        return;
      }
      if (meta && shift && (e.key === "D" || e.key === "d")) {
        e.preventDefault();
        state.openWorkspaceView("diff");
        return;
      }
      if (meta && shift && (e.key === "F" || e.key === "f")) {
        e.preventDefault();
        state.openWorkspaceView("files");
        return;
      }
      // Ctrl+` — terminal panel. Backtick comes through as e.key === "`"
      // on most layouts. Guarded by e.ctrlKey directly (NOT meta) so we
      // don't fire on ⌘` (which macOS uses for window switching).
      if (e.ctrlKey && !e.metaKey && e.key === "`") {
        e.preventDefault();
        state.openWorkspaceView("terminal");
        return;
      }

      // Cmd+N — create a draft session inline (no modal). The chip
      // strip in chat-input handles the rest of the config. Plain
      // ⌘N matches the system "New" convention and matches what the
      // Fleet hub's empty-state kbd hint advertises.
      if (meta && !shift && (e.key === "n" || e.key === "N")) {
        e.preventDefault();
        void state.beginDraft();
        return;
      }

      // Cmd+Shift+. — toggle right panel
      if (meta && shift && e.key === ".") {
        e.preventDefault();
        state.toggleRightPanel();
        return;
      }

      // ── Conductor-style git/PR shortcuts ──
      // All scoped to the active agent session. They no-op silently
      // when no folder is active (Fleet/staff view).

      // Cmd+Shift+Y — commit & push
      if (meta && shift && (e.key === "Y" || e.key === "y")) {
        e.preventDefault();
        const folder = activeFolder();
        if (!folder) return;
        (async () => {
          // Default commit message — branch summary. Future: route through
          // the agent for an AI-generated message.
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
        return;
      }

      // Cmd+Shift+M — merge the open PR
      if (meta && shift && (e.key === "M" || e.key === "m")) {
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
        return;
      }

      // Cmd+Shift+L — pull latest from base branch
      if (meta && shift && (e.key === "L" || e.key === "l")) {
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
        return;
      }

      // Cmd+Shift+G — open the PR (or new-PR page) in GitHub
      if (meta && shift && (e.key === "G" || e.key === "g")) {
        e.preventDefault();
        const folder = activeFolder();
        if (!folder) return;
        git.openPR(folder);
        return;
      }

      // Cmd+Shift+A — abort all running agents
      if (meta && shift && e.key === "A") {
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
        return;
      }

      // Escape — go back to Fleet if in an agent view and not streaming.
      //
      // CRITICAL: skip when focus is inside an editable element. The user is
      // almost always typing in the chat input when they hit Esc; without
      // this guard, Esc yanks them back to Fleet, unmounts the input
      // component, and silently destroys whatever draft they were composing.
      // The mental model is "Esc cancels the current thing in front of me",
      // not "Esc navigates the app while I'm in the middle of typing".
      // Inputs/textareas/contenteditables that need their own Esc handling
      // (chat-input's stop-streaming, mention popovers, slash menus, etc.)
      // already register local listeners — this global one stays out of
      // their way.
      if (e.key === "Escape" && !meta && !shift) {
        const target = e.target as HTMLElement | null;
        const inEditable =
          !!target && (
            target.tagName === "INPUT" ||
            target.tagName === "TEXTAREA" ||
            target.isContentEditable === true ||
            // Also defer when focus is inside any modal/popover container —
            // those almost always have their own Esc-to-close binding and we
            // don't want to "double-close" by also navigating away.
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
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
}
