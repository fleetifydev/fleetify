/**
 * Checks for the workspace's clippy.toml, which every crate reads.
 *
 * On Windows, a console program the app starts opens a console window of its
 * own unless it is started with CREATE_NO_WINDOW, which the constructors in
 * fleetify_core::process pass. clippy.toml disallows the raw constructors, so
 * CI's clippy step fails on a child process started any other way. These
 * checks keep both disallowed, each with a reason that names a constructor
 * that exists.
 *
 *   node --test scripts/ci/check-clippy-config.test.mjs
 *
 * The repo takes no dependency for a test, and TOML 1.0 keeps an inline table
 * on one line, so the disallowed-methods array is read line by line.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** Each method clippy.toml must disallow, and the constructor its reason must name. */
const DISALLOWED = {
  "std::process::Command::new": "fleetify_core::process::command",
  "tokio::process::Command::new": "fleetify_core::process::tokio_command",
};

/** The file that defines the constructors, relative to the repo root. */
const PROCESS_RS = "crates/fleetify-core/src/process.rs";

/**
 * The entries of the `disallowed-methods` array in clippy.toml's text, as a map
 * from each path to its reason ("" for an entry without one).
 */
function disallowedMethods(text) {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => /^disallowed-methods\s*=\s*\[\s*$/.test(line));
  assert.notEqual(start, -1, "clippy.toml has no multi-line disallowed-methods array");
  const entries = new Map();
  for (const line of lines.slice(start + 1)) {
    const entry = line.trim();
    if (entry === "]") return entries;
    if (entry === "" || entry.startsWith("#")) continue;
    const bare = entry.match(/^"([^"]*)",?$/);
    const path = bare?.[1] ?? entry.match(/^\{.*\bpath\s*=\s*"([^"]*)"/)?.[1];
    assert.ok(path, `can't read this disallowed-methods entry: ${entry}`);
    entries.set(path, entry.match(/\breason\s*=\s*"([^"]*)"/)?.[1] ?? "");
  }
  assert.fail("clippy.toml's disallowed-methods array isn't closed");
}

test("clippy.toml disallows the raw process constructors, naming their replacements", () => {
  const entries = disallowedMethods(readFileSync(join(ROOT, "clippy.toml"), "utf8"));
  for (const [path, constructor] of Object.entries(DISALLOWED)) {
    assert.ok(entries.has(path), `clippy.toml doesn't disallow ${path}`);
    assert.ok(
      entries.get(path).includes(constructor),
      `the reason for ${path} doesn't name ${constructor}: "${entries.get(path)}"`,
    );
  }
});

test("the constructors the reasons name exist", () => {
  const source = readFileSync(join(ROOT, PROCESS_RS), "utf8");
  for (const constructor of Object.values(DISALLOWED)) {
    const name = constructor.split("::").at(-1);
    assert.match(
      source,
      new RegExp(`^pub fn ${name}\\(`, "m"),
      `${PROCESS_RS} defines no public ${name}()`,
    );
  }
});
