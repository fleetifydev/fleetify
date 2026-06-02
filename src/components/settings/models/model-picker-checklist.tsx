/**
 * The "Available models in picker" checklist shared by ProviderCard and
 * CloudflareConfigCard. Lists every model a provider exposes — for providers
 * with live discovery (OpenRouter, Cloudflare Workers AI) that's the full
 * fetched catalog (hundreds of entries); otherwise the static curated list —
 * each with an enable/disable checkbox, plus a search box to filter large
 * lists. Toggling persists the explicit enabled set via `setEnabledModels`.
 */
import { useEffect, useState } from "react";
import { type ProviderTile } from "@/lib/providers-api";
import { useProvidersConfig } from "@/hooks/use-providers-config";
import { fetchProviderModels } from "@/lib/api";

/** Providers whose real catalog is fetched at runtime from the backend's
 *  `/providers/{id}/models` proxy rather than curated statically. */
const PROVIDERS_WITH_LIVE_DISCOVERY = ["openrouter", "cloudflare-workers-ai"];

export type CardModel = {
  id: string;
  label: string;
  // Static catalog entries may carry an explicit `null` (not just absent), so
  // allow it alongside `undefined` to match the registry's ModelSpec shape.
  context_window?: string | null;
  note?: string | null;
  group?: string | null;
};

/**
 * The effective model catalog for a provider tile: the live discovered list
 * when available (and the provider is connected), else the static curated
 * catalog from the registry. The fetch runs only for discovery-capable
 * providers and degrades to the static list on any failure. Returned fresh
 * each render; callers read `.length` for headers and pass it to the checklist.
 */
export function useEffectiveModels(tile: ProviderTile, connected: boolean): CardModel[] {
  const [liveModels, setLiveModels] = useState<
    { id: string; label: string; ctx?: string }[] | null
  >(null);

  useEffect(() => {
    if (!PROVIDERS_WITH_LIVE_DISCOVERY.includes(tile.spec.id) || !connected) return;
    let cancelled = false;
    void fetchProviderModels(tile.spec.id).then((models) => {
      // Async resolve (not a synchronous effect setState) → empty keeps static.
      if (!cancelled && models.length > 0) setLiveModels(models);
    });
    return () => {
      cancelled = true;
    };
  }, [tile.spec.id, connected]);

  return liveModels
    ? liveModels.map((m) => ({ id: m.id, label: m.label, context_window: m.ctx }))
    : tile.spec.default_models.map((m) => ({
        id: m.id,
        label: m.label,
        context_window: m.context_window,
        note: m.note,
        group: m.group,
      }));
}

const searchInputStyle: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  background: "var(--c-srf)",
  border: "1px solid var(--c-brd)",
  borderRadius: 7,
  padding: "7px 10px",
  fontSize: 12.5,
  color: "var(--c-high)",
  outline: "none",
  marginBottom: 8,
};

export function ModelPickerChecklist({
  tile,
  models,
}: {
  tile: ProviderTile;
  models: CardModel[];
}) {
  const { setEnabledModels } = useProvidersConfig();
  const [search, setSearch] = useState("");

  const allModelIds = models.map((m) => m.id);
  // Empty `enabled_models` means "all enabled" — fall back to the full list so
  // every checkbox reads as on until the user narrows the selection.
  const enabled = tile.enabled_models.length > 0 ? tile.enabled_models : allModelIds;

  const onToggleModel = async (modelId: string) => {
    const next = new Set(enabled);
    if (next.has(modelId)) next.delete(modelId);
    else next.add(modelId);
    await setEnabledModels(tile.spec.id, Array.from(next));
  };

  if (models.length === 0) return null;

  const q = search.trim().toLowerCase();
  const filtered = q
    ? models.filter(
        (m) => m.id.toLowerCase().includes(q) || m.label.toLowerCase().includes(q),
      )
    : models;

  // Bucket by `group` so grouped catalogs (e.g. Perplexity) keep their
  // sub-headers; live entries carry no group → a single flat bucket.
  const buckets = new Map<string, CardModel[]>();
  for (const m of filtered) {
    const key = m.group ?? "";
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(m);
  }

  return (
    <div style={{ padding: "12px 0 4px 0", borderTop: "1px solid var(--c-brd)" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          marginBottom: 8,
        }}
      >
        <div style={{ fontSize: 12, fontWeight: 500, color: "var(--c-high)" }}>
          Available models in picker
        </div>
        <div style={{ fontSize: 11, color: "var(--c-dim)" }}>
          {enabled.length}/{models.length} enabled
        </div>
      </div>

      {/* Large catalogs (OpenRouter ~343, Cloudflare ~50) are unmanageable as a
          flat checklist — filter by id or label. */}
      {models.length > 12 && (
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={`Search ${models.length} models…`}
          spellCheck={false}
          autoComplete="off"
          style={searchInputStyle}
        />
      )}

      {filtered.length === 0 ? (
        <div style={{ fontSize: 12, color: "var(--c-dim)", padding: "6px 0" }}>
          No models match “{search.trim()}”.
        </div>
      ) : (
        Array.from(buckets.entries()).map(([groupName, groupModels]) => (
          <div key={groupName || "__flat"} style={{ marginBottom: 12 }}>
            {groupName && (
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  letterSpacing: "0.06em",
                  color: "var(--c-dim)",
                  textTransform: "uppercase",
                  margin: "6px 0",
                }}
              >
                {groupName}
              </div>
            )}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 6 }}>
              {groupModels.map((m) => {
                const checked = enabled.includes(m.id);
                return (
                  <label
                    key={m.id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "6px 8px",
                      borderRadius: 6,
                      cursor: "pointer",
                      fontSize: 12,
                      color: "var(--c-high)",
                      background: checked ? "var(--c-srf)" : "transparent",
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => onToggleModel(m.id)}
                      style={{ cursor: "pointer" }}
                    />
                    <span
                      style={{
                        flex: 1,
                        minWidth: 0,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {m.label}
                    </span>
                    {m.context_window && (
                      <span style={{ fontSize: 10, color: "var(--c-dim)" }}>
                        {m.context_window}
                      </span>
                    )}
                    {m.note && (
                      <span
                        style={{
                          fontSize: 9.5,
                          fontWeight: 600,
                          letterSpacing: "0.04em",
                          color: "var(--c-dim)",
                          textTransform: "uppercase",
                        }}
                      >
                        {m.note}
                      </span>
                    )}
                  </label>
                );
              })}
            </div>
          </div>
        ))
      )}
    </div>
  );
}
