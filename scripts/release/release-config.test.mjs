/**
 * Checks for the release configuration.
 *
 *   node --test scripts/release/release-config.test.mjs
 *
 * release-please bumps the version in src-tauri/tauri.conf.json and writes
 * the file back through JSON.stringify. Kept in JSON.stringify(…, null, 2)
 * form with a final newline, the file then changes only in its version line
 * in each release PR, rather than being reformatted.
 *
 * A release build merges src-tauri/tauri.release.conf.json into
 * tauri.conf.json, whose updater settings the shell's Rust tests check
 * (src-tauri/src/shell/updater.rs). The overlay must leave those settings
 * alone, or a release would ship an updater those tests never saw.
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

  test("the release overlay sets no dangerous* key and leaves the updater as tauri.conf.json ships it", () => {
    const overlay = JSON.parse(read("src-tauri/tauri.release.conf.json"));
    const dangerous = [];
    const walk = (value, path) => {
      if (value === null || typeof value !== "object") return;
      for (const [key, child] of Object.entries(value)) {
        // dangerousInsecureTransportProtocol and its kin, also in kebab case.
        if (/^dangerous/i.test(key)) dangerous.push(`${path}${key}`);
        walk(child, `${path}${key}.`);
      }
    };
    walk(overlay, "");
    assert.deepEqual(dangerous, [], "tauri.release.conf.json sets these dangerous* keys");
    assert.equal(overlay.plugins?.updater, undefined, "tauri.release.conf.json changes the shipped updater settings");
  });
});
