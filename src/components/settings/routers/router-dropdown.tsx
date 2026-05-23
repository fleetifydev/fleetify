/**
 * Native <select> styled to match the rest of the Settings surface.
 * Used by routers-section for the Decision Router and Proxy Gateway
 * dropdowns. Options are the routers that advertise the matching
 * capability ("decision" or "proxy").
 *
 * Each option label carries a small status hint: "✓ connected" once
 * the router has a stored secret, "needs setup" otherwise (so the
 * user knows picking it will open the config panel).
 */
import type { RouterTile } from "@/lib/routers-api";

interface Props {
  label: string;
  testId: string;
  options: RouterTile[];
  value: string;
  onChange: (id: string) => void;
}

const wrapStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
};

const labelStyle: React.CSSProperties = {
  fontSize: 12,
  color: "var(--c-low)",
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: 0.4,
};

const selectStyle: React.CSSProperties = {
  appearance: "none",
  WebkitAppearance: "none",
  MozAppearance: "none",
  width: "100%",
  padding: "9px 32px 9px 12px",
  background:
    "var(--card) url('data:image/svg+xml;utf8,<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"10\" height=\"6\" viewBox=\"0 0 10 6\"><path fill=\"%23888\" d=\"M0 0l5 6 5-6z\"/></svg>') no-repeat right 12px center",
  border: "1px solid var(--c-brd)",
  borderRadius: 8,
  fontSize: 13,
  color: "var(--c-high)",
  fontFamily: "inherit",
  cursor: "pointer",
  outline: "none",
};

export function RouterDropdown({
  label,
  testId,
  options,
  value,
  onChange,
}: Props) {
  return (
    <div style={wrapStyle}>
      <label htmlFor={testId} style={labelStyle}>
        {label}
      </label>
      <select
        id={testId}
        data-testid={testId}
        style={selectStyle}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((opt) => {
          const alwaysAvailable =
            opt.id === "builtin" || opt.id === "none-proxy";
          let hint = "";
          if (!alwaysAvailable) {
            hint = opt.connected ? "  ✓ connected" : "  needs setup";
          }
          return (
            <option key={opt.id} value={opt.id}>
              {opt.display_name}
              {hint}
            </option>
          );
        })}
      </select>
    </div>
  );
}
