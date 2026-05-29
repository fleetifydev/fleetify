import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { ProviderLogo } from "../provider-logo";

describe("ProviderLogo — agent brand icons", () => {
  it.each([
    ["claude", "Claude Code"],
    ["anthropic", "Claude Code"],
    ["codex", "Codex"],
    ["gemini", "Gemini"],
    ["gemini-api", "Gemini"],
    ["kimi", "Kimi"],
    ["kimi-api", "Kimi"],
    ["opencode", "OpenCode"],
    ["agy", "Antigravity"],
    ["antigravity", "Antigravity"],
    ["antigravity-sdk", "Antigravity"],
  ])("renders a bundled <img> brand icon for %s", (tool, label) => {
    const { getByAltText } = render(<ProviderLogo tool={tool} size={20} />);
    const img = getByAltText(label) as HTMLImageElement;
    expect(img.tagName).toBe("IMG");
    // The .svg import resolves to a bundled asset URL through the vite pipeline.
    expect(img.getAttribute("src")).toBeTruthy();
  });

  it("renders the GitHub Copilot mark inline so it adapts to the theme", () => {
    const { getByLabelText } = render(<ProviderLogo tool="github-copilot" size={20} />);
    const svg = getByLabelText("GitHub Copilot");
    expect(svg.tagName.toLowerCase()).toBe("svg");
    // No hard-coded fill → the path inherits currentColor (light on dark,
    // dark on light) rather than the source's fixed white.
    expect(svg.getAttribute("fill")).toBe("currentColor");
  });

  it("falls back to a generic icon for unknown tools", () => {
    const { container } = render(<ProviderLogo tool="totally-unknown" size={20} />);
    expect(container.querySelector("svg")).toBeTruthy();
  });
});

describe("ProviderLogo — model-provider brand icons", () => {
  it.each([
    ["perplexity", "Perplexity"],
    ["deepseek", "DeepSeek"],
    ["nvidia-nim", "NVIDIA"],
  ])("renders a bundled <img> brand icon for %s", (tool, label) => {
    const { getByRole } = render(<ProviderLogo tool={tool} size={20} />);
    const el = getByRole("img", { name: label });
    expect(el.tagName).toBe("IMG");
    expect(el.getAttribute("src")).toBeTruthy();
  });

  it.each([
    ["openai", "OpenAI"],
    ["grok", "Grok"],
    ["ollama", "Ollama"],
  ])("renders %s as a currentColor mask so it adapts to the theme", (tool, label) => {
    const { getByRole } = render(<ProviderLogo tool={tool} size={20} />);
    const el = getByRole("img", { name: label });
    // Monochrome marks render as a masked <span> painted with currentColor,
    // not an <img>, so they're visible on both light and dark themes.
    expect(el.tagName).toBe("SPAN");
    expect(el.style.backgroundColor.toLowerCase()).toContain("current");
  });
});
