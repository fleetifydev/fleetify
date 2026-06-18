/**
 * Structured changelog renderer for the plugin detail page.
 *
 * Parses the plugin's Keep a Changelog markdown into versioned sections
 * (see `@/lib/changelog`) and renders each release with a version pill,
 * a formatted date, an optional "Installed" badge, and category-grouped
 * bullets. Boilerplate intro is stripped by the parser. A changelog that
 * doesn't follow the format (no `## version` headings) falls back to the
 * previous raw-markdown rendering so nothing regresses.
 */
import type { CSSProperties } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { parseChangelog, type ChangelogCategory, type ChangelogEntry } from "@/lib/changelog";
import { semverEq } from "@/lib/semver";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-06-18" → "18 Jun 2026". Parsed by hand so there's no Date()
 *  timezone drift; non-ISO input is returned verbatim. */
function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const mon = MONTHS[Number(m[2]) - 1];
  return mon ? `${Number(m[3])} ${mon} ${m[1]}` : iso;
}

/** Small, calm category accent. Destructive kinds reuse the theme's error
 *  token (already light/dark aware); the rest are low-saturation mid-tones
 *  that read on both themes. Kept muted on purpose — these are 6px dots. */
const DOT: Record<ChangelogCategory, string> = {
  Added: "#5b9279",
  Changed: "#5a82c2",
  Fixed: "#7c79c2",
  Removed: "var(--c-err)",
  Deprecated: "#b0894a",
  Security: "var(--c-err)",
  Other: "var(--c-dim)",
};

export function ChangelogBody({
  changelog,
  installedVersion,
}: {
  changelog: string | null;
  installedVersion?: string | null;
}) {
  if (!changelog || !changelog.trim()) {
    return <div style={emptyCard}>No changelog published.</div>;
  }

  const { entries } = parseChangelog(changelog);

  // Non-conforming changelog (no version headings): preserve the previous
  // behaviour rather than show nothing — render the raw markdown.
  if (entries.length === 0) {
    return (
      <div style={rawCard} className="md-detail">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{changelog}</ReactMarkdown>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
      {entries.map((e, i) => (
        <VersionBlock
          key={`${e.version}-${i}`}
          entry={e}
          installed={!!installedVersion && semverEq(e.version, installedVersion)}
        />
      ))}
    </div>
  );
}

function VersionBlock({ entry, installed }: { entry: ChangelogEntry; installed: boolean }) {
  const date = formatDate(entry.date);
  return (
    <section>
      <header style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 10 }}>
        <span style={versionPill}>{entry.rawVersion || entry.version}</span>
        {installed && <span style={installedChip}>Installed</span>}
        <span style={{ flex: 1 }} />
        {date && <span style={dateText}>{date}</span>}
      </header>

      <div style={sectionStack}>
        {entry.sections.map((s, j) => (
          <div key={j}>
            {s.label && (
              <div style={categoryLabel}>
                <span style={{ ...dot, background: DOT[s.kind] }} />
                {s.label}
              </div>
            )}
            <ul style={list}>
              {s.items.map((it, k) => (
                <li key={k} style={listItem}>
                  <span style={bulletMark}>–</span>
                  <div style={{ flex: 1, minWidth: 0 }} className="md-detail">
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      components={{ p: ({ node: _node, ...props }) => <span {...props} /> }}
                    >
                      {it}
                    </ReactMarkdown>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}

const emptyCard: CSSProperties = {
  padding: "16px 18px",
  borderRadius: 10,
  border: "1px solid var(--sidebar-border)",
  background: "var(--sidebar)",
  fontSize: 12.5,
  color: "var(--c-low)",
  lineHeight: 1.55,
};

const rawCard: CSSProperties = {
  padding: "16px 18px",
  borderRadius: 10,
  border: "1px solid var(--sidebar-border)",
  background: "var(--sidebar)",
  fontSize: 13,
  color: "var(--c-med)",
  lineHeight: 1.6,
};

const versionPill: CSSProperties = {
  fontSize: 12.5,
  fontWeight: 600,
  color: "var(--c-high)",
  padding: "2px 9px",
  borderRadius: 7,
  border: "1px solid var(--sidebar-border)",
  background: "var(--card)",
  letterSpacing: 0.2,
  fontVariantNumeric: "tabular-nums",
};

const installedChip: CSSProperties = {
  fontSize: 10,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: 0.5,
  color: "var(--c-low)",
  padding: "2px 7px",
  borderRadius: 6,
  border: "1px solid var(--sidebar-border)",
  background: "var(--accent)",
};

const dateText: CSSProperties = {
  fontSize: 12,
  color: "var(--c-dim)",
  fontVariantNumeric: "tabular-nums",
};

const sectionStack: CSSProperties = {
  borderTop: "1px solid var(--sidebar-border)",
  paddingTop: 12,
  display: "flex",
  flexDirection: "column",
  gap: 14,
};

const categoryLabel: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 7,
  fontSize: 11,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: 0.6,
  color: "var(--c-dim)",
  marginBottom: 7,
};

const dot: CSSProperties = {
  width: 6,
  height: 6,
  borderRadius: 99,
  display: "inline-block",
  flex: "0 0 auto",
};

const list: CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "flex",
  flexDirection: "column",
  gap: 5,
};

const listItem: CSSProperties = {
  display: "flex",
  gap: 8,
  fontSize: 13,
  color: "var(--c-med)",
  lineHeight: 1.55,
  alignItems: "baseline",
};

const bulletMark: CSSProperties = {
  color: "var(--c-dim)",
  flex: "0 0 auto",
  userSelect: "none",
};
