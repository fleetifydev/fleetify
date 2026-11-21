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
 * has. A system without one stops the app at start, with "error while
 * loading shared libraries" and exit 127. This runs ldd on every ELF file in
 * the AppImage, with LD_LIBRARY_PATH set to the AppImage's usr/lib, where
 * its own libraries are, and lists each library ldd can't find, with the
 * files that need it.
 *
 * --appimage extracts the AppImage first (<file> --appimage-extract, in a
 * temporary folder it removes afterwards); --root checks one already
 * extracted.
 *
 * Exit codes: 0 every library is found; 1 some aren't, each listed on
 * stderr, or the check couldn't run; 2 usage.
 */
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, lstatSync, mkdtempSync, openSync, readdirSync, readSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const USAGE = `usage: node scripts/release/appimage-host-libs.mjs --appimage <file>
       node scripts/release/appimage-host-libs.mjs --root <squashfs-root>`;

const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);

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

/** The libraries ldd's output says it can't find. */
export function notFound(output) {
  return [...String(output).matchAll(/^\s*(\S+) => not found\s*$/gm)].map(([, name]) => name);
}

/** Run ldd on `file`, with `env` added to the environment; its output, both streams. */
function runLdd(file, env) {
  const result = spawnSync("ldd", [file], { encoding: "utf8", env: { ...process.env, ...env } });
  if (result.error) throw new Error(`can't run ldd: ${result.error.code ?? result.error.message}`);
  return `${result.stdout}${result.stderr}`;
}

/**
 * Each library the ELF files under `root` need and ldd can't find, mapped to
 * the files that need it (paths from `root`). ldd looks in `root`'s usr/lib
 * first, where the AppImage keeps its own libraries.
 *
 * @param {{ root: string, ldd?: (file: string, env: object) => string, files?: string[] }} options
 * @returns {Map<string, string[]>}
 */
export function missingLibraries({ root, ldd = runLdd, files = elfFiles(root) }) {
  const env = { LD_LIBRARY_PATH: join(root, "usr", "lib") };
  const missing = new Map();
  for (const file of files) {
    for (const name of notFound(ldd(join(root, file), env))) {
      missing.set(name, [...(missing.get(name) ?? []), file]);
    }
  }
  return new Map([...missing].sort(([a], [b]) => compare(a, b)));
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
  const files = elfFiles(root);
  if (files.length === 0) {
    process.stderr.write(`appimage-host-libs: no ELF file under ${root}\n`);
    return 1;
  }
  const missing = missingLibraries({ root, files });
  if (missing.size > 0) {
    process.stderr.write("appimage-host-libs: this system lacks libraries the AppImage leaves to it:\n");
    for (const [name, needers] of missing) process.stderr.write(`  ${name}, needed by ${needers.join(", ")}\n`);
    process.stderr.write("appimage-host-libs: a desktop has them; install them before the AppImage starts\n");
    return 1;
  }
  process.stdout.write(`appimage-host-libs: every library the AppImage's ${files.length} ELF files need is here\n`);
  return 0;
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
