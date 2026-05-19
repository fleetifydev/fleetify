/**
 * ChatSurface — drag-driven multi-pane chat host.
 *
 * Replaces the old "click Split → grid" flow. Now there's no
 * Split button anywhere. Splitting happens entirely via drag:
 *
 *   • Single chat (default): drag a sidebar session over the chat
 *     surface. Edge drop zones light up (left half / right half).
 *     Drop on left  → new pane appears on the LEFT  (dragged session)
 *     Drop on right → new pane appears on the RIGHT (dragged session)
 *     Drop on center→ replaces the current session
 *
 *   • Split mode (>= 2 panes): each pane has its own edge zones.
 *     Drop on left edge of pane → insert new pane BEFORE this one
 *     Drop on right edge of pane → insert new pane AFTER this one
 *     Drop on center of pane → swap that pane's session
 *
 * No buttons, no modals. The drop overlay only appears while a
 * sidebar drag is in progress, so it never gets in the way.
 *
 * The drag MIME (`application/x-fleet-session-id`) is set by the
 * sidebar's AgentRow onDragStart; nothing else fires it.
 */
import { useEffect, useRef, useState } from "react";
import { ChatView } from "./chat-view";
import { useAppStore, SPLIT_PANE_LIMIT } from "@/stores/app-store";
import { SplitPaneGrid } from "./split-pane-grid";

const DRAG_MIME = "application/x-fleet-session-id";
type EdgeZone = "left" | "right" | "center" | null;

export function ChatSurface() {
  const splitPaneIds   = useAppStore(s => s.splitPaneIds);
  const activeSessionId = useAppStore(s => s.activeSessionId);
  const addPane        = useAppStore(s => s.addPane);
  const setPaneSession = useAppStore(s => s.setPaneSession);
  const setActiveSession = useAppStore(s => s.setActiveSession);

  // Track whether ANY sidebar-session drag is currently in flight.
  // Without this we'd have to keep edge overlays mounted permanently,
  // which would catch random clicks. dragenter/dragleave on the
  // window are racy (fire when the cursor crosses child boundaries),
  // so we listen for the global `dragstart` / `dragend` instead.
  const [dragging, setDragging] = useState<string | null>(null);
  useEffect(() => {
    const onStart = (e: DragEvent) => {
      const sid = e.dataTransfer?.getData(DRAG_MIME);
      // Some browsers (Chromium) don't expose the data on dragstart
      // for cross-target detection — they only set types. Use the
      // types presence as the trigger; the actual sessionId comes
      // back on drop.
      if (e.dataTransfer?.types.includes(DRAG_MIME) || sid) {
        setDragging(sid || "pending");
      }
    };
    const onEnd = () => setDragging(null);
    window.addEventListener("dragstart", onStart);
    window.addEventListener("dragend", onEnd);
    window.addEventListener("drop", onEnd);
    return () => {
      window.removeEventListener("dragstart", onStart);
      window.removeEventListener("dragend", onEnd);
      window.removeEventListener("drop", onEnd);
    };
  }, []);

  // ── Single-view path: ChatView + edge overlay ──
  if (splitPaneIds.length <= 1) {
    return (
      <SingleSurface
        dragging={!!dragging}
        onDropEdge={(zone, sid) => {
          if (zone === "center") {
            // Replace current session in single view.
            setActiveSession(sid);
            return;
          }
          // Edge drop → enter split mode.
          // For "left", we want the dragged pane on the left and
          // current on the right. addPane bootstraps with current
          // first then dragged; movePane swaps when needed.
          if (!activeSessionId || activeSessionId === sid) {
            addPane(sid);
            return;
          }
          // Use the store's order: addPane pushes to the end. For
          // left-drop, swap the two panes after creation so the
          // dragged session sits at index 0.
          if (zone === "left") {
            useAppStore.getState().addPane(sid);
            // Swap if a 2-pane grid was created.
            const ids = useAppStore.getState().splitPaneIds;
            if (ids.length === 2) useAppStore.getState().movePane(1, 0);
          } else {
            addPane(sid);
          }
        }}
      />
    );
  }

  // ── Multi-pane path ──
  return (
    <SplitPaneGrid
      dragging={!!dragging}
      onPaneDropEdge={(idx, zone, sid) => {
        if (zone === "center") {
          setPaneSession(idx, sid);
          return;
        }
        // Insert before / after the target pane. Cap at SPLIT_PANE_LIMIT.
        const ids = useAppStore.getState().splitPaneIds;
        if (ids.length >= SPLIT_PANE_LIMIT) {
          // Grid full — fall back to swap behaviour so the drop
          // isn't silently lost.
          setPaneSession(idx, sid);
          return;
        }
        // Skip if it's already in the grid (no-op rather than dup).
        if (ids.includes(sid)) {
          // Move it to the requested neighbour position.
          const fromIdx = ids.indexOf(sid);
          const targetIdx = zone === "left" ? idx : idx + 1;
          // Adjust for the gap left by removing the moved pane.
          const adjustedTarget = fromIdx < targetIdx ? targetIdx - 1 : targetIdx;
          useAppStore.getState().movePane(fromIdx, adjustedTarget);
          return;
        }
        addPane(sid);
        // After append, slide it to the requested neighbour slot.
        const newIds = useAppStore.getState().splitPaneIds;
        const newIdx = newIds.length - 1;
        const targetIdx = zone === "left" ? idx : idx + 1;
        if (newIdx !== targetIdx) {
          useAppStore.getState().movePane(newIdx, targetIdx);
        }
      }}
    />
  );
}

/* ─── Single-view surface with edge drop overlay ───────────────── */

function SingleSurface({
  dragging, onDropEdge,
}: {
  dragging: boolean;
  onDropEdge: (zone: "left" | "right" | "center", sessionId: string) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [zone, setZone] = useState<EdgeZone>(null);

  return (
    <div
      ref={wrapRef}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(DRAG_MIME)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        const rect = wrapRef.current?.getBoundingClientRect();
        if (!rect) return;
        const x = e.clientX - rect.left;
        const w = rect.width;
        // 30 / 40 / 30 split — generous left/right edges so the
        // user doesn't have to land pixel-perfect; center is the
        // "swap" affordance.
        if (x < w * 0.3) setZone("left");
        else if (x > w * 0.7) setZone("right");
        else setZone("center");
      }}
      onDragLeave={(e) => {
        // Only clear when the cursor truly leaves the wrap (not when
        // it crosses a child boundary). relatedTarget == null means
        // we left the window/element entirely.
        if (!wrapRef.current?.contains(e.relatedTarget as Node)) {
          setZone(null);
        }
      }}
      onDrop={(e) => {
        e.preventDefault();
        const sid = e.dataTransfer.getData(DRAG_MIME);
        if (sid && zone) onDropEdge(zone, sid);
        setZone(null);
      }}
      style={{
        position: "relative",
        flex: 1, minHeight: 0, minWidth: 0,
        display: "flex", flexDirection: "column",
      }}
    >
      <ChatView />

      {/* Drop overlay — only mounts while a sidebar drag is active.
          A single overlay covers the surface; the highlighted
          rectangle moves between left/right/center depending on the
          cursor zone. pointer-events:none on the highlight pane
          means the underlying onDragOver still tracks the cursor. */}
      {dragging && (
        <div
          aria-hidden
          style={{
            position: "absolute", inset: 0,
            pointerEvents: "none",
            zIndex: 50,
          }}
        >
          {zone && <DropHighlight zone={zone} kind="single" />}
        </div>
      )}
    </div>
  );
}

/* ─── Drop highlight rectangle ─────────────────────────────────── */

function DropHighlight({
  zone, kind,
}: {
  zone: "left" | "right" | "center";
  kind: "single" | "pane";
}) {
  const isCenter = zone === "center";
  // Center zone gets a softer, full-bleed treatment ("swap this
  // pane's session"). Left/right are edge slabs that suggest a
  // new pane will appear there.
  const styles: React.CSSProperties = isCenter ? {
    position: "absolute", inset: 8,
    background: "rgba(96, 165, 250, 0.10)",
    border: "2px dashed rgba(96, 165, 250, 0.55)",
    borderRadius: 10,
  } : {
    position: "absolute",
    top: 8, bottom: 8,
    [zone]: 8,
    width: kind === "single" ? "calc(50% - 12px)" : "calc(35% - 12px)",
    background: "rgba(96, 165, 250, 0.12)",
    border: "2px dashed rgba(96, 165, 250, 0.65)",
    borderRadius: 10,
  };
  return (
    <div style={{
      ...styles,
      animation: "fleet-popover-in 0.10s ease-out both",
    }}>
      <div style={{
        position: "absolute", top: "50%", left: "50%",
        transform: "translate(-50%, -50%)",
        fontFamily: "var(--font-sans)",
        fontSize: 11.5, fontWeight: 600,
        color: "rgba(96, 165, 250, 0.95)",
        letterSpacing: 0.4, textTransform: "uppercase",
        whiteSpace: "nowrap",
        textShadow: "0 1px 2px rgba(0,0,0,0.4)",
      }}>
        {zone === "center"
          ? "Replace session"
          : zone === "left" ? "Split left" : "Split right"}
      </div>
    </div>
  );
}

/** Re-export so app-shell can still import a named ChatSurface. */
export { DropHighlight as _DropHighlight };
