/**
 * Pure-string predicates and parsers shared by every OS branch of
 * `wipe.mjs`'s keychain step. Split out so they're unit-testable
 * without spawning real `cmdkey` / `security` / `secret-tool`.
 *
 * The shared rule: a credential target belongs to Fleetify iff its
 * service name (sans wrapper prefix) is exactly `Fleetify` OR starts
 * with `Fleetify` followed by one of `-`, `/`, or ` `. Catches every
 * current namespace (`Fleetify`, `Fleetify-GitHub`,
 * `Fleetify-Provider-<id>`, `Fleetify/<user>`) and any future
 * `Fleetify-*` namespace without a wipe.mjs edit. Substring matches
 * like `NotFleetify` are rejected.
 */

export function stripLegacyGenericPrefix(target) {
  return String(target).replace(/^LegacyGeneric:target=/i, "");
}

export function isFleetifyKeychainTarget(name) {
  const bare = stripLegacyGenericPrefix(name);
  if (bare === "Fleetify") return true;
  return /^Fleetify(?=[-/ ])/.test(bare);
}

export function parseMacKeychainDump(text) {
  const seen = new Set();
  const out = [];
  const re = /"svce"<blob>="([^"]*)"/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const name = m[1];
    if (!isFleetifyKeychainTarget(name)) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

export function parseSecretToolDump(text) {
  const seen = new Set();
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*attribute\.service\s*=\s*(.+?)\s*$/);
    if (!m) continue;
    const name = m[1];
    if (!isFleetifyKeychainTarget(name)) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}
