import {
  ChevronLeft,
  ChevronRight,
  Square,
  MoreHorizontal,
  GitCommitHorizontal,
  ChevronDown,
  Copy,
  Share,
  PanelLeftOpen,
} from "lucide-react";
import { useAppStore } from "@/stores/app-store";

function IconBtn({
  children,
  onClick,
  title,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  title?: string;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      // Solid surface hover (var(--c-srf)/(--c-srf2)) instead of rgba alpha —
      // alpha-on-dark looks cloudy over vibrancy/glass backgrounds.
      className="p-[6px] rounded-md text-[#808080] hover:text-[#b0b0b0] transition-colors no-drag"
      onMouseEnter={(e) => { e.currentTarget.style.background = "var(--c-srf)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
      onMouseDown={(e) => { e.currentTarget.style.background = "var(--c-srf2)"; }}
      onMouseUp={(e) => { e.currentTarget.style.background = "var(--c-srf)"; }}
    >
      {children}
    </button>
  );
}

/** Sidebar titlebar — inside vibrancy column */
export function SidebarTitlebar() {
  return (
    <div
      className="drag-region flex-shrink-0 flex items-center"
      style={{ height: 52, borderBottom: "1px solid rgba(255,255,255,0.06)", minWidth: 272 }}
    >
      <div style={{ width: 84, flexShrink: 0 }} />

      <div className="flex items-center gap-[1px]">
        <IconBtn title="Back">
          <ChevronLeft size={15} strokeWidth={2} />
        </IconBtn>
        <IconBtn title="Forward">
          <ChevronRight size={15} strokeWidth={2} />
        </IconBtn>
      </div>

      <div style={{ width: 1, height: 16, background: "rgba(255,255,255,0.07)", margin: "0 7px" }} />

      <IconBtn title="Select">
        <Square size={13} strokeWidth={2} />
      </IconBtn>
    </div>
  );
}

/** Main titlebar — inside opaque column */
export function MainTitlebar() {
  const { sessions, activeSessionId, toggleSidebar, sidebarCollapsed } = useAppStore();
  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const hasSession = !!activeSession;

  return (
    <div
      className="drag-region flex-shrink-0 flex items-center"
      style={{ height: 52, borderBottom: "1px solid rgba(255,255,255,0.06)" }}
    >
      {sidebarCollapsed && (
        <div className="no-drag" style={{ paddingLeft: 80 }}>
          <IconBtn onClick={toggleSidebar} title="Show sidebar">
            <PanelLeftOpen size={15} strokeWidth={1.8} />
          </IconBtn>
        </div>
      )}

      {/* Center */}
      <div className="flex-1 flex items-center justify-center gap-2.5 no-drag min-w-0">
        <span
          className="truncate"
          style={{
            fontSize: 13,
            fontWeight: hasSession ? 600 : 500,
            color: hasSession ? "#d8d8d8" : "#808080",
            letterSpacing: "-0.01em",
          }}
        >
          {activeSession?.title ?? "New chat"}
        </span>

        {hasSession && (
          <IconBtn>
            <MoreHorizontal size={15} strokeWidth={2} />
          </IconBtn>
        )}

        <button className="no-drag flex items-center gap-1.5 px-2.5 py-[4px] rounded-full text-[11px] font-medium text-emerald-400 bg-emerald-400/10 hover:bg-emerald-400/15 border border-emerald-400/12 transition-colors">
          <span>✦</span>
          <span>Get Plus</span>
        </button>
      </div>

      {/* Right — only show contextual actions */}
      <div className="flex items-center gap-[2px] no-drag" style={{ paddingRight: 16 }}>
        {/* Agent */}
        <button className="no-drag flex items-center gap-1.5 px-2 py-[5px] rounded-md hover:bg-[var(--c-srf)] transition-colors">
          <div
            className="flex items-center justify-center"
            style={{
              width: 20, height: 20, borderRadius: 6,
              background: "linear-gradient(135deg, rgba(52,211,153,0.2), rgba(16,185,129,0.2))",
              border: "1px solid rgba(52,211,153,0.15)",
            }}
          >
            <span style={{ color: "#34d399", fontSize: 10, fontWeight: 700, lineHeight: 1 }}>M</span>
          </div>
          <ChevronDown size={10} className="text-[#505050]" />
        </button>

        <div style={{ width: 1, height: 16, background: "rgba(255,255,255,0.06)", margin: "0 6px" }} />

        {/* Commit - only when session active */}
        {hasSession && (
          <>
            <button
              className="no-drag flex items-center gap-1.5 px-2.5 py-[5px] rounded-md hover:bg-[var(--c-srf)] text-[#707070] hover:text-[#a0a0a0] transition-colors"
              style={{ fontSize: "12px" }}
            >
              <GitCommitHorizontal size={13} strokeWidth={2} />
              <span>Commit</span>
              <ChevronDown size={10} className="text-[#505050]" />
            </button>
            <div style={{ width: 1, height: 16, background: "rgba(255,255,255,0.06)", margin: "0 6px" }} />
          </>
        )}

        <IconBtn title="Copy">
          <Copy size={13} strokeWidth={2} />
        </IconBtn>
        <IconBtn title="Share">
          <Share size={13} strokeWidth={2} />
        </IconBtn>
      </div>
    </div>
  );
}
