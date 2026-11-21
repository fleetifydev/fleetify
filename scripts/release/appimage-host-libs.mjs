#!/usr/bin/env node
/**
 * appimage-host-libs.mjs — check that this system has every library an
 * AppImage leaves to it, before the smoke starts the AppImage.
 *
 *   node scripts/release/appimage-host-libs.mjs --appimage <file>
 *   node scripts/release/appimage-host-libs.mjs --root <squashfs-root>
 *
 * An AppImage carries most of the libraries it needs, but linuxdeploy leaves
 * the graphics stack (EGL, GL, GBM, DRM, X11) and a few base libraries
 * (glibc, libstdc++, fontconfig, …) to the system, which a desktop always
 * has. A system without one, or with one older than the AppImage needs,
 * stops the app at start with "error while loading shared libraries" and
 * exit 127. This runs ldd on every dynamically linked ELF file in the
 * AppImage, with LD_LIBRARY_PATH set to the AppImage's usr/lib, where its
 * own libraries are, and lists each library ldd can't find, each version a
 * library here lacks ("version `GLIBC_2.40' not found"), and each file ldd
 * fails on otherwise, with the files concerned.
 *
 * --appimage extracts the AppImage first (<file> --appimage-extract, in a
 * temporary folder it removes afterwards); --root checks one already
 * extracted.
 *
 * Exit codes: 0 every library is found, in a version new enough; 1 a
 * problem, each listed on stderr, or the check couldn't run; 2 usage.
 */
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, lstatSync, mkdtempSync, openSync, readdirSync, readSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const USAGE = `usage: node scripts/release/appimage-host-libs.mjs --appimage <file>
       node scripts/release/appimage-host-libs.mjs --root <squashfs-root>`;

const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);
/** The program header type of a dynamically linked file's dynamic section. */
const PT_DYNAMIC = 2;

const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

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
 * The ELF files under `root`, as paths from it, sorted. Symlinks are
 * skipped: the file a library's symlink names is listed itself.
 *
 * @param {string} root
 * @returns {string[]}
 */
export function elfFiles(root) {
  const found = [];
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => compare(a.name, b.name))) {
      const path = join(dir, entry.name);
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(path, rel);
      else if (entry.isFile() && isElf(path)) found.push(rel);
    }
  };
  walk(root, "");
  return found.sort(compare);
}

/**
 * Whether an ELF file is linked dynamically: whether its program headers
 * hold a dynamic section. 32- and 64-bit files of either byte order are read;
 * anything else isn't.
 *
 * @param {string} path
 */
export function isDynamicElf(path) {
  const fd = openSync(path, "r");
  try {
    const head = Buffer.alloc(64);
    const read = readSync(fd, head, 0, 64, 0);
    if (read < 52 || !head.subarray(0, 4).equals(ELF_MAGIC)) return false;
    const wide = head[4] === 2;
    const little = head[5] !== 2;
    if (wide && read < 64) return false;
    const u16 = (buffer, at) => (little ? buffer.readUInt16LE(at) : buffer.readUInt16BE(at));
    const u32 = (buffer, at) => (little ? buffer.readUInt32LE(at) : buffer.readUInt32BE(at));
    const offset = wide ? Number(little ? head.readBigUInt64LE(0x20) : head.readBigUInt64BE(0x20)) : u32(head, 0x1c);
    const size = u16(head, wide ? 0x36 : 0x2a);
    const count = u16(head, wide ? 0x38 : 0x2c);
    if (offset === 0 || size < 4 || count === 0) return false;
    const table = Buffer.alloc(size * count);
    if (readSync(fd, table, 0, table.length, offset) < table.length) return false;
    for (let n = 0; n < count; n += 1) if (u32(table, n * size) === PT_DYNAMIC) return true;
    return false;
  } finally {
    closeSync(fd);
  }
}

/** The libraries ldd's output says it can't find. */
export function notFound(output) {
  return [...String(output).matchAll(/^\s*(\S+) => not found\s*$/gm)].map(([, name]) => name);
}

/**
 * The library versions ldd's output says are missing, as the loader words it
 * ("<file>: <library>: version `GLIBC_2.40' not found (required by <file>)"):
 * { library, version, requiredBy } each, the library by its file name. A weak
 * version, which the loader does without, isn't one.
 */
export function versionsNotFound(output) {
  return [...String(output).matchAll(/^\s*(.*?): version [`']([^`']+)' not found \(required by (.+?)\)\s*$/gm)].map(([, before, version, requiredBy]) => ({
    library: basename(before.split(": ").at(-1)),
    version,
    requiredBy,
  }));
}

/** Run ldd on `file`, with `env` added to the environment: { status, output }, output being both streams. */
function runLdd(file, env) {
  const result = spawnSync("ldd", [file], { encoding: "utf8", env: { ...process.env, LC_ALL: "C", ...env } });
  if (result.error) throw new Error(`can't run ldd: ${result.error.code ?? result.error.message}`);
  return { status: result.status ?? 1, output: `${result.stdout}${result.stderr}` };
}

/** Add `file` to the list `map` keeps under `key`. */
const note = (map, key, file) => map.set(key, [...new Set([...(map.get(key) ?? []), file])]);
const sorted = (map) => new Map([...map].sort(([a], [b]) => compare(a, b)));

/**
 * What the dynamically linked ELF files under `root` need from this system
 * and don't get. ldd looks in `root`'s usr/lib first, where the AppImage
 * keeps its own libraries. Paths are from `root`.
 *
 * - missing: each library ldd can't find, with the files that need it;
 * - older: each "<library> <version>" a library here lacks, with the files
 *   that need it;
 * - failures: each file ldd fails on with neither, { file, status, output }.
 *
 * @param {{ root: string, ldd?: (file: string, env: object) => { status: number, output: string }, files?: string[] }} options
 */
export function hostLibraryProblems({ root, ldd = runLdd, files = elfFiles(root).filter((file) => isDynamicElf(join(root, file))) }) {
  const env = { LD_LIBRARY_PATH: join(root, "usr", "lib") };
  const fromRoot = (path) => (path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path);
  const missing = new Map();
  const older = new Map();
  const failures = [];
  for (const file of files) {
    const { status, output } = ldd(join(root, file), env);
    const lost = notFound(output);
    const old = versionsNotFound(output);
    for (const name of lost) note(missing, name, file);
    for (const { library, version, requiredBy } of old) note(older, `${library} ${version}`, fromRoot(requiredBy));
    if (status !== 0 && lost.length === 0 && old.length === 0) {
      failures.push({ file, status, output: String(output).trim().split("\n")[0] ?? "" });
    }
  }
  return { missing: sorted(missing), older: sorted(older), failures };
}

/** --appimage or --root, one of them, once. Throws a usage error. */
function parseArgs(argv) {
  const values = new Map();
  for (let i = 0; i < argv.length; i += 2) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (flag !== "--appimage" && flag !== "--root") throw new Error(`unexpected argument: ${flag}`);
    if (value === undefined || value === "" || value.startsWith("-")) throw new Error(`${flag} needs a value`);
    if (values.has(flag)) throw new Error(`${flag} is given twice`);
    values.set(flag, value);
  }
  if (values.size !== 1) throw new Error("give --appimage or --root");
  return { appimage: values.get("--appimage"), root: values.get("--root") };
}

/** Check an extracted AppImage; the exit code. */
function check(root) {
  const files = elfFiles(root).filter((file) => isDynamicElf(join(root, file)));
  if (files.length === 0) {
    process.stderr.write(`appimage-host-libs: no dynamically linked ELF file under ${root}\n`);
    return 1;
  }
  const { missing, older, failures } = hostLibraryProblems({ root, files });
  if (missing.size === 0 && older.size === 0 && failures.length === 0) {
    process.stdout.write(`appimage-host-libs: every library the AppImage's ${files.length} dynamically linked files need is here\n`);
    return 0;
  }
  const say = (line) => process.stderr.write(`${line}\n`);
  if (missing.size > 0) {
    say("appimage-host-libs: this system lacks libraries the AppImage leaves to it:");
    for (const [name, needers] of missing) say(`  ${name}, needed by ${needers.join(", ")}`);
  }
  if (older.size > 0) {
    say("appimage-host-libs: this system has libraries older than the AppImage needs:");
    for (const [what, needers] of older) say(`  ${what}, needed by ${needers.join(", ")}`);
  }
  if (failures.length > 0) {
    say("appimage-host-libs: ldd failed on:");
    for (const { file, status, output } of failures) say(`  ${file} (exit ${status}): ${output}`);
  }
  say("appimage-host-libs: a desktop has these libraries, in versions new enough; install them before the AppImage starts");
  return 1;
}

function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`appimage-host-libs: ${err.message}\n${USAGE}\n`);
    return 2;
  }
  try {
    if (args.root !== undefined) return check(args.root);
    const dir = mkdtempSync(join(tmpdir(), "appimage-host-libs-"));
    try {
      const extract = spawnSync(resolve(args.appimage), ["--appimage-extract"], { cwd: dir, stdio: ["ignore", "ignore", "inherit"] });
      const root = join(dir, "squashfs-root");
      if (extract.error || extract.status !== 0 || !existsSync(root) || !lstatSync(root).isDirectory()) {
        const why = extract.error ? (extract.error.code ?? extract.error.message) : `exit ${extract.status}`;
        process.stderr.write(`appimage-host-libs: can't extract ${args.appimage} (${why})\n`);
        return 1;
      }
      return check(root);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  } catch (err) {
    process.stderr.write(`appimage-host-libs: ${err.message}\n`);
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
