// Tests for retry-dmg.sh: it reruns a command only when hdiutil's output
// shows one of its passing errors, at most RETRY_DMG_ATTEMPTS times, and
// exits with the command's status.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "retry-dmg.sh");
const skip = process.platform === "win32" && "bash scripts run on macOS and Linux here";

/**
 * Run retry-dmg.sh around a fake command that fails `failures` times with
 * `failure` on stderr and exit status `status`, then succeeds. Returns the
 * script's result and how many times the command ran.
 */
function run({ failures, failure, status = 1, attempts = 3 }) {
  const dir = mkdtempSync(join(tmpdir(), "retry-dmg-"));
  try {
    const count = join(dir, "count");
    writeFileSync(count, "0");
    const fake = join(dir, "fake.sh");
    writeFileSync(
      fake,
      [
        "#!/usr/bin/env bash",
        `n=$(( $(cat "${count}") + 1 ))`,
        `echo "$n" > "${count}"`,
        `if [ "$n" -le ${failures} ]; then echo ${JSON.stringify(failure)} >&2; exit ${status}; fi`,
        "echo bundled",
      ].join("\n"),
    );
    const result = spawnSync("bash", [SCRIPT, "bash", fake], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, RETRY_DMG_DELAY_S: "0", RETRY_DMG_ATTEMPTS: String(attempts) },
    });
    return { ...result, runs: Number(readFileSync(count, "utf8").trim()) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("retry-dmg.sh", { skip }, () => {
  test("a command that succeeds runs once", () => {
    const result = run({ failures: 0, failure: "" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.runs, 1);
    assert.match(result.stdout, /bundled/);
  });

  for (const failure of [
    "hdiutil: create failed - Resource busy",
    "hdiutil: couldn't eject \"disk4\" - Resource busy",
    "hdiutil: couldn't unmount \"disk4\" - Resource busy",
    "hdiutil: detach failed - couldn't eject",
  ]) {
    test(`it runs again after "${failure}"`, () => {
      const result = run({ failures: 2, failure });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.equal(result.runs, 3);
      assert.match(result.stdout, /attempt 1 of 3/);
      assert.match(result.stdout, /attempt 2 of 3/);
    });
  }

  test("it gives up after the last attempt, with the command's status", () => {
    const result = run({ failures: 5, failure: "hdiutil: create failed - Resource busy", status: 7 });
    assert.equal(result.status, 7);
    assert.equal(result.runs, 3);
    assert.match(result.stdout, /::error::hdiutil failed in each of 3 attempts/);
  });

  test("any other failure ends it at once", () => {
    for (const failure of ["error: codesign failed", "hdiutil: attach failed - no mountable file systems", "failed to bundle project"]) {
      const result = run({ failures: 5, failure, status: 3 });
      assert.equal(result.status, 3, failure);
      assert.equal(result.runs, 1, failure);
    }
  });

  test("with no command it is a usage error", () => {
    const result = spawnSync("bash", [SCRIPT], { encoding: "utf8" });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /usage/);
  });
});
