/**
 * Checks for the release configuration.
 *
 *   node --test scripts/release/release-config.test.mjs
 *
 * release-please bumps the version in src-tauri/tauri.conf.json and writes
 * the file back through JSON.stringify. Kept in JSON.stringify(…, null, 2)
 * form with a final newline, the file then changes only in its version line
 * in each release PR, rather than being reformatted.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/** A repo file's text, by its path from the repo root. */
const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

describe("release config", () => {
  test("tauri.conf.json is formatted the way release-please writes it", () => {
    // A Windows checkout may turn LF into CRLF; the committed file is LF.
    const text = read("src-tauri/tauri.conf.json").replace(/\r\n/g, "\n");
    assert.equal(JSON.stringify(JSON.parse(text), null, 2) + "\n", text);
  });
});
