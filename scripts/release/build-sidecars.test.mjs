/**
 * Tests for planBuild in scripts/build-sidecars.mjs: the profile and target
 * triple the MCP sidecars are built for, the folder cargo writes them to,
 * and the file extension they carry.
 *
 *   node --test scripts/release/build-sidecars.test.mjs
 *
 * planBuild is pure: the arguments, the environment and the host triple all
 * come in as parameters, so nothing here starts rustc or cargo.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { planBuild } from "../build-sidecars.mjs";

const LINUX = "x86_64-unknown-linux-gnu";
const ARM_MAC = "aarch64-apple-darwin";
const INTEL_MAC = "x86_64-apple-darwin";
const WINDOWS = "x86_64-pc-windows-msvc";

/** planBuild on a Linux x64 host with an empty environment, unless told otherwise. */
const plan = (argv, { env = {}, hostTriple = LINUX } = {}) => planBuild({ argv, env, hostTriple });

describe("planBuild", () => {
  test("no flags: a debug build for the host, where cargo puts it by default", () => {
    assert.deepEqual(plan([]), {
      check: false,
      release: false,
      profile: "debug",
      triple: LINUX,
      cargoTarget: null,
      outDir: "target/debug",
      exe: "",
    });
  });

  test("--release: a release build", () => {
    const p = plan(["--release"]);
    assert.equal(p.release, true);
    assert.equal(p.profile, "release");
    assert.equal(p.triple, LINUX);
    assert.equal(p.cargoTarget, null);
    assert.equal(p.outDir, "target/release");
  });

  test("--release --target for the other macOS arch: cargo builds for it, into the target's own folder", () => {
    assert.deepEqual(plan(["--release", "--target", INTEL_MAC], { hostTriple: ARM_MAC }), {
      check: false,
      release: true,
      profile: "release",
      triple: INTEL_MAC,
      cargoTarget: INTEL_MAC,
      outDir: "target/x86_64-apple-darwin/release",
      exe: "",
    });
  });

  test("a Windows target: the binaries end in .exe", () => {
    const p = plan(["--target", WINDOWS], { hostTriple: WINDOWS });
    assert.equal(p.exe, ".exe");
    assert.equal(p.triple, WINDOWS);
    assert.equal(plan([], { hostTriple: WINDOWS }).exe, ".exe");
    assert.equal(plan([], { hostTriple: ARM_MAC }).exe, "");
  });

  test("TAURI_ENV_TARGET_TRIPLE equal to the host: cargo builds as it would without it", () => {
    const p = plan(["--release"], { env: { TAURI_ENV_TARGET_TRIPLE: LINUX } });
    assert.equal(p.triple, LINUX);
    assert.equal(p.cargoTarget, null);
    assert.equal(p.outDir, "target/release");
  });

  test("TAURI_ENV_TARGET_TRIPLE for another target: cargo builds for that target", () => {
    const p = plan(["--release"], {
      env: { TAURI_ENV_TARGET_TRIPLE: INTEL_MAC },
      hostTriple: ARM_MAC,
    });
    assert.equal(p.triple, INTEL_MAC);
    assert.equal(p.cargoTarget, INTEL_MAC);
    assert.equal(p.outDir, "target/x86_64-apple-darwin/release");
  });

  test("an empty TAURI_ENV_TARGET_TRIPLE counts as unset", () => {
    const p = plan([], { env: { TAURI_ENV_TARGET_TRIPLE: "" } });
    assert.equal(p.triple, LINUX);
    assert.equal(p.cargoTarget, null);
  });

  test("an explicit --target wins over TAURI_ENV_TARGET_TRIPLE", () => {
    const p = plan(["--target", INTEL_MAC], {
      env: { TAURI_ENV_TARGET_TRIPLE: ARM_MAC },
      hostTriple: ARM_MAC,
    });
    assert.equal(p.triple, INTEL_MAC);
    assert.equal(p.cargoTarget, INTEL_MAC);
  });

  test("an explicit --target equal to the host still goes to cargo", () => {
    const p = plan(["--release", "--target", LINUX]);
    assert.equal(p.triple, LINUX);
    assert.equal(p.cargoTarget, LINUX);
    assert.equal(p.outDir, "target/x86_64-unknown-linux-gnu/release");
  });

  test("--target without a triple throws", () => {
    for (const argv of [["--target"], ["--release", "--target"], ["--target", ""], ["--target", "--release"]]) {
      assert.throws(() => plan(argv), { message: "--target needs a target triple" }, JSON.stringify(argv));
    }
  });

  test("--target=<triple> throws, pointing at the spaced form", () => {
    for (const argv of [[`--target=${INTEL_MAC}`], ["--release", "--target="]]) {
      assert.throws(
        () => plan(argv, { hostTriple: ARM_MAC }),
        { message: "--target=<triple> isn't supported: use --target <triple>" },
        JSON.stringify(argv),
      );
    }
  });

  test("a triple with anything but letters, digits, '_', '.' and '-' throws", () => {
    // The triple names the staged files: no path, no space, no shell syntax.
    for (const triple of [`${LINUX}; true`, `${LINUX} `, "$(true)", "a/b"]) {
      assert.throws(() => plan(["--target", triple]), /not a target triple/, triple);
      assert.throws(() => plan([], { env: { TAURI_ENV_TARGET_TRIPLE: triple } }), /not a target triple/, triple);
    }
  });

  test("--check: the drift check", () => {
    assert.equal(plan(["--check"]).check, true);
    assert.equal(plan([]).check, false);
  });

  test("CARGO_TARGET_DIR moves the folder cargo writes to", () => {
    assert.equal(plan(["--release"], { env: { CARGO_TARGET_DIR: "/x" } }).outDir, "/x/release");
    assert.equal(
      plan(["--release", "--target", INTEL_MAC], { env: { CARGO_TARGET_DIR: "/x" }, hostTriple: ARM_MAC }).outDir,
      "/x/x86_64-apple-darwin/release",
    );
    assert.equal(plan([], { env: { CARGO_TARGET_DIR: "" } }).outDir, "target/debug");
  });
});
