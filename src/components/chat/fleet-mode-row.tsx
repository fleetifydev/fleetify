import { useFleetStore, type FleetMode } from "@/stores/fleet-store";
import { LogoMark } from "@/components/brand/logo-mark";
import { fleetModeMeta } from "./fleet-mode-meta";

const MODES: FleetMode[] = ["manual", "refine-only", "copilot", "auto"];

export function FleetModeRow({
  sessionId,
  controlCenter,
}: {
  sessionId: string | null;
  controlCenter: boolean;
}) {
  const globalMode = useFleetStore(s => s.globalMode);
  const setGlobalMode = useFleetStore(s => s.setGlobalMode);
  const sessionMode = useFleetStore(s =>
    sessionId ? s.getSession(sessionId).mode : "manual" as FleetMode,
  );
  const setMode = useFleetStore(s => s.setMode);

  const active = controlCenter ? globalMode : sessionMode;

  const pick = (m: FleetMode) => {
    if (controlCenter) {
      setGlobalMode(m);
    } else if (sessionId) {
      setMode(sessionId, m);
    }
  };

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 4,
        padding: "4px 10px 0",
      }}
    >
      <LogoMark size={11} style={{ flexShrink: 0, marginRight: 2 }} />
      {MODES.map(m => {
        const meta = fleetModeMeta(m);
        const on = m === active;
        return (
          <button
            key={m}
            onClick={() => pick(m)}
            onMouseDown={e => e.preventDefault()}
            title={meta.hint}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              height: 22,
              padding: "0 8px",
              borderRadius: 5,
              border: "none",
              cursor: "pointer",
              background: on ? "var(--c-srf2)" : "transparent",
              color: on ? meta.color : "var(--c-low)",
              fontSize: 11.5,
              fontWeight: on ? 600 : 500,
              fontFamily: "inherit",
              transition: "background 0.12s, color 0.12s",
            }}
            onMouseEnter={e => {
              if (!on) (e.currentTarget as HTMLElement).style.background = "var(--c-srf)";
            }}
            onMouseLeave={e => {
              if (!on) (e.currentTarget as HTMLElement).style.background = "transparent";
            }}
          >
            {meta.label}
          </button>
        );
      })}
    </div>
  );
}
