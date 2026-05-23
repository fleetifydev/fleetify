/**
 * Slim horizontal bar that surfaces the currently active Decision Router +
 * Proxy Gateway. Rendered beneath the message composer in Fleet Hub and
 * the New Session screen so the user knows which router will handle the
 * outgoing prompt.
 *
 * Layout: two compact chips side-by-side. Each chip shows the router's
 * display name. Hovering surfaces a tooltip describing what that slot
 * does. When intelligent routing is disabled the bar collapses to a
 * single muted line ("Routing off — manual selection") so the user can
 * still see at a glance that routing isn't active.
 */
import { useRouterConfig } from "@/hooks/use-router-config";

interface Props {
  /** Optional override for left/right alignment. Default: aligned to the
   *  composer (no left offset, full width). Pass `compact` when the bar
   *  needs to fit in a tight layout (e.g. inside the new-session modal). */
  compact?: boolean;
}

const barStyle = (compact?: boolean): React.CSSProperties => ({
  display: "flex",
  alignItems: "center",
  gap: 10,
  flexWrap: "wrap",
  padding: compact ? "4px 0 0 0" : "6px 4px 0 4px",
  fontSize: 11,
  color: "var(--c-dim)",
  lineHeight: 1.5,
});

const chipStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "3px 8px",
  borderRadius: 5,
  background: "var(--c-srf2)",
  border: "1px solid var(--c-brd)",
  color: "var(--c-high)",
  fontWeight: 500,
};

const labelStyle: React.CSSProperties = {
  fontSize: 10.5,
  textTransform: "uppercase",
  letterSpacing: 0.4,
  color: "var(--c-low)",
};

export function RoutersStatusBar({ compact }: Props) {
  const { tiles, masterEnabled, loading } = useRouterConfig();
  if (loading) return null;

  const decisionTile =
    tiles.find((t) => t.active_for_decision) ??
    tiles.find((t) => t.id === "builtin");
  const proxyTile =
    tiles.find((t) => t.active_for_proxy) ??
    tiles.find((t) => t.id === "none-proxy");

  if (!masterEnabled) {
    return (
      <div
        data-testid="routers-status-bar"
        style={{ ...barStyle(compact), opacity: 0.7 }}
      >
        <span>Routing off — using manual agent selection</span>
      </div>
    );
  }

  return (
    <div data-testid="routers-status-bar" style={barStyle(compact)}>
      <span style={labelStyle}>Routing</span>
      <span
        style={chipStyle}
        title={`Decision router for new sessions. Change in Settings → Routers.`}
        data-testid="routers-status-decision"
      >
        {decisionTile?.display_name ?? "Built-in (Fleetify)"}
      </span>
      <span style={labelStyle}>via</span>
      <span
        style={chipStyle}
        title={`Proxy gateway for outbound LLM requests.`}
        data-testid="routers-status-proxy"
      >
        {proxyTile?.display_name ?? "None / Direct"}
      </span>
    </div>
  );
}
