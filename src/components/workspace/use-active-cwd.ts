/**
 * The working directory the current workspace pane operates in.
 *
 * Resolution order matches what every pane already did inline before this hook
 * existed: the pane's own session when rendered inside a split pane, otherwise
 * the globally-active session; then that session's worktree path, falling back
 * to its project path.
 *
 * Extracted because the identical six-line selector was copy-pasted at three
 * call sites in workspace-panel.tsx (terminal, diff, files) and the Preview
 * view would have made a fourth.
 */
import { useAppStore } from "@/stores/app-store";
import { usePaneSessionId } from "@/components/chat/pane-session-context";

export function useActiveCwd(): string | undefined {
  const paneSid = usePaneSessionId();
  return useAppStore(s => {
    const id = paneSid ?? s.activeSessionId;
    if (!id) return undefined;
    const sess = s.sessions.find(x => x.id === id);
    return sess?.worktree_path || sess?.project_path || undefined;
  });
}
