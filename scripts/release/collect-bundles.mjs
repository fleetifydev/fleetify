#!/usr/bin/env node
/**
 * collect-bundles.mjs — copy the files a target's build publishes out of
 * Tauri's bundle folder, under their release names, ready to upload as that
 * target's artifact.
 *
 *   node scripts/release/collect-bundles.mjs --target <triple> --version <v> --out <dir> [--target-dir target]
 *
 * The files and their names are release-assets.mjs's bundleFiles(): each
 * bundle under <target-dir>/<triple>/release/bundle/, and each updater
 * artifact's .sig. Most keep their own names; both macOS builds write
 * macos/Fleetify.app.tar.gz, which is published with the version and arch
 * added. Nothing else in the bundle folder is copied.
 *
 * Every file is checked before any is copied: when one is missing, or isn't a
 * regular file, nothing is copied and the CLI lists each missing file. The
 * out folder is created when absent and must otherwise be empty, so the
 * artifact holds only this build's files. An existing file is never
 * overwritten.
 *
 * Exit codes: 0 copied; 1 a file is missing (each listed on stderr), or
 * another problem (an unknown target, a malformed version, an out folder
 * that isn't empty); 2 usage.
 */
import { constants, copyFileSync, mkdirSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { bundleFiles } from "./release-assets.mjs";

const USAGE =
  "usage: node scripts/release/collect-bundles.mjs --target <triple> --version <v> --out <dir> [--target-dir target]";

/** fs.stat, following symlinks, with null for a path that isn't there. */
function statOrNull(path) {
  try {
    return statSync(path);
  } catch (err) {
    if (err.code === "ENOENT" || err.code === "ENOTDIR") return null;
    throw err;
  }
}

/** The folder Tauri writes a target's bundles to. */
const bundleFolder = (targetDir, triple) => join(targetDir, triple, "release", "bundle");

/**
 * Copy a target's release files from `<targetDir>/<triple>/release/bundle/`
 * into `outDir`, under their release names.
 *
 * @param {{ targetDir: string, triple: string, version: string, outDir: string }} options
 * @returns {{ copied: string[], missing: string[] }} copied: the release names
 *   written, in bundleFiles order; missing: the path of each file that isn't
 *   there, in which case nothing is copied.
 * @throws on an unknown triple, a malformed version, an out path that isn't
 *   an empty folder, or a failed copy.
 */
export function collect({ targetDir, triple, version, outDir }) {
  const files = bundleFiles(triple, version);
  const dir = bundleFolder(targetDir, triple);
  const missing = files.map(({ from }) => join(dir, from)).filter((path) => statOrNull(path)?.isFile() !== true);
  if (missing.length > 0) return { copied: [], missing };

  const out = statOrNull(outDir);
  if (out !== null && !out.isDirectory()) throw new Error(`out folder ${outDir} is not a folder`);
  if (out !== null && readdirSync(outDir).length > 0) throw new Error(`out folder ${outDir} is not empty`);
  mkdirSync(outDir, { recursive: true });
  for (const { from, to } of files) copyFileSync(join(dir, from), join(outDir, to), constants.COPYFILE_EXCL);
  return { copied: files.map(({ to }) => to), missing: [] };
}

/** The command line, as collect()'s options. Throws a usage error. */
function parseArgs(argv) {
  const values = new Map();
  const takesValue = ["--target", "--version", "--out", "--target-dir"];
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (!takesValue.includes(flag)) throw new Error(`unexpected argument: ${flag}`);
    const value = argv[i + 1];
    if (value === undefined || value === "" || value.startsWith("-")) throw new Error(`${flag} needs a value`);
    if (values.has(flag)) throw new Error(`${flag} is given twice`);
    values.set(flag, value);
    i += 1;
  }
  for (const flag of ["--target", "--version", "--out"]) {
    if (!values.has(flag)) throw new Error(`${flag} is required`);
  }
  return {
    triple: values.get("--target"),
    version: values.get("--version"),
    outDir: values.get("--out"),
    targetDir: values.get("--target-dir") ?? "target",
  };
}

function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`collect-bundles: ${err.message}\n${USAGE}\n`);
    return 2;
  }
  let result;
  try {
    result = collect(options);
  } catch (err) {
    process.stderr.write(`collect-bundles: ${err.message}\n`);
    return 1;
  }
  const from = bundleFolder(options.targetDir, options.triple);
  if (result.missing.length > 0) {
    for (const path of result.missing) process.stderr.write(`collect-bundles: missing ${path}\n`);
    process.stderr.write(
      `collect-bundles: ${result.missing.length} file(s) missing; nothing was copied to ${options.outDir}\n`,
    );
    return 1;
  }
  process.stdout.write(`collect-bundles: copied ${result.copied.length} files from ${from} to ${options.outDir}:\n`);
  for (const name of result.copied) process.stdout.write(`  ${name}\n`);
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
