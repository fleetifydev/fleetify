/**
 * Settings → Providers — merges the legacy Agents and Models sections
 * behind a single page with internal tabs.
 *
 * Layout — one quiet "Sessions Default" card above the tabs:
 *   ┌───────────────────────────────────────────────────────────┐
 *   │ ◍  Sessions Default              [Provider ▾] [Model ▾]    │
 *   │    Pre-selected when you start a new session.              │
 *   ├──────────────────────────────────────────────────────────┤
 *   │ [Agents]  [Models]                                        │
 *   ├──────────────────────────────────────────────────────────┤
 *   │ <tab content — existing AgentsSection / ModelsSection>    │
 *   └───────────────────────────────────────────────────────────┘
 *
 * The card is a `DefaultPairRow` (small provider logo + label/caption, then a
 * provider dropdown + a model dropdown). The provider dropdown lists every
 * enabled tile (`tile.connected === true`) — matching the chat composer's
 * picker filter so a default can always dispatch — and the model dropdown
 * lists that provider's models (the same list the chat picker builds, with
 * CLI fallbacks).
 *
 * It writes `sessionDefaultProvider` / `sessionDefaultModel`. `openComposer`
 * prefers that pair (then the Fleet `defaultProvider`/`defaultModel` set via
 * the per-tile "Set as default" buttons, then a hardcoded baseline), so new
 * sessions open with a coherent (provider, model) pair. The per-tile default
 * still lives on the Agents/Models cards below; this card is the explicit
 * new-session override.
 */
import { useState, useEffect, useCallback, useMemo } from "react";
import { useProvidersConfig } from "@/hooks/use-providers-config";
import { ProviderLogo } from "@/components/ui/provider-logo";
import { buildPickerGroups, type PickerModel } from "@/lib/picker-groups";
import { AgentsSection } from "./agents-section";
import { ModelsSection } from "./models-section";
import { StudioProvidersSection } from "./studio/studio-providers-section";

/** Narrowed view of the persisted config for the Sessions Default picker, so a
 *  read-merge-write preserves every other key without importing the full
 *  FleetConfig shape (mirrors notifications-card / privacy-card). */
type DefaultsCfg = {
  sessionDefaultProvider?: string;
  sessionDefaultModel?: string;
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
  const [mode, setModeState] = useState<ProvidersMode>(readMode);
  const setMode = (v: ProvidersMode) => {
    setModeState(v);
    writeMode(v);
  };
  const { tiles } = useProvidersConfig();

  // Provider dropdown options: every enabled tile, regardless of kind
  // (CLI agents, API providers, and Ollama are all eligible).
  const eligible = tiles.filter((t) => t.connected);

  // Per-provider model list (with the CLI fallbacks the chat picker uses) so
  // the model dropdowns offer exactly what a session could dispatch.
  const groups = useMemo(
    () =>
      buildPickerGroups(
        tiles,
        tiles.filter((t) => t.spec.kind === "cli" && t.connected).map((t) => t.spec.id),
      ),
    [tiles],
  );
  const modelsForProvider = useCallback(
    (id: string): PickerModel[] => groups.find((g) => g.id === id)?.models ?? [],
    [groups],
  );

  // The Sessions Default pair, read once and written through
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
      await cfgApi()?.setConfig?.({ ...cur, ...patch });
    } catch {
      /* best effort — the optimistic update keeps the UI responsive */
    }
  }, []);

  const sessProvider = cfg.sessionDefaultProvider ?? "";
  const sessModel = cfg.sessionDefaultModel ?? "";

  return (
    <>
      {/* Top-level mode selector — Workspace vs Studio */}
      <ModeBar mode={mode} onChange={setMode} />

      {/* Sessions Default — only relevant in Workspace mode */}
      {mode === "workspace" && (
        <div
          style={{
            borderRadius: 10,
            border: "1px solid var(--c-brd)",
            background: "var(--card)",
            overflow: "hidden",
            marginBottom: 18,
          }}
        >
          <DefaultPairRow
            label="Sessions Default"
            caption="Pre-selected when you start a new session."
            providerId={sessProvider}
            modelId={sessModel}
            eligible={eligible}
            modelsForProvider={modelsForProvider}
            onPickProvider={(id) => {
              void writeCfg({ sessionDefaultProvider: id, sessionDefaultModel: modelsForProvider(id)[0]?.id });
              void import("@/lib/posthog").then(({ capture }) => {
                capture("session_default_set", { provider_id: id });
              });
            }}
            onPickModel={(mid) => {
              void writeCfg({ sessionDefaultModel: mid });
            }}
            emptyHint="Enable a tile below to pick a session default."
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

// ── Default pair row — provider + model dropdowns for one named default ──
// Rendered twice (Sessions Default over Fleet Default) inside a single card.
// A small provider logo + the label/caption on the left, the two dropdowns on
// the right — kept deliberately plain so the two rows read as one tidy block.

function DefaultPairRow({
  label,
  caption,
  providerId,
  modelId,
  eligible,
  modelsForProvider,
  onPickProvider,
  onPickModel,
  emptyHint,
}: {
  label: string;
  caption: string;
  providerId: string;
  modelId: string;
  eligible: ReturnType<typeof useProvidersConfig>["tiles"];
  modelsForProvider: (id: string) => PickerModel[];
  onPickProvider: (id: string) => void;
  onPickModel: (id: string) => void;
  emptyHint: string;
}) {
  const models = providerId ? modelsForProvider(providerId) : [];
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "13px 16px" }}>
      <ProviderLogo tool={providerId || "claude"} size={20} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--c-high)" }}>{label}</div>
        <div style={{ fontSize: 11.5, color: "var(--c-dim)", marginTop: 1 }}>{caption}</div>
      </div>
      {eligible.length > 0 ? (
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
          <DefaultSelect
            value={providerId}
            options={eligible.map((t) => ({
              value: t.spec.id,
              label: t.spec.display_name,
              kind: t.spec.kind,
            }))}
            onChange={onPickProvider}
          />
          <ModelSelect value={modelId} options={models} onChange={onPickModel} />
        </div>
      ) : (
        <span style={{ fontSize: 12, color: "var(--c-low)" }}>{emptyHint}</span>
      )}
    </div>
  );
}

// ── Picker dropdown — native select styled to match settings inputs ──

function DefaultSelect({
  value,
  options,
  onChange,
}: {
  value: string;
  options: { value: string; label: string; kind: "api" | "cli" | "local_http" }[];
  onChange: (id: string) => void;
}) {
  // Group by kind so the dropdown reads like the tab layout below.
  // optgroup labels mirror the tab names so a user scanning the
  // dropdown sees the same vocabulary on both surfaces.
  const cliOptions = options.filter((o) => o.kind === "cli");
  const apiOptions = options.filter((o) => o.kind === "api");
  const localOptions = options.filter((o) => o.kind === "local_http");
  return (
    <div style={{ position: "relative", minWidth: 200 }}>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{
          width: "100%",
          boxSizing: "border-box",
          appearance: "none",
          background: "var(--c-srf)",
          border: "1px solid var(--c-brd)",
          borderRadius: 7,
          padding: "7px 28px 7px 12px",
          fontSize: 12.5,
          color: "var(--c-high)",
          fontFamily: "inherit",
          outline: "none",
          cursor: "pointer",
          transition: "border-color 0.12s",
        }}
        onFocus={(e) => (e.currentTarget.style.borderColor = "var(--c-brd2)")}
        onBlur={(e) => (e.currentTarget.style.borderColor = "var(--c-brd)")}
      >
        {value === "" && <option value="">Pick a default…</option>}
        {cliOptions.length > 0 && (
          <optgroup label="Agents">
            {cliOptions.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </optgroup>
        )}
        {apiOptions.length > 0 && (
          <optgroup label="Models">
            {apiOptions.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </optgroup>
        )}
        {localOptions.length > 0 && (
          <optgroup label="Local">
            {localOptions.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </optgroup>
        )}
      </select>
      <span
        style={{
          position: "absolute",
          right: 10,
          top: "50%",
          transform: "translateY(-65%) rotate(45deg)",
          width: 6,
          height: 6,
          borderRight: "1.5px solid var(--c-low)",
          borderBottom: "1.5px solid var(--c-low)",
          pointerEvents: "none",
        }}
      />
    </div>
  );
}

// ── Model dropdown — the selected provider's models as a flat list ──

function ModelSelect({
  value,
  options,
  onChange,
}: {
  value: string;
  options: PickerModel[];
  onChange: (id: string) => void;
}) {
  const disabled = options.length === 0;
  return (
    <div style={{ position: "relative", minWidth: 170 }}>
      <select
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        style={{
          width: "100%",
          boxSizing: "border-box",
          appearance: "none",
          background: "var(--c-srf)",
          border: "1px solid var(--c-brd)",
          borderRadius: 7,
          padding: "7px 28px 7px 12px",
          fontSize: 12.5,
          color: "var(--c-high)",
          fontFamily: "inherit",
          outline: "none",
          cursor: disabled ? "default" : "pointer",
          opacity: disabled ? 0.5 : 1,
          transition: "border-color 0.12s",
        }}
        onFocus={(e) => (e.currentTarget.style.borderColor = "var(--c-brd2)")}
        onBlur={(e) => (e.currentTarget.style.borderColor = "var(--c-brd)")}
      >
        {disabled && <option value="">No models</option>}
        {!disabled && value === "" && <option value="">Pick a model…</option>}
        {options.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
          </option>
        ))}
      </select>
      <span
        style={{
          position: "absolute",
          right: 10,
          top: "50%",
          transform: "translateY(-65%) rotate(45deg)",
          width: 6,
          height: 6,
          borderRight: "1.5px solid var(--c-low)",
          borderBottom: "1.5px solid var(--c-low)",
          pointerEvents: "none",
        }}
      />
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
