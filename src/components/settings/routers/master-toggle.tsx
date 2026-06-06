/**
 * Master toggle row — flips `routing.enabled` in fleet.config.json.
 *
 * Same visual primitive as the pill switch used everywhere else in
 * Settings (see Toggle in settings-page.tsx) — the button is a green
 * pill when on, neutral when off, with a sliding circle inside. Wired
 * to setMasterEnabled from useRouterConfig.
 */
interface Props {
  enabled: boolean;
  onChange: (v: boolean) => void | Promise<void>;
}

const rowStyle: React.CSSProperties = {
  border: "1px solid var(--c-brd)",
  borderRadius: 10,
  background: "var(--card)",
  padding: "14px 16px",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 16,
};

export function MasterToggle({ enabled, onChange }: Props) {
  const handleToggle = () => {
    void onChange(!enabled);
  };
  return (
    <div data-testid="router-master-toggle-row" style={rowStyle}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 13,
            fontWeight: 500,
            color: "var(--c-high)",
            lineHeight: 1.3,
          }}
        >
          Use intelligent routing for Fleet Hub
        </div>
        <div
          style={{
            fontSize: 12,
            color: "var(--c-low)",
            marginTop: 3,
            lineHeight: 1.5,
          }}
        >
          When enabled, Fleetify picks the best agent and model for each new
          session/task.
        </div>
      </div>
      <button
        data-testid="router-master-toggle"
        onClick={handleToggle}
        role="switch"
        aria-checked={enabled}
        aria-label="Use intelligent routing for Fleet Hub"
        style={{
          width: 36,
          height: 21,
          borderRadius: 999,
          padding: 0,
          position: "relative",
          border: "1px solid var(--c-brd)",
          cursor: "pointer",
          flexShrink: 0,
          background: enabled ? "rgb(64,180,120)" : "var(--c-srf)",
          transition: "background 0.18s, border-color 0.18s",
          outline: "none",
        }}
      >
        <span
          style={{
            position: "absolute",
            top: 2,
            left: enabled ? 17 : 2,
            width: 15,
            height: 15,
            borderRadius: "50%",
            background: "#fff",
            boxShadow: "0 1px 2px rgba(0,0,0,0.25)",
            transition: "left 0.18s cubic-bezier(0.4,0,0.2,1)",
          }}
        />
      </button>
    </div>
  );
}
