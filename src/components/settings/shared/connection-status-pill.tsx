/**
 * Shared status pill used across Settings → Models, Settings → Routers,
 * and (incrementally) other settings surfaces that need an at-a-glance
 * connection indicator. Lives in shared/ because two adjacent surfaces
 * (Models and Routers) consume it; promote to a deeper shared location
 * only if a non-settings caller appears.
 *
 *   activated   — green, slightly stronger than connected. Used for
 *                 "this router is currently active" or similar one-of-N
 *                 selections.
 *   connected   — green. Used for "tile has credentials saved".
 *   needs_setup — gray. Used for "tile exists but nothing configured".
 *   error       — red. Used for failed test / probe.
 *   testing     — amber. Used during in-flight probes.
 */
export type ConnectionStatus =
  | "activated"
  | "connected"
  | "needs_setup"
  | "error"
  | "testing";

export function ConnectionStatusPill({
  status,
  label,
}: {
  status: ConnectionStatus;
  label?: string;
}) {
  // Refined status — a single small status dot carries the colour; the text
  // stays neutral (no green-on-green "monitoring dashboard" look). `pulse` adds
  // a soft animated ring while a probe is in flight.
  const palette: Record<ConnectionStatus, { dot: string; text: string; pulse?: boolean }> = {
    activated: { dot: "rgb(64,180,120)", text: label ?? "Activated" },
    connected: { dot: "rgb(64,180,120)", text: label ?? "Connected" },
    needs_setup: { dot: "var(--c-ghost)", text: label ?? "Not connected" },
    error: { dot: "rgb(248,113,113)", text: label ?? "Error" },
    testing: { dot: "rgb(234,179,8)", text: label ?? "Testing…", pulse: true },
  };
  const c = palette[status];
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 7,
        fontSize: 12,
        fontWeight: 500,
        color: "var(--c-med)",
        whiteSpace: "nowrap",
      }}
    >
      <span
        style={{
          width: 7,
          height: 7,
          borderRadius: "50%",
          background: c.dot,
          flexShrink: 0,
          animation: c.pulse ? "thinking-wave 1.4s ease-in-out infinite" : undefined,
        }}
      />
      {c.text}
    </span>
  );
}
