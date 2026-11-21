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
 *   trusted comment: timestamp:1795238472<TAB>file:Fleetify_0.2.0_amd64.AppImage
 *   <base64: global signature (64 bytes)>
 *
 * A Tauri public key (plugins.updater.pubkey, a .key.pub file) is base64 of
 * minisign's two-line public key text:
 *
 *   untrusted comment: minisign public key: 44C694713A20D751
 *   <base64: "Ed", key number (8 bytes), Ed25519 public key (32)>
 *
 * The algorithm is "ED", where the signature covers the BLAKE2b-512 hash of
 * the data (what tauri-cli 2.11.2 writes), or "Ed", where it covers the data
 * itself (older minisign). The global signature covers the 64 signature
 * bytes followed by the trusted comment's text, so that comment can't be
 * changed without the key. The untrusted comment isn't signed.
 *
 * What verifySignature checks, in order:
 *   - the base64 wrapping and the base64 lines inside it are canonical and
 *     padded, as the updater's decoders require, and the text is UTF-8;
 *   - the text has the four lines above, and the algorithm is "ED" or "Ed";
 *   - the key number is the public key's;
 *   - the signature covers the data, and the global signature covers the
 *     trusted comment;
 *   - when given the release version: a version: field in the trusted
 *     comment, if there is one, names that version, compared the way the
 *     updater compares them.
 * The public key must be two lines, 42 bytes of "Ed" key, and not one of the
 * two degenerate keys minisign-verify refuses. A few things the CLI never
 * writes are refused although the updater would read past them: a carriage
 * return, a line after the global signature, a first line without
 * "untrusted comment: ".
 */
import { createHash, createPublicKey, verify as verifyEd25519 } from "node:crypto";

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
 *
 * @param {{ data: Uint8Array, tauriSignature: string, publicKey: string | ReturnType<typeof parsePublicKey>, version?: string }} options
 *   tauriSignature is a .sig file's text, trimmed; publicKey is in Tauri's
 *   form or already parsed; version, when given, is the release version, in
 *   MAJOR.MINOR.PATCH form.
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
  const signed = version === undefined ? null : signedVersion(comment);
  if (signed !== null && !namesVersion(signed, version)) return fail(`signed for version ${JSON.stringify(signed)}, not ${version}`);
  return { ok: true };
}
