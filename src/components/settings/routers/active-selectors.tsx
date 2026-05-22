/**
 * Active selectors summary — shows the current decision + proxy routers.
 *
 * Reads the tiles array from useRouterConfig and finds whichever entries
 * have `active_for_decision` / `active_for_proxy` set. When the same
 * router id is active for BOTH categories, surfaces the same-service hint
 * so the user knows there's no extra network hop in that configuration.
 */
import type { RouterTile } from "@/lib/routers-api";

interface Props {
  tiles: RouterTile[];
}

const boxStyle: React.CSSProperties = {
  border: "1px solid var(--c-brd)",
  borderRadius: 10,
  background: "var(--card)",
  padding: "12px 16px",
  display: "flex",
  flexDirection: "column",
  gap: 4,
};

const labelStyle: React.CSSProperties = {
  fontSize: 12.5,
  color: "var(--c-low)",
  lineHeight: 1.5,
};

const strongStyle: React.CSSProperties = {
  color: "var(--c-high)",
  fontWeight: 600,
};

export function ActiveSelectors({ tiles }: Props) {
  const dec = tiles.find((t) => t.active_for_decision);
  const prx = tiles.find((t) => t.active_for_proxy);
  const sameService = !!dec && !!prx && dec.id === prx.id;
  return (
    <div data-testid="router-active-selectors" style={boxStyle}>
      <div style={labelStyle}>
        Decision:{" "}
        <span style={strongStyle}>
          {dec?.display_name ?? "Built-in (Fleetify)"}
        </span>
      </div>
      <div style={labelStyle}>
        Proxy:{" "}
        <span style={strongStyle}>
          {prx?.display_name ?? "None / Direct"}
        </span>
      </div>
      {sameService && (
        <div
          style={{
            fontSize: 11.5,
            color: "var(--c-dim)",
            marginTop: 4,
            lineHeight: 1.5,
          }}
        >
          Decisions are made in-line — no extra network hop.
        </div>
      )}
    </div>
  );
}
