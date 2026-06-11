/** Session-level reasoning-effort vocabulary: `low · medium · high · extra_high
 *  · max`. The capability layer speaks `xhigh`; this is the picker/session
 *  spelling (see docs/EFFORTS.md). */
export type Effort = "low" | "medium" | "high" | "extra_high" | "max";

/** Full, human-readable effort labels shown in the composer / session-toolbar /
 *  routine model chips. Deliberately NOT abbreviated (was "Med" / "X-Hi", which
 *  read as truncated) — the chips grow to fit so the selected effort always
 *  shows in full. Single source of truth for all three chips. */
export const EFFORT_LABELS: Record<Effort, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  extra_high: "Extra high",
  max: "Max",
};

/** Full label for a session effort id, falling back to the raw id if unknown. */
export const effortLabel = (effort: Effort): string => EFFORT_LABELS[effort] ?? effort;
