#!/usr/bin/env node
/**
 * macos-signature.mjs — check the signature of a built Fleetify.app: it
 * verifies, its designated requirement names Fleetify and pins the signing
 * certificate, the hardened runtime is on, and the entitlements it sets to
 * true are exactly those set to true in src-tauri/Entitlements.plist. Every
 * hardened-runtime exception is a boolean, so an added exception shows as an
 * unexpected key set to true.
 *
 *   node scripts/release/macos-signature.mjs <Fleetify.app> [--expected-dr <file>]
 *
 * Fleetify is signed with a self-signed certificate and isn't notarized.
 * macOS decides whether an update is the same app, and so keeps its
 * microphone permission, by the designated requirement (DR) in its
 * signature. Signing with such a certificate, codesign writes a DR of this
 * shape:
 *
 *   identifier "com.fleetify.app" and certificate root = H"<SHA-1 of the certificate>"
 *
 * It pins the certificate as "root" when the certificate names an
 * Organization that every certificate above it shares, as a self-signed one
 * with an Organization does, and as "leaf" otherwise. The rules:
 *   - it names identifier "com.fleetify.app";
 *   - it pins a certificate as root or leaf by its SHA-1, in lowercase hex;
 *   - it has no cdhash: an ad-hoc signature's DR is the hash of that one
 *     build, so each update would be a different app;
 *   - with --expected-dr, it is exactly the file's text, trimmed. Candidate
 *     and release runs give the release certificate's pinned DR; dry runs
 *     sign with a certificate made for the run, so they check the shape only.
 *
 * It runs, without a shell, and checks:
 *   codesign --verify --deep --strict --verbose=2 <app>   exits 0;
 *   codesign -d -r- <app>                     its "designated =>" line: the DR;
 *   codesign -d -vvv <app>                    the CodeDirectory flags include runtime;
 *   codesign -d --entitlements - --xml <app>  the entitlements set to true are
 *                                             exactly ENTITLEMENTS.
 *
 * It always prints the DR it finds as a line "designated => <DR>", whatever
 * the other checks say, so a run's log shows the value to pin.
 *
 * Exit codes: 0 every check passes; 1 a problem, each listed on stderr; 2 usage.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

const USAGE = "usage: node scripts/release/macos-signature.mjs <Fleetify.app> [--expected-dr <file>]";

/** The bundle identifier, as in src-tauri/tauri.conf.json. */
export const IDENTIFIER = "com.fleetify.app";

/**
 * The entitlements set to true in src-tauri/Entitlements.plist. The
 * signature must set each of them to true, and no other top-level key: the
 * check covers keys set to true, which every hardened-runtime exception is.
 */
export const ENTITLEMENTS = Object.freeze(["com.apple.security.device.audio-input"]);

/** codesign's arguments for each check, before the app's path. */
const COMMANDS = {
  verify: ["--verify", "--deep", "--strict", "--verbose=2"],
  requirements: ["-d", "-r-"],
  display: ["-d", "-vvv"],
  entitlements: ["-d", "--entitlements", "-", "--xml"],
};

/**
 * A "designated => <DR>" line. When the signature holds no DR, codesign
 * prints the one macOS derives instead, commented out with "#".
 */
const DESIGNATED = /^[ \t]*(?:#[ \t]*)?designated[ \t]*=>[ \t]*(\S(?:.*\S)?)[ \t\r]*$/m;
const CERTIFICATE_PIN = /\bcertificate[ \t]+(?:root|leaf)[ \t]*=[ \t]*H"[0-9a-f]{40}"/;
const CDHASH = /\bcdhash\b/i;
/** Each `identifier "<name>"` clause of a DR; its name is compared as text. */
const IDENTIFIER_CLAUSE = /\bidentifier[ \t]+"([^"]*)"/g;
/** The CodeDirectory flag for the hardened runtime (CS_RUNTIME). */
const RUNTIME_FLAG = 0x10000n;

const codeDirectoryLines = (text) => text.split(/\r?\n/).filter((line) => /^[ \t]*CodeDirectory\b/.test(line));

/**
 * The designated requirement in the output of `codesign -d -r-`: the first
 * line that starts with "designated =>", or "# designated =>", without that
 * prefix and the whitespace around it.
 *
 * @param {string} text
 * @returns {string | null}
 */
export function parseDesignatedRequirement(text) {
  if (typeof text !== "string") return null;
  const match = DESIGNATED.exec(text);
  return match ? match[1] : null;
}

/**
 * What is wrong with a designated requirement, by the rules above.
 *
 * @param {string | null} dr
 * @param {{ identifier?: string, expected?: string }} [options]
 *   expected: the pinned DR, as its file's text; it is compared trimmed.
 * @returns {string[]} one message per broken rule; empty when it passes
 */
export function drProblems(dr, { identifier = IDENTIFIER, expected } = {}) {
  if (typeof dr !== "string" || dr.trim() === "") return ["no designated requirement"];
  const problems = [];
  if (![...dr.matchAll(IDENTIFIER_CLAUSE)].some(([, name]) => name === identifier)) {
    problems.push(`the designated requirement does not name identifier "${identifier}"`);
  }
  if (!CERTIFICATE_PIN.test(dr)) {
    problems.push(
      'the designated requirement does not pin the signing certificate (certificate root or leaf = H"<SHA-1 in lowercase hex>")',
    );
  }
  if (CDHASH.test(dr)) {
    problems.push(
      "the designated requirement names a cdhash, which changes with every build: macOS would take each update for another app",
    );
  }
  if (expected !== undefined) {
    if (typeof expected !== "string") throw new TypeError("expected must be the pinned designated requirement's text");
    const pinned = expected.trim();
    if (pinned === "") problems.push("the pinned designated requirement is empty");
    else if (dr.trim() !== pinned) problems.push(`the designated requirement is not the pinned one, which is: ${pinned}`);
  }
  return problems;
}

/**
 * Whether the output of `codesign -d -vvv` shows the hardened runtime: its
 * CodeDirectory line has flags=0x…(…) with the runtime bit set and named.
 * With more than one CodeDirectory line, each must.
 *
 * @param {string} codesignDvvv
 * @returns {boolean}
 */
export function hasHardenedRuntime(codesignDvvv) {
  if (typeof codesignDvvv !== "string") return false;
  const lines = codeDirectoryLines(codesignDvvv);
  return (
    lines.length > 0 &&
    lines.every((line) => {
      const match = /\bflags=0x([0-9a-f]+)[ \t]*\(([^)]*)\)/i.exec(line);
      if (!match) return false;
      const names = match[2].split(",").map((name) => name.trim());
      return (BigInt(`0x${match[1]}`) & RUNTIME_FLAG) !== 0n && names.includes("runtime");
    })
  );
}

const NAMED_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decodeEntities = (text) =>
  text.replace(/&(?:(amp|lt|gt|quot|apos)|#([0-9]+)|#x([0-9a-fA-F]+));/g, (_, name, dec, hex) =>
    name ? NAMED_ENTITIES[name] : String.fromCodePoint(dec ? Number(dec) : Number.parseInt(hex, 16)),
  );

/**
 * A plist's elements in order: a <key> element with its text (an empty
 * <key/> too), or another start, end or empty-element tag. Text between
 * elements isn't matched.
 */
const PLIST_TOKEN = /<key\s*(?:\/>|>([^<]*)<\/key\s*>)|<(\/?)([A-Za-z]+)\b[^>]*?(\/?)>/g;

/**
 * The top-level keys of an XML plist whose value is <true/>, in the order
 * they first appear. A key given twice has its last value, as macOS reads
 * it. Anything before <plist> (codesign's Executable= line, an old binary
 * blob header) is skipped, the XML declaration and DOCTYPE included. A plist
 * with a comment or a CDATA section gives none, rather than be read around
 * them: codesign writes neither, as it re-serializes the dictionary. Nor
 * does anything but a plist whose root is a dict give any.
 *
 * @param {string} plistXml
 * @returns {string[]}
 */
export function entitlementKeys(plistXml) {
  if (typeof plistXml !== "string" || plistXml.includes("<!--") || plistXml.includes("<![CDATA[")) return [];
  const start = plistXml.search(/<plist\b/);
  if (start < 0) return [];
  /** key → whether its value is true */
  const values = new Map();
  let depth = 0; // dict and array elements open; 1 inside the root dict
  let key = null; // a top-level key whose value comes next
  for (const [, keyText, endTag, name, empty] of plistXml.slice(start).matchAll(PLIST_TOKEN)) {
    if (name === undefined) {
      // A <key> element.
      if (depth === 1) key = decodeEntities(keyText ?? "");
      continue;
    }
    if (name === "plist") continue;
    const container = name === "dict" || name === "array";
    if (endTag) {
      if (container) depth -= 1;
      if (depth <= 0) break;
      continue;
    }
    if (depth === 0) {
      if (name !== "dict" || empty) break;
      depth = 1;
      continue;
    }
    if (depth === 1 && key !== null) {
      values.set(key, name === "true");
      key = null;
    }
    if (container && !empty) depth += 1;
  }
  return [...values].filter(([, isTrue]) => isTrue).map(([name]) => name);
}

/** codesign as spawnSync runs it: no shell, and the output as text. */
const runCommand = (command, args) => spawnSync(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

/**
 * Run the four codesign checks on an app.
 *
 * @param {string} app  the path of Fleetify.app
 * @param {{ expected?: string, identifier?: string, run?: typeof runCommand }} [options]
 *   expected: the pinned DR, as its file's text; run: spawnSync, or a stand-in
 *   with its result's shape ({ status, signal, stdout, stderr, error }).
 * @returns {{ dr: string | null, runtime: boolean | null, entitlements: string[] | null, problems: string[] }}
 *   dr: the DR found; runtime: whether codesign showed the hardened runtime;
 *   entitlements: the top-level keys codesign showed set to true. Each is null
 *   when its command failed.
 */
export function checkSignature(app, { expected, identifier = IDENTIFIER, run = runCommand } = {}) {
  const problems = [];
  /**
   * A codesign command's output, stdout then stderr on lines of their own:
   * stdout may end without a newline, as a DR can, and must not run into
   * stderr's Executable= line. null, with a problem, when the command fails.
   */
  const codesign = (args) => {
    const command = `codesign ${args.join(" ")}`;
    const { status, signal, stdout, stderr, error } = run("codesign", [...args, app]);
    if (error) {
      problems.push(`could not run ${command}: ${error.message}`);
      return null;
    }
    const output = `${stdout ?? ""}\n${stderr ?? ""}`;
    if (status !== 0) {
      const how = status === null ? `signal ${signal}` : `exit ${status}`;
      problems.push(`${command} failed (${how}): ${output.trim()}`);
      return null;
    }
    return output;
  };

  codesign(COMMANDS.verify); // a failure is recorded in problems; there is nothing to read

  const requirements = codesign(COMMANDS.requirements);
  const dr = requirements === null ? null : parseDesignatedRequirement(requirements);
  if (requirements !== null && dr === null) {
    const printed = requirements.trim();
    problems.push(`no designated requirement in the output of codesign -d -r-${printed ? `: ${printed}` : " (it printed nothing)"}`);
  } else if (dr !== null) {
    problems.push(...drProblems(dr, { identifier, expected }));
  }

  const display = codesign(COMMANDS.display);
  const runtime = display === null ? null : hasHardenedRuntime(display);
  if (runtime === false) {
    const lines = codeDirectoryLines(display).map((line) => line.trim());
    problems.push(`the hardened runtime is off: ${lines.length > 0 ? lines.join("; ") : "codesign -d -vvv printed no CodeDirectory line"}`);
  }

  const plist = codesign(COMMANDS.entitlements);
  const entitlements = plist === null ? null : entitlementKeys(plist);
  if (entitlements !== null) {
    for (const name of ENTITLEMENTS) if (!entitlements.includes(name)) problems.push(`missing entitlement ${name}`);
    for (const name of entitlements) if (!ENTITLEMENTS.includes(name)) problems.push(`unexpected entitlement ${name}`);
  }

  return { dr, runtime, entitlements, problems };
}

/** `<app> [--expected-dr <file>]`, in any order. Throws a usage error. */
function parseArgs(argv) {
  let app;
  let expectedDr;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--expected-dr") {
      const value = argv[i + 1];
      if (value === undefined || value === "" || value.startsWith("-")) throw new Error("--expected-dr needs a value");
      if (expectedDr !== undefined) throw new Error("--expected-dr is given twice");
      expectedDr = value;
      i += 1;
    } else if (arg.startsWith("-") || app !== undefined) {
      throw new Error(`unexpected argument: ${arg}`);
    } else {
      app = arg;
    }
  }
  if (app === undefined) throw new Error("give the path of Fleetify.app");
  return { app, expectedDr };
}

/** Whether `path` is a folder; false when it isn't there. */
function isFolder(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`macos-signature: ${err.message}\n${USAGE}\n`);
    return 2;
  }
  const say = (line) => process.stdout.write(`macos-signature: ${line}\n`);
  const fail = (problems) => {
    for (const problem of problems) process.stderr.write(`macos-signature: ${problem}\n`);
    process.stderr.write(`macos-signature: ${problems.length} problem(s) with ${args.app}\n`);
    return 1;
  };
  if (!isFolder(args.app)) return fail([`${args.app} is not an app bundle: no folder at that path`]);

  const problems = [];
  let expected;
  if (args.expectedDr !== undefined) {
    try {
      expected = readFileSync(args.expectedDr, "utf8");
      say(`comparing the designated requirement with ${args.expectedDr}`);
    } catch (err) {
      problems.push(`can't read --expected-dr ${args.expectedDr}: ${err.code ?? err.message}`);
    }
  } else {
    say("checking the designated requirement's shape only: no --expected-dr to compare it with");
  }

  const result = checkSignature(args.app, { expected });
  if (result.dr !== null) process.stdout.write(`designated => ${result.dr}\n`);
  if (result.runtime !== null) say(`hardened runtime: ${result.runtime ? "on" : "off"}`);
  if (result.entitlements !== null) {
    say(`entitlements: ${result.entitlements.length > 0 ? result.entitlements.join(", ") : "(none)"}`);
  }
  problems.push(...result.problems);
  if (problems.length > 0) return fail(problems);
  say(`${args.app}: every check passes`);
  return 0;
}

function invokedDirectly() {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

// exitCode instead of process.exit(), so buffered output is written first.
if (invokedDirectly()) process.exitCode = main(process.argv.slice(2));
