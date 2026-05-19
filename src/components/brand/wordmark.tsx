/**
 * Fleetify brand wordmark.
 *
 * Rendered in Geist (Vercel's open-source sans-serif), bold weight.
 * Matches the lockup the founders signed off on — chevron mark + bold
 * geometric sans, NOT the earlier Playfair serif treatment that lived
 * in MEMORY.md. The serif read as too editorial for the product
 * (an AI agent orchestrator); the bold sans is more "tool, in motion".
 *
 * Use anywhere the product name appears (logos, splash, sidebar
 * header, chat empty state). Tracking is set tight (-0.01em) — at
 * Geist Bold sizes, default tracking already reads loose.
 */
import type { CSSProperties } from "react";

export interface WordmarkProps {
  /** Display size variant. */
  size?: "xs" | "sm" | "md" | "lg" | "xl";
  /** Text color (CSS value). Defaults to current foreground. */
  color?: string;
  /** Override letter-spacing if you want a tighter or looser feel. */
  tracking?: string;
  /** className passthrough so callers can use `no-drag` etc. */
  className?: string;
  /** Inline style passthrough. */
  style?: CSSProperties;
  /** ARIA label override (defaults to "Fleetify"). */
  ariaLabel?: string;
}

const SIZE_MAP: Record<NonNullable<WordmarkProps["size"]>, { fontSize: number; weight: number }> = {
  xs: { fontSize: 12, weight: 700 },
  sm: { fontSize: 14, weight: 700 },
  md: { fontSize: 17, weight: 700 },
  lg: { fontSize: 24, weight: 700 },
  xl: { fontSize: 38, weight: 700 },
};

export function Wordmark({
  size = "md",
  color,
  tracking = "-0.01em",  // Geist Bold reads loose at default tracking
  className,
  style,
  ariaLabel = "Fleetify",
}: WordmarkProps) {
  const { fontSize, weight } = SIZE_MAP[size];
  return (
    <span
      aria-label={ariaLabel}
      className={className}
      style={{
        fontFamily: "'Geist Variable', 'Inter', system-ui, sans-serif",
        fontSize,
        fontWeight: weight,
        letterSpacing: tracking,
        color: color ?? "inherit",
        lineHeight: 1,
        display: "inline-block",
        ...style,
      }}
    >
      Fleetify
    </span>
  );
}
