#!/usr/bin/env node
/**
 * scan-secrets.mjs — fail the release build when a private API key or
 * token has made it into a build artefact (the frontend bundle in dist/,
 * the app and sidecar binaries, the bundle outputs).
 *
 *   node scripts/release/scan-secrets.mjs <path>...
 *
 * Each path is scanned recursively. Every rule that matches in a file is
 * printed once to stdout as `<file>: <rule>`. The matched value is never
 * printed, so the CI log cannot become the leak.
 *
 * Exit codes:
 *   0  clean
 *   1  at least one finding
 *   2  the scan could not be completed: no path given, a path that does not
 *      exist or holds no files, or a read error. A release job pointed at
 *      the wrong directory must fail rather than pass as "clean".
 *
 * Files are read as latin1 (one byte per character), so binaries scan
 * safely: decoding never fails and no byte is replaced or shifted.
 * Symlinks found while walking a directory are not followed, because an
 * archive stores the link and not its target. Compressed payloads (.deb,
 * the AppImage's squashfs, .dmg, the NSIS installer) are opaque to a text
 * scan, so point the scanner at the uncompressed files too.
 *
 * Public-by-design values match no rule: the PostHog `phc_` project key
 * and the OIDC client id `fleetify-desktop`.
 */
import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Rules in report order. The regexes have no `g` flag, which keeps
 * `test()` stateless between calls.
 */
export const RULES = Object.freeze([
  { name: "anthropic", pattern: /sk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: "openai-project", pattern: /sk-proj-[A-Za-z0-9_-]{20,}/ },
  { name: "openai-legacy", pattern: /\bsk-[A-Za-z0-9]{40,}\b/ },
  { name: "github-token", pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: "aws-access-key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "slack", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { name: "private-key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/ },
  { name: "notdiamond-assignment", pattern: /NOTDIAMOND_API_KEY\s*[=:]\s*["']?[A-Za-z0-9_-]{16,}/ },
]);

/**
 * The rules that match `text`, each reported once, in RULES order. A
 * finding names the file and the rule, never the matched value.
 *
 * @param {string} text
 * @param {string} file
 * @returns {Array<{ file: string, rule: string }>}
 */
export function scanText(text, file) {
  return RULES.filter(({ pattern }) => pattern.test(text)).map(({ name }) => ({
    file,
    rule: name,
  }));
}

/**
 * Regular files at or under `path`, depth first in sorted order. The root
 * may be a symlink (it was named explicitly). Inside a directory, symlinks
 * and special files are skipped. Problems are appended to `errors`.
 */
function listFiles(path, errors, isRoot = false) {
  let stats;
  try {
    stats = isRoot ? statSync(path) : lstatSync(path);
  } catch (err) {
    errors.push(`${path}: ${err.message}`);
    return [];
  }
  if (stats.isFile()) return [path];
  if (!stats.isDirectory()) return [];
  let names;
  try {
    names = readdirSync(path).sort();
  } catch (err) {
    errors.push(`${path}: ${err.message}`);
    return [];
  }
  return names.flatMap((name) => listFiles(join(path, name), errors));
}

/**
 * Scan every regular file at or under each of `paths`. A path that yields
 * no file to scan counts as an error.
 *
 * @param {string[]} paths
 * @returns {{ findings: Array<{ file: string, rule: string }>, errors: string[], files: number }}
 */
export function scanPaths(paths) {
  const findings = [];
  const errors = [];
  let files = 0;
  for (const path of paths) {
    const errorsBefore = errors.length;
    const list = listFiles(path, errors, true);
    if (list.length === 0 && errors.length === errorsBefore) {
      errors.push(`${path}: no files to scan`);
    }
    for (const file of list) {
      let text;
      try {
        text = readFileSync(file, "latin1");
      } catch (err) {
        errors.push(`${file}: ${err.message}`);
        continue;
      }
      files += 1;
      findings.push(...scanText(text, file));
    }
  }
  return { findings, errors, files };
}

function main(args) {
  if (args.length === 0) {
    process.stderr.write("usage: node scripts/release/scan-secrets.mjs <path>...\n");
    return 2;
  }
  const { findings, errors, files } = scanPaths(args);
  for (const { file, rule } of findings) process.stdout.write(`${file}: ${rule}\n`);
  for (const message of errors) process.stderr.write(`scan-secrets: ${message}\n`);
  if (errors.length > 0) {
    process.stderr.write(`scan-secrets: ${errors.length} error(s), so the scan is incomplete\n`);
    return 2;
  }
  if (findings.length > 0) {
    process.stderr.write(
      `scan-secrets: ${findings.length} finding(s) in ${files} scanned file(s); values are not printed\n`,
    );
    return 1;
  }
  process.stderr.write(`scan-secrets: ${files} file(s) scanned, no secrets found\n`);
  return 0;
}

function invokedDirectly() {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

// exitCode instead of process.exit(): writes to a piped stdout can be
// asynchronous on some platforms, and exiting early could cut the
// findings short.
if (invokedDirectly()) process.exitCode = main(process.argv.slice(2));
