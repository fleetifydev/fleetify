/**
 * Structured changelog renderer for the plugin detail page.
 *
 * Parses the plugin's Keep a Changelog markdown into versioned sections
 * (see `@/lib/changelog`) and renders each release in a flat, boxless
 * layout that mirrors the detail page's own header vocabulary: a mono
 * version label, a muted date with a `·` separator, an optional
 * "Installed" marker, and category-grouped bullets. Versions are split by
 * a faint hairline. A changelog that doesn't follow the format falls back
 * to raw-markdown rendering so nothing regresses.
 */
import type { CSSProperties } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { parseChangelog, type ChangelogEntry } from "@/lib/changelog";
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
    <div style={{ display: "flex", flexDirection: "column" }}>
      {entries.map((e, i) => (
        <VersionBlock
          key={`${e.version}-${i}`}
          entry={e}
          installed={!!installedVersion && semverEq(e.version, installedVersion)}
          first={i === 0}
        />
      ))}
    </div>
  );
}

function VersionBlock({ entry, installed, first }: { entry: ChangelogEntry; installed: boolean; first: boolean }) {
  const date = formatDate(entry.date);
  return (
    <section
      style={{
        paddingTop: first ? 0 : 18,
        marginTop: first ? 0 : 18,
        borderTop: first ? undefined : "1px solid var(--sidebar-border)",
      }}
    >
      <header style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <span style={versionText}>v{entry.rawVersion || entry.version}</span>
        {date && (
          <>
            <span style={dotSep}>·</span>
            <span style={dateText}>{date}</span>
          </>
        )}
        <span style={{ flex: 1 }} />
        {installed && (
          <span style={installedTag}>
            <span style={installedDot} />
            Installed
          </span>
        )}
      </header>

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {entry.sections.map((s, j) => (
          <div key={j}>
            {s.label && <div style={categoryLabel}>{s.label}</div>}
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

const versionText: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 13.5,
  fontWeight: 600,
  color: "var(--c-high)",
  letterSpacing: 0.2,
};

const dotSep: CSSProperties = {
  color: "var(--c-ghost)",
  fontSize: 12,
};

const dateText: CSSProperties = {
  fontSize: 12,
  color: "var(--c-dim)",
};

const installedTag: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  fontSize: 11,
  color: "var(--c-low)",
};

const installedDot: CSSProperties = {
  width: 5,
  height: 5,
  borderRadius: 99,
  background: "var(--c-official)",
  display: "inline-block",
  flex: "0 0 auto",
};

const categoryLabel: CSSProperties = {
  fontSize: 10.5,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: 0.7,
  color: "var(--c-low)",
  marginBottom: 6,
};

const list: CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "flex",
  flexDirection: "column",
  gap: 4,
};

const listItem: CSSProperties = {
  display: "flex",
  gap: 8,
  fontSize: 13,
  color: "var(--c-med)",
  lineHeight: 1.5,
  alignItems: "baseline",
};

const bulletMark: CSSProperties = {
  color: "var(--c-ghost)",
  flex: "0 0 auto",
  userSelect: "none",
};
