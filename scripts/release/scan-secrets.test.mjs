/**
 * Tests for scan-secrets.mjs, the secret scanner the release build runs
 * over its artefacts.
 *
 *   node --test scripts/release/scan-secrets.test.mjs
 *
 * Every fake credential below is assembled at runtime from short pieces
 * and runs of "x"/"X", so no complete token-shaped string appears in this
 * file: GitHub push protection (the repo is public), gitleaks and
 * scan-secrets.mjs itself have nothing to match here.
 */
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { RULES, scanPaths, scanText } from "./scan-secrets.mjs";

const SCRIPT = fileURLToPath(new URL("./scan-secrets.mjs", import.meta.url));

const x = (n, ch = "x") => ch.repeat(n);

// One fake value per rule. `hit` is the shortest string the rule flags;
// `miss` falls one character short of it (for private-key: a public key
// header) and must not be flagged.
const CASES = [
  { rule: "anthropic", hit: "sk-" + "ant-" + x(20), miss: "sk-" + "ant-" + x(19) },
  { rule: "openai-project", hit: "sk-" + "proj-" + x(20), miss: "sk-" + "proj-" + x(19) },
  { rule: "openai-legacy", hit: "sk-" + x(40), miss: "sk-" + x(39) },
  { rule: "github-token", hit: "gh" + "p_" + x(36), miss: "gh" + "p_" + x(35) },
  { rule: "aws-access-key", hit: "AKIA" + x(16, "X"), miss: "AKIA" + x(15, "X") },
  { rule: "slack", hit: "xo" + "xb-" + x(10), miss: "xo" + "xb-" + x(9) },
  {
    rule: "private-key",
    hit: "-----BEGIN " + "PRIVATE KEY-----",
    miss: "-----BEGIN " + "PUBLIC KEY-----",
  },
  {
    rule: "notdiamond-assignment",
    hit: "NOTDIAMOND_API_KEY" + "=" + x(16),
    miss: "NOTDIAMOND_API_KEY" + "=" + x(15),
  },
];

const fake = (rule) => CASES.find((c) => c.rule === rule).hit;

/** How a value sits in a minified bundle: a quoted string literal. */
const line = (value) => `export const VALUE = "${value}";\n`;

const ROOT = mkdtempSync(join(tmpdir(), "scan-secrets-"));
after(() => rmSync(ROOT, { recursive: true, force: true }));

/** Create ROOT/<name> holding `files` (relative path → content). */
function tree(name, files) {
  const dir = join(ROOT, name);
  mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const file = join(dir, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  return dir;
}

const runCli = (...args) =>
  spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });

describe("scanText", () => {
  for (const { rule, hit } of CASES) {
    test(`flags a fake ${rule} value as "${rule}"`, () => {
      assert.deepEqual(scanText(line(hit), "assets/index.js"), [
        { file: "assets/index.js", rule },
      ]);
    });
  }

  for (const { rule, miss } of CASES) {
    test(`does not flag the ${rule} near miss`, () => {
      assert.deepEqual(scanText(line(miss), "assets/index.js"), []);
    });
  }

  test("does not flag the public-by-design PostHog key or OIDC client id", () => {
    const text =
      `posthog.init("phc_${x(43)}", { api_host: "https://us.i.posthog.com" });\n` +
      `const clientId = "fleetify-desktop";\n`;
    assert.deepEqual(scanText(text, "assets/index.js"), []);
  });

  test("reports a rule once per file, however often it matches", () => {
    const text = line(fake("slack")).repeat(3);
    assert.deepEqual(scanText(text, "app.js"), [{ file: "app.js", rule: "slack" }]);
  });

  test("every rule has a fixture above, in report order", () => {
    assert.deepEqual(
      RULES.map((r) => r.name),
      CASES.map((c) => c.rule),
    );
  });
});

describe("scanPaths", () => {
  test("walks a directory recursively, dotfiles included", () => {
    const dir = tree("recursive", {
      "index.html": "<!doctype html><title>Fleetify</title>\n",
      "assets/deep/chunk.js": line(fake("anthropic")),
      "config/.env": `${fake("notdiamond-assignment")}\n`,
    });
    assert.deepEqual(scanPaths([dir]), {
      findings: [
        { file: join(dir, "assets", "deep", "chunk.js"), rule: "anthropic" },
        { file: join(dir, "config", ".env"), rule: "notdiamond-assignment" },
      ],
      errors: [],
      files: 3,
    });
  });

  test("scans a binary file byte for byte", () => {
    const file = join(tree("binary", {}), "fleetify-app");
    writeFileSync(
      file,
      Buffer.concat([
        // ELF magic, NUL bytes and a truncated UTF-8 sequence right before the value.
        Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x00, 0x00, 0xff, 0xfe, 0xc3]),
        Buffer.from(fake("github-token"), "latin1"),
        Buffer.from([0x00, 0x80, 0xff]),
      ]),
    );
    assert.deepEqual(scanPaths([file]), {
      findings: [{ file, rule: "github-token" }],
      errors: [],
      files: 1,
    });
  });
});

describe("CLI", () => {
  test("exits 1 on a dirty directory, printing <file>: <rule> and never the value", () => {
    const dir = tree("cli-dirty", {
      "README.txt": "nothing to see here\n",
      "src/app.js": line(fake("aws-access-key")) + line(fake("slack")),
    });
    const result = runCli(dir);
    assert.equal(result.status, 1, result.stderr);
    const file = join(dir, "src", "app.js");
    assert.equal(result.stdout, `${file}: aws-access-key\n${file}: slack\n`);
    for (const value of [fake("aws-access-key"), fake("slack")]) {
      assert.ok(!result.stdout.includes(value), "value leaked to stdout");
      assert.ok(!result.stderr.includes(value), "value leaked to stderr");
    }
  });

  test("exits 0 on a clean directory and prints no findings", () => {
    const dir = tree("cli-clean", {
      "index.html": `<script>posthog.init("phc_${x(43)}")</script>\n`,
      "assets/auth.js": `const clientId = "fleetify-desktop";\n`,
    });
    const result = runCli(dir);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
  });

  test("exits 2 with a usage line when given no path", () => {
    const result = runCli();
    assert.equal(result.status, 2);
    assert.match(result.stderr, /usage/i);
  });

  test("exits 2 when a path does not exist, even if the others are clean", () => {
    const clean = tree("cli-missing", { "index.html": "<title>ok</title>\n" });
    const missing = join(ROOT, "no-such-dir");
    const result = runCli(clean, missing);
    assert.equal(result.status, 2);
    assert.ok(result.stderr.includes(missing), result.stderr);
  });

  test("exits 2 when a path holds no files to scan", () => {
    const empty = tree("cli-empty", {});
    const result = runCli(empty);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /no files/);
  });
});
