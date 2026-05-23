/**
 * Small status pill that tells the user where a provider tile stands:
 * Connected (green), Needs setup (gray), Error (red), Testing (amber).
 * Shared between provider-card and ollama-config-card so the visual
 * language stays consistent across the Settings → Models surface.
 */

export type ConnectionStatus = "connected" | "needs_setup" | "error" | "testing";

export function ConnectionStatusPill({
  status,
  label,
}: {
  status: ConnectionStatus;
  label?: string;
}) {
  const palette: Record<ConnectionStatus, { fg: string; bg: string; dot: string; text: string }> = {
    connected: {
      fg: "rgb(74,222,128)",
      bg: "rgba(74,222,128,0.10)",
      dot: "rgb(74,222,128)",
      text: label ?? "Connected",
    },
    needs_setup: {
      fg: "var(--c-dim)",
      bg: "var(--c-srf)",
      dot: "var(--c-dim)",
      text: label ?? "Not connected",
    },
    error: {
      fg: "rgb(248,113,113)",
      bg: "rgba(248,113,113,0.10)",
      dot: "rgb(248,113,113)",
      text: label ?? "Error",
    },
    testing: {
      fg: "rgb(250,204,21)",
      bg: "rgba(250,204,21,0.10)",
      dot: "rgb(250,204,21)",
      text: label ?? "Testing…",
    },
  };
  const c = palette[status];
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "3px 8px",
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: "0.02em",
        color: c.fg,
        background: c.bg,
        whiteSpace: "nowrap",
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: c.dot,
          flexShrink: 0,
        }}
      />
      {c.text}
    </span>
  );
}
