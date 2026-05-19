/**
 * Pulse bits — building blocks shared across the right-sidebar Pulse layout.
 *
 *  - Sparkline: tiny inline SVG chart that scales to its container
 *  - bucketCostByHour / bucketToolCallsByMinute: data shapers for the
 *    sparklines, computed entirely client-side from existing store state
 *  - micro typography helpers (kept here so the main panel file stays
 *    focused on layout)
 */
import { CSSProperties } from "react";
import type { ChatMessage } from "@/types/chat";
import type { ProcessEvent } from "@/stores/chat-store";

/* ── <Sparkline> ─────────────────────────────────────────────────── */

export interface SparklineProps {
  /** Series — already bucketed values, equal cadence, oldest → newest. */
  values: number[];
  width?: number;
  height?: number;
  /** Stroke colour for the trend line. Inherits currentColor by default. */
  color?: string;
  /** Optional fill under the line (low alpha). Skip for ultra-minimal look. */
  fill?: string;
  /** Stroke thickness. */
  strokeWidth?: number;
  className?: string;
  style?: CSSProperties;
  ariaLabel?: string;
}

export function Sparkline({
  values,
  width = 80,
  height = 16,
  color = "currentColor",
  fill,
  strokeWidth = 1,
  className,
  style,
  ariaLabel = "trend",
}: SparklineProps) {
  if (!values.length) {
    return (
      <svg
        role="img"
        aria-label={ariaLabel}
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        className={className}
        style={style}
      />
    );
  }

  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const range = max - min || 1;
  const stepX = values.length > 1 ? width / (values.length - 1) : 0;
  const points = values.map((v, i) => {
    const x = i * stepX;
    const y = height - ((v - min) / range) * (height - strokeWidth) - strokeWidth / 2;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });

  // For the fill polygon we need to close the path along the bottom.
  const fillPath = fill
    ? `M ${points[0]} L ${points.join(" ")} L ${width.toFixed(2)},${height} L 0,${height} Z`
    : null;
  const strokePath = `M ${points.join(" L ")}`;

  return (
    <svg
      role="img"
      aria-label={ariaLabel}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      fill="none"
      className={className}
      style={{ overflow: "visible", ...style }}
      preserveAspectRatio="none"
    >
      {fillPath && <path d={fillPath} fill={fill} />}
      <path
        d={strokePath}
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}

/* ── Aggregation helpers ─────────────────────────────────────────── */

/**
 * Bucket per-message cost into N hourly slots covering `now - hours .. now`.
 * Caller passes ChatMessage[] flattened across every session.
 */
export function bucketCostByHour(messages: ChatMessage[], hours = 24): number[] {
  const now = Date.now();
  const slots = new Array<number>(hours).fill(0);
  for (const m of messages) {
    if (typeof m.cost_usd !== "number" || !m.timestamp) continue;
    const ts = new Date(m.timestamp).getTime();
    if (Number.isNaN(ts)) continue;
    const ageH = (now - ts) / 3_600_000;
    if (ageH < 0 || ageH >= hours) continue;
    const idx = hours - 1 - Math.floor(ageH);
    slots[idx] = (slots[idx] ?? 0) + m.cost_usd;
  }
  return slots;
}

/**
 * Bucket per-agent tool-call activity into N minute slots covering the last
 * `minutes` minutes. Each tool-end timestamp counts once into its slot.
 */
export function bucketToolCallsByMinute(log: ProcessEvent[], minutes = 60): number[] {
  const now = Date.now();
  const slots = new Array<number>(minutes).fill(0);
  for (const e of log) {
    const ts = e.endedAt ?? e.startedAt;
    if (!ts) continue;
    const ageM = (now - ts) / 60_000;
    if (ageM < 0 || ageM >= minutes) continue;
    const idx = minutes - 1 - Math.floor(ageM);
    slots[idx] = (slots[idx] ?? 0) + 1;
  }
  return slots;
}

/**
 * Best-effort agent-hours: sum of currently-streaming sessions' uptime since
 * their most recent streamStartTime. This is the only durable signal we have
 * for "time spent under load" — historic uptime would require a new schema.
 */
export function liveAgentHours(streamStarts: Array<number | null | undefined>): number {
  const now = Date.now();
  let totalMs = 0;
  for (const t of streamStarts) {
    if (!t) continue;
    const dt = now - t;
    if (dt > 0) totalMs += dt;
  }
  return totalMs / 3_600_000;
}

/* ── Tiny typography helpers ─────────────────────────────────────── */

/** Section group label — matches the left sidebar's "Pinned / Costco / …". */
export function GroupLabel({ children, count }: { children: React.ReactNode; count?: number }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        padding: "10px 12px 4px",
      }}
    >
      <span
        style={{
          flex: 1,
          fontSize: 10.5,
          fontWeight: 500,
          letterSpacing: "0.01em",
          color: "var(--c-ghost)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {children}
      </span>
      {count != null && (
        <span
          style={{
            fontSize: 10,
            color: "var(--c-ghost)",
            fontWeight: 500,
            flexShrink: 0,
            fontFamily: "var(--font-mono)",
          }}
        >
          {count}
        </span>
      )}
    </div>
  );
}

/** Compact agent-hour formatter — "4h 12m", "53m", "0m". */
export function fmtAgentHours(h: number): string {
  if (h <= 0) return "0m";
  if (h < 1) return `${Math.round(h * 60)}m`;
  const wholeH = Math.floor(h);
  const remM = Math.round((h - wholeH) * 60);
  return remM === 0 ? `${wholeH}h` : `${wholeH}h ${remM}m`;
}

/** Compact token formatter — "1.2k", "17M". */
export function fmtTokensCompact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, "")}k`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0).replace(/\.0$/, "")}M`;
}
