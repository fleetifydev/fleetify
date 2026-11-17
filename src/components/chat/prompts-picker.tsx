/**
 * Prompts picker — the `/prompts` (no-arg) dialog. Lists every prompt
 * (Library-authored + plugin-shipped) with a search box on top; picking a row
 * sends that prompt's body as a message. Styled to match the app's other modals
 * (see create-item-dialog) and the Fleet ask-user feel.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { claimEscape } from "@/hooks/use-escape-to-stop";
import { Search, X, FileText } from "lucide-react";
import { listPrompts, filterPrompts, type PromptSummary } from "@/lib/prompts-api";

export function PromptsPicker({
  open, onClose, onPick,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (prompt: PromptSummary) => void;
}) {
  const [items, setItems] = useState<PromptSummary[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Fetch on open; reset transient state each time it opens.
  useEffect(() => {
    if (!open) return;
    setQuery(""); setIndex(0); setError(null); setLoading(true);
    let cancelled = false;
    listPrompts()
      .then((list) => { if (!cancelled) setItems(list); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    requestAnimationFrame(() => inputRef.current?.focus());
    return () => { cancelled = true; };
  }, [open]);

  const filtered = useMemo(() => filterPrompts(items, query), [items, query]);

  // Keep the highlighted row in range as the filter narrows.
  useEffect(() => {
    setIndex((i) => Math.min(i, Math.max(0, filtered.length - 1)));
  }, [filtered.length]);

  // Esc closes; ↑/↓ move; Enter picks the highlighted row.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      // Claim it: closing must not also stop a stream or deny a card.
      if (e.key === "Escape") { claimEscape(e); onClose(); }
      else if (e.key === "ArrowDown") { e.preventDefault(); setIndex((i) => Math.min(i + 1, filtered.length - 1)); }
      else if (e.key === "ArrowUp") { e.preventDefault(); setIndex((i) => Math.max(i - 1, 0)); }
      else if (e.key === "Enter") {
        const hit = filtered[index];
        if (hit) { e.preventDefault(); onPick(hit); }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, filtered, index, onClose, onPick]);

  if (!open) return null;

  return (
    <div onClick={onClose} style={overlay} role="dialog" aria-modal="true" aria-label="Prompts">
      <div onClick={(e) => e.stopPropagation()} style={card}>
        <div style={searchRow}>
          <Search size={15} style={{ color: "var(--c-dim)", flexShrink: 0 }} />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search prompts by name…"
            style={searchInput}
          />
          <button onClick={onClose} aria-label="Close" style={closeBtn}><X size={15} /></button>
        </div>

        <div className="scroll-subtle" style={listWrap}>
          {loading ? (
            <Hint text="Loading prompts…" />
          ) : error ? (
            <Hint text={`Couldn't load prompts: ${error}`} />
          ) : filtered.length === 0 ? (
            <Hint text={items.length === 0
              ? "No prompts yet — create one in Library or install a plugin."
              : "No prompts match your search."} />
          ) : (
            filtered.map((p, i) => (
              <button
                key={p.id}
                onClick={() => onPick(p)}
                onMouseEnter={() => setIndex(i)}
                style={row(i === index)}
              >
                <FileText size={14} style={{ color: "var(--c-dim)", flexShrink: 0, marginTop: 2 }} />
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={rowTitle}>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</span>
                    <span style={rowSlug}>{p.slug}</span>
                    <span style={rowBadge}>{p.source === "user" ? "You" : p.source}</span>
                  </span>
                  {p.description && <span style={rowDesc}>{p.description}</span>}
                </span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function Hint({ text }: { text: string }) {
  return <div style={{ padding: "28px 16px", textAlign: "center", color: "var(--c-low)", fontSize: 12.5 }}>{text}</div>;
}

const overlay: React.CSSProperties = { position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "flex-start", justifyContent: "center", zIndex: 1000, padding: "12vh 24px 24px" };
const card: React.CSSProperties = { width: 560, maxWidth: "100%", maxHeight: "70vh", background: "var(--card)", border: "1px solid var(--c-brd)", borderRadius: 12, display: "flex", flexDirection: "column", overflow: "hidden", boxShadow: "0 20px 60px rgba(0,0,0,0.4)" };
const searchRow: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, padding: "10px 12px", borderBottom: "1px solid var(--c-brd)" };
const searchInput: React.CSSProperties = { flex: 1, background: "none", border: "none", outline: "none", color: "var(--c-high)", fontSize: 14, fontFamily: "inherit" };
const closeBtn: React.CSSProperties = { background: "none", border: "none", cursor: "pointer", color: "var(--c-dim)", display: "flex", flexShrink: 0 };
const listWrap: React.CSSProperties = { flex: 1, minHeight: 0, overflowY: "auto", padding: 6 };
const rowTitle: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, fontSize: 13, fontWeight: 500, color: "var(--c-high)" };
const rowSlug: React.CSSProperties = { fontSize: 10.5, fontFamily: "var(--font-mono)", color: "var(--c-ghost)", flexShrink: 0 };
const rowBadge: React.CSSProperties = { fontSize: 9.5, fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase", color: "var(--c-med)", background: "var(--c-srf)", borderRadius: 4, padding: "1px 5px", flexShrink: 0 };
const rowDesc: React.CSSProperties = { display: "block", fontSize: 11.5, color: "var(--c-dim)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
function row(active: boolean): React.CSSProperties {
  return { display: "flex", alignItems: "flex-start", gap: 9, width: "100%", textAlign: "left", padding: "8px 10px", borderRadius: 8, border: "none", cursor: "pointer", background: active ? "var(--c-srf)" : "transparent", fontFamily: "inherit" };
}
