import { describe, it, expect } from "vitest";
import { buildPickerGroups, effortForDiscoveredModel, resolveDispatchTool, resolveModelChip, modelsForTile, resolveStartupDefault, hermesProviders, hermesHealModel } from "../picker-groups";
import type { ProviderTile, ProviderSpec } from "@/lib/providers-api";

const baseTile = (
  id: string,
  display_name: string,
  kind: "cli" | "api" | "local_http",
  modelIds: string[] = [],
  opts: Partial<ProviderTile> = {},
): ProviderTile => ({
  spec: {
    id,
    display_name,
    kind,
    default_base_url: "",
    auth: { kind: "none" },
    default_models: modelIds.map((mid) => ({
      id: mid,
      label: mid,
      supports_effort: false,
    })),
    extras: {},
    bin: "",
    auth_indicators: [],
    install_hint: "",
    login_hint: "",
  },
  connected: kind !== "cli",
  has_key: kind !== "cli",
  enabled_models: [],
  is_default: false,
  capabilities: {
    permission: { kind: "none" },
    tool_matrix: null,
    timing: { permission: "spawn", effort: "spawn" },
    model_efforts: [],
  },
  ...opts,
});

describe("effortForDiscoveredModel", () => {
  // Effort is now sourced exclusively from the provider tile's registry-backed
  // `capabilities.model_efforts` snapshot — no longer re-derived from CLI_MODELS
  // (which keeps only the cold-start id/label list). Discovered/live models that
  // arrive without a wire `effort` get re-hydrated from this tile lookup so the
  // Effort column isn't blanked for a model that actually has levels.
  it("reads a model's effort from the tile's registry-backed model_efforts", () => {
    const tile = baseTile("claude", "Claude Code", "cli", []);
    tile.capabilities.model_efforts = [
      { id: "claude-opus-4-8", effort: { kind: "levels", levels: ["low", "medium", "high", "xhigh", "max"], default: "high" } },
    ];
    const eff = effortForDiscoveredModel("claude", "claude-opus-4-8", [tile]);
    expect(eff.kind).toBe("levels");
    if (eff.kind === "levels") expect(eff.levels).toContain("max");
  });
  it("works for HTTP providers too (tile model_efforts)", () => {
    const tile = baseTile("openai", "OpenAI", "api", []);
    tile.capabilities.model_efforts = [
      { id: "gpt-5.5", effort: { kind: "levels", levels: ["low", "medium", "high"], default: "medium" } },
    ];
    expect(effortForDiscoveredModel("openai", "gpt-5.5", [tile]).kind).toBe("levels");
  });
  it("returns none for a model the tile's model_efforts doesn't list", () => {
    const tile = baseTile("claude", "Claude Code", "cli", []);
    tile.capabilities.model_efforts = [
      { id: "claude-opus-4-8", effort: { kind: "levels", levels: ["low", "high"], default: "high" } },
    ];
    expect(effortForDiscoveredModel("claude", "claude-haiku-4-5-20251001", [tile]).kind).toBe("none");
  });
  it("returns none when the tile carries no model_efforts entry", () => {
    const tile = baseTile("claude", "Claude Code", "cli", []);
    expect(effortForDiscoveredModel("claude", "claude-opus-4-8", [tile]).kind).toBe("none");
  });
  it("returns none for an unknown provider (no matching tile)", () => {
    expect(effortForDiscoveredModel("nope", "whatever", []).kind).toBe("none");
  });
});

describe("buildPickerGroups", () => {
  // B5: CLI_MODELS is now the cold-start id/label LIST only — it carries no
  // effort. Effort rides in via the live `/models` response (dynamicModels) or
  // the tile's registry-backed `capabilities.model_efforts`, NOT this table. So
  // the fallback list always surfaces `none`/`false` with ids+labels+ctx intact.
  it("CLI_MODELS fallback entries carry no effort but keep id/label/ctx", () => {
    const groups = buildPickerGroups([], []);
    const claude = groups.find((g) => g.id === "claude");
    const opus = claude?.models.find((m) => m.id === "claude-opus-4-8");
    expect(opus?.label).toBe("Opus 4.8");
    expect(opus?.ctx).toBe("200K");
    expect(opus?.effort.kind).toBe("none");
    expect(opus?.supports_effort).toBe(false);
    const sonnet = claude?.models.find((m) => m.id === "claude-sonnet-4-6");
    expect(sonnet?.label).toBe("Sonnet 4.6");
    expect(sonnet?.effort.kind).toBe("none");
    expect(sonnet?.supports_effort).toBe(false);
  });

  it("a cold-start CLI model has supports_effort === false", () => {
    const groups = buildPickerGroups([], []);
    const claude = groups.find((g) => g.id === "claude");
    const haiku = claude?.models.find((m) => m.id === "claude-haiku-4-5-20251001");
    expect(haiku?.effort.kind).toBe("none");
    expect(haiku?.supports_effort).toBe(false);
  });

  it("gemini CLI fallback models keep their id/label/ctx with no effort", () => {
    const groups = buildPickerGroups([], []);
    const gemini = groups.find((g) => g.id === "gemini");
    const pro = gemini?.models.find((m) => m.id === "gemini-3.1-pro-preview");
    expect(pro?.label).toBe("3.1 Pro");
    expect(pro?.ctx).toBe("1M");
    expect(pro?.effort.kind).toBe("none");
    expect(pro?.supports_effort).toBe(false);
    const lite = gemini?.models.find((m) => m.id === "gemini-3.1-flash-lite-preview");
    expect(lite?.effort.kind).toBe("none");
    expect(lite?.supports_effort).toBe(false);
  });

  it("buildPickerGroups joins model_efforts from tile capabilities for HTTP providers", () => {
    const tiles = [
      baseTile("openai", "OpenAI", "api", ["gpt-5.5"], {
        connected: true,
        has_key: true,
        capabilities: {
          permission: { kind: "none" },
          tool_matrix: null,
          timing: { permission: "spawn", effort: "spawn" },
          model_efforts: [
            { id: "gpt-5.5", effort: { kind: "levels", levels: ["low", "medium", "high"], default: "medium" } },
          ],
        },
      }),
    ];
    const groups = buildPickerGroups(tiles, []);
    const openai = groups.find((g) => g.id === "openai");
    const model = openai?.models.find((m) => m.id === "gpt-5.5");
    expect(model?.effort.kind).toBe("levels");
    if (model?.effort.kind === "levels") {
      expect(model.effort.levels).toContain("high");
    }
    expect(model?.supports_effort).toBe(true);
  });

  it("filters CLI agents by enabledAgentIds", () => {
    const tiles = [
      baseTile("claude", "Claude Code", "cli"),
      baseTile("kimi", "Kimi Code CLI", "cli"),
    ];
    const groups = buildPickerGroups(tiles, ["claude"]);
    const cliIds = groups.filter((g) => g.id !== "ollama").map((g) => g.id);
    expect(cliIds).toContain("claude");
    expect(cliIds).not.toContain("kimi");
  });

  it("groups Hermes dynamic models by provider into a chip-row", () => {
    const tiles = [baseTile("hermes", "Hermes Agent", "cli")];
    const dyn = {
      hermes: [
        { id: "copilot:claude-opus-4.8", label: "claude-opus-4.8", supports_effort: false },
        { id: "copilot:gpt-5.5", label: "gpt-5.5", supports_effort: false },
        { id: "anthropic:claude-opus-4-6", label: "claude-opus-4-6", supports_effort: false },
      ],
    };
    const hermes = buildPickerGroups(tiles, ["hermes"], dyn).find((g) => g.id === "hermes");
    expect(hermes?.providers).toEqual([
      { id: "copilot", label: "Copilot" },
      { id: "anthropic", label: "Anthropic" },
    ]);
    // All models stay in the flat list; the picker filters by the active chip.
    expect(hermes?.models).toHaveLength(3);
  });

  it("omits the Hermes provider chip-row when only one provider is present", () => {
    const tiles = [baseTile("hermes", "Hermes Agent", "cli")];
    const dyn = {
      hermes: [
        { id: "copilot:claude-opus-4.8", label: "claude-opus-4.8", supports_effort: false },
        { id: "copilot:gpt-5.5", label: "gpt-5.5", supports_effort: false },
      ],
    };
    const hermes = buildPickerGroups(tiles, ["hermes"], dyn).find((g) => g.id === "hermes");
    expect(hermes?.providers).toBeUndefined();
    expect(hermes?.models).toHaveLength(2);
  });

  it("hermesProviders: distinct providers in first-seen order, friendly labels, skips unprefixed", () => {
    const provs = hermesProviders([
      { id: "copilot:claude-opus-4.8", label: "claude-opus-4.8", supports_effort: false },
      { id: "openrouter:anthropic/claude-opus-4.7", label: "claude-opus-4.7", supports_effort: false },
      { id: "copilot:gpt-5.5", label: "gpt-5.5", supports_effort: false }, // dup provider
      { id: "default", label: "Hermes (configured model)", supports_effort: false }, // unprefixed → skipped
      { id: "some-vendor:m1", label: "m1", supports_effort: false }, // fallback capitalization
    ]);
    expect(provs).toEqual([
      { id: "copilot", label: "Copilot" },
      { id: "openrouter", label: "OpenRouter" },
      { id: "some-vendor", label: "Some-vendor" },
    ]);
  });

  it("drops HTTP providers that are neither connected nor have a key", () => {
    const tiles = [
      baseTile("openai", "OpenAI", "api", ["gpt-5"], { connected: false, has_key: false }),
      baseTile("deepseek", "DeepSeek", "api", ["deepseek-v4-pro"]),
    ];
    const groups = buildPickerGroups(tiles, []);
    expect(groups.find((g) => g.id === "openai")).toBeUndefined();
    expect(groups.find((g) => g.id === "deepseek")).toBeDefined();
  });

  it("uses CLI display_name verbatim (Claude Code) and short brand label for APIs (OpenAI)", () => {
    const tiles = [
      baseTile("claude", "Claude Code", "cli"),
      baseTile("openai", "OpenAI", "api", ["gpt-5"]),
      baseTile("kimi-api", "Kimi (Moonshot)", "api", ["kimi-k2.6"]),
      baseTile("gemini-api", "Gemini (Google API)", "api", ["gemini-3.1-pro"]),
    ];
    const groups = buildPickerGroups(tiles, ["claude"]);
    expect(groups.find((g) => g.id === "claude")?.label).toBe("Claude Code");
    expect(groups.find((g) => g.id === "openai")?.label).toBe("OpenAI");
    expect(groups.find((g) => g.id === "kimi-api")?.label).toBe("Kimi");
    expect(groups.find((g) => g.id === "gemini-api")?.label).toBe("Gemini");
  });

  it("splits Perplexity Agent models into brand groups by id prefix", () => {
    const tiles = [
      baseTile("perplexity", "Perplexity", "api", [
        "sonar",
        "sonar-pro",
        "anthropic/claude-opus-4-7",
        "anthropic/claude-sonnet-4-6",
        "openai/gpt-5.5",
        "google/gemini-3.5-flash",
        "xai/grok-4.3",
      ]),
    ];
    const groups = buildPickerGroups(tiles, []);
    const native = groups.find((g) => g.id === "perplexity");
    expect(native?.models.map((m) => m.id)).toEqual(["sonar", "sonar-pro"]);
    expect(groups.find((g) => g.id === "perplexity:claude")?.label).toBe("Claude");
    expect(groups.find((g) => g.id === "perplexity:claude")?.models.map((m) => m.id)).toEqual([
      "anthropic/claude-opus-4-7",
      "anthropic/claude-sonnet-4-6",
    ]);
    expect(groups.find((g) => g.id === "perplexity:gpt")?.label).toBe("GPT");
    expect(groups.find((g) => g.id === "perplexity:gemini")?.label).toBe("Gemini");
    expect(groups.find((g) => g.id === "perplexity:grok")?.label).toBe("Grok");
  });

  it("appends '(via Perplexity)' to brand row when a direct provider for that brand exists", () => {
    const tiles = [
      baseTile("gemini-api", "Gemini (Google API)", "api", ["gemini-3.1-pro"]),
      baseTile("grok", "Grok (xAI)", "api", ["grok-4.3"]),
      baseTile("perplexity", "Perplexity", "api", [
        "google/gemini-3.5-flash",
        "xai/grok-4.3",
      ]),
    ];
    const groups = buildPickerGroups(tiles, []);
    expect(groups.find((g) => g.id === "perplexity:gemini")?.subtitle).toBe("via Perplexity");
    expect(groups.find((g) => g.id === "perplexity:grok")?.subtitle).toBe("via Perplexity");
    expect(groups.find((g) => g.id === "gemini-api")?.subtitle).toBeUndefined();
    expect(groups.find((g) => g.id === "grok")?.subtitle).toBeUndefined();
  });

  it("resolveDispatchTool maps perplexity:* group ids back to 'perplexity'", () => {
    expect(resolveDispatchTool("perplexity:claude")).toBe("perplexity");
    expect(resolveDispatchTool("perplexity:gpt")).toBe("perplexity");
    expect(resolveDispatchTool("perplexity")).toBe("perplexity");
    expect(resolveDispatchTool("claude")).toBe("claude");
    expect(resolveDispatchTool("openai")).toBe("openai");
  });

  it("populates CLI agent groups with hardcoded model lists", () => {
    const tiles = [
      baseTile("claude", "Claude Code", "cli"),
      baseTile("codex", "Codex CLI", "cli"),
      baseTile("gemini", "Gemini CLI", "cli"),
      baseTile("kimi", "Kimi Code CLI", "cli"),
    ];
    const groups = buildPickerGroups(tiles, ["claude", "codex", "gemini", "kimi"]);
    const claude = groups.find((g) => g.id === "claude");
    expect(claude?.models.length).toBeGreaterThan(0);
    expect(claude?.models.some((m) => m.id.startsWith("claude-"))).toBe(true);
    const codex = groups.find((g) => g.id === "codex");
    expect(codex?.models.length).toBeGreaterThan(0);
    expect(codex?.models.some((m) => m.id.startsWith("gpt-5"))).toBe(true);
    const gemini = groups.find((g) => g.id === "gemini");
    expect(gemini?.models.length).toBeGreaterThan(0);
    expect(gemini?.models.some((m) => m.id.startsWith("gemini-"))).toBe(true);
    const kimi = groups.find((g) => g.id === "kimi");
    expect(kimi?.models.length).toBeGreaterThan(0);
    expect(kimi?.models.some((m) => m.id.startsWith("kimi-") || m.id.startsWith("moonshot"))).toBe(true);
  });

  // Regression: OpenCode + Cursor are live-model ACP agents (empty catalog
  // default_models). Before a session cold-starts (or when the picker is
  // viewed from another agent's session) there's no live list, so their rail
  // was blank. They must fall back to a curated CLI_MODELS list like the
  // other CLI agents.
  it("gives OpenCode and Cursor a fallback model list so their rail isn't blank", () => {
    const tiles = [
      baseTile("opencode", "OpenCode", "cli"),
      baseTile("cursor", "Cursor CLI", "cli"),
    ];
    const groups = buildPickerGroups(tiles, ["opencode", "cursor"]);
    const oc = groups.find((g) => g.id === "opencode");
    expect(oc?.models.length).toBeGreaterThan(0);
    expect(oc?.models.some((m) => m.id.startsWith("opencode/"))).toBe(true);
    const cu = groups.find((g) => g.id === "cursor");
    expect(cu?.models.length).toBeGreaterThan(0);
    expect(cu?.models.some((m) => m.label === "Auto")).toBe(true);
  });

  it("lets the live ACP model list override the OpenCode/Cursor fallback", () => {
    const tiles = [baseTile("cursor", "Cursor CLI", "cli")];
    const live = [
      { id: "gpt-5.2[reasoning=medium,fast=false]", label: "GPT-5.2", supports_effort: false },
    ];
    const groups = buildPickerGroups(tiles, ["cursor"], { cursor: live });
    expect(groups.find((g) => g.id === "cursor")?.models).toEqual(live);
  });

  // Regression: when providerTiles is empty (cold-start race or transient
  // IPC failure), buildPickerGroups must still return all CLI agent rails
  // populated from CLI_MODELS so the picker isn't a blank popover.
  it("emits every CLI rail even when tiles is empty", () => {
    const groups = buildPickerGroups([], []);
    const ids = groups.map((g) => g.id);
    expect(ids).toEqual(
      expect.arrayContaining(["claude", "codex", "gemini", "kimi", "agy", "antigravity-sdk"]),
    );
    for (const id of ["claude", "codex", "gemini", "kimi", "agy", "antigravity-sdk"]) {
      const g = groups.find((gg) => gg.id === id);
      expect(g?.models.length ?? 0).toBeGreaterThan(0);
    }
  });

  it("CLI rail labels match the catalog display_name even when tiles is empty", () => {
    const groups = buildPickerGroups([], []);
    expect(groups.find((g) => g.id === "claude")?.label).toBe("Claude Code");
    expect(groups.find((g) => g.id === "codex")?.label).toBe("Codex CLI");
    expect(groups.find((g) => g.id === "gemini")?.label).toBe("Gemini CLI");
    expect(groups.find((g) => g.id === "kimi")?.label).toBe("Kimi Code CLI");
    expect(groups.find((g) => g.id === "agy")?.label).toBe("Antigravity CLI");
    expect(groups.find((g) => g.id === "antigravity-sdk")?.label).toBe("Antigravity SDK");
  });

  it("antigravity-sdk exposes per-(model × effort) lineup unlike agy CLI", () => {
    const groups = buildPickerGroups([], []);
    const sdk = groups.find((g) => g.id === "antigravity-sdk");
    const cli = groups.find((g) => g.id === "agy");
    // CLI side collapses to a single "Auto" entry because print mode
    // can't accept a model override; SDK side gets the full lineup.
    expect(cli?.models.length).toBe(1);
    expect(sdk?.models.length).toBeGreaterThanOrEqual(6);
    expect(sdk?.models.some((m) => m.id.startsWith("gemini-"))).toBe(true);
    expect(sdk?.models.some((m) => m.id.startsWith("claude-"))).toBe(true);
  });

  // OpenRouter-style: a live HTTP catalog supplied via dynamicModels overrides
  // the provider's curated default_models, and a large list is flagged
  // `searchable` so the picker renders a search box.
  it("lets dynamic models override an API provider's catalog and flags large lists searchable", () => {
    const tiles = [baseTile("openrouter", "OpenRouter", "api", ["anthropic/claude-sonnet-4"])];
    const live = Array.from({ length: 30 }, (_, i) => ({
      id: `vendor/model-${i}`,
      label: `Model ${i}`,
      supports_effort: false,
    }));
    const groups = buildPickerGroups(tiles, [], { openrouter: live });
    const or = groups.find((g) => g.id === "openrouter");
    expect(or?.models).toEqual(live); // dynamic list replaces the single fallback
    expect(or?.searchable).toBe(true); // 30 > 20 → searchable
    expect(or?.label).toBe("OpenRouter"); // BRAND_SHORT short label
  });

  it("does not flag a small API catalog as searchable", () => {
    const tiles = [baseTile("openai", "OpenAI", "api", ["gpt-5"])];
    const groups = buildPickerGroups(tiles, []);
    expect(groups.find((g) => g.id === "openai")?.searchable).toBe(false);
  });

  // Registry-driven effort: a discovered model can carry its own `effort`
  // descriptor (the backend resolved it from the model registry). That value
  // must ride through buildPickerGroups onto the picker model verbatim — it is
  // NOT re-derived from CLI_MODELS, so registry-only models (e.g. a brand-new
  // "Fable 5" the renderer has never heard of) still get the right effort.
  it("dynamicModels effort descriptor is preserved on the picker model", () => {
    const tiles = [baseTile("claude", "Claude Code", "cli")];
    const groups = buildPickerGroups(tiles, ["claude"], {
      claude: [{ id: "claude-fable-5", label: "Fable 5",
        effort: { kind: "levels", levels: ["low", "high"], default: "high" },
        supports_effort: true }],
    });
    const claude = groups.find((g) => g.id === "claude")!;
    expect(claude.models[0].effort).toEqual({ kind: "levels", levels: ["low", "high"], default: "high" });
  });
});

describe("resolveModelChip", () => {
  // Regression: a model can live under a DIFFERENT provider's group than the
  // session's `tool` — e.g. GitHub Copilot surfaces a model the chip resolves
  // to the Copilot face. The chip must resolve identically regardless of the
  // tool so the session-toolbar chip and the chat-composer chip never disagree.
  // (Uses a non-"auto" id since "auto" is now the routing sentinel.)
  it("resolves a cross-group model to the same face regardless of the tool", () => {
    const tiles = [
      baseTile("claude", "Claude Code", "cli"),
      baseTile("github-copilot", "GitHub Copilot", "cli"),
    ];
    const groups = buildPickerGroups(tiles, ["claude", "github-copilot"], {
      "github-copilot": [{ id: "copilot-gpt-5", label: "GPT-5 (Copilot)", supports_effort: false }],
    });
    const fromComposer = resolveModelChip(groups, "claude", "copilot-gpt-5");
    const fromToolbar = resolveModelChip(groups, "github-copilot", "copilot-gpt-5");
    expect(fromComposer).toEqual(fromToolbar);
    expect(fromComposer.dispatchTool).toBe("github-copilot");
    expect(fromComposer.label).toBe("GPT-5 (Copilot)");
  });

  it("falls back to the tool's own group when the model is in no other group", () => {
    const groups = buildPickerGroups([baseTile("claude", "Claude Code", "cli")], ["claude"]);
    const chip = resolveModelChip(groups, "claude", "claude-opus-4-8");
    expect(chip.dispatchTool).toBe("claude");
    expect(chip.label).toBe("Opus 4.8");
  });

  it("maps a perplexity brand-split group back to the 'perplexity' dispatch tool", () => {
    const groups = buildPickerGroups(
      [baseTile("perplexity", "Perplexity", "api", ["openai/gpt-5.5"])],
      [],
    );
    expect(resolveModelChip(groups, "perplexity", "openai/gpt-5.5").dispatchTool).toBe("perplexity");
  });

  it("falls through label resolution: CLI table → raw id → 'Default'", () => {
    expect(resolveModelChip([], "claude", "claude-opus-4-8").label).toBe("Opus 4.8"); // CLI table
    expect(resolveModelChip([], "claude", "totally-unknown-xyz").label).toBe("totally-unknown-xyz"); // raw id
    // Null model = the provider's own default (spawned agents) — labelled
    // "Default", and the face stays on the SESSION's tool.
    expect(resolveModelChip([], "claude", null).label).toBe("Default");
    expect(resolveModelChip([], "claude", null).dispatchTool).toBe("claude");
  });

  it("surfaces an 'Auto' group first and resolves the auto sentinel neutrally", () => {
    const groups = buildPickerGroups([baseTile("claude", "Claude Code", "cli")], ["claude"]);
    expect(groups[0]?.id).toBe("auto");
    expect(groups[0]?.label).toBe("Auto");
    // The sentinel resolves to a neutral face, never attributed to a provider.
    expect(resolveModelChip(groups, "auto", "auto")).toEqual({ dispatchTool: "auto", label: "Auto" });
    // model === "auto" under a REAL tool (e.g. GitHub Copilot's native `auto`)
    // is NOT Fleet's cross-provider Auto — only tool === "auto" is the sentinel.
    expect(resolveModelChip(groups, "github-copilot", "auto").dispatchTool).toBe("github-copilot");
  });

  it("derives a friendly label from a 'provider:model' id not yet in any group", () => {
    // Before the picker's lazy discovery runs, Hermes' group holds only the
    // cold-start placeholder, so a persisted `copilot:claude-opus-4.8` (a real
    // pick or a healed default) must resolve to the bare model name — NOT the
    // raw `copilot:…` id and NOT the "Hermes (configured model)" placeholder.
    const groups = buildPickerGroups([baseTile("hermes", "Hermes Agent", "cli")], ["hermes"]);
    expect(resolveModelChip(groups, "hermes", "copilot:claude-opus-4.8").label).toBe("claude-opus-4.8");
  });

  it("keeps the placeholder label for the bare Hermes 'default' sentinel", () => {
    // The sentinel itself still reads as the placeholder; the self-heal rewrites
    // the persisted model_name (away from "default"), it does not relabel "default".
    const groups = buildPickerGroups([baseTile("hermes", "Hermes Agent", "cli")], ["hermes"]);
    expect(resolveModelChip(groups, "hermes", "default").label).toBe("Hermes (configured model)");
  });
});

describe("hermesHealModel", () => {
  it("heals the Hermes 'default' sentinel to the discovered configured model", () => {
    expect(hermesHealModel("hermes", "default", "copilot:claude-opus-4.8")).toBe("copilot:claude-opus-4.8");
  });

  it("never overwrites an explicit real pick", () => {
    expect(hermesHealModel("hermes", "copilot:gpt-5-mini", "copilot:claude-opus-4.8")).toBeNull();
  });

  it("is a no-op without a usable current model", () => {
    expect(hermesHealModel("hermes", "default", null)).toBeNull();
    expect(hermesHealModel("hermes", "default", "default")).toBeNull();
    expect(hermesHealModel("hermes", "default", "")).toBeNull();
  });

  it("only applies to the hermes tool", () => {
    expect(hermesHealModel("claude", "default", "copilot:claude-opus-4.8")).toBeNull();
  });
});

function tile(
  id: string,
  kind: ProviderSpec["kind"],
  models: { id: string; label: string }[],
  over: Partial<ProviderTile> = {},
): ProviderTile {
  return {
    spec: {
      id,
      display_name: id,
      kind,
      default_base_url: "",
      auth: { kind: "none" },
      default_models: models.map((m) => ({ ...m, supports_effort: false })),
      extras: {},
      bin: "",
      auth_indicators: [],
      install_hint: "",
      login_hint: "",
    } as ProviderSpec,
    connected: true,
    has_key: false,
    enabled_models: [],
    is_default: false,
    capabilities: {
      permission: { kind: "none" },
      tool_matrix: null,
      timing: { permission: "spawn", effort: "spawn" },
      model_efforts: [],
    },
    ...over,
  };
}

describe("modelsForTile", () => {
  it("returns the catalog default_models when present", () => {
    const t = tile("openai", "api", [{ id: "gpt-5.5", label: "GPT-5.5" }]);
    expect(modelsForTile(t).map((m) => m.id)).toEqual(["gpt-5.5"]);
  });

  it("falls back to CLI_MODELS for a CLI tile with no catalog models", () => {
    const t = tile("claude", "cli", []);
    expect(modelsForTile(t).map((m) => m.id)).toContain("claude-opus-4-8");
  });

  it("prefers dynamic models over catalog/CLI fallback", () => {
    const t = tile("claude", "cli", []);
    const dyn = [{ id: "live-1", label: "Live", supports_effort: false }];
    expect(modelsForTile(t, dyn).map((m) => m.id)).toEqual(["live-1"]);
  });

  it("returns [] when nothing resolves (e.g. ollama, no static list)", () => {
    expect(modelsForTile(tile("ollama", "local_http", []))).toEqual([]);
  });
});

describe("resolveStartupDefault", () => {
  it("honors the persisted default model when valid for the default provider", () => {
    const tiles = [tile("claude", "cli", [], { is_default: true })];
    const r = resolveStartupDefault(tiles, "claude-sonnet-4-6");
    expect(r).toEqual({ tool: "claude", model: "claude-sonnet-4-6" });
  });

  it("falls back to the provider's first model when the persisted model is invalid", () => {
    const tiles = [tile("claude", "cli", [], { is_default: true })];
    const r = resolveStartupDefault(tiles, "not-a-real-model");
    expect(r.tool).toBe("claude");
    expect(r.model).toBe("claude-opus-4-8");
  });

  it("falls back to the first connected tile and claude when none is default", () => {
    const tiles = [tile("openai", "api", [{ id: "gpt-5.5", label: "GPT-5.5" }])];
    const r = resolveStartupDefault(tiles, null);
    expect(r).toEqual({ tool: "openai", model: "gpt-5.5" });
  });

  it("defaults the tool to claude when no tile is connected", () => {
    const tiles = [tile("openai", "api", [{ id: "gpt-5.5", label: "GPT-5.5" }], { connected: false })];
    const r = resolveStartupDefault(tiles, null);
    expect(r.tool).toBe("claude");
  });

  it("validates a Perplexity Agent-marketplace model across split groups", () => {
    // buildPickerGroups splits Perplexity into a native "perplexity" (Sonar)
    // group + "perplexity:<brand>" marketplace groups. A persisted
    // marketplace model must still validate against tool "perplexity".
    const tiles = [
      tile(
        "perplexity",
        "api",
        [
          { id: "sonar", label: "Sonar" },
          { id: "anthropic/claude-opus-4-7", label: "Claude Opus (via Perplexity)" },
        ],
        { is_default: true },
      ),
    ];
    const r = resolveStartupDefault(tiles, "anthropic/claude-opus-4-7");
    expect(r.tool).toBe("perplexity");
    expect(r.model).toBe("anthropic/claude-opus-4-7");
  });
});
