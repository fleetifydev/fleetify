import type { RouterTile as RouterTileMeta } from "@/lib/routers-api";

interface Props {
  meta: RouterTileMeta;
  description: string;
  onConnect?: () => void;
  onDisconnect?: () => void;
  onActivate: (category: "decision" | "proxy") => void;
}

const tileStyle: React.CSSProperties = {
  border: "1px solid var(--c-brd)",
  borderRadius: 10,
  background: "var(--card)",
  padding: "14px 16px",
  display: "flex",
  alignItems: "flex-start",
  gap: 14,
};

const capBadge: React.CSSProperties = {
  fontSize: 10,
  textTransform: "uppercase",
  letterSpacing: 0.5,
  padding: "2px 6px",
  borderRadius: 4,
  background: "var(--c-srf2)",
  color: "var(--c-high)",
  fontWeight: 600,
};

const btnConnect: React.CSSProperties = {
  padding: "5px 11px",
  borderRadius: 7,
  background: "var(--c-fg)",
  border: "1px solid var(--c-fg)",
  color: "var(--card, #0d0d0d)",
  cursor: "pointer",
  fontSize: 12,
  fontFamily: "inherit",
  fontWeight: 600,
  whiteSpace: "nowrap",
};

const btnGhost: React.CSSProperties = {
  background: "transparent",
  border: "none",
  color: "var(--c-low)",
  cursor: "pointer",
  fontSize: 11.5,
  fontFamily: "inherit",
  textDecoration: "underline",
  padding: 0,
};

const radioLabel: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  cursor: "pointer",
  fontSize: 11.5,
  color: "var(--c-high)",
};

export function RouterTile({
  meta,
  description,
  onConnect,
  onDisconnect,
  onActivate,
}: Props) {
  const isImmortal = meta.id === "builtin" || meta.id === "none-proxy";
  return (
    <div data-testid={`router-tile-${meta.id}`} style={tileStyle}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontSize: 13.5, fontWeight: 600, color: "var(--c-high)" }}>
            {meta.display_name}
          </span>
          {meta.capabilities.map((c) => (
            <span key={c} style={capBadge}>{c}</span>
          ))}
          {meta.connected && !isImmortal && (
            <span style={{ fontSize: 11.5, color: "#22c55e" }}>✓ connected</span>
          )}
          {isImmortal && (
            <span style={{ fontSize: 11.5, color: "var(--c-dim)" }}>always available</span>
          )}
        </div>
        <p style={{ fontSize: 12, color: "var(--c-low)", marginTop: 4, lineHeight: 1.5 }}>
          {description}
        </p>
        {meta.connected && (
          <div style={{ marginTop: 8, display: "flex", gap: 14, flexWrap: "wrap" }}>
            {meta.capabilities.includes("decision") && (
              <label style={radioLabel}>
                <input
                  type="radio"
                  name="active-decision"
                  checked={meta.active_for_decision}
                  onChange={() => onActivate("decision")}
                  style={{ cursor: "pointer" }}
                />
                Active for decision
              </label>
            )}
            {meta.capabilities.includes("proxy") && (
              <label style={radioLabel}>
                <input
                  type="radio"
                  name="active-proxy"
                  checked={meta.active_for_proxy}
                  onChange={() => onActivate("proxy")}
                  style={{ cursor: "pointer" }}
                />
                Active for proxy
              </label>
            )}
          </div>
        )}
      </div>
      {!isImmortal && (
        <div style={{ flexShrink: 0 }}>
          {meta.connected ? (
            <button
              type="button"
              data-testid={`router-disconnect-${meta.id}`}
              style={btnGhost}
              onClick={onDisconnect}
            >
              Disconnect
            </button>
          ) : (
            <button
              type="button"
              data-testid={`router-connect-${meta.id}`}
              style={btnConnect}
              onClick={onConnect}
            >
              Connect
            </button>
          )}
        </div>
      )}
    </div>
  );
}
