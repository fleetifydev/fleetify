/**
 * Fleetify logo mark.
 *
 * Three left-anchored horizontal bars of descending widths, each
 * with rounded caps. Read in two ways at once:
 *
 *   1. **F monogram** — the left edge anchors the three strokes,
 *      forming a stylized "F" for Fleetify. Survives at 16px.
 *   2. **Stack / hierarchy** — descending widths read as
 *      "primary > secondary > tertiary", matching Fleet's vision
 *      of a single orchestrator above a fleet of agents.
 *
 * Tuned to a 24×24 viewBox. Bars are independently scalable
 * rectangles (not strokes) so the rounding stays crisp at every
 * size and the mark looks identical on retina + 1×.
 *
 * Replaces the previous three-chevron "rank insignia" mark, which
 * read as generic "level up" rather than something brand-specific.
 */
import type { CSSProperties } from "react";

export interface LogoMarkProps {
  size?: number;
  /** Fill color. Defaults to currentColor so the mark inherits the
   *  surrounding text color in a lockup. */
  color?: string;
  /** Per-bar opacities. Defaults to [1, 0.85, 0.7] — a gentle
   *  tonal step so the hierarchy reads without losing legibility. */
  opacities?: [number, number, number];
  className?: string;
  style?: CSSProperties;
  ariaLabel?: string;
  /** Animate the three bars in a staggered top→bottom glow wave (with a
   *  soft halo) — for live/active accents like the "thinking" indicator. */
  glow?: boolean;
}

export function LogoMark({
  size = 18,
  color = "currentColor",
  opacities = [1, 0.85, 0.7],
  className,
  style,
  ariaLabel = "Fleetify logo",
  glow = false,
}: LogoMarkProps) {
  return (
    <svg
      role="img"
      aria-label={ariaLabel}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={[glow ? "logo-glow" : "", className].filter(Boolean).join(" ") || undefined}
      style={{ display: "block", ...style }}
    >
      {/* Top bar — full width. The "F" crossbar; the orchestrator
          tier in the hierarchy read. 18 wide × 3 tall, rounded
          caps so the mark feels premium, not chiseled. */}
      <rect x="3"  y="4"    width="18" height="3" rx="1.5" fill={color} opacity={opacities[0]} />
      {/* Middle bar — ~60% width. The "F" crossbar; the agents
          tier. Aligned to the left edge to keep the F-anchor solid. */}
      <rect x="3"  y="10.5" width="11" height="3" rx="1.5" fill={color} opacity={opacities[1]} />
      {/* Bottom bar — ~33% width. Anchors the F's left rail
          visually and adds a tertiary tonal step. */}
      <rect x="3"  y="17"   width="7"  height="3" rx="1.5" fill={color} opacity={opacities[2]} />
    </svg>
  );
}
