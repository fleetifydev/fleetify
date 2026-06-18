import { describe, it, expect } from "vitest";
import { parseChangelog } from "../changelog";
import { normalizeVersion, semverEq } from "../semver";

const SAMPLE = `# Changelog

All notable changes to this plugin are documented in this file.
Format: [Keep a Changelog](https://keepachangelog.com/). Versioning: [SemVer](https://semver.org/).

## [0.2.0] - 2026-06-18

### Added
- Per-plugin auto-update toggle.
- Secrets editor.

### Fixed
- Crash on empty manifest.

## [0.1.0] - 2026-06-17

### Added
- Initial release.
`;

describe("parseChangelog", () => {
  it("discards the boilerplate intro before the first version heading", () => {
    const { entries } = parseChangelog(SAMPLE);
    expect(entries).toHaveLength(2);
    const flat = JSON.stringify(entries);
    expect(flat).not.toContain("All notable changes");
    expect(flat).not.toContain("Keep a Changelog");
  });

  it("parses version, date and categorized sections", () => {
    const { entries } = parseChangelog(SAMPLE);
    const v020 = entries[0];
    expect(v020.version).toBe("0.2.0");
    expect(v020.date).toBe("2026-06-18");
    expect(v020.sections.map(s => s.kind)).toEqual(["Added", "Fixed"]);
    expect(v020.sections[0].items).toEqual([
      "Per-plugin auto-update toggle.",
      "Secrets editor.",
    ]);
    expect(v020.sections[1].items).toEqual(["Crash on empty manifest."]);
  });

  it("preserves document order (newest first as authored)", () => {
    const { entries } = parseChangelog(SAMPLE);
    expect(entries.map(e => e.version)).toEqual(["0.2.0", "0.1.0"]);
  });

  it("handles a version heading with no date", () => {
    const { entries } = parseChangelog(`## [1.2.3]\n\n### Added\n- x\n`);
    expect(entries).toHaveLength(1);
    expect(entries[0].version).toBe("1.2.3");
    expect(entries[0].date).toBeNull();
  });

  it("handles a heading without brackets", () => {
    const { entries } = parseChangelog(`## 1.2.3 - 2026-06-17\n\n### Fixed\n- y\n`);
    expect(entries[0].version).toBe("1.2.3");
    expect(entries[0].date).toBe("2026-06-17");
    expect(entries[0].sections[0].kind).toBe("Fixed");
  });

  it("maps an unknown category to Other but keeps its label", () => {
    const { entries } = parseChangelog(`## [0.1.0] - 2026-06-17\n\n### Notes\n- hello\n`);
    const sec = entries[0].sections[0];
    expect(sec.kind).toBe("Other");
    expect(sec.label).toBe("Notes");
    expect(sec.items).toEqual(["hello"]);
  });

  it("keeps inline markdown inside bullet items", () => {
    const md = `## [0.1.0] - 2026-06-17\n\n### Added\n- Support [links](https://x.io) and \`code\`.\n`;
    const { entries } = parseChangelog(md);
    expect(entries[0].sections[0].items[0]).toBe("Support [links](https://x.io) and `code`.");
  });

  it("accepts '*' bullets as well as '-'", () => {
    const { entries } = parseChangelog(`## [0.1.0] - 2026-06-17\n\n### Added\n* star bullet\n`);
    expect(entries[0].sections[0].items).toEqual(["star bullet"]);
  });

  it("captures uncategorized bullets under a version into an Other section", () => {
    const { entries } = parseChangelog(`## [0.1.0] - 2026-06-17\n\n- bare bullet\n`);
    expect(entries[0].sections).toHaveLength(1);
    expect(entries[0].sections[0].kind).toBe("Other");
    expect(entries[0].sections[0].label).toBe("");
    expect(entries[0].sections[0].items).toEqual(["bare bullet"]);
  });

  it("supports an Unreleased section", () => {
    const { entries } = parseChangelog(`## [Unreleased]\n\n### Changed\n- wip\n`);
    expect(entries[0].version).toBe("Unreleased");
    expect(entries[0].date).toBeNull();
  });

  it("returns no entries for null, empty, or prose-only input (fallback signal)", () => {
    expect(parseChangelog(null).entries).toEqual([]);
    expect(parseChangelog("").entries).toEqual([]);
    expect(parseChangelog("Just some prose, no version headings.").entries).toEqual([]);
  });
});

describe("normalizeVersion / semverEq", () => {
  it("normalizeVersion strips a leading v, brackets and whitespace", () => {
    expect(normalizeVersion(" v0.1.0 ")).toBe("0.1.0");
    expect(normalizeVersion("[1.2.3]")).toBe("1.2.3");
  });
  it("semverEq matches regardless of v-prefix, false for empties", () => {
    expect(semverEq("v0.1.0", "0.1.0")).toBe(true);
    expect(semverEq("0.1.0", "0.2.0")).toBe(false);
    expect(semverEq("", "")).toBe(false);
  });
});
