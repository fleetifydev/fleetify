#!/usr/bin/env node
/**
 * provenance.mjs — keep a release's build provenance with it: check that the
 * attestation bundle release.yml's assemble job made attests exactly the
 * assembled release, then copy it to the file the draft's upload takes.
 *
 *   node scripts/release/provenance.mjs --bundle <file> --release <dir> --out <file>
 *
 * The bundle is what actions/attest-build-provenance writes to its
 * bundle-path output: one Sigstore bundle, on one line, whose DSSE envelope
 * carries an in-toto statement of SLSA build provenance. Its subjects must be
 * exactly the files of the release folder, each under the file's name and
 * with its SHA-256, so the provenance a release carries is the one made of
 * its own files. The bundle is copied byte for byte, to a new file outside
 * the release folder: the folder stays as it was attested, and the
 * provenance can't attest itself.
 *
 * Anyone can then check a downloaded file against it without asking GitHub
 * for the attestation: `gh attestation verify <file> --bundle <out> --repo
 * fleetifydev/fleetify`.
 *
 * Exit codes: 0 copied; 1 a problem, each listed on stderr; 2 usage.
 */
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const USAGE = "usage: node scripts/release/provenance.mjs --bundle <file> --release <dir> --out <file>";

/** A Sigstore bundle's media type, of version 0.3 or a later 0.x. */
const BUNDLE_MEDIA_TYPE = /^application\/vnd\.dev\.sigstore\.bundle\.v0\.([3-9]|[1-9]\d+)\+json$/;
export const PAYLOAD_TYPE = "application/vnd.in-toto+json";
export const STATEMENT_TYPE = "https://in-toto.io/Statement/v1";
export const PREDICATE_TYPE = "https://slsa.dev/provenance/v1";

const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The release folder's files, each with its SHA-256, sorted by name.
 *
 * @param {string} dir
 * @returns {{ files: { name: string, sha256: string }[], problems: string[] }}
 */
export function releaseFiles(dir) {
  const files = [];
  const problems = [];
  for (const name of readdirSync(dir).sort(compare)) {
    const stats = lstatSync(join(dir, name));
    if (!stats.isFile()) {
      problems.push(`${name} in the release folder is not a regular file`);
      continue;
    }
    files.push({ name, sha256: createHash("sha256").update(readFileSync(join(dir, name))).digest("hex") });
  }
  if (files.length === 0 && problems.length === 0) problems.push("the release folder is empty");
  return { files, problems };
}

/**
 * What is wrong with a bundle, as the provenance of a release's files.
 *
 * @param {string} text  the bundle file, as actions/attest wrote it
 * @param {{ name: string, sha256: string }[]} files  the release's files
 * @returns {string[]} one message per problem; empty when it attests exactly those files
 */
export function provenanceProblems(text, files) {
  if (text.replace(/\n$/, "").includes("\n")) return ["the bundle isn't one line of JSON, as actions/attest writes one attestation"];
  let bundle;
  try {
    bundle = JSON.parse(text);
  } catch {
    return ["the bundle isn't JSON"];
  }
  if (!isObject(bundle) || !BUNDLE_MEDIA_TYPE.test(String(bundle.mediaType))) return ["the bundle isn't a Sigstore bundle"];
  const envelope = bundle.dsseEnvelope;
  if (!isObject(envelope) || envelope.payloadType !== PAYLOAD_TYPE || typeof envelope.payload !== "string") {
    return ["the bundle doesn't carry an in-toto statement in a DSSE envelope"];
  }
  let statement;
  try {
    statement = JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8"));
  } catch {
    return ["the bundle's statement isn't JSON"];
  }
  if (!isObject(statement) || statement._type !== STATEMENT_TYPE) return ["the bundle's statement isn't an in-toto statement"];
  if (statement.predicateType !== PREDICATE_TYPE) return [`the bundle's statement is a ${JSON.stringify(statement.predicateType)}, not SLSA build provenance`];
  if (!Array.isArray(statement.subject) || statement.subject.length === 0) return ["the bundle's statement has no subject"];

  const problems = [];
  const attested = new Map();
  for (const subject of statement.subject) {
    const name = isObject(subject) ? subject.name : undefined;
    const sha256 = isObject(subject) && isObject(subject.digest) ? subject.digest.sha256 : undefined;
    if (typeof name !== "string" || typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) {
      problems.push(`the bundle attests ${JSON.stringify(subject)}, which isn't a file with a SHA-256`);
    } else if (attested.has(name)) problems.push(`the bundle attests ${name} twice`);
    else attested.set(name, sha256);
  }
  for (const { name, sha256 } of files) {
    if (!attested.has(name)) problems.push(`the bundle doesn't attest ${name}`);
    else if (attested.get(name) !== sha256) problems.push(`the bundle attests another ${name} (SHA-256 ${attested.get(name)}, not ${sha256})`);
  }
  const names = new Set(files.map(({ name }) => name));
  for (const name of [...attested.keys()].sort(compare)) {
    if (!names.has(name)) problems.push(`the bundle attests ${name}, which the release doesn't have`);
  }
  return problems;
}

/** `--bundle <file> --release <dir> --out <file>`, each once, with the output outside the release folder. Throws a usage error. */
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    const key = { "--bundle": "bundle", "--release": "release", "--out": "out" }[flag];
    if (key === undefined) throw new Error(`unknown argument ${JSON.stringify(flag)}`);
    if (value === undefined || value === "") throw new Error(`${flag} needs a value`);
    if (Object.hasOwn(args, key)) throw new Error(`${flag} is given twice`);
    args[key] = value;
  }
  for (const flag of ["--bundle", "--release", "--out"]) {
    if (!Object.hasOwn(args, flag.slice(2))) throw new Error(`give ${flag}`);
  }
  const path = relative(resolve(args.release), resolve(args.out));
  const outside = path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path);
  if (!outside) {
    throw new Error("--out must be outside the release folder, which the provenance attests");
  }
  return args;
}

function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`provenance: ${err.message}\n${USAGE}\n`);
    return 2;
  }
  let bytes;
  let release;
  try {
    bytes = readFileSync(args.bundle);
    release = releaseFiles(args.release);
  } catch (err) {
    process.stderr.write(`provenance: ${err.message}\n`);
    return 1;
  }
  const problems = [...release.problems, ...provenanceProblems(bytes.toString("utf8"), release.files)];
  if (problems.length > 0) {
    for (const problem of problems) process.stderr.write(`provenance: ${problem}\n`);
    process.stderr.write(`provenance: ${args.bundle} isn't the build provenance of ${args.release}, so it isn't kept\n`);
    return 1;
  }
  try {
    mkdirSync(dirname(args.out), { recursive: true });
    // A new file: never one that is there already, or a link to another.
    writeFileSync(args.out, bytes, { flag: "wx" });
  } catch (err) {
    process.stderr.write(`provenance: ${err.message}\n`);
    return 1;
  }
  process.stdout.write(`provenance: ${args.out} attests the ${release.files.length} files of ${args.release}\n`);
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
