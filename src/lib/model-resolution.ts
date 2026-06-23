/** Pure model-selection resolver shared by every selection point.
 *  - empty `available` ⇒ "unverified" (fail-open) unless the caller asserts the
 *    provider genuinely has zero models (`providerKnownEmpty`) ⇒ "missing".
 *  - persisted id present in `available` ⇒ "ok".
 *  - otherwise heal to the flagged default, else the first model ⇒ "healed". */
export type ModelResolution = { status: "ok" | "healed" | "missing" | "unverified"; model: string };

export function resolveSessionModel(
  persisted: string | null | undefined,
  available: { id: string; default?: boolean; active?: boolean }[],
  opts: { providerKnownEmpty?: boolean } = {},
): ModelResolution {
  const id = persisted ?? "";
  // Catalog-retired models (`active: false`) are not selectable: never resolve
  // "ok" onto one, never heal TO one, and heal a session pinned to one AWAY to
  // the provider's default. They stay visible-but-disabled in the picker; this
  // resolver is the gate that keeps a retired model un-dispatchable everywhere
  // selection happens (startup default, session restore, send). Entries with no
  // `active` field (embedded/CLI fallbacks, live probes) are treated as usable.
  const usable = available.filter((m) => m.active !== false);
  if (usable.length === 0) {
    return { status: opts.providerKnownEmpty ? "missing" : "unverified", model: id };
  }
  if (id && usable.some((m) => m.id === id)) return { status: "ok", model: id };
  // `usable` is non-empty here (the length-0 case returned above), so
  // `usable[0]` is defined; assert it past `noUncheckedIndexedAccess`.
  const def = usable.find((m) => m.default) ?? usable[0]!;
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
