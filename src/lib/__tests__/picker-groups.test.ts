import { describe, it, expect } from "vitest";
import { buildPickerGroups, resolveDispatchTool } from "../picker-groups";
import type { ProviderTile } from "@/lib/providers-api";

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
