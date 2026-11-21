#!/usr/bin/env node
/**
 * compiled-tar.mjs — the hand-off between a macOS compile job, which runs the
 * dependencies' code and holds no key, and the bundle job, which holds the
 * signing keys: what the archive must hold, and how the bundle job unpacks it.
 *
 *   node scripts/release/compiled-tar.mjs list --target <triple>
 *   node scripts/release/compiled-tar.mjs unpack --target <triple> --tar <file> --out <dir>
 *
 * list prints, one a line, the files the bundler needs from the compile job
 * (compiledFiles): the app binary under target/<triple>/release/, and each
 * sidecar staged in src-tauri/ under the names tauri.conf.json's
 * bundle.externalBin gives it. The compile job packs exactly those, in ustar
 * format.
 *
 * unpack reads the archive itself, member by member, rather than handing it
 * to tar, and refuses it unless every member is a regular file at one of
 * those paths, or a folder above one, each named once: no link of either
 * kind, no device or FIFO, no pax or GNU extension, no absolute path and no
 * ".", ".." or empty component, every listed file present, the headers'
 * checksums right and the archive whole. Only then does it write each
 * listed file into <dir>, which must be empty, with mode 0755 whatever the
 * member's mode. When anything is wrong it writes nothing.
 *
 * Exit codes: 0 listed or unpacked; 1 the archive is refused, each problem
 * listed on stderr; 2 usage.
 */
import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const USAGE = `usage: node scripts/release/compiled-tar.mjs list --target <triple>
       node scripts/release/compiled-tar.mjs unpack --target <triple> --tar <file> --out <dir>`;

/** The app crate's binary, as src-tauri/Cargo.toml names the package. */
export const APP_BINARY = "fleetify-app";

const CONFIG = new URL("../../src-tauri/tauri.conf.json", import.meta.url);

/** What a member's type flag stands for, for the ones the check refuses. */
const TYPE_NAMES = {
  1: "a hard link",
  2: "a symbolic link",
  3: "a character device",
  4: "a block device",
  6: "a FIFO",
  7: "a contiguous file",
  x: "a pax extended header",
  g: "a pax global header",
  L: "a GNU long name",
  K: "a GNU long link name",
};

/**
 * The files the bundle job needs from a compile job, as paths from the
 * repository's root: the app binary, and each sidecar Tauri bundles.
 *
 * @param {string} triple
 * @param {{ config?: object }} [options]  tauri.conf.json, read from the repository by default
 * @returns {string[]}
 */
export function compiledFiles(triple, { config = JSON.parse(readFileSync(CONFIG, "utf8")) } = {}) {
  if (typeof triple !== "string" || !/^[A-Za-z0-9_.-]+$/.test(triple)) throw new Error(`invalid target triple ${JSON.stringify(triple)}`);
  const exe = triple.includes("windows") ? ".exe" : "";
  const sidecars = config?.bundle?.externalBin ?? [];
  return [`target/${triple}/release/${APP_BINARY}${exe}`, ...sidecars.map((bin) => `src-tauri/${bin}-${triple}${exe}`)];
}

/** A NUL-terminated text field of a header. */
function field(block, start, length) {
  const raw = block.subarray(start, start + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? length : end).toString("utf8");
}

/** An octal number field; NaN when it isn't one. */
function octal(block, start, length) {
  const text = field(block, start, length).trim();
  return /^[0-7]+$/.test(text) ? Number.parseInt(text, 8) : Number.NaN;
}

/**
 * Read a ustar archive's members: { path, type, data } each, type being the
 * header's type flag ("0" for a regular file written with a NUL flag too).
 * Reading stops at a problem, which is returned instead.
 *
 * @param {Buffer} bytes
 * @returns {{ members: { path: string, type: string, data: Buffer }[], problems: string[] }}
 */
function readArchive(bytes) {
  const members = [];
  let offset = 0;
  for (;;) {
    if (offset + 512 > bytes.length) return { members, problems: ["the archive has no end-of-archive block"] };
    const block = bytes.subarray(offset, offset + 512);
    if (block.every((byte) => byte === 0)) return { members, problems: [] };
    let sum = 0;
    for (let i = 0; i < 512; i += 1) sum += i >= 148 && i < 156 ? 0x20 : block[i];
    if (octal(block, 148, 8) !== sum) return { members, problems: [`the member header at byte ${offset} has a bad checksum`] };
    const magic = block.subarray(257, 263).toString("latin1");
    if (!magic.startsWith("ustar")) return { members, problems: [`the member at byte ${offset} is not a ustar member`] };
    if (block[124] & 0x80) return { members, problems: [`the member at byte ${offset} is too large`] };
    const size = octal(block, 124, 12);
    if (Number.isNaN(size)) return { members, problems: [`the member at byte ${offset} has no readable size`] };
    // POSIX ustar splits a long path into prefix and name; GNU's old format keeps other fields there.
    const prefix = magic === "ustar\0" ? field(block, 345, 155) : "";
    const name = field(block, 0, 100);
    const flag = block[156] === 0 ? "0" : String.fromCharCode(block[156]);
    const start = offset + 512;
    if (start + size > bytes.length) return { members, problems: [`the archive is cut short in ${JSON.stringify(name)}`] };
    members.push({ path: prefix === "" ? name : `${prefix}/${name}`, type: flag, data: bytes.subarray(start, start + size) });
    offset = start + Math.ceil(size / 512) * 512;
  }
}

/** Why a member's path is refused, or null when it is a plain relative path. */
function pathProblem(path) {
  if (path.startsWith("/")) return "an absolute path";
  const parts = path.split("/");
  if (parts.includes("..")) return "a .. component";
  if (parts.includes(".")) return "a . component";
  if (parts.some((part) => part === "")) return "an empty component";
  return null;
}

/**
 * Check the hand-off archive and, when nothing is wrong with it, write the
 * listed files into `out`.
 *
 * @param {{ tar: string, out: string, files: string[] }} options
 *   files: compiledFiles() for the target
 * @returns {{ problems: string[], written: string[] }}
 */
export function unpack({ tar, out, files }) {
  const problems = [];
  let bytes;
  try {
    bytes = readFileSync(tar);
  } catch (err) {
    return { problems: [`can't read ${tar}: ${err.code ?? err.message}`], written: [] };
  }
  const archive = readArchive(bytes);
  problems.push(...archive.problems);
  const parents = new Set(files.flatMap((file) => file.split("/").slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join("/"))));
  const seen = new Set();
  const contents = new Map();
  for (const { path, type, data } of archive.members) {
    const isFolder = type === "5";
    const clean = isFolder ? path.replace(/\/+$/, "") : path;
    const why = pathProblem(clean);
    if (why !== null) {
      problems.push(`${JSON.stringify(path)} has ${why}`);
      continue;
    }
    if (type !== "0" && !isFolder) {
      problems.push(`${JSON.stringify(clean)} is ${TYPE_NAMES[type] ?? `of type ${JSON.stringify(type)}`}, not a regular file or a folder`);
      continue;
    }
    if (seen.has(clean)) {
      problems.push(`${JSON.stringify(clean)} appears twice`);
      continue;
    }
    seen.add(clean);
    if (isFolder) {
      if (!parents.has(clean)) problems.push(`unexpected folder ${JSON.stringify(clean)}`);
    } else if (files.includes(clean)) {
      contents.set(clean, data);
    } else {
      problems.push(`unexpected file ${JSON.stringify(clean)}`);
    }
  }
  for (const file of files) if (!contents.has(file) && archive.problems.length === 0) problems.push(`missing ${JSON.stringify(file)}`);
  let present = [];
  try {
    present = readdirSync(out);
  } catch (err) {
    if (err.code !== "ENOENT") problems.push(`can't read ${out}: ${err.code ?? err.message}`);
  }
  if (present.length > 0) problems.push(`${out} is not empty`);
  if (problems.length > 0) return { problems, written: [] };

  mkdirSync(out, { recursive: true });
  if (!lstatSync(out).isDirectory()) return { problems: [`${out} is not a folder`], written: [] };
  for (const file of files) {
    const target = join(out, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents.get(file), { flag: "wx", mode: 0o755 });
    chmodSync(target, 0o755);
  }
  return { problems: [], written: [...files] };
}

/** The command line. Throws a usage error. */
function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (command !== "list" && command !== "unpack") throw new Error(command === undefined ? "missing command: list or unpack" : `unknown command: ${command}`);
  const takes = command === "list" ? ["--target"] : ["--target", "--tar", "--out"];
  const values = new Map();
  for (let i = 0; i < rest.length; i += 2) {
    const [flag, value] = [rest[i], rest[i + 1]];
    if (!takes.includes(flag)) throw new Error(`unexpected argument: ${flag}`);
    if (value === undefined || value === "" || value.startsWith("-")) throw new Error(`${flag} needs a value`);
    if (values.has(flag)) throw new Error(`${flag} is given twice`);
    values.set(flag, value);
  }
  for (const flag of takes) if (!values.has(flag)) throw new Error(`${flag} is required`);
  return { command, target: values.get("--target"), tar: values.get("--tar"), out: values.get("--out") };
}

function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`compiled-tar: ${err.message}\n${USAGE}\n`);
    return 2;
  }
  let files;
  try {
    files = compiledFiles(args.target);
  } catch (err) {
    process.stderr.write(`compiled-tar: ${err.message}\n`);
    return 1;
  }
  if (args.command === "list") {
    process.stdout.write(files.map((file) => `${file}\n`).join(""));
    return 0;
  }
  const { problems, written } = unpack({ tar: args.tar, out: args.out, files });
  if (problems.length > 0) {
    for (const problem of problems) process.stderr.write(`compiled-tar: ${problem}\n`);
    process.stderr.write(`compiled-tar: refused ${args.tar}; nothing was unpacked\n`);
    return 1;
  }
  process.stdout.write(`compiled-tar: unpacked ${written.length} files into ${args.out}:\n${written.map((file) => `  ${file}\n`).join("")}`);
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
