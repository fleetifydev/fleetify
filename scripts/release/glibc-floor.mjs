#!/usr/bin/env node
/**
 * glibc-floor.mjs — check that the Linux build's ELF files are x86-64 and need
 * no glibc newer than the one of the oldest Linux Fleetify supports, so that
 * each of them loads there.
 *
 *   node scripts/release/glibc-floor.mjs <file or folder>...
 *
 * A file given must be an ELF file; a folder is searched for ELF files, found
 * by their magic (\x7fELF), and its symlinks are skipped, as the file one
 * names is checked itself. A file reached by two paths is checked once.
 *
 * readelf --file-header --version-info --wide (binutils) reads each file, in
 * the C locale, as readelf translates its labels. The machine in the ELF
 * header must be x86-64. The version needs section (.gnu.version_r) lists the
 * symbol versions the file needs from each library; glibc's numbered ones,
 * GLIBC_x.y[.z], must be no newer than GLIBC_FLOOR. GLIBC_PRIVATE is the
 * interface between glibc's own libraries, which changes from one glibc to
 * the next, so a file that needs it is a part of glibc, made to load beside
 * the rest of the glibc it came from, and it fails too: a newer glibc's
 * libc.so.6 in the AppImage, for one, would need symbols that Ubuntu 22.04's
 * loader lacks, though every number it needs passes. glibc's other names mark
 * features of the dynamic loader, such as GLIBC_ABI_DT_RELR. The first of
 * them came with glibc 2.36, so a file that needs any of them fails too; a
 * floor of 2.36 or later would have to tell them apart. The version
 * definitions section, which names the versions a library provides, isn't
 * read.
 *
 * Each file that fails gets one ::error:: line on stdout, with every reason.
 * One summary line follows: how many files were checked, and the newest glibc
 * version one needs, with the file that needs it.
 *
 * Exit codes: 0 every file passes; 1 a file fails, or the check couldn't run
 * (a path missing, a file given that isn't ELF, no ELF file at all, readelf
 * failing), each said on stdout or stderr; 2 usage.
 */
import { spawnSync } from "node:child_process";
import { closeSync, openSync, readdirSync, readSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const USAGE = "usage: node scripts/release/glibc-floor.mjs <file or folder>...";

/**
 * The newest glibc a file of the Linux build may need: 2.35, Ubuntu 22.04's.
 * docs/INSTALL.md promises "64-bit x86 Linux with WebKitGTK 4.1, which Ubuntu
 * 22.04, Debian 12 and newer releases provide", and Ubuntu 22.04's glibc is
 * the oldest of those (Debian 12 has 2.36). A file that needs a newer one
 * doesn't start there.
 */
export const GLIBC_FLOOR = "2.35";

/** The machine readelf names in the ELF header of an x86-64 file, the one machine INSTALL.md promises. */
const X86_64 = "Advanced Micro Devices X86-64";

const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);

const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** "a", "a and b", "a, b and c". */
const listed = (names) => (names.length <= 2 ? names.join(" and ") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);

/** The machine readelf's --file-header output names, or undefined. */
export function machineOf(output) {
  return String(output).match(/^\s*Machine:\s+(.*?)\s*$/m)?.[1];
}

/**
 * The glibc versions readelf's --version-info output says the file needs, each
 * once, from its version needs section alone: versions, the GLIBC_x.y[.z]
 * ones, as "x.y[.z]"; features, glibc's other names but GLIBC_PRIVATE, such as
 * GLIBC_ABI_DT_RELR; and glibcPrivate, whether it needs GLIBC_PRIVATE. Other
 * libraries' versions, such as GLIBCXX_3.4, aren't glibc's.
 *
 * @param {string} output
 * @returns {{ versions: string[], features: string[], glibcPrivate: boolean }}
 */
export function glibcNeeds(output) {
  const versions = new Set();
  const features = new Set();
  let glibcPrivate = false;
  let inside = false;
  for (const line of String(output).split(/\r?\n/)) {
    if (line.startsWith("Version needs section ")) {
      inside = true;
      continue;
    }
    // The section's lines are indented; a blank line or the next heading ends it.
    if (!/^\s+\S/.test(line)) {
      inside = false;
      continue;
    }
    const name = inside ? line.match(/^\s*[0-9a-fx]+:\s+Name:\s+(GLIBC_\S+)/)?.[1] : undefined;
    if (name === undefined) continue;
    const version = name.match(/^GLIBC_(\d+\.\d+(?:\.\d+)?)$/)?.[1];
    if (version !== undefined) versions.add(version);
    else if (name === "GLIBC_PRIVATE") glibcPrivate = true;
    else features.add(name);
  }
  return { versions: [...versions], features: [...features], glibcPrivate };
}

/** Compare two versions, x.y[.z], number by number: 2.34 is newer than 2.4. */
export function compareVersions(a, b) {
  const [x, y] = [a, b].map((version) => version.split(".").map(Number));
  for (let n = 0; n < Math.max(x.length, y.length); n += 1) {
    const difference = (x[n] ?? 0) - (y[n] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

/** The newest of `versions`, or undefined when there is none. */
export function newestVersion(versions) {
  return versions.reduce((newest, version) => (newest === undefined || compareVersions(version, newest) > 0 ? version : newest), undefined);
}

/** Whether a file starts with the ELF magic. */
function isElf(path) {
  const fd = openSync(path, "r");
  try {
    const head = Buffer.alloc(4);
    return readSync(fd, head, 0, 4, 0) === 4 && head.equals(ELF_MAGIC);
  } finally {
    closeSync(fd);
  }
}

/**
 * The ELF files among `paths`: each file given, and the ELF files in each
 * folder given, sorted by name within it. A symlink given is followed; one in
 * a folder is skipped, as the file it names is listed itself, if it ships. A
 * file reached by two paths is listed once, by the first. Throws when a path
 * doesn't exist, or when a file given isn't an ELF file.
 *
 * @param {string[]} paths
 * @returns {string[]}
 */
export function elfFiles(paths) {
  const found = new Map();
  const add = (path) => {
    const real = realpathSync(path);
    if (!found.has(real)) found.set(real, path);
  };
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => compare(a.name, b.name))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && isElf(path)) add(path);
    }
  };
  for (const path of paths) {
    let stats;
    try {
      stats = statSync(path);
    } catch (err) {
      if (err.code === "ENOENT") throw new Error(`${path}: no such file or folder`);
      throw err;
    }
    if (stats.isDirectory()) walk(path);
    else if (stats.isFile() && isElf(path)) add(path);
    else throw new Error(`${path} isn't an ELF file`);
  }
  return [...found.values()];
}

/** readelf's output for one file; throws when readelf can't run or fails. */
function runReadelf(file) {
  // A large library's symbol version table runs to hundreds of kilobytes.
  const result = spawnSync("readelf", ["--file-header", "--version-info", "--wide", file], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error) throw new Error(`can't run readelf: ${result.error.code ?? result.error.message}`);
  if (result.status !== 0) {
    const why = result.stderr.trim().split("\n")[0] ?? "";
    throw new Error(`readelf failed on ${file} (exit ${result.status ?? result.signal}): ${why}`);
  }
  return result.stdout;
}

/**
 * Check each ELF file: its machine must be x86-64, the glibc it needs no
 * newer than GLIBC_FLOOR, and it mustn't need GLIBC_PRIVATE. `readelf` gives
 * readelf's output for a file.
 *
 * - checked: how many files were checked;
 * - newest: the newest glibc version a file needs, { version, file }, or
 *   undefined when none needs one;
 * - failures: { file, reasons } for each file that fails.
 *
 * @param {string[]} files
 * @param {{ readelf?: (file: string) => string }} [options]
 */
export function checkFiles(files, { readelf = runReadelf } = {}) {
  const floor = GLIBC_FLOOR;
  let newest;
  const failures = [];
  for (const file of files) {
    const output = readelf(file);
    const reasons = [];
    const machine = machineOf(output);
    if (machine !== X86_64) reasons.push(`is built for ${machine ?? "a machine readelf doesn't name"}, not x86-64`);
    const { versions, features, glibcPrivate } = glibcNeeds(output);
    const version = newestVersion(versions);
    if (version !== undefined && (newest === undefined || compareVersions(version, newest.version) > 0)) newest = { version, file };
    if (version !== undefined && compareVersions(version, floor) > 0) reasons.push(`needs GLIBC_${version}, newer than the floor, glibc ${floor}`);
    if (features.length > 0) reasons.push(`needs ${listed(features)}, which glibc ${floor} lacks`);
    if (glibcPrivate) reasons.push("needs GLIBC_PRIVATE, the interface between glibc's own libraries, so it loads only beside the glibc it came from");
    if (reasons.length > 0) failures.push({ file, reasons });
  }
  return { checked: files.length, newest, failures };
}

function main(argv) {
  if (argv.length === 0 || argv.some((arg) => arg.startsWith("-"))) {
    process.stderr.write(`glibc-floor: give the files and folders to check, and nothing else\n${USAGE}\n`);
    return 2;
  }
  try {
    const files = elfFiles(argv);
    if (files.length === 0) {
      process.stderr.write(`glibc-floor: no ELF file in ${argv.join(", ")}\n`);
      return 1;
    }
    const { checked, newest, failures } = checkFiles(files);
    for (const { file, reasons } of failures) process.stdout.write(`::error::${file}: ${reasons.join("; ")}\n`);
    const what = `${checked} ELF ${checked === 1 ? "file" : "files"} checked`;
    const needs = newest === undefined ? "none needs a glibc version" : `the newest glibc they need is ${newest.version}, by ${newest.file}`;
    process.stdout.write(`glibc-floor: ${what}; ${needs}; the floor is ${GLIBC_FLOOR}\n`);
    return failures.length > 0 ? 1 : 0;
  } catch (err) {
    process.stderr.write(`glibc-floor: ${err.message}\n`);
    return 1;
  }
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
