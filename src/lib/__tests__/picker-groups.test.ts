import { describe, it, expect } from "vitest";
import { buildPickerGroups, resolveDispatchTool, resolveModelChip, modelsForTile, resolveStartupDefault } from "../picker-groups";
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
  ...opts,
});

describe("buildPickerGroups", () => {
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

  it("falls through label resolution: CLI table → raw id → 'Model'", () => {
    expect(resolveModelChip([], "claude", "claude-opus-4-8").label).toBe("Opus 4.8"); // CLI table
    expect(resolveModelChip([], "claude", "totally-unknown-xyz").label).toBe("totally-unknown-xyz"); // raw id
    expect(resolveModelChip([], "claude", null).label).toBe("Model"); // final fallback
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
