import { PanelLeft, Search, ArrowLeft } from "lucide-react";
import { useAppStore } from "@/stores/app-store";
import { usesInAppTitleBar } from "@/lib/utils";
import { Ib, SortMenu } from "./sidebar";
import { WindowControls, WINDOWS_TITLEBAR_HEIGHT_PX } from "./window-controls";

/**
 * In-app top title bar (Windows + Linux) — full-width row, ChatGPT-desktop
 * style. Both platforms build the window decorationless, so the renderer owns
 * the chrome here.
 *
 * The bar is split into three regions:
 *   • Left:   sidebar controls (toggle / search / sort) — moved here
 *             from inside the sidebar so the rail starts cleaner and
 *             the chrome reads as one row of caption affordances.
 *             Full-viewport routes (Settings, Library, …) override
 *             this with a single back-arrow button via the ``backTo``
 *             prop so the caption trio doesn't suggest navigation
 *             that no longer applies on those surfaces.
 *   • Middle: empty drag-region — primary surface for window-drag.
 *   • Right:  custom caption buttons (minimize / maximize / close).
 *
 * Mounted at the very top of the app shell so the sidebar / chat /
 * right-panel grid below it never has to reserve space for the
 * window controls. macOS doesn't mount this component (traffic lights
 * are OS-drawn over the chat header instead, and the same trio of
 * sidebar controls still lives inside the sidebar header there).
 */
export interface WindowsTitleBarProps {
  /** Full-viewport routes (Settings, Library, …) pass this to swap
   *  the sidebar-controls trio for a single back-arrow that closes
   *  the route. The right-side caption buttons (min/max/close) keep
   *  rendering exactly as on the main shell so window operations
   *  stay reachable from every surface — that's the user-reported
   *  regression this prop exists to fix. */
  backTo?: { onBack: () => void; title?: string };
}

export function WindowsTitleBar({ backTo }: WindowsTitleBarProps = {}) {
  // Hooks first, platform gate after — keeps the call order stable
  // even though usesInAppTitleBar() is effectively const at runtime.
  const toggleSidebar = useAppStore(s => s.toggleSidebar);
  const sidebarCollapsed = useAppStore(s => s.sidebarCollapsed);
  const setSidebarSearchOpen = useAppStore(s => s.setSidebarSearchOpen);
  const sidebarSearchOpen = useAppStore(s => s.sidebarSearchOpen);
  const sortBy = useAppStore(s => s.sidebarSortBy);
  const setSortBy = useAppStore(s => s.setSidebarSortBy);

  if (!usesInAppTitleBar()) return null;

  // The search overlay only renders inside the EXPANDED sidebar (the
  // collapsed rail doesn't have room for an inline input). So when
  // the user clicks search here while the sidebar is collapsed, we
  // first expand the sidebar and then open the overlay — clicking
  // search must never feel inert. Toggling-off works without the
  // expand step because closing is a no-op against an already-closed
  // overlay.
  const handleSearchClick = () => {
    if (sidebarSearchOpen) {
      setSidebarSearchOpen(false);
      return;
    }
    if (sidebarCollapsed) toggleSidebar();
    setSidebarSearchOpen(true);
  };

  return (
    <div
      className="drag-region"
      style={{
        height: WINDOWS_TITLEBAR_HEIGHT_PX,
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        background: "var(--card)",
        // Left inset hosts the sidebar control trio; everything to
        // the right of it (until the WindowControls trio) is empty
        // drag-region so the user can grab anywhere outside the
        // controls to move the window.
        padding: "0 0 0 8px",
      }}
    >
      {/* Left affordance — either the main-shell control trio
          (toggle / search / sort) or a single back-arrow on full-
          viewport routes that swap it out via ``backTo``. */}
      <div
        className="no-drag"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 1,
        }}
      >
        {backTo ? (
          <Ib onClick={backTo.onBack} title={backTo.title ?? "Back"}>
            <ArrowLeft size={12} />
          </Ib>
        ) : (
          <>
            <Ib onClick={toggleSidebar} title="Toggle sidebar">
              <PanelLeft size={12} />
            </Ib>
            <Ib onClick={handleSearchClick} title="Search">
              <Search size={12} />
            </Ib>
            {/* align="left" because the trigger sits at the far left
                of the title bar — the default right-anchored menu
                would spill off the left window edge. */}
            <SortMenu value={sortBy} onChange={setSortBy} align="left" />
          </>
        )}
      </div>

      <div style={{ flex: 1 }} />

      <WindowControls />
    </div>
  );
}
