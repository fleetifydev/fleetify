/**
 * Tests for collect-bundles.mjs, which copies the files a target's build
 * publishes out of target/<triple>/release/bundle/, under their release names.
 *
 *   node --test scripts/release/collect-bundles.test.mjs
 *
 * The bundle trees are fake: each file holds a line of text naming itself.
 */
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { collect } from "./collect-bundles.mjs";
import { TARGETS, bundleFiles, unsignedBundleFiles } from "./release-assets.mjs";

const SCRIPT = fileURLToPath(new URL("./collect-bundles.mjs", import.meta.url));

const V = "0.2.0";
const LINUX = "x86_64-unknown-linux-gnu";
const WINDOWS = "x86_64-pc-windows-msvc";
const ARM_MAC = "aarch64-apple-darwin";
const INTEL_MAC = "x86_64-apple-darwin";

/** Each target's release assets, by name, in the order bundleFiles lists them. */
const NAMES = {
  [LINUX]: [
    "Fleetify_0.2.0_amd64.AppImage",
    "Fleetify_0.2.0_amd64.AppImage.sig",
    "Fleetify_0.2.0_amd64.deb",
    "Fleetify_0.2.0_amd64.deb.sig",
    "Fleetify-0.2.0-1.x86_64.rpm",
    "Fleetify-0.2.0-1.x86_64.rpm.sig",
  ],
  [WINDOWS]: ["Fleetify_0.2.0_x64-setup.exe", "Fleetify_0.2.0_x64-setup.exe.sig"],
  [ARM_MAC]: ["Fleetify_0.2.0_aarch64.app.tar.gz", "Fleetify_0.2.0_aarch64.app.tar.gz.sig", "Fleetify_0.2.0_aarch64.dmg"],
  [INTEL_MAC]: ["Fleetify_0.2.0_x64.app.tar.gz", "Fleetify_0.2.0_x64.app.tar.gz.sig", "Fleetify_0.2.0_x64.dmg"],
};

const ROOT = mkdtempSync(join(tmpdir(), "collect-bundles-"));
after(() => rmSync(ROOT, { recursive: true, force: true }));
let count = 0;
/** A path under ROOT that doesn't exist yet. */
const fresh = (name) => join(ROOT, `${name}-${(count += 1)}`);

/** The folder Tauri writes a target's bundles to. */
const bundleDir = (targetDir, triple) => join(targetDir, triple, "release", "bundle");
/** What a fake bundle file holds. */
const content = (triple, from) => `fake ${triple} ${from}\n`;

/**
 * A fake Cargo target folder for one triple: every file bundleFiles(triple)
 * names, except those in `skip`, and the other things a build leaves in the
 * bundle folder, which aren't published.
 */
function targetTree(triple, { skip = [], targetDir = fresh("target") } = {}) {
  const dir = bundleDir(targetDir, triple);
  for (const { from } of bundleFiles(triple, V)) {
    if (skip.includes(from)) continue;
    mkdirSync(dirname(join(dir, from)), { recursive: true });
    writeFileSync(join(dir, from), content(triple, from));
  }
  mkdirSync(join(dir, "macos", "Fleetify.app", "Contents"), { recursive: true });
  writeFileSync(join(dir, "macos", "Fleetify.app", "Contents", "Info.plist"), "<plist/>\n");
  mkdirSync(join(dir, "share"), { recursive: true });
  writeFileSync(join(dir, "share", "bundle_dmg.sh"), "#!/bin/sh\n");
  writeFileSync(join(dir, "README.txt"), "not a release asset\n");
  return targetDir;
}

const sorted = (names) => [...names].sort();

describe("collect --unsigned", () => {
  test("Linux: the bundles under their release names, without the signatures, which a keyless build doesn't make", () => {
    const targetDir = targetTree(LINUX, { skip: bundleFiles(LINUX, V).map(({ from }) => from).filter((from) => from.endsWith(".sig")) });
    const outDir = fresh("out");
    const { copied, missing } = collect({ targetDir, triple: LINUX, version: V, outDir, unsigned: true });
    assert.deepEqual(missing, []);
    assert.deepEqual(copied, unsignedBundleFiles(LINUX, V).map(({ to }) => to));
    assert.deepEqual(sorted(readdirSync(outDir)), sorted(NAMES[LINUX].filter((name) => !name.endsWith(".sig"))));
  });

  test("a missing bundle is still missing", () => {
    const targetDir = targetTree(WINDOWS, { skip: ["nsis/Fleetify_0.2.0_x64-setup.exe"] });
    const { copied, missing } = collect({ targetDir, triple: WINDOWS, version: V, outDir: fresh("out"), unsigned: true });
    assert.deepEqual(copied, []);
    assert.deepEqual(missing, [join(bundleDir(targetDir, WINDOWS), "nsis/Fleetify_0.2.0_x64-setup.exe")]);
  });

  test("the CLI's --unsigned copies the bundles alone; exit 0", () => {
    const targetDir = targetTree(WINDOWS);
    const outDir = fresh("out");
    const result = cli(["--target", WINDOWS, "--version", V, "--out", outDir, "--target-dir", targetDir, "--unsigned"]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readdirSync(outDir), ["Fleetify_0.2.0_x64-setup.exe"]);
    assert.equal(cli(["--target", WINDOWS, "--version", V, "--out", fresh("out"), "--unsigned", "--unsigned"]).status, 2, "--unsigned twice is a usage error");
  });
});

describe("collect", () => {
  for (const { triple } of TARGETS) {
    test(`${triple}: its files in out under their release names, and nothing else`, () => {
      const targetDir = targetTree(triple);
      const outDir = fresh("out");
      const { copied, missing } = collect({ targetDir, triple, version: V, outDir });
      assert.deepEqual(missing, []);
      assert.deepEqual(copied, NAMES[triple]);
      assert.deepEqual(sorted(readdirSync(outDir)), sorted(NAMES[triple]));
      for (const { from, to } of bundleFiles(triple, V)) {
        assert.equal(readFileSync(join(outDir, to), "utf8"), content(triple, from), to);
      }
    });
  }

  test("each macOS build's app archive and its signature are renamed with the version and arch", () => {
    for (const [triple, arch] of [
      [ARM_MAC, "aarch64"],
      [INTEL_MAC, "x64"],
    ]) {
      const outDir = fresh("out");
      collect({ targetDir: targetTree(triple), triple, version: V, outDir });
      const archive = `Fleetify_0.2.0_${arch}.app.tar.gz`;
      assert.equal(readFileSync(join(outDir, archive), "utf8"), content(triple, "macos/Fleetify.app.tar.gz"));
      assert.equal(readFileSync(join(outDir, `${archive}.sig`), "utf8"), content(triple, "macos/Fleetify.app.tar.gz.sig"));
      assert.equal(existsSync(join(outDir, "Fleetify.app.tar.gz")), false);
      assert.equal(existsSync(join(outDir, "Fleetify.app.tar.gz.sig")), false);
    }
  });

  test("a missing file is reported by its path, and nothing is copied", () => {
    const targetDir = targetTree(LINUX, { skip: ["deb/Fleetify_0.2.0_amd64.deb"] });
    const outDir = fresh("out");
    const { copied, missing } = collect({ targetDir, triple: LINUX, version: V, outDir });
    assert.deepEqual(missing, [join(bundleDir(targetDir, LINUX), "deb", "Fleetify_0.2.0_amd64.deb")]);
    assert.deepEqual(copied, []);
    assert.equal(existsSync(outDir), false);
  });

  test("every missing file is reported, in bundleFiles order", () => {
    const targetDir = targetTree(ARM_MAC, { skip: ["macos/Fleetify.app.tar.gz.sig", "dmg/Fleetify_0.2.0_aarch64.dmg"] });
    const { missing } = collect({ targetDir, triple: ARM_MAC, version: V, outDir: fresh("out") });
    const dir = bundleDir(targetDir, ARM_MAC);
    assert.deepEqual(missing, [join(dir, "macos", "Fleetify.app.tar.gz.sig"), join(dir, "dmg", "Fleetify_0.2.0_aarch64.dmg")]);
  });

  test("no bundle folder at all: every file is missing", () => {
    const targetDir = fresh("target");
    const { copied, missing } = collect({ targetDir, triple: WINDOWS, version: V, outDir: fresh("out") });
    assert.deepEqual(copied, []);
    assert.deepEqual(
      missing,
      bundleFiles(WINDOWS, V).map(({ from }) => join(bundleDir(targetDir, WINDOWS), from)),
    );
  });

  test("a folder where a file should be counts as missing", () => {
    const targetDir = targetTree(WINDOWS, { skip: ["nsis/Fleetify_0.2.0_x64-setup.exe.sig"] });
    mkdirSync(join(bundleDir(targetDir, WINDOWS), "nsis", "Fleetify_0.2.0_x64-setup.exe.sig"));
    const { missing } = collect({ targetDir, triple: WINDOWS, version: V, outDir: fresh("out") });
    assert.deepEqual(missing, [join(bundleDir(targetDir, WINDOWS), "nsis", "Fleetify_0.2.0_x64-setup.exe.sig")]);
  });

  test("an empty out folder is used", () => {
    const outDir = fresh("out");
    mkdirSync(outDir);
    const { copied } = collect({ targetDir: targetTree(WINDOWS), triple: WINDOWS, version: V, outDir });
    assert.deepEqual(copied, NAMES[WINDOWS]);
    assert.deepEqual(sorted(readdirSync(outDir)), sorted(NAMES[WINDOWS]));
  });

  test("an out folder that isn't empty is refused and left as it was", () => {
    const outDir = fresh("out");
    mkdirSync(outDir);
    writeFileSync(join(outDir, "Fleetify_0.2.0_x64-setup.exe"), "from another build\n");
    assert.throws(
      () => collect({ targetDir: targetTree(WINDOWS), triple: WINDOWS, version: V, outDir }),
      /is not empty/,
    );
    assert.deepEqual(readdirSync(outDir), ["Fleetify_0.2.0_x64-setup.exe"]);
    assert.equal(readFileSync(join(outDir, "Fleetify_0.2.0_x64-setup.exe"), "utf8"), "from another build\n");
  });

  test("an out path that is a file is refused", () => {
    const outDir = fresh("out");
    writeFileSync(outDir, "a file\n");
    assert.throws(
      () => collect({ targetDir: targetTree(WINDOWS), triple: WINDOWS, version: V, outDir }),
      /is not a folder/,
    );
  });

  test("an unknown target or a malformed version is refused", () => {
    const targetDir = targetTree(LINUX);
    assert.throws(
      () => collect({ targetDir, triple: "riscv64gc-unknown-linux-gnu", version: V, outDir: fresh("out") }),
      /unknown target triple/,
    );
    assert.throws(() => collect({ targetDir, triple: LINUX, version: "v0.2.0", outDir: fresh("out") }), /invalid version/);
  });
});

/** Run the CLI with `args`, from `cwd`. */
function cli(args, { cwd } = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: "utf8" });
}

describe("the CLI", () => {
  test("copies the target's files and lists them; exit 0", () => {
    const targetDir = targetTree(ARM_MAC);
    const outDir = fresh("out");
    const result = cli(["--target", ARM_MAC, "--version", V, "--out", outDir, "--target-dir", targetDir]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(sorted(readdirSync(outDir)), sorted(NAMES[ARM_MAC]));
    const listed = result.stdout.split(/\r?\n/);
    for (const name of NAMES[ARM_MAC]) assert.ok(listed.includes(`  ${name}`), result.stdout);
  });

  test("--target-dir defaults to target, under the working directory", () => {
    const cwd = fresh("repo");
    targetTree(LINUX, { targetDir: join(cwd, "target") });
    const result = cli(["--target", LINUX, "--version", V, "--out", "bundles"], { cwd });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(sorted(readdirSync(join(cwd, "bundles"))), sorted(NAMES[LINUX]));
  });

  test("a missing file: exit 1, the missing files listed, nothing copied", () => {
    const targetDir = targetTree(LINUX, { skip: ["rpm/Fleetify-0.2.0-1.x86_64.rpm.sig", "appimage/Fleetify_0.2.0_amd64.AppImage"] });
    const outDir = fresh("out");
    const result = cli(["--target", LINUX, "--version", V, "--out", outDir, "--target-dir", targetDir]);
    assert.equal(result.status, 1);
    const dir = bundleDir(targetDir, LINUX);
    const listed = result.stderr.split("\n").filter((line) => line.startsWith("collect-bundles: missing "));
    assert.deepEqual(listed, [
      `collect-bundles: missing ${join(dir, "appimage", "Fleetify_0.2.0_amd64.AppImage")}`,
      `collect-bundles: missing ${join(dir, "rpm", "Fleetify-0.2.0-1.x86_64.rpm.sig")}`,
    ]);
    assert.match(result.stderr, /2 file\(s\) missing; nothing was copied/);
    assert.equal(existsSync(outDir), false);
  });

  test("an out folder that isn't empty: exit 1", () => {
    const outDir = fresh("out");
    mkdirSync(outDir);
    writeFileSync(join(outDir, "stale.txt"), "stale\n");
    const result = cli(["--target", WINDOWS, "--version", V, "--out", outDir, "--target-dir", targetTree(WINDOWS)]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /is not empty/);
  });

  test("an unknown target: exit 1", () => {
    const result = cli(["--target", "riscv64gc-unknown-linux-gnu", "--version", V, "--out", fresh("out")]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unknown target triple/);
  });

  test("usage errors: exit 2", () => {
    const out = fresh("out");
    for (const args of [
      [],
      ["--version", V, "--out", out],
      ["--target", LINUX, "--out", out],
      ["--target", LINUX, "--version", V],
      [`--target=${LINUX}`, "--version", V, "--out", out],
      ["--target", LINUX, "--target", LINUX, "--version", V, "--out", out],
      ["--target", LINUX, "--version", V, "--out"],
      ["--target", LINUX, "--version", V, "--out", ""],
      ["--target", "--version", V, "--out", out],
      ["--target", LINUX, "--version", V, "--out", out, "extra"],
    ]) {
      const result = cli(args);
      assert.equal(result.status, 2, `${JSON.stringify(args)}: ${result.stderr}`);
      assert.match(result.stderr, /usage: node scripts\/release\/collect-bundles\.mjs/, JSON.stringify(args));
    }
    assert.equal(existsSync(out), false);
  });
});
