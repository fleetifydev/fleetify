/**
 * Settings → Providers — merges the legacy Agents and Models sections
 * behind a single page with internal tabs.
 *
 * Layout:
 *   ┌───────────────────────────────────────────────────────────┐
 *   │ FLEET DEFAULT                                             │
 *   │ <ProviderLogo>  <display_name>           [Change ▾]       │
 *   │                                                           │
 *   │ Defaults open new chats with this provider/model pair.    │
 *   │ Any tile — CLI agent OR API provider — can be the         │
 *   │ default. Toggling a tile off in the lists below removes   │
 *   │ it from the picker (and from this dropdown).              │
 *   ├──────────────────────────────────────────────────────────┤
 *   │ [Agents]  [Models]                                        │
 *   ├──────────────────────────────────────────────────────────┤
 *   │ <tab content — existing AgentsSection / ModelsSection>    │
 *   └───────────────────────────────────────────────────────────┘
 *
 * The "Change" dropdown lists every catalog provider where the user
 * has explicitly enabled the tile (`tile.connected === true`). That
 * gating matches the chat composer's picker filter so the default
 * dropdown only offers providers that would actually dispatch — no
 * "pick provider X, get an immediate auth error on next message"
 * footgun. Writes through `providers.setDefault(id)` (the IPC that
 * also seeds `defaultModel` from the spec's first default model),
 * so the chat composer's `openComposer` opens new chats with a
 * coherent (provider, model) pair regardless of which kind was
 * picked here.
 */
import { useState } from "react";
import { useProvidersConfig } from "@/hooks/use-providers-config";
import { ProviderLogo } from "@/components/ui/provider-logo";
import { AgentsSection } from "./agents-section";
import { ModelsSection } from "./models-section";

type ProvidersTab = "agents" | "models";

const STORAGE_TAB = "fleet:settings:providers-tab";

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

export function ProvidersSection({ initialSubTab }: { initialSubTab?: ProvidersTab }) {
  const [tab, setTabState] = useState<ProvidersTab>(() => initialSubTab ?? readTab());
  const setTab = (v: ProvidersTab) => {
    setTabState(v);
    writeTab(v);
  };
  const { tiles, setDefault } = useProvidersConfig();

  const defaultTile = tiles.find((t) => t.is_default);
  // Default dropdown options: every enabled tile, regardless of kind.
  // Matches the user spec — CLI agents AND API providers AND Ollama
  // are all eligible defaults.
  const eligible = tiles.filter((t) => t.connected);

  return (
    <>
      <FleetDefaultCard
        defaultTile={defaultTile}
        eligible={eligible}
        onPick={(id) => {
          void setDefault(id);
          void import("@/lib/posthog").then(({ capture }) => {
            capture("default_provider_set", { provider_id: id });
          });
        }}
      />

      <TabBar tab={tab} onChange={setTab} />

      {tab === "agents" ? <AgentsSection /> : <ModelsSection />}
    </>
  );
}

// ── Fleet default card — current pick + picker dropdown ──────────

function FleetDefaultCard({
  defaultTile,
  eligible,
  onPick,
}: {
  defaultTile: ReturnType<typeof useProvidersConfig>["tiles"][number] | undefined;
  eligible: ReturnType<typeof useProvidersConfig>["tiles"];
  onPick: (id: string) => void;
}) {
  const fallbackId = defaultTile?.spec.id ?? eligible[0]?.spec.id ?? "";
  return (
    <div
      style={{
        borderRadius: 10,
        border: "1px solid var(--c-brd)",
        background: "var(--card)",
        overflow: "hidden",
        marginBottom: 18,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "14px 16px" }}>
        <ProviderLogo tool={fallbackId || "claude"} size={26} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 10.5,
              fontWeight: 600,
              letterSpacing: "0.10em",
              color: "var(--c-dim)",
              textTransform: "uppercase",
              marginBottom: 3,
            }}
          >
            Fleet Default
          </div>
          <div style={{ fontSize: 14, fontWeight: 500, color: "var(--c-high)" }}>
            {defaultTile?.spec.display_name ?? (
              <span style={{ color: "var(--c-low)" }}>Not set — pick one to the right</span>
            )}
          </div>
        </div>
        {eligible.length > 0 ? (
          <DefaultSelect
            value={defaultTile?.spec.id ?? ""}
            options={eligible.map((t) => ({
              value: t.spec.id,
              label: t.spec.display_name,
              kind: t.spec.kind,
            }))}
            onChange={onPick}
          />
        ) : (
          <span style={{ fontSize: 12, color: "var(--c-low)" }}>
            Enable a tile below to set a default.
          </span>
        )}
      </div>
      <div
        style={{
          padding: "10px 16px 12px 16px",
          borderTop: "1px solid var(--c-brd)",
          fontSize: 12,
          color: "var(--c-low)",
          lineHeight: 1.55,
        }}
      >
        New chats open with this provider and its top-ranked model. Any
        tile below — CLI agent or API provider — can be the default;
        toggling a tile off removes it from the picker and from this list.
      </div>
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

// ── Tab bar ──────────────────────────────────────────────────────

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
      <TabButton active={tab === "agents"} onClick={() => onChange("agents")}>Agents</TabButton>
      <TabButton active={tab === "models"} onClick={() => onChange("models")}>Models</TabButton>
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
