/**
 * SplitPaneGrid — multi-chat layout.
 *
 * Just ChatView instances side by side, with thin resize handles
 * between them. No pane header / chrome — the user's mental model
 * is "I split the single chat in half" not "I opened a window".
 *
 * Each pane:
 *   • Card border + 8 px radius so the layout still reads as
 *     distinct surfaces (not a wall of input boxes).
 *   • A tiny close X in the top-right corner that fades in on
 *     hover. No always-visible label / grip / title bar.
 *   • Embedded right panel (Terminal / Diff / …) when its
 *     PanelViewMenu pick toggles paneRightOpen for this session.
 *   • Drop targets stay (drop a sidebar session on the left/right
 *     edge to insert a new pane, or center to swap).
 *
 * Splitting is fully drag-driven — no Split button anywhere.
 *
 * Resize:
 *   • Per-pane flex weights live in store.paneSizes (number[]).
 *   • A 4-px draggable handle between every adjacent pane pair
 *     drags the boundary; live updates.
 *
 * Layout direction: ALL splits are horizontal (side-by-side
 * columns), regardless of pane count. The user explicitly asked
 * "yan yana koyuoruz" — vertical 2×2 felt like windowing chrome.
 */
import { useRef, useState, useCallback, useEffect } from "react";
import { ChatView } from "./chat-view";
import { useAppStore } from "@/stores/app-store";
import { PaneSessionProvider } from "./pane-session-context";
import { WorkspacePanel } from "@/components/workspace/workspace-panel";

const DRAG_MIME = "application/x-fleet-session-id";
type EdgeZone = "left" | "right" | "center" | null;

/** Layout thresholds.
 *
 *  Default behaviour: max 2 columns. The 3rd and 4th panes wrap
 *  to a second row. The user's spec was "3 ve 4. pencere her
 *  zaman alt'a açılsın" — so we honour that as the default and
 *  only allow more columns on a really wide canvas (an external
 *  monitor or an ultrawide).
 *
 *  WIDE_CANVAS_PX: above this, allow 3+ columns. Picked at
 *  1700 px so a typical 13-15" laptop (1280-1440 px) stays in
 *  the 2-col regime, an external 24-27" (1920+) gets 3-4 cols. */
const MIN_PANE_WIDTH  = 360;
const WIDE_CANVAS_PX  = 1700;

export function SplitPaneGrid({
  dragging, onPaneDropEdge,
}: {
  dragging: boolean;
  onPaneDropEdge: (paneIdx: number, zone: "left" | "right" | "center", sessionId: string) => void;
}) {
  const splitPaneIds  = useAppStore(s => s.splitPaneIds);
  const focusedPaneIdx = useAppStore(s => s.focusedPaneIdx);
  const removePane    = useAppStore(s => s.removePane);
  const setFocusedPaneIdx = useAppStore(s => s.setFocusedPaneIdx);

  // Outer container width — drives the auto-layout decision (do
  // we add another column or wrap to a new row?). Tracked via
  // ResizeObserver so the layout reflows when the user drags the
  // sidebar / right panel and the available horizontal space
  // changes.
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState<number>(0);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => {
      for (const ent of entries) setContainerWidth(ent.contentRect.width);
    });
    ro.observe(el);
    setContainerWidth(el.getBoundingClientRect().width);
    return () => ro.disconnect();
  }, []);

  // Auto-layout: split the flat pane list into rows based on the
  // container width. We pick the largest column count that keeps
  // every pane ≥ MIN_PANE_WIDTH wide, then distribute panes
  // evenly across rows.
  const rows = computeRows(splitPaneIds, containerWidth);

  // Per-pane flex weights, FLAT — index matches splitPaneIds.
  const [weights, setWeights] = useState<number[]>(() => splitPaneIds.map(() => 1));
  useEffect(() => {
    setWeights(prev => {
      if (prev.length === splitPaneIds.length) return prev;
      const avg = prev.length > 0 ? prev.reduce((a, b) => a + b, 0) / prev.length : 1;
      return splitPaneIds.map((_, i) => prev[i] ?? avg);
    });
  }, [splitPaneIds.length]);

  if (splitPaneIds.length === 0) return null;

  // Helper — find a pane's flat index from row+col coords.
  const flatIdx = (rowIdx: number, colIdx: number): number => {
    let n = 0;
    for (let r = 0; r < rowIdx; r++) n += rows[r]?.length ?? 0;
    return n + colIdx;
  };

  return (
    <div
      ref={containerRef}
      style={{
        flex: 1, minHeight: 0, minWidth: 0,
        display: "flex", flexDirection: "column",
        gap: 0,
        // Container padding zeroed — the leftmost pane should sit
        // flush against the sidebar's right edge, matching the
        // single-view ChatView layout. The 6 px we used to add as
        // outer padding made the split layout feel like a separate
        // box floating inside the chat surface. Inter-pane gaps
        // come from the ResizeHandle (6 px) and the row marginTop
        // (6 px) — those still apply between panes.
        padding: 0,
        background: "var(--card)",
      }}
    >
      {rows.map((rowPanes, rowIdx) => (
        <div
          key={rowIdx}
          style={{
            flex: `1 1 ${100 / rows.length}%`,
            minHeight: 0, minWidth: 0,
            display: "flex", flexDirection: "row",
            // Vertical gap between rows comes from a 6-px space
            // applied as marginTop on rows past the first.
            marginTop: rowIdx === 0 ? 0 : 6,
          }}
        >
          {rowPanes.map((sid, colIdx) => {
            const idx = flatIdx(rowIdx, colIdx);
            const isLastInRow = colIdx === rowPanes.length - 1;
            return (
              <PaneSlot
                key={sid}
                sid={sid}
                idx={idx}
                last={isLastInRow}
                focused={idx === focusedPaneIdx}
                weight={weights[idx] ?? 1}
                onClose={() => removePane(sid)}
                onFocus={() => setFocusedPaneIdx(idx)}
                onPaneDropEdge={onPaneDropEdge}
                dragging={dragging}
                onResizeRight={(deltaPx, totalPx) => {
                  setWeights(prev => {
                    const next = prev.slice();
                    const rightFlat = flatIdx(rowIdx, colIdx + 1);
                    if (rightFlat >= prev.length) return prev;
                    const sumPrev = prev[idx]! + prev[rightFlat]!;
                    const ratio = sumPrev / totalPx;
                    const minW = sumPrev * 0.18;
                    const maxW = sumPrev * 0.82;
                    const newLeft = Math.min(maxW, Math.max(minW, prev[idx]! + deltaPx * ratio));
                    next[idx] = newLeft;
                    next[rightFlat] = sumPrev - newLeft;
                    return next;
                  });
                }}
              />
            );
          })}
        </div>
      ))}
    </div>
  );
}

/** Distribute a flat pane list into rows based on container width.
 *
 *  Strategy: pick the LARGEST column count such that
 *    containerWidth / cols ≥ MIN_PANE_WIDTH
 *  Then ceil-divide panes into rows, leaving the last row with
 *  any remainder (which is fine since flex re-distributes within
 *  the row).
 *
 *  Edge cases:
 *    • containerWidth = 0 → ResizeObserver hasn't fired yet, fall
 *      back to single row so initial render isn't blank.
 *    • Very narrow (<MIN_PANE_WIDTH) → 1 column, panes stack. */
function computeRows(panes: string[], containerWidth: number): string[][] {
  if (panes.length === 0) return [];
  if (containerWidth <= 0) return [panes];          // pre-measure

  // Default: 2 columns max — 3rd and 4th pane stack BELOW.
  // Promote to 3-4 cols only on a wide canvas where columns
  // can stay above MIN_PANE_WIDTH each.
  const widthCap = Math.max(1, Math.floor(containerWidth / MIN_PANE_WIDTH));
  const wideAllowance = containerWidth >= WIDE_CANVAS_PX
    ? Math.min(4, widthCap)   // wide screen: up to 4 cols if they fit
    : 2;                       // default: 2 cols → forces 3rd/4th down

  const cols = Math.min(panes.length, Math.max(1, wideAllowance));
  const rowCount = Math.ceil(panes.length / cols);
  const rows: string[][] = [];
  for (let r = 0; r < rowCount; r++) {
    rows.push(panes.slice(r * cols, (r + 1) * cols));
  }
  return rows;
}

/* ─── PaneSlot — pane wrapper + (optional) resize handle ───────── */

function PaneSlot({
  sid, idx, last, focused, weight,
  onClose, onFocus, onPaneDropEdge, dragging,
  onResizeRight,
}: {
  sid: string;
  idx: number;
  last: boolean;
  focused: boolean;
  weight: number;
  onClose: () => void;
  onFocus: () => void;
  onPaneDropEdge: (paneIdx: number, zone: "left" | "right" | "center", sessionId: string) => void;
  dragging: boolean;
  onResizeRight: (deltaPx: number, totalPx: number) => void;
}) {
  return (
    <>
      <Pane
        sessionId={sid}
        idx={idx}
        focused={focused}
        weight={weight}
        onClose={onClose}
        onFocus={onFocus}
        onPaneDropEdge={onPaneDropEdge}
        dragging={dragging}
      />
      {!last && <ResizeHandle onResize={onResizeRight} />}
    </>
  );
}

/* ─── ResizeHandle ─────────────────────────────────────────────── */

function ResizeHandle({
  onResize,
}: {
  onResize: (deltaPx: number, totalPx: number) => void;
}) {
  const [active, setActive] = useState(false);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setActive(true);
    const startX = e.clientX;
    // Total width = parent flex row's width — drives the
    // pixel-to-weight conversion.
    const parent = (e.currentTarget as HTMLDivElement).parentElement;
    const totalPx = parent?.getBoundingClientRect().width ?? 1;

    const onMove = (ev: MouseEvent) => {
      onResize(ev.clientX - startX, totalPx);
    };
    const onUp = () => {
      setActive(false);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [onResize]);

  return (
    <div
      onMouseDown={onMouseDown}
      style={{
        position: "relative",
        width: 6, flexShrink: 0,
        cursor: "col-resize",
        // The visible affordance is a 1-px center line that
        // brightens on hover/drag; the surrounding 6 px is the
        // pointer-friendly hit area.
        display: "flex", alignItems: "stretch", justifyContent: "center",
      }}
    >
      <div style={{
        width: active ? 2 : 1,
        background: active
          ? "rgba(var(--fg-rgb), 0.35)"
          : "transparent",
        transition: "background 0.12s, width 0.12s",
      }} />
    </div>
  );
}

/* ─── Pane ─────────────────────────────────────────────────────── */

function Pane({
  sessionId, idx, focused, weight, dragging,
  onClose, onFocus, onPaneDropEdge,
}: {
  sessionId: string;
  idx: number;
  focused: boolean;
  weight: number;
  dragging: boolean;
  onClose: () => void;
  onFocus: () => void;
  onPaneDropEdge: (paneIdx: number, zone: "left" | "right" | "center", sessionId: string) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [zone, setZone] = useState<EdgeZone>(null);

  const paneRightOpen = useAppStore(s => s.paneRightOpen[sessionId] ?? false);
  const togglePaneRightPanel = useAppStore(s => s.togglePaneRightPanel);

  const computeZone = (clientX: number): EdgeZone => {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const x = clientX - rect.left;
    const w = rect.width;
    if (x < w * 0.25) return "left";
    if (x > w * 0.75) return "right";
    return "center";
  };

  return (
    <div
      ref={wrapRef}
      onClick={onFocus}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(DRAG_MIME)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        setZone(computeZone(e.clientX));
      }}
      onDragLeave={(e) => {
        if (!wrapRef.current?.contains(e.relatedTarget as Node)) setZone(null);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setZone(null);
        const sid = e.dataTransfer.getData(DRAG_MIME);
        if (sid) {
          const z = computeZone(e.clientX) ?? "center";
          onPaneDropEdge(idx, z, sid);
        }
      }}
      style={{
        flex: `${weight} 1 0`,
        minWidth: 0, minHeight: 0,
        position: "relative",
        display: "flex", flexDirection: "column",
        background: "var(--card)",
        // Card chrome — same border treatment as the rest of Fleet
        // so the panes read as distinct surfaces, but no top header
        // strip (the user said "no window chrome"). Focused pane
        // gets a brighter border so the user can still see which
        // pane the sidebar binds to.
        border: "1px solid " + (focused ? "var(--c-brd2)" : "var(--c-brd)"),
        borderRadius: 8,
        overflow: "hidden",
        transition: "border-color 0.12s",
      }}
    >
      {/* Pane close lives in ChatView's HEADER now (passed via the
          onClosePane prop). Floating absolute-positioned X buttons
          competed with chat-view chrome (sidebar toggle, breadcrumb)
          and with the workspace panel's own X / + / □ trio, which
          made the close affordance look broken even when it was
          firing the right action. Routing it through the chat
          header gives it dedicated, conflict-free space. */}

      {/* Chat + (optional) per-pane right panel */}
      <PaneSessionProvider sessionId={sessionId}>
        <div style={{
          flex: 1, minHeight: 0, minWidth: 0,
          display: "flex", flexDirection: "row",
        }}>
          <div style={{
            flex: paneRightOpen ? "1 1 60%" : "1 1 100%",
            minWidth: 0, minHeight: 0,
            display: "flex",
            transition: "flex-basis 0.18s ease",
          }}>
            <ChatView paneSessionId={sessionId} paneIdx={idx} onClosePane={onClose} />
          </div>
          {paneRightOpen && (
            <div style={{
              flex: "1 1 40%",
              minWidth: 0, minHeight: 0,
              borderLeft: "1px solid var(--c-brd)",
              display: "flex", flexDirection: "column",
              background: "var(--card)",
            }}>
              <WorkspacePanel onClose={() => togglePaneRightPanel(sessionId)} />
            </div>
          )}
        </div>
      </PaneSessionProvider>

      {/* Drop overlay — appears only while a sidebar drag is in flight. */}
      {dragging && zone && (
        <div aria-hidden style={{
          position: "absolute", inset: 0,
          pointerEvents: "none",
          zIndex: 50,
        }}>
          <DropHighlight zone={zone} />
        </div>
      )}
    </div>
  );
}

/* ─── DropHighlight ────────────────────────────────────────────── */

function DropHighlight({ zone }: { zone: "left" | "right" | "center" }) {
  const isCenter = zone === "center";
  const styles: React.CSSProperties = isCenter ? {
    position: "absolute", inset: 6,
    background: "rgba(96, 165, 250, 0.10)",
    border: "2px dashed rgba(96, 165, 250, 0.55)",
    borderRadius: 8,
  } : {
    position: "absolute",
    top: 6, bottom: 6,
    [zone]: 6,
    width: "calc(40% - 9px)",
    background: "rgba(96, 165, 250, 0.12)",
    border: "2px dashed rgba(96, 165, 250, 0.65)",
    borderRadius: 8,
  };
  return (
    <div style={{ ...styles, animation: "fleet-popover-in 0.10s ease-out both" }}>
      <div style={{
        position: "absolute", top: "50%", left: "50%",
        transform: "translate(-50%, -50%)",
        fontFamily: "var(--font-sans)",
        fontSize: 10.5, fontWeight: 600,
        color: "rgba(96, 165, 250, 0.95)",
        letterSpacing: 0.4, textTransform: "uppercase",
        whiteSpace: "nowrap",
        textShadow: "0 1px 2px rgba(0,0,0,0.4)",
      }}>
        {zone === "center" ? "Replace" : zone === "left" ? "Split left" : "Split right"}
      </div>
    </div>
  );
}
