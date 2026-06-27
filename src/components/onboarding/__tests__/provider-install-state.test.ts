import { describe, it, expect } from "vitest";

import { isProviderInstalled } from "@/components/onboarding/provider-install-state";
import type { ProviderScan } from "@/lib/api";

/**
 * Regression guard for "Ollama installed but onboarding shows it as
 * Installable". The onboarding picker splits CLI providers into "Installed on
 * this device" vs "Installable" via this helper.
 *
 * Local Ollama is detected through the live system scan, whose `ollama` row is
 * `{ running, installed, models }`. `installed` is the durable signal — the
 * daemon answering OR the `ollama` binary being present on disk — so an
 * installed-but-stopped daemon (or one whose 2 s HTTP probe lost the race on
 * the first scan) is still bucketed under "Installed on this device" instead of
 * flapping into "Installable". `running` alone is fragile: the picker's scan
 * snapshot is taken seconds before the verify step's re-scan, so a daemon that
 * is merely slow to answer was mis-bucketed as not installed.
 */
function makeScan(overrides: Partial<ProviderScan> = {}): ProviderScan {
  const cli = { installed: false, authenticated: false, path: null };
  return {
    claude_code: { ...cli },
    codex_cli: { ...cli },
    kimi_code: { ...cli },
    antigravity_cli: { ...cli },
    antigravity_sdk: { ...cli },
    opencode: { ...cli },
    cursor_cli: { ...cli },
    grok_build: { ...cli },
    github_copilot: { ...cli },
    hermes_agent: { ...cli },
    ollama: { running: false, installed: false, models: [] },
    env_keys: { anthropic: false, openai: false, gemini: false, groq: false },
    ...overrides,
  };
}

describe("isProviderInstalled", () => {
  it("treats a running local Ollama daemon as installed (no scanKey needed)", () => {
    const scan = makeScan({ ollama: { running: true, installed: true, models: ["llama3.2:1b"] } });
    expect(isProviderInstalled({ ollama: true }, scan)).toBe(true);
  });

  it("treats an installed-but-stopped Ollama daemon as installed", () => {
    // The binary is on disk (`installed: true`) but the daemon isn't answering
    // yet. This is the bug the user hit: Ollama was installed, the first scan's
    // probe found the daemon down, and the picker wrongly showed "Installable".
    const scan = makeScan({ ollama: { running: false, installed: true, models: [] } });
    expect(isProviderInstalled({ ollama: true }, scan)).toBe(true);
  });

  it("treats Ollama as not installed when neither the daemon nor the binary is present", () => {
    const scan = makeScan({ ollama: { running: false, installed: false, models: [] } });
    expect(isProviderInstalled({ ollama: true }, scan)).toBe(false);
  });

  it("returns false for the Ollama row before the scan has loaded", () => {
    expect(isProviderInstalled({ ollama: true }, null)).toBe(false);
  });

  it("detects a CLI agent via its scanKey installed flag", () => {
    const scan = makeScan({
      claude_code: { installed: true, authenticated: true, path: "/usr/bin/claude" },
    });
    expect(isProviderInstalled({ scanKey: "claude_code" }, scan)).toBe(true);
  });

  it("treats a not-installed CLI agent as not installed", () => {
    expect(isProviderInstalled({ scanKey: "codex_cli" }, makeScan())).toBe(false);
  });

  it("returns false for a row with neither an ollama flag nor a scanKey", () => {
    const scan = makeScan({ ollama: { running: true, installed: true, models: [] } });
    expect(isProviderInstalled({}, scan)).toBe(false);
  });
});
