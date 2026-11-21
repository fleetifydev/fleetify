/**
 * Tests for dry-run-config.mjs, which writes the updater config a release
 * dry run builds with: the run's own updater key, and an update endpoint on
 * 127.0.0.1 over plain http.
 *
 *   node --test scripts/release/dry-run-config.test.mjs
 *
 * The key is fixtures/minisign/fixture.pub, a public key in Tauri's form.
 */
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { dryRunConfig } from "./dry-run-config.mjs";

const SCRIPT = fileURLToPath(new URL("./dry-run-config.mjs", import.meta.url));
const FIXTURE_PUB = readFileSync(new URL("./fixtures/minisign/fixture.pub", import.meta.url), "utf8");
const FIXTURE_KEY_ID = "D6038C2BD30A992F";
const SHIPPED = JSON.parse(readFileSync(new URL("../../src-tauri/tauri.conf.json", import.meta.url), "utf8"));

const ENDPOINT = "http://127.0.0.1:18080/update/{{target}}/{{arch}}/{{current_version}}?bundle_type={{bundle_type}}";

const ROOT = mkdtempSync(join(tmpdir(), "dry-run-config-"));
after(() => rmSync(ROOT, { recursive: true, force: true }));
let count = 0;
/** A path under ROOT that doesn't exist yet. */
const fresh = (name) => join(ROOT, `${name}-${(count += 1)}`);

describe("dryRunConfig", () => {
  test("the exact overlay: the run's key, the local endpoint, and plain http allowed", () => {
    assert.deepEqual(dryRunConfig({ pubkey: FIXTURE_PUB }), {
      plugins: {
        updater: {
          pubkey: FIXTURE_PUB,
          endpoints: [ENDPOINT],
          dangerousInsecureTransportProtocol: true,
        },
      },
    });
  });

  test("another port", () => {
    assert.deepEqual(dryRunConfig({ pubkey: FIXTURE_PUB, port: 18090 }).plugins.updater.endpoints, [
      "http://127.0.0.1:18090/update/{{target}}/{{arch}}/{{current_version}}?bundle_type={{bundle_type}}",
    ]);
  });

  test("the endpoint asks with the same variables as the shipped fleetify.dev endpoint", () => {
    const suffix = "/update/{{target}}/{{arch}}/{{current_version}}?bundle_type={{bundle_type}}";
    assert.ok(SHIPPED.plugins.updater.endpoints[0].endsWith(suffix), SHIPPED.plugins.updater.endpoints[0]);
    assert.ok(dryRunConfig({ pubkey: FIXTURE_PUB }).plugins.updater.endpoints[0].endsWith(suffix));
  });

  test("a key that isn't a public key in Tauri's form is refused, as is one with a line break after it", () => {
    for (const pubkey of ["not a key", "", `${FIXTURE_PUB}\n`, undefined, 42]) {
      assert.throws(() => dryRunConfig({ pubkey }), /malformed public key/, JSON.stringify(pubkey));
    }
  });

  test("a port outside 1-65535, or not a whole number, is refused", () => {
    for (const port of [0, 65536, -1, 1.5, Number.NaN, "18080", null]) {
      assert.throws(() => dryRunConfig({ pubkey: FIXTURE_PUB, port }), /invalid port/, String(port));
    }
  });
});

/** Run the CLI with `args`. */
const cli = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });

/** A key file holding `text`. */
function keyFile(text) {
  const path = fresh("updater.key.pub");
  writeFileSync(path, text);
  return path;
}

describe("the CLI", () => {
  test("writes the overlay as JSON and names the key; exit 0", () => {
    const out = fresh("dry-run.json");
    const result = cli(["--pubkey-file", keyFile(FIXTURE_PUB), "--out", out]);
    assert.equal(result.status, 0, result.stderr);
    const text = readFileSync(out, "utf8");
    assert.equal(text, `${JSON.stringify(dryRunConfig({ pubkey: FIXTURE_PUB }), null, 2)}\n`);
    assert.match(result.stdout, new RegExp(`key id ${FIXTURE_KEY_ID}`));
    assert.ok(result.stdout.includes(ENDPOINT), result.stdout);
  });

  test("a key file that ends in a line break, LF or CRLF, gives the same overlay", () => {
    for (const ending of ["\n", "\r\n"]) {
      const out = fresh("dry-run.json");
      const result = cli(["--pubkey-file", keyFile(`${FIXTURE_PUB}${ending}`), "--out", out]);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(readFileSync(out, "utf8")), dryRunConfig({ pubkey: FIXTURE_PUB }));
    }
  });

  test("an out file that already exists is left alone; exit 1", () => {
    const out = fresh("tauri.conf.json");
    writeFileSync(out, "{}\n");
    const result = cli(["--pubkey-file", keyFile(FIXTURE_PUB), "--out", out]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /already exists/);
    assert.equal(readFileSync(out, "utf8"), "{}\n");
  });

  test("a key file that is missing or holds no public key: exit 1, nothing written", () => {
    for (const pubkeyFile of [fresh("missing.pub"), keyFile("not a key\n"), keyFile("")]) {
      const out = fresh("dry-run.json");
      const result = cli(["--pubkey-file", pubkeyFile, "--out", out]);
      assert.equal(result.status, 1, pubkeyFile);
      assert.match(result.stderr, /dry-run-config: /);
      assert.equal(existsSync(out), false);
    }
  });

  test("usage errors: exit 2", () => {
    const key = keyFile(FIXTURE_PUB);
    const out = fresh("dry-run.json");
    for (const args of [
      [],
      ["--pubkey-file", key],
      ["--out", out],
      ["--pubkey-file", key, "--out"],
      ["--pubkey-file", "", "--out", out],
      ["--pubkey-file", key, "--pubkey-file", key, "--out", out],
      [`--pubkey-file=${key}`, "--out", out],
      ["--pubkey-file", key, "--out", out, "--port", "18090"],
    ]) {
      const result = cli(args);
      assert.equal(result.status, 2, `${JSON.stringify(args)}: ${result.stderr}`);
      assert.match(result.stderr, /usage: node scripts\/release\/dry-run-config\.mjs/, JSON.stringify(args));
    }
    assert.equal(existsSync(out), false);
  });
});
