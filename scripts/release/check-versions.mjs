#!/usr/bin/env node
/**
 * check-versions.mjs — check that every file holding Fleetify's version holds
 * the same one.
 *
 *   node scripts/release/check-versions.mjs [--root <dir>]
 *
 * release-please's release pull request bumps the version in each of these
 * together (release-please-config.json):
 *   - package.json, and package-lock.json's version and packages[""].version,
 *     as its node release type does;
 *   - Cargo.toml's [workspace.package] version, which each crate takes;
 *   - src-tauri/tauri.conf.json's version;
 *   - Cargo.lock's entry for each workspace crate;
 *   - .release-please-manifest.json, where release-please keeps the version
 *     it last released.
 * With the workspace's eight crates, that makes 14 sources. The check catches
 * a version changed by hand in one place, a workspace crate that Cargo.lock
 * lacks, and a crate with a version of its own, which release-please would
 * leave behind.
 *
 * Cargo.lock's [[package]] entries are matched by name alone, as
 * release-please's jsonpath ($.package[?(@.name.value==='<crate>')]) matches
 * them, so a crates.io crate named like a workspace crate is a source of its
 * own: release-please would bump it too.
 *
 * TOML is read here without a dependency, as far as these files use it:
 * tables, arrays of tables, comments, and key = value lines whose values are
 * strings (multi-line ones too), arrays or inline tables.
 *
 * --root reads the tree at <dir> instead of this repository.
 *
 * Exit codes: 0 they agree, printing "versions: all <v> (<n> sources)"; 1 they
 * don't, listing "<source>: <version>" for each source that differs from the
 * version most sources hold ("missing" for one that holds none), or a file
 * can't be read; 2 usage.
 */
import { readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../../", import.meta.url));

const USAGE = "usage: node scripts/release/check-versions.mjs [--root <dir>]";

// ── TOML, as far as these files use it ─────────────────────────────────────

/**
 * A TOML document cut into its logical lines: comments dropped, blank lines
 * left out, and a value that spans lines (an array, or a multi-line string)
 * joined onto its key's line. Throws on a string that is never closed.
 */
function logicalLines(text) {
  const lines = [];
  let line = "";
  let depth = 0; // brackets and braces open outside strings
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const delimiter = text.slice(i, i + 3);
    if (delimiter === '"""' || delimiter === "'''") {
      let end = text.indexOf(delimiter, i + 3);
      if (end === -1) throw new Error("a multi-line string is never closed");
      // The closing delimiter may come after up to two quotes of the string's own.
      for (let extra = 0; extra < 2 && text[end + 3] === ch; extra += 1) end += 1;
      line += text.slice(i, end + 3);
      i = end + 2;
    } else if (ch === '"' || ch === "'") {
      let end = i + 1;
      while (end < text.length && text[end] !== ch && text[end] !== "\n") end += ch === '"' && text[end] === "\\" ? 2 : 1;
      if (text[end] !== ch) throw new Error(`a string is never closed: ${text.slice(i, end).trim()}`);
      line += text.slice(i, end + 1);
      i = end;
    } else if (ch === "#") {
      while (i + 1 < text.length && text[i + 1] !== "\n") i += 1;
    } else if (ch === "\n" && depth <= 0) {
      if (line.trim() !== "") lines.push(line.trim());
      line = "";
      depth = 0;
    } else {
      if (ch === "[" || ch === "{") depth += 1;
      if (ch === "]" || ch === "}") depth -= 1;
      line += ch === "\n" ? " " : ch;
    }
  }
  if (line.trim() !== "") lines.push(line.trim());
  return lines;
}

/** `text` with each string in it blanked out, so its structure can be searched. */
const withoutStrings = (text) =>
  text.replace(/"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:[^"\\\n]|\\.)*"|'[^'\n]*'/g, (string) => "_".repeat(string.length));

/** A dotted key or a table's name, without the spaces around its dots or the quotes of a quoted part. */
const keyOf = (text) =>
  text
    .split(".")
    .map((part) => part.trim().replace(/^"([^"\\]*)"$|^'([^']*)'$/, "$1$2"))
    .join(".");

/**
 * The tables of a TOML document, in order: the top level (name ""), then each
 * [table] and each entry of an [[array of tables]], with its name and the raw
 * text of each key's value.
 */
function tomlTables(text) {
  const tables = [{ name: "", values: new Map() }];
  for (const line of logicalLines(text)) {
    const header = line.match(/^\[\[(.*)\]\]$/s) ?? line.match(/^\[(.*)\]$/s);
    if (header) {
      tables.push({ name: keyOf(header[1]), values: new Map() });
      continue;
    }
    const equals = withoutStrings(line).indexOf("=");
    if (equals < 1) throw new Error(`can't read this line as TOML: ${line}`);
    tables.at(-1).values.set(keyOf(line.slice(0, equals)), line.slice(equals + 1).trim());
  }
  return tables;
}

/** The tables of the TOML file `rel`, whose text is `text`; an error names the file. */
function tomlFile(rel, text) {
  try {
    return tomlTables(text);
  } catch (err) {
    throw new Error(`${rel}: ${err.message}`);
  }
}

/** The first table named `name` in a TOML document, if it has one. */
const tableNamed = (tables, name) => tables.find((table) => table.name === name);

/** A TOML value's string, or undefined when the value isn't a one-line string. */
function tomlString(raw) {
  if (typeof raw !== "string") return undefined;
  const literal = raw.match(/^'([^'\n]*)'$/);
  if (literal) return literal[1];
  if (!/^"(?:[^"\\\n]|\\.)*"$/.test(raw)) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** A TOML array of strings, or undefined when the value is anything else. */
function tomlStrings(raw) {
  const inner = typeof raw === "string" ? raw.match(/^\[([\s\S]*)\]$/)?.[1] : undefined;
  if (inner === undefined) return undefined;
  const blanked = withoutStrings(inner);
  const items = [];
  let start = 0;
  for (let i = 0; i <= inner.length; i += 1) {
    if (i === inner.length || blanked[i] === ",") {
      items.push(inner.slice(start, i).trim());
      start = i + 1;
    }
  }
  if (items.at(-1) === "") items.pop(); // a trailing comma
  const strings = items.map(tomlString);
  return strings.every((item) => item !== undefined) ? strings : undefined;
}

// ── The sources ────────────────────────────────────────────────────────────

/**
 * The names of a Cargo workspace's crates, in the order of its members, each
 * from the crate's own Cargo.toml, which `readMemberManifest(folder)` returns.
 *
 * Throws when Cargo.toml lists no members; when a member is a glob, since
 * release-please-config.json names each crate; and when a crate has no name
 * or doesn't take the workspace's version (version.workspace = true), since
 * release-please bumps the workspace's version alone.
 */
export function workspaceMembers(cargoToml, readMemberManifest) {
  const members = tomlStrings(tableNamed(tomlFile("Cargo.toml", cargoToml), "workspace")?.values.get("members"));
  if (members === undefined) throw new Error("Cargo.toml has no [workspace] members list");
  return members.map((member) => {
    if (/[*?[\]{}]/.test(member)) {
      throw new Error(`Cargo.toml's workspace member "${member}" is a glob: list each crate's folder, as release-please-config.json names each crate`);
    }
    const rel = `${member}/Cargo.toml`;
    const values = tableNamed(tomlFile(rel, readMemberManifest(member)), "package")?.values;
    const name = tomlString(values?.get("name"));
    if (name === undefined) throw new Error(`${rel} has no [package] name`);
    const inherits =
      values.get("version.workspace") === "true" || /^\{\s*workspace\s*=\s*true\s*\}$/.test(values.get("version") ?? "");
    if (!inherits) {
      throw new Error(`${rel} must take the workspace's version (version.workspace = true), which is the one release-please bumps`);
    }
    return name;
  });
}

/**
 * Each source of the version, in order, with the version it holds (undefined
 * when it holds none): package.json; package-lock.json's version and
 * packages[""].version; Cargo.toml's [workspace.package] version;
 * src-tauri/tauri.conf.json; Cargo.lock's entry for each workspace crate; and
 * .release-please-manifest.json's ".".
 *
 * @param {string} root the folder of the tree to read
 * @returns {{ source: string, version: string | undefined }[]}
 * @throws {Error} naming a file that is missing or can't be parsed
 */
export function readVersions(root) {
  const text = (rel) => {
    try {
      return readFileSync(join(root, rel), "utf8");
    } catch (err) {
      throw new Error(`can't read ${rel}: ${err.code ?? err.message}`);
    }
  };
  const json = (rel) => {
    const source = text(rel);
    try {
      return JSON.parse(source);
    } catch (err) {
      throw new Error(`${rel} isn't valid JSON: ${err.message}`);
    }
  };
  const string = (value) => (typeof value === "string" ? value : undefined);

  const npm = json("package.json");
  const lock = json("package-lock.json");
  const cargoToml = text("Cargo.toml");
  const workspace = tableNamed(tomlFile("Cargo.toml", cargoToml), "workspace.package");
  const crates = workspaceMembers(cargoToml, (member) => text(`${member}/Cargo.toml`));
  const tauri = json("src-tauri/tauri.conf.json");
  const locked = tomlFile("Cargo.lock", text("Cargo.lock"))
    .filter(({ name }) => name === "package")
    .map(({ values }) => ({ name: tomlString(values.get("name")), version: tomlString(values.get("version")) }));
  const manifest = json(".release-please-manifest.json");

  return [
    { source: "package.json", version: string(npm?.version) },
    { source: "package-lock.json", version: string(lock?.version) },
    { source: 'package-lock.json packages[""]', version: string(lock?.packages?.[""]?.version) },
    { source: "Cargo.toml [workspace.package]", version: tomlString(workspace?.values.get("version")) },
    { source: "src-tauri/tauri.conf.json", version: string(tauri?.version) },
    ...crates.flatMap((crate) => {
      const source = `Cargo.lock ${crate}`;
      const entries = locked.filter(({ name }) => name === crate);
      return entries.length > 0 ? entries.map(({ version }) => ({ source, version })) : [{ source, version: undefined }];
    }),
    { source: '.release-please-manifest.json "."', version: string(manifest?.["."]) },
  ];
}

/**
 * "<source>: <version>" for each source that differs from the version most
 * sources hold, or that holds none ("missing"); empty when all agree. On a
 * tie, the version the earliest source holds is taken as the right one.
 *
 * @param {{ source: string, version: string | undefined }[]} entries
 * @returns {string[]}
 */
export function versionProblems(entries) {
  const counts = new Map();
  for (const { version } of entries) {
    if (typeof version === "string") counts.set(version, (counts.get(version) ?? 0) + 1);
  }
  let expected;
  for (const [version, count] of counts) {
    if (expected === undefined || count > counts.get(expected)) expected = version;
  }
  return entries
    .filter(({ version }) => typeof version !== "string" || version !== expected)
    .map(({ source, version }) => `${source}: ${typeof version === "string" ? version : "missing"}`);
}

function main(argv) {
  let root = REPO;
  if (argv.length > 0) {
    const [flag, dir, ...rest] = argv;
    if (flag !== "--root" || dir === undefined || dir === "" || dir.startsWith("-") || rest.length > 0) {
      process.stderr.write(`versions: unexpected arguments: ${argv.join(" ")}\n${USAGE}\n`);
      return 2;
    }
    root = resolve(dir);
  }
  let entries;
  try {
    entries = readVersions(root);
  } catch (err) {
    process.stderr.write(`versions: ${err.message}\n`);
    return 1;
  }
  const problems = versionProblems(entries);
  if (problems.length === 0) {
    process.stdout.write(`versions: all ${entries[0].version} (${entries.length} sources)\n`);
    return 0;
  }
  process.stderr.write(
    `versions: ${problems.length} of ${entries.length} sources disagree with the others:\n${problems.join("\n")}\n` +
      "release-please's release PR bumps them all together (release-please-config.json), so each must hold the same version.\n",
  );
  return 1;
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
