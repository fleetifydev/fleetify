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
});
