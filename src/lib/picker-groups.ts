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

/** Hardcoded model lists for the CLI agents whose backends bake models
 *  into the binary (so the registry can't ship them). When buildPickerGroups
 *  encounters a CLI tile whose catalog `default_models` is empty, it pulls
 *  the list from here instead. Mirrors src/components/chat/chat-input.tsx's
 *  CLAUDE_MODELS / CODEX_MODELS / GEMINI_MODELS (kept in sync by hand). */
const CLI_MODELS: Record<string, PickerModel[]> = {
  claude: [
    { id: "claude-opus-4-7",           label: "Opus 4.7",   ctx: "200K", supports_effort: true },
    { id: "claude-sonnet-4-6",         label: "Sonnet 4.6", ctx: "200K", supports_effort: true },
    { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5",  ctx: "200K", supports_effort: true },
  ],
  codex: [
    { id: "gpt-5.2", label: "GPT-5.2", ctx: "200K", supports_effort: true },
    { id: "gpt-5.4", label: "GPT-5.4", ctx: "200K", supports_effort: true },
    { id: "gpt-5.5", label: "GPT-5.5", ctx: "200K", supports_effort: true },
  ],
  gemini: [
    { id: "gemini-3.1-pro-preview",        label: "3.1 Pro",  ctx: "1M", supports_effort: true },
    { id: "gemini-3-flash-preview",        label: "3 Flash",  ctx: "1M", supports_effort: true },
    { id: "gemini-3.1-flash-lite-preview", label: "3.1 Lite", ctx: "1M", supports_effort: false },
  ],
  kimi: [
    { id: "kimi-k2.6",          label: "Kimi K2.6",          ctx: "256K", supports_effort: false },
    { id: "kimi-k2.6-thinking", label: "Kimi K2.6 Thinking", ctx: "256K", supports_effort: true },
    { id: "kimi-k2.6-agent",    label: "Kimi K2.6 Agent",    ctx: "256K", supports_effort: true },
  ],
};

/** Display names for the four CLI agents — matches each CLI ProviderSpec's
 *  catalog `display_name`. Used as fallback when `providerTiles` is empty
 *  (cold-start race or transient IPC failure) so the picker never shows a
 *  blank rail. */
const CLI_FALLBACK_LABELS: Record<string, string> = {
  claude: "Claude Code",
  codex:  "Codex CLI",
  gemini: "Gemini CLI",
  kimi:   "Kimi Code CLI",
};

/** Flat lookup of every CLI model id → its friendly label, derived from
 *  CLI_MODELS. Exported so callers (chip-face label resolution in the
 *  session toolbar) can avoid showing the raw model id when groups
 *  hasn't loaded yet. */
export const CLI_MODEL_LABELS: Record<string, string> = Object.values(CLI_MODELS)
  .flat()
  .reduce<Record<string, string>>((acc, m) => {
    acc[m.id] = m.label;
    return acc;
  }, {});

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
  //    CLI ProviderSpecs declare default_models: &[] because models live inside
  //    each CLI binary, not the registry. Fall back to CLI_MODELS when empty.
  const emittedCliIds = new Set<string>();
  for (const t of tiles) {
    if (t.spec.kind !== "cli") continue;
    if (!enabledAgentIds.includes(t.spec.id)) continue;
    const catalogModels = t.spec.default_models.map(modelFromSpec);
    const fallbackModels = CLI_MODELS[t.spec.id] ?? [];
    const models = catalogModels.length > 0 ? catalogModels : fallbackModels;
    out.push({
      id: t.spec.id,
      label: t.spec.display_name,
      models,
    });
    emittedCliIds.add(t.spec.id);
  }

  // Defensive fallback: if NO CLI tiles made it through (tiles was empty
  // due to a cold-start race or transient IPC failure) the picker would
  // render with a blank Providers rail + raw model ids on the chip face.
  // Emit all four known CLI agents from CLI_MODELS so the user always sees
  // a workable picker.
  //
  // We DON'T fill in only-some-missing CLI agents — if any CLI rail made
  // it through, the caller has a valid (possibly user-filtered) view and
  // we shouldn't second-guess it.
  if (emittedCliIds.size === 0) {
    for (const cliId of Object.keys(CLI_MODELS)) {
      const models = CLI_MODELS[cliId] ?? [];
      if (models.length === 0) continue;
      out.push({
        id: cliId,
        label: CLI_FALLBACK_LABELS[cliId] ?? cliId,
        models,
      });
    }
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
