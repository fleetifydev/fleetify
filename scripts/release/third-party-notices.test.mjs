/**
 * Tests for third-party-notices.mjs, which writes THIRD-PARTY-NOTICES in the
 * release build.
 *
 *   node --test scripts/release/third-party-notices.test.mjs
 *
 * Nothing here runs cargo or npm. The cargo-about and cargo metadata output
 * and the package-lock excerpt come from fixtures/notices/; the node_modules
 * tree, crate folders and whisper.cpp source are built in a temp dir or
 * stubbed. Every licence text is made up, so no real author's contact details
 * can end up in the repo.
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
  SHIPPED_BUILD_PACKAGES,
  STANDARD_TEXTS,
  compiledSources,
  crateDirectories,
  crateFiles,
  npmBuildPackages,
  npmProductionPackages,
  packageFileReader,
  packageTextReader,
  renderNotices,
  rustLicences,
  sourceNotices,
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
  "node_modules/with-holder/index.js": "export default 3;\n",
  "node_modules/with-holder/readme.md": "# with-holder\n\n## License\n\n[MIT][license] \u00a9 [A. Fixture Holder][author]\n",
  "node_modules/dev-tool/LICENSE": "Fixture licence for dev-tool.\n",
  "node_modules/unlisted-dev/LICENSE": "Fixture licence for unlisted-dev.\n",
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

/** The fixture's packages published without a licence file; with-holder's readme names its holder. */
const LISTED = {
  "standard-only": { licence: "MIT" },
  "with-holder": { licence: "MIT", holder: "A. Fixture Holder", source: "readme.md" },
};
const npm = (dir = tree(), options = { noLicenceFile: LISTED, readPackageText: packageTextReader(dir) }) =>
  npmProductionPackages(LOCK, packageFileReader(dir), options);
/** npmBuildPackages over the fixture lock, for the dev packages in `names`. */
const build = (names, dir = tree()) =>
  npmBuildPackages(LOCK, packageFileReader(dir), {
    names,
    noLicenceFile: LISTED,
    readPackageText: packageTextReader(dir),
  });
/** The standard MIT text with a holder in its copyright line. */
const MIT_WITH_HOLDER = STANDARD_TEXTS.MIT.replace(
  "Copyright (c) <year> <copyright holders>",
  "Copyright (c) A. Fixture Holder",
);

// `cargo metadata` for the fixture graph. The cargo-about fixture carries no
// manifest paths, so every crate folder below has to come from here.
const METADATA = JSON.parse(fixture("cargo-metadata.json"));
const WORKSPACE = new Set(METADATA.workspace_members);
const CRATE_DIRS = crateDirectories(METADATA);

const FRAMEWORK_MIT =
  "Fixture MIT licence of framework-rs.\n\nCopyright (c) 2026 The Framework Fixture Contributors\n";
const FRAMEWORK_APACHE = "Fixture Apache licence of framework-rs.\n";
const FRAMEWORK_FILES = [
  { file: "LICENSE_APACHE-2.0", text: FRAMEWORK_APACHE },
  { file: "LICENSE_MIT", text: FRAMEWORK_MIT },
];
const CRATE_TEXT = {
  alphaMit: "Fixture MIT licence file of alpha-rs.\n",
  alphaNotice: "alpha-rs\nCopyright 2026 The Alpha Fixture Authors\n\nThis crate includes fixture code.\n",
  betaThirdParty: "Fixture licences of the third-party code in beta-rs.\r\n",
  gammaCopyright: "Copyrights in gamma-rs are retained by its fixture contributors.  \n",
  dualBsd: "Fixture BSD-style licence text of dual-rs.\n",
  dualThirdParty: "Fixture third-party notices of dual-rs.",
  appNotice: "Fixture NOTICE of the fixture workspace app.\n",
};
/** The licence and notice files in each crate folder, as crateFiles would read them. */
const CRATE_FILES = new Map([
  ["/fixture/registry/alpha-rs-1.0.0", [
    { file: "LICENSE-MIT", text: CRATE_TEXT.alphaMit },
    { file: "NOTICE", text: CRATE_TEXT.alphaNotice },
  ]],
  ["/fixture/registry/beta-rs-0.2.0", [{ file: "LICENSE-THIRD-PARTY", text: CRATE_TEXT.betaThirdParty }]],
  ["/fixture/registry/gamma-rs-0.3.0", [{ file: "COPYRIGHT", text: CRATE_TEXT.gammaCopyright }]],
  ["/fixture/registry/dual-rs-1.0.0", [
    { file: "LICENSE-BSD", text: CRATE_TEXT.dualBsd },
    { file: "THIRD-PARTY-NOTICES", text: CRATE_TEXT.dualThirdParty },
  ]],
  ["/fixture/registry/framework-rs-2.0.0", FRAMEWORK_FILES],
  ["/fixture/workspace/vendor/framework-macros", FRAMEWORK_FILES],
  ["/fixture/registry/bare-rs-0.1.0", []],
  ["/fixture/registry/sync-thing-1.0.2", []],
  ["/fixture/registry/binding-sys-0.15.0", []],
  ["/fixture/workspace/app", [{ file: "NOTICE", text: CRATE_TEXT.appNotice }]],
  ["/fixture/workspace/core", []],
]);
function readCrateFiles(dir) {
  if (!CRATE_FILES.has(dir)) throw new Error(`read the files of ${dir}`);
  return CRATE_FILES.get(dir);
}
const rust = () => rustLicences(ABOUT, { exclude: WORKSPACE, crateDirs: CRATE_DIRS, readCrateFiles });

const WHISPER_DIR = "/fixture/registry/whisper-rs-sys-0.15.0";
const WHISPER_TEXT =
  "MIT License\n\nCopyright (c) 2026 The Fixture ggml Authors\n\nPermission is granted to use this fixture in tests.\n";
const ROPE_NOTICE =
  "// Fixture rope algorithm, after a fixture paper.\n// MIT licensed. Copyright (c) 2026 The Fixture Rope Authors.";
/** readText for whisperCppLicence: the fixture licence at its path, ENOENT anywhere else. */
function readWhisper(path) {
  if (path === join(WHISPER_DIR, "whisper.cpp", "LICENSE")) return WHISPER_TEXT;
  throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), { code: "ENOENT" });
}
/** findNotices for whisperCppLicence: one notice, found where the scan would report it. */
function findWhisperNotices(dir, licence) {
  assert.equal(dir, join(WHISPER_DIR, "whisper.cpp"));
  assert.equal(licence, WHISPER_TEXT);
  return [{ text: ROPE_NOTICE, places: [{ path: "ggml/src/ggml-cpu/ops.cpp", line: 12 }] }];
}
const bundled = () => [
  whisperCppLicence(METADATA, { readText: readWhisper, findNotices: findWhisperNotices }),
];

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
        "with-holder 2.0.0 MIT",
      ],
    );

    const out = notices();
    const part = section(out, "npm packages");
    for (const p of packages) assert.equal(countLines(part, label(p)), 1, label(p));
    for (const name of ["dev-tool", "unlisted-dev", "@esbuild/darwin-arm64", "@scope/native-linux-x64", "linked-workspace"]) {
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
    assert.equal(pkg.holder, null);
    assert.deepEqual(pkg.texts, [{ file: null, text: STANDARD_TEXTS.MIT }]);
  });

  test("a listed holder fills the standard text's copyright line, once the package's own file names it", () => {
    const pkg = npm().find((p) => p.name === "with-holder");
    assert.equal(pkg.standard, true);
    assert.equal(pkg.holder, "A. Fixture Holder");
    assert.equal(pkg.holderSource, "readme.md");
    assert.deepEqual(pkg.texts, [{ file: null, text: MIT_WITH_HOLDER }]);
  });

  test("a holder that the package's own file doesn't name throws", () => {
    const dir = tree({ "node_modules/with-holder/readme.md": "# with-holder\n\nNo licence section.\n" });
    assert.throws(() => npm(dir), /with-holder 2\.0\.0: readme\.md doesn't name A\. Fixture Holder/);
  });

  test("a listed package that now declares another licence throws", () => {
    assert.throws(
      () => npm(tree(), { noLicenceFile: { ...LISTED, "standard-only": { licence: "ISC" } } }),
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
      npmProductionPackages(reversed, packageFileReader(dir), {
        noLicenceFile: LISTED,
        readPackageText: packageTextReader(dir),
      }),
      npm(dir),
    );
  });

  test("every package that NO_LICENCE_FILE lists names a licence with a standard text", () => {
    for (const [name, { licence, holder, source }] of Object.entries(NO_LICENCE_FILE)) {
      assert.equal(typeof STANDARD_TEXTS[licence], "string", `${name}: ${licence}`);
      assert.ok(STANDARD_TEXTS[licence].length > 0, `${name}: ${licence}`);
      // A holder always comes with the file of the package that names it.
      assert.equal(typeof holder === "string", typeof source === "string", name);
    }
  });
});

describe("npmBuildPackages", () => {
  test("a listed dev package appears, marked as a build-time package whose output ships", () => {
    const packages = build(["dev-tool"]);
    assert.deepEqual(
      packages.map((p) => ({ label: label(p), license: p.license, build: p.build, texts: p.texts })),
      [{ label: "dev-tool 1.0.0", license: "MIT", build: true, texts: [{ file: "LICENSE", text: "Fixture licence for dev-tool.\n" }] }],
    );
    const part = section(notices({ npm: [...npm(), ...packages] }), "npm packages");
    assert.equal(countLines(part, "dev-tool 1.0.0"), 1);
    assert.ok(part.includes("dev-tool 1.0.0\nLicence: MIT\nA build-time package: its output ships in Fleetify's user interface.\n"));
  });

  test("an unlisted dev package doesn't", () => {
    const out = notices({ npm: [...npm(), ...build(["dev-tool"])] });
    assert.ok(!out.includes("unlisted-dev"));
    assert.ok(!out.includes("Fixture licence for unlisted-dev."));
  });

  test("a listed package missing from the lock throws", () => {
    assert.throws(() => build(["not-in-the-lock"]), /not-in-the-lock .*package-lock\.json/);
  });

  test("a listed package that ships as a production dependency isn't listed twice", () => {
    assert.deepEqual(build(["alpha"]), []);
  });

  test("every package in SHIPPED_BUILD_PACKAGES is a dev dependency in the repo's package-lock.json", () => {
    const lock = JSON.parse(repoFile("package-lock.json"));
    assert.ok(SHIPPED_BUILD_PACKAGES.length > 0);
    for (const name of SHIPPED_BUILD_PACKAGES) {
      assert.equal(lock.packages[`node_modules/${name}`]?.dev, true, name);
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
        { id: "BSD-3-Clause", standard: false, crates: ["dual-rs 1.0.0"] },
        { id: "MIT", standard: false, crates: ["alpha-rs 1.0.0", "beta-rs 0.2.0"] },
        { id: "MIT", standard: true, crates: ["bare-rs 0.1.0", "framework-macros 2.0.0", "framework-rs 2.0.0"] },
        { id: "MIT", standard: false, crates: ["dual-rs 1.0.0", "gamma-rs 0.3.0"] },
        { id: "Unlicense", standard: true, crates: ["binding-sys 0.15.0"] },
      ],
    );
  });

  test("appends a standard text's licence files, and each crate's notice files after its first licence", () => {
    const framework = ["framework-macros 2.0.0", "framework-rs 2.0.0"];
    assert.deepEqual(
      rust().map((g) => g.files.map((f) => ({ file: f.file, text: f.text, crates: f.crates.map(label) }))),
      [
        [],
        // dual-rs is under BSD-3-Clause first, so its notice comes here, not under MIT.
        [{ file: "THIRD-PARTY-NOTICES", text: CRATE_TEXT.dualThirdParty, crates: ["dual-rs 1.0.0"] }],
        // cargo-about found these crates' licence text, so only the notices follow it.
        [
          { file: "NOTICE", text: CRATE_TEXT.alphaNotice, crates: ["alpha-rs 1.0.0"] },
          { file: "LICENSE-THIRD-PARTY", text: CRATE_TEXT.betaThirdParty, crates: ["beta-rs 0.2.0"] },
        ],
        [
          { file: "LICENSE_APACHE-2.0", text: FRAMEWORK_APACHE, crates: framework },
          { file: "LICENSE_MIT", text: FRAMEWORK_MIT, crates: framework },
        ],
        [{ file: "COPYRIGHT", text: CRATE_TEXT.gammaCopyright, crates: ["gamma-rs 0.3.0"] }],
        [],
      ],
    );
  });

  test("finds each crate's folder through cargo metadata", () => {
    const crateDirs = new Map(CRATE_DIRS);
    crateDirs.delete("registry+https://github.com/rust-lang/crates.io-index#alpha-rs@1.0.0");
    assert.throws(
      () => rustLicences(ABOUT, { exclude: WORKSPACE, crateDirs, readCrateFiles }),
      /alpha-rs 1\.0\.0 .*cargo metadata/,
    );
  });
});

describe("crateFiles", () => {
  test("reads a crate's licence and notice files, and the licence files in its third-party folders", () => {
    const dir = join(ROOT, "crate-folder");
    const files = {
      "COPYRIGHT": "Fixture copyright file.\n",
      "LICENSE-MIT": "Fixture licence file.\n",
      "LICENSE-THIRD-PARTY": "Fixture third-party licences.\n",
      "NOTICE.md": "Fixture NOTICE file.\n",
      "THIRD_PARTY": "Fixture THIRD_PARTY file.\n",
      "ThirdPartyNotices.txt": "Fixture third-party notices.\n",
      "third_party/vendored/LICENSE": "Fixture licence of vendored code.\n",
      "third_party/vendored/code.h": "/* fixture code */\n",
      "README.md": "# fixture\n",
      "src/lib.rs": "// fixture code\n",
      "src/LICENSE": "Not read: src isn't a third-party folder.\n",
    };
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      writeFileSync(join(dir, rel), text);
    }
    const read = [
      "COPYRIGHT",
      "LICENSE-MIT",
      "LICENSE-THIRD-PARTY",
      "NOTICE.md",
      "THIRD_PARTY",
      "ThirdPartyNotices.txt",
      "third_party/vendored/LICENSE",
    ];
    assert.deepEqual(crateFiles(dir), read.map((file) => ({ file, text: files[file] })));
  });
});

describe("whisperCppLicence", () => {
  test("reads whisper.cpp/LICENSE beside whisper-rs-sys's manifest, with the source's other notices", () => {
    assert.deepEqual(whisperCppLicence(METADATA, { readText: readWhisper, findNotices: findWhisperNotices }), {
      name: "whisper.cpp and ggml",
      crate: { name: "whisper-rs-sys", version: "0.15.0" },
      licence: "MIT",
      file: "whisper.cpp/LICENSE",
      text: WHISPER_TEXT,
      notices: [{ text: ROPE_NOTICE, places: [{ path: "whisper.cpp/ggml/src/ggml-cpu/ops.cpp", line: 12 }] }],
    });
  });

  test("scans the real whisper.cpp folder by default", () => {
    const crate = join(ROOT, "registry", "whisper-rs-sys-0.15.0");
    mkdirSync(join(crate, "whisper.cpp", "ggml", "src"), { recursive: true });
    writeFileSync(join(crate, "whisper.cpp", "LICENSE"), WHISPER_TEXT);
    writeFileSync(join(crate, "whisper.cpp", "ggml", "src", "rope.cu"), `int a;\n\n${ROPE_NOTICE}\nint b;\n`);
    const metadata = {
      packages: [{ name: "whisper-rs-sys", version: "0.15.0", manifest_path: join(crate, "Cargo.toml") }],
    };
    assert.deepEqual(whisperCppLicence(metadata).notices, [
      { text: ROPE_NOTICE, places: [{ path: "whisper.cpp/ggml/src/rope.cu", line: 3 }] },
    ]);
  });

  test("a missing whisper.cpp licence throws", () => {
    const missing = () => {
      throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
    };
    const none = () => [];
    assert.throws(() => whisperCppLicence(METADATA, { readText: missing, findNotices: none }), /whisper\.cpp/);
    assert.throws(() => whisperCppLicence(METADATA, { readText: () => "", findNotices: none }), /whisper\.cpp/);
  });

  test("a whisper.cpp licence that isn't MIT throws", () => {
    assert.throws(
      () =>
        whisperCppLicence(METADATA, {
          readText: () => "Fixture licence of another kind.\n",
          findNotices: () => [],
        }),
      /MIT/,
    );
  });

  test("a graph without whisper-rs-sys throws", () => {
    const metadata = { ...METADATA, packages: METADATA.packages.filter((p) => p.name !== "whisper-rs-sys") };
    assert.throws(
      () => whisperCppLicence(metadata, { readText: readWhisper, findNotices: findWhisperNotices }),
      /whisper-rs-sys/,
    );
  });
});

describe("sourceNotices", () => {
  const LICENCE = WHISPER_TEXT;
  const SOURCE = {
    "LICENSE": LICENCE,
    "ggml/src/ggml-cpu/ops.cpp": `int a;\n\n${ROPE_NOTICE}\nstatic void rope(void) {}\n`,
    "ggml/src/ggml-cuda/rope.cu": `#include "common.cuh"\n\n${ROPE_NOTICE}\n__global__ void rope() {}\n`,
    // A block comment whose lines don't start with "*", with a blank line inside.
    "ggml/src/ggml-x/kernel.c":
      "/*\n Copyright 2026 The Fixture Foundation\n\n Permission to use this fixture is granted for tests.\n*/\nint k;\n",
    "cmake/FindThing.cmake":
      "# Find Thing\n#\n# Copyright (c) 2026, A Fixture Person\n" +
      "# Redistribution and use is allowed according to the terms of the BSD license.\n\ninclude(X)\n",
    // Only repeats LICENSE, so it adds nothing.
    "ggml/src/ggml-cann/common.h":
      "/*\n * Copyright (c) 2026 The Fixture ggml Authors\n *\n" +
      " * Permission is granted to use this fixture in tests.\n */\n#pragma once\n",
    "ggml/src/vendored/LICENSE": "Fixture licence of vendored code.\n",
    // Not notices: a plain comment, "copyright" in code, a file type the scan doesn't read.
    "src/whisper.cpp": '// Plain comment.\nconst char * s = "copyright";\n',
    "ggml/src/blob.bin": "Copyright 2026 nobody\n",
  };
  const root = join(ROOT, "whisper-source");
  for (const [rel, text] of Object.entries(SOURCE)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }

  test("finds each separate licence notice once, verbatim, with every file and line it is at", () => {
    assert.deepEqual(sourceNotices(root, LICENCE), [
      {
        text:
          "# Find Thing\n#\n# Copyright (c) 2026, A Fixture Person\n" +
          "# Redistribution and use is allowed according to the terms of the BSD license.",
        places: [{ path: "cmake/FindThing.cmake", line: 1 }],
      },
      {
        text: ROPE_NOTICE,
        places: [
          { path: "ggml/src/ggml-cpu/ops.cpp", line: 3 },
          { path: "ggml/src/ggml-cuda/rope.cu", line: 3 },
        ],
      },
      {
        text: "/*\n Copyright 2026 The Fixture Foundation\n\n Permission to use this fixture is granted for tests.\n*/",
        places: [{ path: "ggml/src/ggml-x/kernel.c", line: 1 }],
      },
      { text: "Fixture licence of vendored code.\n", places: [{ path: "ggml/src/vendored/LICENSE", line: 1 }] },
    ]);
  });
});

describe("compiledSources", () => {
  const crate = (name, version) => ({
    name,
    version,
    id: `registry+https://github.com/rust-lang/crates.io-index#${name}@${version}`,
  });
  const CSRC = crate("csrc-sys", "1.2.0");
  const PLAIN = crate("plain-cc", "0.1.0");
  const SQLITE = crate("libsqlite3-sys", "0.30.1");
  const WHISPER = crate("whisper-rs-sys", "0.15.0");
  const HOST = crate("host-only-sys", "0.1.0"); // builds with cc, but no release target has it
  const OPTIONAL = crate("optional-cc", "0.2.0"); // declares cc for a feature that is off
  const RUST_ONLY = crate("rust-only", "1.0.0"); // uses cc as a normal dependency, not to build
  const CC = crate("cc", "1.2.0");
  const CMAKE = crate("cmake", "0.1.0");
  const builds = (...deps) => deps.map((dep) => ({ name: dep.name, pkg: dep.id, dep_kinds: [{ kind: "build", target: null }] }));
  const METADATA_C = {
    packages: [CSRC, PLAIN, SQLITE, WHISPER, HOST, OPTIONAL, RUST_ONLY, CC, CMAKE].map((c) => ({
      ...c,
      manifest_path: `/unused/${c.name}/Cargo.toml`,
    })),
    resolve: {
      nodes: [
        { id: CSRC.id, deps: builds(CC) },
        { id: PLAIN.id, deps: builds(CC) },
        { id: SQLITE.id, deps: builds(CC) },
        { id: WHISPER.id, deps: builds(CMAKE) },
        { id: HOST.id, deps: builds(CC) },
        { id: OPTIONAL.id, deps: [] },
        { id: RUST_ONLY.id, deps: [{ name: "cc", pkg: CC.id, dep_kinds: [{ kind: null, target: null }] }] },
      ],
    },
  };
  const CSRC_TEXT =
    "Fixture ISC licence of csrc-sys.\n\nCopyright (c) 2026 The Csrc Fixture Authors\n\nPermission to use this fixture is granted for tests.\n";
  // cargo-about's output: the release crates, and csrc-sys's own licence text.
  const ABOUT_C = {
    licenses: [
      { id: "ISC", name: "ISC License", text: CSRC_TEXT, source_path: "/unused/csrc-sys/LICENSE", used_by: [{ crate: CSRC }] },
      {
        id: "MIT",
        name: "MIT License",
        text: "Fixture MIT licence text.\n",
        source_path: "/unused/LICENSE",
        used_by: [PLAIN, SQLITE, WHISPER, OPTIONAL, RUST_ONLY].map((c) => ({ crate: c })),
      },
    ],
  };
  const OTHER_HEADER = "/* Copyright (c) 2026, Fixture Inc.\n *\n * Permission to use this fixture code is granted for tests. */";
  const PERL_HEADER =
    "#! /usr/bin/env perl\n# Copyright 2026 The Fixture Project Authors. All Rights Reserved.\n#\n# Licensed under the Fixture Licence.";
  const ASM_HEADER = "; Copyright 2026 The Fixture Asm Authors\n; Licensed under the Fixture Licence.";
  const CREDIT = "// Based on fixture code by A. Person, placed in the public domain.";
  const root = join(ROOT, "compiled");
  const FILES = {
    // Its header repeats csrc-sys's own licence text, so only the credit below is new.
    "csrc-sys/src/c/thing.c":
      "/* Copyright (c) 2026 The Csrc Fixture Authors\n *\n * Permission to use this fixture is granted for tests. */\n\n" +
      `int thing;\n\n${CREDIT}\nint borrowed;\n`,
    "csrc-sys/src/c/other.c": `${OTHER_HEADER}\nint other;\n`,
    "csrc-sys/include/other.h": `${OTHER_HEADER}\n#pragma once\n`,
    "csrc-sys/asm/fixture.pl": `${PERL_HEADER}\n\nuse strict;\n`,
    "csrc-sys/asm/fixture-nasm.asm": `${ASM_HEADER}\nsection .text\n`,
    // Not read: Rust sources are cargo-about's, licence files the Rust section's.
    "csrc-sys/src/lib.rs": "// Copyright 2026 The Rust Fixture Authors\n",
    "csrc-sys/LICENSE-OTHER": "Copyright 2026 A fixture licence file.\n",
    "plain-cc/src/shim.c": "int shim(void) { return 0; }\n",
    "libsqlite3-sys/sqlite3/sqlite3.h": '#define SQLITE_VERSION        "3.46.0"\n',
    "libsqlite3-sys/sqlite3/sqlite3.c": "/*\n** The author disclaims copyright to this source code.\n*/\nint sqlite;\n",
  };
  for (const [rel, text] of Object.entries(FILES)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  const DIRS_C = new Map([
    [CSRC.id, join(root, "csrc-sys")],
    [PLAIN.id, join(root, "plain-cc")],
    [SQLITE.id, join(root, "libsqlite3-sys")],
  ]);
  const compiled = () => compiledSources(ABOUT_C, METADATA_C, { crateDirs: DIRS_C });

  test("scans each release crate that builds with cc or cmake, except whisper-rs-sys", () => {
    assert.deepEqual(
      compiled().map((source) => `${source.name} (${label(source.crate)})`),
      ["csrc-sys (csrc-sys 1.2.0)", "SQLite 3.46.0 (libsqlite3-sys 0.30.1)", "plain-cc (plain-cc 0.1.0)"],
    );
  });

  test("keeps each other notice once, verbatim, with its files and lines, but not the crate's own licence", () => {
    const csrc = compiled().find((source) => source.crate.name === "csrc-sys");
    assert.deepEqual(csrc.notices, [
      { text: ASM_HEADER, places: [{ path: "asm/fixture-nasm.asm", line: 1 }] },
      { text: PERL_HEADER, places: [{ path: "asm/fixture.pl", line: 1 }] },
      {
        text: OTHER_HEADER,
        places: [
          { path: "include/other.h", line: 1 },
          { path: "src/c/other.c", line: 1 },
        ],
      },
      { text: CREDIT, places: [{ path: "src/c/thing.c", line: 7 }] },
    ]);
    assert.deepEqual(compiled().find((source) => source.crate.name === "plain-cc").notices, []);
  });

  test("names SQLite in one public-domain entry, with the version it bundles, instead of scanning it", () => {
    assert.deepEqual(
      compiled().find((source) => source.crate.name === "libsqlite3-sys"),
      {
        name: "SQLite 3.46.0",
        crate: { name: "libsqlite3-sys", version: "0.30.1" },
        publicDomain: "https://www.sqlite.org/copyright.html",
        notices: [],
      },
    );
  });

  test("finds nothing without a resolve graph", () => {
    assert.deepEqual(compiledSources(ABOUT_C, { packages: METADATA_C.packages }, { crateDirs: DIRS_C }), []);
  });

  test("the bundled source section lists what it holds, and each notice as crate, version, path and line", () => {
    const sources = [...bundled(), ...compiled()];
    const part = section(notices({ bundled: sources }), "Bundled C/C++ source");
    // The intro lists exactly the entries below it.
    const all = lines(part);
    const intro = all.slice(0, all.indexOf("-".repeat(80))).filter((l) => l.startsWith("    ")).map((l) => l.trim());
    const titles = all.filter((l, i) => all[i - 1] === "-".repeat(80));
    assert.deepEqual(intro, titles);
    assert.deepEqual(titles, [
      "SQLite 3.46.0, from libsqlite3-sys 0.30.1",
      "csrc-sys 1.2.0",
      "plain-cc 0.1.0",
      "whisper.cpp and ggml, from whisper-rs-sys 0.15.0",
    ]);
    assert.ok(part.includes(`\n    csrc-sys 1.2.0 include/other.h:1\n    csrc-sys 1.2.0 src/c/other.c:1\n\n${OTHER_HEADER}\n`));
    assert.ok(part.includes("SQLite 3.46.0, from libsqlite3-sys 0.30.1\nLicence: public domain, https://www.sqlite.org/copyright.html\n"));
    assert.ok(part.includes('plain-cc 0.1.0\nLicence: under "Rust crates" above\nIts sources carry no other licence notice.\n'));
    assert.ok(part.includes('csrc-sys 1.2.0\nLicence: under "Rust crates" above\n'));
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
    for (const name of ["alphaNotice", "betaThirdParty", "gammaCopyright", "dualThirdParty"]) {
      assert.ok(out.includes(CRATE_TEXT[name]), name);
    }
    assert.ok(out.includes(FRAMEWORK_MIT));
    assert.ok(out.includes(FRAMEWORK_APACHE));
    assert.ok(out.includes(WHISPER_TEXT));
    assert.ok(out.includes(ROPE_NOTICE));
    assert.ok(out.includes(STANDARD_TEXTS.MIT));
  });

  test("each text appears once, however many crates or copies share it", () => {
    const out = notices();
    const textA = ABOUT.licenses.find((l) => l.text.startsWith("Fixture MIT licence text A")).text;
    assert.equal(occurrences(out, textA), 1); // alpha-rs and beta-rs
    assert.equal(occurrences(out, FRAMEWORK_MIT), 1); // framework-rs and framework-macros
    assert.equal(occurrences(out, TEXT.delta), 1); // two copies of delta 1.0.0
    assert.equal(occurrences(out, CRATE_TEXT.dualThirdParty), 1); // dual-rs, under two licences
    assert.ok(!out.includes("Fixture ISC licence text."), "a licence only the workspace uses");
    // cargo-about found alpha-rs's licence text, so its licence file isn't repeated.
    assert.ok(!out.includes(CRATE_TEXT.alphaMit));
  });

  test("lists each crate under its licence by name and version", () => {
    const part = lines(section(notices(), "Rust crates")).map((l) => l.trim());
    for (const crate of ["alpha-rs 1.0.0", "beta-rs 0.2.0", "dual-rs 1.0.0", "framework-rs 2.0.0", "binding-sys 0.15.0", "sync-thing 1.0.2"]) {
      assert.ok(part.includes(crate), crate);
    }
    assert.ok(!part.includes("fleetify-fixture-app 0.1.0"));
  });

  test("a crate's NOTICE file shows verbatim under its name, after its licence", () => {
    const part = section(notices(), "Rust crates");
    const textA = ABOUT.licenses.find((l) => l.text.startsWith("Fixture MIT licence text A")).text;
    const block = `[NOTICE] in:\n    alpha-rs 1.0.0\n\n${CRATE_TEXT.alphaNotice}`;
    assert.equal(occurrences(part, block), 1);
    // Between alpha-rs's licence text and the next licence's entry.
    const licence = part.indexOf(textA);
    const next = part.indexOf("-".repeat(80), licence);
    assert.ok(licence < part.indexOf(block) && part.indexOf(block) < next);
  });

  test("the workspace's own notice files stay out", () => {
    assert.ok(!notices().includes(CRATE_TEXT.appNotice));
  });

  test("says where a standard text's copyright holder comes from, or that there is none", () => {
    const part = section(notices(), "npm packages");
    assert.ok(
      part.includes(
        "with-holder 2.0.0\nLicence: MIT\n\n" +
          "Published without a licence file: this is the standard text of the licence its\n" +
          `package.json declares, with the copyright holder its readme.md names.\n\n${MIT_WITH_HOLDER}`,
      ),
    );
    assert.ok(
      part.includes(
        "standard-only 1.0.0\nLicence: MIT\n\n" +
          "Published without a licence file, and its files name no copyright holder: this\n" +
          `is the standard text of the licence its package.json declares.\n\n${STANDARD_TEXTS.MIT}`,
      ),
    );
  });

  test("names whisper.cpp and ggml under the bundled source, with the crate they come from", () => {
    const part = section(notices(), "Bundled C/C++ source");
    assert.match(part, /whisper\.cpp and ggml/);
    assert.match(part, /whisper-rs-sys 0\.15\.0/);
    assert.ok(part.includes(WHISPER_TEXT));
  });

  test("gives the bundled source's other licence notices verbatim, with the files they are in", () => {
    const part = section(notices(), "Bundled C/C++ source");
    assert.equal(
      occurrences(part, `\n    whisper-rs-sys 0.15.0 whisper.cpp/ggml/src/ggml-cpu/ops.cpp:12\n\n${ROPE_NOTICE}\n`),
      1,
    );
    assert.ok(part.indexOf(WHISPER_TEXT) < part.indexOf(ROPE_NOTICE));
  });

  test("the output is deterministic", () => {
    const input = { version: "1.2.3", rust: rust(), npm: npm(), bundled: bundled() };
    const first = renderNotices(input);
    const shuffled = renderNotices({
      version: "1.2.3",
      rust: [...input.rust].reverse().map((g) => ({
        ...g,
        crates: [...g.crates].reverse(),
        files: [...g.files].reverse().map((f) => ({ ...f, crates: [...f.crates].reverse() })),
      })),
      npm: [...input.npm].reverse(),
      bundled: [...input.bundled].reverse().map((b) => ({
        ...b,
        notices: [...b.notices].reverse().map((n) => ({ ...n, places: [...n.places].reverse() })),
      })),
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
