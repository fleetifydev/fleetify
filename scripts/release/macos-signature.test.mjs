/**
 * Tests for macos-signature.mjs, which checks the signature of a built
 * Fleetify.app: its designated requirement, the hardened runtime and its
 * entitlements.
 *
 *   node --test scripts/release/macos-signature.test.mjs
 *
 * The codesign outputs in fixtures/codesign/ follow the formats Apple's
 * codesign prints, both streams together as a terminal shows them. They were
 * written by hand, not captured on a Mac: one set from an app signed with a
 * self-signed certificate and the hardened runtime, and one from an app with
 * only the linker's ad-hoc signature. The CLI tests put
 * fixtures/fake-codesign.mjs first on PATH as `codesign`, so they run without
 * macOS.
 */
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

import { codesignStreams, kindOf } from "./fixtures/fake-codesign.mjs";
import {
  ENTITLEMENTS,
  IDENTIFIER,
  checkSignature,
  drProblems,
  entitlementKeys,
  hasHardenedRuntime,
  parseDesignatedRequirement,
} from "./macos-signature.mjs";

const SCRIPT = fileURLToPath(new URL("./macos-signature.mjs", import.meta.url));
const FAKE_CODESIGN = fileURLToPath(new URL("./fixtures/fake-codesign.mjs", import.meta.url));
const sample = (name) => readFileSync(new URL(`./fixtures/codesign/${name}`, import.meta.url), "utf8");
const repoFile = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

const REQUIREMENTS = sample("requirements.txt");
const REQUIREMENTS_ADHOC = sample("requirements-adhoc.txt");
const DISPLAY = sample("display.txt");
const DISPLAY_ADHOC = sample("display-adhoc.txt");
const ENTITLEMENTS_XML = sample("entitlements.txt");
const VERIFY = sample("verify.txt");

const HASH = "4373166b9e2432f53462f06b1440efeef5f812fc";
const OTHER_HASH = "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c";
/** The designated requirement in requirements.txt. */
const DR = `identifier "com.fleetify.app" and certificate root = H"${HASH}"`;
const LEAF_DR = `identifier "com.fleetify.app" and certificate leaf = H"${HASH}"`;
/** The (implicit) designated requirement in requirements-adhoc.txt. */
const ADHOC_DR = 'cdhash H"3c84341d6ef288a40a1910f03bcfc42eb00c2b6e"';
const AUDIO = "com.apple.security.device.audio-input";

const IDENTIFIER_PROBLEM = /does not name identifier "com\.fleetify\.app"/;
const CERTIFICATE_PROBLEM = /does not pin the signing certificate/;
const CDHASH_PROBLEM = /names a cdhash/;
const PINNED_PROBLEM = /is not the pinned one/;

/** An entitlements plist as codesign --xml prints it, with `entries` inside its dict. */
const plist = (entries) =>
  '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" ' +
  `"https://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>${entries}</dict></plist>`;

describe("parseDesignatedRequirement", () => {
  test("the designated => line of codesign -d -r-, without its prefix", () => {
    assert.equal(parseDesignatedRequirement(REQUIREMENTS), DR);
  });

  test("an implicit requirement, which codesign prints commented out with #", () => {
    assert.equal(parseDesignatedRequirement(REQUIREMENTS_ADHOC), ADHOC_DR);
    assert.equal(parseDesignatedRequirement(`# designated => ${DR}\n`), DR);
  });

  test("spaces and tabs around its parts, and CRLF line ends", () => {
    for (const text of [
      `   designated   =>   ${DR}   \n`,
      `\t#\tdesignated=>${DR}\t\n`,
      `#designated => ${DR}`,
      REQUIREMENTS.replace(/\n/g, "\r\n"),
      `Executable=/x\r\n# designated => ${DR}\r\n`,
    ]) {
      assert.equal(parseDesignatedRequirement(text), DR, JSON.stringify(text));
    }
  });

  test("the first line that starts with designated =>, among the other requirements", () => {
    assert.equal(parseDesignatedRequirement(`host => anchor apple\ndesignated => ${DR}\nlibrary => anchor apple\n`), DR);
    assert.equal(parseDesignatedRequirement(`designated => ${DR}\ndesignated => ${LEAF_DR}\n`), DR);
    assert.equal(parseDesignatedRequirement(`note: designated => ${DR}\n`), null);
  });

  test("null when there is none", () => {
    for (const text of ["", "Executable=/x\n", "designated =>", "designated =>   \n", "# designated\n", undefined, null, 42]) {
      assert.equal(parseDesignatedRequirement(text), null, JSON.stringify(text));
    }
  });
});

describe("drProblems", () => {
  test("a self-signed certificate's requirement passes, whether it pins the certificate as root or leaf", () => {
    assert.deepEqual(drProblems(DR), []);
    assert.deepEqual(drProblems(LEAF_DR), []);
    assert.deepEqual(drProblems(DR, {}), []);
  });

  test("an ad-hoc signature's cdhash requirement fails", () => {
    const problems = drProblems(ADHOC_DR);
    assert.equal(problems.length, 3, problems.join("\n"));
    assert.match(problems[0], IDENTIFIER_PROBLEM);
    assert.match(problems[1], CERTIFICATE_PROBLEM);
    assert.match(problems[2], CDHASH_PROBLEM);
  });

  test("a cdhash fails even beside a pinned certificate", () => {
    const problems = drProblems(`${DR} or cdhash H"3c84341d6ef288a40a1910f03bcfc42eb00c2b6e"`);
    assert.equal(problems.length, 1, problems.join("\n"));
    assert.match(problems[0], CDHASH_PROBLEM);
  });

  test("a mismatch with the expected requirement fails, and the problem shows the pinned one", () => {
    const expected = DR.replace(HASH, OTHER_HASH);
    const problems = drProblems(DR, { expected });
    assert.equal(problems.length, 1, problems.join("\n"));
    assert.match(problems[0], PINNED_PROBLEM);
    assert.ok(problems[0].includes(expected), problems[0]);
    assert.deepEqual(drProblems(LEAF_DR, { expected: DR }).length, 1);
  });

  test("the expected requirement matches after trimming", () => {
    assert.deepEqual(drProblems(DR, { expected: DR }), []);
    assert.deepEqual(drProblems(DR, { expected: `${DR}\n` }), []);
    assert.deepEqual(drProblems(DR, { expected: `  ${DR}\r\n` }), []);
    assert.deepEqual(drProblems(` ${DR}\t`, { expected: DR }), []);
  });

  test("past trimming the match is exact", () => {
    for (const expected of [
      DR.replace(" and ", "  and "),
      DR.replace(HASH, HASH.toUpperCase()),
      `${DR} and anchor apple generic`,
      `designated => ${DR}`,
      `${DR}\n${DR}`,
    ]) {
      const problems = drProblems(DR, { expected });
      assert.equal(problems.length, 1, JSON.stringify(expected));
      assert.match(problems[0], PINNED_PROBLEM);
    }
  });

  test("an empty expected requirement fails", () => {
    for (const expected of ["", "\n", "  \r\n"]) {
      assert.deepEqual(drProblems(DR, { expected }), ["the pinned designated requirement is empty"]);
    }
  });

  test("the identifier must be Fleetify's, whole and quoted", () => {
    for (const dr of [
      `identifier "com.fleetify.app.helper" and certificate root = H"${HASH}"`,
      `identifier "com.example.app" and certificate root = H"${HASH}"`,
      `identifier com.fleetify.app and certificate root = H"${HASH}"`,
      `certificate root = H"${HASH}"`,
    ]) {
      const problems = drProblems(dr);
      assert.equal(problems.length, 1, dr);
      assert.match(problems[0], IDENTIFIER_PROBLEM);
    }
    assert.deepEqual(drProblems(`identifier "com.example.app" and certificate leaf = H"${HASH}"`, { identifier: "com.example.app" }), []);
    assert.deepEqual(drProblems(`identifier  "com.fleetify.app"  and  certificate  root  =  H"${HASH}"`), []);
  });

  test("the certificate must be pinned as root or leaf by a SHA-1 in lowercase hex", () => {
    for (const dr of [
      'identifier "com.fleetify.app" and anchor apple generic',
      `identifier "com.fleetify.app" and certificate root = H"${HASH.toUpperCase()}"`,
      `identifier "com.fleetify.app" and certificate root = H"${HASH.slice(1)}"`,
      `identifier "com.fleetify.app" and certificate root = H"${HASH}0"`,
      `identifier "com.fleetify.app" and certificate 1 = H"${HASH}"`,
      `identifier "com.fleetify.app" and certificate root = "${HASH}"`,
    ]) {
      const problems = drProblems(dr);
      assert.equal(problems.length, 1, dr);
      assert.match(problems[0], CERTIFICATE_PROBLEM);
    }
  });

  test("no requirement at all", () => {
    for (const dr of [null, undefined, "", "   "]) {
      assert.deepEqual(drProblems(dr), ["no designated requirement"]);
      assert.deepEqual(drProblems(dr, { expected: DR }), ["no designated requirement"]);
    }
  });

  test("IDENTIFIER is the bundle identifier in tauri.conf.json", () => {
    assert.equal(IDENTIFIER, "com.fleetify.app");
    assert.equal(JSON.parse(repoFile("src-tauri/tauri.conf.json")).identifier, IDENTIFIER);
  });
});

describe("hasHardenedRuntime", () => {
  test("the runtime flag on codesign -d -vvv's CodeDirectory line", () => {
    assert.equal(hasHardenedRuntime(DISPLAY), true);
  });

  test("an ad-hoc, linker-signed binary has no hardened runtime", () => {
    assert.equal(hasHardenedRuntime(DISPLAY_ADHOC), false);
  });

  test("runtime among other flags", () => {
    for (const flags of ["0x12200(kill,library-validation,runtime)", "0x10002(adhoc,runtime)"]) {
      assert.equal(hasHardenedRuntime(`CodeDirectory v=20500 size=1 flags=${flags} hashes=1+7 location=embedded\n`), true, flags);
    }
  });

  test("the flag's bit and its name must both be there", () => {
    for (const flags of ["0x0(runtime)", "0x10000(none)", "0x10000", "0x2(adhoc)", "0x0(none)"]) {
      assert.equal(hasHardenedRuntime(`CodeDirectory v=20500 size=1 flags=${flags} hashes=1+7 location=embedded\n`), false, flags);
    }
  });

  test("only the CodeDirectory line counts, not Runtime Version or another line", () => {
    assert.equal(hasHardenedRuntime(DISPLAY.replace("flags=0x10000(runtime)", "flags=0x0(none)")), false);
    assert.equal(hasHardenedRuntime("Note flags=0x10000(runtime)\nRuntime Version=15.2.0\n"), false);
  });

  test("every CodeDirectory line must have it", () => {
    const text = `${DISPLAY}CodeDirectory v=20400 size=1 flags=0x2(adhoc) hashes=1+0 location=embedded\n`;
    assert.equal(hasHardenedRuntime(text), false);
  });

  test("spaces, tabs and CRLF line ends", () => {
    assert.equal(hasHardenedRuntime("\tCodeDirectory v=20500 flags=0x10000 ( runtime ) hashes=1+7\r\n"), true);
    assert.equal(hasHardenedRuntime(DISPLAY.replace(/\n/g, "\r\n")), true);
  });

  test("false when there is nothing to read", () => {
    for (const text of ["", "Executable=/x\n", undefined, null, 42]) assert.equal(hasHardenedRuntime(text), false);
  });
});

describe("entitlementKeys", () => {
  test("codesign's one-line XML: the audio-input entitlement", () => {
    assert.deepEqual(entitlementKeys(ENTITLEMENTS_XML), [AUDIO]);
  });

  test("ENTITLEMENTS, which the check requires, are exactly those src-tauri/Entitlements.plist grants", () => {
    assert.deepEqual(ENTITLEMENTS, [AUDIO]);
    assert.ok(Object.isFrozen(ENTITLEMENTS));
    assert.deepEqual(entitlementKeys(repoFile("src-tauri/Entitlements.plist")), [...ENTITLEMENTS]);
  });

  test("only the top-level keys whose value is true", () => {
    const xml = plist(
      [
        "<key>a</key><true/>",
        "<key>b</key><false/>",
        "<key>c</key><string>yes</string>",
        "<key>d</key><integer>1</integer>",
        "<key>e</key><array><true/><string>x</string></array>",
        "<key>f</key><dict><key>g</key><true/></dict>",
        "<key>h</key><true />",
        "<key>i</key><array/>",
        "<key>j</key>\n\t<true></true>",
        "<key>k</key><dict/>",
        "<key>l</key><true/>",
        "<key>m</key><keyboard/><true/>",
      ].join("\n\t"),
    );
    assert.deepEqual(entitlementKeys(xml), ["a", "h", "j", "l"]);
  });

  test("a key given twice has its last value, as macOS reads it", () => {
    assert.deepEqual(entitlementKeys(plist("<key>a</key><true/><key>a</key><false/>")), []);
    assert.deepEqual(entitlementKeys(plist("<key>a</key><false/><key>a</key><true/>")), ["a"]);
  });

  test("a binary blob header before the XML is skipped", () => {
    const blob = "úÞqq\u0000\u0000\u0001\u0010";
    assert.deepEqual(entitlementKeys(`${blob}${plist("<key>a</key><true/>")}`), ["a"]);
  });

  test("a plist with a comment or a CDATA section gives no keys, as codesign writes neither", () => {
    // Fails closed, so the exact match with ENTITLEMENTS fails, rather than
    // read around markup that codesign's re-serialized dictionary never has.
    assert.deepEqual(entitlementKeys(plist("<!-- <key>x</key><true/> --><key>a</key><true/>")), []);
    assert.deepEqual(entitlementKeys(plist("<key>s</key><string><![CDATA[</string><key>y</key><true/>]]></string>")), []);
    assert.deepEqual(entitlementKeys(plist("<key>a</key><true/><!-<!-- -->- x -->")), []);
  });

  test("codesign's XML, with its declaration and DOCTYPE, gives its key", () => {
    assert.deepEqual(entitlementKeys(sample("entitlements.txt")), [AUDIO]);
    const pretty = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      "<dict>",
      `\t<key>${AUDIO}</key>`,
      "\t<true/>",
      "</dict>",
      "</plist>",
    ].join("\n");
    assert.deepEqual(entitlementKeys(pretty), [AUDIO]);
  });

  test("entity references in a key are decoded, and an empty key is a key", () => {
    assert.deepEqual(entitlementKeys(plist("<key>a&amp;b&#46;c&#x2E;</key><true/>")), ["a&b.c."]);
    assert.deepEqual(entitlementKeys(plist("<key/><true/><key>b</key><true/>")), ["", "b"]);
  });

  test("nothing when there is no dict plist", () => {
    for (const text of [
      "",
      "Executable=/x\n",
      '<plist version="1.0"><dict/></plist>',
      '<plist version="1.0"><array><true/></array></plist>',
      "<dict><key>a</key><true/></dict>",
      undefined,
      42,
    ]) {
      assert.deepEqual(entitlementKeys(text), [], JSON.stringify(text));
    }
  });
});

const APP = "/Users/runner/work/_temp/dmg/Fleetify.app";

/** codesign's answers for a good, self-signed app, by command kind. */
const GOOD = Object.freeze({
  verify: { output: VERIFY },
  requirements: { output: REQUIREMENTS },
  display: { output: DISPLAY },
  entitlements: { output: ENTITLEMENTS_XML },
});

/**
 * A stand-in for spawnSync that answers each codesign command from
 * `scenario` (GOOD, with any kinds replaced), on the streams codesign uses.
 * An entry with `error` stands for a codesign that couldn't be started.
 */
function fakeRun(changes = {}) {
  const scenario = { ...GOOD, ...changes };
  const calls = [];
  const run = (command, args) => {
    calls.push([command, args]);
    const kind = kindOf(args);
    const { status = 0, output = "", error } = scenario[kind];
    if (error) return { status: null, signal: null, stdout: "", stderr: "", error };
    return { status, signal: null, ...codesignStreams(kind, output) };
  };
  return { run, calls };
}

describe("checkSignature, with a stand-in for codesign", () => {
  test("runs the four codesign commands on the app; a good app has no problems", () => {
    const { run, calls } = fakeRun();
    assert.deepEqual(checkSignature(APP, { run }), { dr: DR, runtime: true, entitlements: [AUDIO], problems: [] });
    assert.deepEqual(calls, [
      ["codesign", ["--verify", "--deep", "--strict", "--verbose=2", APP]],
      ["codesign", ["-d", "-r-", APP]],
      ["codesign", ["-d", "-vvv", APP]],
      ["codesign", ["-d", "--entitlements", "-", "--xml", APP]],
    ]);
  });

  test("with the pinned requirement: no problem when it is the same, one when it differs", () => {
    assert.deepEqual(checkSignature(APP, { run: fakeRun().run, expected: `${DR}\n` }).problems, []);
    const { problems } = checkSignature(APP, { run: fakeRun().run, expected: DR.replace(HASH, OTHER_HASH) });
    assert.equal(problems.length, 1, problems.join("\n"));
    assert.match(problems[0], PINNED_PROBLEM);
  });

  test("an ad-hoc signature: its cdhash requirement and no hardened runtime", () => {
    const { run } = fakeRun({ requirements: { output: REQUIREMENTS_ADHOC }, display: { output: DISPLAY_ADHOC } });
    const result = checkSignature(APP, { run });
    assert.equal(result.dr, ADHOC_DR);
    assert.equal(result.runtime, false);
    assert.equal(result.problems.length, 4, result.problems.join("\n"));
    assert.match(result.problems[0], IDENTIFIER_PROBLEM);
    assert.match(result.problems[1], CERTIFICATE_PROBLEM);
    assert.match(result.problems[2], CDHASH_PROBLEM);
    assert.match(result.problems[3], /the hardened runtime is off: CodeDirectory v=20400 .*flags=0x20002\(adhoc,linker-signed\)/);
  });

  test("a signature that doesn't verify is a problem, and the requirement is still read", () => {
    const { run } = fakeRun({ verify: { status: 3, output: `${APP}: a sealed resource is missing or invalid\n` } });
    const result = checkSignature(APP, { run });
    assert.equal(result.dr, DR);
    assert.equal(result.problems.length, 1, result.problems.join("\n"));
    assert.match(result.problems[0], /^codesign --verify --deep --strict --verbose=2 failed \(exit 3\): .*a sealed resource is missing or invalid$/);
  });

  test("entitlements: the audio-input one missing, or another one granted", () => {
    const missing = checkSignature(APP, { run: fakeRun({ entitlements: { output: plist("") } }).run });
    assert.deepEqual(missing.entitlements, []);
    assert.deepEqual(missing.problems, [`missing entitlement ${AUDIO}`]);
    const extra = plist(`<key>${AUDIO}</key><true/><key>com.apple.security.get-task-allow</key><true/>`);
    const granted = checkSignature(APP, { run: fakeRun({ entitlements: { output: extra } }).run });
    assert.deepEqual(granted.problems, ["unexpected entitlement com.apple.security.get-task-allow"]);
  });

  test("no designated => line in codesign's output", () => {
    const { problems, dr } = checkSignature(APP, { run: fakeRun({ requirements: { output: "Executable=/x/fleetify-app\n" } }).run });
    assert.equal(dr, null);
    assert.equal(problems.length, 1, problems.join("\n"));
    assert.match(problems[0], /^no designated requirement in the output of codesign -d -r-/);
  });

  test("a codesign command that fails: its exit code and output in the problem, and nothing read from it", () => {
    const { run } = fakeRun({ display: { status: 1, output: `${APP}: code object is not signed at all\n` } });
    const result = checkSignature(APP, { run });
    assert.equal(result.runtime, null);
    assert.deepEqual(result.problems, [`codesign -d -vvv failed (exit 1): ${APP}: code object is not signed at all`]);
  });

  test("a DR printed without a final newline doesn't run into stderr's Executable= line", () => {
    const good = fakeRun().run;
    const run = (command, args) =>
      kindOf(args) === "requirements"
        ? { status: 0, signal: null, stdout: `designated => ${DR}`, stderr: `Executable=${APP}/Contents/MacOS/fleetify-app\n` }
        : good(command, args);
    const result = checkSignature(APP, { run });
    assert.equal(result.dr, DR);
    assert.deepEqual(result.problems, []);
  });

  test("codesign can't be run: each command is a problem", () => {
    const error = new Error("spawnSync codesign ENOENT");
    const { run } = fakeRun(Object.fromEntries(Object.keys(GOOD).map((kind) => [kind, { error }])));
    const result = checkSignature(APP, { run });
    assert.deepEqual(result, {
      dr: null,
      runtime: null,
      entitlements: null,
      problems: [
        "could not run codesign --verify --deep --strict --verbose=2: spawnSync codesign ENOENT",
        "could not run codesign -d -r-: spawnSync codesign ENOENT",
        "could not run codesign -d -vvv: spawnSync codesign ENOENT",
        "could not run codesign -d --entitlements - --xml: spawnSync codesign ENOENT",
      ],
    });
  });
});

const ROOT = mkdtempSync(join(tmpdir(), "macos-signature-"));
after(() => rmSync(ROOT, { recursive: true, force: true }));
let count = 0;
/** A path under ROOT that doesn't exist yet. */
const fresh = (name) => join(ROOT, `${name}-${(count += 1)}`);

/** A folder holding a `codesign` that runs fake-codesign.mjs. */
const BIN = join(ROOT, "bin");
mkdirSync(BIN);
const quote = (text) => `'${text.replace(/'/g, "'\\''")}'`;
writeFileSync(join(BIN, "codesign"), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(FAKE_CODESIGN)} "$@"\n`, { mode: 0o755 });

/** An empty Fleetify.app folder to point the CLI at. */
function appFolder() {
  const app = join(fresh("dmg"), "Fleetify.app");
  mkdirSync(app, { recursive: true });
  return app;
}

/**
 * Run the CLI with `args`, codesign answering from GOOD with `changes`.
 * Returns spawnSync's result and the codesign calls, each as its arguments.
 */
function cli(args, changes = {}) {
  const dir = fresh("codesign");
  mkdirSync(dir);
  const scenario = join(dir, "scenario.json");
  const log = join(dir, "calls.log");
  writeFileSync(scenario, JSON.stringify({ ...GOOD, ...changes }));
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${BIN}${delimiter}${process.env.PATH}`, FAKE_CODESIGN_SCENARIO: scenario, FAKE_CODESIGN_LOG: log },
  });
  const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
  return { ...result, calls };
}

/** A file holding `text`. */
function textFile(text) {
  const path = fresh("macos-designated-requirement.txt");
  writeFileSync(path, text);
  return path;
}

const lines = (text) => text.split(/\r?\n/);

describe("the CLI, with fake-codesign.mjs as codesign", { skip: process.platform === "win32" && "the codesign stand-in is a shell script" }, () => {
  test("a self-signed app: exit 0, the DR line printed, the four commands run on the app", () => {
    const app = appFolder();
    const result = cli([app]);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(lines(result.stdout).includes(`designated => ${DR}`), result.stdout);
    assert.deepEqual(result.calls, [
      ["--verify", "--deep", "--strict", "--verbose=2", app],
      ["-d", "-r-", app],
      ["-d", "-vvv", app],
      ["-d", "--entitlements", "-", "--xml", app],
    ]);
    assert.match(result.stdout, /hardened runtime: on/);
    assert.ok(result.stdout.includes(`entitlements: ${AUDIO}`), result.stdout);
    assert.match(result.stdout, /shape only/);
  });

  test("--expected-dr holding the same requirement: exit 0", () => {
    const pinned = textFile(`${DR}\n`);
    const result = cli([appFolder(), "--expected-dr", pinned]);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes(pinned), result.stdout);
  });

  test("--expected-dr holding another requirement: exit 1, and the DR line is still printed", () => {
    const result = cli(["--expected-dr", textFile(`${DR.replace(HASH, OTHER_HASH)}\n`), appFolder()]);
    assert.equal(result.status, 1);
    assert.ok(lines(result.stdout).includes(`designated => ${DR}`), result.stdout);
    assert.match(result.stderr, PINNED_PROBLEM);
    assert.match(result.stderr, /1 problem\(s\)/);
  });

  test("an ad-hoc signature: exit 1, every problem listed, the DR line printed", () => {
    const result = cli([appFolder()], { requirements: { output: REQUIREMENTS_ADHOC }, display: { output: DISPLAY_ADHOC } });
    assert.equal(result.status, 1);
    assert.ok(lines(result.stdout).includes(`designated => ${ADHOC_DR}`), result.stdout);
    for (const problem of [IDENTIFIER_PROBLEM, CERTIFICATE_PROBLEM, CDHASH_PROBLEM, /the hardened runtime is off/]) {
      assert.match(result.stderr, problem);
    }
    assert.match(result.stderr, /4 problem\(s\)/);
  });

  test("a signature that doesn't verify: exit 1", () => {
    const result = cli([appFolder()], { verify: { status: 1, output: "Fleetify.app: invalid signature (code or signature have been modified)\n" } });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /codesign --verify --deep --strict --verbose=2 failed \(exit 1\)/);
  });

  test("an --expected-dr file that can't be read: exit 1, after the checks have run and printed the DR line", () => {
    const result = cli([appFolder(), "--expected-dr", fresh("missing.txt")]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /can't read --expected-dr/);
    assert.ok(lines(result.stdout).includes(`designated => ${DR}`), result.stdout);
  });

  test("a path that isn't a folder: exit 1, and codesign isn't run", () => {
    for (const app of [fresh("Fleetify.app"), textFile("not an app\n")]) {
      const result = cli([app]);
      assert.equal(result.status, 1, app);
      assert.match(result.stderr, /is not an app bundle/);
      assert.deepEqual(result.calls, []);
    }
  });

  test("usage errors: exit 2, and codesign isn't run", () => {
    const app = appFolder();
    const pinned = textFile(`${DR}\n`);
    for (const args of [
      [],
      [app, app],
      ["--expected-dr"],
      [app, "--expected-dr"],
      [app, "--expected-dr", ""],
      [app, "--expected-dr", pinned, "--expected-dr", pinned],
      [`--expected-dr=${pinned}`, app],
      [app, "--bogus"],
    ]) {
      const result = cli(args);
      assert.equal(result.status, 2, `${JSON.stringify(args)}: ${result.stderr}`);
      assert.match(result.stderr, /usage: node scripts\/release\/macos-signature\.mjs/, JSON.stringify(args));
      assert.deepEqual(result.calls, [], JSON.stringify(args));
    }
  });
});
