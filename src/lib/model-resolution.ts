/** Pure model-selection resolver shared by every selection point.
 *  - empty `available` ⇒ "unverified" (fail-open) unless the caller asserts the
 *    provider genuinely has zero models (`providerKnownEmpty`) ⇒ "missing".
 *  - persisted id present in `available` ⇒ "ok".
 *  - otherwise heal to the flagged default, else the first model ⇒ "healed". */
export type ModelResolution = { status: "ok" | "healed" | "missing" | "unverified"; model: string };

export function resolveSessionModel(
  persisted: string | null | undefined,
  available: { id: string; default?: boolean }[],
  opts: { providerKnownEmpty?: boolean } = {},
): ModelResolution {
  const id = persisted ?? "";
  if (available.length === 0) {
    return { status: opts.providerKnownEmpty ? "missing" : "unverified", model: id };
  }
  if (id && available.some((m) => m.id === id)) return { status: "ok", model: id };
  // `available` is non-empty here (the length-0 case returned above), so
  // `available[0]` is defined; assert it past `noUncheckedIndexedAccess`.
  const def = available.find((m) => m.default) ?? available[0]!;
  return { status: "healed", model: def.id };
}

/** The in-chat error to show when a send must be blocked, or null to proceed.
 *  Only "missing" (provider known + connected but no model to heal to) blocks;
 *  "healed" is silent (the caller persists + proceeds) and ok/unverified
 *  proceed unchanged (fail-open — never block a legitimate send). */
export function sendBlockMessage(r: ModelResolution): string | null {
  return r.status === "missing"
    ? "This model is no longer available, and this provider has no model to fall back to. Pick a model to continue."
    : null;
}
