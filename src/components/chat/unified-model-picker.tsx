/**
 * Three-column model picker shared between the session toolbar
 * (Pick-folder-adjacent chip) and the chat composer (Routing-adjacent
 * chip). Columns: Providers | Models | Effort.
 *
 * Selection callbacks DO NOT close the menu. The caller passes an
 * onClose handler that this component fires on outside click / Escape.
 *
 * Effort column is rendered disabled when the active model's
 * `supports_effort` is false. The catalog ships the flag per-entry.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Check } from "lucide-react";
import { ProviderLogo } from "@/components/ui/provider-logo";
import type { PickerGroup, PickerModel } from "@/lib/picker-groups";
import { resolveDispatchTool } from "@/lib/picker-groups";

export type Effort = "low" | "medium" | "high" | "extra_high" | "max";

const EFFORTS: Array<{ id: Effort; label: string }> = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "extra_high", label: "Extra high" },
  { id: "max", label: "Max" },
];

export interface UnifiedModelPickerProps {
  /** Active catalog provider id (e.g. "claude", "perplexity"). For
   *  Perplexity Agent brand splits the picker still highlights the
   *  source-provider row matching this value AND the brand-split row
   *  whose models include the active `model`. */
  tool: string;
  model: string | null;
  effort: Effort;
  groups: PickerGroup[];
  onPickModel: (groupId: string, modelId: string) => void;
  onPickEffort: (effort: Effort) => void;
  onClose: () => void;
  /** Determines which edge the popover sits flush against. */
  anchor: "top" | "bottom";
}

export function UnifiedModelPicker({
  tool,
  model,
  effort,
  groups,
  onPickModel,
  onPickEffort,
  onClose,
  anchor,
}: UnifiedModelPickerProps) {
  const initialGroupId = useMemo(() => {
    if (model) {
      const containing = groups.find((g) => g.models.some((m) => m.id === model));
      if (containing) return containing.id;
    }
    const direct = groups.find((g) => g.id === tool);
    if (direct) return direct.id;
    return groups[0]?.id ?? "";
  }, [groups, tool, model]);

  const [activeGroupId, setActiveGroupId] = useState(initialGroupId);
  const visibleGroup = groups.find((g) => g.id === activeGroupId) ?? groups[0];

  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const activeModel: PickerModel | undefined = useMemo(() => {
    if (!model) return undefined;
    for (const g of groups) {
      const m = g.models.find((mm) => mm.id === model);
      if (m) return m;
    }
    return undefined;
  }, [groups, model]);
  const effortEnabled = activeModel?.supports_effort ?? false;

  const railRows = useMemo(() => {
    const rows: Array<{ kind: "divider" } | { kind: "row"; group: PickerGroup }> = [];
    let lastCategory: "cli" | "http" | "ppx-agent" | null = null;
    for (const g of groups) {
      const cat: "cli" | "http" | "ppx-agent" = g.id.startsWith("perplexity:")
        ? "ppx-agent"
        : isCliId(g.id)
          ? "cli"
          : "http";
      if (lastCategory && cat !== lastCategory) rows.push({ kind: "divider" });
      rows.push({ kind: "row", group: g });
      lastCategory = cat;
    }
    return rows;
  }, [groups]);

  return (
    <div
      ref={rootRef}
      role="menu"
      style={{
        position: "absolute",
        ...(anchor === "bottom"
          ? { bottom: "calc(100% + 6px)" }
          : { top: "calc(100% + 6px)" }),
        left: 0,
        zIndex: 60,
        display: "flex",
        background: "var(--popover, #1a1a1a)",
        border: "1px solid var(--c-brd, rgba(255,255,255,0.10))",
        borderRadius: 8,
        boxShadow:
          anchor === "bottom"
            ? "0 -14px 36px rgba(0,0,0,0.45)"
            : "0 14px 36px rgba(0,0,0,0.45)",
        animation: "fleet-popover-up 0.14s ease-out both",
        overflow: "hidden",
        textAlign: "left",
        maxWidth: "calc(100vw - 32px)",
      }}
    >
      {/* Providers column */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          padding: 4,
          width: 160,
          height: 320,
          overflowY: "auto",
          borderRight: "1px solid var(--c-brd, rgba(255,255,255,0.08))",
        }}
      >
        <SectionHeader>Providers</SectionHeader>
        {railRows.map((row, idx) => {
          if (row.kind === "divider") {
            return (
              <div
                key={`div-${idx}`}
                data-rail-divider="true"
                style={{
                  height: 1,
                  background: "var(--c-brd, rgba(255,255,255,0.08))",
                  margin: "4px 6px",
                }}
              />
            );
          }
          const g = row.group;
          const isHovered = g.id === activeGroupId;
          const isActiveProvider =
            resolveDispatchTool(g.id) === tool &&
            g.models.some((m) => m.id === model);
          return (
            <button
              key={g.id}
              onMouseEnter={() => setActiveGroupId(g.id)}
              onFocus={() => setActiveGroupId(g.id)}
              onClick={() => setActiveGroupId(g.id)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 9,
                width: "100%",
                textAlign: "left",
                padding: "6px 10px",
                background: isHovered ? "var(--c-srf, rgba(255,255,255,0.06))" : "transparent",
                border: "none",
                outline: "none",
                cursor: "pointer",
                borderRadius: 5,
                // `--c-fg` is never defined in globals.css — the literal
                // fallback `#e6e6e6` made provider names invisible on
                // the light-theme white popover. Route through `--c-high`
                // which IS themed (dark text in light, light text in dark).
                color: "var(--c-high)",
                fontFamily: "var(--font-sans)",
                fontSize: 12.5,
                fontWeight: isActiveProvider ? 600 : 500,
              }}
            >
              <ProviderLogo tool={resolveDispatchTool(g.id)} size={12} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {g.label}
                </div>
                {g.subtitle && (
                  <div style={{ fontSize: 10, color: "var(--c-dim, #7a7a7a)" }}>{g.subtitle}</div>
                )}
              </div>
              {isActiveProvider && (
                <span
                  style={{
                    width: 5,
                    height: 5,
                    borderRadius: "50%",
                    background: "var(--c-high)",
                    flexShrink: 0,
                  }}
                />
              )}
            </button>
          );
        })}
      </div>

      {/* Models column */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          padding: 4,
          width: 240,
          height: 320,
          overflowY: "auto",
          borderRight: "1px solid var(--c-brd, rgba(255,255,255,0.08))",
        }}
      >
        <SectionHeader>Models</SectionHeader>
        {visibleGroup?.models.map((m) => {
          const active = model === m.id;
          return (
            <button
              key={m.id}
              role="option"
              aria-selected={active}
              aria-label={m.label}
              onClick={() => onPickModel(visibleGroup.id, m.id)}
              onMouseDown={(e) => e.preventDefault()}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                width: "100%",
                padding: "6px 10px",
                background: active ? "var(--c-srf, rgba(255,255,255,0.10))" : "transparent",
                border: "none",
                cursor: "pointer",
                textAlign: "left",
                outline: "none",
                borderRadius: 5,
              }}
              onMouseEnter={(e) => {
                if (!active) e.currentTarget.style.background = "var(--c-srf, rgba(255,255,255,0.06))";
              }}
              onMouseLeave={(e) => {
                if (!active) e.currentTarget.style.background = "transparent";
              }}
            >
              <span
                style={{
                  fontSize: 12.5,
                  color: active ? "var(--c-high, #ffffff)" : "var(--c-low, #c0c0c0)",
                  fontWeight: active ? 500 : 400,
                }}
              >
                {m.label}
              </span>
              <span style={{ display: "flex", alignItems: "center", gap: 7 }}>
                {m.ctx && (
                  <span style={{ fontSize: 10, color: "var(--c-ghost, #6a6a6a)", fontFamily: "var(--font-mono)" }}>
                    {m.ctx}
                  </span>
                )}
                {active && <Check size={10} style={{ color: "var(--c-dim, #9a9a9a)" }} />}
              </span>
            </button>
          );
        })}
      </div>

      {/* Effort column */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          padding: 4,
          width: 130,
          height: 320,
          opacity: effortEnabled ? 1 : 0.4,
          pointerEvents: effortEnabled ? "auto" : "none",
        }}
        title={effortEnabled ? undefined : "This model has no reasoning effort control"}
      >
        <SectionHeader>Effort</SectionHeader>
        {EFFORTS.map((e) => {
          const active = effort === e.id;
          return (
            <button
              key={e.id}
              disabled={!effortEnabled}
              onClick={() => onPickEffort(e.id)}
              onMouseDown={(ev) => ev.preventDefault()}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                width: "100%",
                padding: "6px 10px",
                background: active ? "var(--c-srf, rgba(255,255,255,0.10))" : "transparent",
                border: "none",
                cursor: effortEnabled ? "pointer" : "default",
                textAlign: "left",
                outline: "none",
                borderRadius: 5,
              }}
              onMouseEnter={(ev) => {
                if (effortEnabled && !active)
                  ev.currentTarget.style.background = "var(--c-srf, rgba(255,255,255,0.06))";
              }}
              onMouseLeave={(ev) => {
                if (effortEnabled && !active) ev.currentTarget.style.background = "transparent";
              }}
            >
              <span
                style={{
                  fontSize: 12.5,
                  color: active ? "var(--c-high, #ffffff)" : "var(--c-low, #c0c0c0)",
                  fontWeight: active ? 500 : 400,
                }}
              >
                {e.label}
              </span>
              {active && <Check size={10} style={{ color: "var(--c-dim, #9a9a9a)" }} />}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        padding: "4px 10px 6px",
        fontSize: 10.5,
        fontWeight: 500,
        letterSpacing: 0.3,
        textTransform: "uppercase",
        color: "var(--c-dim, #7a7a7a)",
      }}
    >
      {children}
    </div>
  );
}

const CLI_IDS = new Set(["claude", "codex", "gemini", "kimi"]);
function isCliId(id: string): boolean {
  return CLI_IDS.has(id);
}
