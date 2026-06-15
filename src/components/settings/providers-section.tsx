/**
 * Settings → Providers — merges the legacy Agents and Models sections
 * behind a single page with internal tabs.
 *
 * Layout — one quiet "Sessions Default" card above the tabs:
 *   ┌───────────────────────────────────────────────────────────┐
 *   │ ◍  Sessions Default        [◍ Opus 4.8 · High ▾]  [✕]      │
 *   │    Pre-selected when you start a new session.              │
 *   ├──────────────────────────────────────────────────────────┤
 *   │ [Agents]  [Models]                                        │
 *   ├──────────────────────────────────────────────────────────┤
 *   │ <tab content — existing AgentsSection / ModelsSection>    │
 *   └───────────────────────────────────────────────────────────┘
 *
 * The card is a `DefaultSessionPicker`: a small provider logo + label/caption
 * on the left, then ONE dropdown-style trigger that opens the very same
 * three-column `UnifiedModelPicker` the chat composer / session toolbar use
 * (Providers | Models | Effort). Picking there sets the default provider,
 * model AND effort in one place — no more two separate native selects. A
 * reset (✕) button sits beside the trigger and clears the saved default once
 * one exists.
 *
 * It writes `sessionDefaultProvider` / `sessionDefaultModel` /
 * `sessionDefaultEffort`. `openComposer` prefers that triple (then the Fleet
 * `defaultProvider`/`defaultModel` set via the per-tile "Set as default"
 * buttons, then a hardcoded baseline), so new sessions open with a coherent
 * (provider, model, effort) selection. The per-tile default still lives on the
 * Agents/Models cards below; this card is the explicit new-session override.
 */
import { useState, useEffect, useCallback, useMemo } from "react";
import { ChevronDown, X } from "lucide-react";
import { useProvidersConfig } from "@/hooks/use-providers-config";
import { ProviderLogo } from "@/components/ui/provider-logo";
import {
  buildPickerGroups,
  resolveModelChip,
  resolveDispatchTool,
  type PickerGroup,
} from "@/lib/picker-groups";
import { effortLabel, type Effort } from "@/lib/effort";
import { UnifiedModelPicker } from "@/components/chat/unified-model-picker";
import { useDiscoveredModelsStore } from "@/stores/discovered-models-store";
import { useAppStore } from "@/stores/app-store";
import type { ProviderTile } from "@/lib/providers-api";
import { AgentsSection } from "./agents-section";
import { ModelsSection } from "./models-section";
import { StudioProvidersSection } from "./studio/studio-providers-section";
import { STUDIO_ENABLED } from "@/lib/feature-flags";

/** Narrowed view of the persisted config for the Sessions Default picker, so a
 *  read-merge-write preserves every other key without importing the full
 *  FleetConfig shape (mirrors notifications-card / privacy-card). */
type DefaultsCfg = {
  sessionDefaultProvider?: string;
  sessionDefaultModel?: string;
  sessionDefaultEffort?: string;
};
function cfgApi() {
  return (
    window as unknown as {
      electronAPI?: {
        getConfig?: () => Promise<(DefaultsCfg & Record<string, unknown>) | null>;
        setConfig?: (cfg: Record<string, unknown>) => Promise<unknown>;
      };
    }
  ).electronAPI;
}

type ProvidersTab = "agents" | "models";
type ProvidersMode = "workspace" | "studio";

const STORAGE_TAB = "fleet:settings:providers-tab";
const STORAGE_MODE = "fleet:settings:providers-mode";

function readTab(): ProvidersTab {
  try {
    const raw = localStorage.getItem(STORAGE_TAB);
    if (raw === "agents" || raw === "models") return raw;
  } catch { /* private mode */ }
  return "models";
}
function writeTab(v: ProvidersTab) {
  try { localStorage.setItem(STORAGE_TAB, v); } catch { /* private mode */ }
}

function readMode(): ProvidersMode {
  try {
    const raw = localStorage.getItem(STORAGE_MODE);
    if (raw === "workspace" || raw === "studio") return raw;
  } catch { /* private mode */ }
  return "workspace";
}
function writeMode(v: ProvidersMode) {
  try { localStorage.setItem(STORAGE_MODE, v); } catch { /* private mode */ }
}

export function ProvidersSection({ initialSubTab }: { initialSubTab?: ProvidersTab }) {
  const [tab, setTabState] = useState<ProvidersTab>(() => initialSubTab ?? readTab());
  const setTab = (v: ProvidersTab) => {
    setTabState(v);
    writeTab(v);
  };
  // Studio gated off → always Workspace; the mode bar is hidden too.
  const [mode, setModeState] = useState<ProvidersMode>(() => (STUDIO_ENABLED ? readMode() : "workspace"));
  const setMode = (v: ProvidersMode) => {
    setModeState(v);
    writeMode(v);
  };
  const { tiles } = useProvidersConfig();

  // The composer's active project path drives the project-scoped live model
  // probes (opencode/cursor/hermes); reuse it so Settings discovers the same
  // models the composer would. Empty string when no project is selected.
  const composerProjectPath = useAppStore((s) => s.composer.projectPath);

  // Provider dropdown options: every enabled tile, regardless of kind
  // (CLI agents, API providers, and Ollama are all eligible). Gates the
  // empty-state hint when nothing is connected yet.
  const eligible = tiles.filter((t) => t.connected);

  // Live, DISCOVERED model catalogs — the SAME source the chat composer's
  // picker uses, so Settings shows the current lineup (claude/codex/gemini/kimi
  // via `/agents/{id}/models`, OpenRouter via `/models`, opencode/cursor/hermes
  // via a live ACP probe) instead of the static CLI_MODELS / catalog fallback.
  // `hydrate` is single-flight per app run (no-op if the composer already ran
  // it); `discoverLive` (fired from the picker's onOpen below) adds the
  // live-probe agents. An absent key just falls back to the curated list.
  const discoveredModels = useDiscoveredModelsStore((s) => s.models);
  useEffect(() => {
    void useDiscoveredModelsStore.getState().hydrate(tiles);
  }, [tiles]);

  // The same picker groups the chat composer builds (Auto + CLI agents + the
  // discovered catalogs + connected HTTP providers), so the default picker
  // offers exactly what a session could dispatch — with the same up-to-date
  // model lists.
  const groups = useMemo(() => {
    const enabledAgentIds = tiles
      .filter((t) => t.spec.kind === "cli" && t.connected)
      .map((t) => t.spec.id);
    const dyn = Object.keys(discoveredModels).length > 0 ? discoveredModels : undefined;
    return buildPickerGroups(tiles, enabledAgentIds, dyn);
  }, [tiles, discoveredModels]);

  // The Sessions Default triple, read once and written through
  // getConfig→merge→setConfig so every other config key is preserved.
  const [cfg, setCfg] = useState<DefaultsCfg>({});
  useEffect(() => {
    let cancelled = false;
    cfgApi()
      ?.getConfig?.()
      .then((c) => {
        if (cancelled || !c) return;
        setCfg({
          sessionDefaultProvider: c.sessionDefaultProvider,
          sessionDefaultModel: c.sessionDefaultModel,
          sessionDefaultEffort: c.sessionDefaultEffort,
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  const writeCfg = useCallback(async (patch: DefaultsCfg) => {
    setCfg((prev) => ({ ...prev, ...patch })); // optimistic
    try {
      const cur = (await cfgApi()?.getConfig?.()) ?? {};
      // `setConfig` fully replaces the on-disk JSON (write-tmp + rename), so an
      // `undefined` key in the merged object is dropped by JSON serialization —
      // that's exactly how the reset button clears a default.
      await cfgApi()?.setConfig?.({ ...cur, ...patch });
    } catch {
      /* best effort — the optimistic update keeps the UI responsive */
    }
  }, []);

  const sessProvider = cfg.sessionDefaultProvider ?? "";
  const sessModel = cfg.sessionDefaultModel ?? "";
  const sessEffort = (cfg.sessionDefaultEffort as Effort) ?? "high";

  return (
    <>
      {/* Top-level mode selector — Workspace vs Studio (hidden while Studio is gated off) */}
      {STUDIO_ENABLED && <ModeBar mode={mode} onChange={setMode} />}

      {/* Sessions Default — only relevant in Workspace mode */}
      {mode === "workspace" && (
        <div
          style={{
            borderRadius: 10,
            border: "1px solid var(--c-brd)",
            background: "var(--card)",
            // visible (not hidden) so the UnifiedModelPicker popover can spill
            // below the card instead of being clipped by the rounded corners.
            overflow: "visible",
            marginBottom: 18,
          }}
        >
          <DefaultSessionPicker
            label="Sessions Default"
            caption="Pre-selected when you start a new session."
            providerId={sessProvider}
            modelId={sessModel}
            effort={sessEffort}
            groups={groups}
            hasEligible={eligible.length > 0}
            emptyHint="Enable a tile below to pick a session default."
            tiles={tiles}
            projectPath={composerProjectPath}
            onPick={(provider, model) => {
              void writeCfg({ sessionDefaultProvider: provider, sessionDefaultModel: model });
              void import("@/lib/posthog").then(({ capture }) => {
                capture("session_default_set", { provider_id: provider });
              });
            }}
            onPickEffort={(e) => {
              void writeCfg({ sessionDefaultEffort: e });
            }}
            onReset={() => {
              void writeCfg({
                sessionDefaultProvider: undefined,
                sessionDefaultModel: undefined,
                sessionDefaultEffort: undefined,
              });
            }}
          />
        </div>
      )}

      <TabBar tab={tab} onChange={setTab} />

      {mode === "workspace" ? (
        tab === "agents" ? <AgentsSection /> : <ModelsSection />
      ) : (
        tab === "agents" ? <StudioProvidersSection /> : <StudioApiEmpty />
      )}
    </>
  );
}

// ── Default session picker — one dropdown trigger + reset ────────────
// A small provider logo + label/caption on the left, then a single
// dropdown-style trigger on the right that opens the shared three-column
// UnifiedModelPicker (Providers | Models | Effort). The trigger face mirrors
// the chat composer's model chip (provider logo + model label + effort), and
// a reset (✕) button beside it clears the saved default once one exists.

function DefaultSessionPicker({
  label,
  caption,
  providerId,
  modelId,
  effort,
  groups,
  tiles,
  projectPath,
  hasEligible,
  emptyHint,
  onPick,
  onPickEffort,
  onReset,
}: {
  label: string;
  caption: string;
  providerId: string;
  modelId: string;
  effort: Effort;
  groups: PickerGroup[];
  tiles: ProviderTile[];
  projectPath: string;
  hasEligible: boolean;
  emptyHint: string;
  /** (provider, model) — provider is the dispatch tool id; "auto"/"auto" for Auto. */
  onPick: (provider: string, model: string) => void;
  onPickEffort: (effort: Effort) => void;
  onReset: () => void;
}) {
  const [open, setOpen] = useState(false);

  // Mirror the composer (chat-input.tsx): re-run the project-scoped live model
  // probes whenever the picker is open and the tiles / project path change, so
  // the live-probe agents (opencode/cursor/hermes) resolve the same up-to-date
  // models — instead of a one-shot probe on click that can miss late-loading
  // tiles or run with no project context.
  useEffect(() => {
    if (open) void useDiscoveredModelsStore.getState().discoverLive(tiles, projectPath);
  }, [open, tiles, projectPath]);
  const hasSelection = providerId !== "";

  // Chip face — resolved the SAME way as the composer/toolbar chip so the
  // logo + label always agree with what the picker shows.
  const chip = resolveModelChip(groups, providerId || "claude-code", modelId || null);

  // Show the effort suffix only when the selected model actually exposes an
  // effort lever (the picker's Effort column is disabled otherwise) — saves
  // showing a meaningless "· High" on CLI models that ignore effort.
  const activeModel = useMemo(
    () => groups.flatMap((g) => g.models).find((m) => m.id === modelId),
    [groups, modelId],
  );
  const showEffort = hasSelection && providerId !== "auto" && !!activeModel?.supports_effort;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "13px 16px",
        // Anchor for the absolutely-positioned UnifiedModelPicker popover
        // (it pins itself to `left: 0` of the nearest positioned ancestor).
        position: "relative",
      }}
    >
      <ProviderLogo tool={hasSelection ? chip.dispatchTool : "claude-code"} size={20} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--c-high)" }}>{label}</div>
        <div style={{ fontSize: 11.5, color: "var(--c-dim)", marginTop: 1 }}>{caption}</div>
      </div>

      {hasEligible ? (
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
          <button
            // Marks this as the picker's trigger so its outside-click handler
            // ignores clicks here (otherwise click-to-close races click-to-open).
            data-model-trigger="1"
            aria-haspopup="menu"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            onMouseDown={(e) => e.preventDefault()}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
              minWidth: 210,
              maxWidth: 340,
              boxSizing: "border-box",
              background: "var(--c-srf)",
              border: `1px solid ${open ? "var(--c-brd2)" : "var(--c-brd)"}`,
              borderRadius: 7,
              padding: "7px 10px",
              fontSize: 12.5,
              color: "var(--c-high)",
              fontFamily: "inherit",
              cursor: "pointer",
              outline: "none",
              transition: "border-color 0.12s",
            }}
            onMouseEnter={(e) => {
              if (!open) e.currentTarget.style.borderColor = "var(--c-brd2)";
            }}
            onMouseLeave={(e) => {
              if (!open) e.currentTarget.style.borderColor = "var(--c-brd)";
            }}
          >
            <span style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
              {hasSelection ? (
                <>
                  <ProviderLogo tool={chip.dispatchTool} size={14} />
                  <span
                    style={{
                      color: "var(--c-high)",
                      fontWeight: 500,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {chip.label}
                  </span>
                  {showEffort && (
                    <>
                      <span style={{ color: "var(--c-dim)", fontSize: 10, flexShrink: 0 }}>·</span>
                      <span style={{ color: "var(--c-low)", fontSize: 11, flexShrink: 0 }}>
                        {effortLabel(effort)}
                      </span>
                    </>
                  )}
                </>
              ) : (
                <span style={{ color: "var(--c-low)" }}>Pick a default…</span>
              )}
            </span>
            <ChevronDown
              size={13}
              strokeWidth={2}
              style={{
                flexShrink: 0,
                color: "var(--c-low)",
                transform: open ? "rotate(180deg)" : "none",
                transition: "transform 0.15s",
              }}
            />
          </button>

          {/* Reset — only once a default exists. Clears all three keys. */}
          {hasSelection && (
            <button
              title="Clear session default"
              aria-label="Clear session default"
              onClick={() => {
                onReset();
                setOpen(false);
              }}
              onMouseDown={(e) => e.preventDefault()}
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                width: 30,
                height: 30,
                boxSizing: "border-box",
                background: "var(--c-srf)",
                border: "1px solid var(--c-brd)",
                borderRadius: 7,
                color: "var(--c-low)",
                cursor: "pointer",
                outline: "none",
                transition: "color 0.12s, border-color 0.12s",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = "var(--c-high)";
                e.currentTarget.style.borderColor = "var(--c-brd2)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = "var(--c-low)";
                e.currentTarget.style.borderColor = "var(--c-brd)";
              }}
            >
              <X size={14} strokeWidth={2} />
            </button>
          )}
        </div>
      ) : (
        <span style={{ fontSize: 12, color: "var(--c-low)" }}>{emptyHint}</span>
      )}

      {/* Popover — the shared three-column picker. Anchored to this row
          (position: relative above), opens DOWNWARD and right-aligned so it
          hangs under the right-side trigger instead of the card's far left.
          Selections don't close it; the trigger / outside-click / Escape do. */}
      {open && hasEligible && (
        <UnifiedModelPicker
          tool={providerId || "claude-code"}
          model={modelId || null}
          effort={effort}
          groups={groups}
          onPickModel={(groupId, mId) => {
            if (groupId === "auto") {
              onPick("auto", "auto");
              return;
            }
            onPick(resolveDispatchTool(groupId), mId);
          }}
          onPickEffort={onPickEffort}
          onClose={() => setOpen(false)}
          anchor="top"
          align="right"
        />
      )}
    </div>
  );
}

// ── Mode bar (Workspace | Studio) ────────────────────────────────

function ModeBar({
  mode,
  onChange,
}: {
  mode: ProvidersMode;
  onChange: (v: ProvidersMode) => void;
}) {
  return (
    <div
      role="tablist"
      style={{
        display: "flex",
        gap: 4,
        borderBottom: "1px solid var(--c-brd)",
        marginBottom: 18,
      }}
    >
      <TabButton active={mode === "workspace"} onClick={() => onChange("workspace")}>Workspace</TabButton>
      <TabButton active={mode === "studio"} onClick={() => onChange("studio")}>Studio</TabButton>
    </div>
  );
}

// ── Sub-tab bar (Providers | API) ────────────────────────────────

function TabBar({
  tab,
  onChange,
}: {
  tab: ProvidersTab;
  onChange: (v: ProvidersTab) => void;
}) {
  return (
    <div
      role="tablist"
      style={{
        display: "flex",
        gap: 4,
        borderBottom: "1px solid var(--c-brd)",
        marginBottom: 18,
      }}
    >
      <TabButton active={tab === "agents"} onClick={() => onChange("agents")}>Providers</TabButton>
      <TabButton active={tab === "models"} onClick={() => onChange("models")}>API</TabButton>
    </div>
  );
}

// ── Studio → API placeholder ─────────────────────────────────────

function StudioApiEmpty() {
  return (
    <div style={{ fontSize: 13, color: "var(--c-low)", padding: "12px 2px" }}>
      No API providers yet.
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      role="tab"
      aria-selected={active}
      onClick={onClick}
      style={{
        padding: "9px 14px",
        background: "transparent",
        border: "none",
        borderBottom: active ? "2px solid var(--c-high)" : "2px solid transparent",
        marginBottom: -1,
        color: active ? "var(--c-high)" : "var(--c-low)",
        fontSize: 13,
        fontWeight: active ? 600 : 500,
        cursor: "pointer",
        fontFamily: "inherit",
        outline: "none",
        transition: "color 0.12s, border-color 0.12s",
      }}
      onMouseEnter={(e) => {
        if (!active) e.currentTarget.style.color = "var(--c-high)";
      }}
      onMouseLeave={(e) => {
        if (!active) e.currentTarget.style.color = "var(--c-low)";
      }}
    >
      {children}
    </button>
  );
}
