#!/usr/bin/env node
/**
 * third-party-notices.mjs — write THIRD-PARTY-NOTICES: the licences and
 * notices of the third-party software inside Fleetify's release bundles.
 *
 *   node scripts/release/third-party-notices.mjs --out THIRD-PARTY-NOTICES
 *
 * The release build runs this in CI and bundles the file it writes
 * (src-tauri/tauri.release.conf.json). The file is never committed: it is
 * gitignored, because licence texts carry their authors' contact details,
 * which this repository must not hold.
 *
 * Its four sections:
 *   - Rust crates, from `cargo about generate --format json` as
 *     scripts/release/about.toml configures it: the four release targets,
 *     no dev or build dependencies. The workspace's own crates are left out.
 *     Each licence text appears once, with the crates it covers. The NOTICE,
 *     COPYRIGHT and third-party notice files in each crate's folder (found
 *     through `cargo metadata`) follow the crate's first licence.
 *   - npm packages: the production packages in package-lock.json, each with
 *     the LICENSE*, LICENCE*, COPYING* and NOTICE* files it has in
 *     node_modules.
 *   - Bundled C/C++ source: whisper.cpp and ggml, which the whisper-rs-sys
 *     crate compiles in, under whisper.cpp's MIT licence from that crate,
 *     then every other licence notice found in that source, with the files
 *     it is in.
 *   - Linux AppImage: a pointer to LINUX-APPIMAGE-LIBRARIES.txt, which
 *     appimage-libraries.mjs writes for each release.
 *
 * Run `npm ci` and `cargo fetch --locked` first, with cargo-about 0.9.3 on
 * PATH. cargo runs with --frozen, so it neither goes online nor changes
 * Cargo.lock. Installing cargo-about with cargo needs its `cli` feature:
 * `cargo install cargo-about --locked --version 0.9.3 --features cli`.
 *
 * It fails closed: a production npm package without a licence file stops the
 * run unless NO_LICENCE_FILE lists it, and so does a missing whisper.cpp
 * licence or a failed cargo command.
 *
 * Exit codes: 0 written; 1 a source is missing or a command failed; 2 usage.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const USAGE = "usage: node scripts/release/third-party-notices.mjs --out <file>";

// File names, matched in any letter case.
/** An npm package's licence or NOTICE file: LICENSE*, LICENCE*, COPYING* or NOTICE*. */
const PACKAGE_FILE = /^(licen[cs]e|copying|notice)/i;
/** A licence file: LICENSE*, LICENCE* or COPYING*. */
const LICENCE_FILE = /^(licen[cs]e|copying)/i;
/**
 * A crate's notice file: NOTICE*, COPYRIGHT*, LICENSE-THIRD-PARTY* and
 * THIRD-PARTY* (also THIRD_PARTY*, ThirdParty*). A folder of that last kind
 * holds vendored code, and its licence files count as the crate's notices.
 */
const CRATE_NOTICE = /^(notice|copyright|licen[cs]e[-_]third[-_]?party|third[-_]?party)/i;
const THIRD_PARTY_FOLDER = /^third[-_]?party/i;
/** A licence or notice file inside vendored code: LICENSE*, LICENCE*, COPYING*, COPYRIGHT* or NOTICE*. */
const VENDORED_LICENCE = /^(licen[cs]e|copying|copyright|notice)/i;

/**
 * Standard licence texts, for npm packages published without a licence
 * file. MIT is SPDX's text, the one cargo-about gives a crate without one.
 */
export const STANDARD_TEXTS = Object.freeze({
  MIT: `MIT License

Copyright (c) <year> <copyright holders>

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
associated documentation files (the "Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the
following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial
portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT
LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO
EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
USE OR OTHER DEALINGS IN THE SOFTWARE.
`,
});

/**
 * Production npm packages published without a licence file, each with the
 * licence its package.json declares. The notices give that licence's
 * standard text for them. Any other production package without a licence
 * file stops the run, so that a new one is looked at before it ships.
 */
export const NO_LICENCE_FILE = Object.freeze({
  // From the posthog-js repository (packages/core). The LICENSE in the
  // posthog-js package is the Apache License and doesn't cover it.
  "@posthog/core": "MIT",
  // Both from the remark-math repository, whose licence file isn't published
  // with them.
  "rehype-katex": "MIT",
  "remark-math": "MIT",
});

const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
/** Orders crates and packages by name, then version. */
const byNameAndVersion = (a, b) => compare(a.name, b.name) || compare(a.version, b.version);
const label = ({ name, version }) => `${name} ${version}`;

const isFile = (path) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/** `{ file, text }` for each of `files`, paths relative to `dir` with "/", sorted. */
const readAll = (dir, files) =>
  [...files].sort(compare).map((file) => ({ file, text: readFileSync(join(dir, file), "utf8") }));

/**
 * The paths of the files under `dir`, relative to it with "/" separators.
 * Symlinks are not followed.
 */
function walk(dir, prefix = "") {
  const found = [];
  for (const name of readdirSync(dir)) {
    const stats = lstatSync(join(dir, name));
    const rel = prefix ? `${prefix}/${name}` : name;
    if (stats.isDirectory()) found.push(...walk(join(dir, name), rel));
    else if (stats.isFile()) found.push(rel);
  }
  return found;
}

/**
 * A `readPackageFiles` for npmProductionPackages: the licence and NOTICE
 * files of the package at `path` (a package-lock "packages" key) under
 * `root`. Throws when the package isn't there.
 *
 * @param {string} root
 * @returns {(path: string) => Array<{ file: string, text: string }>}
 */
export function packageFileReader(root) {
  return (path) => {
    const dir = join(root, path);
    if (!existsSync(dir)) throw new Error(`${path} is not installed: run npm ci first`);
    return readAll(dir, readdirSync(dir).filter((name) => PACKAGE_FILE.test(name) && isFile(join(dir, name))));
  };
}

/**
 * The licence and notice files of the crate in `dir`, as `{ file, text }`
 * with `file` relative to `dir`, sorted: the licence files (LICENCE_FILE)
 * and notice files (CRATE_NOTICE) at its top level, and the licence files
 * anywhere inside a top-level third-party folder, such as ring's
 * third_party/.
 *
 * @param {string} dir
 * @returns {Array<{ file: string, text: string }>}
 */
export function crateFiles(dir) {
  const files = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (isFile(path) && (LICENCE_FILE.test(name) || CRATE_NOTICE.test(name))) {
      files.push(name);
    } else if (THIRD_PARTY_FOLDER.test(name) && lstatSync(path).isDirectory()) {
      files.push(...walk(path, name).filter((rel) => VENDORED_LICENCE.test(posix.basename(rel))));
    }
  }
  return readAll(dir, files);
}

/**
 * Each package's folder, by package id, from `cargo metadata
 * --format-version 1` output.
 *
 * @param {{ packages?: Array<{ id: string, manifest_path: string }> }} metadata
 * @returns {Map<string, string>}
 */
export function crateDirectories(metadata) {
  return new Map((metadata.packages ?? []).map((p) => [p.id, dirname(p.manifest_path)]));
}

const MODULES = "node_modules/";

/**
 * The npm packages that ship: package-lock.json's "packages" without the
 * root, workspace packages and links, dev-only packages, and optional
 * packages tied to an OS or CPU (native builds for other platforms). Each
 * name and version comes once, sorted, with its licence and NOTICE files from
 * `readPackageFiles(path)`.
 *
 * A package without a licence file throws, unless `noLicenceFile` lists it
 * with the licence it declares: it then gets that licence's standard text
 * (`file: null`, first) and `standard: true`.
 *
 * @param {{ packages?: Record<string, any> }} lock
 * @param {(path: string) => Array<{ file: string, text: string }>} readPackageFiles
 * @param {{ noLicenceFile?: Record<string, string> }} [options]
 * @returns {Array<{ name: string, version: string, license: string, standard: boolean,
 *                   texts: Array<{ file: string | null, text: string }> }>}
 */
export function npmProductionPackages(lock, readPackageFiles, { noLicenceFile = NO_LICENCE_FILE } = {}) {
  const packages = new Map();
  for (const path of Object.keys(lock.packages ?? {}).sort(compare)) {
    const entry = lock.packages[path];
    if (!path.includes(MODULES) || entry.link || entry.dev) continue;
    if ((entry.optional || entry.devOptional) && (entry.os || entry.cpu || entry.libc)) continue;

    const name = entry.name ?? path.slice(path.lastIndexOf(MODULES) + MODULES.length);
    const { version } = entry;
    const key = `${name}@${version}`;
    if (packages.has(key)) continue;

    const license = typeof entry.license === "string" ? entry.license : "not declared";
    const texts = [...readPackageFiles(path)];
    const standard = !texts.some(({ file }) => LICENCE_FILE.test(file));
    if (standard) {
      texts.unshift({ file: null, text: standardText({ name, version, path, license }, noLicenceFile) });
    }
    packages.set(key, { name, version, license, standard, texts });
  }
  return [...packages.values()].sort(byNameAndVersion);
}

/** The standard licence text for a package without a licence file, or why there is none. */
function standardText({ name, version, path, license }, noLicenceFile) {
  if (!Object.hasOwn(noLicenceFile, name)) {
    throw new Error(
      `${name} ${version} (${path}) has no licence file (LICENSE*, LICENCE* or COPYING*). ` +
        "Check its licence; if it is published without a licence file, add it to " +
        "NO_LICENCE_FILE in scripts/release/third-party-notices.mjs.",
    );
  }
  const listed = noLicenceFile[name];
  if (listed !== license) {
    throw new Error(`${name} ${version} declares ${license}, but NO_LICENCE_FILE lists it as ${listed}`);
  }
  if (!Object.hasOwn(STANDARD_TEXTS, listed)) {
    throw new Error(`${name} ${version}: there is no standard text for ${listed} in STANDARD_TEXTS`);
  }
  return STANDARD_TEXTS[listed];
}

/** Crates as `{ name, version }`, each once, sorted. */
function crateList(crates) {
  const unique = new Map(crates.map(({ name, version }) => [`${name}@${version}`, { name, version }]));
  return [...unique.values()].sort(byNameAndVersion);
}

const byFirstCrate = (a, b) => byNameAndVersion(a.crates[0], b.crates[0]);
const compareFiles = (a, b) => byFirstCrate(a, b) || compare(a.file, b.file) || compare(a.text, b.text);
const compareLicences = (a, b) => compare(a.id, b.id) || byFirstCrate(a, b) || compare(a.text, b.text);

/**
 * The Rust part of the notices, from cargo-about's JSON output (`about`): one
 * entry per licence text, with the crates it covers, sorted. Crates whose
 * package id is in `exclude` (the workspace's own) are left out, and so is a
 * licence that no other crate uses.
 *
 * Each entry's `files` are files from its crates' folders, verbatim, once per
 * name and text, with the crates that ship them. `crateDirs` (from
 * crateDirectories) locates each folder, and `readCrateFiles` reads it.
 *   - Notice files (NOTICE, COPYRIGHT, third-party notices; see crateFiles)
 *     follow the crate's first licence in sorted order, so they appear once.
 *   - When cargo-about finds no file with a licence's text in a crate, it
 *     gives the licence's standard text, with no `source_path`. Offline,
 *     that happens for crates that ship no licence file, but also for files
 *     it skips, such as Tauri's LICENSE_MIT and windows-rs's license-mit. Such
 *     an entry has `standard: true`, and its crates' own licence files follow
 *     it, so their copyright lines reach the notices.
 *
 * Throws when a crate is not in `crateDirs`.
 *
 * @param {{ licenses?: Array<any> }} about
 * @param {{ exclude?: Set<string>, crateDirs?: Map<string, string>,
 *           readCrateFiles?: (dir: string) => Array<{ file: string, text: string }> }} [options]
 */
export function rustLicences(about, { exclude = new Set(), crateDirs = new Map(), readCrateFiles = crateFiles } = {}) {
  const read = new Map();
  const filesOf = (crate) => {
    const dir = crateDirs.get(crate.id);
    if (!dir) throw new Error(`${label(crate)} (${crate.id}) is not in cargo metadata, so its folder is unknown`);
    if (!read.has(dir)) read.set(dir, readCrateFiles(dir));
    return read.get(dir);
  };

  const licences = [];
  for (const licence of about.licenses ?? []) {
    const users = licence.used_by.map((use) => use.crate).filter((crate) => !exclude.has(crate.id));
    if (users.length === 0) continue;
    const standard = licence.source_path == null;
    licences.push({ id: licence.id, name: licence.name, text: licence.text, standard, crates: crateList(users), users });
  }
  licences.sort(compareLicences);

  const placed = new Set();
  return licences.map(({ users, ...licence }) => {
    const files = new Map();
    for (const crate of users) {
      const first = !placed.has(crate.id);
      placed.add(crate.id);
      for (const { file, text } of filesOf(crate)) {
        const wanted = CRATE_NOTICE.test(file) ? first : licence.standard && LICENCE_FILE.test(file);
        if (!wanted) continue;
        const key = `${file}\0${text}`;
        if (!files.has(key)) files.set(key, { file, text, crates: [] });
        files.get(key).crates.push(crate);
      }
    }
    const shipped = [...files.values()].map((f) => ({ ...f, crates: crateList(f.crates) }));
    return { ...licence, files: shipped.sort(compareFiles) };
  });
}

/** Source files sourceNotices reads, by extension: C-style comments (// and block comments) or # comments. */
const SLASH_COMMENTS = new Set([
  ".c", ".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp", ".hxx", ".cu", ".cuh", ".cl",
  ".comp", ".glsl", ".wgsl", ".tmpl", ".m", ".mm", ".metal", ".idl",
]);
const HASH_COMMENTS = new Set([".cmake", ".txt", ".in", ".py", ".sh"]);
/** Words that make a comment a licence notice. */
const NOTICE_MARKER =
  /copyright|spdx-license-identifier|licen[cs]ed under|mit licen[cs]e|apache licen[cs]e|bsd licen[cs]e|permission is hereby granted|redistribution and use|public domain/i;

/** The words of a text, lower-cased, without punctuation, comment marks or line breaks. */
const words = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * The comments in a source file's `text`: each run of consecutive comment
 * lines as `{ line, text }`, `line` counting from 1. In "slash" style a run is
 * // lines, or a whole block comment, blank lines included; in "hash" style
 * it is # lines. A blank line ends a // or # run.
 */
function commentBlocks(text, style) {
  const lines = text.split("\n");
  const blocks = [];
  let start = -1;
  let inBlock = false;
  const end = (i) => {
    if (start >= 0) blocks.push({ line: start + 1, text: lines.slice(start, i).join("\n") });
    start = -1;
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trimStart();
    let comment;
    if (style === "hash") {
      comment = line.startsWith("#");
    } else if (inBlock) {
      comment = true;
      inBlock = !line.includes("*/");
    } else if (line.startsWith("//")) {
      comment = true;
    } else if (line.startsWith("/*")) {
      comment = true;
      inBlock = !line.slice(2).includes("*/");
    } else {
      comment = false;
    }
    if (!comment) end(i);
    else if (start < 0) start = i;
  }
  end(lines.length);
  return blocks;
}

const comparePlaces = (a, b) => compare(a.path, b.path) || a.line - b.line;
const compareNotices = (a, b) => comparePlaces(a.places[0], b.places[0]) || compare(a.text, b.text);

/**
 * The licence notices in a source tree other than its licence, `licence`
 * (the text of `<root>/LICENSE`). Each is verbatim, once, with every place it
 * is at as `{ path, line }` (path relative to `root`, with "/"), sorted:
 *   - a licence or notice file anywhere below the top (VENDORED_LICENCE), whole;
 *   - in a source file (SLASH_COMMENTS, HASH_COMMENTS), a comment with a
 *     NOTICE_MARKER in it: a file header, or a line or two crediting
 *     borrowed code.
 * A notice whose words all appear, in order, in `licence` only repeats it,
 * and is left out.
 *
 * @param {string} root
 * @param {string} licence
 * @returns {Array<{ text: string, places: Array<{ path: string, line: number }> }>}
 */
export function sourceNotices(root, licence) {
  const own = words(licence);
  const notices = new Map();
  const add = (text, place) => {
    if (own.includes(words(text))) return;
    if (!notices.has(text)) notices.set(text, []);
    notices.get(text).push(place);
  };
  for (const path of walk(root)) {
    if (path === "LICENSE") continue;
    const name = posix.basename(path);
    const extension = posix.extname(name);
    if (VENDORED_LICENCE.test(name)) {
      add(readFileSync(join(root, path), "utf8"), { path, line: 1 });
      continue;
    }
    const style = SLASH_COMMENTS.has(extension) ? "slash" : HASH_COMMENTS.has(extension) ? "hash" : null;
    if (!style) continue;
    for (const block of commentBlocks(readFileSync(join(root, path), "utf8"), style)) {
      if (NOTICE_MARKER.test(block.text)) add(block.text, { path, line: block.line });
    }
  }
  return [...notices]
    .map(([text, places]) => ({ text, places: places.sort(comparePlaces) }))
    .sort(compareNotices);
}

/**
 * whisper.cpp's licence, which covers the ggml library inside it too. The
 * whisper-rs-sys crate compiles both into Fleetify, for on-device voice
 * dictation, from the whisper.cpp folder beside its Cargo.toml. `metadata`
 * is `cargo metadata --format-version 1` output. `notices` are the other
 * licence notices in that folder (`findNotices`, sourceNotices by default),
 * their paths starting with "whisper.cpp/". Throws when whisper-rs-sys isn't
 * in the graph exactly once, or the licence is missing, empty or not the MIT
 * License.
 *
 * @param {{ packages?: Array<{ name: string, version: string, manifest_path: string }> }} metadata
 * @param {{ readText?: (path: string) => string,
 *           findNotices?: (dir: string, licence: string) => ReturnType<typeof sourceNotices> }} [options]
 */
export function whisperCppLicence(
  metadata,
  { readText = (path) => readFileSync(path, "utf8"), findNotices = sourceNotices } = {},
) {
  const crates = (metadata.packages ?? []).filter((p) => p.name === "whisper-rs-sys");
  if (crates.length !== 1) {
    throw new Error(
      `whisper.cpp's licence comes from the whisper-rs-sys crate, but the cargo graph has ${crates.length} of it`,
    );
  }
  const [crate] = crates;
  const source = join(dirname(crate.manifest_path), "whisper.cpp");
  const path = join(source, "LICENSE");
  let text;
  try {
    text = readText(path);
  } catch (err) {
    throw new Error(`whisper.cpp's licence is missing: ${path} (${err.code ?? err.message})`);
  }
  if (!text.trim()) throw new Error(`whisper.cpp's licence is empty: ${path}`);
  if (!/\bMIT License\b/.test(text)) throw new Error(`whisper.cpp's licence is not the MIT License: ${path}`);
  const notices = findNotices(source, text).map((notice) => ({
    text: notice.text,
    places: notice.places.map(({ path: file, line }) => ({ path: `whisper.cpp/${file}`, line })),
  }));
  return {
    name: "whisper.cpp and ggml",
    from: `whisper-rs-sys ${crate.version}`,
    licence: "MIT",
    file: "whisper.cpp/LICENSE",
    text,
    notices,
  };
}

const RULE = "=".repeat(80);
const LINE = "-".repeat(80);

const INTRO = [
  "Fleetify is licensed under the Apache License, Version 2.0; see LICENSE and",
  "NOTICE. It includes the third-party software below, in four sections: Rust",
  "crates, npm packages, bundled C/C++ source, and the system libraries in the",
  "Linux AppImage. Each part comes with the licence terms that apply to it.",
];
const RUST_INTRO = [
  "The Rust crates compiled into Fleetify and its MCP sidecars. Each licence text",
  "appears once, after the crates it covers. A crate that offers a choice of",
  "licences is listed under the one Fleetify takes. The NOTICE, COPYRIGHT and",
  "third-party notice files that a crate ships follow the first licence it is",
  "listed under, verbatim.",
];
const STANDARD_NOTE = [
  "cargo-about found no file with this licence's text in these crates, so the",
  "licence's standard text follows.",
];
const STANDARD_AND_SHIPPED_NOTE = [
  "cargo-about found no file with this licence's text in these crates, so the",
  "licence's standard text follows, then the files that some of them ship.",
];
const SOURCE_NOTICES_NOTE = [
  "Licence notices inside individual files of this source follow, verbatim, with",
  "the files and lines they are at. Notices that only repeat the licence above are",
  "left out.",
];
const NPM_INTRO = [
  "The npm packages built into Fleetify's user interface, each with the licence",
  "and NOTICE files it is published with.",
];
const NPM_STANDARD_NOTE = [
  "Published without a licence file: this is the standard text of the licence",
  "its package.json declares.",
];
const BUNDLED_INTRO = ["C and C++ source that a Rust crate carries and compiles into Fleetify."];
const APPIMAGE = [
  "The Linux AppImage also bundles system libraries, which each release lists,",
  "with their copyright files and source links, in LINUX-APPIMAGE-LIBRARIES.txt.",
];

/** A text that comes out verbatim once the lines are joined with "\n", which puts its final newline back. */
const verbatim = (text) => (text.endsWith("\n") ? text.slice(0, -1) : text);
const indented = (crates) => crates.map((crate) => `    ${label(crate)}`);
const heading = (out, title, intro) => out.push("", "", RULE, title, RULE, "", ...intro);

/**
 * THIRD-PARTY-NOTICES as text. Deterministic: everything is sorted here,
 * whatever order the input comes in, and nothing depends on the time or the
 * machine. Licence texts go in verbatim.
 *
 * @param {{ version: string, rust: ReturnType<typeof rustLicences>,
 *           npm: ReturnType<typeof npmProductionPackages>,
 *           bundled: Array<ReturnType<typeof whisperCppLicence>> }} input
 * @returns {string}
 */
export function renderNotices({ version, rust, npm, bundled }) {
  const title = `Third-party notices for Fleetify ${version}`;
  const out = [title, "=".repeat(title.length), "", ...INTRO];

  heading(out, "Rust crates", RUST_INTRO);
  const licences = rust
    .map((licence) => ({
      ...licence,
      crates: [...licence.crates].sort(byNameAndVersion),
      files: licence.files
        .map((f) => ({ ...f, crates: [...f.crates].sort(byNameAndVersion) }))
        .sort(compareFiles),
    }))
    .sort(compareLicences);
  for (const licence of licences) {
    out.push("", LINE, `${licence.name} (${licence.id})`, "", ...indented(licence.crates), "");
    if (licence.standard) {
      out.push(...(licence.files.length > 0 ? STANDARD_AND_SHIPPED_NOTE : STANDARD_NOTE), "");
    }
    out.push(verbatim(licence.text));
    for (const f of licence.files) {
      out.push("", `[${f.file}] in:`, ...indented(f.crates), "", verbatim(f.text));
    }
  }

  heading(out, "npm packages", NPM_INTRO);
  for (const pkg of [...npm].sort(byNameAndVersion)) {
    out.push("", LINE, label(pkg), `Licence: ${pkg.license}`);
    for (const { file, text } of [...pkg.texts].sort((a, b) => compare(a.file ?? "", b.file ?? ""))) {
      out.push("", ...(file === null ? NPM_STANDARD_NOTE : [`[${file}]`]), "", verbatim(text));
    }
  }

  heading(out, "Bundled C/C++ source", BUNDLED_INTRO);
  for (const source of [...bundled].sort((a, b) => compare(a.name, b.name))) {
    out.push("", LINE, `${source.name}, from ${source.from}`, `Licence: ${source.licence}`);
    out.push("", `[${source.file}]`, "", verbatim(source.text));
    const notices = (source.notices ?? [])
      .map((notice) => ({ ...notice, places: [...notice.places].sort(comparePlaces) }))
      .sort(compareNotices);
    if (notices.length > 0) out.push("", ...SOURCE_NOTICES_NOTE);
    for (const notice of notices) {
      out.push("", "Notice in:", ...notice.places.map((p) => `    ${p.path}:${p.line}`), "", verbatim(notice.text));
    }
  }

  heading(out, "Linux AppImage", APPIMAGE);
  return `${out.join("\n")}\n`;
}

/** `--out <file>`, and nothing else. */
function parseArgs(argv) {
  let out = null;
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i + 1];
    if (argv[i] === "--out" && value && !value.startsWith("-")) {
      out = value;
      i += 1;
    } else {
      throw new Error(`unexpected argument: ${argv[i]}`);
    }
  }
  if (!out) throw new Error("--out <file> is required");
  return { out };
}

/**
 * `command args` from the repo root, without a shell; returns its stdout.
 * Its stderr goes straight to ours, so cargo's errors and warnings show.
 */
function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 1 << 30,
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (result.error) throw new Error(`could not run ${command}: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed (${result.status ?? result.signal})`);
  }
  return result.stdout;
}

function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`third-party-notices: ${err.message}\n${USAGE}\n`);
    return 2;
  }
  try {
    const { version } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    const metadata = JSON.parse(run("cargo", ["metadata", "--format-version", "1", "--frozen"]));
    const about = JSON.parse(
      run("cargo", [
        "about", "generate", "--format", "json", "-c", "scripts/release/about.toml",
        "--workspace", "--frozen", "--fail",
      ]),
    );
    const lock = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8"));

    const rust = rustLicences(about, {
      exclude: new Set(metadata.workspace_members),
      crateDirs: crateDirectories(metadata),
    });
    const npm = npmProductionPackages(lock, packageFileReader(ROOT));
    const bundled = [whisperCppLicence(metadata)];
    writeFileSync(args.out, renderNotices({ version, rust, npm, bundled }));

    const crates = new Set(rust.flatMap((licence) => licence.crates.map(label))).size;
    const crateFileCount = rust.reduce((n, licence) => n + licence.files.length, 0);
    const sourceNoticeCount = bundled.reduce((n, source) => n + source.notices.length, 0);
    process.stderr.write(
      `third-party-notices: wrote ${args.out}: ${crates} Rust crates under ${rust.length} licence texts ` +
        `with ${crateFileCount} files from their folders, ${npm.length} npm packages, ` +
        `${bundled.map((source) => source.name).join(", ")} with ${sourceNoticeCount} more notices\n`,
    );
    return 0;
  } catch (err) {
    process.stderr.write(`third-party-notices: ${err.message}\n`);
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
