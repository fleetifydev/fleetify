import { useEffect, useRef } from "react";
import { Folder, FileText } from "lucide-react";
import type { FileSearchEntry } from "@/lib/api";

interface FileMentionPopupProps {
  query: string;
  results: FileSearchEntry[];
  loading: boolean;
  activeIndex: number;
  onHover: (index: number) => void;
  onPick: (entry: FileSearchEntry) => void;
}

export function FileMentionPopup({
  query,
  results,
  loading,
  activeIndex,
  onHover,
  onPick,
}: FileMentionPopupProps) {
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLButtonElement>(
      `[data-mention-index="${activeIndex}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  return (
    <div
      data-testid="file-mention-popup"
      style={{
        position: "absolute",
        bottom: "calc(100% + 8px)",
        left: 0,
        right: 0,
        maxWidth: 480,
        zIndex: 60,
        background: "var(--popover, var(--card))",
        border: "1px solid var(--c-brd)",
        borderRadius: 12,
        overflow: "hidden",
        boxShadow:
          "0 12px 36px rgba(0,0,0,0.32), 0 2px 8px rgba(0,0,0,0.16)",
        animation: "fleetMenuIn 0.12s cubic-bezier(0.4, 0, 0.2, 1)",
      }}
    >
      <div
        style={{
          padding: "7px 12px 5px",
          fontSize: 10.5,
          fontWeight: 600,
          letterSpacing: "0.06em",
          color: "var(--c-ghost)",
          textTransform: "uppercase",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <span>Files & Folders</span>
        <span style={{ fontSize: 10, color: "var(--c-dim)", opacity: 0.7, letterSpacing: "0.04em" }}>
          {query ? `@${query}` : "@"}
        </span>
      </div>

      <div
        ref={listRef}
        style={{
          maxHeight: 260,
          overflowY: "auto",
          padding: "2px 4px 6px",
        }}
      >
        {loading && results.length === 0 && (
          <div style={{ padding: "12px 14px", fontSize: 12, color: "var(--c-dim)" }}>
            Searching…
          </div>
        )}

        {!loading && results.length === 0 && (
          <div style={{ padding: "12px 14px", fontSize: 12, color: "var(--c-dim)" }}>
            No matches for “{query}”
          </div>
        )}

        {results.map((entry, i) => {
          const active = i === activeIndex;
          const Icon = entry.type === "folder" ? Folder : FileText;
          const dirname = entry.relative.includes("/")
            ? entry.relative.slice(0, entry.relative.lastIndexOf("/"))
            : "";
          return (
            <button
              key={entry.path}
              data-mention-index={i}
              data-testid={`file-mention-item-${i}`}
              onMouseEnter={() => onHover(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                onPick(entry);
              }}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 9,
                width: "100%",
                padding: "6px 10px",
                borderRadius: 7,
                background: active ? "var(--c-srf2)" : "transparent",
                border: "none",
                cursor: "pointer",
                textAlign: "left",
                transition: "background 0.08s",
              }}
            >
              <Icon
                size={13}
                style={{
                  flexShrink: 0,
                  color:
                    entry.type === "folder"
                      ? "var(--c-med)"
                      : "var(--c-dim)",
                }}
              />
              <span
                style={{
                  fontSize: 12.5,
                  color: "var(--c-high)",
                  fontWeight: 500,
                  flexShrink: 0,
                  maxWidth: 180,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {entry.name}
              </span>
              {dirname && (
                <span
                  style={{
                    fontSize: 11,
                    color: "var(--c-dim)",
                    opacity: 0.7,
                    fontFamily: "var(--font-mono)",
                    flex: 1,
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    textAlign: "right",
                  }}
                >
                  {dirname}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
