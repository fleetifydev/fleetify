import type { ProviderTile } from "@/lib/providers-api";

export interface PickerModel {
  id: string;
  label: string;
  ctx?: string;
  note?: string;
  supports_effort: boolean;
}

export interface PickerGroup {
  id: string;
  label: string;
  /** Optional second line on the rail row — used to mark Perplexity
   *  marketplace rows as `via Perplexity` when a direct provider for
   *  the same brand also exists. */
  subtitle?: string;
  models: PickerModel[];
}

/** Short brand labels for the HTTP API rail. CLI tiles use the
 *  catalog's `display_name` verbatim ("Claude Code" etc.) — see
 *  `buildPickerGroups` below. */
const BRAND_SHORT: Record<string, string> = {
  openai: "OpenAI",
  deepseek: "DeepSeek",
  grok: "Grok",
  "nvidia-nim": "NVIDIA",
  "kimi-api": "Kimi",
  "gemini-api": "Gemini",
  perplexity: "Perplexity",
  ollama: "Ollama",
};

/** Brand splits applied to Perplexity Agent API marketplace ids.
 *  Order matches the rail-row order users expect. */
const PERPLEXITY_BRAND_PREFIXES: Array<{
  prefix: string;
  subId: string;
  label: string;
  directProviderId: string;
}> = [
  {
    prefix: "anthropic/",
    subId: "claude",
    label: "Claude",
    directProviderId: "anthropic" /* no direct provider today */,
  },
  { prefix: "openai/", subId: "gpt", label: "GPT", directProviderId: "openai" },
  { prefix: "google/", subId: "gemini", label: "Gemini", directProviderId: "gemini-api" },
  { prefix: "xai/", subId: "grok", label: "Grok", directProviderId: "grok" },
];

function modelFromSpec(m: {
  id: string;
  label: string;
  context_window?: string | null;
  note?: string | null;
  supports_effort: boolean;
}): PickerModel {
  return {
    id: m.id,
    label: m.label,
    ctx: m.context_window ?? undefined,
    note: m.note ?? undefined,
    supports_effort: m.supports_effort,
  };
}

export function buildPickerGroups(
  tiles: ProviderTile[],
  enabledAgentIds: string[],
): PickerGroup[] {
  const out: PickerGroup[] = [];

  // 1. CLI agents — filtered by enabledAgentIds, use display_name verbatim.
  for (const t of tiles) {
    if (t.spec.kind !== "cli") continue;
    if (!enabledAgentIds.includes(t.spec.id)) continue;
    out.push({
      id: t.spec.id,
      label: t.spec.display_name,
      models: t.spec.default_models.map(modelFromSpec),
    });
  }

  // 2. HTTP / local_http providers — only connected ones, short brand labels.
  //    Perplexity gets special handling: native Sonar entries stay here, the
  //    Agent marketplace entries are pulled out into per-brand groups below.
  const directBrandIds = new Set<string>();
  for (const t of tiles) {
    if (t.spec.kind !== "api" && t.spec.kind !== "local_http") continue;
    if (!t.connected && !t.has_key) continue;

    if (t.spec.id === "perplexity") {
      // Split: native Sonar stays here, marketplace entries are deferred.
      const native = t.spec.default_models
        .filter((m) => !m.id.includes("/"))
        .map(modelFromSpec);
      if (native.length > 0) {
        out.push({
          id: "perplexity",
          label: BRAND_SHORT["perplexity"] ?? "Perplexity",
          models: native,
        });
        directBrandIds.add("perplexity");
      }
      continue;
    }

    const models = t.spec.default_models.map(modelFromSpec);
    if (models.length === 0) continue;
    out.push({
      id: t.spec.id,
      label: BRAND_SHORT[t.spec.id] ?? t.spec.display_name,
      models,
    });
    directBrandIds.add(t.spec.id);
  }

  // 3. Perplexity Agent marketplace — brand-split into Claude / GPT / Gemini / Grok rows.
  const perplexityTile = tiles.find(
    (t) => t.spec.id === "perplexity" && (t.connected || t.has_key),
  );
  if (perplexityTile) {
    for (const { prefix, subId, label, directProviderId } of PERPLEXITY_BRAND_PREFIXES) {
      const models = perplexityTile.spec.default_models
        .filter((m) => m.id.startsWith(prefix))
        .map(modelFromSpec);
      if (models.length === 0) continue;
      const hasDirect = directBrandIds.has(directProviderId);
      out.push({
        id: `perplexity:${subId}`,
        label,
        subtitle: hasDirect ? "via Perplexity" : undefined,
        models,
      });
    }
  }

  return out;
}

/** Strip the `perplexity:brand` sub-id back to the catalog provider id
 *  the dispatch layer expects. Native ids pass through unchanged. */
export function resolveDispatchTool(groupId: string): string {
  return groupId.startsWith("perplexity:") ? "perplexity" : groupId;
}
