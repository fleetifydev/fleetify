/** Catalog-change healing — "the model you had selected is gone; take the
 *  provider's default instead".
 *
 *  The remote catalog can retire a model (`Opus 5` removed, `Opus 6` added)
 *  while the app is open. Every surface holding a selected model then points at
 *  an id the provider will reject: the running session, the new-session
 *  composer, and the Fleet screen (whose model IS the staff session's). Send
 *  time already resolves this per-session, but that's too late — the user reads
 *  the chip long before they send, and Fleet dispatches without one.
 *
 *  This module is the pure planner: given the surfaces and the freshly
 *  discovered lineup, it returns the writes to apply. Keeping it pure means the
 *  rule that decides whether someone's explicit pick gets overwritten is
 *  unit-testable in isolation — it is the part that must never misfire.
 *
 *  Fail-open is the governing rule: a provider we couldn't discover yields NO
 *  decision, so a transient catalog outage can't silently reset the fleet's
 *  model selections. Only a provider with a known, non-empty lineup that does
 *  not contain the selected id produces a heal. */
import { resolveSessionModel } from "@/lib/model-resolution";

/** One selectable surface. `id` is the session row for `kind: "session"` (the
 *  Fleet screen is just the staff session); the composer has no id yet. */
export type HealTarget = {
  kind: "session" | "composer";
  id?: string;
  /** Provider/agent id the surface dispatches to — the lineup key. */
  tool: string;
  model: string | null;
};

export type HealDecision = { target: HealTarget; nextModel: string };

/** Discovered lineups keyed by provider/agent id. Entries carry the picker's
 *  shape; only `id` / `default` / `active` matter here. */
export type DiscoveredLineups = Record<
  string,
  { id: string; default?: boolean; active?: boolean }[]
>;

/** Fleet's "Auto" pseudo-provider routes server-side — its `model_name` isn't a
 *  user pick against a catalog lineup, so healing it would fight the router. */
const ROUTED_PROVIDERS = new Set(["auto"]);

export function planModelHeal(
  targets: readonly HealTarget[],
  lineups: DiscoveredLineups,
): HealDecision[] {
  const out: HealDecision[] = [];
  for (const target of targets) {
    if (ROUTED_PROVIDERS.has(target.tool)) continue;
    const available = lineups[target.tool];
    // Undiscovered or empty ⇒ fail open. `providerKnownEmpty` is deliberately
    // NOT asserted: we can't tell "provider has no models" from "we couldn't
    // reach the catalog", and only the first justifies touching a user's pick.
    if (!available || available.length === 0) continue;
    const r = resolveSessionModel(target.model, available);
    if (r.status !== "healed" || r.model === target.model) continue;
    out.push({ target, nextModel: r.model });
  }
  return out;
}
