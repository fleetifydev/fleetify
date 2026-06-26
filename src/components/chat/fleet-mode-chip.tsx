import { useState, useRef } from "react";
import { ChevronDown, Check } from "lucide-react";
import { useFleetStore, type FleetMode } from "@/stores/fleet-store";
import { LogoMark } from "@/components/brand/logo-mark";
import { fleetModeMeta } from "./fleet-mode-meta";
import { ComposerDropMenu } from "./composer-drop-menu";

const MODES: FleetMode[] = ["manual", "refine-only", "copilot", "auto"];

/**
 * FleetModeChip — compact in-box composer chip that opens an upward
 * dropdown to pick the Fleet mode (Manual / Refine only / Co-pilot /
 * Auto). Lives in the toolbar next to the model picker so Fleet mode +
 * model read as one status cluster. Fleet-hub only.
 *
 * The hub (controlCenter) drives the global mode; a bound session drives
 * its own per-session mode — the same contract the former FleetModeRow
 * exposed, now folded into a single chip + dropdown.
 */
export function FleetModeChip({
  sessionId,
  controlCenter,
}: {
  sessionId: string | null;
  controlCenter: boolean;
}) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);

  const globalMode = useFleetStore(s => s.globalMode);
  const setGlobalMode = useFleetStore(s => s.setGlobalMode);
  const sessionMode = useFleetStore(s =>
    sessionId ? s.getSession(sessionId).mode : ("manual" as FleetMode),
  );
  const setMode = useFleetStore(s => s.setMode);

  const active = controlCenter ? globalMode : sessionMode;
  const activeMeta = fleetModeMeta(active);

  const pick = (m: FleetMode) => {
    if (controlCenter) setGlobalMode(m);
    else if (sessionId) setMode(sessionId, m);
    setOpen(false);
  };

  return (
    <div style={{ position: "relative", flexShrink: 0 }}>
      {/* Trigger — same chip face as ModelChip (leading glyph + label +
          chevron) so the two sit side by side as one status cluster. The
          label takes the active mode's colour (Manual stays calm/neutral
          since it means "Fleet off"). */}
      <button
        ref={btnRef}
        data-testid="fleet-mode-trigger"
        aria-label={`Fleet mode: ${activeMeta.label}`}
        title="Fleet mode"
        onClick={() => setOpen(o => !o)}
        onMouseDown={e => e.preventDefault()}
        style={{
          display: "flex", alignItems: "center", gap: 5,
          padding: "2px 7px", borderRadius: 5, border: "none", cursor: "pointer",
          background: open ? "var(--c-srf2)" : "none",
          fontSize: 12, fontFamily: "var(--font-sans)",
          transition: "background 0.12s", outline: "none",
        }}
        onMouseEnter={e => { if (!open) e.currentTarget.style.background = "var(--c-srf)"; }}
        onMouseLeave={e => { if (!open) e.currentTarget.style.background = "none"; }}
      >
        <LogoMark size={11} style={{ flexShrink: 0 }} />
        <span style={{
          color: active === "manual" ? "var(--c-med)" : activeMeta.color,
          fontWeight: 500,
        }}>
          {activeMeta.label}
        </span>
        <ChevronDown
          size={9}
          strokeWidth={2}
          style={{
            color: "var(--c-low)",
            transform: open ? "rotate(180deg)" : "none",
            transition: "transform 0.15s",
          }}
        />
      </button>

      <ComposerDropMenu
        anchorRef={btnRef}
        open={open}
        onClose={() => setOpen(false)}
        role="listbox"
        ariaLabel="Fleet mode"
        style={{
          minWidth: 234,
          background: "var(--popover, #161616)",
          border: "1px solid var(--c-brd)",
          borderRadius: 8,
          padding: 3,
          boxShadow: "0 -8px 28px rgba(0,0,0,0.42)",
          fontFamily: "var(--font-sans)",
          animation: "fleet-popover-up 0.14s ease-out both",
        }}
      >
          {/* Section label — same hairline-quiet header the other toolbar
              popovers use, with the Fleet glyph for identity. */}
          <div style={{
            padding: "4px 8px 5px",
            fontSize: 10, fontWeight: 600,
            letterSpacing: 0.3, textTransform: "uppercase",
            color: "var(--c-dim)",
            display: "flex", alignItems: "center", gap: 6,
          }}>
            <LogoMark size={10} style={{ flexShrink: 0 }} />
            Fleet mode
          </div>

          {MODES.map(m => {
            const meta = fleetModeMeta(m);
            const on = m === active;
            return (
              <button
                key={m}
                role="option"
                aria-selected={on}
                data-testid={`fleet-mode-opt-${m}`}
                onClick={() => pick(m)}
                onMouseDown={e => e.preventDefault()}
                style={{
                  display: "flex", alignItems: "center", gap: 9,
                  width: "100%", padding: "5px 8px",
                  background: on ? "rgba(var(--fg-rgb),0.06)" : "transparent",
                  border: "none", outline: "none", cursor: "pointer",
                  borderRadius: 5, textAlign: "left", fontFamily: "inherit",
                  transition: "background 0.1s",
                }}
                onMouseEnter={e => { if (!on) (e.currentTarget as HTMLButtonElement).style.background = "rgba(var(--fg-rgb),0.04)"; }}
                onMouseLeave={e => { if (!on) (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
              >
                {/* Mode colour dot — glows when active, giving the menu a
                    quiet "live state" read without shouting. */}
                <span
                  aria-hidden
                  style={{
                    width: 7, height: 7, borderRadius: "50%", flexShrink: 0,
                    background: meta.color,
                    boxShadow: on ? `0 0 6px ${meta.color}` : "none",
                    transition: "box-shadow 0.15s",
                  }}
                />
                <span style={{ display: "flex", flexDirection: "column", gap: 1, flex: 1, minWidth: 0 }}>
                  <span style={{
                    fontSize: 12.5,
                    fontWeight: on ? 600 : 500,
                    color: on ? "var(--c-high)" : "var(--c-med)",
                  }}>
                    {meta.label}
                  </span>
                  <span style={{ fontSize: 10.5, color: "var(--c-dim)", lineHeight: 1.2 }}>
                    {meta.hint}
                  </span>
                </span>
                {on && <Check size={11} strokeWidth={2.2} style={{ color: "var(--c-low)", flexShrink: 0 }} />}
              </button>
            );
          })}
      </ComposerDropMenu>
    </div>
  );
}
