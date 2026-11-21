/**
 * Checks for the release configuration.
 *
 *   node --test scripts/release/release-config.test.mjs
 *
 * release-please bumps the version in src-tauri/tauri.conf.json and writes
 * the file back through JSON.stringify. Kept in JSON.stringify(…, null, 2)
 * form with a final newline, the file then changes only in its version line
 * in each release PR, rather than being reformatted.
 *
 * No Tauri config in src-tauri may set a dangerous* key, such as the
 * updater's dangerousInsecureTransportProtocol. A release build merges
 * tauri.release.conf.json, and Tauri merges a platform's own config, into
 * tauri.conf.json, whose updater settings the shell's Rust tests check
 * (src-tauri/src/shell/updater.rs). Those overlays must leave the updater
 * alone, or a release would ship an updater the tests never saw.
 *
 * The Tauri CLI also reads a config in JSON5 (tauri.conf.json5) or TOML
 * (Tauri.toml), and their platform variants. The release config is JSON
 * alone, which these checks read, so neither kind may appear in src-tauri.
 *
 * release-please (release-please-config.json) makes one release of the whole
 * repository, tagged vX.Y.Z. Its release PR bumps the version in each file
 * check-versions.mjs reads: package.json and package-lock.json (the node
 * release type), and the extra files: the Cargo workspace's version,
 * tauri.conf.json's, and Cargo.lock's entry for each workspace crate. The
 * GitHub release starts as a draft, which has no tag until it is published,
 * after the release's checks pass; with force-tag-creation, the tag would
 * exist from the start, and a tag can't be moved or deleted.
 *
 * release-please reads a TOML file into values that carry their place in the
 * file ({ value, start, end }), and the jsonpath of an extra TOML file runs
 * over those, so a filter compares a value's .value: @.name.value === 'x'.
 * Compared with @.name, the filter matches nothing, and release-please leaves
 * the file as it was, with only a warning.
 *
 * release-as and bootstrap-sha serve the first release alone: release-as
 * makes it 0.2.0, and bootstrap-sha starts its changelog with the commits
 * after it, from pull request #2 on. The release PR's prep commit removes
 * both, so neither reaches main next to a released version.
 *
 * CHANGELOG.md is empty until the first release PR writes it: release-please
 * keeps whatever text it finds there below the first entry, so only an empty
 * file gives a changelog that holds the entry alone.
 *
 * Squash merging makes each pull request's title a commit on main, which
 * release-please files under its type's changelog section. The sections, and
 * which of them the changelog hides, are those of the prefix tables in
 * CONTRIBUTING.md and CLAUDE.md.
 *
 * macOS takes an update for the same app, keeping its microphone permission
 * and its keychain items, while the app's designated requirement stays the
 * same. The release identity's is pinned in macos-designated-requirement.txt,
 * which candidate and release builds compare the app's with: one line, as
 * codesign writes it for a self-signed certificate (macos-signature.mjs has
 * the rules), and of the shape the dry runs' identities get, which differ
 * only in the certificate's hash.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

import { workspaceMembers } from "./check-versions.mjs";
import { IDENTIFIER, drProblems, parseDesignatedRequirement } from "./macos-signature.mjs";

/** A repo file's text, by its path from the repo root. */
const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

/** The version of the first release, which release-as asks for. */
const FIRST_RELEASE = "0.2.0";

const releasePleaseConfig = () => JSON.parse(read("release-please-config.json"));
const releasePleaseManifest = () => JSON.parse(read(".release-please-manifest.json"));

/** The release-please config of the one package, the repository's root. */
function rootPackage(config) {
  assert.deepEqual(Object.keys(config.packages ?? {}), ["."], "release-please-config.json releases one package, the repository");
  return config.packages["."];
}

/** -1, 0 or 1 as MAJOR.MINOR.PATCH version `a` is below, at or above `b`. */
function compareVersions(a, b) {
  const [x, y] = [a, b].map((version) => version.split(".").map(Number));
  const i = x.findIndex((part, at) => part !== y[at]);
  return i === -1 ? 0 : Math.sign(x[i] - y[i]);
}

/**
 * The rows of the table in the section under a Markdown heading, as arrays of
 * cell texts: the header row first, without the separator row.
 */
function tableUnder(rel, heading) {
  const lines = read(rel).replace(/\r\n/g, "\n").split("\n");
  const start = lines.indexOf(heading);
  assert.ok(start !== -1, `${rel} has no "${heading}" heading`);
  const rows = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6} /.test(line)) break;
    if (line.startsWith("|")) rows.push(line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim()));
    else if (rows.length > 0) break;
  }
  assert.ok(rows.length > 2, `${rel} has no table under "${heading}"`);
  return rows.filter((cells) => !cells.every((cell) => /^:?-+:?$/.test(cell)));
}

/**
 * The changelog a prefix table describes: "type: section" for each type it
 * shows, in the table's order, and the types it hides. A row may name several
 * types, each in backquotes (`docs` or `docs:`, with an optional scope). The
 * row for a breaking change (`feat!:`) marks a type another row lists, so it
 * is left out.
 */
function changelogInTable(rel, heading, isHidden) {
  const [header, ...rows] = tableUnder(rel, heading);
  const column = header.findIndex((cell) => /^Changelog/.test(cell));
  assert.ok(column > 0, `${rel}'s table under "${heading}" has no Changelog column`);
  const shown = [];
  const hidden = [];
  for (const cells of rows) {
    const marks = [...cells[0].matchAll(/`([^`]+)`/g)].map(([, mark]) => mark);
    if (marks.some((mark) => /^[a-z]+(\([^)]*\))?!/.test(mark))) continue;
    const types = [...new Set(marks.map((mark) => mark.match(/^([a-z]+)(\([^)]*\))?:?$/)?.[1]))];
    assert.ok(types.length > 0 && types.every(Boolean), `${rel}: can't read the types in "${cells[0]}"`);
    if (isHidden(cells[column])) hidden.push(...types);
    else shown.push(...types.map((type) => `${type}: ${cells[column]}`));
  }
  return { shown, hidden: hidden.sort() };
}

describe("release config", () => {
  test("tauri.conf.json is formatted the way release-please writes it", () => {
    // A Windows checkout may turn LF into CRLF; the committed file is LF.
    const text = read("src-tauri/tauri.conf.json").replace(/\r\n/g, "\n");
    assert.equal(JSON.stringify(JSON.parse(text), null, 2) + "\n", text);
  });

  test("no Tauri config sets a dangerous* key, and no overlay changes the shipped updater settings", () => {
    const names = readdirSync(new URL("../../src-tauri/", import.meta.url))
      .filter((name) => /^tauri.*\.conf\.json$/.test(name))
      .sort();
    assert.ok(names.includes("tauri.conf.json") && names.includes("tauri.release.conf.json"), `src-tauri holds ${names.join(", ")}`);
    const problems = [];
    for (const name of names) {
      const config = JSON.parse(read(`src-tauri/${name}`));
      const walk = (value, path) => {
        if (value === null || typeof value !== "object") return;
        for (const [key, child] of Object.entries(value)) {
          // dangerousInsecureTransportProtocol and its kin, also in kebab case.
          if (/^dangerous/i.test(key)) problems.push(`${name} sets ${path}${key}`);
          walk(child, `${path}${key}.`);
        }
      };
      walk(config, "");
      if (name !== "tauri.conf.json" && config.plugins?.updater !== undefined) {
        problems.push(`${name} changes the shipped updater settings (plugins.updater)`);
      }
    }
    assert.deepEqual(problems, [], problems.join("\n"));
  });

  test("src-tauri holds no Tauri config in JSON5 or TOML, which the check above doesn't read", () => {
    const others = readdirSync(new URL("../../src-tauri/", import.meta.url))
      .filter((name) => /^tauri.*\.conf\.json5$/i.test(name) || /^tauri.*\.toml$/i.test(name))
      .sort();
    assert.deepEqual(others, [], `src-tauri holds ${others.join(", ")}`);
  });

  test("the pinned designated requirement is one line, of the shape codesign gives a self-signed identity, the dry runs' shape", () => {
    // A Windows checkout may turn LF into CRLF; the committed file is LF.
    const text = read("scripts/release/macos-designated-requirement.txt").replace(/\r\n/g, "\n");
    assert.match(text, /^[^\n]+\n$/, "macos-designated-requirement.txt must hold one line, ending in a newline");
    const pinned = text.slice(0, -1);
    const hash = /H"[0-9a-f]{40}"/;
    const identifier = IDENTIFIER.replaceAll(".", "\\.");
    assert.match(pinned, new RegExp(`^identifier "${identifier}" and certificate root = ${hash.source}$`), "without codesign's \"designated => \"");
    assert.deepEqual(drProblems(pinned), []);
    // Each Mac's dry run, as codesign printed it: a certificate of the same
    // shape, made for the run, so the same requirement with another hash.
    for (const triple of ["aarch64-apple-darwin", "x86_64-apple-darwin"]) {
      const captured = parseDesignatedRequirement(read(`scripts/release/fixtures/codesign/captured/${triple}/requirements.stdout.txt`));
      assert.equal(captured.replace(hash, 'H"…"'), pinned.replace(hash, 'H"…"'), `${triple}'s dry run`);
      assert.notEqual(captured.match(hash)[0], pinned.match(hash)[0], `${triple}'s dry run pins the release certificate`);
    }
  });
});

describe("release-please", () => {
  test("one release of the whole repository, tagged vX.Y.Z, its version bumped as the node type does", () => {
    const config = releasePleaseConfig();
    const root = rootPackage(config);
    // A package's own setting outranks the config's.
    const setting = (key) => (Object.hasOwn(root, key) ? root[key] : config[key]);
    assert.equal(setting("release-type"), "node");
    assert.equal(setting("include-component-in-tag"), false);
    assert.equal(setting("include-v-in-tag"), true);
    assert.equal(setting("bump-minor-pre-major"), true);
    assert.equal(setting("bump-patch-for-minor-pre-major"), false);
    assert.equal(setting("package-name"), "fleetify");
    assert.equal(setting("changelog-path"), "CHANGELOG.md");
    assert.deepEqual(Object.keys(releasePleaseManifest()), ["."], ".release-please-manifest.json holds the one package");
  });

  test("a release is a draft, without its tag until it is published", () => {
    const config = releasePleaseConfig();
    const root = rootPackage(config);
    assert.equal(config.draft, true, "draft");
    assert.ok(!Object.hasOwn(root, "draft") || root.draft === true, "the package's own draft setting");
    for (const [where, settings] of [["the config", config], ["the package", root]]) {
      assert.ok(
        settings["force-tag-creation"] === undefined || settings["force-tag-creation"] === false,
        `${where} sets force-tag-creation: a draft's tag would exist before its checks pass`,
      );
    }
  });

  test("until the first release, release-as makes it 0.2.0 and bootstrap-sha starts its changelog; after it, neither is left", () => {
    const config = releasePleaseConfig();
    const root = rootPackage(config);
    const current = releasePleaseManifest()["."];
    assert.match(String(current), /^\d+\.\d+\.\d+$/, ".release-please-manifest.json's version");
    assert.equal(config["release-as"], undefined, "release-as is the package's setting, not the whole config's");
    if (compareVersions(current, FIRST_RELEASE) < 0) {
      assert.equal(root["release-as"], FIRST_RELEASE, "release-as");
      assert.match(String(config["bootstrap-sha"]), /^[0-9a-f]{40}$/, "bootstrap-sha is a full commit id");
    } else {
      assert.equal(
        root["release-as"],
        undefined,
        `the manifest is at ${current}, so release-as must go: left in, it asks each later release PR for ${root["release-as"]} again`,
      );
      assert.equal(config["bootstrap-sha"], undefined, `the manifest is at ${current}, so bootstrap-sha must go`);
    }
  });

  // release-please (17.6.0) puts a release's entry above the newest entry's
  // heading, a line of "## " or "### " followed by "v", a digit or "[". When
  // the file has no such heading, it writes "# Changelog" and the entry, then
  // whatever the file held, with each "# " heading in it turned into "## ".
  // Any text in the file before the first release would stay below that
  // entry for good: "# Changelog" alone becomes a second, "## Changelog"
  // heading. From an empty file, the first release PR writes "# Changelog"
  // and the entry, and nothing else. CI can't run release-please, which the
  // repository doesn't depend on, so the test pins that starting point. After
  // the first release, the file starts with the heading and the entry for the
  // version the manifest names, as each release PR writes them.
  test("CHANGELOG.md is empty until the first release, then starts with the entry for the manifest's version", () => {
    const text = read("CHANGELOG.md").replace(/\r\n/g, "\n");
    const current = String(releasePleaseManifest()["."]);
    assert.match(current, /^\d+\.\d+\.\d+$/, ".release-please-manifest.json's version");
    if (compareVersions(current, FIRST_RELEASE) < 0) {
      assert.equal(text, "", "CHANGELOG.md must be empty until the first release PR writes it");
    } else {
      const version = current.replace(/\./g, "\\.");
      assert.match(
        text,
        new RegExp(`^# Changelog\\n\\n#{2,3} \\[?${version}\\]?[ (]`),
        `CHANGELOG.md must start with "# Changelog", then the entry for ${current}`,
      );
    }
  });

  test("the release PR bumps the Cargo workspace's version, tauri.conf.json's and Cargo.lock's entry for each workspace crate", () => {
    const root = rootPackage(releasePleaseConfig());
    const extra = root["extra-files"] ?? [];
    const crates = workspaceMembers(read("Cargo.toml"), (member) => read(`${member}/Cargo.toml`));
    const inLock = extra
      .filter((file) => file.path === "Cargo.lock")
      .map((file) => file.jsonpath?.match(/^\$\.package\[\?\(@\.name\.value==='([^']+)'\)\]\.version$/)?.[1] ?? file.jsonpath);
    assert.deepEqual([...inLock].sort(), [...crates].sort(), "Cargo.lock's extra files must name each workspace crate once");
    assert.deepEqual(extra, [
      { type: "toml", path: "Cargo.toml", jsonpath: "$.workspace.package.version" },
      { type: "json", path: "src-tauri/tauri.conf.json", jsonpath: "$.version" },
      ...crates.map((crate) => ({ type: "toml", path: "Cargo.lock", jsonpath: `$.package[?(@.name.value==='${crate}')].version` })),
    ]);
  });

  test("the changelog shows and hides the types the prefix tables of CONTRIBUTING.md and CLAUDE.md say it does", () => {
    const sections = releasePleaseConfig()["changelog-sections"] ?? [];
    const config = {
      shown: sections.filter((section) => !section.hidden).map(({ type, section }) => `${type}: ${section}`),
      hidden: sections.filter((section) => section.hidden).map(({ type }) => type).sort(),
    };
    assert.ok(config.shown.length > 0, "release-please-config.json's changelog shows no section");
    assert.deepEqual(changelogInTable("CONTRIBUTING.md", "### Titles", (cell) => cell === "not listed"), config, "CONTRIBUTING.md");
    assert.deepEqual(
      changelogInTable("CLAUDE.md", "### Prefix → version-bump + changelog effect", (cell) => /^hidden\b/.test(cell)),
      config,
      "CLAUDE.md",
    );
  });
});
