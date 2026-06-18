/** Parse a plugin CHANGELOG.md (Keep a Changelog format) into structured
 *  data for the marketplace detail page. Pure / I-O free.
 *
 *  Tolerant by design: the boilerplate `# Changelog` H1 + intro paragraphs
 *  before the first `## ` version heading are discarded; version headings
 *  may or may not carry brackets / a date; unknown `### X` categories fall
 *  back to "Other"; bullets with no `###` above them collect into an
 *  unlabeled "Other" section. A string with no `## ` version heading yields
 *  `{ entries: [] }` so the renderer can fall back to raw markdown. */
import { normalizeVersion } from "./semver";

export type ChangelogCategory =
  | "Added" | "Changed" | "Deprecated" | "Removed" | "Fixed" | "Security" | "Other";

export interface ChangelogSection {
  kind: ChangelogCategory;
  /** Heading as authored ("Added", "Notes", …). Empty for uncategorized bullets. */
  label: string;
  items: string[];
}

export interface ChangelogEntry {
  /** Normalized version ("0.2.0", "Unreleased"). */
  version: string;
  /** Version token as authored, brackets stripped. */
  rawVersion: string;
  /** ISO date if the heading carried one, else null. */
  date: string | null;
  sections: ChangelogSection[];
}

export interface ParsedChangelog {
  entries: ChangelogEntry[];
}

const KNOWN_CATEGORIES: ChangelogCategory[] = [
  "Added", "Changed", "Deprecated", "Removed", "Fixed", "Security",
];

function categoryKind(label: string): ChangelogCategory {
  const hit = KNOWN_CATEGORIES.find(k => k.toLowerCase() === label.toLowerCase());
  return hit ?? "Other";
}

const ISO_DATE = /(\d{4}-\d{2}-\d{2})/;

function parseVersionHeading(text: string): { version: string; rawVersion: string; date: string | null } {
  const date = ISO_DATE.exec(text)?.[1] ?? null;
  // Drop a trailing " - <date> …" (any dash variant) so only the version token remains.
  const versionPart = text.replace(/\s*[-–—]\s*\d{4}-\d{2}-\d{2}.*$/, "").trim();
  const token = versionPart.replace(/^\[|\]$/g, "").trim();
  return { version: normalizeVersion(token), rawVersion: token, date };
}

export function parseChangelog(md: string | null | undefined): ParsedChangelog {
  if (!md) return { entries: [] };
  const entries: ChangelogEntry[] = [];
  let entry: ChangelogEntry | null = null;
  let section: ChangelogSection | null = null;

  for (const line of md.split(/\r?\n/)) {
    if (line.startsWith("## ")) {
      const { version, rawVersion, date } = parseVersionHeading(line.slice(3).trim());
      entry = { version, rawVersion, date, sections: [] };
      entries.push(entry);
      section = null;
      continue;
    }
    if (!entry) continue; // skip the H1 + intro before the first version heading
    if (line.startsWith("### ")) {
      const label = line.slice(4).trim();
      section = { kind: categoryKind(label), label, items: [] };
      entry.sections.push(section);
      continue;
    }
    const text = /^[-*]\s+(.*\S)\s*$/.exec(line.trim())?.[1]?.trim();
    if (text) {
      if (!section) {
        section = { kind: "Other", label: "", items: [] };
        entry.sections.push(section);
      }
      section.items.push(text);
    }
  }
  return { entries };
}
