import { describe, it, expect } from "vitest";

import { isProviderInstalled } from "@/components/onboarding/provider-install-state";
import type { ProviderScan } from "@/lib/api";

/**
 * Regression guard for "Ollama installed but onboarding shows it as
 * Installable". The onboarding picker splits CLI providers into "Installed on
 * this device" vs "Installable" via this helper. Local Ollama is an HTTP
 * daemon (scan shape `{ running, models }`), not a CLI binary on PATH, so it
 * carries no `scanKey` — and the old helper, keyed only on `scanKey`, could
 * never see the running daemon and always bucketed Ollama as Installable.
 */
function makeScan(overrides: Partial<ProviderScan> = {}): ProviderScan {
  const cli = { installed: false, authenticated: false, path: null };
  return {
    claude_cli: { ...cli },
    codex_cli: { ...cli },
    kimi_cli: { ...cli },
    agy_cli: { ...cli },
    antigravity_sdk: { ...cli },
    opencode_cli: { ...cli },
    cursor_cli: { ...cli },
    grok_cli: { ...cli },
    github_copilot_cli: { ...cli },
    hermes_cli: { ...cli },
    ollama: { running: false, models: [] },
    env_keys: { anthropic: false, openai: false, gemini: false, groq: false },
    ...overrides,
  };
}

describe("isProviderInstalled", () => {
  it("treats a running local Ollama daemon as installed (no scanKey needed)", () => {
    const scan = makeScan({ ollama: { running: true, models: ["llama3.2:1b"] } });
    expect(isProviderInstalled({ ollama: true }, scan)).toBe(true);
  });

  it("treats a stopped Ollama daemon as not installed", () => {
    const scan = makeScan({ ollama: { running: false, models: [] } });
    expect(isProviderInstalled({ ollama: true }, scan)).toBe(false);
  });

  it("returns false for the Ollama row before the scan has loaded", () => {
    expect(isProviderInstalled({ ollama: true }, null)).toBe(false);
  });

  it("detects a CLI agent via its scanKey installed flag", () => {
    const scan = makeScan({
      claude_cli: { installed: true, authenticated: true, path: "/usr/bin/claude" },
    });
    expect(isProviderInstalled({ scanKey: "claude_cli" }, scan)).toBe(true);
  });

  it("treats a not-installed CLI agent as not installed", () => {
    expect(isProviderInstalled({ scanKey: "codex_cli" }, makeScan())).toBe(false);
  });

  it("returns false for a row with neither an ollama flag nor a scanKey", () => {
    const scan = makeScan({ ollama: { running: true, models: [] } });
    expect(isProviderInstalled({}, scan)).toBe(false);
  });
});
