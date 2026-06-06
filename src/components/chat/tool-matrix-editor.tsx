import { useState, useRef, useEffect } from "react";
import type { ToolMatrixCapability } from "@/lib/providers-api";

export interface ToolMatrixEditorProps {
  matrix: ToolMatrixCapability;
  overrides: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
}

export function ToolMatrixEditor({ matrix, overrides, onChange }: ToolMatrixEditorProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const hasAnyOverride = Object.keys(overrides).length > 0;

  return (
    <div ref={wrapRef} style={{ position: "relative", flexShrink: 0 }}>
      <button
        onClick={() => setOpen(o => !o)}
        onMouseDown={e => e.preventDefault()}
        title="Per-tool permissions"
        style={{
          padding: "3px 7px", marginRight: 1,
          border: "none",
          background: open ? "rgba(var(--fg-rgb), 0.05)" : "none",
          color: hasAnyOverride ? "rgba(96,165,250,0.95)" : "var(--c-low)",
          fontSize: 12, fontWeight: 600, cursor: "pointer",
          letterSpacing: "0.005em",
          borderRadius: 5,
          transition: "color 0.12s, background 0.12s",
          flexShrink: 0,
          fontFamily: "var(--font-sans)",
          outline: "none",
        }}
        onMouseEnter={e => { if (!open) e.currentTarget.style.background = "rgba(var(--fg-rgb),0.05)"; }}
        onMouseLeave={e => { if (!open) e.currentTarget.style.background = "none"; }}
      >
        Tools
      </button>

      {open && (
        <div style={{
          position: "absolute", bottom: "calc(100% + 6px)", left: 0,
          minWidth: 300,
          background: "var(--popover, #161616)",
          border: "1px solid var(--c-brd, rgba(255,255,255,0.08))",
          borderRadius: 8,
          padding: 4,
          boxShadow: "0 -8px 28px rgba(0,0,0,0.42)",
          zIndex: 60,
          fontFamily: "var(--font-sans)",
          animation: "fleet-popover-up 0.14s ease-out both",
        }}>
          {/* Header row */}
          <div style={{
            display: "flex", alignItems: "center", justifyContent: "space-between",
            padding: "5px 9px 6px",
            borderBottom: "1px solid var(--c-brd, rgba(255,255,255,0.06))",
            marginBottom: 2,
          }}>
            <span style={{ fontSize: 10.5, color: "var(--c-dim)", fontWeight: 500 }}>
              Per-tool permissions
            </span>
            {hasAnyOverride && (
              <button
                onClick={() => onChange({})}
                onMouseDown={e => e.preventDefault()}
                style={{
                  background: "none", border: "none", cursor: "pointer",
                  fontSize: 10.5, color: "var(--c-dim)", padding: "0 2px",
                  fontFamily: "inherit", outline: "none",
                  textDecoration: "underline",
                  textUnderlineOffset: 2,
                }}
                onMouseEnter={e => { e.currentTarget.style.color = "var(--c-fg)"; }}
                onMouseLeave={e => { e.currentTarget.style.color = "var(--c-dim)"; }}
              >
                Reset all
              </button>
            )}
          </div>

          {/* Tool rows */}
          {matrix.tools.map((tool) => {
            const active = overrides[tool] ?? "Default";
            const options = ["Default", ...matrix.decisions];
            return (
              <div
                key={tool}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "space-between",
                  padding: "4px 9px",
                  borderRadius: 5,
                  gap: 8,
                }}
              >
                <span style={{
                  fontSize: 12, fontWeight: 500,
                  color: "var(--c-fg)",
                  fontFamily: "var(--font-mono)",
                  flexShrink: 0,
                  minWidth: 80,
                }}>
                  {tool}
                </span>
                {/* Segmented selector */}
                <div style={{
                  display: "flex", gap: 2,
                  background: "rgba(var(--fg-rgb),0.06)",
                  borderRadius: 5, padding: 2,
                  flexShrink: 0,
                }}>
                  {options.map((opt) => {
                    const isActive = active === opt;
                    return (
                      <button
                        key={opt}
                        onClick={() => {
                          const next = { ...overrides };
                          if (opt === "Default") {
                            delete next[tool];
                          } else {
                            next[tool] = opt;
                          }
                          onChange(next);
                        }}
                        onMouseDown={e => e.preventDefault()}
                        style={{
                          padding: "2px 7px",
                          border: "none", outline: "none",
                          borderRadius: 4,
                          background: isActive ? "var(--c-srf, rgba(255,255,255,0.1))" : "transparent",
                          color: isActive ? "var(--c-fg)" : "var(--c-dim)",
                          fontSize: 11, fontWeight: isActive ? 600 : 500,
                          cursor: "pointer",
                          fontFamily: "inherit",
                          transition: "background 0.1s, color 0.1s",
                          textTransform: "capitalize",
                          letterSpacing: "0.01em",
                        }}
                        onMouseEnter={e => {
                          if (!isActive) {
                            e.currentTarget.style.background = "rgba(var(--fg-rgb),0.08)";
                            e.currentTarget.style.color = "var(--c-fg)";
                          }
                        }}
                        onMouseLeave={e => {
                          if (!isActive) {
                            e.currentTarget.style.background = "transparent";
                            e.currentTarget.style.color = "var(--c-dim)";
                          }
                        }}
                      >
                        {opt}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}

          {/* Glob hint */}
          {matrix.supports_glob && (
            <div style={{
              padding: "5px 9px 3px",
              borderTop: "1px solid var(--c-brd, rgba(255,255,255,0.06))",
              marginTop: 4,
            }}>
              <span style={{
                fontSize: 10.5, color: "var(--c-dim)",
                fontStyle: "italic",
              }}>
                Tool names; glob patterns supported by the agent.
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
