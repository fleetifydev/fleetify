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
 *   - npm packages: the production packages in package-lock.json, and the
 *     build-time packages whose output ships (SHIPPED_BUILD_PACKAGES), each
 *     with the LICENSE*, LICENCE*, COPYING* and NOTICE* files it has in
 *     node_modules, at its top and below it (outside nested node_modules),
 *     and the vendored-code headers that VENDORED_HEADER_NOTICES points to.
 *   - Bundled C/C++ source: the C, C++ and assembly source that crates
 *     compile in. whisper.cpp and ggml (from whisper-rs-sys) come under
 *     whisper.cpp's MIT licence; every release crate that builds with cc or
 *     cmake is scanned for the licence notices in its sources; SQLite (from
 *     libsqlite3-sys), which is in the public domain, gets one line. Each
 *     notice comes with the crate, file and line it is at.
 *   - Linux AppImage: a pointer to LINUX-APPIMAGE-LIBRARIES.txt, which
 *     appimage-libraries.mjs writes for each release.
 *
 * Run `npm ci` and `cargo fetch --locked` first, with cargo-about 0.9.3 on
 * PATH. cargo runs with --frozen, so it neither goes online nor changes
 * Cargo.lock. Installing cargo-about with cargo needs its `cli` feature:
 * `cargo install cargo-about --locked --version 0.9.3 --features cli`.
 *
 * It fails closed: a production npm package without a licence file stops the
 * run unless NO_LICENCE_FILE lists it, and so does a copyright holder that
 * the package's own file doesn't name, a SHIPPED_BUILD_PACKAGES entry
 * missing from the lock, a missing whisper.cpp licence or a failed cargo
 * command.
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
/**
 * The same, below a package's top folder, where it may also follow a dot, as
 * in bundlers' extracted comments (uuidv7.js.LICENSE.txt). The word must end
 * there, so a data file such as licenses.json doesn't count.
 */
const NESTED_PACKAGE_FILE = /(^|\.)(licen[cs]e|copying|notice)([._-]|$)/i;
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
 * npm packages published without a licence file, each with the `licence` its
 * package.json declares. The notices give that licence's standard text for
 * them. A `holder` goes into the text's copyright line only when the
 * package's own file `source` names it, which the run checks. Any other
 * package without a licence file stops the run, so that a new one is looked
 * at before it ships.
 */
export const NO_LICENCE_FILE = Object.freeze({
  // From the posthog-js repository (packages/browser-common). Its files name
  // no copyright holder, and the LICENSE that posthog-js and @posthog/core
  // ship puts the repository under the Apache License and gives the MIT
  // licence, with its holder, to packages/core only: the standard text stays
  // as it is.
  "@posthog/browser-common": { licence: "MIT" },
  // Both from the remark-math repository, whose licence file isn't published
  // with them. Each one's readme.md ends "[MIT][license] © [Junyoung Choi]".
  "rehype-katex": { licence: "MIT", holder: "Junyoung Choi", source: "readme.md" },
  "remark-math": { licence: "MIT", holder: "Junyoung Choi", source: "readme.md" },
});

/** The copyright line of a standard text, which a NO_LICENCE_FILE holder fills in. */
const HOLDER_PLACEHOLDER = /^Copyright \(c\) <year> <copyright holders>$/m;

/**
 * Dev dependencies whose output ships in Fleetify's user interface, so their
 * licences go in the notices like the production packages'. Each is checked
 * against a built dist/:
 *   - tailwindcss: the generated CSS carries Tailwind's own CSS, under its
 *     "tailwindcss v… | MIT License" banner;
 *   - vite: the entry chunk carries Vite's module-preload polyfill, and the
 *     chunks that load others its preload helper (__vite__mapDeps).
 * The shadcn CLI is not here: none of the components it generated reaches the
 * bundle.
 */
export const SHIPPED_BUILD_PACKAGES = Object.freeze(["tailwindcss", "vite"]);

/**
 * Notices of code vendored into npm packages that survive only as a comment
 * in a source file the package installs, with no licence file of their own.
 * Each entry names the package, the file, and the text of the header's first
 * and last lines (`from`, `to`). The run copies the lines from `from` to `to`
 * verbatim from the installed file, and fails when the file or either line is
 * gone, so a new version can't drop a notice unseen. Add only entries checked
 * against the installed package.
 */
export const VENDORED_HEADER_NOTICES = Object.freeze([
  // @posthog/core's stack parsers, forked from TraceKit (MIT) by way of
  // Sentry's JavaScript SDK (MIT). The Sentry line also heads chunk-ids.ts,
  // types.ts and utils.ts in src/error-tracking/; only this file carries the
  // TraceKit notice. The built dist/ drops the comment.
  Object.freeze({
    package: "@posthog/core",
    file: "src/error-tracking/parsers/index.ts",
    from: "// Portions of this file are derived from getsentry/sentry-javascript",
    to: "// OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.",
  }),
]);

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
 * Symlinks are not followed, and neither are folders whose name `enter`
 * turns down.
 */
function walk(dir, prefix = "", enter = () => true) {
  const found = [];
  for (const name of readdirSync(dir)) {
    const stats = lstatSync(join(dir, name));
    const rel = prefix ? `${prefix}/${name}` : name;
    if (stats.isDirectory()) {
      if (enter(name)) found.push(...walk(join(dir, name), rel, enter));
    } else if (stats.isFile()) {
      found.push(rel);
    }
  }
  return found;
}

/**
 * A `readPackageFiles` for npmProductionPackages: the licence and NOTICE
 * files of the package at `path` (a package-lock "packages" key) under
 * `root`. Those at its top come first, as `{ file, text }`; then those at any
 * depth below it (NESTED_PACKAGE_FILE), as `{ file, text, nested: true }`
 * with `file` relative to the package. Nested node_modules folders are
 * skipped: the packages in them are listed in their own right. Throws when
 * the package isn't there.
 *
 * @param {string} root
 * @returns {(path: string) => Array<{ file: string, text: string, nested?: true }>}
 */
export function packageFileReader(root) {
  return (path) => {
    const dir = join(root, path);
    if (!existsSync(dir)) throw new Error(`${path} is not installed: run npm ci first`);
    const top = readdirSync(dir).filter((name) => PACKAGE_FILE.test(name) && isFile(join(dir, name)));
    const nested = walk(dir, "", (name) => name !== "node_modules").filter(
      (file) => file.includes("/") && NESTED_PACKAGE_FILE.test(posix.basename(file)),
    );
    return [...readAll(dir, top), ...readAll(dir, nested).map((f) => ({ ...f, nested: true }))];
  };
}

/**
 * A `readPackageText` for npmProductionPackages and npmBuildPackages: the
 * text of `file` in the package at `path` under `root`.
 *
 * @param {string} root
 * @returns {(path: string, file: string) => string}
 */
export function packageTextReader(root) {
  return (path, file) => readFileSync(join(root, path, file), "utf8");
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
 * @typedef {{ name: string, version: string, license: string, build: boolean,
 *             standard: boolean, holder: string | null, holderSource: string | null,
 *             texts: Array<{ file: string | null, text: string, nested?: true,
 *                            lines?: { first: number, last: number } }> }} NpmPackage
 */

/**
 * The npm packages that ship: package-lock.json's "packages" without the
 * root, workspace packages and links, dev-only packages, and optional
 * packages tied to an OS or CPU (native builds for other platforms). Each
 * name and version comes once, sorted, with its licence and NOTICE files from
 * `readPackageFiles(path)`: the top-level ones, then the nested ones other
 * than copies of a top-level one, then the package's `vendoredHeaders`
 * (VENDORED_HEADER_NOTICES), read with `readPackageText`.
 *
 * A package without a top-level licence file throws, unless `noLicenceFile`
 * lists it with the licence it declares: it then gets that licence's standard
 * text (`file: null`, first) and `standard: true`. A listed `holder` fills in
 * the text's copyright line once `readPackageText(path, source)` shows that
 * the package's own file names it; otherwise that throws too.
 *
 * @param {{ packages?: Record<string, any> }} lock
 * @param {(path: string) => Array<{ file: string, text: string, nested?: true }>} readPackageFiles
 * @param {{ noLicenceFile?: Record<string, { licence: string, holder?: string, source?: string }>,
 *           readPackageText?: (path: string, file: string) => string,
 *           vendoredHeaders?: ReadonlyArray<{ package: string, file: string, from: string, to: string }> }} [options]
 * @returns {NpmPackage[]}
 */
export function npmProductionPackages(
  lock,
  readPackageFiles,
  { noLicenceFile = NO_LICENCE_FILE, readPackageText, vendoredHeaders = VENDORED_HEADER_NOTICES } = {},
) {
  const options = { readPackageFiles, noLicenceFile, readPackageText, vendoredHeaders };
  const packages = new Map();
  for (const path of Object.keys(lock.packages ?? {}).sort(compare)) {
    const entry = lock.packages[path];
    if (!path.includes(MODULES) || entry.link || entry.dev) continue;
    if ((entry.optional || entry.devOptional) && (entry.os || entry.cpu || entry.libc)) continue;

    const name = entry.name ?? path.slice(path.lastIndexOf(MODULES) + MODULES.length);
    const key = `${name}@${entry.version}`;
    if (packages.has(key)) continue;
    packages.set(key, describePackage(name, entry, path, options));
  }
  return [...packages.values()].sort(byNameAndVersion);
}

/**
 * The dev dependencies named in `names` (SHIPPED_BUILD_PACKAGES), whose
 * output ships in the bundle, as npmProductionPackages describes packages,
 * with `build: true`. Each must be at node_modules/<name> in the lock, or this
 * throws. One that is a production dependency there is left out, because
 * npmProductionPackages lists it already.
 *
 * @param {{ packages?: Record<string, any> }} lock
 * @param {(path: string) => Array<{ file: string, text: string }>} readPackageFiles
 * @param {{ names?: readonly string[],
 *           noLicenceFile?: Record<string, { licence: string, holder?: string, source?: string }>,
 *           readPackageText?: (path: string, file: string) => string }} [options]
 * @returns {NpmPackage[]}
 */
export function npmBuildPackages(
  lock,
  readPackageFiles,
  {
    names = SHIPPED_BUILD_PACKAGES,
    noLicenceFile = NO_LICENCE_FILE,
    readPackageText,
    vendoredHeaders = VENDORED_HEADER_NOTICES,
  } = {},
) {
  const options = { readPackageFiles, noLicenceFile, readPackageText, vendoredHeaders };
  const packages = [];
  for (const name of names) {
    const path = `${MODULES}${name}`;
    const entry = lock.packages?.[path];
    if (!entry) throw new Error(`${name} is a shipped build package, but package-lock.json has no ${path}`);
    if (!entry.dev) continue;
    packages.push({ ...describePackage(name, entry, path, options), build: true });
  }
  return packages.sort(byNameAndVersion);
}

/**
 * One package for the notices, from its lock entry and its files: its
 * top-level licence and NOTICE files; its nested ones, less any copy of a
 * top-level file; and its VENDORED_HEADER_NOTICES headers, as
 * `{ file, text, nested: true, lines: { first, last } }`.
 */
function describePackage(name, entry, path, { readPackageFiles, noLicenceFile, readPackageText, vendoredHeaders }) {
  const { version } = entry;
  const license = typeof entry.license === "string" ? entry.license : "not declared";
  const files = readPackageFiles(path);
  const top = files.filter((f) => !f.nested);
  const nested = files.filter((f) => f.nested && !top.some((t) => t.text === f.text));
  const headers = vendoredHeaders
    .filter((notice) => notice.package === name)
    .map((notice) => vendoredHeader({ name, version, path }, notice, readPackageText));
  const texts = [...top, ...[...nested, ...headers].sort((a, b) => compare(a.file, b.file))];
  const standard = !top.some(({ file }) => LICENCE_FILE.test(file));
  let holder = null;
  let holderSource = null;
  if (standard) {
    const fallback = standardText({ name, version, path, license }, noLicenceFile, readPackageText);
    texts.unshift({ file: null, text: fallback.text });
    ({ holder, source: holderSource } = fallback);
  }
  return { name, version, license, build: false, standard, holder, holderSource, texts };
}

/**
 * A VENDORED_HEADER_NOTICES header, copied verbatim from the installed file:
 * the lines from the first one holding `from` to the next one holding `to`.
 * Throws when the file or either line is missing.
 */
function vendoredHeader({ name, version, path }, { file, from, to }, readPackageText) {
  if (!readPackageText) throw new Error(`${name} ${version}: there is no way to read ${file} for its vendored notice`);
  let source;
  try {
    source = readPackageText(path, file);
  } catch (err) {
    throw new Error(`${name} ${version}: can't read ${file}, where VENDORED_HEADER_NOTICES expects a notice (${err.code ?? err.message})`);
  }
  const lines = source.split("\n");
  const first = lines.findIndex((line) => line.includes(from));
  if (first < 0) throw new Error(`${name} ${version}: ${file} has no line with ${JSON.stringify(from)}`);
  const length = lines.slice(first).findIndex((line) => line.includes(to));
  if (length < 0) {
    throw new Error(`${name} ${version}: ${file} has no line with ${JSON.stringify(to)} after line ${first + 1}`);
  }
  const last = first + length;
  return { file, text: lines.slice(first, last + 1).join("\n"), nested: true, lines: { first: first + 1, last: last + 1 } };
}

/**
 * Throws when a VENDORED_HEADER_NOTICES entry names a package that isn't among
 * the shipped `packages`: its notice would be dropped without a word, or the
 * entry is stale.
 *
 * @param {NpmPackage[]} packages
 * @param {ReadonlyArray<{ package: string }>} [list]
 */
export function checkVendoredHeaders(packages, list = VENDORED_HEADER_NOTICES) {
  const shipped = new Set(packages.map((pkg) => pkg.name));
  const unused = list.filter((notice) => !shipped.has(notice.package)).map((notice) => notice.package);
  if (unused.length > 0) {
    throw new Error(`VENDORED_HEADER_NOTICES lists ${unused.join(", ")}, which no longer ships: remove or fix the entry`);
  }
}

/**
 * The standard licence text for a package without a licence file, with its
 * holder when NO_LICENCE_FILE gives one, or why there can be none.
 */
function standardText({ name, version, path, license }, noLicenceFile, readPackageText) {
  if (!Object.hasOwn(noLicenceFile, name)) {
    throw new Error(
      `${name} ${version} (${path}) has no licence file (LICENSE*, LICENCE* or COPYING*). ` +
        "Check its licence; if it is published without a licence file, add it to " +
        "NO_LICENCE_FILE in scripts/release/third-party-notices.mjs.",
    );
  }
  const { licence, holder = null, source = null } = noLicenceFile[name];
  if (licence !== license) {
    throw new Error(`${name} ${version} declares ${license}, but NO_LICENCE_FILE lists it as ${licence}`);
  }
  if (!Object.hasOwn(STANDARD_TEXTS, licence)) {
    throw new Error(`${name} ${version}: there is no standard text for ${licence} in STANDARD_TEXTS`);
  }
  const text = STANDARD_TEXTS[licence];
  if (holder === null) return { text, holder: null, source: null };

  if (!readPackageText || !source) {
    throw new Error(`${name} ${version}: NO_LICENCE_FILE names a copyright holder, but nothing can check it`);
  }
  let named;
  try {
    named = readPackageText(path, source);
  } catch (err) {
    throw new Error(`${name} ${version}: can't read ${source} to check its copyright holder (${err.code ?? err.message})`);
  }
  if (!named.includes(holder)) {
    throw new Error(`${name} ${version}: ${source} doesn't name ${holder}, the copyright holder NO_LICENCE_FILE gives`);
  }
  if (!HOLDER_PLACEHOLDER.test(text)) {
    throw new Error(`${name} ${version}: the standard text of ${licence} has no copyright line to fill in`);
  }
  return { text: text.replace(HOLDER_PLACEHOLDER, `Copyright (c) ${holder}`), holder, source };
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

/**
 * The source files sourceNotices reads, by extension, with their comment
 * style: "slash" for // and block comments (C, C++, Objective-C, GPU kernels,
 * preprocessed assembly), "semicolon" for nasm assembly, "hash" for build
 * scripts and perlasm, the Perl that generates ring's assembly.
 */
const COMMENT_STYLE = new Map([
  ...[
    ".c", ".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp", ".hxx", ".inl", ".cu", ".cuh", ".cl",
    ".comp", ".glsl", ".wgsl", ".tmpl", ".m", ".mm", ".metal", ".idl", ".S",
  ].map((extension) => [extension, "slash"]),
  [".asm", "semicolon"],
  ...[".cmake", ".txt", ".in", ".py", ".sh", ".pl"].map((extension) => [extension, "hash"]),
]);
/** Words that make a comment a licence notice. */
const NOTICE_MARKER =
  /copyright|spdx-license-identifier|licen[cs]ed under|mit licen[cs]e|apache licen[cs]e|bsd licen[cs]e|permission is hereby granted|redistribution and use|public domain/i;

/** The words of a text, lower-cased, without punctuation, comment marks or line breaks. */
const words = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * The comments in a source file's `text`: each run of consecutive comment
 * lines as `{ line, text }`, `line` counting from 1. In "slash" style a run is
 * // lines, or a whole block comment, blank lines included; in "hash" and
 * "semicolon" style it is # or ; lines. A blank line ends a //, # or ; run.
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
    } else if (style === "semicolon") {
      comment = line.startsWith(";");
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
 * The licence notices in a source tree beyond its own licences, `licences`
 * (one text or several). Each is verbatim, once, with every place it is at as
 * `{ path, line }` (path relative to `root`, with "/"), sorted:
 *   - with `licenceFiles`, a licence or notice file (VENDORED_LICENCE) other
 *     than <root>/LICENSE, whole;
 *   - in a source file (COMMENT_STYLE), a comment with a NOTICE_MARKER in it:
 *     a file header, or a line or two crediting borrowed code.
 * A notice whose words all appear, in order, in one of `licences` only
 * repeats it, and is left out.
 *
 * @param {string} root
 * @param {string | string[]} licences
 * @param {{ licenceFiles?: boolean }} [options]
 * @returns {Array<{ text: string, places: Array<{ path: string, line: number }> }>}
 */
export function sourceNotices(root, licences, { licenceFiles = true } = {}) {
  const own = [licences].flat().map(words);
  const notices = new Map();
  const add = (text, place) => {
    const notice = words(text);
    if (own.some((licence) => licence.includes(notice))) return;
    if (!notices.has(text)) notices.set(text, []);
    notices.get(text).push(place);
  };
  for (const path of walk(root)) {
    if (path === "LICENSE") continue;
    const name = posix.basename(path);
    if (VENDORED_LICENCE.test(name)) {
      if (licenceFiles) add(readFileSync(join(root, path), "utf8"), { path, line: 1 });
      continue;
    }
    const style = COMMENT_STYLE.get(posix.extname(name));
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
    crate: { name: crate.name, version: crate.version },
    licence: "MIT",
    file: "whisper.cpp/LICENSE",
    text,
    notices,
  };
}

/** Build tools whose use in a crate's build script means it compiles C, C++ or assembly. */
const NATIVE_BUILDERS = new Set(["cc", "cmake"]);
/** Where SQLite's public-domain dedication is explained. */
const SQLITE_COPYRIGHT = "https://www.sqlite.org/copyright.html";

/**
 * The C, C++ and assembly source that release crates compile in, beyond
 * whisper.cpp: one entry per crate that cargo-about lists (minus `exclude`)
 * and whose resolved build dependencies, in `metadata.resolve`, include cc or
 * cmake. Each entry's `notices` are the licence notices in the crate's
 * sources (sourceNotices, without licence files, which the Rust section
 * covers), leaving out those that only repeat the crate's own licence texts
 * in cargo-about's output. Sorted by crate.
 *   - whisper-rs-sys is left out: whisperCppLicence covers its source.
 *   - libsqlite3-sys bundles SQLite, which is in the public domain: its
 *     source carries a blessing in place of a licence, so the entry names
 *     SQLite and its version (from sqlite3/sqlite3.h) and `publicDomain`
 *     links the dedication, instead of a scan.
 *
 * @param {{ licenses?: Array<any> }} about
 * @param {{ packages?: Array<any>, resolve?: { nodes: Array<any> } | null }} metadata
 * @param {{ exclude?: Set<string>, crateDirs?: Map<string, string> }} [options]
 */
export function compiledSources(about, metadata, { exclude = new Set(), crateDirs = new Map() } = {}) {
  const packages = new Map((metadata.packages ?? []).map((p) => [p.id, p]));
  const release = new Map();
  for (const licence of about.licenses ?? []) {
    for (const { crate } of licence.used_by) {
      if (exclude.has(crate.id)) continue;
      if (!release.has(crate.id)) release.set(crate.id, { crate, texts: [] });
      release.get(crate.id).texts.push(licence.text);
    }
  }
  const sources = [];
  for (const node of metadata.resolve?.nodes ?? []) {
    if (!release.has(node.id)) continue;
    const native = node.deps.some(
      (dep) => NATIVE_BUILDERS.has(packages.get(dep.pkg)?.name) && dep.dep_kinds.some((kind) => kind.kind === "build"),
    );
    if (!native) continue;
    const { crate, texts } = release.get(node.id);
    if (crate.name === "whisper-rs-sys") continue;
    const dir = crateDirs.get(crate.id);
    if (!dir) throw new Error(`${label(crate)} (${crate.id}) is not in cargo metadata, so its folder is unknown`);
    const id = { name: crate.name, version: crate.version };
    if (crate.name === "libsqlite3-sys") {
      sources.push({ name: sqliteName(dir), crate: id, publicDomain: SQLITE_COPYRIGHT, notices: [] });
    } else {
      sources.push({ name: crate.name, crate: id, publicDomain: null, notices: sourceNotices(dir, texts, { licenceFiles: false }) });
    }
  }
  return sources.sort((a, b) => byNameAndVersion(a.crate, b.crate));
}

/** "SQLite <version>", the version from the bundled sqlite3.h, or "SQLite" when it can't be read. */
function sqliteName(dir) {
  try {
    const header = readFileSync(join(dir, "sqlite3", "sqlite3.h"), "utf8");
    const version = header.match(/^#define SQLITE_VERSION\s+"([^"]+)"/m);
    return version ? `SQLite ${version[1]}` : "SQLite";
  } catch {
    return "SQLite";
  }
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
  "the crate, file and line they are at. Notices that only repeat its licence are",
  "left out.",
];
const NO_SOURCE_NOTICES = "Its sources carry no other licence notice.";
const NPM_INTRO = [
  "The npm packages built into Fleetify's user interface, each with the licence",
  "and NOTICE files it is published with, and the build-time packages whose",
  "output ships in it.",
];
const BUILD_NOTE = "A build-time package: its output ships in Fleetify's user interface.";
const NPM_STANDARD_NOTE = [
  "Published without a licence file, and its files name no copyright holder: this",
  "is the standard text of the licence its package.json declares.",
];
/** The note for a standard text whose copyright holder `source`, a file of the package, names. */
const npmHolderNote = (source) => [
  "Published without a licence file: this is the standard text of the licence its",
  `package.json declares, with the copyright holder its ${source} names.`,
];
const BUNDLED_INTRO = ["C, C++ and assembly source that Rust crates compile into Fleetify:"];
const APPIMAGE = [
  "The Linux AppImage also bundles system libraries, which each release lists,",
  "with their copyright files and source links, in LINUX-APPIMAGE-LIBRARIES.txt.",
];

/** A text that comes out verbatim once the lines are joined with "\n", which puts its final newline back. */
const verbatim = (text) => (text.endsWith("\n") ? text.slice(0, -1) : text);
const indented = (crates) => crates.map((crate) => `    ${label(crate)}`);
const heading = (out, title, intro) => out.push("", "", RULE, title, RULE, "", ...intro);
/** A bundled source's heading: the crate, or what it bundles and the crate it comes from. */
const sourceTitle = (source) =>
  source.name === source.crate.name ? label(source.crate) : `${source.name}, from ${label(source.crate)}`;

/**
 * An npm package's texts in the order they print, each with the lines that
 * label it: the standard text first, then its top-level files, then the
 * nested files and vendored headers by path. A nested file is labelled
 * `[<package>/<path>]`, and nested files with the same text share one copy
 * of it; a header is labelled with the lines it came from.
 */
function packageTexts(pkg) {
  const rank = (t) => (t.file === null ? 0 : t.nested ? 2 : 1);
  const texts = [...pkg.texts].sort((a, b) => rank(a) - rank(b) || compare(a.file ?? "", b.file ?? ""));
  const printed = [];
  const shared = new Map();
  for (const t of texts) {
    if (t.file === null) {
      printed.push({ labels: pkg.holder ? npmHolderNote(pkg.holderSource) : NPM_STANDARD_NOTE, text: t.text });
    } else if (!t.nested) {
      printed.push({ labels: [`[${t.file}]`], text: t.text });
    } else if (t.lines) {
      printed.push({ labels: [`[${pkg.name}/${t.file}:${t.lines.first}-${t.lines.last}]`], text: t.text });
    } else if (shared.has(t.text)) {
      shared.get(t.text).labels.push(`[${pkg.name}/${t.file}]`);
    } else {
      const entry = { labels: [`[${pkg.name}/${t.file}]`], text: t.text };
      shared.set(t.text, entry);
      printed.push(entry);
    }
  }
  return printed;
}

/**
 * THIRD-PARTY-NOTICES as text. Deterministic: everything is sorted here,
 * whatever order the input comes in, and nothing depends on the time or the
 * machine. Licence texts go in verbatim.
 *
 * @param {{ version: string, rust: ReturnType<typeof rustLicences>, npm: NpmPackage[],
 *           bundled: Array<ReturnType<typeof whisperCppLicence> | ReturnType<typeof compiledSources>[number]> }} input
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
    out.push("", LINE, label(pkg), `Licence: ${pkg.license}`, ...(pkg.build ? [BUILD_NOTE] : []));
    for (const { labels, text } of packageTexts(pkg)) out.push("", ...labels, "", verbatim(text));
  }

  const sources = [...bundled].map((source) => ({ ...source, title: sourceTitle(source) }));
  sources.sort((a, b) => compare(a.title, b.title));
  heading(out, "Bundled C/C++ source", [...BUNDLED_INTRO, ...sources.map((source) => `    ${source.title}`)]);
  for (const source of sources) {
    out.push("", LINE, source.title);
    if (source.text) {
      out.push(`Licence: ${source.licence}`, "", `[${source.file}]`, "", verbatim(source.text));
    } else if (source.publicDomain) {
      out.push(`Licence: public domain, ${source.publicDomain}`);
    } else {
      out.push('Licence: under "Rust crates" above');
    }
    const notices = (source.notices ?? [])
      .map((notice) => ({ ...notice, places: [...notice.places].sort(comparePlaces) }))
      .sort(compareNotices);
    if (notices.length > 0) {
      out.push("", ...SOURCE_NOTICES_NOTE);
    } else if (!source.text && !source.publicDomain) {
      out.push(NO_SOURCE_NOTICES);
    }
    for (const notice of notices) {
      const places = notice.places.map((p) => `    ${label(source.crate)} ${p.path}:${p.line}`);
      out.push("", "Notice in:", ...places, "", verbatim(notice.text));
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

    const exclude = new Set(metadata.workspace_members);
    const crateDirs = crateDirectories(metadata);
    const rust = rustLicences(about, { exclude, crateDirs });
    const packageOptions = { readPackageText: packageTextReader(ROOT) };
    const production = npmProductionPackages(lock, packageFileReader(ROOT), packageOptions);
    const build = npmBuildPackages(lock, packageFileReader(ROOT), packageOptions);
    const npm = [...production, ...build];
    checkVendoredHeaders(npm);
    const bundled = [whisperCppLicence(metadata), ...compiledSources(about, metadata, { exclude, crateDirs })];
    writeFileSync(args.out, renderNotices({ version, rust, npm, bundled }));

    const crates = new Set(rust.flatMap((licence) => licence.crates.map(label))).size;
    const crateFileCount = rust.reduce((n, licence) => n + licence.files.length, 0);
    const nested = npm.flatMap((pkg) => pkg.texts.filter((t) => t.nested && !t.lines).map(() => pkg));
    const headers = npm.flatMap((pkg) => pkg.texts.filter((t) => t.lines));
    const sources = bundled.map((source) => `${label(source.crate)} (${source.notices.length} notices)`);
    process.stderr.write(
      `third-party-notices: wrote ${args.out}: ${crates} Rust crates under ${rust.length} licence texts ` +
        `with ${crateFileCount} files from their folders; ${production.length} npm packages and ` +
        `${build.length} build-time ones (${build.map(label).join(", ")}), with ${nested.length} nested ` +
        `licence files from ${new Set(nested.map(label)).size} packages and ${headers.length} vendored ` +
        `headers; bundled source from ${sources.join(", ")}\n`,
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
