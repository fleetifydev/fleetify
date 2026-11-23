/**
 * Tests for assemble.mjs, which turns the build jobs' artifacts into a
 * release: it checks that every expected file is there and nothing else,
 * checks each updater artifact's signature, and writes latest.json and
 * SHA256SUMS.
 *
 *   node --test scripts/release/assemble.test.mjs
 *
 * The trees are fake: each bundle is a line of text. Most tests inject a
 * `verify` stub that passes when a .sig names its own file, and a rehearsal
 * signature its file and the rehearsal. The end-to-end tests sign the fake
 * bundles with keys made in memory for the run (fixtures/test-signer.mjs),
 * then run the real verifier and the CLI.
 */
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { assemble } from "./assemble.mjs";
import { makeTestKey, signLikeTauri } from "./fixtures/test-signer.mjs";
import { parsePublicKey } from "./minisign.mjs";
import {
  INSTALL_SCRIPTS,
  REHEARSAL_VERSION,
  TARGETS,
  UPDATER_KEY_ID,
  bundleFiles,
  downloadBase,
  expectedAssets,
  latestJson,
  sha256sums,
  updaterArtifacts,
  updaterAssets,
} from "./release-assets.mjs";

const SCRIPT = fileURLToPath(new URL("./assemble.mjs", import.meta.url));
const CONFIG = fileURLToPath(new URL("../../src-tauri/tauri.conf.json", import.meta.url));
const FIXTURE_PUB = readFileSync(new URL("./fixtures/minisign/fixture.pub", import.meta.url), "utf8");
const OTHER_PUB = readFileSync(new URL("./fixtures/minisign/other.pub", import.meta.url), "utf8");

const V = "0.2.0";
const LINUX = "x86_64-unknown-linux-gnu";
const WINDOWS = "x86_64-pc-windows-msvc";
const DEB = "Fleetify_0.2.0_amd64.deb";
const APPIMAGE = "Fleetify_0.2.0_amd64.AppImage";
const NOW = new Date("2026-11-21T10:00:00.250Z");
const PUB_DATE = "2026-11-21T10:00:00.250Z";
/** How a release run checks signatures: the key in tauri.conf.json, which must be the release key. */
const RELEASE_KEYS = { config: CONFIG, expectKeyId: UPDATER_KEY_ID };

const ROOT = mkdtempSync(join(tmpdir(), "assemble-"));
after(() => rmSync(ROOT, { recursive: true, force: true }));
let count = 0;
/** A path under ROOT that doesn't exist yet. */
const fresh = (name) => join(ROOT, `${name}-${(count += 1)}`);

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const hasSig = (triple, name) => bundleFiles(triple, V).some(({ to }) => to === `${name}.sig`);

/** Stand-ins for the install scripts, which no build makes: a release gets them with --extra. */
const EXTRAS_DIR = fresh("extras");
mkdirSync(EXTRAS_DIR);
const EXTRAS = INSTALL_SCRIPTS.map((name) => {
  const path = join(EXTRAS_DIR, name);
  writeFileSync(path, `fake ${name}\n`);
  return path;
});
const extraArgs = () => EXTRAS.flatMap((path) => ["--extra", path]);

/**
 * A complete --in tree: each target's bundles, the Linux library list and the
 * notices. A fake bundle holds "fake <name>\n". Its .sig holds "sig:<name>\n",
 * which stubVerify accepts, or, with `keys` ({ [triple]: test key }), a real
 * signature by that target's key, whose trusted comment is `comment(name)`:
 * by default the one tauri-cli 2.11.5 writes for version 0.2.0. `pubkeyFiles`
 * adds each bundle folder's updater-pubkey.txt, as a dry run has them: the
 * target's key, or else fixture.pub. `rehearsal` adds each target's
 * rehearsal-<triple> folder, as a dry run has them: for each updater
 * artifact, <name>.sig holds "rehearsal-sig:<name>\n", or with `keys` a real
 * signature whose trusted comment is `rehearsalComment(name)`, by default
 * the one tauri signer sign --app-version 99.0.0 writes.
 */
function inputTree({
  keys = null,
  pubkeyFiles = false,
  rehearsal = false,
  comment = (name) => `timestamp:1795238472\tfile:${name}\tversion:${V}`,
  rehearsalComment = (name) => `timestamp:1795238473\tfile:${name}\tversion:${REHEARSAL_VERSION}`,
} = {}) {
  const dir = fresh("in");
  for (const { triple } of TARGETS) {
    const folder = join(dir, `bundles-${triple}`);
    mkdirSync(folder, { recursive: true });
    if (rehearsal) mkdirSync(join(dir, `rehearsal-${triple}`));
    for (const { to } of bundleFiles(triple, V)) {
      if (to.endsWith(".sig")) continue;
      const data = Buffer.from(`fake ${to}\n`);
      writeFileSync(join(folder, to), data);
      if (!hasSig(triple, to)) continue;
      const signature = keys
        ? signLikeTauri(keys[triple], data, { trustedComment: comment(to) })
        : `sig:${to}\n`;
      writeFileSync(join(folder, `${to}.sig`), signature);
      if (!rehearsal) continue;
      const rehearsalSignature = keys
        ? signLikeTauri(keys[triple], data, { trustedComment: rehearsalComment(to) })
        : `rehearsal-sig:${to}\n`;
      writeFileSync(join(dir, `rehearsal-${triple}`, `${to}.sig`), rehearsalSignature);
    }
    if (pubkeyFiles) writeFileSync(join(folder, "updater-pubkey.txt"), keys ? keys[triple].tauriPublicKey : FIXTURE_PUB);
  }
  writeFileSync(join(dir, `bundles-${LINUX}`, "LINUX-APPIMAGE-LIBRARIES.txt"), "the AppImage's libraries\n");
  mkdirSync(join(dir, "third-party-notices"));
  writeFileSync(join(dir, "third-party-notices", "THIRD-PARTY-NOTICES"), "Third-party notices for Fleetify 0.2.0\n");
  return dir;
}

/**
 * Passes when a .sig names the data's own file, as the fake .sig files do,
 * and a signature checked for the rehearsal's version names the rehearsal too.
 */
function stubVerify({ data, tauriSignature, version }) {
  const name = data.toString("utf8").replace(/^fake /, "").trimEnd();
  const expected = version === REHEARSAL_VERSION ? `rehearsal-sig:${name}` : `sig:${name}`;
  return tauriSignature === expected ? { ok: true } : { ok: false, reason: "signature does not match the data" };
}

/** assemble()'s options for a dry run: each build's own key, and a fresh folder for the rehearsal's signatures. */
const dryRun = () => ({ pubkeys: { perTarget: true }, rehearsalOut: fresh("rehearsal") });

/** assemble() over `inDir` for 0.2.0 into a fresh out folder, as a release run would, unless told otherwise. */
function run(inDir, options = {}) {
  const outDir = options.outDir ?? fresh("out");
  const result = assemble({
    inDir,
    outDir,
    version: V,
    pubkeys: RELEASE_KEYS,
    extras: EXTRAS,
    now: NOW,
    verify: stubVerify,
    ...options,
  });
  return { ...result, outDir };
}

/** Assert that `problems` has one entry matching every pattern given. */
function assertProblem(problems, ...patterns) {
  assert.ok(
    problems.some((problem) => patterns.every((pattern) => pattern.test(problem))),
    `no problem matches ${patterns.join(" and ")} in:\n${problems.join("\n")}`,
  );
}

/** A pattern for assertProblem that matches `text` as it is, without becoming a RegExp. */
const literal = (text) => ({ test: (value) => value.includes(text), toString: () => JSON.stringify(text) });

describe("assemble, with a stub for the signature check", () => {
  test("a complete input and the install scripts: no problems, and the release's 20 assets", () => {
    const { assets, problems, outDir } = run(inputTree());
    assert.deepEqual(problems, []);
    assert.deepEqual(assets, expectedAssets(V));
    assert.deepEqual(readdirSync(outDir).sort(), expectedAssets(V));
  });

  test("latest.json: latestJson() over the trimmed .sig texts, with pub_date `now` as toISOString() writes it", () => {
    const { outDir } = run(inputTree());
    const text = readFileSync(join(outDir, "latest.json"), "utf8");
    const signatures = Object.fromEntries(updaterArtifacts(V).map(({ asset }) => [asset, `sig:${asset}`]));
    const expected = latestJson({ version: V, pubDate: PUB_DATE, signatures, base: downloadBase(V) });
    assert.equal(text, `${JSON.stringify(expected, null, 2)}\n`);
  });

  test("SHA256SUMS: every other asset, with the hash of the file as published", () => {
    const { outDir } = run(inputTree());
    const others = expectedAssets(V).filter((name) => name !== "SHA256SUMS");
    assert.equal(others.length, 19);
    const expected = sha256sums(others.map((name) => ({ name, sha256: sha256(readFileSync(join(outDir, name))) })));
    assert.equal(readFileSync(join(outDir, "SHA256SUMS"), "utf8"), expected);
  });

  test("each published file is its input file, byte for byte", () => {
    const inDir = inputTree();
    const { outDir } = run(inDir);
    for (const { triple } of TARGETS) {
      for (const { to } of bundleFiles(triple, V)) {
        assert.deepEqual(readFileSync(join(outDir, to)), readFileSync(join(inDir, `bundles-${triple}`, to)), to);
      }
    }
    assert.deepEqual(
      readFileSync(join(outDir, "LINUX-APPIMAGE-LIBRARIES.txt")),
      readFileSync(join(inDir, `bundles-${LINUX}`, "LINUX-APPIMAGE-LIBRARIES.txt")),
    );
    assert.deepEqual(
      readFileSync(join(outDir, "THIRD-PARTY-NOTICES")),
      readFileSync(join(inDir, "third-party-notices", "THIRD-PARTY-NOTICES")),
    );
    for (const [i, name] of INSTALL_SCRIPTS.entries()) assert.deepEqual(readFileSync(join(outDir, name)), readFileSync(EXTRAS[i]), name);
  });

  test("without the install scripts: a problem for each, and nothing is assembled", () => {
    const { assets, problems, outDir } = run(inputTree(), { extras: [] });
    assert.deepEqual(problems, [...INSTALL_SCRIPTS].sort().map((name) => `missing ${name}: give it with --extra`));
    assert.deepEqual(assets, []);
    assert.equal(existsSync(outDir), false);
  });

  test("each updater artifact's signature is checked once, over its own bytes, against the configured key and version", () => {
    const calls = [];
    const { problems } = run(inputTree(), {
      verify: (args) => {
        calls.push(args);
        return stubVerify(args);
      },
    });
    assert.deepEqual(problems, []);
    const checked = calls.map(({ data }) => data.toString("utf8").replace(/^fake /, "").trimEnd());
    assert.deepEqual(checked.sort(), updaterArtifacts(V).map(({ asset }) => asset).sort());
    for (const { data, tauriSignature, publicKey, version } of calls) {
      assert.equal(tauriSignature, `sig:${data.toString("utf8").slice(5).trimEnd()}`);
      assert.equal(publicKey.keyId, UPDATER_KEY_ID);
      assert.equal(version, V);
    }
  });

  test("a missing .deb: a problem naming it, and nothing is assembled", () => {
    const inDir = inputTree();
    rmSync(join(inDir, `bundles-${LINUX}`, DEB));
    const { assets, problems, outDir } = run(inDir);
    assert.deepEqual(problems, [`missing bundles-${LINUX}/${DEB}`]);
    assert.deepEqual(assets, []);
    assert.equal(existsSync(outDir), false);
  });

  test("a missing signature file: a problem naming it", () => {
    const inDir = inputTree();
    rmSync(join(inDir, `bundles-${LINUX}`, `${APPIMAGE}.sig`));
    const { problems } = run(inDir);
    assert.deepEqual(problems, [`missing bundles-${LINUX}/${APPIMAGE}.sig`]);
  });

  test("a missing bundle folder or notices: a problem naming it", () => {
    const inDir = inputTree();
    rmSync(join(inDir, `bundles-${WINDOWS}`), { recursive: true });
    rmSync(join(inDir, "third-party-notices", "THIRD-PARTY-NOTICES"));
    const { problems } = run(inDir);
    assert.deepEqual(problems, [`missing bundles-${WINDOWS}/`, "missing third-party-notices/THIRD-PARTY-NOTICES"]);
  });

  test("an extra file in a bundle folder: a problem", () => {
    const inDir = inputTree();
    writeFileSync(join(inDir, `bundles-${WINDOWS}`, "Fleetify_0.2.0_x64_en-US.msi"), "fake msi\n");
    const { assets, problems } = run(inDir);
    assert.deepEqual(problems, [`unexpected file bundles-${WINDOWS}/Fleetify_0.2.0_x64_en-US.msi`]);
    assert.deepEqual(assets, []);
  });

  test("an extra folder or file at the top of --in: a problem", () => {
    const inDir = inputTree();
    mkdirSync(join(inDir, "bundles-riscv64gc-unknown-linux-gnu"));
    writeFileSync(join(inDir, "stray.txt"), "stray\n");
    const { problems } = run(inDir);
    assert.deepEqual(problems, ["unexpected folder bundles-riscv64gc-unknown-linux-gnu/", "unexpected file stray.txt"]);
  });

  test("an updater-pubkey.txt in a release run: an unexpected file", () => {
    const inDir = inputTree();
    writeFileSync(join(inDir, `bundles-${LINUX}`, "updater-pubkey.txt"), FIXTURE_PUB);
    const { problems } = run(inDir);
    assert.deepEqual(problems, [`unexpected file bundles-${LINUX}/updater-pubkey.txt`]);
  });

  test("a bad signature: a problem naming the file and why", () => {
    const inDir = inputTree();
    writeFileSync(join(inDir, `bundles-${LINUX}`, `${APPIMAGE}.sig`), "sig:another file\n");
    const { assets, problems, outDir } = run(inDir);
    assert.deepEqual(problems, [`bad signature for ${APPIMAGE}: signature does not match the data`]);
    assert.deepEqual(assets, []);
    assert.equal(existsSync(outDir), false);
  });

  test("an empty file: a problem", () => {
    const inDir = inputTree();
    writeFileSync(join(inDir, "third-party-notices", "THIRD-PARTY-NOTICES"), "");
    writeFileSync(join(inDir, `bundles-${LINUX}`, `${DEB}.sig`), "  \n");
    const { problems } = run(inDir);
    assertProblem(problems, literal("third-party-notices/THIRD-PARTY-NOTICES"), /empty/);
    assertProblem(problems, literal(`bundles-${LINUX}/${DEB}.sig`), /empty/);
  });

  test(
    "a symlink in place of a bundle: a problem, and it isn't followed",
    { skip: process.platform === "win32" && "creating symlinks needs extra rights on Windows" },
    () => {
      const inDir = inputTree();
      const elsewhere = fresh("elsewhere");
      writeFileSync(elsewhere, `fake ${DEB}\n`);
      rmSync(join(inDir, `bundles-${LINUX}`, DEB));
      symlinkSync(elsewhere, join(inDir, `bundles-${LINUX}`, DEB));
      const { problems } = run(inDir);
      assert.deepEqual(problems, [`bundles-${LINUX}/${DEB} is not a regular file`]);
    },
  );

  test("--expect-key-id that isn't the configured key's id: a problem naming both", () => {
    const { assets, problems } = run(inputTree(), { pubkeys: { config: CONFIG, expectKeyId: "0123456789ABCDEF" } });
    assertProblem(problems, /key id/, /44C694713A20D751/, /0123456789ABCDEF/);
    assert.deepEqual(assets, []);
  });

  test("a config that can't be read, isn't JSON, or has no updater key: a problem", () => {
    const dir = fresh("conf");
    mkdirSync(dir);
    writeFileSync(join(dir, "not-json.json"), "{");
    writeFileSync(join(dir, "no-key.json"), JSON.stringify({ plugins: { updater: {} } }));
    writeFileSync(join(dir, "bad-key.json"), JSON.stringify({ plugins: { updater: { pubkey: "garbage" } } }));
    for (const [name, pattern] of [
      ["missing.json", /missing\.json/],
      ["not-json.json", /not-json\.json/],
      ["no-key.json", /no plugins\.updater\.pubkey/],
      ["bad-key.json", /malformed public key/],
    ]) {
      const { problems } = run(inputTree(), { pubkeys: { config: join(dir, name), expectKeyId: UPDATER_KEY_ID } });
      assertProblem(problems, pattern);
    }
  });

  test("per-target keys: each bundle's signatures against its own updater-pubkey.txt, which isn't published", () => {
    const inDir = inputTree({ pubkeyFiles: true, rehearsal: true });
    writeFileSync(join(inDir, `bundles-${WINDOWS}`, "updater-pubkey.txt"), `${OTHER_PUB}\n`);
    const calls = [];
    const { assets, problems, outDir } = run(inDir, {
      ...dryRun(),
      verify: (args) => {
        calls.push(args);
        return stubVerify(args);
      },
    });
    assert.deepEqual(problems, []);
    assert.deepEqual(assets, expectedAssets(V));
    assert.ok(!readdirSync(outDir).includes("updater-pubkey.txt"));
    // Each updater artifact twice: its signature for the release, and the rehearsal's.
    assert.equal(calls.length, 12);
    for (const { data, publicKey } of calls) {
      const windows = data.toString("utf8").includes("x64-setup.exe");
      assert.equal(publicKey.keyId, parsePublicKey(windows ? OTHER_PUB : FIXTURE_PUB).keyId);
    }
  });

  test("per-target keys: a missing or malformed updater-pubkey.txt is a problem", () => {
    const inDir = inputTree({ pubkeyFiles: true, rehearsal: true });
    rmSync(join(inDir, `bundles-${WINDOWS}`, "updater-pubkey.txt"));
    writeFileSync(join(inDir, `bundles-${LINUX}`, "updater-pubkey.txt"), "garbage\n");
    const { problems } = run(inDir, dryRun());
    assertProblem(problems, literal(`missing bundles-${WINDOWS}/updater-pubkey.txt`));
    assertProblem(problems, literal(`bundles-${LINUX}/updater-pubkey.txt`), /malformed public key/);
  });

  test("a dry run's rehearsal signatures: each checked once, over its artifact's bytes, against its target's key, for the rehearsal's version", () => {
    const calls = [];
    const { problems } = run(inputTree({ pubkeyFiles: true, rehearsal: true }), {
      ...dryRun(),
      verify: (args) => {
        calls.push(args);
        return stubVerify(args);
      },
    });
    assert.deepEqual(problems, []);
    const rehearsed = calls.filter(({ version }) => version === REHEARSAL_VERSION);
    const released = calls.filter(({ version }) => version === V);
    assert.equal(rehearsed.length + released.length, calls.length, "a signature was checked for another version");
    const names = (list) => list.map(({ data }) => data.toString("utf8").replace(/^fake /, "").trimEnd()).sort();
    const updaters = updaterArtifacts(V).map(({ asset }) => asset).sort();
    assert.deepEqual([names(rehearsed), names(released)], [updaters, updaters]);
    for (const { data, tauriSignature } of rehearsed) assert.equal(tauriSignature, `rehearsal-sig:${data.toString("utf8").slice(5).trimEnd()}`);
  });

  test("a dry run writes the rehearsal's signatures to --rehearsal-out, each as <asset>.sig, byte for byte, and none into the release", () => {
    const inDir = inputTree({ pubkeyFiles: true, rehearsal: true });
    const options = dryRun();
    const { assets, rehearsal, problems, outDir } = run(inDir, options);
    assert.deepEqual(problems, []);
    assert.deepEqual(readdirSync(outDir).sort(), expectedAssets(V));
    assert.deepEqual(assets, expectedAssets(V));
    const sigs = updaterArtifacts(V).map(({ asset }) => `${asset}.sig`).sort();
    assert.deepEqual(rehearsal, sigs);
    assert.deepEqual(readdirSync(options.rehearsalOut).sort(), sigs);
    for (const { triple } of TARGETS) {
      for (const asset of updaterAssets(triple, V)) {
        const published = readFileSync(join(options.rehearsalOut, `${asset}.sig`));
        assert.deepEqual(published, readFileSync(join(inDir, `rehearsal-${triple}`, `${asset}.sig`)), asset);
        assert.notDeepEqual(published, readFileSync(join(outDir, `${asset}.sig`)), `${asset}: the rehearsal's signature is the release's`);
      }
    }
  });

  test("a rehearsal signature that doesn't verify: a problem naming it, and neither folder is written", () => {
    const inDir = inputTree({ pubkeyFiles: true, rehearsal: true });
    writeFileSync(join(inDir, `rehearsal-${LINUX}`, `${DEB}.sig`), `sig:${DEB}\n`);
    const options = dryRun();
    const { assets, rehearsal, problems, outDir } = run(inDir, options);
    assert.deepEqual(problems, [`bad rehearsal signature for ${DEB}: signature does not match the data`]);
    assert.deepEqual([assets, rehearsal], [[], []]);
    assert.equal(existsSync(outDir), false);
    assert.equal(existsSync(options.rehearsalOut), false);
  });

  test("a rehearsal folder that is missing, or misses a signature or holds another file: a problem each", () => {
    const inDir = inputTree({ pubkeyFiles: true, rehearsal: true });
    rmSync(join(inDir, `rehearsal-${WINDOWS}`), { recursive: true });
    rmSync(join(inDir, `rehearsal-${LINUX}`, `${APPIMAGE}.sig`));
    writeFileSync(join(inDir, `rehearsal-${LINUX}`, "updater-pubkey.txt"), FIXTURE_PUB);
    const { problems } = run(inDir, dryRun());
    assert.deepEqual(problems, [
      `missing rehearsal-${LINUX}/${APPIMAGE}.sig`,
      `unexpected file rehearsal-${LINUX}/updater-pubkey.txt`,
      `missing rehearsal-${WINDOWS}/`,
    ]);
  });

  test("a release run takes no rehearsal signature: a rehearsal folder is unexpected, so none can ship", () => {
    const { assets, problems } = run(inputTree({ rehearsal: true }));
    assert.deepEqual(
      problems,
      TARGETS.map(({ triple }) => `rehearsal-${triple}`)
        .sort()
        .map((folder) => `unexpected folder ${folder}/`),
    );
    assert.deepEqual(assets, []);
  });

  test("--rehearsal-out that isn't empty, or is --out or inside it, or holds it: a problem, and nothing is written", () => {
    const busy = fresh("rehearsal");
    mkdirSync(busy);
    writeFileSync(join(busy, "old.sig"), "from an earlier run\n");
    const outDir = fresh("out");
    for (const [rehearsalOut, pattern, out] of [
      [busy, /--rehearsal-out .* is not empty/, outDir],
      [outDir, /--rehearsal-out \S+ must be a folder of its own, apart from --out \S+$/, outDir],
      [join(outDir, "rehearsal"), /--rehearsal-out \S+ must be a folder of its own, apart from --out \S+$/, outDir],
      [outDir, /--rehearsal-out \S+ must be a folder of its own, apart from --out \S+$/, join(outDir, "release")],
    ]) {
      const { assets, problems } = run(inputTree({ pubkeyFiles: true, rehearsal: true }), { pubkeys: { perTarget: true }, rehearsalOut, outDir: out });
      assertProblem(problems, pattern);
      assert.deepEqual(assets, []);
      assert.equal(existsSync(out), false, `${out} was written`);
    }
    assert.deepEqual(readdirSync(busy), ["old.sig"]);
  });

  test("a rehearsal signature that changes after its check: a problem, and neither folder keeps a file", () => {
    const inDir = inputTree({ pubkeyFiles: true, rehearsal: true });
    const sig = join(inDir, `rehearsal-${LINUX}`, `${APPIMAGE}.sig`);
    const options = dryRun();
    const { assets, problems, outDir } = run(inDir, {
      ...options,
      verify: (args) => {
        const result = stubVerify(args);
        if (args.version === REHEARSAL_VERSION && args.data.toString("utf8").includes(APPIMAGE)) writeFileSync(sig, "rehearsal-sig:another file\n");
        return result;
      },
    });
    assert.deepEqual(problems, [`rehearsal-${LINUX}/${APPIMAGE}.sig changed while the release was being assembled`]);
    assert.deepEqual(assets, []);
    assert.equal(existsSync(outDir), false);
    assert.equal(existsSync(options.rehearsalOut), false);
  });

  test("per-target keys and --rehearsal-out go together: either alone is refused", () => {
    assert.throws(() => run(inputTree({ pubkeyFiles: true, rehearsal: true }), { pubkeys: { perTarget: true } }), TypeError);
    assert.throws(() => run(inputTree(), { rehearsalOut: fresh("rehearsal") }), TypeError);
  });

  test("a non-empty out folder: a problem, and its files are left alone", () => {
    const outDir = fresh("out");
    mkdirSync(outDir);
    writeFileSync(join(outDir, "old.txt"), "from an earlier run\n");
    const { assets, problems } = run(inputTree(), { outDir });
    assertProblem(problems, literal(outDir), /not empty/);
    assert.deepEqual(assets, []);
    assert.deepEqual(readdirSync(outDir), ["old.txt"]);
  });

  test("an empty out folder is used, and left empty when there is a problem", () => {
    const good = fresh("out");
    mkdirSync(good);
    assert.deepEqual(run(inputTree(), { outDir: good }).problems, []);
    assert.deepEqual(readdirSync(good).sort(), expectedAssets(V));

    const inDir = inputTree();
    writeFileSync(join(inDir, `bundles-${LINUX}`, `${DEB}.sig`), "sig:wrong\n");
    const bad = fresh("out");
    mkdirSync(bad);
    assert.equal(run(inDir, { outDir: bad }).problems.length, 1);
    assert.deepEqual(readdirSync(bad), []);
  });

  test("a file that changes after its check: a problem, and nothing is left in the out folder", () => {
    const inDir = inputTree();
    const deb = join(inDir, `bundles-${LINUX}`, DEB);
    const { assets, problems, outDir } = run(inDir, {
      verify: (args) => {
        const result = stubVerify(args);
        // Swap the .deb once its signature has been checked.
        if (args.data.toString("utf8").includes(DEB)) writeFileSync(deb, "something else\n");
        return result;
      },
    });
    assert.deepEqual(problems, [`bundles-${LINUX}/${DEB} changed while the release was being assembled`]);
    assert.deepEqual(assets, []);
    assert.equal(existsSync(outDir), false);
  });

  test("a .sig that changes after its check: a problem, so latest.json can't carry a text the published .sig doesn't", () => {
    const inDir = inputTree();
    const sig = join(inDir, `bundles-${LINUX}`, `${APPIMAGE}.sig`);
    const { assets, problems, outDir } = run(inDir, {
      verify: (args) => {
        const result = stubVerify(args);
        // Swap the AppImage's .sig once its text has been checked.
        if (args.data.toString("utf8").includes(APPIMAGE)) writeFileSync(sig, "sig:another file\n");
        return result;
      },
    });
    assert.deepEqual(problems, [`bundles-${LINUX}/${APPIMAGE}.sig changed while the release was being assembled`]);
    assert.deepEqual(assets, []);
    assert.equal(existsSync(outDir), false);
  });

  test("an --extra that isn't a release asset, or isn't there: a problem", () => {
    const dir = fresh("extras");
    mkdirSync(dir);
    writeFileSync(join(dir, "notes.txt"), "notes\n");
    writeFileSync(join(dir, "THIRD-PARTY-NOTICES"), "a second copy\n");
    const { problems } = run(inputTree(), {
      extras: [join(dir, "notes.txt"), join(dir, "THIRD-PARTY-NOTICES"), join(dir, "missing.sh")],
    });
    assertProblem(problems, literal(join(dir, "notes.txt")), /not a release asset/);
    assertProblem(problems, literal(`${join(dir, "THIRD-PARTY-NOTICES")}: THIRD-PARTY-NOTICES is already provided by the build`));
    assertProblem(problems, literal(join(dir, "missing.sh")), /missing/);
  });

  test("an --extra can't stand in for a file the build provides, even when the build's copy is missing", () => {
    const inDir = inputTree();
    rmSync(join(inDir, "third-party-notices", "THIRD-PARTY-NOTICES"));
    const dir = fresh("extras");
    mkdirSync(dir);
    const extra = join(dir, "THIRD-PARTY-NOTICES");
    writeFileSync(extra, "notices from elsewhere\n");
    const { problems } = run(inDir, { extras: [...EXTRAS, extra] });
    assert.deepEqual(problems, [
      "missing third-party-notices/THIRD-PARTY-NOTICES",
      `--extra ${extra}: THIRD-PARTY-NOTICES is already provided by the build`,
    ]);
  });

  test("a version that isn't MAJOR.MINOR.PATCH: a problem", () => {
    const { assets, problems } = run(inputTree(), { version: "v0.2.0" });
    assertProblem(problems, /invalid version/);
    assert.deepEqual(assets, []);
  });

  test("a missing --in folder: a problem", () => {
    const { problems } = run(fresh("nothing"));
    assertProblem(problems, /does not exist/);
  });
});

describe("assemble, with the real signature check and keys from the test run", () => {
  const perTargetKeys = () => Object.fromEntries(TARGETS.map(({ triple }) => [triple, makeTestKey()]));

  /** assemble() over a dry run's tree, signed with `keys` (by default fresh per-target keys), as the CLI runs it. */
  const assembleDryRun = (options = {}) => {
    const { keys = perTargetKeys(), ...tree } = options;
    const inDir = inputTree({ keys, pubkeyFiles: true, rehearsal: true, ...tree });
    return { inDir, ...assemble({ inDir, outDir: fresh("out"), version: V, ...dryRun(), extras: EXTRAS, now: NOW }) };
  };

  test("a dry run's per-target keys: every signature verifies, the rehearsal's among them", () => {
    const { assets, rehearsal, problems } = assembleDryRun();
    assert.deepEqual(problems, []);
    assert.deepEqual(assets, expectedAssets(V));
    assert.deepEqual(rehearsal, updaterArtifacts(V).map(({ asset }) => `${asset}.sig`).sort());
  });

  test("a bundle signed by another target's key: a key id problem, for its signature and the rehearsal's", () => {
    const keys = perTargetKeys();
    const inDir = inputTree({ keys, pubkeyFiles: true, rehearsal: true });
    writeFileSync(join(inDir, `bundles-${WINDOWS}`, "updater-pubkey.txt"), keys[LINUX].tauriPublicKey);
    const { problems } = assemble({ inDir, outDir: fresh("out"), version: V, ...dryRun(), extras: EXTRAS, now: NOW });
    assert.equal(problems.length, 2, problems.join("\n"));
    assertProblem(problems, /^bad signature for Fleetify_0\.2\.0_x64-setup\.exe/, /key id/);
    assertProblem(problems, /^bad rehearsal signature for Fleetify_0\.2\.0_x64-setup\.exe/, /key id/);
  });

  test("a rehearsal signature must name the rehearsal's version: the release's, or none, is a problem", () => {
    const base = (name) => `timestamp:1795238473\tfile:${name}`;
    const released = assembleDryRun({ rehearsalComment: (name) => (name === DEB ? `${base(name)}\tversion:${V}` : `${base(name)}\tversion:${REHEARSAL_VERSION}`) });
    assert.deepEqual(released.problems, [`bad rehearsal signature for ${DEB}: signed for version "0.2.0", not 99.0.0`]);
    const none = assembleDryRun({ rehearsalComment: (name) => (name === APPIMAGE ? base(name) : `${base(name)}\tversion:${REHEARSAL_VERSION}`) });
    assert.equal(none.problems.length, 1, none.problems.join("\n"));
    assertProblem(none.problems, literal(`bad rehearsal signature for ${APPIMAGE}: the trusted comment names no version, so the signature isn't bound to 99.0.0`));
  });

  test("the release's own signatures can't stand in for the rehearsal's: they name the release's version", () => {
    const keys = perTargetKeys();
    const inDir = inputTree({ keys, pubkeyFiles: true, rehearsal: true });
    for (const { triple } of TARGETS) {
      for (const asset of updaterAssets(triple, V)) copyFileSync(join(inDir, `bundles-${triple}`, `${asset}.sig`), join(inDir, `rehearsal-${triple}`, `${asset}.sig`));
    }
    const { problems } = assemble({ inDir, outDir: fresh("out"), version: V, ...dryRun(), extras: EXTRAS, now: NOW });
    assert.deepEqual(
      problems,
      updaterArtifacts(V).map(({ asset }) => `bad rehearsal signature for ${asset}: signed for version "0.2.0", not 99.0.0`),
    );
  });

  test("the trusted comment's version: field must name the release version: any other, or none, is a problem", () => {
    const signed = (comment) => assembleDryRun({ comment });
    const base = (name) => `timestamp:1795238472\tfile:${name}`;
    const release = (name) => `${base(name)}\tversion:0.2.0`;
    assert.deepEqual(signed(release).problems, []);
    const other = signed((name) => (name === DEB ? `${base(name)}\tversion:0.1.0` : release(name)));
    assert.deepEqual(other.problems, [`bad signature for ${DEB}: signed for version "0.1.0", not 0.2.0`]);
    assert.deepEqual(other.assets, []);
    // As tauri-cli 2.11.2 signed, and tauri signer sign without --app-version.
    const none = signed((name) => (name === APPIMAGE ? base(name) : release(name)));
    assert.equal(none.problems.length, 1, none.problems.join("\n"));
    assertProblem(none.problems, literal(`bad signature for ${APPIMAGE}: the trusted comment names no version, so the signature isn't bound to 0.2.0`));
    assert.deepEqual(none.assets, []);
  });

  test("a release run, against one key from its config: a signature without the version is a problem too", () => {
    const key = makeTestKey();
    const keys = Object.fromEntries(TARGETS.map(({ triple }) => [triple, key]));
    const config = join(fresh("conf"), "tauri.conf.json");
    mkdirSync(join(config, ".."));
    writeFileSync(config, JSON.stringify({ plugins: { updater: { pubkey: key.tauriPublicKey } } }));
    const inDir = inputTree({ keys, comment: (name) => `timestamp:1795238472\tfile:${name}` });
    const { assets, problems } = assemble({ inDir, outDir: fresh("out"), version: V, pubkeys: { config, expectKeyId: key.keyId }, extras: EXTRAS, now: NOW });
    assert.equal(problems.length, updaterArtifacts(V).length, problems.join("\n"));
    for (const { asset } of updaterArtifacts(V)) assertProblem(problems, literal(`bad signature for ${asset}: the trusted comment names no version`));
    assert.deepEqual(assets, []);
  });

  test("one key from a config: verifies; a changed byte in a bundle: a problem", () => {
    const key = makeTestKey();
    const keys = Object.fromEntries(TARGETS.map(({ triple }) => [triple, key]));
    const config = join(fresh("conf"), "tauri.conf.json");
    mkdirSync(join(config, ".."));
    writeFileSync(config, JSON.stringify({ plugins: { updater: { pubkey: key.tauriPublicKey } } }));
    const pubkeys = { config, expectKeyId: key.keyId };

    const inDir = inputTree({ keys });
    assert.deepEqual(assemble({ inDir, outDir: fresh("out"), version: V, pubkeys, extras: EXTRAS, now: NOW }).problems, []);

    const deb = join(inDir, `bundles-${LINUX}`, DEB);
    const bytes = readFileSync(deb);
    bytes[0] ^= 0x01;
    writeFileSync(deb, bytes);
    const { problems } = assemble({ inDir, outDir: fresh("out"), version: V, pubkeys, extras: EXTRAS, now: NOW });
    assert.deepEqual(problems, [`bad signature for ${DEB}: signature does not match the data`]);
  });
});

describe("the CLI", () => {
  const cli = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });

  test("a signed dry-run tree: exit 0, listing the assets, the rehearsal's signatures, and each key and version that verified them", () => {
    const keys = Object.fromEntries(TARGETS.map(({ triple }) => [triple, makeTestKey()]));
    const inDir = inputTree({ keys, pubkeyFiles: true, rehearsal: true });
    const outDir = fresh("out");
    const rehearsalOut = fresh("rehearsal");
    const result = cli("--in", inDir, "--out", outDir, "--version", V, "--per-target-pubkeys", "--rehearsal-out", rehearsalOut, ...extraArgs());
    assert.equal(result.status, 0, result.stderr);
    for (const asset of expectedAssets(V)) assert.ok(result.stdout.includes(asset), result.stdout);
    for (const key of Object.values(keys)) assert.ok(result.stdout.includes(key.keyId), result.stdout);
    for (const { asset } of updaterArtifacts(V)) {
      const name = asset.replaceAll(".", "\\.");
      assert.match(result.stdout, new RegExp(`signature ok, key [0-9A-F]{16}, version 0\\.2\\.0: ${name} `), asset);
      assert.match(result.stdout, new RegExp(`rehearsal signature ok, key [0-9A-F]{16}, version 99\\.0\\.0: ${name}\\n`), asset);
    }
    assert.ok(result.stdout.includes(`6 rehearsal signatures in ${rehearsalOut}`), result.stdout);
    assert.deepEqual(readdirSync(outDir).sort(), expectedAssets(V));
    assert.deepEqual(readdirSync(rehearsalOut).sort(), updaterArtifacts(V).map(({ asset }) => `${asset}.sig`).sort());
  });

  test("a release run whose configured key isn't the expected one: exit 1, saying why, nothing written", () => {
    const key = makeTestKey();
    const keys = Object.fromEntries(TARGETS.map(({ triple }) => [triple, key]));
    const config = join(fresh("conf"), "tauri.conf.json");
    mkdirSync(join(config, ".."));
    writeFileSync(config, JSON.stringify({ plugins: { updater: { pubkey: key.tauriPublicKey } } }));
    const outDir = fresh("out");
    const result = cli(
      "--in", inputTree({ keys }), "--out", outDir, "--version", V,
      "--pubkey-config", config, "--expect-key-id", UPDATER_KEY_ID, ...extraArgs(),
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /key id/);
    assert.ok(result.stderr.includes(key.keyId), result.stderr);
    assert.equal(existsSync(outDir), false);
  });

  test("usage errors: exit 2", () => {
    const inDir = inputTree();
    const base = ["--in", inDir, "--out", fresh("out"), "--version", V];
    for (const args of [
      [],
      base,
      [...base, "--per-target-pubkeys", "--pubkey-config", CONFIG, "--expect-key-id", UPDATER_KEY_ID],
      [...base, "--pubkey-config", CONFIG],
      [...base, "--expect-key-id", UPDATER_KEY_ID],
      [...base, "--pubkey-config", CONFIG, "--expect-key-id", "44C69471"],
      [...base, "--per-target-pubkeys", "--rehearsal-out", fresh("rehearsal"), "--bogus"],
      [...base, "--per-target-pubkeys", "--rehearsal-out", fresh("rehearsal"), "--extra"],
      ["--in", inDir, "--out", fresh("out"), "--per-target-pubkeys", "--rehearsal-out", fresh("rehearsal")],
      [...base, "--version", V, "--per-target-pubkeys", "--rehearsal-out", fresh("rehearsal")],
      // The rehearsal's signatures go with a dry run's per-target keys, and only with them.
      [...base, "--per-target-pubkeys"],
      [...base, "--per-target-pubkeys", "--rehearsal-out"],
      [...base, "--pubkey-config", CONFIG, "--expect-key-id", UPDATER_KEY_ID, "--rehearsal-out", fresh("rehearsal")],
      [...base, "--per-target-pubkeys", "--rehearsal-out", fresh("rehearsal"), "--rehearsal-out", fresh("rehearsal")],
    ]) {
      const result = cli(...args);
      assert.equal(result.status, 2, `${args.join(" ")}\n${result.stderr}`);
      assert.match(result.stderr, /usage:/);
    }
  });
});
