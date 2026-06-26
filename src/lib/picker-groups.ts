import type { ProviderTile, EffortCapability } from "@/lib/providers-api";
import { resolveSessionModel } from "@/lib/model-resolution";

export interface PickerModel {
  id: string;
  label: string;
  ctx?: string;
  note?: string;
  /** Capability descriptor driving the Effort column in UnifiedModelPicker.
   *  `supports_effort` is derived from this (true iff kind !== "none") and kept
   *  for backwards compatibility with any consumer that still reads it directly. */
  effort: EffortCapability;
  supports_effort: boolean;
  /** True when the backend catalog flags this as the lineup's default model. */
  default?: boolean;
  /** Catalog availability (the remote catalog's `active` field). `false` ⇒
   *  retired: shown disabled in the picker and rejected at send. */
  active?: boolean;
  /** Catalog sort weight. Higher floats the model toward the top of its
   *  provider's list; ties keep catalog order. Absent ⇒ 0. */
  priority?: number;
}

export interface PickerGroup {
  id: string;
  label: string;
  /** Optional second line on the rail row — used to mark Perplexity
   *  marketplace rows as `via Perplexity` when a direct provider for
   *  the same brand also exists. */
  subtitle?: string;
  models: PickerModel[];
  /** When true, the picker renders a search box above the model list — set
   *  for providers whose catalog is large (e.g. OpenRouter's live list) so
   *  users can filter instead of scrolling hundreds of rows. */
  searchable?: boolean;
  /** Optional per-provider grouping. When present (and length > 1), the picker
   *  renders a provider chip-row above the models and filters the list to the
   *  selected provider. Used by Hermes, whose model ids are `provider:model`
   *  (e.g. `copilot:claude-opus-4.8`) so one agent fans out across the
   *  providers its `hermes model` config has authenticated. */
  providers?: Array<{ id: string; label: string }>;
}

/** Hardcoded model lists for the CLI agents whose backends bake models
 *  into the binary (so the registry can't ship them). When buildPickerGroups
 *  encounters a CLI tile whose catalog `default_models` is empty, it pulls
 *  the list from here instead. Mirrors src/components/chat/chat-input.tsx's
 *  CLAUDE_MODELS / CODEX_MODELS (kept in sync by hand). */
/** Reusable no-effort descriptor for models that expose no effort lever. */
const EFFORT_NONE: EffortCapability = { kind: "none" };

const CLI_MODELS: Record<string, PickerModel[]> = {
  "claude-code": [
    {
      id: "claude-fable-5", label: "Fable 5", ctx: "1M",
      effort: EFFORT_NONE,
      supports_effort: false,
      active: false, // retired — disabled in the picker (matches the catalog)
    },
    {
      id: "claude-opus-4-8", label: "Opus 4.8", ctx: "200K",
      effort: EFFORT_NONE,
      supports_effort: false,
      default: true,
    },
    {
      id: "claude-sonnet-4-6", label: "Sonnet 4.6", ctx: "200K",
      effort: EFFORT_NONE,
      supports_effort: false,
    },
    {
      id: "claude-haiku-4-5-20251001", label: "Haiku 4.5", ctx: "200K",
      effort: EFFORT_NONE,
      supports_effort: false,
    },
  ],
  "codex-cli": [
    {
      id: "gpt-5.2", label: "GPT-5.2", ctx: "200K",
      effort: EFFORT_NONE,
      supports_effort: false,
    },
    {
      id: "gpt-5.4", label: "GPT-5.4", ctx: "200K",
      effort: EFFORT_NONE,
      supports_effort: false,
    },
    {
      id: "gpt-5.5", label: "GPT-5.5", ctx: "200K",
      effort: EFFORT_NONE,
      supports_effort: false,
    },
  ],
  "kimi-code": [
    {
      id: "kimi-k2.6", label: "Kimi K2.6", ctx: "256K",
      effort: EFFORT_NONE,
      supports_effort: false,
      default: true,
    },
    {
      id: "kimi-k2.6-thinking", label: "Kimi K2.6 Thinking", ctx: "256K",
      effort: EFFORT_NONE,
      supports_effort: false,
    },
    {
      id: "kimi-k2.6-agent", label: "Kimi K2.6 Agent", ctx: "256K",
      effort: EFFORT_NONE,
      supports_effort: false,
    },
  ],
  // Antigravity's `-p` (print) mode pins to whatever model the user
  // last selected via the TUI's `/model` slash command — that selection
  // is stored server-side (agy backend writes it via `setUserSettings`,
  // reads it via `fetchAvailableModels`). Exhaustive testing confirmed
  // there is NO local override surface: 25+ vectors tried (every CLI
  // flag variant, env vars, both settings.json files, project
  // descriptors, plugin.json, stdin slash injection, interactive-mode
  // pipe) — all are silently ignored by the print-mode pipeline.
  //
  // So the picker exposes a single "Auto" entry that reflects "use
  // whatever agy is configured to use." When upstream lands a `--model`
  // flag (or we ship PTY-driven dispatch that can run `/model <id>`
  // before each turn), the full per-(model × effort) list returns.
  "antigravity-cli": [
    { id: "agy-default", label: "Auto", ctx: "1M", effort: EFFORT_NONE, supports_effort: false },
  ],
  // Antigravity SDK — sibling of `agy` driven from a Python sidecar
  // wrapping `google.antigravity`. Here we DO expose the full per-
  // (model × effort) lineup because `LocalAgentConfig(model=...)`
  // accepts the model id at construction time and honours it for the
  // turn. The bridge passes the id verbatim to the sidecar, which
  // strips the effort suffix (-medium/-high/-low/-thinking) before
  // handing to the SDK's base-name parameter.
  "antigravity-sdk": [
    { id: "gemini-3.5-flash-medium",    label: "Gemini 3.5 Flash (Medium)",    ctx: "1M",   effort: EFFORT_NONE, supports_effort: false },
    { id: "gemini-3.5-flash-high",      label: "Gemini 3.5 Flash (High)",      ctx: "1M",   effort: EFFORT_NONE, supports_effort: false },
    { id: "gemini-3.1-pro-low",         label: "Gemini 3.1 Pro (Low)",         ctx: "1M",   effort: EFFORT_NONE, supports_effort: false },
    { id: "gemini-3.1-pro-high",        label: "Gemini 3.1 Pro (High)",        ctx: "1M",   effort: EFFORT_NONE, supports_effort: false },
    { id: "claude-sonnet-4-6-thinking", label: "Claude Sonnet 4.6 (Thinking)", ctx: "200K", effort: EFFORT_NONE, supports_effort: false },
    { id: "claude-opus-4-6-thinking",   label: "Claude Opus 4.6 (Thinking)",   ctx: "200K", effort: EFFORT_NONE, supports_effort: false },
    { id: "gpt-oss-120b-medium",        label: "GPT-OSS 120B (Medium)",        ctx: "128K", effort: EFFORT_NONE, supports_effort: false },
  ],
  // OpenCode + Cursor source their model list LIVE from the ACP session
  // (catalog default_models is empty), surfaced via `available_models_update`
  // → dynamicCliModels, which overrides these entries once a session
  // cold-starts. Until then (a draft, or the picker viewed from another
  // agent's session) the rail would be blank, so these curated fallbacks keep
  // the picker usable. The ids are the EXACT modelIds the ACP session reports
  // (OpenCode's `opencode/*` zen free models; Cursor's bracketed ids) so a
  // pick made before cold start still matches + applies via set_config_option.
  opencode: [
    { id: "opencode/big-pickle",             label: "Big Pickle",        effort: EFFORT_NONE, supports_effort: false },
    { id: "opencode/deepseek-v4-flash-free", label: "DeepSeek V4 Flash", effort: EFFORT_NONE, supports_effort: false },
    { id: "opencode/mimo-v2.5-free",         label: "MiMo V2.5",         effort: EFFORT_NONE, supports_effort: false },
    { id: "opencode/nemotron-3-super-free",  label: "Nemotron 3 Super",  effort: EFFORT_NONE, supports_effort: false },
  ],
  "cursor-cli": [
    { id: "default[]",                                                            label: "Auto",              effort: EFFORT_NONE, supports_effort: false },
    { id: "composer-2.5[fast=true]",                                              label: "Composer 2.5",      effort: EFFORT_NONE, supports_effort: false },
    { id: "claude-opus-4-8[thinking=true,context=300k,effort=high,fast=false]",   label: "Claude Opus 4.8",   ctx: "300K", effort: EFFORT_NONE, supports_effort: false },
    { id: "claude-sonnet-4-5[thinking=true,context=200k]",                        label: "Claude Sonnet 4.5", ctx: "200K", effort: EFFORT_NONE, supports_effort: false },
    { id: "gpt-5.5[context=272k,reasoning=medium,fast=false]",                    label: "GPT-5.5",           ctx: "272K", effort: EFFORT_NONE, supports_effort: false },
    { id: "gpt-5.2[reasoning=medium,fast=false]",                                 label: "GPT-5.2",           effort: EFFORT_NONE, supports_effort: false },
    { id: "gpt-5.3-codex[reasoning=medium,fast=false]",                           label: "GPT-5.3 Codex",     effort: EFFORT_NONE, supports_effort: false },
    { id: "gemini-3.1-pro[]",                                                     label: "Gemini 3.1 Pro",    effort: EFFORT_NONE, supports_effort: false },
  ],
  // Grok Build — xAI's ACP agent. Reuses the curated GROK_MODELS lineup the
  // backend ships (shared with the Grok HTTP provider) so the rail isn't empty
  // before live discovery lands. grok-4.3 exposes configurable reasoning
  // (none/low/medium/high); grok-build-0.1 has no effort lever.
  "grok-build": [
    {
      id: "grok-build-0.1", label: "Grok Build 0.1", ctx: "256K",
      effort: EFFORT_NONE,
      supports_effort: false,
    },
    {
      id: "grok-4.3", label: "Grok 4.3", ctx: "1M",
      effort: { kind: "levels", levels: ["none", "low", "medium", "high"], default: "low" },
      supports_effort: true,
    },
  ],
  // Hermes sources its model list LIVE from the ACP session (catalog
  // default_models is empty): both the lazy toolbar/composer probe
  // (`/agents/hermes/models`, a transient `session/new`) and the running
  // session's `available_models_update` override these entries with Hermes'
  // real per-provider list (ids in `provider:model` form). Until one of those
  // resolves, show a single placeholder so the rail isn't blank — the real
  // model is whatever `hermes model` configured. (This placeholder id is never
  // in Hermes's real available list, so picking it pre-discovery is a no-op
  // until live models arrive.)
  "hermes-agent": [
    { id: "default", label: "Hermes (configured model)", effort: EFFORT_NONE, supports_effort: false },
  ],
};

/** Display names for the five CLI agents — matches each CLI ProviderSpec's
 *  catalog `display_name`. Used as fallback when `providerTiles` is empty
 *  (cold-start race or transient IPC failure) so the picker never shows a
 *  blank rail. */
const CLI_FALLBACK_LABELS: Record<string, string> = {
  "claude-code":     "Claude Code",
  claude:            "Claude Code", // legacy id alias (pre-rename sessions)
  "codex-cli":             "Codex CLI",
  "kimi-code":              "Kimi Code",
  opencode:          "OpenCode",
  "cursor-cli":            "Cursor CLI",
  "grok-build":            "Grok Build",
  "antigravity-cli":               "Antigravity CLI",
  "antigravity-sdk": "Antigravity SDK",
  "hermes-agent":            "Hermes Agent",
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
  openrouter: "OpenRouter",
  ollama: "Ollama",
  // Cloud sibling of local `ollama` — curated rail label so it stays distinct
  // ("Ollama Cloud") from the local tile rather than depending on display_name.
  "ollama-cloud": "Ollama Cloud",
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

function modelFromSpec(
  m: {
    id: string;
    label: string;
    context_window?: string | null;
    note?: string | null;
    supports_effort: boolean;
  },
  effort: EffortCapability = EFFORT_NONE,
): PickerModel {
  const resolvedEffort = effort;
  return {
    id: m.id,
    label: m.label,
    ctx: m.context_window ?? undefined,
    note: m.note ?? undefined,
    effort: resolvedEffort,
    supports_effort: resolvedEffort.kind !== "none",
  };
}

/** Parse a human context-window label ("1M", "200K", "128k", "1000000",
 *  "200,000") into a token count. Returns null for unparseable input. */
export function parseContextWindow(ctx?: string | null): number | null {
  if (!ctx) return null;
  const s = String(ctx).trim().toLowerCase().replace(/[,_ ]/g, "");
  const m = s.match(/^([\d.]+)([mk]?)/);
  if (!m || !m[1]) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (m[2] === "m") return Math.round(n * 1_000_000);
  if (m[2] === "k") return Math.round(n * 1_000);
  return Math.round(n);
}

/** The real context-window size (tokens) for a model id, resolved from the SAME
 *  source the picker shows: an explicit hint baked into the id (`[1m]`,
 *  `[context=200k]`), then the provider catalog's `context_window`, falling back
 *  to 200K. Replaces the old `id.includes("1m") ? 1M : 200K` guess so the
 *  context-window bar's denominator matches the model's actual window. */
export function contextWindowForModel(
  modelId: string | null | undefined,
  tiles: ProviderTile[],
): number {
  const DEFAULT = 200_000;
  if (!modelId) return DEFAULT;
  const id = modelId.trim();
  const lower = id.toLowerCase();
  // 1. Explicit hint in the id (variant suffixes win over the catalog).
  const tagged = parseContextWindow(lower.match(/context=([\d.]+\s*[mk]?)/)?.[1]);
  if (tagged) return tagged;
  if (/\[1m\]/.test(lower)) return 1_000_000;
  // 2. Catalog context_window (strip any [..] variant suffix to match).
  const bareId = id.replace(/\[[^\]]*\]\s*$/, "");
  for (const t of tiles ?? []) {
    for (const m of t.spec?.default_models ?? []) {
      if (m.id === id || m.id === bareId) {
        const n = parseContextWindow(m.context_window);
        if (n) return n;
      }
    }
  }
  // 3. Static fallback catalog (used when providerTiles is empty).
  for (const list of Object.values(CLI_MODELS)) {
    for (const m of list) {
      if (m.id === id || m.id === bareId) {
        const n = parseContextWindow(m.ctx);
        if (n) return n;
      }
    }
  }
  return DEFAULT;
}

/** Friendly labels for Hermes' provider slugs (the `provider:` prefix on its
 *  model ids). Falls back to a capitalized slug for anything unlisted. */
const HERMES_PROVIDER_LABELS: Record<string, string> = {
  copilot: "Copilot",
  anthropic: "Anthropic",
  openrouter: "OpenRouter",
  nous: "Nous",
  "nous-api": "Nous",
  "openai-codex": "Codex",
  "gemini-cli": "Gemini",
  zai: "Z.AI",
  "kimi-coding": "Kimi",
  minimax: "MiniMax",
  nvidia: "NVIDIA",
  ollama: "Ollama",
  "ollama-cloud": "Ollama",
  lmstudio: "LM Studio",
};

/** Extract Hermes' distinct providers from its `provider:model` model ids, in
 *  first-seen order, for the picker's provider chip-row. Unprefixed ids (e.g.
 *  the `"default"` cold-start placeholder) are skipped. */
export function hermesProviders(
  models: PickerModel[],
): Array<{ id: string; label: string }> {
  const seen = new Set<string>();
  const out: Array<{ id: string; label: string }> = [];
  for (const m of models) {
    const i = m.id.indexOf(":");
    if (i <= 0) continue;
    const slug = m.id.slice(0, i);
    if (seen.has(slug)) continue;
    seen.add(slug);
    out.push({
      id: slug,
      label: HERMES_PROVIDER_LABELS[slug] ?? slug.charAt(0).toUpperCase() + slug.slice(1),
    });
  }
  return out;
}

export function buildPickerGroups(
  tiles: ProviderTile[],
  enabledAgentIds: string[],
  /** Model lists sourced at runtime rather than from the static catalog,
   *  keyed by catalog provider id. Covers BOTH live-model CLI agents
   *  (OpenCode / Cursor over ACP) and HTTP providers with a discovery
   *  endpoint (OpenRouter's `/models`). When present + non-empty for an id,
   *  these take precedence over catalog `default_models` / CLI_MODELS. */
  dynamicModels?: Record<string, PickerModel[]>,
): PickerGroup[] {
  const out: PickerGroup[] = [];

  // "Auto" — always the FIRST rail entry. A pseudo-provider: selecting it
  // doesn't pin a model; it routes to the best (provider, model) per message
  // (Not Diamond, or the built-in router as fallback). It carries no model
  // list — the picker special-cases it as a one-click selection.
  out.push({ id: "auto", label: "Auto", subtitle: "Best model per message", models: [] });

  // 1. CLI agents — filtered by enabledAgentIds, use display_name verbatim.
  //    CLI ProviderSpecs declare default_models: &[] because models live inside
  //    each CLI binary, not the registry. Fall back to CLI_MODELS when empty.
  const emittedCliIds = new Set<string>();
  for (const t of tiles) {
    if (t.spec.kind !== "cli") continue;
    if (!enabledAgentIds.includes(t.spec.id)) continue;
    const catalogModels = t.spec.default_models.map((m) => {
      const effort = t.capabilities?.model_efforts?.find((me) => me.id === m.id)?.effort ?? EFFORT_NONE;
      return modelFromSpec(m, effort);
    });
    const fallbackModels = CLI_MODELS[t.spec.id] ?? [];
    const dynamic = dynamicModels?.[t.spec.id] ?? [];
    const models =
      dynamic.length > 0
        ? dynamic
        : catalogModels.length > 0
          ? catalogModels
          : fallbackModels;
    const group: PickerGroup = {
      id: t.spec.id,
      label: t.spec.display_name,
      models,
    };
    // Hermes fans one agent out across multiple authenticated providers; its
    // model ids are `provider:model`. Surface the providers so the picker shows
    // a chip-row above the models. Only when >1 (a single provider needs no
    // selector — the flat list is clearer).
    if (t.spec.id === "hermes-agent") {
      const provs = hermesProviders(models);
      if (provs.length > 1) group.providers = provs;
    }
    out.push(group);
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
  //    `tile.connected` is the master enable bit (Settings → Models tile
  //    toggle writes through it). We no longer also accept `has_key` as
  //    a fallback — a user who saved a key but explicitly disabled the
  //    tile expects it hidden from the picker.
  //    Perplexity gets special handling: native Sonar entries stay here, the
  //    Agent marketplace entries are pulled out into per-brand groups below.
  const directBrandIds = new Set<string>();
  for (const t of tiles) {
    if (t.spec.kind !== "api" && t.spec.kind !== "local_http") continue;
    if (!t.connected) continue;

    if (t.spec.id === "perplexity") {
      // Split: native Sonar stays here, marketplace entries are deferred.
      const native = t.spec.default_models
        .filter((m) => !m.id.includes("/"))
        .map((m) => {
          const effort = t.capabilities?.model_efforts?.find((me) => me.id === m.id)?.effort ?? EFFORT_NONE;
          return modelFromSpec(m, effort);
        });
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

    // Live discovery (OpenRouter) overrides the curated fallback when it has
    // resolved; otherwise show the catalog's default_models.
    const dynamic = dynamicModels?.[t.spec.id] ?? [];
    const models =
      dynamic.length > 0
        ? dynamic
        : t.spec.default_models.map((m) => {
            const effort = t.capabilities?.model_efforts?.find((me) => me.id === m.id)?.effort ?? EFFORT_NONE;
            return modelFromSpec(m, effort);
          });
    if (models.length === 0) continue;
    out.push({
      id: t.spec.id,
      label: BRAND_SHORT[t.spec.id] ?? t.spec.display_name,
      models,
      // Large live catalogs (OpenRouter) get a search box instead of an
      // unscrollable wall of rows.
      searchable: models.length > 20,
    });
    directBrandIds.add(t.spec.id);
  }

  // 3. Perplexity Agent marketplace — brand-split into Claude / GPT / Gemini / Grok rows.
  const perplexityTile = tiles.find(
    (t) => t.spec.id === "perplexity" && t.connected,
  );
  if (perplexityTile) {
    for (const { prefix, subId, label, directProviderId } of PERPLEXITY_BRAND_PREFIXES) {
      const models = perplexityTile.spec.default_models
        .filter((m) => m.id.startsWith(prefix))
        .map((m) => {
          const effort = perplexityTile.capabilities?.model_efforts?.find((me) => me.id === m.id)?.effort ?? EFFORT_NONE;
          return modelFromSpec(m, effort);
        });
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

  // Catalog-retired models (`active: false`) are KEPT in the picker but rendered
  // disabled (greyed, non-clickable) by UnifiedModelPicker — they stay visible so
  // users can see the model exists yet can't pick it. Selection/dispatch is gated
  // separately: resolveSessionModel skips inactive (heals away, never defaults to
  // one) and send is blocked. Entries with no `active` field (embedded/CLI
  // fallbacks, live probes) are treated as available.

  // Order each group by catalog `priority` (higher floats toward the top). The
  // sort is stable — equal/absent priorities (0) keep their source order, so CLI
  // fallbacks and live-probe lists are untouched unless the catalog weights them.
  // Decorate-with-index keeps stability explicit (not engine-dependent).
  for (const g of out) {
    g.models = g.models
      .map((m, i) => [m, i] as const)
      .sort(([a, ai], [b, bi]) => (b.priority ?? 0) - (a.priority ?? 0) || ai - bi)
      .map(([m]) => m);
  }
  return out;
}

/** Model list for a SINGLE tile, independent of `connected` — used by the
 *  onboarding fleet-model step (which needs models for a provider before
 *  the picker's connected filter applies). Resolution mirrors
 *  buildPickerGroups: dynamic models > catalog default_models > CLI_MODELS
 *  fallback. Returns [] when nothing resolves (e.g. Ollama, whose models
 *  are fetched live). */
export function modelsForTile(tile: ProviderTile, dynamic?: PickerModel[]): PickerModel[] {
  if (dynamic && dynamic.length > 0) return dynamic.filter((m) => m.active !== false);
  const catalog = tile.spec.default_models.map((m) => {
    const effort = tile.capabilities?.model_efforts?.find((me) => me.id === m.id)?.effort ?? EFFORT_NONE;
    return modelFromSpec(m, effort);
  });
  if (catalog.length > 0) return catalog;
  return CLI_MODELS[tile.spec.id] ?? [];
}

/** Resolve a discovered / live-arriving model's effort descriptor.
 *
 *  Models fetched at runtime — `/agents/{id}/models` for the baked-lineup CLI
 *  agents (claude/codex/gemini/kimi), or a bridge `available_models_update` —
 *  may not carry a capability descriptor on the wire, so callers re-derive it
 *  here or the Effort column goes blank for a model that actually has levels.
 *  Effort now comes from the provider tile's registry-backed
 *  `capabilities.model_efforts` (the same snapshot the backend resolves from the
 *  model registry) for CLI and HTTP providers alike. Falls back to "none". */
export function effortForDiscoveredModel(
  providerId: string,
  modelId: string,
  tiles: ProviderTile[],
): EffortCapability {
  const tile = tiles.find((t) => t.spec.id === providerId);
  return tile?.capabilities?.model_efforts?.find((me) => me.id === modelId)?.effort ?? EFFORT_NONE;
}

/** Resolve the (tool, model) pair to seed the Fleet hub on first launch.
 *  `tool` = the connected default tile, else the first connected tile,
 *  else "claude-code". `model` = the persisted `defaultModel` when it is a
 *  valid model id for that tool's group, otherwise the group's first
 *  model. This is what stops the hub from defaulting to "Auto" after
 *  onboarding pinned a real model. */
export function resolveStartupDefault(
  tiles: ProviderTile[],
  persistedDefaultModel?: string | null,
): { tool: string; model: string | undefined } {
  const pick =
    tiles.find((t) => t.is_default && t.connected) ?? tiles.find((t) => t.connected);
  const tool = pick?.spec.id ?? "claude-code";
  const groups = buildPickerGroups(
    tiles,
    tiles.filter((t) => t.spec.kind === "cli" && t.connected).map((t) => t.spec.id),
  );
  // Gather models across ALL groups that dispatch to this tool. Perplexity
  // splits its catalog into "perplexity" (Sonar) + "perplexity:<brand>"
  // marketplace groups that all dispatch-resolve to "perplexity"; without
  // flattening them a persisted marketplace model (e.g. "anthropic/...")
  // wouldn't validate and the hub would silently fall back to Sonar. For
  // every non-split provider, resolveDispatchTool(g.id) === g.id, so this
  // is exactly the single-group behavior as before.
  const groupModels = groups
    .filter((g) => resolveDispatchTool(g.id) === tool)
    .flatMap((g) => g.models);
  // Honor the FLAGGED default: a persisted model that's still valid is kept
  // (status "ok"); a missing/stale one heals to the group's flagged default,
  // else its first model. `groupModels` carries `default` for claude-code via
  // the CLI_MODELS flag even without discovered models, so the Fleet seed picks
  // the right model. (buildPickerGroups emits every CLI agent as a fallback, so
  // the default tool's group is non-empty in practice.)
  const r = resolveSessionModel(persistedDefaultModel ?? null, groupModels);
  return { tool, model: r.model };
}

/** Strip the `perplexity:brand` sub-id back to the catalog provider id
 *  the dispatch layer expects. Native ids pass through unchanged. */
export function resolveDispatchTool(groupId: string): string {
  return groupId.startsWith("perplexity:") ? "perplexity" : groupId;
}

/** Resolve the model-chip face (provider logo `tool` + display label) for a
 *  (tool, model) pair against the picker groups. This is the SINGLE source of
 *  truth shared by the session-toolbar chip AND the chat-composer chip so the
 *  two never disagree (they previously diverged: the toolbar resolved via
 *  groups while the composer used the raw `tool` + a static label table, so a
 *  model that lives in another provider's group — e.g. "auto" surfacing under
 *  GitHub Copilot — showed two different provider icons + labels).
 *
 *  Resolution: match by model id first (a model can live in another provider's
 *  group via a brand-split or a connected agent's catalog), then fall back to
 *  the tool's own group. Label order: the matched group model's label > the
 *  hardcoded CLI label table (cold-start race before tiles load) > the raw id
 *  > "Model". Pass the SAME `groups` (built from the same providerTiles +
 *  dynamic models) at both call sites to guarantee identical faces. */
export function resolveModelChip(
  groups: PickerGroup[],
  tool: string,
  model: string | null,
): { dispatchTool: string; label: string } {
  // Fleet's cross-provider "Auto" routing sentinel — keyed on the TOOL only.
  // A manual agent may legitimately have model === "auto" (e.g. GitHub
  // Copilot's native `auto` model); that is NOT Fleet's Auto.
  if (tool === "auto") {
    return { dispatchTool: "auto", label: "Auto" };
  }
  const activeGroup =
    groups.find((g) => g.models.some((m) => m.id === model)) ??
    groups.find((g) => g.id === tool);
  const activeModel = activeGroup?.models.find((m) => m.id === model);
  // When the session has no model (null/empty), resolve the chip to the
  // provider's OWN default model name instead of a placeholder-looking
  // "Default": the tool group's flagged-`default` model, else its first model.
  const groupForTool = groups.find((g) => g.id === tool);
  const groupDefault = groupForTool?.models.find((m) => m.default) ?? groupForTool?.models[0];
  const label =
    activeModel?.label ??
    (model ? CLI_MODEL_LABELS[model] : undefined) ??
    // Hermes ids are `provider:model` (e.g. `copilot:claude-opus-4.8`). Before
    // the picker's lazy discovery populates the group, a persisted Hermes pick
    // (or a healed default) matches no group, so show the bare model name
    // instead of the raw `copilot:…` id. Tool-scoped so it never mangles other
    // colon-bearing ids (e.g. Ollama's `llama3:8b`).
    (model && tool === "hermes-agent" && model.includes(":")
      ? model.slice(model.indexOf(":") + 1)
      : undefined) ??
    model ??
    // No model on the session (spawned agents default to the provider's own
    // pick) — show the provider's default model name, neutral "Auto" last.
    groupDefault?.label ??
    "Auto";
  return { dispatchTool: resolveDispatchTool(activeGroup?.id ?? tool), label };
}

/** Hermes' cold-start placeholder model id — a sentinel meaning "use whatever
 *  model `hermes model` is configured for", NOT a real model. The bridge skips
 *  `session/set_model` for it (see `bridges/hermes.rs::select_model_to_apply`).
 *  It must never remain the *displayed* or *persisted* model once Hermes' real
 *  configured model is known, otherwise the chip reads the unhelpful "Hermes
 *  (configured model)" forever — even across restarts. */
export const HERMES_DEFAULT_SENTINEL = "default";

/** Decide whether a session still carrying the Hermes `"default"` sentinel
 *  should be rewritten to the discovered configured model. Returns the real
 *  `provider:model` id to persist, or `null` when no heal is warranted: not a
 *  Hermes session, the model is already a real pick, or no usable `current`
 *  was discovered. Pure so the self-heal decision is unit-testable. */
export function hermesHealModel(
  tool: string,
  modelName: string | null,
  current: string | null | undefined,
): string | null {
  if (tool !== "hermes-agent") return null;
  if (modelName !== HERMES_DEFAULT_SENTINEL) return null;
  if (!current || current === HERMES_DEFAULT_SENTINEL) return null;
  return current;
}
