import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { ProviderLogo } from "../provider-logo";
import { useThemeStore } from "@/stores/theme-store";

describe("ProviderLogo — agent brand icons", () => {
  it.each([
    ["claude-code", "Claude Code"],
    ["anthropic", "Claude Code"],
    ["codex-cli", "Codex"],
    ["gemini-api", "Gemini"],
    ["kimi-code", "Kimi"],
    ["kimi-api", "Kimi"],
    ["opencode", "OpenCode"],
  ])("renders a bundled <img> brand icon for %s", (tool, label) => {
    const { getByAltText } = render(<ProviderLogo tool={tool} size={20} />);
    const img = getByAltText(label) as HTMLImageElement;
    expect(img.tagName).toBe("IMG");
    // The bundled asset import resolves to a URL through the vite pipeline.
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

  it("renders the Cursor mark inline so it adapts to the theme", () => {
    const { getByLabelText } = render(<ProviderLogo tool="cursor-cli" size={20} />);
    const svg = getByLabelText("Cursor");
    expect(svg.tagName.toLowerCase()).toBe("svg");
    // The hexagon mark's path is painted with currentColor so it reads on
    // both light and dark themes (the source ships a fixed-colour variant).
    expect(svg.querySelector("path")?.getAttribute("fill")).toBe("currentColor");
  });

  it("renders the Auto routing sentinel as an inline sparkle svg", () => {
    const { getByLabelText } = render(<ProviderLogo tool="auto" size={18} />);
    expect(getByLabelText("Auto").tagName.toLowerCase()).toBe("svg");
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
    ["ollama", "Ollama"],
  ])("renders %s as a currentColor mask so it adapts to the theme", (tool, label) => {
    const { getByRole } = render(<ProviderLogo tool={tool} size={20} />);
    const el = getByRole("img", { name: label });
    // Monochrome marks render as a masked <span> painted with currentColor,
    // not an <img>, so they're visible on both light and dark themes.
    expect(el.tagName).toBe("SPAN");
    expect(el.style.backgroundColor.toLowerCase()).toContain("current");
  });

  it.each([
    ["openai", "OpenAI"],
    ["antigravity-cli", "Antigravity CLI"],
    ["antigravity", "Antigravity CLI"],
    ["antigravity-sdk", "Antigravity CLI"],
  ])("renders %s as a self-coloured inline SVG, crisp at the picker's small size", (tool, label) => {
    const { getByRole } = render(<ProviderLogo tool={tool} size={12} />);
    const el = getByRole("img", { name: label });
    // OpenAI's bundled mark is a thin white-glyph PNG and Antigravity's is a
    // 22-blur masked SVG; both wash out when an <img>/mask rasterises them at
    // the model picker's ~12px size. They render as crisp self-coloured
    // inline <svg> vectors instead, so they stay visible in the rail.
    expect(el.tagName.toLowerCase()).toBe("svg");
  });

  it.each([
    ["antigravity-cli"],
    ["antigravity"],
    ["antigravity-sdk"],
  ])("renders %s as the official bundled colour <img> at Settings sizes (>=16px)", (tool) => {
    const { getByAltText } = render(<ProviderLogo tool={tool} size={20} />);
    const img = getByAltText("Antigravity") as HTMLImageElement;
    // The lobehub colour mark renders crisply at larger sizes (Settings + agent
    // cards); only the ~12px picker falls back to the inline AgyLogo above.
    expect(img.tagName).toBe("IMG");
    expect(img.getAttribute("src")).toBeTruthy();
  });

  it.each([
    ["grok", "Grok"],
    // Grok Build (the `grok-build` ACP agent) reuses the Grok API provider's mark.
    ["grok-build", "Grok"],
    ["opencode", "OpenCode"],
  ])("swaps %s between a light and dark asset by theme", (tool, label) => {
    const { setTheme } = useThemeStore.getState();

    setTheme("light");
    const { getByRole, rerender } = render(<ProviderLogo tool={tool} size={20} />);
    const lightEl = getByRole("img", { name: label }) as HTMLImageElement;
    expect(lightEl.tagName).toBe("IMG");
    const lightSrc = lightEl.getAttribute("src");
    expect(lightSrc).toBeTruthy();

    setTheme("dark");
    rerender(<ProviderLogo tool={tool} size={20} />);
    const darkEl = getByRole("img", { name: label }) as HTMLImageElement;
    const darkSrc = darkEl.getAttribute("src");
    expect(darkSrc).toBeTruthy();
    // The two themes resolve to different bundled assets.
    expect(darkSrc).not.toBe(lightSrc);

    setTheme("dark"); // restore default
  });
});
