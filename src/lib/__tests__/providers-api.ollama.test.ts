import { describe, it, expect } from "vitest";
import { providers } from "@/lib/providers-api";

// jsdom provides `window` but no `window.electronAPI`, so every call below
// hits the deterministic no-op fallbacks in `api()`. These assert the shapes
// callers branch on (`r.ok`, `r.code`) stay stable without a Tauri bridge.
describe("providers ollama no-bridge fallbacks", () => {
  it("ollamaPs falls back to not-running NETWORK", async () => {
    const r = await providers.ollamaPs(null);
    expect(r.ok).toBe(false);
    expect(r.running).toBe(false);
    // `code` only exists on the `ok:false` arm of the union — narrow first
    // (mirrors the ollamaDelete test below) so this stays type-correct.
    if (!r.ok) expect(r.code).toBe("NETWORK");
  });

  it("ollamaPs tolerates a base url argument", async () => {
    const r = await providers.ollamaPs("http://localhost:11434");
    expect(r.ok).toBe(false);
  });

  it("ollamaPull falls back to not-ok with an error", async () => {
    const r = await providers.ollamaPull("llama3", null);
    expect(r.ok).toBe(false);
    expect(typeof r.error).toBe("string");
  });

  it("ollamaPullCancel falls back to not-ok", async () => {
    const r = await providers.ollamaPullCancel("llama3");
    expect(r.ok).toBe(false);
  });

  it("ollamaDelete falls back to not-ok NETWORK", async () => {
    const r = await providers.ollamaDelete("x");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("NETWORK");
  });

  it("setOllamaCloudBaseUrl falls back to not-ok", async () => {
    const r = await providers.setOllamaCloudBaseUrl("https://ollama.com");
    expect(r.ok).toBe(false);
  });

  it("onOllamaPullProgress returns a no-op unsubscribe fn", () => {
    const unsub = providers.onOllamaPullProgress(() => {});
    expect(typeof unsub).toBe("function");
    // Calling it must not throw.
    expect(() => unsub()).not.toThrow();
  });
});
