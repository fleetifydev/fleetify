/** Walking Fleet's tree from the keyboard, the way a game moves a cursor:
 *  predictable, never a surprise. The tree has the hub in the middle and two
 *  sides, each a list read top to bottom (a project's label, its cards, its
 *  sub-agents, its folded finished ones).
 *
 *  - Up and Down walk the list of the side you are on; Up from its top goes to the hub.
 *  - Left and Right cross over the hub to the other side, landing level with
 *    where you were; outward (away from the hub) does nothing.
 *  - From the hub, Left and Right enter that side at its top, Down enters the
 *    left side (or the right one if the left is empty). */
import type { Placed, Side } from "./roots-layout";

export type Dir = "up" | "down" | "left" | "right";

export interface NavMap {
  hub: string;
  left: string[];
  right: string[];
  /** each node's vertical middle, for landing level when crossing over */
  y: Record<string, number>;
}

/** The two sides' reading order from a laid-out tree. */
export function navMap(
  hub: string,
  columns: { project: string; rows: { id: string }[]; folded: boolean; merged: boolean }[],
  L: { hub: Placed; heads: Record<string, Placed>; rows: Record<string, Placed>; folds: Record<string, Placed>; sides: Record<string, Side> },
): NavMap {
  const map: NavMap = { hub, left: [], right: [], y: { [hub]: L.hub.y + L.hub.h / 2 } };
  const mid = (b: Placed) => b.y + Math.min(b.h, 120) / 2;
  for (const c of columns) {
    const side = L.sides[c.project] ?? "right";
    const list = map[side];
    const head = L.heads[c.project];
    if (head && !c.merged) { list.push(`head:${c.project}`); map.y[`head:${c.project}`] = mid(head); }
    for (const r of c.rows) {
      const b = L.rows[r.id];
      if (b) { list.push(`s:${r.id}`); map.y[`s:${r.id}`] = mid(b); }
    }
    const fold = L.folds[c.project];
    if (fold && c.folded) { list.push(`fold:${c.project}`); map.y[`fold:${c.project}`] = mid(fold); }
  }
  // each side in the order it reads on screen
  for (const side of ["left", "right"] as const) map[side].sort((a, b) => map.y[a]! - map.y[b]!);
  return map;
}

/** Where a key takes the cursor from `cur`; null when it stays. */
export function navigate(cur: string | null, dir: Dir, m: NavMap): string | null {
  const nearest = (list: string[], y: number) => list.reduce<string | null>((best, id) => (best === null || Math.abs(m.y[id]! - y) < Math.abs(m.y[best]! - y) ? id : best), null);
  if (!cur || cur === m.hub || (!m.left.includes(cur) && !m.right.includes(cur))) {
    if (dir === "left") return m.left[0] ?? null;
    if (dir === "right") return m.right[0] ?? null;
    if (dir === "down") return m.left[0] ?? m.right[0] ?? null;
    return cur && cur !== m.hub ? m.hub : null;
  }
  const side: Side = m.left.includes(cur) ? "left" : "right";
  const list = m[side], i = list.indexOf(cur);
  if (dir === "up") return i > 0 ? list[i - 1]! : m.hub;
  if (dir === "down") return i < list.length - 1 ? list[i + 1]! : null;
  // toward the hub crosses to the other side, level with here; outward stays
  const toward = side === "left" ? "right" : "left";
  if (dir !== toward) return null;
  const other = m[toward];
  return other.length ? nearest(other, m.y[cur]!) : m.hub;
}
