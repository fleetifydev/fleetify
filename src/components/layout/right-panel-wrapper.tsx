/**
 * Right-panel surface.
 *
 * Earlier this component wrapped Hub + Workspace behind an inner
 * Fleet / Workspace tab strip. The new chat-side panel-picker
 * model (Preview / Diff / Terminal / Files / Tasks / Plan)
 * supersedes that — when an agent session is open, the right
 * panel is the single view chosen from the menu, no inner tab
 * navigation.
 *
 * Hub (FleetPanel) is still rendered when no individual agent is
 * active (Fleet/staff view) — that's the "always-reachable
 * operations center" surface from the vision doc.
 *
 * The 44px top bar mirrors the left sidebar's own header: when the
 * panel is OPEN, the collapse toggle lives inside the panel itself,
 * so the chat-header stays clean. When CLOSED, the toggle migrates
 * back into the chat-header (handled in chat-view.tsx).
 */
import { FleetPanel } from "@/components/dashboard/fleet-panel";
import { WorkspacePanel } from "@/components/workspace/workspace-panel";
import { useAppStore } from "@/stores/app-store";
import type { Session } from "@/types/session";

interface Props {
  sessions: Session[];
  onSelectAgent: (id: string | null) => void;
  onNewAgent: () => void;
  onClose: () => void;
}

export function RightPanelWrapper({ sessions, onSelectAgent }: Props) {
  const activeSessionId = useAppStore(s => s.activeSessionId);
  const staffSessionId  = useAppStore(s => s.staffSessionId);

  // Single source of truth: agent session ⇒ Workspace; otherwise Hub.
  // No wrapper header any more — FleetPanel draws its own pane-card
  // chrome (matching WorkspaceGrid's panes), and the chat-header's
  // right-panel toggle handles open/close from outside. Two rows of
  // chrome on the Fleet hub looked cluttered.
  const isIndividualAgent = !!activeSessionId && activeSessionId !== staffSessionId;

  return (
    <div style={{
      height: "100%", minHeight: 0,
      background: "transparent",
      overflow: "hidden",
    }}>
      {isIndividualAgent
        ? <WorkspacePanel onClose={() => {}} />
        : <FleetPanel sessions={sessions} onSelectAgent={onSelectAgent} />
      }
    </div>
  );
}
