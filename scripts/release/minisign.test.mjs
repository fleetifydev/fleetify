/**
 * Tests for minisign.mjs, which checks Tauri updater signatures: minisign
 * signatures, base64-wrapped, as .sig files and latest.json carry them.
 *
 *   node --test scripts/release/minisign.test.mjs
 *
 * fixtures/minisign/ was made with the repo's own Tauri CLI, once with
 * 2.11.2, whose signatures name no version:
 *
 *   npx tauri signer generate --ci -p "" -w "$SCRATCH/fx.key"      (fixture.pub)
 *   npx tauri signer generate --ci -p "" -w "$SCRATCH/other.key"   (other.pub)
 *   npx tauri signer sign -f "$SCRATCH/fx.key" -p "" hello.txt     (hello.txt.sig)
 *
 * and once with 2.11.5, which binds a signature to the version it is given:
 *
 *   npx tauri signer generate --ci -p "" -w "$SCRATCH/versioned.key"                       (versioned.pub)
 *   npx tauri signer sign -f "$SCRATCH/versioned.key" -p "" --app-version 1.2.3 hello.txt   (hello.txt.1.2.3.sig)
 *
 * Only the public keys and the signatures were kept; every private key was
 * deleted. The other cases sign with a key made in memory for the run
 * (fixtures/test-signer.mjs), and with minisign's own test vectors.
 */
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { makeTestKey, signLikeTauri } from "./fixtures/test-signer.mjs";
import { parsePublicKey, verifySignature } from "./minisign.mjs";
import { UPDATER_KEY_ID } from "./release-assets.mjs";

const fixture = (name) => readFileSync(new URL(`./fixtures/minisign/${name}`, import.meta.url));
const HELLO = fixture("hello.txt");
const HELLO_SIG = fixture("hello.txt.sig").toString("utf8");
const FIXTURE_PUB = fixture("fixture.pub").toString("utf8");
const OTHER_PUB = fixture("other.pub").toString("utf8");
const VERSIONED_PUB = fixture("versioned.pub").toString("utf8");
/** hello.txt, signed by tauri-cli 2.11.5 with --app-version 1.2.3. */
const HELLO_SIG_1_2_3 = fixture("hello.txt.1.2.3.sig").toString("utf8");
const CONFIG_PUB = JSON.parse(readFileSync(new URL("../../src-tauri/tauri.conf.json", import.meta.url), "utf8"))
  .plugins.updater.pubkey;

/** A Tauri-form value (base64) as minisign text, and back. */
const unwrap = (value) => Buffer.from(value, "base64").toString("utf8");
const wrap = (text) => Buffer.from(text, "utf8").toString("base64");
/** A Tauri signature with line `i` of its minisign text replaced by `edit(line)`. */
const editLine = (signature, i, edit) => {
  const lines = unwrap(signature).split("\n");
  lines[i] = edit(lines[i]);
  return wrap(lines.join("\n"));
};
/** The algorithm bytes of a Tauri signature. */
const algorithmOf = (signature) => Buffer.from(unwrap(signature).split("\n")[1], "base64").subarray(0, 2).toString("latin1");

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
/**
 * The same bytes, spelled non-canonically: the last character before the
 * padding gets a trailing bit set. Node's decoder ignores that bit; the
 * updater's decoders (the base64 crate's STANDARD engine for the wrapping,
 * minisign-verify's for the lines inside) refuse it.
 */
const nonCanonical = (text) => {
  const match = /^(.*)([A-Za-z0-9+/])(=+)$/s.exec(text);
  assert.ok(match, `no padding in ${text}`);
  return match[1] + ALPHABET[ALPHABET.indexOf(match[2]) | 1] + match[3];
};

const verify = (data, tauriSignature, publicKey = FIXTURE_PUB) => verifySignature({ data, tauriSignature, publicKey });
const assertFails = (result, pattern, name = "") => {
  assert.equal(result.ok, false, `${name}: ${JSON.stringify(result)}`);
  assert.match(result.reason, pattern, name);
};

describe("the Tauri CLI's signature (fixtures/minisign)", () => {
  test("verifies against the key that made it", () => {
    assert.deepEqual(verify(HELLO, HELLO_SIG), { ok: true });
  });

  test("tauri-cli 2.11.2 signs in minisign's prehashed mode, ED", () => {
    assert.equal(algorithmOf(HELLO_SIG), "ED");
  });

  test("its trusted comment is the one the CLI writes: a timestamp and the file name", () => {
    assert.match(unwrap(HELLO_SIG).split("\n")[2], /^trusted comment: timestamp:\d+\tfile:hello\.txt$/);
  });

  test("the fixtures hold no line break, so a CRLF checkout can't change their bytes", () => {
    for (const name of ["hello.txt", "hello.txt.sig", "hello.txt.1.2.3.sig", "fixture.pub", "other.pub", "versioned.pub"]) {
      assert.doesNotMatch(fixture(name).toString("latin1"), /[\r\n]/, name);
    }
  });

  test("one changed byte of data: the signature doesn't match", () => {
    const data = Buffer.from(HELLO);
    data[5] ^= 0x01;
    const result = verify(data, HELLO_SIG);
    assertFails(result, /signature does not match the data/);
    assert.doesNotMatch(result.reason, /trusted comment|key id/);
  });

  test("a byte more or a byte less of data: the signature doesn't match", () => {
    assertFails(verify(Buffer.concat([HELLO, Buffer.from("\n")]), HELLO_SIG), /signature does not match the data/);
    assertFails(verify(HELLO.subarray(0, -1), HELLO_SIG), /signature does not match the data/);
  });

  test("checked against another key: a key id mismatch, naming both ids", () => {
    const result = verify(HELLO, HELLO_SIG, OTHER_PUB);
    assertFails(result, /key id/);
    assert.match(result.reason, new RegExp(parsePublicKey(FIXTURE_PUB).keyId));
    assert.match(result.reason, new RegExp(parsePublicKey(OTHER_PUB).keyId));
  });

  test("an edited trusted comment: the global signature no longer covers it", () => {
    const newTime = editLine(HELLO_SIG, 2, (line) => line.replace(/timestamp:(\d)/, (_, d) => `timestamp:${(Number(d) + 1) % 10}`));
    const addedField = editLine(HELLO_SIG, 2, (line) => `${line}\tversion:9.9.9`);
    const otherFile = editLine(HELLO_SIG, 2, (line) => line.replace("file:hello.txt", "file:Fleetify_9.9.9_amd64.AppImage"));
    for (const signature of [newTime, addedField, otherFile]) {
      const result = verify(HELLO, signature);
      assertFails(result, /trusted comment/);
      assert.doesNotMatch(result.reason, /does not match the data/);
    }
  });

  test("the untrusted comment's text isn't signed, as in minisign, so editing it changes nothing", () => {
    const edited = editLine(HELLO_SIG, 0, () => "untrusted comment: anything at all");
    assert.deepEqual(verify(HELLO, edited), { ok: true });
  });

  test("garbage: malformed", () => {
    const sigLine = unwrap(HELLO_SIG).split("\n")[1];
    const cases = {
      empty: "",
      word: "garbage",
      "not base64": "!!!!",
      "base64 of plain text": wrap("hello"),
      "the minisign text itself, unwrapped": unwrap(HELLO_SIG),
      "three lines": wrap(unwrap(HELLO_SIG).split("\n").slice(0, 3).join("\n")),
      "a signature line one byte short": editLine(HELLO_SIG, 1, () => Buffer.from(sigLine, "base64").subarray(0, 73).toString("base64")),
      "a signature line one byte long": editLine(HELLO_SIG, 1, () =>
        Buffer.concat([Buffer.from(sigLine, "base64"), Buffer.from([0])]).toString("base64"),
      ),
      "a global signature one byte short": editLine(HELLO_SIG, 3, (line) => Buffer.from(line, "base64").subarray(0, 63).toString("base64")),
      "no trusted comment prefix": editLine(HELLO_SIG, 2, (line) => line.replace("trusted comment: ", "trusted: ")),
      "no untrusted comment prefix": editLine(HELLO_SIG, 0, () => "signature from tauri secret key"),
      "lines after the global signature": wrap(`${unwrap(HELLO_SIG)}extra\n`),
      "a carriage return": wrap(unwrap(HELLO_SIG).replace(/\n/g, "\r\n")),
      "whitespace around the wrapping": ` ${HELLO_SIG}`,
    };
    for (const [name, signature] of Object.entries(cases)) {
      assertFails(verify(HELLO, signature), /malformed/, name);
    }
  });

  test("not a string or no data: malformed, not a crash", () => {
    assertFails(verifySignature({ data: HELLO, tauriSignature: undefined, publicKey: FIXTURE_PUB }), /malformed/);
    assertFails(verifySignature({ data: HELLO, tauriSignature: 42, publicKey: FIXTURE_PUB }), /malformed/);
    assertFails(verifySignature({ data: "hello", tauriSignature: HELLO_SIG, publicKey: FIXTURE_PUB }), /must be bytes/);
  });

  test("a malformed public key gives ok:false rather than a throw", () => {
    assertFails(verify(HELLO, HELLO_SIG, "garbage"), /malformed public key/);
  });

  test("a public key that is already parsed works the same", () => {
    assert.deepEqual(verify(HELLO, HELLO_SIG, parsePublicKey(FIXTURE_PUB)), { ok: true });
    assertFails(verify(HELLO, HELLO_SIG, parsePublicKey(OTHER_PUB)), /key id/);
  });
});

describe("the Tauri CLI's signature bound to a version (fixtures/minisign, tauri-cli 2.11.5)", () => {
  const check = (version) => verifySignature({ data: HELLO, tauriSignature: HELLO_SIG_1_2_3, publicKey: VERSIONED_PUB, version });

  test("its trusted comment adds the version --app-version names, last, after the timestamp and the file name", () => {
    assert.match(unwrap(HELLO_SIG_1_2_3).split("\n")[2], /^trusted comment: timestamp:\d+\tfile:hello\.txt\tversion:1\.2\.3$/);
    assert.equal(algorithmOf(HELLO_SIG_1_2_3), "ED");
  });

  test("verifies for the version it names, and is refused for any other, naming both", () => {
    assert.deepEqual(check("1.2.3"), { ok: true });
    assertFails(check("1.2.4"), /^signed for version "1\.2\.3", not 1\.2\.4$/);
    assertFails(check("99.0.0"), /^signed for version "1\.2\.3", not 99\.0\.0$/);
  });

  test("tauri-cli 2.11.2's signature names no version, so it is refused once a version is asked for", () => {
    assert.deepEqual(verify(HELLO, HELLO_SIG), { ok: true });
    assertFails(
      verifySignature({ data: HELLO, tauriSignature: HELLO_SIG, publicKey: FIXTURE_PUB, version: "1.2.3" }),
      /^the trusted comment names no version, so the signature isn't bound to 1\.2\.3/,
    );
  });
});

describe("parsePublicKey", () => {
  test("the updater key in tauri.conf.json has key id UPDATER_KEY_ID", () => {
    const key = parsePublicKey(CONFIG_PUB);
    assert.equal(key.keyId, UPDATER_KEY_ID);
    assert.equal(key.keyId, "44C694713A20D751");
    assert.ok(Buffer.isBuffer(key.keynum));
    assert.equal(key.keynum.length, 8);
    assert.equal(key.key.type, "public");
    assert.equal(key.key.asymmetricKeyType, "ed25519");
  });

  test("each key id reads the key number the way minisign prints it in the key's comment", () => {
    for (const pub of [CONFIG_PUB, FIXTURE_PUB, OTHER_PUB]) {
      const printed = /^untrusted comment: minisign public key: ([0-9A-F]{16})\n/.exec(unwrap(pub))[1];
      assert.equal(parsePublicKey(pub).keyId, printed);
    }
    assert.notEqual(parsePublicKey(FIXTURE_PUB).keyId, parsePublicKey(OTHER_PUB).keyId);
  });

  test("anything else throws 'malformed public key'", () => {
    const [comment, keyLine] = unwrap(FIXTURE_PUB).split("\n");
    const keyBytes = Buffer.from(keyLine, "base64");
    const cases = {
      empty: "",
      word: "garbage",
      "base64 of plain text": wrap("hello"),
      "the minisign text itself, unwrapped": unwrap(FIXTURE_PUB),
      "the bare key line": keyLine,
      "a key line one byte short": wrap(`${comment}\n${keyBytes.subarray(0, 41).toString("base64")}\n`),
      "a key line one byte long": wrap(`${comment}\n${Buffer.concat([keyBytes, Buffer.from([0])]).toString("base64")}\n`),
      "not an Ed25519 key": wrap(`${comment}\n${Buffer.concat([Buffer.from("XX"), keyBytes.subarray(2)]).toString("base64")}\n`),
      "no comment line": wrap(`${keyLine}\n`),
      "a first line that isn't an untrusted comment": wrap(`comment: ${comment}\n${keyLine}\n`),
      "a comment that isn't UTF-8": Buffer.concat([Buffer.from(`${comment}`), Buffer.from([0xff]), Buffer.from(`\n${keyLine}\n`)]).toString("base64"),
      "a third line": wrap(`${comment}\n${keyLine}\nextra\n`),
      "a carriage return": wrap(`${comment}\r\n${keyLine}\r\n`),
      // The updater decodes the configured value exactly as given.
      "a trailing newline": `${FIXTURE_PUB}\n`,
      "a leading space": ` ${FIXTURE_PUB}`,
      "not a string": undefined,
    };
    for (const [name, value] of Object.entries(cases)) {
      assert.throws(() => parsePublicKey(value), /malformed public key/, name);
    }
  });

  test("a degenerate key (all zero, or the identity point) throws, as minisign-verify refuses one", () => {
    const keynum = Buffer.from("0123456789abcdef", "hex");
    const keyOf = (raw) =>
      wrap(`untrusted comment: minisign public key\n${Buffer.concat([Buffer.from("Ed"), keynum, raw]).toString("base64")}\n`);
    const identity = Buffer.concat([Buffer.from([1]), Buffer.alloc(31)]);
    const identitySigned = Buffer.from(identity);
    identitySigned[31] = 0x80;
    for (const [name, raw] of [
      ["all zero", Buffer.alloc(32)],
      ["the identity point", identity],
      ["the identity point with the sign bit set", identitySigned],
    ]) {
      assert.throws(() => parsePublicKey(keyOf(raw)), /malformed public key/, name);
      // A zero signature line and global signature, which Node's Ed25519 alone can accept for such a key.
      const signature = wrap(
        [
          "untrusted comment: x",
          Buffer.concat([Buffer.from("Ed"), keynum, Buffer.alloc(64)]).toString("base64"),
          "trusted comment: x",
          Buffer.alloc(64).toString("base64"),
        ].join("\n"),
      );
      assertFails(verifySignature({ data: Buffer.from("x"), tauriSignature: signature, publicKey: keyOf(raw) }), /malformed public key/, name);
    }
  });

  test("a non-canonical base64 spelling throws, as the updater refuses it", () => {
    const [comment, keyLine] = unwrap(FIXTURE_PUB).split("\n");
    // Pad the comment until the wrapping needs padding, then spell it non-canonically.
    let pub = FIXTURE_PUB;
    for (let extra = 1; !pub.endsWith("="); extra += 1) pub = wrap(`${comment}${"x".repeat(extra)}\n${keyLine}\n`);
    assert.equal(parsePublicKey(pub).keyId, parsePublicKey(FIXTURE_PUB).keyId);
    const odd = nonCanonical(pub);
    assert.deepEqual(Buffer.from(odd, "base64"), Buffer.from(pub, "base64"), "Node's decoder reads both the same");
    assert.throws(() => parsePublicKey(odd), /malformed public key/);
  });
});

// minisign's own test vectors, as the minisign-verify crate (the updater
// plugin's verifier) tests itself with: one signature in the raw mode ("Ed")
// and one in the prehashed mode ("ED"), both over the four bytes "test".
describe("minisign's test vectors: the raw and the prehashed mode", () => {
  const PUBLIC_KEY = wrap(
    "untrusted comment: minisign public key E7620F1842B4E81F\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3\n",
  );
  const RAW = wrap(
    [
      "untrusted comment: signature from minisign secret key",
      "RWQf6LRCGA9i59SLOFxz6NxvASXDJeRtuZykwQepbDEGt87ig1BNpWaVWuNrm73YiIiJbq71Wi+dP9eKL8OC351vwIasSSbXxwA=",
      "trusted comment: timestamp:1555779966\tfile:test",
      "QtKMXWyYcwdpZAlPF7tE2ENJkRd1ujvKjlj1m9RtHTBnZPa5WKU5uWRs5GoP5M/VqE81QFuMKI5k/SfNQUaOAA==",
    ].join("\n"),
  );
  const PREHASHED = wrap(
    [
      "untrusted comment: signature from minisign secret key",
      "RUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=",
      "trusted comment: timestamp:1556193335\tfile:test",
      "y/rUw2y8/hOUYjZU71eHp/Wo1KZ40fGy2VJEDl34XMJM+TX48Ss/17u3IvIfbVR1FkZZSNCisQbuQY+bHwhEBg==",
    ].join("\n"),
  );

  test("the key id matches the one minisign printed", () => {
    assert.equal(parsePublicKey(PUBLIC_KEY).keyId, "E7620F1842B4E81F");
  });

  test("the raw-mode signature verifies, and fails for other data", () => {
    assert.equal(algorithmOf(RAW), "Ed");
    assert.deepEqual(verifySignature({ data: Buffer.from("test"), tauriSignature: RAW, publicKey: PUBLIC_KEY }), { ok: true });
    assertFails(
      verifySignature({ data: Buffer.from("Test"), tauriSignature: RAW, publicKey: PUBLIC_KEY }),
      /signature does not match the data/,
    );
  });

  test("the prehashed signature verifies, and fails for other data", () => {
    assert.equal(algorithmOf(PREHASHED), "ED");
    assert.deepEqual(verifySignature({ data: Buffer.from("test"), tauriSignature: PREHASHED, publicKey: PUBLIC_KEY }), {
      ok: true,
    });
    assertFails(
      verifySignature({ data: Buffer.from("Test"), tauriSignature: PREHASHED, publicKey: PUBLIC_KEY }),
      /signature does not match the data/,
    );
  });
});

// The updater compares a version: field in a verified trusted comment with
// the version the manifest announces, and refuses the update when they
// differ; with requireSignedVersion, which the shipped config sets, it also
// refuses a signature that has no such field. verifySignature does both when
// it is given the version.
describe("a version: field in the trusted comment", () => {
  const key = makeTestKey();
  const data = Buffer.from("an updater artifact\n");
  const signedFor = (field) => signLikeTauri(key, data, { trustedComment: `timestamp:1795238472\tfile:a.AppImage${field}` });
  const check = (signature, version) => verifySignature({ data, tauriSignature: signature, publicKey: key.tauriPublicKey, version });

  test("the given version: verifies", () => {
    assert.deepEqual(check(signedFor("\tversion:0.2.0"), "0.2.0"), { ok: true });
  });

  test("another version: refused, naming both", () => {
    assertFails(check(signedFor("\tversion:0.1.0"), "0.2.0"), /^signed for version "0\.1\.0", not 0\.2\.0$/);
  });

  test("no version: field, as tauri signer sign writes without --app-version: refused, as requireSignedVersion refuses it", () => {
    const reason = /^the trusted comment names no version, so the signature isn't bound to 0\.2\.0/;
    assertFails(check(signedFor(""), "0.2.0"), reason);
    assertFails(verifySignature({ data: HELLO, tauriSignature: HELLO_SIG, publicKey: FIXTURE_PUB, version: "0.2.0" }), reason);
  });

  test("compared as the updater compares them: leading v's dropped, anything else must be the same version", () => {
    assert.deepEqual(check(signedFor("\tversion:v0.2.0"), "0.2.0"), { ok: true });
    assert.deepEqual(check(signedFor("\tversion:vv0.2.0"), "0.2.0"), { ok: true });
    for (const other of ["0.2.0+build.1", "0.2.0-rc.1", "0.2", "00.2.0", "0.2.0 ", "", "V0.2.0"]) {
      assertFails(check(signedFor(`\tversion:${other}`), "0.2.0"), /^signed for version /, JSON.stringify(other));
    }
  });

  test("the first version: field counts, as in the updater", () => {
    assert.deepEqual(check(signedFor("\tversion:0.2.0\tversion:9.9.9"), "0.2.0"), { ok: true });
    assertFails(check(signedFor("\tversion:9.9.9\tversion:0.2.0"), "0.2.0"), /signed for version "9\.9\.9"/);
  });

  test("a field must start with version: exactly", () => {
    assert.deepEqual(check(signedFor("\tthe version:9.9.9\tVersion:9.9.9\tversion:0.2.0"), "0.2.0"), { ok: true });
    assertFails(check(signedFor("\tthe version:0.2.0\tVersion:0.2.0\tfile-version:0.2.0"), "0.2.0"), /names no version/);
  });

  test("the timestamp and file: fields don't count, nor does a version: that is part of another field", () => {
    assertFails(check(signLikeTauri(key, data, { trustedComment: "timestamp:1\tfile:app-version:0.2.0.AppImage" }), "0.2.0"), /names no version/);
  });

  test("the field counts only once the global signature covers it", () => {
    const forged = editLine(signedFor("\tversion:0.2.0"), 2, (line) => line.replace("version:0.2.0", "version:0.1.0"));
    const result = check(forged, "0.2.0");
    assertFails(result, /trusted comment/);
    assert.doesNotMatch(result.reason, /signed for version/);
  });

  test("a version to compare with that isn't MAJOR.MINOR.PATCH: refused", () => {
    for (const bad of ["v0.2.0", "0.2", "0.2.0-rc.1", "", 2]) {
      assertFails(check(signedFor("\tversion:0.2.0"), bad), /must be MAJOR\.MINOR\.PATCH/, JSON.stringify(bad));
    }
  });

  test("without a version to compare with, the field isn't read", () => {
    assert.deepEqual(verifySignature({ data, tauriSignature: signedFor("\tversion:9.9.9"), publicKey: key.tauriPublicKey }), {
      ok: true,
    });
  });
});

describe("signatures made with a key from the test run", () => {
  const key = makeTestKey();
  const data = Buffer.from("an updater artifact\n");
  const check = (signature, d = data) => verifySignature({ data: d, tauriSignature: signature, publicKey: key.tauriPublicKey });

  test("the prehashed mode (ED) verifies", () => {
    assert.deepEqual(check(signLikeTauri(key, data)), { ok: true });
  });

  test("the raw mode (Ed) verifies", () => {
    assert.deepEqual(check(signLikeTauri(key, data, { algorithm: "Ed" })), { ok: true });
  });

  test("switching the mode byte (ED to Ed, or Ed to ED) breaks the signature", () => {
    const flip = (signature, to) =>
      editLine(signature, 1, (line) => {
        const bytes = Buffer.from(line, "base64");
        bytes.write(to, 0, "latin1");
        return bytes.toString("base64");
      });
    assertFails(check(flip(signLikeTauri(key, data), "Ed")), /signature does not match the data/);
    assertFails(check(flip(signLikeTauri(key, data, { algorithm: "Ed" }), "ED")), /signature does not match the data/);
  });

  test("an unknown algorithm is refused", () => {
    assertFails(check(signLikeTauri(key, data, { algorithm: "XX" })), /unsupported signature algorithm/);
  });

  test("a global signature taken from another signature: the trusted comment check fails", () => {
    const one = signLikeTauri(key, data, { trustedComment: "timestamp:1\tfile:a" });
    const two = signLikeTauri(key, data, { trustedComment: "timestamp:2\tfile:a" });
    const spliced = editLine(one, 3, () => unwrap(two).split("\n")[3]);
    assertFails(check(spliced), /trusted comment/);
  });

  test("a trusted comment line ending in a carriage return is refused, even when the global signature covers it", () => {
    // The updater reads the line without it ("\r\n" is a line end to Rust's lines()), so it would check a different text.
    const signature = signLikeTauri(key, data, { trustedComment: "timestamp:1\tfile:a\r" });
    assertFails(check(signature), /malformed/);
  });

  test("a comment that isn't UTF-8 is refused, as the updater refuses the whole signature", () => {
    const lines = unwrap(signLikeTauri(key, data)).split("\n");
    const bytes = (first, third) =>
      Buffer.concat([first, Buffer.from(`\n${lines[1]}\n`), third, Buffer.from(`\n${lines[3]}\n`)]).toString("base64");
    const bad = Buffer.concat([Buffer.from("untrusted comment: "), Buffer.from([0xc3, 0x28])]);
    assertFails(check(bytes(bad, Buffer.from(lines[2]))), /malformed/, "untrusted comment");
    assertFails(check(bytes(Buffer.from(lines[0]), Buffer.concat([Buffer.from(lines[2]), Buffer.from([0xff])]))), /malformed/, "trusted comment");
  });

  test("the trusted comment is signed as UTF-8", () => {
    assert.deepEqual(check(signLikeTauri(key, data, { trustedComment: "timestamp:1\tfile:Fleetify_ü_é.AppImage" })), { ok: true });
  });

  test("a non-canonical base64 wrapping is refused, as the updater's decoder refuses it", () => {
    // The untrusted comment's length sets the wrapping's padding: find one signature ending in "=" and one in "==".
    const byPadding = new Map();
    for (let extra = 0; byPadding.size < 2; extra += 1) {
      const signature = signLikeTauri(key, data, { untrustedComment: `signature from tauri secret key${"x".repeat(extra)}` });
      const padding = /=*$/.exec(signature)[0];
      if (padding !== "" && !byPadding.has(padding)) byPadding.set(padding, signature);
    }
    for (const [padding, signature] of byPadding) {
      assert.deepEqual(check(signature), { ok: true }, padding);
      const odd = nonCanonical(signature);
      assert.deepEqual(Buffer.from(odd, "base64"), Buffer.from(signature, "base64"), `${padding}: Node's decoder reads both the same`);
      assertFails(check(odd), /malformed/, padding);
    }
  });

  test("a non-canonical signature or global signature line is refused, as minisign-verify refuses it", () => {
    const signature = signLikeTauri(key, data);
    // 74 bytes end in "=", 64 bytes in "==": both lines have trailing bits to set.
    for (const i of [1, 3]) {
      const line = unwrap(signature).split("\n")[i];
      assert.deepEqual(Buffer.from(nonCanonical(line), "base64"), Buffer.from(line, "base64"), `line ${i + 1}`);
      assertFails(check(editLine(signature, i, nonCanonical)), /malformed/, `line ${i + 1}`);
    }
  });

  test("a different key with the same key number: the signature doesn't match", () => {
    const impostor = makeTestKey();
    impostor.keynum = key.keynum;
    assertFails(check(signLikeTauri(impostor, data)), /signature does not match the data/);
  });
});

describe("the verify CLI", () => {
  const SCRIPT = fileURLToPath(new URL("./minisign.mjs", import.meta.url));
  const FIXTURES = fileURLToPath(new URL("./fixtures/minisign/", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "minisign-cli-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const cli = (...args) => spawnSync(process.execPath, [SCRIPT, "verify", ...args], { encoding: "utf8" });
  const versionedPub = join(FIXTURES, "versioned.pub");
  const versionedId = parsePublicKey(VERSIONED_PUB.trim()).keyId;
  /** hello.txt beside its signature for version 1.2.3, as hello.txt.sig, the way the CLI looks for it. */
  const signed = join(dir, "signed");
  mkdirSync(signed);
  const hello = join(signed, "hello.txt");
  copyFileSync(join(FIXTURES, "hello.txt"), hello);
  copyFileSync(join(FIXTURES, "hello.txt.1.2.3.sig"), `${hello}.sig`);
  /** A Tauri config whose updater key is the versioned fixture's. */
  const config = join(dir, "tauri.conf.json");
  writeFileSync(config, JSON.stringify({ plugins: { updater: { pubkey: VERSIONED_PUB.trim() } } }));

  test("each file's .sig against a public key file and the version: exit 0, one line per file", () => {
    const result = cli("--pubkey-file", versionedPub, "--version", "1.2.3", hello);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes(`signature ok, key ${versionedId}, version 1.2.3: ${hello}`), result.stdout);
  });

  test("against the key in a Tauri config, whose key id must be the one expected", () => {
    const ok = cli("--pubkey-config", config, "--expect-key-id", versionedId, "--version", "1.2.3", hello);
    assert.equal(ok.status, 0, ok.stderr);
    const other = cli("--pubkey-config", config, "--expect-key-id", "0000000000000000", "--version", "1.2.3", hello);
    assert.equal(other.status, 1);
    assert.ok(other.stderr.includes(`has key id ${versionedId}, expected 0000000000000000`), other.stderr);
  });

  test("a signature made for another version, or for none: exit 1, naming the file and why", () => {
    const other = cli("--pubkey-file", versionedPub, "--version", "1.2.4", hello);
    assert.equal(other.status, 1);
    assert.ok(other.stderr.includes(`${hello}: signed for version "1.2.3", not 1.2.4`), other.stderr);
    // tauri-cli 2.11.2's signature, which names no version.
    const legacy = join(FIXTURES, "hello.txt");
    const none = cli("--pubkey-file", join(FIXTURES, "fixture.pub"), "--version", "1.2.3", legacy);
    assert.equal(none.status, 1);
    assert.ok(none.stderr.includes(`${legacy}: the trusted comment names no version, so the signature isn't bound to 1.2.3`), none.stderr);
  });

  test("another key, changed data or a missing .sig: exit 1, naming the file", () => {
    const wrongKey = cli("--pubkey-file", join(FIXTURES, "other.pub"), "--version", "1.2.3", hello);
    assert.equal(wrongKey.status, 1);
    assert.ok(wrongKey.stderr.includes(`${hello}: key id mismatch`), wrongKey.stderr);
    const changed = join(dir, "hello.txt");
    writeFileSync(changed, "hello, changed\n");
    copyFileSync(join(FIXTURES, "hello.txt.1.2.3.sig"), `${changed}.sig`);
    const tampered = cli("--pubkey-file", versionedPub, "--version", "1.2.3", changed);
    assert.equal(tampered.status, 1);
    assert.ok(tampered.stderr.includes(`${changed}: signature does not match the data`), tampered.stderr);
    const unsigned = join(dir, "unsigned.txt");
    writeFileSync(unsigned, "no signature\n");
    const missing = cli("--pubkey-file", versionedPub, "--version", "1.2.3", unsigned);
    assert.equal(missing.status, 1);
    assert.ok(missing.stderr.includes(`can't read ${unsigned}.sig`), missing.stderr);
  });

  test("--sig-dir: each file's signature is <dir>/<its name>.sig, and the file's own .sig isn't read", () => {
    const sigs = join(dir, "sigs");
    mkdirSync(sigs);
    copyFileSync(join(FIXTURES, "hello.txt.1.2.3.sig"), join(sigs, "hello.txt.sig"));
    // The file's own .sig is tauri-cli 2.11.2's, which names no version and
    // was made with another key.
    const bare = join(dir, "bare");
    mkdirSync(bare);
    copyFileSync(join(FIXTURES, "hello.txt"), join(bare, "hello.txt"));
    copyFileSync(join(FIXTURES, "hello.txt.sig"), join(bare, "hello.txt.sig"));
    const ok = cli("--pubkey-file", versionedPub, "--version", "1.2.3", "--sig-dir", sigs, join(bare, "hello.txt"));
    assert.equal(ok.status, 0, ok.stderr);
    assert.ok(ok.stdout.includes(`signature ok, key ${versionedId}, version 1.2.3: ${join(bare, "hello.txt")}`), ok.stdout);
    const missing = cli("--pubkey-file", versionedPub, "--version", "1.2.3", "--sig-dir", join(dir, "nowhere"), join(bare, "hello.txt"));
    assert.equal(missing.status, 1);
    assert.ok(missing.stderr.includes(`can't read ${join(dir, "nowhere", "hello.txt.sig")}`), missing.stderr);
  });

  test("usage errors exit 2, a missing --version among them", () => {
    for (const args of [
      [],
      ["--pubkey-file", versionedPub, "--version", "1.2.3"],
      ["--pubkey-file", versionedPub, hello],
      ["--pubkey-config", config, "--expect-key-id", versionedId, hello],
      ["--pubkey-config", config, "--version", "1.2.3", hello],
      ["--pubkey-file", versionedPub, "--pubkey-config", config, "--expect-key-id", versionedId, "--version", "1.2.3", hello],
      ["--expect-key-id", "XYZ", "--pubkey-config", config, "--version", "1.2.3", hello],
      ["--pubkey-file", versionedPub, "--version", "v1.2.3", hello],
      ["--pubkey-file", versionedPub, "--version", "1.2", hello],
      ["--pubkey-file", versionedPub, "--version", "1.2.3", "--version", "1.2.3", hello],
      ["--pubkey-file", versionedPub, "--version", "1.2.3", "--sig-dir", hello],
    ]) {
      const result = cli(...args);
      assert.equal(result.status, 2, `${args.join(" ")}: ${result.stderr}`);
      assert.match(result.stderr, /usage:/);
    }
    const bare = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8" });
    assert.equal(bare.status, 2);
  });
});
