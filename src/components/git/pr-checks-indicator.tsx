/**
 * PrChecksIndicator — compact CI status ring for the BranchStrip merge cluster.
 *
 * A small progress ring whose arc fills with the fraction of checks that have
 * finished (passing + failing) and whose colour reads the overall outcome:
 * **red** when anything failed, otherwise a **calm muted** tone (the app's
 * design language avoids a loud success green — see globals `--c-*`). While
 * checks are still running the whole ring **pulses** (the "progress" cue).
 * Clicking it toggles the per-check details popover.
 *
 * Renders nothing when the PR has no checks (`total === 0`) so repos without
 * CI keep the strip clean.
 */
import type { CSSProperties } from "react";

export type ChecksSummary = {
  passing: number;
  failing: number;
  pending: number;
  total: number;
};

interface Props {
  checks: ChecksSummary;
  /** Highlight state while the details popover is open. */
  open?: boolean;
  onClick?: () => void;
}

const SIZE = 15;
const STROKE = 2;
const R = (SIZE - STROKE) / 2; // radius so the stroke stays inside the box
const C = 2 * Math.PI * R; // circumference

export function PrChecksIndicator({ checks, open = false, onClick }: Props) {
  const { passing, failing, pending, total } = checks;
  if (total <= 0) return null; // no CI → no indicator

  const completed = passing + failing;
  const frac = Math.max(0, Math.min(1, completed / total));
  // Outcome colour, matching the popover's icons: red on any failure, muted
  // while still running (the pulse carries the "in progress" cue), green once
  // everything has passed.
  const color = failing > 0 ? "var(--c-err)" : pending > 0 ? "var(--c-med)" : "rgb(64,180,120)";
  const isPending = pending > 0 && failing === 0;

  const label =
    `CI checks: ${passing} passed` +
    (failing ? `, ${failing} failing` : "") +
    (pending ? `, ${pending} running` : "");

  const wrapStyle: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: SIZE + 7,
    height: SIZE + 7,
    borderRadius: 999,
    cursor: onClick ? "pointer" : "default",
    background: open ? "var(--c-ghost)" : "transparent",
    border: "none",
    padding: 0,
    transition: "background 120ms ease",
  };

  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-expanded={open}
      data-testid="pr-checks-ring"
      style={wrapStyle}
    >
      <svg
        width={SIZE}
        height={SIZE}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        style={isPending ? { animation: "fleetPulse 1.4s ease-in-out infinite" } : undefined}
      >
        {/* faint full-circle track */}
        <circle
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={R}
          fill="none"
          stroke="var(--c-brd)"
          strokeWidth={STROKE}
          opacity={0.55}
        />
        {/* progress arc — completed / total, starting at 12 o'clock */}
        <circle
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={R}
          fill="none"
          stroke={color}
          strokeWidth={STROKE}
          strokeLinecap="round"
          strokeDasharray={C}
          strokeDashoffset={C * (1 - frac)}
          transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
        />
      </svg>
    </button>
  );
}
