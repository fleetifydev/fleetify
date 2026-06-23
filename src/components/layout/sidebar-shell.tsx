import type { ReactNode } from "react";
import { usesInAppTitleBar } from "@/lib/utils";

/** Shared default sidebar width. app-shell's LEFT_DEFAULT is set from this;
 *  Settings/Library render at it. Replaces the old hand-coded 224s. */
export const SIDEBAR_DEFAULT_WIDTH = 224;

/** Shared nav row — icon + label, optional active/badge/count. Moved here
 *  from sidebar.tsx so Fleet, Settings, and Library share one definition. */
export function SideRow({
  icon, label, onClick, badge, active, count, tourKey,
}: {
  icon?: ReactNode; label: string; onClick?: () => void;
  badge?: string; active?: boolean; count?: number; tourKey?: string;
}) {
  const baseBg = active ? "var(--c-srf2)" : "transparent";
  const baseColor = active ? "var(--c-high)" : "var(--c-med)";
  const iconColor = active ? "var(--c-high)" : "var(--c-dim)";
  return (
    <button onClick={onClick} data-tour={tourKey} style={{
      display: "flex", alignItems: "center", gap: 10, width: "100%",
      padding: "6px 10px", border: "none", cursor: "pointer",
      textAlign: "left", fontSize: 13, fontWeight: active ? 600 : 400,
      borderRadius: 7, background: baseBg,
      color: baseColor, transition: "none",
    }}
      onMouseEnter={e => { if (!active) { e.currentTarget.style.background = "var(--c-srf)"; e.currentTarget.style.color = "var(--c-high)"; } }}
      onMouseLeave={e => { if (!active) { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--c-med)"; } }}
    >
      {icon != null && <span style={{ flexShrink: 0, display: "flex", color: iconColor, transition: "none" }}>{icon}</span>}
      <span style={{ flex: 1 }}>{label}</span>
      {count != null && count > 0 && (
        <span style={{ fontSize: 10.5, color: active ? "var(--c-low)" : "var(--c-ghost)", fontVariantNumeric: "tabular-nums", lineHeight: 1, flexShrink: 0 }}>{count}</span>
      )}
      {badge && (
        <span style={{ fontSize: 9.5, color: "var(--c-low)", background: "var(--c-srf2)", padding: "1px 6px", borderRadius: 3, fontWeight: 500, letterSpacing: 0.2 }}>{badge}</span>
      )}
    </button>
  );
}

interface SidebarShellProps {
  caption?: { icon: ReactNode; label: string };
  topBar?: ReactNode;
  /** Fixed (non-scrolling) content rendered after the caption and before the
   *  scroll area. Fleet's search overlay lives here so it stays pinned while
   *  the session list scrolls. */
  aboveScroll?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: number | string;
  chrome?: boolean;
  /** When set, becomes the `data-tour` attribute on the <nav>. Fleet passes
   *  "sidebar-rail" so the first-launch tour can anchor on the shell's nav. */
  navTour?: string;
  /** Whether the shell owns the scroll area. `true` (default, Settings/Library)
   *  wraps `children` in a `scroll-subtle` `overflowY:auto` div. `false` (Fleet)
   *  renders a plain non-overflow `flex:1` div so the caller's own scroller
   *  (Fleet's `<ReactLenis>`) owns scrolling — no double scroll container. The
   *  `0 6px` padding is identical either way so rows align. */
  scroll?: boolean;
}

/** The shared left-sidebar chrome: optional outer card, 44px macOS top bar
 *  (with a right-aligned slot), optional rail caption, optional fixed
 *  above-scroll slot, scroll area, optional footer. `chrome={false}` returns
 *  just the <nav> (Fleet, whose card lives in app-shell); `chrome={true}`
 *  draws the card (Settings/Library). */
export function SidebarShell({
  caption, topBar, aboveScroll, children, footer,
  width = SIDEBAR_DEFAULT_WIDTH, chrome = true, navTour, scroll = true,
}: SidebarShellProps) {
  const inApp = usesInAppTitleBar();
  const nav = (
    <nav data-tour={navTour} style={{
      height: "100%", display: "flex", flexDirection: "column",
      background: "var(--sidebar)", overflow: "hidden", userSelect: "none",
    }}>
      {inApp && <div style={{ height: 12, flexShrink: 0 }} />}
      {!inApp && (
        <div className="drag-region" style={{
          height: 44, flexShrink: 0, display: "flex", alignItems: "center",
          padding: "0 10px 0 78px",
        }}>
          <div style={{ flex: 1 }} />
          {topBar && (
            <div className="no-drag" style={{ display: "flex", gap: 1, marginTop: -8 }}>
              {topBar}
            </div>
          )}
        </div>
      )}
      {caption && (
        <div style={{
          display: "flex", alignItems: "center", gap: 8, padding: "0 12px 12px",
          color: "var(--c-dim)", fontSize: 11.5, fontWeight: 600,
          letterSpacing: "0.08em", textTransform: "uppercase",
        }}>
          {caption.icon}<span>{caption.label}</span>
        </div>
      )}
      {aboveScroll && <div style={{ flexShrink: 0 }}>{aboveScroll}</div>}
      {scroll ? (
        <div className="scroll-subtle" style={{ flex: 1, overflowY: "auto", minHeight: 0, padding: "0 6px" }}>
          {children}
        </div>
      ) : (
        /* Caller owns scrolling. A transparent flex-column pass-through so a
           `flex:1` child (e.g. Fleet's <ReactLenis>) still resolves to a
           bounded height and scrolls instead of clipping. No overflow and no
           padding here: the caller's subtree supplies its own inner padding,
           so adding `0 6px` would double-inset the rows. */
        <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
          {children}
        </div>
      )}
      {footer && <div style={{ flexShrink: 0, padding: "6px 6px 8px" }}>{footer}</div>}
    </nav>
  );
  if (!chrome) return nav;
  return (
    <div style={{
      width, flexShrink: 0, marginTop: 8, marginBottom: 8,
      borderRadius: 8, border: "1px solid var(--c-brd)",
      background: "var(--sidebar)", overflow: "hidden",
    }}>
      {nav}
    </div>
  );
}
