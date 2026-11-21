/**
 * Tests for third-party-notices.mjs, which writes THIRD-PARTY-NOTICES in the
 * release build.
 *
 *   node --test scripts/release/third-party-notices.test.mjs
 *
 * Nothing here runs cargo or npm. The cargo-about output and the
 * package-lock excerpt come from fixtures/notices/, and the node_modules tree
 * is built in a temp dir. Every licence text is made up, so no real author's
 * contact details can end up in the repo.
 */
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  NO_LICENCE_FILE,
  STANDARD_TEXTS,
  npmProductionPackages,
  packageFileReader,
  renderNotices,
  rustLicences,
  whisperCppLicence,
} from "./third-party-notices.mjs";

const SCRIPT = fileURLToPath(new URL("./third-party-notices.mjs", import.meta.url));

/** A fixture's text, by its name under fixtures/notices/. */
const fixture = (name) =>
  readFileSync(new URL(`./fixtures/notices/${name}`, import.meta.url), "utf8");
/** A repo file's text, by its path from the repo root. */
const repoFile = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

// Not named package-lock.json: GitHub's dependency graph would read the
// fixture's made-up packages as the repo's own.
const LOCK = JSON.parse(fixture("package-lock.excerpt.json"));
const ABOUT = JSON.parse(fixture("cargo-about.json"));

// Made-up licence texts. Some are awkward on purpose (CRLF line endings, no
// final newline, trailing spaces and blank lines): all of it must survive.
const TEXT = {
  alpha: "Fixture licence for alpha.\n\nCopyright (c) 2026 The Alpha Fixture Authors\n\nUse it in tests only.\n",
  betaApache: "Fixture Apache-style licence for @scope/beta.\r\n\r\nLicensed for tests only.\r\n",
  betaNotice: "@scope/beta\nCopyright 2026 The Beta Fixture Project\n\nThis product includes fixture software.",
  delta: "Fixture BSD-style licence for delta.  \n\n\n",
  gamma2: "Fixture ISC-style licence for gamma 2.\n",
  gamma3: "Fixture ISC-style licence for gamma 3.\n",
  realName: "Fixture MIT-style licence for real-name.\n",
  typesOnly: "Fixture MIT-style licence for types-only.\n",
};

/** The fixture lock's node_modules tree: path from the project root → content. */
const TREE = {
  "node_modules/alpha/LICENSE": TEXT.alpha,
  "node_modules/alpha/README.md": "# alpha\n",
  "node_modules/alpha/index.js": "export default 1;\n",
  "node_modules/alpha/node_modules/gamma/license.md": TEXT.gamma2,
  "node_modules/gamma/LICENCE.txt": TEXT.gamma3,
  "node_modules/@scope/beta/LICENSE-APACHE": TEXT.betaApache,
  "node_modules/@scope/beta/NOTICE": TEXT.betaNotice,
  "node_modules/@scope/beta/node_modules/delta/COPYING": TEXT.delta,
  "node_modules/delta/COPYING": TEXT.delta,
  "node_modules/aliased/LICENSE": TEXT.realName,
  "node_modules/types-only/LICENSE": TEXT.typesOnly,
  "node_modules/standard-only/index.js": "export default 2;\n",
  "node_modules/dev-tool/LICENSE": "Fixture licence for dev-tool.\n",
  "packages/linked-workspace/LICENSE": "Fixture licence for linked-workspace.\n",
};

const ROOT = mkdtempSync(join(tmpdir(), "third-party-notices-"));
after(() => rmSync(ROOT, { recursive: true, force: true }));

let trees = 0;
/** A fresh copy of TREE in a temp dir, with `changes` applied; null leaves a file out. */
function tree(changes = {}) {
  trees += 1;
  const dir = join(ROOT, `tree-${trees}`);
  mkdirSync(dir);
  for (const [rel, content] of Object.entries({ ...TREE, ...changes })) {
    if (content === null) continue;
    const file = join(dir, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  return dir;
}

/** The fixture's one package published without a licence file. */
const LISTED = { "standard-only": "MIT" };
const npm = (dir = tree(), options = { noLicenceFile: LISTED }) =>
  npmProductionPackages(LOCK, packageFileReader(dir), options);

// The fixture workspace's own crates, as `cargo metadata` lists them.
const WORKSPACE = new Set([
  "path+file:///fixture/workspace/app#fleetify-fixture-app@0.1.0",
  "path+file:///fixture/workspace/core#fleetify-fixture-core@0.1.0",
]);

const FRAMEWORK_MIT =
  "Fixture MIT licence of framework-rs.\n\nCopyright (c) 2026 The Framework Fixture Contributors\n";
const FRAMEWORK_APACHE = "Fixture Apache licence of framework-rs.\n";
const FRAMEWORK_FILES = [
  { file: "LICENSE_APACHE-2.0", text: FRAMEWORK_APACHE },
  { file: "LICENSE_MIT", text: FRAMEWORK_MIT },
];
/** The licence files in each crate folder that the fixture's standard-text licences cover. */
const CRATE_FILES = new Map([
  ["/fixture/registry/framework-rs-2.0.0", FRAMEWORK_FILES],
  ["/fixture/workspace/vendor/framework-macros", FRAMEWORK_FILES],
  ["/fixture/registry/bare-rs-0.1.0", []],
  ["/fixture/registry/sync-thing-1.0.2", []],
  ["/fixture/registry/binding-sys-0.15.0", []],
]);
function readCrateFiles(dir) {
  if (!CRATE_FILES.has(dir)) throw new Error(`read the licence files of ${dir}`);
  return CRATE_FILES.get(dir);
}
const rust = () => rustLicences(ABOUT, { exclude: WORKSPACE, readCrateFiles });

const WHISPER_DIR = "/fixture/registry/whisper-rs-sys-0.15.0";
const WHISPER_TEXT =
  "MIT License\n\nCopyright (c) 2026 The Fixture ggml Authors\n\nPermission is granted to use this fixture in tests.\n";
const METADATA = {
  packages: [
    { name: "whisper-rs", version: "0.16.0", manifest_path: "/fixture/registry/whisper-rs-0.16.0/Cargo.toml" },
    { name: "whisper-rs-sys", version: "0.15.0", manifest_path: `${WHISPER_DIR}/Cargo.toml` },
  ],
  workspace_members: [...WORKSPACE],
};
/** readText for whisperCppLicence: the fixture licence at its path, ENOENT anywhere else. */
function readWhisper(path) {
  if (path === join(WHISPER_DIR, "whisper.cpp", "LICENSE")) return WHISPER_TEXT;
  throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), { code: "ENOENT" });
}
const bundled = () => [whisperCppLicence(METADATA, { readText: readWhisper })];

const notices = (input = {}) =>
  renderNotices({ version: "1.2.3", rust: rust(), npm: npm(), bundled: bundled(), ...input });

const HEADINGS = ["Rust crates", "npm packages", "Bundled C/C++ source", "Linux AppImage"];
const lines = (text) => text.split("\n");
/** How many lines of `text` are exactly `line`. */
const countLines = (text, line) => lines(text).filter((l) => l === line).length;
/** How many times `part` occurs in `text`. */
const occurrences = (text, part) => text.split(part).length - 1;
/** The notices from the section heading `title` up to the next section heading. */
function section(out, title) {
  const all = lines(out);
  const start = all.indexOf(title);
  assert.ok(start >= 0, `no "${title}" heading`);
  const next = HEADINGS.map((h) => all.indexOf(h)).filter((i) => i > start);
  return all.slice(start, next.length ? Math.min(...next) : all.length).join("\n");
}
const label = (c) => `${c.name} ${c.version}`;

describe("npmProductionPackages", () => {
  test("every production package appears once, and no dev, other-platform or linked package does", () => {
    const packages = npm();
    assert.deepEqual(
      packages.map((p) => `${p.name} ${p.version} ${p.license}`),
      [
        "@scope/beta 2.0.0 Apache-2.0",
        "alpha 1.2.3 MIT",
        "delta 1.0.0 BSD-3-Clause",
        "gamma 2.0.0 ISC",
        "gamma 3.1.0 ISC",
        "real-name 4.0.0 MIT",
        "standard-only 1.0.0 MIT",
        "types-only 0.1.0 MIT",
      ],
    );

    const out = notices();
    const part = section(out, "npm packages");
    for (const p of packages) assert.equal(countLines(part, label(p)), 1, label(p));
    for (const name of ["dev-tool", "@esbuild/darwin-arm64", "@scope/native-linux-x64", "linked-workspace"]) {
      assert.ok(!out.includes(name), `${name} is in the notices`);
    }
  });

  test("each package brings its licence and NOTICE files, and nothing else", () => {
    const packages = npm();
    assert.deepEqual(packages.find((p) => p.name === "@scope/beta").texts, [
      { file: "LICENSE-APACHE", text: TEXT.betaApache },
      { file: "NOTICE", text: TEXT.betaNotice },
    ]);
    assert.deepEqual(packages.find((p) => p.name === "alpha").texts, [
      { file: "LICENSE", text: TEXT.alpha },
    ]);
  });

  test("a production package without a licence file throws, naming the package", () => {
    assert.throws(
      () => npm(tree({ "node_modules/alpha/LICENSE": null })),
      /^Error: alpha 1\.2\.3 \(node_modules\/alpha\) has no licence file .*NO_LICENCE_FILE/,
    );
    // A NOTICE file is not a licence.
    assert.throws(
      () => npm(tree({ "node_modules/@scope/beta/LICENSE-APACHE": null })),
      /^Error: @scope\/beta 2\.0\.0 \(node_modules\/@scope\/beta\) has no licence file/,
    );
    // Not even the fixture's standard-only package passes when it isn't listed.
    assert.throws(
      () => npm(tree(), { noLicenceFile: {} }),
      /^Error: standard-only 1\.0\.0 \(node_modules\/standard-only\) has no licence file/,
    );
  });

  test("a listed package without a licence file gets its licence's standard text", () => {
    const pkg = npm().find((p) => p.name === "standard-only");
    assert.equal(pkg.standard, true);
    assert.deepEqual(pkg.texts, [{ file: null, text: STANDARD_TEXTS.MIT }]);
  });

  test("a listed package that now declares another licence throws", () => {
    assert.throws(
      () => npm(tree(), { noLicenceFile: { "standard-only": "ISC" } }),
      /standard-only 1\.0\.0 declares MIT/,
    );
  });

  test("a production package missing from node_modules throws, naming it", () => {
    // gamma's only file left out: its folder is never created.
    assert.throws(() => npm(tree({ "node_modules/gamma/LICENCE.txt": null })), /node_modules\/gamma is not installed/);
  });

  test("the order of the lock's entries doesn't matter", () => {
    const reversed = {
      ...LOCK,
      packages: Object.fromEntries(Object.entries(LOCK.packages).reverse()),
    };
    const dir = tree();
    assert.deepEqual(
      npmProductionPackages(reversed, packageFileReader(dir), { noLicenceFile: LISTED }),
      npm(dir),
    );
  });

  test("every package that NO_LICENCE_FILE lists names a licence with a standard text", () => {
    for (const [name, licence] of Object.entries(NO_LICENCE_FILE)) {
      assert.equal(typeof STANDARD_TEXTS[licence], "string", `${name}: ${licence}`);
      assert.ok(STANDARD_TEXTS[licence].length > 0, `${name}: ${licence}`);
    }
  });
});

describe("rustLicences", () => {
  test("leaves out the workspace's own crates, and a licence that only they use", () => {
    const groups = rust();
    const crates = groups.flatMap((g) => g.crates.map(label));
    assert.ok(!crates.includes("fleetify-fixture-app 0.1.0"));
    assert.ok(!crates.includes("fleetify-fixture-core 0.1.0"));
    assert.ok(!groups.some((g) => g.id === "ISC"));
    // A path crate that isn't a workspace member is third-party code: it stays.
    assert.ok(crates.includes("framework-macros 2.0.0"));
  });

  test("gives each licence text once, with its crates sorted by name and version", () => {
    assert.deepEqual(
      rust().map((g) => ({ id: g.id, standard: g.standard, crates: g.crates.map(label) })),
      [
        { id: "Apache-2.0", standard: true, crates: ["sync-thing 1.0.2"] },
        { id: "MIT", standard: false, crates: ["alpha-rs 1.0.0", "beta-rs 0.2.0"] },
        { id: "MIT", standard: true, crates: ["bare-rs 0.1.0", "framework-macros 2.0.0", "framework-rs 2.0.0"] },
        { id: "MIT", standard: false, crates: ["gamma-rs 0.3.0"] },
        { id: "Unlicense", standard: true, crates: ["binding-sys 0.15.0"] },
      ],
    );
  });

  test("a licence in its standard text carries the licence files its crates ship, once per file", () => {
    const groups = rust();
    assert.deepEqual(
      groups.map((g) => g.files.map((f) => ({ file: f.file, text: f.text, crates: f.crates.map(label) }))),
      [
        [],
        [],
        [
          { file: "LICENSE_APACHE-2.0", text: FRAMEWORK_APACHE, crates: ["framework-macros 2.0.0", "framework-rs 2.0.0"] },
          { file: "LICENSE_MIT", text: FRAMEWORK_MIT, crates: ["framework-macros 2.0.0", "framework-rs 2.0.0"] },
        ],
        [],
        [],
      ],
    );
  });
});

describe("whisperCppLicence", () => {
  test("reads whisper.cpp/LICENSE beside whisper-rs-sys's manifest", () => {
    assert.deepEqual(whisperCppLicence(METADATA, { readText: readWhisper }), {
      name: "whisper.cpp and ggml",
      from: "whisper-rs-sys 0.15.0",
      licence: "MIT",
      file: "whisper.cpp/LICENSE",
      text: WHISPER_TEXT,
    });
  });

  test("a missing whisper.cpp licence throws", () => {
    const missing = () => {
      throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
    };
    assert.throws(() => whisperCppLicence(METADATA, { readText: missing }), /whisper\.cpp/);
    assert.throws(() => whisperCppLicence(METADATA, { readText: () => "" }), /whisper\.cpp/);
  });

  test("a whisper.cpp licence that isn't MIT throws", () => {
    assert.throws(
      () => whisperCppLicence(METADATA, { readText: () => "Fixture licence of another kind.\n" }),
      /MIT/,
    );
  });

  test("a graph without whisper-rs-sys throws", () => {
    const metadata = { ...METADATA, packages: METADATA.packages.filter((p) => p.name !== "whisper-rs-sys") };
    assert.throws(() => whisperCppLicence(metadata, { readText: readWhisper }), /whisper-rs-sys/);
  });
});

describe("renderNotices", () => {
  test("opens with the version, then has the four sections in order", () => {
    const out = notices();
    assert.equal(lines(out)[0], "Third-party notices for Fleetify 1.2.3");
    const at = HEADINGS.map((h) => lines(out).indexOf(h));
    assert.ok(at.every((i) => i > 0), `headings at ${at}`);
    assert.deepEqual([...at].sort((a, b) => a - b), at);
    for (const h of HEADINGS) assert.equal(countLines(out, h), 1, h);
  });

  test("licence texts are verbatim", () => {
    const out = notices();
    for (const [name, text] of Object.entries(TEXT)) assert.ok(out.includes(text), name);
    for (const g of ABOUT.licenses.filter((l) => l.id !== "ISC")) assert.ok(out.includes(g.text), g.id);
    assert.ok(out.includes(FRAMEWORK_MIT));
    assert.ok(out.includes(FRAMEWORK_APACHE));
    assert.ok(out.includes(WHISPER_TEXT));
    assert.ok(out.includes(STANDARD_TEXTS.MIT));
  });

  test("each text appears once, however many crates or copies share it", () => {
    const out = notices();
    assert.equal(occurrences(out, ABOUT.licenses[1].text), 1); // alpha-rs and beta-rs
    assert.equal(occurrences(out, FRAMEWORK_MIT), 1); // framework-rs and framework-macros
    assert.equal(occurrences(out, TEXT.delta), 1); // two copies of delta 1.0.0
    assert.ok(!out.includes("Fixture ISC licence text."), "a licence only the workspace uses");
  });

  test("lists each crate under its licence by name and version", () => {
    const part = lines(section(notices(), "Rust crates")).map((l) => l.trim());
    for (const crate of ["alpha-rs 1.0.0", "beta-rs 0.2.0", "framework-rs 2.0.0", "binding-sys 0.15.0", "sync-thing 1.0.2"]) {
      assert.ok(part.includes(crate), crate);
    }
    assert.ok(!part.includes("fleetify-fixture-app 0.1.0"));
  });

  test("names whisper.cpp and ggml under the bundled source, with the crate they come from", () => {
    const part = section(notices(), "Bundled C/C++ source");
    assert.match(part, /whisper\.cpp and ggml/);
    assert.match(part, /whisper-rs-sys 0\.15\.0/);
    assert.ok(part.includes(WHISPER_TEXT));
  });

  test("the output is deterministic", () => {
    const input = { version: "1.2.3", rust: rust(), npm: npm(), bundled: bundled() };
    const first = renderNotices(input);
    const shuffled = renderNotices({
      version: "1.2.3",
      rust: [...input.rust].reverse().map((g) => ({ ...g, crates: [...g.crates].reverse(), files: [...g.files].reverse() })),
      npm: [...input.npm].reverse(),
      bundled: [...input.bundled].reverse(),
    });
    assert.equal(shuffled, first);
    assert.equal(renderNotices(input), first);
  });

  test("it contains LINUX-APPIMAGE-LIBRARIES.txt", () => {
    assert.match(section(notices(), "Linux AppImage"), /LINUX-APPIMAGE-LIBRARIES\.txt/);
  });
});

describe("about.toml", () => {
  const about = repoFile("scripts/release/about.toml");
  const deny = repoFile("deny.toml");
  /** The strings in the TOML array `key = [ ... ]` that starts a line. */
  function tomlArray(text, key) {
    const match = text.match(new RegExp(`^${key} = \\[([^\\]]*)\\]`, "m"));
    assert.ok(match, `no ${key} = [...]`);
    return [...match[1].replace(/#.*$/gm, "").matchAll(/"([^"]*)"/g)].map((m) => m[1]);
  }

  test("accepts deny.toml's licences, then the ones deny.toml allows for single crates", () => {
    const exceptions = [...deny.matchAll(/\{ allow = \[([^\]]*)\], crate =/g)].flatMap((m) =>
      [...m[1].matchAll(/"([^"]*)"/g)].map((x) => x[1]),
    );
    assert.deepEqual(
      [...new Set(exceptions)],
      ["CDLA-Permissive-2.0", "Unlicense"],
    );
    assert.deepEqual(tomlArray(about, "accepted"), [...tomlArray(deny, "allow"), ...new Set(exceptions)]);
  });

  test("covers the four release targets, without dev or build dependencies", () => {
    assert.deepEqual(tomlArray(about, "targets").sort(), [
      "aarch64-apple-darwin",
      "x86_64-apple-darwin",
      "x86_64-pc-windows-msvc",
      "x86_64-unknown-linux-gnu",
    ]);
    assert.match(about, /^ignore-dev-dependencies = true$/m);
    assert.match(about, /^ignore-build-dependencies = true$/m);
  });
});

describe("the CLI", () => {
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });

  test("without --out it prints the usage and exits 2", () => {
    const r = run();
    assert.equal(r.status, 2);
    assert.match(r.stderr, /usage: node scripts\/release\/third-party-notices\.mjs --out <file>/);
  });

  test("an unknown argument exits 2", () => {
    assert.equal(run("--out", join(ROOT, "x"), "--bogus").status, 2);
  });
});
