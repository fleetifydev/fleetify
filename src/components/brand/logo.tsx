/**
 * Fleetify logo — canonical mark + wordmark lockup.
 *
 * Use this in headers, splash screens, onboarding. For the mark or
 * wordmark alone, import `<LogoMark>` or `<Wordmark>` directly.
 *
 * The lockup is the chevron-stack mark on the left + bold Geist
 * wordmark on the right, separated by a size-proportional gap. The
 * `accent` / `active` props that lived on the previous solid-disc
 * mark are gone — the chevron stack carries its tonal life via its
 * built-in opacity gradient, no animation needed.
 */
import type { CSSProperties } from "react";
import { LogoMark } from "./logo-mark";
import { Wordmark, type WordmarkProps } from "./wordmark";

export interface LogoProps {
  /** Overall size of the lockup. */
  size?: WordmarkProps["size"];
  /** Tint applied to both mark and wordmark. */
  color?: string;
  /** Letter-spacing for the wordmark. */
  tracking?: string;
  /** className passthrough (use for `no-drag` in title bars, etc). */
  className?: string;
  style?: CSSProperties;
  ariaLabel?: string;
}

const MARK_PIXELS: Record<NonNullable<WordmarkProps["size"]>, number> = {
  xs: 14,
  sm: 17,
  md: 22,
  lg: 30,
  xl: 46,
};

const GAP_PIXELS: Record<NonNullable<WordmarkProps["size"]>, number> = {
  xs: 6,
  sm: 8,
  md: 10,
  lg: 13,
  xl: 18,
};

export function Logo({
  size = "md",
  color,
  tracking,
  className,
  style,
  ariaLabel = "Fleetify",
}: LogoProps) {
  return (
    <span
      aria-label={ariaLabel}
      className={className}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: GAP_PIXELS[size],
        color: color ?? "inherit",
        ...style,
      }}
    >
      <LogoMark size={MARK_PIXELS[size]} color="currentColor" ariaLabel=""/>
      <Wordmark size={size} color="currentColor" tracking={tracking} ariaLabel=""/>
    </span>
  );
}
