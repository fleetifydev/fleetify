/**
 * Lets a workspace view remove itself from the pane grid.
 *
 * Each view draws its own header, so each one needs the close affordance. The
 * grid provides the handler; the view calls it with its own id.
 *
 * Lives in its own module rather than inside workspace-panel.tsx so that views
 * extracted into `views/` can consume it without importing their own parent —
 * which would be a circular import.
 */
import { createContext } from "react";
import type { WorkspaceView } from "@/stores/app-store";

export const PaneCloseContext = createContext<((v: WorkspaceView) => void) | null>(null);
