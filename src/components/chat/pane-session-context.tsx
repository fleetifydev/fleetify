/**
 * PaneSessionContext — overrides which session a subtree reads
 * from the app store.
 *
 * Without this, every component inside the right panel calls
 *   useAppStore(s => s.activeSessionId)
 * directly, which means a 4-pane split shows the SAME workspace
 * (terminal / diff / files) in every pane. With it:
 *
 *   <PaneSessionProvider sessionId={paneSessionId}>
 *     <WorkspacePanel ... />     ← uses paneSessionId
 *   </PaneSessionProvider>
 *
 * Anywhere in the subtree:
 *   const sid = usePaneSessionId();   // pane's id, OR
 *                                       // activeSessionId fallback
 *
 * Components that haven't opted in to the hook keep reading from
 * the store as before — the override is purely opt-in.
 */
import { createContext, useContext } from "react";
import { useAppStore } from "@/stores/app-store";

const PaneSessionContext = createContext<string | null | undefined>(undefined);

export function PaneSessionProvider({
  sessionId, children,
}: {
  sessionId: string | null;
  children: React.ReactNode;
}) {
  return (
    <PaneSessionContext.Provider value={sessionId}>
      {children}
    </PaneSessionContext.Provider>
  );
}

/** Returns the pane's session id when called inside a
 *  PaneSessionProvider, or the global activeSessionId from the
 *  app store otherwise. Components use this in place of the
 *  raw store selector to be split-aware. */
export function usePaneSessionId(): string | null {
  const ctx = useContext(PaneSessionContext);
  // The context default is `undefined`; an explicit null is a
  // VALID provider value ("this pane has no session yet"). So we
  // distinguish the unprovided case from "provider says null".
  const storeId = useAppStore(s => s.activeSessionId);
  return ctx === undefined ? storeId : ctx;
}

/** True iff this hook is called inside a PaneSessionProvider.
 *  Use this when you need to BRANCH on "am I rendered inside a
 *  split pane" vs "am I rendered in the legacy single-view path"
 *  — usePaneSessionId() can't tell those apart on its own
 *  because it returns activeSessionId as a fallback. */
export function useIsInPane(): boolean {
  return useContext(PaneSessionContext) !== undefined;
}
