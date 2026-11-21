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
 * No Tauri config in src-tauri may set a dangerous* key, such as the
 * updater's dangerousInsecureTransportProtocol. A release build merges
 * tauri.release.conf.json, and Tauri merges a platform's own config, into
 * tauri.conf.json, whose updater settings the shell's Rust tests check
 * (src-tauri/src/shell/updater.rs). Those overlays must leave the updater
 * alone, or a release would ship an updater the tests never saw.
 *
 * The Tauri CLI also reads a config in JSON5 (tauri.conf.json5) or TOML
 * (Tauri.toml), and their platform variants. The release config is JSON
 * alone, which these checks read, so neither kind may appear in src-tauri.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

/** A repo file's text, by its path from the repo root. */
const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

describe("release config", () => {
  test("tauri.conf.json is formatted the way release-please writes it", () => {
    // A Windows checkout may turn LF into CRLF; the committed file is LF.
    const text = read("src-tauri/tauri.conf.json").replace(/\r\n/g, "\n");
    assert.equal(JSON.stringify(JSON.parse(text), null, 2) + "\n", text);
  });

  test("no Tauri config sets a dangerous* key, and no overlay changes the shipped updater settings", () => {
    const names = readdirSync(new URL("../../src-tauri/", import.meta.url))
      .filter((name) => /^tauri.*\.conf\.json$/.test(name))
      .sort();
    assert.ok(names.includes("tauri.conf.json") && names.includes("tauri.release.conf.json"), `src-tauri holds ${names.join(", ")}`);
    const problems = [];
    for (const name of names) {
      const config = JSON.parse(read(`src-tauri/${name}`));
      const walk = (value, path) => {
        if (value === null || typeof value !== "object") return;
        for (const [key, child] of Object.entries(value)) {
          // dangerousInsecureTransportProtocol and its kin, also in kebab case.
          if (/^dangerous/i.test(key)) problems.push(`${name} sets ${path}${key}`);
          walk(child, `${path}${key}.`);
        }
      };
      walk(config, "");
      if (name !== "tauri.conf.json" && config.plugins?.updater !== undefined) {
        problems.push(`${name} changes the shipped updater settings (plugins.updater)`);
      }
    }
    assert.deepEqual(problems, [], problems.join("\n"));
  });

  test("src-tauri holds no Tauri config in JSON5 or TOML, which the check above doesn't read", () => {
    const others = readdirSync(new URL("../../src-tauri/", import.meta.url))
      .filter((name) => /^tauri.*\.conf\.json5$/i.test(name) || /^tauri.*\.toml$/i.test(name))
      .sort();
    assert.deepEqual(others, [], `src-tauri holds ${others.join(", ")}`);
  });
});
