/**
 * Tests for provenance.mjs, which checks that an attestation bundle attests
 * exactly a release's files before it copies the bundle beside them.
 *
 *   node --test scripts/release/provenance.test.mjs
 */
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { PAYLOAD_TYPE, PREDICATE_TYPE, STATEMENT_TYPE, provenanceProblems, releaseFiles } from "./provenance.mjs";

const SCRIPT = fileURLToPath(new URL("./provenance.mjs", import.meta.url));

const ROOT = mkdtempSync(join(tmpdir(), "provenance-"));
after(() => rmSync(ROOT, { recursive: true, force: true }));
let count = 0;

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

/** A release's files, each holding its name: name → text. */
const FILES = { "Fleetify_1.2.3_amd64.AppImage": "AppImage\n", "latest.json": "{}\n", SHA256SUMS: "sums\n" };

/** The files as releaseFiles() lists them. */
const entries = (files = FILES) =>
  Object.entries(files)
    .map(([name, text]) => ({ name, sha256: sha256(text) }))
    .sort((a, b) => (a.name < b.name ? -1 : 1));

/**
 * A bundle as actions/attest writes it: one line, a Sigstore bundle whose
 * DSSE envelope carries the statement. `statement` and `bundle` change what
 * the defaults give.
 */
function bundleText({ subjects = entries().map(({ name, sha256 }) => ({ name, digest: { sha256 } })), statement = {}, bundle = {}, envelope = {} } = {}) {
  const payload = { _type: STATEMENT_TYPE, subject: subjects, predicateType: PREDICATE_TYPE, predicate: { buildDefinition: {}, runDetails: {} }, ...statement };
  const full = {
    mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
    verificationMaterial: { certificate: { rawBytes: "Y2VydA==" }, tlogEntries: [] },
    dsseEnvelope: { payload: Buffer.from(JSON.stringify(payload)).toString("base64"), payloadType: PAYLOAD_TYPE, signatures: [{ sig: "c2ln" }], ...envelope },
    ...bundle,
  };
  return `${JSON.stringify(full)}\n`;
}

/** A new folder holding `files` (name → text). */
function folder(files = FILES) {
  const dir = join(ROOT, `dir-${(count += 1)}`);
  mkdirSync(dir);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

/** A bundle file holding `text`, outside any release folder. */
function bundleFile(text = bundleText()) {
  const file = join(ROOT, `bundle-${(count += 1)}.jsonl`);
  writeFileSync(file, text);
  return file;
}

const cli = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });

describe("provenanceProblems", () => {
  test("a bundle that attests exactly the release's files: no problems", () => {
    assert.deepEqual(provenanceProblems(bundleText(), entries()), []);
  });

  test("a file it doesn't attest, a subject the release doesn't have, and a file of other bytes are each a problem", () => {
    const byName = Object.fromEntries(entries().map((entry) => [entry.name, entry]));
    const appImage = byName["Fleetify_1.2.3_amd64.AppImage"];
    const latest = byName["latest.json"];
    const subjects = [
      { name: appImage.name, digest: { sha256: sha256("another AppImage\n") } },
      { name: latest.name, digest: { sha256: latest.sha256 } },
      { name: "Fleetify_1.2.2_amd64.AppImage", digest: { sha256: sha256("old\n") } },
    ];
    assert.deepEqual(provenanceProblems(bundleText({ subjects }), entries()), [
      `the bundle attests another ${appImage.name} (SHA-256 ${sha256("another AppImage\n")}, not ${appImage.sha256})`,
      "the bundle doesn't attest SHA256SUMS",
      "the bundle attests Fleetify_1.2.2_amd64.AppImage, which the release doesn't have",
    ]);
  });

  test("a subject named twice, or without a name or a SHA-256, is a problem", () => {
    const subjects = entries().map(({ name, sha256 }) => ({ name, digest: { sha256 } }));
    const twice = provenanceProblems(bundleText({ subjects: [...subjects, subjects[0]] }), entries());
    assert.deepEqual(twice, [`the bundle attests ${subjects[0].name} twice`]);
    for (const odd of [{ digest: { sha256: sha256("x") } }, { name: "x", digest: { sha512: "ab" } }, { name: "x", digest: { sha256: "ABC" } }, "x"]) {
      const problems = provenanceProblems(bundleText({ subjects: [...subjects, odd] }), entries());
      assert.equal(problems.length, 1, JSON.stringify(odd));
      assert.match(problems[0], /which isn't a file with a SHA-256$/);
    }
  });

  test("anything but one line of a Sigstore bundle of SLSA build provenance is refused", () => {
    const good = bundleText();
    for (const [why, text, message] of [
      ["two attestations", `${good}${good}`, /isn't one line of JSON/],
      ["pretty-printed", JSON.stringify(JSON.parse(good), null, 2), /isn't one line of JSON/],
      ["not JSON", "not json\n", /isn't JSON/],
      ["an array", "[]\n", /isn't a Sigstore bundle/],
      ["another media type", bundleText({ bundle: { mediaType: "application/json" } }), /isn't a Sigstore bundle/],
      ["no envelope", bundleText({ bundle: { dsseEnvelope: undefined } }), /doesn't carry an in-toto statement/],
      ["another payload type", bundleText({ envelope: { payloadType: "text/plain" } }), /doesn't carry an in-toto statement/],
      ["a payload that isn't JSON", bundleText({ envelope: { payload: Buffer.from("{").toString("base64") } }), /statement isn't JSON/],
      ["another statement type", bundleText({ statement: { _type: "https://in-toto.io/Statement/v0.1" } }), /isn't an in-toto statement/],
      ["a release attestation", bundleText({ statement: { predicateType: "https://in-toto.io/attestation/release/v0.2" } }), /not SLSA build provenance/],
      ["no subject", bundleText({ subjects: [] }), /has no subject/],
    ]) {
      const problems = provenanceProblems(text, entries());
      assert.equal(problems.length, 1, `${why}: ${problems.join("; ")}`);
      assert.match(problems[0], message, why);
    }
  });

  test("a later 0.x bundle version is a Sigstore bundle too; no final newline is fine", () => {
    assert.deepEqual(provenanceProblems(bundleText({ bundle: { mediaType: "application/vnd.dev.sigstore.bundle.v0.4+json" } }), entries()), []);
    assert.deepEqual(provenanceProblems(bundleText().trimEnd(), entries()), []);
    const v02 = provenanceProblems(bundleText({ bundle: { mediaType: "application/vnd.dev.sigstore.bundle.v0.2+json" } }), entries());
    assert.deepEqual(v02, ["the bundle isn't a Sigstore bundle"]);
  });
});

describe("releaseFiles", () => {
  test("lists each file with its SHA-256, sorted by name", () => {
    assert.deepEqual(releaseFiles(folder()), { files: entries(), problems: [] });
  });

  test("a folder, a symlink, or no file at all in the release folder is a problem", () => {
    const dir = folder({ "latest.json": "{}\n" });
    mkdirSync(join(dir, "nested"));
    symlinkSync(join(dir, "latest.json"), join(dir, "link.json"));
    assert.deepEqual(releaseFiles(dir).problems, ["link.json in the release folder is not a regular file", "nested in the release folder is not a regular file"]);
    assert.deepEqual(releaseFiles(folder({})).problems, ["the release folder is empty"]);
  });
});

describe("the CLI", () => {
  test("copies a bundle that attests exactly the release, byte for byte, to a new file in a new folder", () => {
    const text = bundleText();
    const out = join(ROOT, `out-${(count += 1)}`, "provenance", "provenance.intoto.jsonl");
    const result = cli("--bundle", bundleFile(text), "--release", folder(), "--out", out);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(out, "utf8"), text);
    assert.match(result.stdout, /attests the 3 files of /);
  });

  test("refuses a bundle that doesn't, listing why, and writes nothing", () => {
    const out = join(ROOT, `out-${(count += 1)}.jsonl`);
    const result = cli("--bundle", bundleFile(), "--release", folder({ ...FILES, "install.sh": "#!/bin/sh\n" }), "--out", out);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /the bundle doesn't attest install\.sh/);
    assert.match(result.stderr, /isn't the build provenance of .*, so it isn't kept/);
    assert.equal(existsSync(out), false);
  });

  test("never writes over a file that is there already", () => {
    const out = join(ROOT, `out-${(count += 1)}.jsonl`);
    writeFileSync(out, "kept\n");
    const result = cli("--bundle", bundleFile(), "--release", folder(), "--out", out);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /EEXIST/);
    assert.equal(readFileSync(out, "utf8"), "kept\n");
  });

  test("a bundle or a release folder that isn't there is a problem", () => {
    const out = join(ROOT, `out-${(count += 1)}.jsonl`);
    assert.equal(cli("--bundle", join(ROOT, "none.jsonl"), "--release", folder(), "--out", out).status, 1);
    assert.equal(cli("--bundle", bundleFile(), "--release", join(ROOT, "none"), "--out", out).status, 1);
    assert.equal(existsSync(out), false);
  });

  test("usage: each flag once with a value, and the output outside the release folder", () => {
    const release = folder();
    const bundle = bundleFile();
    for (const args of [
      [],
      ["--bundle", bundle, "--release", release],
      ["--bundle", bundle, "--release", release, "--out"],
      ["--bundle", bundle, "--bundle", bundle, "--release", release, "--out", join(ROOT, "x.jsonl")],
      ["--bundle", bundle, "--release", release, "--out", join(ROOT, "x.jsonl"), "--force", "yes"],
      ["--bundle", bundle, "--release", release, "--out", join(release, "provenance.intoto.jsonl")],
      ["--bundle", bundle, "--release", release, "--out", join(release, "sub", "provenance.intoto.jsonl")],
      ["--bundle", bundle, "--release", release, "--out", release],
      ["--bundle", bundle, "--release", release, "--out", join(release, "..p.jsonl")],
    ]) {
      const result = cli(...args);
      assert.equal(result.status, 2, `${args.join(" ")}: ${result.stderr}`);
      assert.match(result.stderr, /usage: node scripts\/release\/provenance\.mjs/);
    }
    assert.match(cli("--bundle", bundle, "--release", release, "--out", join(release, "p.jsonl")).stderr, /must be outside the release folder/);
  });
});
