/**
 * SessionRulesChip — a toolbar chip that edits a session's *rules*: free-text
 * instructions written into the session's working-directory rule file
 * (CLAUDE.md / AGENTS.md / GEMINI.md / .github/copilot-instructions.md, or a
 * Cursor `.cursor/rules/*.mdc`) so the provider reads them automatically on its
 * next spawn. Distinct from a Library "rule" (which is user-global, fans out to
 * every provider's home file) — this one is scoped to the single session.
 *
 * Self-contained on purpose: the session-toolbar is large and draft-aware, so
 * this keeps its footprint there to a single mount line. Only rendered for a
 * committed (non-draft) session — a draft has no row or working dir yet.
 *
 * Load-on-open, save-on-demand: GETs the current text the first time the
 * popover opens, PUTs on "Save". A filled dot on the chip signals that rules
 * are set without opening the popover.
 */
import { useEffect, useRef, useState } from "react";
import { ScrollText } from "lucide-react";
import { getSessionRules, setSessionRules } from "@/lib/api";

export function SessionRulesChip({ sessionId }: { sessionId: string }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  // The persisted text, so the chip's filled-dot state survives a re-open
  // without re-fetching and "Save" can detect a no-op.
  const [saved, setSaved] = useState("");
  const wrapRef = useRef<HTMLDivElement>(null);

  // Lazy-load the current rules the first time the popover opens.
  useEffect(() => {
    if (!open || loaded) return;
    let cancelled = false;
    void (async () => {
      try {
        const r = await getSessionRules(sessionId);
        if (!cancelled) {
          setText(r);
          setSaved(r);
        }
      } catch {
        /* leave empty — the textarea is still editable */
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, loaded, sessionId]);

  // Close on outside click + Escape, matching the toolbar's other popovers.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const dirty = loaded && text.trim() !== saved.trim();
  const hasRules = saved.trim().length > 0;

  const save = async () => {
    if (saving || !dirty) return;
    setSaving(true);
    try {
      const next = await setSessionRules(sessionId, text.trim());
      setSaved(next);
      setText(next);
      setOpen(false);
    } catch {
      /* keep the popover open so the user can retry */
    } finally {
      setSaving(false);
    }
  };

  return (
    <div ref={wrapRef} style={{ position: "relative", display: "inline-flex" }}>
      <button
        onClick={() => setOpen((o) => !o)}
        onMouseDown={(e) => e.preventDefault()}
        title="Session rules — instructions for this session only"
        style={{
          position: "relative",
          display: "inline-flex",
          alignItems: "center",
          gap: 5,
          height: 24,
          padding: "0 8px",
          background: open ? "rgba(var(--fg-rgb),0.10)" : "transparent",
          border: "1px solid transparent",
          borderRadius: 6,
          color: "var(--c-fg, #e6e6e6)",
          fontFamily: "var(--font-sans)",
          fontSize: 11.5,
          fontWeight: 500,
          lineHeight: 1,
          cursor: "pointer",
          outline: "none",
          whiteSpace: "nowrap",
          flexShrink: 0,
          transition: "background 0.12s",
        }}
        onMouseEnter={(e) => {
          if (!open) e.currentTarget.style.background = "rgba(var(--fg-rgb),0.06)";
        }}
        onMouseLeave={(e) => {
          if (!open) e.currentTarget.style.background = "transparent";
        }}
      >
        <ScrollText size={11} style={{ color: "var(--c-dim, #9a9a9a)" }} />
        <span>Rules</span>
        {hasRules && (
          <span
            aria-hidden
            style={{
              width: 5,
              height: 5,
              borderRadius: "50%",
              background: "var(--c-accent, #6ea8fe)",
              flexShrink: 0,
            }}
          />
        )}
      </button>

      {open && (
        <div
          style={{
            position: "absolute",
            bottom: "calc(100% + 6px)",
            left: 0,
            zIndex: 30,
            width: 340,
            background: "var(--popover, #0D0D0D)",
            border: "1px solid var(--c-brd)",
            borderRadius: 10,
            boxShadow: "0 12px 34px rgba(0,0,0,0.36)",
            padding: 12,
            display: "flex",
            flexDirection: "column",
            gap: 8,
            animation: "fleet-popover-up 0.14s ease-out both",
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--c-high)" }}>
              Session rules
            </div>
            <div style={{ fontSize: 11, color: "var(--c-dim)", lineHeight: 1.45 }}>
              Written into this session's working-dir rule file so the agent
              follows them automatically. Scoped to this session only.
            </div>
          </div>
          <textarea
            value={text}
            disabled={!loaded}
            onChange={(e) => setText(e.target.value)}
            placeholder={loaded ? "e.g. Always run the tests before committing." : "Loading…"}
            rows={6}
            style={{
              width: "100%",
              padding: "8px 10px",
              fontSize: 12.5,
              fontFamily: "var(--font-mono)",
              lineHeight: 1.5,
              borderRadius: 7,
              border: "1px solid var(--c-brd)",
              background: "var(--sidebar)",
              color: "var(--c-high)",
              outline: "none",
              resize: "vertical",
              boxSizing: "border-box",
            }}
          />
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button
              onClick={() => setOpen(false)}
              style={{
                padding: "5px 12px",
                fontSize: 12,
                fontWeight: 600,
                background: "none",
                color: "var(--c-med)",
                border: "1px solid var(--c-brd)",
                borderRadius: 7,
                cursor: "pointer",
              }}
            >
              Cancel
            </button>
            <button
              onClick={save}
              disabled={!dirty || saving}
              style={{
                padding: "5px 12px",
                fontSize: 12,
                fontWeight: 600,
                background: dirty && !saving ? "var(--c-high)" : "var(--c-srf)",
                color: dirty && !saving ? "var(--card)" : "var(--c-dim)",
                border: "none",
                borderRadius: 7,
                cursor: dirty && !saving ? "pointer" : "default",
              }}
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
