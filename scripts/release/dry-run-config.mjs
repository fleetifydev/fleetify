#!/usr/bin/env node
/**
 * dry-run-config.mjs — write the updater config a release dry run builds
 * with, an overlay for `tauri build --config <file>`.
 *
 *   node scripts/release/dry-run-config.mjs --pubkey-file <updater.key.pub> --out <file>
 *
 * A dry run signs its updates with a key made for the run, then rehearses an
 * update against a server on 127.0.0.1 that speaks plain http. The overlay
 * gives the updater that key's public half, that server as its only
 * endpoint, and dangerousInsecureTransportProtocol, which the updater needs
 * before it will use an http endpoint. Builds made with it never leave the
 * run: a released build has the shipped config in src-tauri/tauri.conf.json,
 * which allows no insecure transport.
 *
 * The CLI merges the overlay into the config as a JSON merge patch: the
 * endpoints list replaces the shipped one as a whole, and the updater's other
 * settings stay as shipped.
 *
 * The key file is `tauri signer generate`'s .pub output, read with
 * surrounding whitespace trimmed: the updater decodes the configured key as
 * given. An existing out file is never overwritten.
 *
 * Exit codes: 0 written; 1 the key file can't be read or holds no public key,
 * or the out file exists or can't be written; 2 usage.
 */
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { parsePublicKey } from "./minisign.mjs";

const USAGE = "usage: node scripts/release/dry-run-config.mjs --pubkey-file <updater.key.pub> --out <file>";

/**
 * The dry-run overlay for the updater config.
 *
 * @param {{ pubkey: string, port?: number }} options
 *   pubkey: the run's updater public key, in Tauri's form; port: where the
 *   rehearsal's update server listens on 127.0.0.1.
 * @throws {Error} "malformed public key: …" or "invalid port …"
 */
export function dryRunConfig({ pubkey, port = 18080 }) {
  parsePublicKey(pubkey);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid port ${JSON.stringify(port)}: expected a whole number from 1 to 65535`);
  }
  return {
    plugins: {
      updater: {
        pubkey,
        endpoints: [`http://127.0.0.1:${port}/update/{{target}}/{{arch}}/{{current_version}}?bundle_type={{bundle_type}}`],
        dangerousInsecureTransportProtocol: true,
      },
    },
  };
}

/** `--pubkey-file <f> --out <f>`, and nothing else. Throws a usage error. */
function parseArgs(argv) {
  const values = new Map();
  const takesValue = ["--pubkey-file", "--out"];
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (!takesValue.includes(flag)) throw new Error(`unexpected argument: ${flag}`);
    const value = argv[i + 1];
    if (value === undefined || value === "" || value.startsWith("-")) throw new Error(`${flag} needs a value`);
    if (values.has(flag)) throw new Error(`${flag} is given twice`);
    values.set(flag, value);
    i += 1;
  }
  for (const flag of takesValue) {
    if (!values.has(flag)) throw new Error(`${flag} is required`);
  }
  return { pubkeyFile: values.get("--pubkey-file"), out: values.get("--out") };
}

function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`dry-run-config: ${err.message}\n${USAGE}\n`);
    return 2;
  }
  let pubkey;
  try {
    pubkey = readFileSync(args.pubkeyFile, "utf8").trim();
  } catch (err) {
    process.stderr.write(`dry-run-config: can't read ${args.pubkeyFile}: ${err.code ?? err.message}\n`);
    return 1;
  }
  let config;
  try {
    config = dryRunConfig({ pubkey });
  } catch (err) {
    process.stderr.write(`dry-run-config: ${args.pubkeyFile}: ${err.message}\n`);
    return 1;
  }
  try {
    writeFileSync(args.out, `${JSON.stringify(config, null, 2)}\n`, { flag: "wx" });
  } catch (err) {
    const why = err.code === "EEXIST" ? "it already exists, and is left as it was" : (err.code ?? err.message);
    process.stderr.write(`dry-run-config: can't write ${args.out}: ${why}\n`);
    return 1;
  }
  const { keyId } = parsePublicKey(pubkey);
  const [endpoint] = config.plugins.updater.endpoints;
  process.stdout.write(`dry-run-config: wrote ${args.out}: updater key id ${keyId}, endpoint ${endpoint}\n`);
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
