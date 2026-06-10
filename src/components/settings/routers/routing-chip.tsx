/**
 * Compact "routing status" chip that sits to the LEFT of the model
 * picker in the chat composer.
 *
 *   • Green dot   → master toggle is on AND a router is active
 *   • Dim dot     → master toggle off (routing disabled, manual selection)
 *
 * Clicking the chip opens a small popover with:
 *   • The active Decision router's name
 *   • The active Proxy gateway's name
 *   • A hint when both are the same service (no extra hop)
 *
 * The popover positions itself directly above the chip and clicks outside
 * dismiss it (matching the model picker's interaction). The chip itself is
 * deliberately narrow — just the dot + the word "Routing" — so it doesn't
 * compete visually with the model name.
 */
import { useEffect, useRef, useState } from "react";

import { useRouterConfig } from "@/hooks/use-router-config";

const wrap: React.CSSProperties = {
  position: "relative",
  display: "inline-flex",
};

// Same "calm pill" family as the permission picker / sandbox toggle /
// model chip: ghost background, neutral muted label, tiny state-coloured
// dot. No neon, no tonal fill — the chip earns attention only on hover
// or while its popover is open.
const chip: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "3px 8px",
  borderRadius: 5,
  border: "none",
  cursor: "pointer",
  background: "none",
  fontFamily: "inherit",
  fontSize: 12,
  fontWeight: 500,
  color: "var(--c-low)",
  transition: "background 120ms ease, color 120ms ease",
  whiteSpace: "nowrap",
  outline: "none",
};

const dot = (active: boolean): React.CSSProperties => ({
  width: 5,
  height: 5,
  borderRadius: "50%",
  // Refined green (same token as the branch strip / Sandbox dot) when
  // routing is on; quiet --c-low ring otherwise. No glow, no neon.
  background: active ? "rgb(64,180,120)" : "var(--c-low)",
  flexShrink: 0,
  transition: "background 150ms ease",
});

const popoverStyle: React.CSSProperties = {
  position: "absolute",
  bottom: "calc(100% + 6px)",
  left: 0,
  minWidth: 240,
  background: "var(--popover)",
  border: "1px solid var(--c-brd)",
  borderRadius: 9,
  padding: "10px 12px",
  boxShadow: "0 16px 40px rgba(0,0,0,0.5), 0 2px 8px rgba(0,0,0,0.2)",
  zIndex: 50,
  display: "flex",
  flexDirection: "column",
  gap: 6,
};

const rowLabel: React.CSSProperties = {
  fontSize: 10.5,
  color: "var(--c-dim)",
  textTransform: "uppercase",
  letterSpacing: 0.4,
  fontWeight: 600,
};

const rowValue: React.CSSProperties = {
  fontSize: 12.5,
  color: "var(--c-high)",
  fontWeight: 500,
};

export function RoutingChip() {
  const { tiles, masterEnabled, loading } = useRouterConfig();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Click-outside to dismiss the popover. Same pattern as the model
  // picker (`onMouseDown` listener so the click registers before any
  // global handlers).
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  if (loading) return null;

  const decision = tiles.find((t) => t.active_for_decision);
  const proxy = tiles.find((t) => t.active_for_proxy);
  const sameService = !!decision && !!proxy && decision.id === proxy.id;
  const lit = masterEnabled;
  // Self-hide when routing is off — Settings → Routers is the surface to
  // turn it on. Showing an always-dim "Routing" chip just for the disabled
  // popover added noise the user explicitly asked to remove.
  if (!lit) return null;

  return (
    <div ref={ref} style={wrap}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          ...chip,
          background: open ? "rgba(var(--fg-rgb), 0.05)" : "none",
          color: open ? "var(--c-high)" : "var(--c-low)",
        }}
        onMouseEnter={(e) => {
          if (!open) {
            e.currentTarget.style.background = "rgba(var(--fg-rgb), 0.05)";
            e.currentTarget.style.color = "var(--c-high)";
          }
        }}
        onMouseLeave={(e) => {
          if (!open) {
            e.currentTarget.style.background = "none";
            e.currentTarget.style.color = "var(--c-low)";
          }
        }}
        onMouseDown={(e) => e.preventDefault()}
        data-testid="routing-chip"
        aria-label={lit ? "Routing active" : "Routing off"}
        aria-expanded={open}
      >
        <span style={dot(lit)} aria-hidden />
        <span>Routing</span>
      </button>

      {open && (
        <div style={popoverStyle} data-testid="routing-chip-popover">
          {!lit && (
            <div
              style={{
                fontSize: 11.5,
                color: "var(--c-low)",
                lineHeight: 1.5,
              }}
            >
              Intelligent routing is disabled. Fleet uses your manually-
              selected agent + model for each turn. Toggle in
              Settings&nbsp;→&nbsp;Routers.
            </div>
          )}
          {lit && (
            <>
              <div>
                <div style={rowLabel}>Decision</div>
                <div style={rowValue}>
                  {decision?.display_name ?? "Built-in (Fleetify)"}
                </div>
              </div>
              <div style={{ height: 1, background: "var(--c-brd)" }} />
              <div>
                <div style={rowLabel}>Proxy</div>
                <div style={rowValue}>
                  {proxy?.display_name ?? "None / Direct"}
                </div>
              </div>
              {sameService && (
                <div
                  style={{
                    fontSize: 11,
                    color: "var(--c-dim)",
                    lineHeight: 1.5,
                    marginTop: 2,
                  }}
                >
                  Decisions are made in-line — no extra network hop.
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
