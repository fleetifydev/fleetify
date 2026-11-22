/**
 * minisign.mjs — check Tauri updater signatures in Node, the way the updater
 * plugin checks them before it installs an update (minisign-verify), so that
 * a release is checked before it is published rather than on every install.
 *
 * A Tauri signature (a .sig file, a latest.json "signature") is base64 of
 * minisign's four-line signature text:
 *
 *   untrusted comment: signature from tauri secret key
 *   <base64: algorithm (2 bytes), key number (8), Ed25519 signature (64)>
 *   trusted comment: timestamp:1795238472<TAB>file:Fleetify_0.2.0_amd64.AppImage<TAB>version:0.2.0
 *   <base64: global signature (64 bytes)>
 *
 * A Tauri public key (plugins.updater.pubkey, a .key.pub file) is base64 of
 * minisign's two-line public key text:
 *
 *   untrusted comment: minisign public key: 44C694713A20D751
 *   <base64: "Ed", key number (8 bytes), Ed25519 public key (32)>
 *
 * The algorithm is "ED", where the signature covers the BLAKE2b-512 hash of
 * the data (what tauri-cli 2.11.5 writes), or "Ed", where it covers the data
 * itself (older minisign). The global signature covers the 64 signature
 * bytes followed by the trusted comment's text, so that comment can't be
 * changed without the key. The untrusted comment isn't signed.
 *
 * The trusted comment is tab-separated key:value fields. From tauri-cli
 * 2.11.5 on, its version: field names the version the artifact was released
 * as: `tauri build` and `tauri bundle` write the app's version, and
 * `tauri signer sign` the one --app-version gives (none without it). The
 * updater compares that field with the version the update endpoint
 * announces, and refuses a mismatch; with requireSignedVersion, which the
 * shipped config sets, it refuses a signature without the field too.
 *
 * What verifySignature checks, in order:
 *   - the base64 wrapping and the base64 lines inside it are canonical and
 *     padded, as the updater's decoders require, and the text is UTF-8;
 *   - the text has the four lines above, and the algorithm is "ED" or "Ed";
 *   - the key number is the public key's;
 *   - the signature covers the data, and the global signature covers the
 *     trusted comment;
 *   - when given a version: the trusted comment's version: field names it,
 *     compared the way the updater compares them, and a comment without the
 *     field is refused, as the updater refuses it with requireSignedVersion.
 * The public key must be two lines, 42 bytes of "Ed" key, and not one of the
 * two degenerate keys minisign-verify refuses. A few things the CLI never
 * writes are refused although the updater would read past them: a carriage
 * return, a line after the global signature, a first line without
 * "untrusted comment: ".
 *
 * The CLI checks files against their signatures, and the version each one
 * must be bound to, as the jobs that sign the updater artifacts do before
 * they hand them on:
 *
 *   node scripts/release/minisign.mjs verify --pubkey-file <file> --version <v> [--sig-dir <dir>] <file>...
 *   node scripts/release/minisign.mjs verify --pubkey-config <tauri.conf.json> --expect-key-id <16 hex digits> --version <v> [--sig-dir <dir>] <file>...
 *
 * Each <file> is checked against <file>.sig, or with --sig-dir against
 * <dir>/<the file's name>.sig, with the key in the public key file, or with
 * plugins.updater.pubkey in the config, whose key id must be the one
 * expected. --version, MAJOR.MINOR.PATCH, is the version every signature
 * must name. Exit codes: 0 every signature verifies; 1 one doesn't, each
 * named on stderr; 2 usage.
 */
import { createHash, createPublicKey, verify as verifyEd25519 } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The DER prefix that makes 32 raw bytes an Ed25519 SubjectPublicKeyInfo. */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const UNTRUSTED = "untrusted comment: ";
const TRUSTED = "trusted comment: ";
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
/** Strict UTF-8 that keeps a byte-order mark, so the text is read byte for byte. */
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * The bytes of canonical, padded base64, or null. The last character before
 * the padding can carry bits beyond the data; Node's decoder drops them
 * without a word, the updater's refuse them, so the encoding must round-trip.
 */
function decodeBase64(text) {
  if (typeof text !== "string" || !BASE64.test(text)) return null;
  const bytes = Buffer.from(text, "base64");
  return bytes.toString("base64") === text ? bytes : null;
}

/**
 * The lines of a Tauri-form value: base64 of UTF-8 text with "\n" line ends,
 * the last one optional. Null when it is anything else.
 */
function unwrapLines(value) {
  const bytes = decodeBase64(value);
  if (bytes === null) return null;
  let text;
  try {
    text = UTF8.decode(bytes);
  } catch {
    return null;
  }
  if (text.includes("\r")) return null;
  const lines = text.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * The two Ed25519 public keys minisign-verify refuses outright: all zero
 * bytes, and the identity point (1, then zeros, either sign bit). OpenSSL
 * verifies against them, and can accept a forged signature for one.
 */
function isDegenerate(raw) {
  const zero = raw.every((byte) => byte === 0);
  const identity = raw[0] === 1 && raw.subarray(1, 31).every((byte) => byte === 0) && (raw[31] & 0x7f) === 0;
  return zero || identity;
}

/** Ed25519 verification that reports a failure instead of throwing one. */
function ed25519Verifies(message, key, signature) {
  try {
    return verifyEd25519(null, message, key, signature);
  } catch {
    return false;
  }
}

/** MAJOR.MINOR.PATCH, as release versions are written. */
const RELEASE_VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

/**
 * The version: field of a trusted comment, as the updater reads it: the
 * first tab-separated field that starts with "version:". Null when there is
 * none.
 */
function signedVersion(comment) {
  const field = comment.split("\t").find((f) => f.startsWith("version:"));
  return field === undefined ? null : field.slice("version:".length);
}

/**
 * Whether a signed version names `version`, as the updater compares them: as
 * semver with leading "v"s dropped, else as text. For a MAJOR.MINOR.PATCH
 * version, which has one semver spelling and no pre-release or build part,
 * that is the signed text without its leading "v"s being exactly `version`.
 */
const namesVersion = (signed, version) => signed.replace(/^v+/, "") === version;

/** A key number as minisign prints it: the 8 bytes read as a little-endian integer, in hex. */
const keyIdOf = (keynum) => Buffer.from(keynum).reverse().toString("hex").toUpperCase();

/**
 * Read a public key in Tauri's form, exactly as given: the updater decodes
 * the configured value without trimming it.
 *
 * @param {string} tauriPubkey
 * @returns {{ keyId: string, keynum: Buffer, key: import("node:crypto").KeyObject }}
 * @throws {Error} "malformed public key: …"
 */
export function parsePublicKey(tauriPubkey) {
  const malformed = (why) => new Error(`malformed public key: ${why}`);
  const lines = unwrapLines(tauriPubkey);
  if (lines === null) throw malformed("not base64 of a minisign public key");
  if (lines.length !== 2) throw malformed(`expected 2 lines, found ${lines.length}`);
  if (!lines[0].startsWith(UNTRUSTED)) throw malformed("the first line is not an untrusted comment");
  const bytes = decodeBase64(lines[1]);
  if (bytes === null || bytes.length !== 42) throw malformed("the key line is not 42 bytes of base64");
  if (bytes.toString("latin1", 0, 2) !== "Ed") throw malformed("not an Ed25519 minisign key");
  const keynum = Buffer.from(bytes.subarray(2, 10));
  const raw = bytes.subarray(10);
  if (isDegenerate(raw)) throw malformed("not a usable Ed25519 key");
  let key;
  try {
    key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: "der", type: "spki" });
  } catch (err) {
    throw malformed(err.message);
  }
  return { keyId: keyIdOf(keynum), keynum, key };
}

/** A parsed key as parsePublicKey returns it. */
const isParsedKey = (value) =>
  value !== null &&
  typeof value === "object" &&
  Buffer.isBuffer(value.keynum) &&
  value.keynum.length === 8 &&
  value.key?.asymmetricKeyType === "ed25519";

/**
 * Check a Tauri signature over `data`. Never throws: every way to fail has
 * its own reason.
 *
 *   malformed …                         the signature or key can't be read
 *   unsupported signature algorithm …   neither "ED" nor "Ed"
 *   key id mismatch …                   signed with another key
 *   signature does not match the data   the data, or the signature, changed
 *   trusted comment …                   the comment, or the global signature, changed
 *   signed for version …                the trusted comment names another version
 *   the trusted comment names no version …   it has no version: field
 *
 * @param {{ data: Uint8Array, tauriSignature: string, publicKey: string | ReturnType<typeof parsePublicKey>, version?: string }} options
 *   tauriSignature is a .sig file's text, trimmed; publicKey is in Tauri's
 *   form or already parsed; version, when given, is the version the
 *   signature must be bound to, in MAJOR.MINOR.PATCH form: the release's,
 *   as the update endpoint announces it.
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function verifySignature({ data, tauriSignature, publicKey, version }) {
  const fail = (reason) => ({ ok: false, reason });
  if (!(data instanceof Uint8Array)) return fail("the data to check must be bytes");
  if (version !== undefined && (typeof version !== "string" || !RELEASE_VERSION.test(version))) {
    return fail(`the version to compare with must be MAJOR.MINOR.PATCH, not ${JSON.stringify(version)}`);
  }

  let key = publicKey;
  if (typeof publicKey === "string") {
    try {
      key = parsePublicKey(publicKey);
    } catch (err) {
      return fail(err.message);
    }
  } else if (!isParsedKey(publicKey)) {
    return fail("malformed public key: expected one in Tauri's form or from parsePublicKey");
  }

  const lines = unwrapLines(tauriSignature);
  if (lines === null) return fail("malformed signature: not base64 of a minisign signature");
  if (lines.length !== 4) return fail(`malformed signature: expected 4 lines, found ${lines.length}`);
  const [untrusted, signatureLine, trusted, globalLine] = lines;
  if (!untrusted.startsWith(UNTRUSTED)) return fail("malformed signature: the first line is not an untrusted comment");
  if (!trusted.startsWith(TRUSTED)) return fail("malformed signature: the third line is not a trusted comment");
  const signatureBytes = decodeBase64(signatureLine);
  if (signatureBytes === null || signatureBytes.length !== 74) {
    return fail("malformed signature: the signature line is not 74 bytes of base64");
  }
  const globalSignature = decodeBase64(globalLine);
  if (globalSignature === null || globalSignature.length !== 64) {
    return fail("malformed signature: the global signature line is not 64 bytes of base64");
  }

  const algorithm = signatureBytes.toString("latin1", 0, 2);
  if (algorithm !== "ED" && algorithm !== "Ed") return fail(`unsupported signature algorithm ${JSON.stringify(algorithm)}`);
  const keynum = signatureBytes.subarray(2, 10);
  if (!keynum.equals(key.keynum)) {
    return fail(`key id mismatch: signed with key ${keyIdOf(keynum)}, expected ${keyIdOf(key.keynum)}`);
  }
  const signature = signatureBytes.subarray(10);
  const message = algorithm === "ED" ? createHash("blake2b512").update(data).digest() : data;
  if (!ed25519Verifies(message, key.key, signature)) return fail("signature does not match the data");
  const comment = trusted.slice(TRUSTED.length);
  if (!ed25519Verifies(Buffer.concat([signature, Buffer.from(comment, "utf8")]), key.key, globalSignature)) {
    return fail("trusted comment does not match its global signature: one of them was changed");
  }
  // Only now is the comment's text known to be signed, and so worth reading.
  if (version === undefined) return { ok: true };
  const signed = signedVersion(comment);
  if (signed === null) {
    return fail(`the trusted comment names no version, so the signature isn't bound to ${version}: an updater with requireSignedVersion refuses it`);
  }
  if (!namesVersion(signed, version)) return fail(`signed for version ${JSON.stringify(signed)}, not ${version}`);
  return { ok: true };
}

const USAGE = `usage: node scripts/release/minisign.mjs verify --pubkey-file <file> --version <v> [--sig-dir <dir>] <file>...
       node scripts/release/minisign.mjs verify --pubkey-config <tauri.conf.json> --expect-key-id <16 hex digits> --version <v> [--sig-dir <dir>] <file>...`;

/** The options the verify command takes, each with a value. */
const VALUED = ["--pubkey-file", "--pubkey-config", "--expect-key-id", "--version", "--sig-dir"];

/** The verify command line. Throws a usage error. */
function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (command !== "verify") throw new Error(command === undefined ? "missing command: verify" : `unknown command: ${command}`);
  const values = new Map();
  const files = [];
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (VALUED.includes(arg)) {
      const value = rest[i + 1];
      if (value === undefined || value === "" || value.startsWith("-")) throw new Error(`${arg} needs a value`);
      if (values.has(arg)) throw new Error(`${arg} is given twice`);
      values.set(arg, value);
      i += 1;
    } else if (arg.startsWith("-")) {
      throw new Error(`unexpected argument: ${arg}`);
    } else {
      files.push(arg);
    }
  }
  const file = values.get("--pubkey-file");
  const config = values.get("--pubkey-config");
  const expectKeyId = values.get("--expect-key-id");
  const version = values.get("--version");
  if ((file === undefined) === (config === undefined)) throw new Error("give --pubkey-file, or --pubkey-config with --expect-key-id");
  if (config !== undefined && expectKeyId === undefined) throw new Error("--pubkey-config needs --expect-key-id");
  if (file !== undefined && expectKeyId !== undefined) throw new Error("--expect-key-id goes with --pubkey-config");
  if (expectKeyId !== undefined && !/^[0-9A-Fa-f]{16}$/.test(expectKeyId)) throw new Error(`--expect-key-id must be 16 hex digits, not ${expectKeyId}`);
  if (version === undefined) throw new Error("--version is required: the version every signature must be bound to");
  if (!RELEASE_VERSION.test(version)) throw new Error(`--version must be MAJOR.MINOR.PATCH, not ${version}`);
  if (files.length === 0) throw new Error("name the files to check");
  return { file, config, expectKeyId, version, sigDir: values.get("--sig-dir"), files };
}

/** The public key the command line names; throws an Error naming what is wrong. */
function keyFor({ file, config, expectKeyId }) {
  if (file !== undefined) return parsePublicKey(readFileSync(file, "utf8").trim());
  const pubkey = JSON.parse(readFileSync(config, "utf8"))?.plugins?.updater?.pubkey;
  if (typeof pubkey !== "string") throw new Error(`${config} has no plugins.updater.pubkey`);
  const key = parsePublicKey(pubkey);
  if (key.keyId !== expectKeyId.toUpperCase()) throw new Error(`the updater key in ${config} has key id ${key.keyId}, expected ${expectKeyId}`);
  return key;
}

function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`minisign: ${err.message}\n${USAGE}\n`);
    return 2;
  }
  let key;
  try {
    key = keyFor(args);
  } catch (err) {
    process.stderr.write(`minisign: ${err.message}\n`);
    return 1;
  }
  let failed = 0;
  for (const file of args.files) {
    let data;
    let signature;
    try {
      data = readFileSync(file);
    } catch (err) {
      process.stderr.write(`minisign: can't read ${file}: ${err.code ?? err.message}\n`);
      failed += 1;
      continue;
    }
    const sigFile = args.sigDir === undefined ? `${file}.sig` : join(args.sigDir, `${basename(file)}.sig`);
    try {
      signature = readFileSync(sigFile, "utf8").trim();
    } catch (err) {
      process.stderr.write(`minisign: can't read ${sigFile}: ${err.code ?? err.message}\n`);
      failed += 1;
      continue;
    }
    const result = verifySignature({ data, tauriSignature: signature, publicKey: key, version: args.version });
    if (result.ok) {
      process.stdout.write(`minisign: signature ok, key ${key.keyId}, version ${args.version}: ${file}\n`);
    } else {
      process.stderr.write(`minisign: ${file}: ${result.reason}\n`);
      failed += 1;
    }
  }
  if (failed > 0) {
    process.stderr.write(`minisign: ${failed} of ${args.files.length} file(s) failed\n`);
    return 1;
  }
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
