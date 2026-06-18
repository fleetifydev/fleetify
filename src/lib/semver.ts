/** Minimal semver compare for marketplace plugin versions (X.Y.Z[-pre]).
 *  Pre-release/build metadata is ignored for ordering (rare in the
 *  marketplace). Unparseable input compares as "not greater" so detection
 *  never false-positives an update. */
function parse(v: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function semverGt(a: string, b: string): boolean {
  const pa = parse(a), pb = parse(b);
  if (!pa || !pb) return false;
  for (let i = 0; i < 3; i++) {
    const av = pa[i] ?? 0, bv = pb[i] ?? 0;
    if (av > bv) return true;
    if (av < bv) return false;
  }
  return false;
}

export function isMajorBump(from: string, to: string): boolean {
  const pf = parse(from), pt = parse(to);
  if (!pf || !pt) return false;
  return (pt[0] ?? 0) > (pf[0] ?? 0);
}

/** Strip a leading "v", surrounding brackets, and whitespace so versions
 *  compare cleanly ("[v0.1.0]" → "0.1.0"). Non-semver tokens such as
 *  "Unreleased" pass through trimmed. */
export function normalizeVersion(v: string): string {
  return v.trim().replace(/^\[|\]$/g, "").replace(/^v/i, "").trim();
}

/** True when two version strings denote the same release, ignoring a
 *  leading "v"/brackets. Empty / whitespace inputs never match. */
export function semverEq(a: string, b: string): boolean {
  const na = normalizeVersion(a);
  return na.length > 0 && na === normalizeVersion(b);
}
