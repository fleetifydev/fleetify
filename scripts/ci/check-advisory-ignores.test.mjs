/**
 * osv-scanner.toml tells OSV, and the OpenSSF Scorecard through it, which
 * advisories don't affect Fleetify. Each of them must be one that deny.toml,
 * the cargo-deny gate, already ignores with its triage, so the two files
 * stay one decision:
 *
 * - everything osv-scanner.toml ignores is triaged in deny.toml, with a reason;
 * - everything deny.toml ignores is ignored for OSV too, or listed in
 *   COUNTED: advisories that may affect the app and stay counted until their
 *   fix lands;
 * - an ignore whose deny.toml reason names an end date ends then for OSV too.
 *
 *   node --test scripts/ci/check-advisory-ignores.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

/** Advisories deny.toml ignores that OSV keeps counting: they may affect the app, and their fix is pending. */
const COUNTED = [];

/** deny.toml's `[advisories] ignore` entries. */
function denyIgnores() {
  const text = read("deny.toml");
  const start = text.indexOf("[advisories]");
  const end = text.indexOf("\n[", start + 1);
  const block = text.slice(start, end === -1 ? undefined : end);
  return [...block.matchAll(/\{\s*id\s*=\s*"([^"]+)"\s*,\s*reason\s*=\s*"([^"]*)"/g)].map(([, id, reason]) => ({ id, reason }));
}

/** osv-scanner.toml's `[[IgnoredVulns]]` entries. */
function osvIgnores() {
  return read("osv-scanner.toml")
    .split(/^\[\[IgnoredVulns\]\]\s*$/m)
    .slice(1)
    .map((entry) => ({
      id: entry.match(/^id\s*=\s*"([^"]+)"/m)?.[1],
      reason: entry.match(/^reason\s*=\s*"([^"]*)"/m)?.[1] ?? "",
      until: entry.match(/^ignoreUntil\s*=\s*(\d{4}-\d{2}-\d{2})/m)?.[1],
    }));
}

test("deny.toml and osv-scanner.toml both list ignores, so there's something to compare", () => {
  assert.ok(denyIgnores().length > 0, "no ignores parsed from deny.toml");
  assert.ok(osvIgnores().length > 0, "no ignores parsed from osv-scanner.toml");
});

test("osv-scanner.toml ignores only advisories deny.toml has triaged, each with a reason", () => {
  const triaged = new Set(denyIgnores().map(({ id }) => id));
  for (const { id, reason } of osvIgnores()) {
    assert.ok(id, "an [[IgnoredVulns]] entry has no id");
    assert.ok(triaged.has(id), `${id} is ignored for OSV but not triaged in deny.toml`);
    assert.ok(reason.trim().length >= 30, `${id} needs a reason saying why it doesn't affect the app`);
  }
});

test("every advisory deny.toml ignores is ignored for OSV, or deliberately still counted", () => {
  const ignored = new Set(osvIgnores().map(({ id }) => id));
  const missing = denyIgnores()
    .map(({ id }) => id)
    .filter((id) => !ignored.has(id) && !COUNTED.includes(id));
  assert.deepEqual(missing, [], `add these to osv-scanner.toml, or to COUNTED if they may affect the app: ${missing.join(", ")}`);
  for (const id of COUNTED) assert.ok(!ignored.has(id), `${id} is in COUNTED but osv-scanner.toml ignores it`);
});

test("an ignore whose deny.toml reason names an end date ends on that date for OSV", () => {
  const osv = new Map(osvIgnores().map((entry) => [entry.id, entry]));
  for (const { id, reason } of denyIgnores()) {
    const date = reason.match(/\b(\d{4}-\d{2}-\d{2})\b/)?.[1];
    if (!date || !osv.has(id)) continue;
    assert.equal(osv.get(id).until, date, `${id}: deny.toml's reason ends it on ${date}, so osv-scanner.toml's ignoreUntil should too`);
  }
});
