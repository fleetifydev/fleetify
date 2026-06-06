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
import { Check, ChevronDown } from "lucide-react";
import { ProviderLogo } from "@/components/ui/provider-logo";
import type { PickerGroup, PickerModel } from "@/lib/picker-groups";
import { resolveDispatchTool } from "@/lib/picker-groups";

export type Effort = "low" | "medium" | "high" | "extra_high" | "max";

/** Map capability level ids (xhigh, etc.) to their display labels.
 *  Falls back to capitalizing the raw level for values not in this table. */
const EFFORT_LABELS: Record<string, string> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

/** Translate a capability level id to the session's effort vocabulary. */
const capToSession = (lvl: string): string => (lvl === "xhigh" ? "extra_high" : lvl);
/** Translate the session's effort vocabulary back to a capability level id. */
const sessionToCap = (e: string): string => (e === "extra_high" ? "xhigh" : e);

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
  // Search query for the Models column — only surfaced for `searchable`
  // groups (e.g. OpenRouter's large live catalog). Reset on rail change.
  const [modelQuery, setModelQuery] = useState("");
  // Selected provider for groups that carry a provider dropdown (Hermes).
  // null when the active group has no providers.
  const [activeProvider, setActiveProvider] = useState<string | null>(null);
  // Whether the provider dropdown (above the models) is open.
  const [providerMenuOpen, setProviderMenuOpen] = useState(false);

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
  const eff = activeModel?.effort ?? { kind: "none" as const };
  const levels = (eff.kind === "levels" || eff.kind === "thinking_level") ? eff.levels : [];
  const effortEnabled = levels.length > 0;

  // Clear the filter whenever the active provider rail changes so switching
  // from OpenRouter back to a curated provider doesn't carry a stale query.
  useEffect(() => {
    setModelQuery("");
    setProviderMenuOpen(false);
  }, [activeGroupId]);

  // Default the provider chip selection (Hermes) to the active model's provider
  // when it belongs to this group, else the first provider. Keyed on a stable
  // provider-id string so it re-runs on rail / model / provider-set changes —
  // not on every render (visibleGroup is a fresh ref each time).
  const providerKey = (visibleGroup?.providers ?? []).map((p) => p.id).join(",");
  useEffect(() => {
    const provs = visibleGroup?.providers;
    const first = provs?.[0];
    if (!provs || !first) {
      setActiveProvider(null);
      return;
    }
    let next = first.id;
    if (model) {
      const i = model.indexOf(":");
      if (i > 0) {
        const slug = model.slice(0, i);
        if (provs.some((p) => p.id === slug)) next = slug;
      }
    }
    setActiveProvider(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeGroupId, model, providerKey]);

  const shownModels = useMemo(() => {
    let all = visibleGroup?.models ?? [];
    // Provider chip filter (Hermes): narrow to the selected provider's models
    // (ids are `provider:model`).
    if (visibleGroup?.providers && visibleGroup.providers.length > 0 && activeProvider) {
      all = all.filter((m) => {
        const i = m.id.indexOf(":");
        return i > 0 && m.id.slice(0, i) === activeProvider;
      });
    }
    const q = modelQuery.trim().toLowerCase();
    if (!visibleGroup?.searchable || !q) return all;
    return all.filter(
      (m) => m.label.toLowerCase().includes(q) || m.id.toLowerCase().includes(q),
    );
  }, [visibleGroup, modelQuery, activeProvider]);

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
          // The "auto" row is a one-click action (no model sub-list): it's
          // active whenever the session is in Auto mode, and clicking it
          // selects Auto directly instead of just switching the column.
          const isAuto = g.id === "auto";
          const isActiveProvider = isAuto
            ? model === "auto" || tool === "auto"
            : resolveDispatchTool(g.id) === tool && g.models.some((m) => m.id === model);
          return (
            <button
              key={g.id}
              onMouseEnter={() => setActiveGroupId(g.id)}
              onFocus={() => setActiveGroupId(g.id)}
              onClick={() => (isAuto ? onPickModel("auto", "auto") : setActiveGroupId(g.id))}
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
          borderRight: "1px solid var(--c-brd, rgba(255,255,255,0.08))",
        }}
      >
        <SectionHeader>Models</SectionHeader>
        {visibleGroup?.providers && visibleGroup.providers.length > 0 && (
          <div style={{ position: "relative", padding: "0 6px 6px" }}>
            <button
              aria-haspopup="listbox"
              aria-expanded={providerMenuOpen}
              onClick={() => setProviderMenuOpen((o) => !o)}
              onMouseDown={(e) => e.preventDefault()}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 6,
                width: "100%",
                padding: "5px 9px",
                background: "var(--c-srf, rgba(255,255,255,0.06))",
                border: "1px solid var(--c-brd, rgba(255,255,255,0.12))",
                borderRadius: 6,
                color: "var(--c-high)",
                fontFamily: "var(--font-sans)",
                fontSize: 11.5,
                fontWeight: 500,
                cursor: "pointer",
                outline: "none",
              }}
            >
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {visibleGroup.providers.find((p) => p.id === activeProvider)?.label ??
                  visibleGroup.providers[0]?.label ??
                  "Provider"}
              </span>
              <ChevronDown
                size={13}
                style={{
                  flexShrink: 0,
                  opacity: 0.6,
                  transform: providerMenuOpen ? "rotate(180deg)" : "none",
                  transition: "transform 0.12s ease",
                }}
              />
            </button>
            {providerMenuOpen && (
              <div
                role="listbox"
                aria-label="Provider"
                style={{
                  position: "absolute",
                  top: "calc(100% + 2px)",
                  left: 6,
                  right: 6,
                  zIndex: 5,
                  background: "var(--popover, #1a1a1a)",
                  border: "1px solid var(--c-brd, rgba(255,255,255,0.14))",
                  borderRadius: 6,
                  boxShadow: "0 10px 24px rgba(0,0,0,0.45)",
                  overflow: "hidden auto",
                  maxHeight: 220,
                }}
              >
                {visibleGroup.providers.map((p) => {
                  const isActive = activeProvider === p.id;
                  return (
                    <button
                      key={p.id}
                      role="option"
                      aria-selected={isActive}
                      onClick={() => {
                        setActiveProvider(p.id);
                        setProviderMenuOpen(false);
                      }}
                      onMouseDown={(e) => e.preventDefault()}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        width: "100%",
                        padding: "6px 9px",
                        background: isActive ? "var(--c-srf, rgba(255,255,255,0.10))" : "transparent",
                        border: "none",
                        color: isActive ? "var(--c-high)" : "var(--c-low)",
                        fontFamily: "var(--font-sans)",
                        fontSize: 11.5,
                        fontWeight: isActive ? 600 : 400,
                        cursor: "pointer",
                        textAlign: "left",
                        outline: "none",
                      }}
                      onMouseEnter={(e) => {
                        if (!isActive) e.currentTarget.style.background = "var(--c-srf, rgba(255,255,255,0.06))";
                      }}
                      onMouseLeave={(e) => {
                        if (!isActive) e.currentTarget.style.background = "transparent";
                      }}
                    >
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {p.label}
                      </span>
                      {isActive && <Check size={10} style={{ color: "var(--c-dim, #9a9a9a)", flexShrink: 0 }} />}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}
        {visibleGroup?.searchable && (
          <input
            autoFocus
            value={modelQuery}
            onChange={(e) => setModelQuery(e.target.value)}
            onKeyDown={(e) => {
              // Let Escape bubble to the menu's close handler; keep every
              // other key local so typing a query never trips app shortcuts.
              if (e.key !== "Escape") e.stopPropagation();
            }}
            placeholder="Search models…"
            aria-label="Search models"
            style={{
              margin: "0 6px 6px",
              padding: "5px 8px",
              fontSize: 12,
              color: "var(--c-high)",
              background: "var(--c-srf, rgba(255,255,255,0.06))",
              border: "1px solid var(--c-brd, rgba(255,255,255,0.10))",
              borderRadius: 6,
              outline: "none",
              fontFamily: "var(--font-sans)",
            }}
          />
        )}
        <div style={{ flex: 1, overflowY: "auto" }}>
          {shownModels.map((m) => {
            const active = model === m.id;
            return (
              <button
                key={m.id}
                role="option"
                aria-selected={active}
                aria-label={m.label}
                onClick={() => visibleGroup && onPickModel(visibleGroup.id, m.id)}
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
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {m.label}
                </span>
                <span style={{ display: "flex", alignItems: "center", gap: 7, flexShrink: 0 }}>
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
          {visibleGroup?.searchable && shownModels.length === 0 && (
            <div style={{ padding: "8px 10px", fontSize: 11.5, color: "var(--c-dim, #7a7a7a)" }}>
              No models match “{modelQuery.trim()}”.
            </div>
          )}
          {visibleGroup?.id === "auto" && (
            <div style={{ padding: "10px 12px", fontSize: 12, color: "var(--c-low)", lineHeight: 1.5 }}>
              Fleetify routes each message to the best model automatically (Not
              Diamond). Pick a provider on the left to choose a model yourself.
            </div>
          )}
        </div>
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
        {levels.map((level) => {
          const active = sessionToCap(effort) === level;
          const label = EFFORT_LABELS[level] ?? (level.charAt(0).toUpperCase() + level.slice(1));
          return (
            <button
              key={level}
              disabled={!effortEnabled}
              onClick={() => onPickEffort(capToSession(level) as Effort)}
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
                {label}
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

// Every CLI-agent group id (catalog `kind: cli`). Drives the rail's
// category grouping: all CLI agents share one block, so the divider only
// falls between CLI and the HTTP/API rail — NOT between, say, Kimi and
// GitHub Copilot. Must stay in sync with the CLI ProviderSpecs in the
// backend catalog (claude, codex, gemini, kimi, opencode, cursor,
// github-copilot, agy, antigravity-sdk); a missing id here mis-buckets that
// agent as HTTP and splits it off below the divider.
const CLI_IDS = new Set([
  "claude",
  "codex",
  "gemini",
  "kimi",
  "opencode",
  "cursor",
  "github-copilot",
  "agy",
  "antigravity-sdk",
]);
function isCliId(id: string): boolean {
  return CLI_IDS.has(id);
}
