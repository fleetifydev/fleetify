import type { SessionStatus } from "@/types/session";

/** The three orbits of the Fleet map. The closer a ring sits to the core,
 *  the more its sessions need the user: `needs` is the inner ring. */
export type OrbitRing = "needs" | "working" | "done";

/** How many sessions each ring shows before the rest are only counted.
 *  More than this crowds the labels; the sidebar still lists every session. */
export const RING_LIMIT: Record<OrbitRing, number> = { needs: 4, working: 6, done: 5 };

/** The inner ring opens on the left (180°) and spreads around the whole
 *  circle: its first two sessions sit left and right of the core, where their
 *  question cards open below them. */
const NEEDS_START = 180;

/** The middle and outer rings keep clear of those cards: their sessions sit
 *  on the top arc (200°–340°) and the bottom arc (60°–120°) only. */
const OPEN_ARCS: [number, number][] = [[200, 340], [60, 120]];
const OPEN_SPAN = OPEN_ARCS.reduce((a, [from, to]) => a + (to - from), 0);

/** Map a position along the open arcs (0 ≤ t < OPEN_SPAN) to an angle. */
function arcAngle(t: number): number {
  let rest = t;
  for (const [from, to] of OPEN_ARCS) {
    if (rest < to - from) return from + rest;
    rest -= to - from;
  }
  return OPEN_ARCS[0]![0];
}

/** Which ring a session belongs on. A pending permission or question counts
 *  as waiting even before the backend flips the status, and a streaming
 *  session counts as working. */
export function ringFor(status: SessionStatus, hasPending: boolean, isStreaming: boolean): OrbitRing {
  if (status === "waiting" || hasPending) return "needs";
  if (status === "running" || status === "starting" || isStreaming) return "working";
  return "done";
}

export interface OrbitItem {
  id: string;
  ring: OrbitRing;
  /** Last activity, epoch millis. Most recent first within a ring. */
  lastActive: number;
}

export interface OrbitPlacement {
  id: string;
  ring: OrbitRing;
  /** Degrees, 0 = right, clockwise. */
  angle: number;
}

/** Spread each ring's sessions evenly around it, most recent first, up to
 *  {@link RING_LIMIT}. Returns the placements and how many were left off. */
export function layoutOrbits(items: OrbitItem[]): { placed: OrbitPlacement[]; hidden: number } {
  const placed: OrbitPlacement[] = [];
  let hidden = 0;
  for (const ring of ["needs", "working", "done"] as const) {
    const inRing = items.filter(i => i.ring === ring).sort((a, b) => b.lastActive - a.lastActive);
    const shown = inRing.slice(0, RING_LIMIT[ring]);
    hidden += inRing.length - shown.length;
    shown.forEach((item, i) => {
      const angle = ring === "needs"
        ? (NEEDS_START + (i * 360) / shown.length) % 360
        // the outer ring is offset by a quarter step so it doesn't line up with the middle one
        : arcAngle(((i + (ring === "working" ? 0.5 : 0.75)) * OPEN_SPAN) / shown.length);
      placed.push({ id: item.id, ring, angle });
    });
  }
  return { placed, hidden };
}

/** A point on an ellipse centred at (cx, cy), for an angle in degrees. */
export function pointOn(cx: number, cy: number, rx: number, ry: number, angle: number): [number, number] {
  const t = (angle * Math.PI) / 180;
  return [cx + rx * Math.cos(t), cy + ry * Math.sin(t)];
}
