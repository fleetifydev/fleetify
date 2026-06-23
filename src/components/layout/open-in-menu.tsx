import { useState, useEffect, useRef, useCallback } from "react";
import { ChevronDown, SquareCode } from "lucide-react";

interface DetectedEditor { id: string; label: string }

/** Top-right "Open in…" control. Probes installed editors once on mount,
 *  launches the given project path in the picked editor, and falls back to
 *  the OS folder opener when no editor is on PATH. Renders nothing when
 *  there's no project path to open (e.g. the Fleet hub with no agent). */
export function OpenInMenu({ projectPath }: { projectPath?: string | null }) {
  const [editors, setEditors] = useState<DetectedEditor[] | null>(null);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!projectPath) return;
    let cancelled = false;
    window.fleetify?.detectEditors?.()
      .then((r) => { if (!cancelled) setEditors(r.editors ?? []); })
      .catch(() => { if (!cancelled) setEditors([]); });
    return () => { cancelled = true; };
  }, [projectPath]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const launch = useCallback((id: string) => {
    if (projectPath) void window.fleetify?.openInEditor?.(id, projectPath);
    setOpen(false);
  }, [projectPath]);

  const openFolder = useCallback(() => {
    if (projectPath) void window.fleetify?.openExternal?.(projectPath);
    setOpen(false);
  }, [projectPath]);

  if (!projectPath) return null;

  // Three states: `null` = still probing, `[]` = probed but none found,
  // a non-empty array = the detected editors. Distinguishing the first
  // two matters so the menu doesn't flash the "Open folder" fallback
  // while detection is still in flight.
  const detecting = editors === null;
  const soloEditor = editors?.length === 1 ? editors[0] : undefined;
  const faceLabel = soloEditor ? `Open in: ${soloEditor.label}` : "Open in";

  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <button
        onClick={() => setOpen((v) => !v)}
        onMouseDown={(e) => e.preventDefault()}
        title="Open the project in an editor"
        style={{
          display: "inline-flex", alignItems: "center", gap: 5,
          height: 22, padding: "0 8px", borderRadius: 5,
          background: open ? "rgba(var(--fg-rgb),0.06)" : "transparent",
          border: "none", outline: "none", cursor: "pointer",
          color: open ? "var(--c-med)" : "var(--c-low)",
          fontSize: 12, fontWeight: 500, fontFamily: "var(--font-sans)",
          transition: "color 0.12s, background 0.12s",
        }}
        onMouseEnter={(e) => { if (!open) { e.currentTarget.style.background = "rgba(var(--fg-rgb),0.06)"; e.currentTarget.style.color = "var(--c-med)"; } }}
        onMouseLeave={(e) => { if (!open) { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--c-low)"; } }}
      >
        <SquareCode size={13} strokeWidth={1.9} />
        <span>{faceLabel}</span>
        <ChevronDown size={11} strokeWidth={2} style={{ color: "var(--c-ghost)" }} />
      </button>
      {open && (
        <div style={{
          position: "absolute", top: "calc(100% + 6px)", right: 0,
          minWidth: 190,
          background: "var(--popover, #161616)",
          border: "1px solid var(--c-brd, rgba(255,255,255,0.08))",
          borderRadius: 7, padding: 3,
          boxShadow: "0 8px 28px rgba(0,0,0,0.42)", zIndex: 60,
          fontFamily: "var(--font-sans)",
        }}>
          {detecting ? (
            <div style={{ ...menuItemStyle, color: "var(--c-ghost)", cursor: "default" }} aria-disabled>
              Detecting editors…
            </div>
          ) : editors.length > 0 ? editors.map((ed) => (
            <button
              key={ed.id}
              onClick={() => launch(ed.id)}
              onMouseDown={(e) => e.preventDefault()}
              style={menuItemStyle}
              onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "rgba(var(--fg-rgb),0.06)"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
            >{ed.label}</button>
          )) : (
            <button
              onClick={openFolder}
              onMouseDown={(e) => e.preventDefault()}
              style={menuItemStyle}
              onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "rgba(var(--fg-rgb),0.06)"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
            >Open folder</button>
          )}
        </div>
      )}
    </div>
  );
}

const menuItemStyle: React.CSSProperties = {
  display: "block", width: "100%", textAlign: "left",
  padding: "5px 9px", borderRadius: 4,
  background: "transparent", border: "none", outline: "none",
  color: "var(--c-med)", fontSize: 12.5, fontFamily: "inherit", cursor: "pointer",
};
