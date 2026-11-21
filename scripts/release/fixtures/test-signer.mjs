/**
 * A minisign signer for tests only. Each key is made in memory for the test
 * run and never touches the disk. Signatures come out in the form the Tauri
 * CLI writes them: minisign's four-line text, base64-wrapped, which is what a
 * .sig file holds and what latest.json carries.
 *
 * Nothing in the release signs with this: the Tauri CLI signs the bundles,
 * and scripts/release/minisign.mjs only verifies. The tests use it to cover
 * cases the committed fixture can't: the raw ("Ed") mode, chosen trusted
 * comments, and whole bundle trees signed for assemble.mjs.
 */
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";

const base64 = (bytes) => Buffer.from(bytes).toString("base64");

/**
 * A fresh Ed25519 key with a random minisign key number.
 *
 * @returns {{ privateKey: import("node:crypto").KeyObject, keynum: Buffer, keyId: string, tauriPublicKey: string }}
 *   tauriPublicKey is the public key in Tauri's form (base64 of minisign's
 *   public key file), as tauri.conf.json and a .key.pub file hold it.
 */
export function makeTestKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const keynum = randomBytes(8);
  const keyId = Buffer.from(keynum).reverse().toString("hex").toUpperCase();
  const keyLine = base64(Buffer.concat([Buffer.from("Ed", "latin1"), keynum, raw]));
  return {
    privateKey,
    keynum,
    keyId,
    tauriPublicKey: base64(`untrusted comment: minisign public key: ${keyId}\n${keyLine}\n`),
  };
}

/**
 * Sign `data` the way tauri-cli 2.11.2 does (minisign 0.7.3): the prehashed
 * mode "ED" by default, or the raw mode "Ed".
 *
 * @param {ReturnType<typeof makeTestKey>} key
 * @param {Buffer} data
 * @param {{ algorithm?: string, trustedComment?: string, untrustedComment?: string }} [options]
 * @returns {string} the signature in Tauri's form: a .sig file's text
 */
export function signLikeTauri(
  key,
  data,
  {
    algorithm = "ED",
    trustedComment = "timestamp:1795238472\tfile:test.bin",
    untrustedComment = "signature from tauri secret key",
  } = {},
) {
  const message = algorithm === "ED" ? createHash("blake2b512").update(data).digest() : data;
  const signature = sign(null, message, key.privateKey);
  const global = sign(null, Buffer.concat([signature, Buffer.from(trustedComment, "utf8")]), key.privateKey);
  const signatureLine = base64(Buffer.concat([Buffer.from(algorithm, "latin1"), key.keynum, signature]));
  return base64(
    `untrusted comment: ${untrustedComment}\n${signatureLine}\ntrusted comment: ${trustedComment}\n${base64(global)}\n`,
  );
}
