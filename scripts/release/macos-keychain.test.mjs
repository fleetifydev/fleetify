/**
 * Tests for macos-keychain.sh, which build.yml's macOS identity steps run to
 * put a code-signing identity into a keychain of the job's own and check
 * that codesign signs with it.
 *
 *   node --test scripts/release/macos-keychain.test.mjs
 *
 * security, codesign, cc and sudo are macOS's, so stand-ins on PATH log each
 * call and answer as a scenario asks. openssl is the real one, behind a
 * stand-in that logs its arguments, and the watchdog is the real perl.
 * The certificate test runs only where openssl is installed; it reads the
 * OpenSSL config from the script itself, the same one the dry run uses.
 */
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./macos-keychain.sh", import.meta.url));
const TEXT = readFileSync(SCRIPT, "utf8");

const which = (name) => {
  const found = spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" });
  return found.status === 0 ? found.stdout.trim() : null;
};
const OPENSSL = process.platform === "win32" ? null : which("openssl");
const SKIP_SHELL = process.platform === "win32" || which("bash") === null ? "needs bash, on Linux or macOS" : false;
const SKIP_OPENSSL = SKIP_SHELL || (OPENSSL === null && "needs openssl");
const SKIP_STUBS = SKIP_OPENSSL || (which("perl") === null && "needs perl, for the watchdog");

const ROOT = mkdtempSync(join(tmpdir(), "macos-keychain-"));
after(() => rmSync(ROOT, { recursive: true, force: true }));
let count = 0;
const fresh = (name) => {
  const dir = join(ROOT, `${name}-${(count += 1)}`);
  mkdirSync(dir);
  return dir;
};

const DRY_RUN_IDENTITY = "Fleetify Dry Run Code Signing";
const SHA1 = "0123456789ABCDEF0123456789ABCDEF01234567";

/** Each stand-in logs its name and arguments, one call a line. */
const LOG_CALL = `{ printf '%s' "\${0##*/}"; for a in "$@"; do printf ' %s' "$a"; done; printf '\\n'; } >> "$STUB_LOG"`;
const STUBS = {
  security: `#!/bin/sh
${LOG_CALL}
case "$1" in
  list-keychains)
    case " $* " in *" -s "*) ;; *) echo '    "/Users/runner/Library/Keychains/login.keychain-db"' ;; esac ;;
  find-identity)
    if [ -n "\${STUB_FIND_IDENTITY+set}" ]; then
      printf '%s\\n' "$STUB_FIND_IDENTITY"
    else
      printf '  1) %s "%s"\\n     1 valid identities found\\n' ${SHA1} "$IDENTITY"
    fi ;;
esac
exit 0
`,
  codesign: `#!/bin/sh
${LOG_CALL}
case "\${STUB_CODESIGN:-ok}" in
  fail) echo "error: The specified item could not be found in the keychain." >&2; exit 1 ;;
  hang) exec sleep 60 ;;
esac
exit 0
`,
  cc: `#!/bin/sh
${LOG_CALL}
cat > /dev/null
out=""
while [ $# -gt 0 ]; do
  if [ "$1" = -o ]; then out=$2; shift; fi
  shift
done
: > "$out"
`,
  sudo: `#!/bin/sh
${LOG_CALL}
exec "$@"
`,
  openssl: `#!/bin/sh
${LOG_CALL}
exec "$REAL_OPENSSL" "$@"
`,
};

/** A folder of stand-ins for macOS's tools, and their log. */
function stubs() {
  const bin = fresh("bin");
  for (const [name, script] of Object.entries(STUBS)) {
    writeFileSync(join(bin, name), script);
    chmodSync(join(bin, name), 0o755);
  }
  return { bin, log: join(bin, "calls.log") };
}

/** Run the script with `args` and `env`, with the stand-ins first on PATH: { status, stdout, stderr, calls, githubEnv, dir }. */
function run(args, env = {}, { timeout = 60_000 } = {}) {
  const { bin, log } = stubs();
  const dir = join(fresh("job"), "codesign");
  const githubEnv = join(ROOT, `github-env-${(count += 1)}`);
  writeFileSync(githubEnv, "");
  writeFileSync(log, "");
  const result = spawnSync("bash", [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    timeout,
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: process.env.HOME,
      STUB_LOG: log,
      REAL_OPENSSL: OPENSSL ?? "openssl",
      CODESIGN_DIR: dir,
      GITHUB_ENV: githubEnv,
      ...env,
    },
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    calls: readFileSync(log, "utf8").split("\n").filter(Boolean),
    githubEnv: readFileSync(githubEnv, "utf8"),
    dir,
  };
}

/** A PKCS#12 identity for `name`, under `password`, made with the real openssl in a fresh folder. */
function makeP12(name, password) {
  const dir = fresh("p12");
  const env = { ...process.env, P12_PASSWORD: password };
  const opts = { cwd: dir, env, encoding: "utf8" };
  const req = spawnSync(OPENSSL, ["req", "-x509", "-newkey", "rsa:2048", "-days", "1", "-subj", `/CN=${name}`, "-keyout", "key.pem", "-passout", "env:P12_PASSWORD", "-out", "cert.pem"], opts);
  assert.equal(req.status, 0, req.stderr);
  const p12 = spawnSync(OPENSSL, ["pkcs12", "-export", "-inkey", "key.pem", "-passin", "env:P12_PASSWORD", "-in", "cert.pem", "-out", "identity.p12", "-passout", "env:P12_PASSWORD"], opts);
  assert.equal(p12.status, 0, p12.stderr);
  rmSync(join(dir, "key.pem"));
  return join(dir, "identity.p12");
}

/** The extensions `openssl x509 -text` prints: { name, critical, value } each, value its lines joined. */
function extensionsOf(text) {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => /^\s*X509v3 extensions:\s*$/.test(line));
  assert.ok(start !== -1, `no extensions in:\n${text}`);
  const indent = (line) => line.match(/^\s*/)[0].length;
  const headerIndent = indent(lines[start + 1]);
  const extensions = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "") continue;
    if (indent(line) < headerIndent) break;
    if (indent(line) === headerIndent) {
      const [, name, critical] = line.trim().match(/^(.*?):\s*(critical)?$/);
      extensions.push({ name, critical: critical === "critical", value: [] });
    } else {
      extensions.at(-1).value.push(line.trim());
    }
  }
  return extensions.map(({ value, ...rest }) => ({ ...rest, value: value.join(" ") }));
}

/** The calls whose line starts with `prefix`. */
const callsOf = (calls, prefix) => calls.filter((call) => call.startsWith(prefix));

describe("macos-keychain.sh's dry-run certificate", () => {
  test("cert-config gives openssl req the release certificate's five extensions, under the identity's name", { skip: SKIP_SHELL }, () => {
    const result = spawnSync("bash", [SCRIPT, "cert-config"], { encoding: "utf8", env: { PATH: process.env.PATH, IDENTITY: DRY_RUN_IDENTITY } });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^prompt = no$/m);
    assert.match(result.stdout, /^x509_extensions = ext$/m);
    assert.match(result.stdout, new RegExp(`^CN = ${DRY_RUN_IDENTITY}$`, "m"));
  });

  test("an identity name with characters an OpenSSL config reads is refused", { skip: SKIP_SHELL }, () => {
    for (const name of ["Fleetify $HOME", "Fleetify # comment", "Fleetify\nO = Other"]) {
      const result = spawnSync("bash", [SCRIPT, "cert-config"], { encoding: "utf8", env: { PATH: process.env.PATH, IDENTITY: name } });
      assert.equal(result.status, 1, JSON.stringify(name));
      assert.match(result.stdout, /::error::the dry run's identity name/);
    }
  });

  test("it is made from that config alone: openssl req gets -config, and nothing gets -addext", () => {
    const req = TEXT.split("\n").filter((line) => /\bopenssl req\b/.test(line) && !line.trim().startsWith("#"));
    assert.equal(req.length, 1, "the script runs openssl req once");
    assert.match(req[0], /\s-config "\$dir\/identity\.cnf"(\s|$)/);
    assert.doesNotMatch(TEXT, /-addext/);
    assert.match(TEXT, /^\s*cert_config > "\$dir\/identity\.cnf"$/m);
  });

  test("it has exactly basicConstraints, keyUsage, extendedKeyUsage and both key identifiers, each once", { skip: SKIP_OPENSSL }, () => {
    const dir = join(fresh("cert"), "codesign");
    const result = spawnSync("bash", [SCRIPT, "make-dry-run-identity"], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: process.env.HOME, IDENTITY: DRY_RUN_IDENTITY, CODESIGN_DIR: dir },
    });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    // The step's log shows which openssl ran, and the certificate it made.
    assert.match(result.stdout, /^OpenSSL: \S+/m);
    assert.match(result.stdout, /X509v3 extensions:/);
    const text = spawnSync(OPENSSL, ["x509", "-in", join(dir, "identity.pem"), "-noout", "-text", "-certopt", "no_pubkey,no_sigdump"], { encoding: "utf8" }).stdout;
    const extensions = extensionsOf(text);
    assert.deepEqual(
      extensions.map(({ name, critical }) => ({ name, critical })).sort((a, b) => (a.name < b.name ? -1 : 1)),
      [
        { name: "X509v3 Authority Key Identifier", critical: false },
        { name: "X509v3 Basic Constraints", critical: true },
        { name: "X509v3 Extended Key Usage", critical: true },
        { name: "X509v3 Key Usage", critical: true },
        { name: "X509v3 Subject Key Identifier", critical: false },
      ],
    );
    const value = (name) => extensions.find((extension) => extension.name === name).value;
    assert.equal(value("X509v3 Basic Constraints"), "CA:FALSE");
    assert.equal(value("X509v3 Key Usage"), "Digital Signature");
    assert.equal(value("X509v3 Extended Key Usage"), "Code Signing");
    assert.equal(value("X509v3 Authority Key Identifier").replace(/^keyid:/, ""), value("X509v3 Subject Key Identifier"));
    assert.match(text, new RegExp(`Subject: CN ?= ?${DRY_RUN_IDENTITY}, O ?= ?The Fleetify Authors`));
    // Only the p12 holds the key, encrypted.
    assert.deepEqual(readdirSync(dir).sort(), ["identity.cnf", "identity.p12", "identity.pem"]);
  });
});

describe("macos-keychain.sh import", () => {
  const IDENTITY = "Developer ID Application: Test (AB.12)";
  const PASSWORD = "the-p12-password-4b7e";

  test("the identity goes into the job's keychain non-extractable, and APPLE_SIGNING_IDENTITY is set after the probe", { skip: SKIP_STUBS }, () => {
    const p12 = makeP12(IDENTITY, PASSWORD);
    const result = run(["import"], { IDENTITY, P12: p12, P12_PASSWORD: PASSWORD });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    const keychain = join(result.dir, "fleetify.keychain-db");
    assert.equal(result.githubEnv, `CODESIGN_KEYCHAIN=${keychain}\nAPPLE_SIGNING_IDENTITY=${IDENTITY}\n`);
    const [importCall, ...more] = callsOf(result.calls, "security import ");
    assert.equal(more.length, 0, "security import runs once");
    assert.match(importCall, new RegExp(`^security import ${join(result.dir, "import.p12").replaceAll(".", "\\.")} -k \\S+ -f pkcs12 -x -P [0-9a-f]{48} -T /usr/bin/codesign$`));
    // The order: keychain, import, partition list, search list, trust, check, probe.
    const order = [
      "security create-keychain ",
      "security import ",
      "security set-key-partition-list ",
      "security list-keychains -d user -s ",
      "sudo security add-trusted-cert -d -r trustRoot -p codeSign -k /Library/Keychains/System.keychain ",
      "security find-identity -v -p codesigning ",
      "cc ",
      "codesign --force ",
      "codesign --verify --strict ",
    ].map((prefix) => result.calls.findIndex((call) => call.startsWith(prefix)));
    assert.ok(order.every((at, i) => at !== -1 && (i === 0 || at > order[i - 1])), `calls out of order:\n${result.calls.join("\n")}`);
    assert.equal(callsOf(result.calls, "security list-keychains -d user -s ")[0], `security list-keychains -d user -s ${keychain} /Users/runner/Library/Keychains/login.keychain-db`);
    // The probe is signed as Tauri signs: by name, with no --keychain.
    assert.deepEqual(callsOf(result.calls, "codesign "), [
      `codesign --force -s ${IDENTITY} --options runtime --entitlements src-tauri/Entitlements.plist ${join(result.dir, "probe")}`,
      `codesign --verify --strict ${join(result.dir, "probe")}`,
    ]);
  });

  test("the p12's password reaches openssl only through the environment, and no file holds the key unencrypted", { skip: SKIP_STUBS }, () => {
    const p12 = makeP12(IDENTITY, PASSWORD);
    const result = run(["import"], { IDENTITY, P12: p12, P12_PASSWORD: PASSWORD });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    for (const [where, text] of [["a command line", result.calls.join("\n")], ["the log", `${result.stdout}${result.stderr}`], ["GITHUB_ENV", result.githubEnv]]) {
      assert.ok(!text.includes(PASSWORD), `the p12's password is in ${where}`);
    }
    const openssl = callsOf(result.calls, "openssl ");
    assert.ok(openssl.some((call) => call === `openssl pkcs12 -in ${p12} -passin env:P12_PASSWORD -nocerts -nodes`), openssl.join("\n"));
    assert.ok(openssl.some((call) => /^openssl pkcs12 -export .* -inkey \/dev\/stdin .* -passout env:IMPORT_PASSWORD /.test(call)), openssl.join("\n"));
    assert.deepEqual(openssl.filter((call) => /\spass:|\s-pass(in|out) (?!env:)/.test(call)), [], "openssl gets a password on its command line");
    for (const name of readdirSync(result.dir)) {
      const text = readFileSync(join(result.dir, name), "latin1");
      assert.doesNotMatch(text, /-----BEGIN (RSA )?PRIVATE KEY-----/, `${name} holds the key unencrypted`);
    }
    assert.ok(!existsSync(join(result.dir, "import.p12")), "the re-encrypted copy is left behind");
  });

  for (const status of ["(Unknown critical cert extension)", "(CSSMERR_TP_NOT_TRUSTED)"]) {
    test(`an identity find-identity marks ${status} fails before the probe, printing its line`, { skip: SKIP_STUBS }, () => {
      const line = `  1) ${SHA1} "${IDENTITY}" ${status}`;
      const result = run(["import"], { IDENTITY, P12: makeP12(IDENTITY, PASSWORD), P12_PASSWORD: PASSWORD, STUB_FIND_IDENTITY: `${line}\n     1 valid identities found` });
      assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
      assert.ok(result.stdout.includes(`::error::codesign won't sign as "${IDENTITY}": security find-identity marks it: ${line.trim()}`), result.stdout);
      assert.deepEqual([callsOf(result.calls, "cc "), callsOf(result.calls, "codesign ")], [[], []], "the probe ran");
      assert.doesNotMatch(result.githubEnv, /APPLE_SIGNING_IDENTITY/);
    });
  }

  test("only the identity's own name counts: another one that starts with it doesn't", { skip: SKIP_STUBS }, () => {
    const listing = `  1) ${SHA1} "${IDENTITY} 2"\n     1 valid identities found`;
    const result = run(["import"], { IDENTITY, P12: makeP12(IDENTITY, PASSWORD), P12_PASSWORD: PASSWORD, STUB_FIND_IDENTITY: listing });
    assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
    assert.ok(result.stdout.includes(`::error::codesign can't sign as "${IDENTITY}": security find-identity -v doesn't list it as valid`), result.stdout);
  });

  test("a failed probe exits 1, after showing what codesign sees and two retries", { skip: SKIP_STUBS }, () => {
    const result = run(["import"], { IDENTITY, P12: makeP12(IDENTITY, PASSWORD), P12_PASSWORD: PASSWORD, STUB_CODESIGN: "fail" });
    assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
    assert.ok(result.stdout.includes(`::error::codesign can't sign as "${IDENTITY}" the way Tauri does`), result.stdout);
    const keychain = join(result.dir, "fleetify.keychain-db");
    assert.match(result.stdout, /Code-signing identities in the whole keychain search list:/);
    assert.ok(result.stdout.includes(`Retry with --keychain ${keychain}: failed (exit 1)`), result.stdout);
    assert.match(result.stdout, /Retry by the certificate's SHA-1, [0-9A-F]{40}: failed \(exit 1\)/);
    const signs = callsOf(result.calls, "codesign --force ");
    assert.equal(signs.length, 3, signs.join("\n"));
    assert.ok(signs[1].includes(`--keychain ${keychain}`), signs[1]);
    assert.match(signs[2], /^codesign --force -s [0-9A-F]{40} /);
    assert.ok(result.calls.includes("security find-identity -v -p codesigning"), "the whole search list isn't shown");
    assert.equal(result.githubEnv, `CODESIGN_KEYCHAIN=${keychain}\n`, "APPLE_SIGNING_IDENTITY is set although the probe failed");
  });

  test("a codesign stuck on a dialog is stopped by the watchdog, and the diagnostics still run", { skip: SKIP_STUBS }, () => {
    const started = Date.now();
    const result = run(["import"], { IDENTITY, P12: makeP12(IDENTITY, PASSWORD), P12_PASSWORD: PASSWORD, STUB_CODESIGN: "hang", CODESIGN_TIMEOUT: "1" }, { timeout: 45_000 });
    assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
    assert.ok(Date.now() - started < 40_000, "the watchdog didn't stop codesign");
    assert.match(result.stdout, /codesign didn't finish within 1s, so the watchdog stopped it/);
    assert.match(result.stdout, /Retry with --keychain .*: failed \(exit 142\)/);
    assert.match(result.stdout, /::error::codesign can't sign as/);
  });

  test("every codesign call goes through the watchdog", () => {
    const calls = TEXT.split("\n").filter((line) => /(^|\s)codesign --/.test(line) && !line.trim().startsWith("#"));
    assert.ok(calls.length >= 2, "the script signs and verifies the probe");
    assert.deepEqual(calls.filter((line) => !/\bwatchdog codesign --/.test(line)), []);
    assert.match(TEXT, /^\s*perl -e 'alarm shift; exec @ARGV' "\$CODESIGN_TIMEOUT" "\$@"$/m);
    assert.match(TEXT, /^CODESIGN_TIMEOUT=\$\{CODESIGN_TIMEOUT:-60\}$/m);
  });

  test("usage errors exit 2: no command, another command, a missing input or a bad timeout", { skip: SKIP_SHELL }, () => {
    for (const [args, env] of [
      [[], {}],
      [["sign"], { IDENTITY }],
      [["import"], { IDENTITY, P12_PASSWORD: PASSWORD }],
      [["import"], { IDENTITY, P12: "x.p12", P12_PASSWORD: PASSWORD, CODESIGN_TIMEOUT: "1m" }],
      [["dry-run"], { IDENTITY, GITHUB_ENV: "" }],
    ]) {
      const result = run(args, env);
      assert.equal(result.status, 2, `${args.join(" ")} ${JSON.stringify(env)}: ${result.stdout}${result.stderr}`);
      assert.match(result.stderr, /usage:/);
    }
  });
});

describe("macos-keychain.sh dry-run", () => {
  test("it makes the run's identity and imports it as a release identity is imported", { skip: SKIP_STUBS }, () => {
    const result = run(["dry-run"], { IDENTITY: DRY_RUN_IDENTITY });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /^OpenSSL: /m);
    const openssl = callsOf(result.calls, "openssl ");
    assert.ok(openssl.some((call) => call.startsWith("openssl req -x509 ") && call.includes(` -config ${join(result.dir, "identity.cnf")} `)), openssl.join("\n"));
    assert.ok(openssl.some((call) => call === `openssl pkcs12 -in ${join(result.dir, "identity.p12")} -passin env:P12_PASSWORD -nocerts -nodes`), "the dry run doesn't re-encrypt its p12 as a release does");
    assert.equal(callsOf(result.calls, "security import ").length, 1);
    assert.match(callsOf(result.calls, "security import ")[0], / -x /);
    assert.match(result.githubEnv, new RegExp(`^APPLE_SIGNING_IDENTITY=${DRY_RUN_IDENTITY}$`, "m"));
  });
});

describe("shellcheck", () => {
  const shellcheck = SKIP_SHELL ? null : which("shellcheck");
  test("finds nothing in macos-keychain.sh", { skip: shellcheck === null && "shellcheck isn't installed" }, () => {
    const result = spawnSync(shellcheck, [SCRIPT], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stdout);
  });
});
