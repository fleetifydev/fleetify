/**
 * Renders the list of citations / search-results that came back with a
 * search-grounded assistant message (Perplexity Sonar today; whatever
 * other providers we wire to the same event types next).
 *
 * Visual: compact rows, one per source. Favicon is loaded from the
 * URL's hostname via Google's s2 favicon endpoint — cheap, no extra
 * deps, no auth — with a graceful fallback to a generic link icon
 * when the image errors. The whole row is a button that opens the
 * source in a new tab (Tauri's shell_open_external if available,
 * window.open otherwise).
 */
import { Link as LinkIcon, Globe } from "lucide-react";
import type { CitationBlock } from "@/types/chat";

function hostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function faviconUrl(url: string): string | null {
  try {
    const h = new URL(url).hostname;
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(h)}&sz=32`;
  } catch {
    return null;
  }
}

function openLink(url: string) {
  // Tauri provides shell_open_external via the preload bridge so links
  // open in the user's default browser instead of inside the webview.
  const w = window as unknown as { electronAPI?: { openExternal?: (u: string) => unknown } };
  if (w.electronAPI?.openExternal) {
    void w.electronAPI.openExternal(url);
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

export function CitationCard({ block }: { block: CitationBlock }) {
  if (block.items.length === 0) return null;
  const searchResults = block.items.filter((i) => i.kind === "search_result");
  const plainCitations = block.items.filter((i) => i.kind === "citation");
  const showSection = (label: string, items: CitationBlock["items"]) => {
    if (items.length === 0) return null;
    return (
      <div style={{ marginTop: 6 }}>
        <div
          style={{
            fontSize: 10.5,
            fontWeight: 600,
            letterSpacing: "0.05em",
            color: "var(--c-dim)",
            textTransform: "uppercase",
            marginBottom: 4,
          }}
        >
          {label}
          <span style={{ marginLeft: 6, fontWeight: 400 }}>{items.length}</span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {items.map((it, i) => {
            const fav = faviconUrl(it.url);
            return (
              <button
                key={`${i}-${it.url}`}
                onClick={() => openLink(it.url)}
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 9,
                  padding: "7px 9px",
                  borderRadius: 6,
                  background: "transparent",
                  border: "1px solid var(--c-brd)",
                  cursor: "pointer",
                  outline: "none",
                  textAlign: "left",
                  color: "var(--c-high)",
                  fontFamily: "inherit",
                  width: "100%",
                  transition: "background 0.12s",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "var(--c-srf)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "transparent";
                }}
              >
                <div
                  style={{
                    width: 16,
                    height: 16,
                    flexShrink: 0,
                    marginTop: 1,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  {fav ? (
                    <img
                      src={fav}
                      width={16}
                      height={16}
                      alt=""
                      onError={(e) => {
                        (e.currentTarget as HTMLImageElement).style.display = "none";
                      }}
                      style={{ borderRadius: 3 }}
                    />
                  ) : (
                    <Globe size={14} style={{ color: "var(--c-dim)" }} />
                  )}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  {it.title && (
                    <div
                      style={{
                        fontSize: 12,
                        fontWeight: 500,
                        color: "var(--c-high)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {it.title}
                    </div>
                  )}
                  <div
                    style={{
                      fontSize: 11,
                      color: "var(--c-low)",
                      marginTop: 1,
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                    }}
                  >
                    <span
                      style={{
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {hostname(it.url)}
                    </span>
                    {it.date && (
                      <span style={{ color: "var(--c-dim)" }}>· {it.date}</span>
                    )}
                  </div>
                  {it.snippet && (
                    <div
                      style={{
                        fontSize: 11.5,
                        color: "var(--c-low)",
                        marginTop: 4,
                        lineHeight: 1.4,
                        display: "-webkit-box",
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: "vertical",
                        overflow: "hidden",
                      }}
                    >
                      {it.snippet}
                    </div>
                  )}
                </div>
                <LinkIcon
                  size={12}
                  style={{
                    color: "var(--c-dim)",
                    marginTop: 2,
                    flexShrink: 0,
                  }}
                />
              </button>
            );
          })}
        </div>
      </div>
    );
  };
  return (
    <div style={{ marginTop: 8 }}>
      {showSection("Sources", searchResults)}
      {showSection("Citations", plainCitations)}
    </div>
  );
}
