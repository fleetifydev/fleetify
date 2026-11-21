/**
 * Tests for check-artifact.mjs, which checks that a downloaded artifact's
 * folder holds exactly the files a job expects, each a non-empty regular
 * file.
 *
 *   node --test scripts/release/check-artifact.test.mjs
 */
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { checkArtifact } from "./check-artifact.mjs";

const SCRIPT = fileURLToPath(new URL("./check-artifact.mjs", import.meta.url));

const ROOT = mkdtempSync(join(tmpdir(), "check-artifact-"));
after(() => rmSync(ROOT, { recursive: true, force: true }));
let count = 0;

/** A new folder holding `files` (name → text). */
function folder(files = {}) {
  const dir = join(ROOT, `artifact-${(count += 1)}`);
  mkdirSync(dir);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

const cli = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });

describe("checkArtifact", () => {
  test("exactly the expected files, each non-empty: no problems", () => {
    assert.deepEqual(checkArtifact(folder({ "a.deb": "deb", "b.rpm": "rpm" }), ["a.deb", "b.rpm"]), []);
  });

  test("a missing file, an unexpected file and an unexpected folder are each a problem", () => {
    const dir = folder({ "a.deb": "deb", "extra.sh": "#!/bin/sh" });
    mkdirSync(join(dir, "nested"));
    assert.deepEqual(checkArtifact(dir, ["a.deb", "b.rpm"]), ["missing b.rpm", "unexpected file extra.sh", "unexpected folder nested/"]);
  });

  test("a symlink, even to an expected file elsewhere, is not a regular file", () => {
    const outside = folder({ "a.deb": "deb" });
    const dir = folder();
    symlinkSync(join(outside, "a.deb"), join(dir, "a.deb"));
    assert.deepEqual(checkArtifact(dir, ["a.deb"]), ["a.deb is not a regular file"]);
  });

  test("an empty file is a problem", () => {
    assert.deepEqual(checkArtifact(folder({ "updater.key": "" }), ["updater.key"]), ["updater.key is empty"]);
  });

  test("a folder that is a symlink, or that isn't there, is a problem", () => {
    const real = folder({ "a.deb": "deb" });
    const link = join(ROOT, `link-${(count += 1)}`);
    symlinkSync(real, link);
    assert.deepEqual(checkArtifact(link, ["a.deb"]), [`${link} is not a folder`]);
    assert.deepEqual(checkArtifact(join(ROOT, "nope"), ["a.deb"]), [`${join(ROOT, "nope")} is missing`]);
  });
});

describe("the CLI", () => {
  test("exit 0 when the folder holds exactly the files named", () => {
    const result = cli(folder({ "compiled.tar": "tar" }), "compiled.tar");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /holds exactly compiled\.tar/);
  });

  test("exit 1, with each problem on stderr", () => {
    const result = cli(folder({ "compiled.tar": "tar", "other.tar": "x" }), "compiled.tar");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unexpected file other\.tar/);
  });

  test("exit 2 for usage: no folder, no names, a name with a path, a name twice", () => {
    for (const args of [[], [folder()], [folder(), "a/b"], [folder(), ".."], [folder(), ""], [folder(), "a", "a"]]) {
      const result = cli(...args);
      assert.equal(result.status, 2, `${JSON.stringify(args)}: ${result.stderr}`);
      assert.match(result.stderr, /usage:/);
    }
  });
});
