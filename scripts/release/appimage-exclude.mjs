#!/usr/bin/env node
/**
 * appimage-exclude.mjs — take out of the Linux AppImage the libraries it
 * must leave to the system, and repack it.
 *
 *   node scripts/release/appimage-exclude.mjs --dir <bundle/appimage folder>
 *
 * linuxdeploy copies into the AppImage every library the app links to,
 * except those on its built-in excludelist, which the system must provide.
 * The linuxdeploy that appimage-tools.json pins predates some entries of
 * that list: EXCLUDED_LIBRARIES names them, and this takes each one out.
 *
 * The folder must hold exactly one *.AppImage. It is extracted (<file>
 * --appimage-extract, in a temporary folder), and every file or symlink
 * named like a listed library (its name, or its name with more version
 * numbers after it) is deleted. The extraction leaves every folder 0700,
 * which the repack would keep, so they go back to 0755, the bundler's mode.
 * The rest is repacked with the pinned linuxdeploy-plugin-appimage from the
 * bundler's cache (appimage-tools.mjs puts it there), with the variables the
 * bundler gives it, and with the AppImage's own runtime (LDAI_RUNTIME_FILE),
 * which appimagetool would otherwise download. The plugin extracts itself
 * into the temporary folder too (TMPDIR), as it doesn't clean up after itself.
 *
 * The repacked AppImage is extracted in turn, and must hold exactly the
 * original's files less the deleted ones. Only then is it renamed into the
 * original's place, with the original's mode. One line names what was taken
 * out, and the sizes before and after.
 *
 * An AppImage that holds none of the listed libraries, which a later
 * linuxdeploy leaves out itself, is left as it is. Any failure leaves the
 * AppImage as it was. The temporary folder is always removed.
 *
 * Exit codes: 0 repacked, or nothing to take out; 1 a problem, named on
 * stderr, with the AppImage left as it was; 2 usage.
 */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defaultCacheDir, parseManifest } from "./appimage-tools.mjs";

const USAGE = "usage: node scripts/release/appimage-exclude.mjs --dir <bundle/appimage folder>";
const MANIFEST = fileURLToPath(new URL("./appimage-tools.json", import.meta.url));

/**
 * The libraries the AppImage leaves to the system, which the pinned
 * linuxdeploy copies in all the same.
 *
 * - libwayland-client.so.0: a newer system's Mesa needs its own, newer
 *   libwayland-client. With the AppImage's copy, Ubuntu 22.04's, loaded
 *   first, its libEGL fails ("Could not create default EGL display:
 *   EGL_BAD_PARAMETER"), WebKit's web process aborts and the window stays
 *   blank. AppImage's excludelist has left it to the system since
 *   2024-11-03 for that reason (AppImageCommunity/pkg2appimage#559, mesa
 *   issue 11316); the pinned linuxdeploy was built on 2024-07-26. Every
 *   system with Mesa's EGL has the library, as Mesa's EGL needs it.
 *
 * Drop an entry once the pinned linuxdeploy's built-in excludelist has it:
 * this then reports that the AppImage holds none of it.
 */
export const EXCLUDED_LIBRARIES = ["libwayland-client.so.0"];

/** The plugin's output kept for an error message: its last lines. */
const OUTPUT_LINES = 30;
/** Room for the plugin's output, progress bars included. */
const MAX_OUTPUT = 64 * 1024 * 1024;

const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const EXCLUDED = EXCLUDED_LIBRARIES.map((name) => new RegExp(`^${escapeRegExp(name)}(\\.[0-9]+)*$`));

/**
 * Whether a file name is a listed library's: its name, or its name with more
 * version numbers after it (libwayland-client.so.0.20.0).
 *
 * @param {string} name
 */
export const isExcludedName = (name) => EXCLUDED.some((pattern) => pattern.test(name));

/**
 * The pinned linuxdeploy-plugin-appimage: the file appimage-tools.json names
 * for it, in the bundler's cache.
 *
 * @param {string} [cacheDir]
 */
export function pinnedPlugin(cacheDir = defaultCacheDir()) {
  const tools = parseManifest(JSON.parse(readFileSync(MANIFEST, "utf8")));
  const tool = tools.find(({ file }) => file.startsWith("linuxdeploy-plugin-appimage"));
  if (tool === undefined) throw new Error(`${MANIFEST} pins no linuxdeploy-plugin-appimage`);
  return join(cacheDir, tool.file);
}

/**
 * Every entry under `root`, sorted by path from it ("/" separators), each
 * with its kind: dir, file, link or other. Symlinks aren't followed.
 *
 * @param {string} root
 * @returns {{ path: string, kind: string }[]}
 */
function entries(root) {
  const found = [];
  const walk = (dir, prefix) => {
    for (const name of readdirSync(dir)) {
      const rel = prefix === "" ? name : `${prefix}/${name}`;
      const stats = lstatSync(join(dir, name));
      const kind = stats.isDirectory() ? "dir" : stats.isSymbolicLink() ? "link" : stats.isFile() ? "file" : "other";
      found.push({ path: rel, kind });
      if (kind === "dir") walk(join(dir, name), rel);
    }
  };
  walk(root, "");
  return found.sort((a, b) => compare(a.path, b.path));
}

/** The files and symlinks among `list` that are named like a listed library. */
const excludedAmong = (list) => list.filter(({ path, kind }) => (kind === "file" || kind === "link") && isExcludedName(path.split("/").at(-1)));

/** How a child process ended, for an error message. */
function ending(result) {
  if (result.error) return result.error.code ?? result.error.message;
  return result.signal ? `killed by ${result.signal}` : `exit ${result.status}`;
}

/** The last lines of a child's output, indented, or nothing. */
function lastLines(...outputs) {
  const lines = outputs.map((output) => String(output ?? "")).join("").trimEnd().split("\n").filter((line) => line.trim() !== "");
  return lines.length === 0 ? "" : `\n${lines.slice(-OUTPUT_LINES).map((line) => `  ${line}`).join("\n")}`;
}

/** The one *.AppImage in `dir`, as an absolute path. Throws when there is none, or more. */
function findAppImage(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch (err) {
    throw new Error(`can't read ${dir}: ${err.code ?? err.message}`);
  }
  const found = names.filter((name) => name.endsWith(".AppImage")).sort(compare);
  if (found.length === 0) throw new Error(`${dir} holds no *.AppImage`);
  if (found.length > 1) throw new Error(`${dir} holds ${found.length} AppImages, expected one: ${found.join(", ")}`);
  const appimage = resolve(dir, found[0]);
  if (!lstatSync(appimage).isFile()) throw new Error(`${appimage} is not a regular file`);
  return appimage;
}

/** Extract an AppImage into the new folder `into`; the squashfs-root it made. */
function extract(appimage, into, spawn) {
  mkdirSync(into);
  const result = spawn(appimage, ["--appimage-extract"], { cwd: into, encoding: "utf8", stdio: ["ignore", "ignore", "pipe"], maxBuffer: MAX_OUTPUT });
  const root = join(into, "squashfs-root");
  if (result.error || result.status !== 0 || !existsSync(root) || !lstatSync(root).isDirectory()) {
    throw new Error(`can't extract ${appimage} (${ending(result)})${lastLines(result.stderr)}`);
  }
  return root;
}

/** An AppImage's runtime: the bytes before its file system, where --appimage-offset says it starts. */
function runtimeOf(appimage, spawn) {
  const result = spawn(appimage, ["--appimage-offset"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: MAX_OUTPUT });
  const printed = String(result.stdout ?? "").trim();
  const size = statSync(appimage).size;
  if (result.error || result.status !== 0 || !/^[1-9][0-9]*$/.test(printed) || Number(printed) >= size) {
    throw new Error(`can't tell where ${appimage}'s runtime ends: --appimage-offset gave ${JSON.stringify(printed)} (${ending(result)})${lastLines(result.stderr)}`);
  }
  const runtime = Buffer.alloc(Number(printed));
  const fd = openSync(appimage, "r");
  try {
    for (let read = 0; read < runtime.length; ) {
      const n = readSync(fd, runtime, read, runtime.length - read, read);
      if (n === 0) throw new Error(`${appimage} ended inside its runtime`);
      read += n;
    }
  } finally {
    closeSync(fd);
  }
  return runtime;
}

/**
 * Take the listed libraries out of the one AppImage in `dir`, and repack it.
 *
 * @param {{
 *   dir: string,
 *   plugin?: string,
 *   spawn?: typeof spawnSync,
 *   tmpRoot?: string,
 * }} options
 *   plugin: the linuxdeploy-plugin-appimage to repack with (default: the
 *   pinned one in the bundler's cache); spawn: runs the AppImages and the
 *   plugin, as spawnSync does; tmpRoot: where the temporary folder goes.
 * @returns {{ appimage: string, removed: string[], before?: number, after?: number }}
 *   removed: the paths taken out, from the AppImage's root, sorted; empty
 *   when it holds none, and then it is left as it is. before and after:
 *   the AppImage's sizes, in bytes, when it was repacked.
 * @throws on any problem, the AppImage left as it was.
 */
export function excludeLibraries({ dir, plugin, spawn = spawnSync, tmpRoot = tmpdir() }) {
  const appimage = findAppImage(dir);
  const work = mkdtempSync(join(tmpRoot, "appimage-exclude-"));
  try {
    const appdir = extract(appimage, join(work, "original"), spawn);
    const original = entries(appdir);
    const removed = excludedAmong(original);
    if (removed.length === 0) return { appimage, removed: [] };

    const tool = plugin ?? pinnedPlugin();
    if (!existsSync(tool)) throw new Error(`no linuxdeploy-plugin-appimage at ${tool}: scripts/release/appimage-tools.mjs installs the pinned one`);
    const runtime = join(work, "runtime");
    writeFileSync(runtime, runtimeOf(appimage, spawn));

    for (const { path } of removed) unlinkSync(join(appdir, path));
    chmodSync(appdir, 0o755);
    for (const { path } of original.filter(({ kind }) => kind === "dir")) chmodSync(join(appdir, path), 0o755);

    // As tauri-bundler runs linuxdeploy, whose output plugin this is, with
    // the runtime it already has: the release builds the x86_64 AppImage.
    mkdirSync(join(work, "out"));
    mkdirSync(join(work, "tmp"));
    const output = join(work, "out", basename(appimage));
    const env = { ...process.env, APPIMAGE_EXTRACT_AND_RUN: "1", ARCH: "x86_64", OUTPUT: output, LDAI_RUNTIME_FILE: runtime, TMPDIR: join(work, "tmp") };
    const packed = spawn(tool, ["--appdir", appdir], { cwd: work, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: MAX_OUTPUT });
    if (packed.error || packed.status !== 0) {
      throw new Error(`linuxdeploy-plugin-appimage failed (${ending(packed)})${lastLines(packed.stdout, packed.stderr)}`);
    }
    if (!existsSync(output) || !statSync(output).isFile() || statSync(output).size === 0) {
      throw new Error(`linuxdeploy-plugin-appimage made no AppImage at ${output}${lastLines(packed.stdout, packed.stderr)}`);
    }

    chmodSync(output, 0o755);
    const repacked = entries(extract(output, join(work, "check"), spawn));
    const left = excludedAmong(repacked);
    if (left.length > 0) throw new Error(`the repacked AppImage still holds ${left.map(({ path }) => path).join(", ")}`);
    const key = ({ kind, path }) => `${kind} ${path}`;
    const gone = new Set(removed.map(key));
    const expected = new Set(original.map(key).filter((entry) => !gone.has(entry)));
    const got = new Set(repacked.map(key));
    const differences = [
      ...[...expected].filter((entry) => !got.has(entry)).map((entry) => `lacks ${entry}`),
      ...[...got].filter((entry) => !expected.has(entry)).map((entry) => `adds ${entry}`),
    ];
    if (differences.length > 0) {
      throw new Error(`the repacked AppImage doesn't hold exactly the original's files less the ones taken out: it ${differences.slice(0, 20).join(", ")}`);
    }

    // Copied next to the original, then renamed over it: the rename is atomic.
    const before = statSync(appimage).size;
    const mode = statSync(appimage).mode & 0o777;
    const staged = join(dirname(appimage), `.${basename(appimage)}.${process.pid}.repacked`);
    try {
      copyFileSync(output, staged, constants.COPYFILE_EXCL);
      chmodSync(staged, mode);
      renameSync(staged, appimage);
    } catch (err) {
      throw new Error(`can't put the repacked AppImage in place of ${appimage}: ${err.code ?? err.message}`);
    } finally {
      rmSync(staged, { force: true });
    }
    return { appimage, removed: removed.map(({ path }) => path), before, after: statSync(appimage).size };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** --dir, once, with a value. Throws a usage error. */
function parseArgs(argv) {
  let dir;
  for (let i = 0; i < argv.length; i += 2) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (flag !== "--dir") throw new Error(`unexpected argument: ${flag}`);
    if (value === undefined || value === "" || value.startsWith("-")) throw new Error(`${flag} needs a value`);
    if (dir !== undefined) throw new Error(`${flag} is given twice`);
    dir = value;
  }
  if (dir === undefined) throw new Error("--dir is required");
  return dir;
}

function main(argv) {
  let dir;
  try {
    dir = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`appimage-exclude: ${err.message}\n${USAGE}\n`);
    return 2;
  }
  let result;
  try {
    result = excludeLibraries({ dir });
  } catch (err) {
    process.stderr.write(`appimage-exclude: ${err.message}\n`);
    process.stderr.write(`appimage-exclude: nothing in ${dir} was changed\n`);
    return 1;
  }
  const name = basename(result.appimage);
  if (result.removed.length === 0) {
    process.stdout.write(`appimage-exclude: ${name} holds none of ${EXCLUDED_LIBRARIES.join(", ")}; it is left as it was\n`);
  } else {
    process.stdout.write(
      `appimage-exclude: took ${result.removed.join(", ")} out of ${name} and repacked it: ${result.before} bytes before, ${result.after} after\n`,
    );
  }
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
