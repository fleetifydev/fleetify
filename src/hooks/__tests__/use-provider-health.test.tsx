import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useProviderHealth } from "../use-provider-health";

vi.mock("@/lib/api", () => ({
  apiScanProviders: vi.fn(async () => ({
    claude_cli: { installed: false, authenticated: false, path: null },
    gemini_cli: { installed: false, authenticated: false, path: null },
    codex_cli:  { installed: false, authenticated: false, path: null },
    ollama:     { running: false, models: [] },
    env_keys:   { anthropic: false, openai: false, gemini: false, groq: false },
  })),
}));

const testConnectionMock = vi.fn();
vi.mock("@/lib/providers-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/providers-api")>("@/lib/providers-api");
  return {
    ...actual,
    providers: { ...actual.providers, testConnection: (id: string, key: string) => testConnectionMock(id, key) },
  };
});

function tileWithKey(id: string, hasKey: boolean) {
  return {
    spec: { id, display_name: id, kind: "api" as const, default_base_url: "", auth: { kind: "none" as const }, default_models: [], extras: {}, bin: "", auth_indicators: [], install_hint: "", login_hint: "" },
    connected: hasKey, has_key: hasKey, enabled_models: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  (window as unknown as { electronAPI?: unknown }).electronAPI = {
    installOllama: vi.fn(async () => ({ success: true })),
  };
});

describe("useProviderHealth", () => {
  it("ollama starts in 'scanning' then resolves to 'missing' when scan reports running=false", async () => {
    const { result } = renderHook(() => useProviderHealth({ tiles: [] }));
    expect(result.current.ollama.kind).toBe("scanning");
    await waitFor(() => expect(result.current.ollama.kind).toBe("missing"));
  });

  it("ollama resolves to 'running' with models when scan reports running=true", async () => {
    const { apiScanProviders } = await import("@/lib/api");
    (apiScanProviders as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      claude_cli: { installed: false, authenticated: false, path: null },
      gemini_cli: { installed: false, authenticated: false, path: null },
      codex_cli:  { installed: false, authenticated: false, path: null },
      ollama:     { running: true, models: ["llama3", "qwen2"] },
      env_keys:   { anthropic: false, openai: false, gemini: false, groq: false },
    });
    const { result } = renderHook(() => useProviderHealth({ tiles: [] }));
    await waitFor(() => expect(result.current.ollama.kind).toBe("running"));
    if (result.current.ollama.kind === "running") {
      expect(result.current.ollama.models).toEqual(["llama3", "qwen2"]);
    }
  });

  it("provider with has_key=false stays no_key", async () => {
    const tiles = [tileWithKey("openai", false)];
    const { result } = renderHook(() => useProviderHealth({ tiles }));
    await waitFor(() => expect(result.current.providers.openai?.kind).toBe("no_key"));
    expect(testConnectionMock).not.toHaveBeenCalled();
  });

  it("provider with has_key=true goes testing → ok with latency", async () => {
    testConnectionMock.mockResolvedValueOnce({ ok: true, latency_ms: 123, model_count: 7 });
    const tiles = [tileWithKey("openai", true)];
    const { result } = renderHook(() => useProviderHealth({ tiles }));
    // testing first
    await waitFor(() => expect(result.current.providers.openai?.kind).toBe("testing"));
    // resolves to ok
    await waitFor(() => expect(result.current.providers.openai?.kind).toBe("ok"));
    if (result.current.providers.openai?.kind === "ok") {
      expect(result.current.providers.openai.latencyMs).toBe(123);
    }
  });

  it("provider failed test reflects code", async () => {
    testConnectionMock.mockResolvedValueOnce({ ok: false, code: "AUTH", error: "401" });
    const tiles = [tileWithKey("openai", true)];
    const { result } = renderHook(() => useProviderHealth({ tiles }));
    await waitFor(() => expect(result.current.providers.openai?.kind).toBe("failed"));
    if (result.current.providers.openai?.kind === "failed") {
      expect(result.current.providers.openai.code).toBe("AUTH");
    }
  });

  it("installOllama transitions through running-installer → waiting-daemon → running", async () => {
    const { apiScanProviders } = await import("@/lib/api");
    const installSpy = vi.fn(async () => ({ success: true }));
    (window as unknown as { electronAPI: { installOllama: typeof installSpy } }).electronAPI = { installOllama: installSpy };

    // First scan (mount) — missing.
    (apiScanProviders as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        claude_cli: { installed: false, authenticated: false, path: null },
        gemini_cli: { installed: false, authenticated: false, path: null },
        codex_cli:  { installed: false, authenticated: false, path: null },
        ollama:     { running: false, models: [] },
        env_keys:   { anthropic: false, openai: false, gemini: false, groq: false },
      })
      // Poll after install — running.
      .mockResolvedValueOnce({
        claude_cli: { installed: false, authenticated: false, path: null },
        gemini_cli: { installed: false, authenticated: false, path: null },
        codex_cli:  { installed: false, authenticated: false, path: null },
        ollama:     { running: true, models: ["llama3"] },
        env_keys:   { anthropic: false, openai: false, gemini: false, groq: false },
      });

    const { result } = renderHook(() => useProviderHealth({ tiles: [] }));
    await waitFor(() => expect(result.current.ollama.kind).toBe("missing"));

    await act(async () => { await result.current.installOllama(); });
    expect(installSpy).toHaveBeenCalled();
    await waitFor(() => expect(result.current.ollama.kind).toBe("running"));
  });

  it("installOllama browser fallback keeps polling and reports openedBrowser", async () => {
    const { apiScanProviders } = await import("@/lib/api");
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      installOllama: vi.fn(async () => ({ success: false, error: "needs admin", openedBrowser: true })),
    };
    (apiScanProviders as ReturnType<typeof vi.fn>).mockResolvedValue({
      claude_cli: { installed: false, authenticated: false, path: null },
      gemini_cli: { installed: false, authenticated: false, path: null },
      codex_cli:  { installed: false, authenticated: false, path: null },
      ollama:     { running: false, models: [] },
      env_keys:   { anthropic: false, openai: false, gemini: false, groq: false },
    });
    const { result } = renderHook(() => useProviderHealth({ tiles: [] }));
    await waitFor(() => expect(result.current.ollama.kind).toBe("missing"));
    void result.current.installOllama();
    await waitFor(() => {
      const o = result.current.ollama;
      expect(o.kind).toBe("installing");
      if (o.kind === "installing") {
        expect(o.openedBrowser).toBe(true);
        expect(o.substate).toBe("waiting-daemon");
      }
    });
  });

  it("cancelInstall returns to missing", async () => {
    const { apiScanProviders } = await import("@/lib/api");
    (apiScanProviders as ReturnType<typeof vi.fn>).mockResolvedValue({
      claude_cli: { installed: false, authenticated: false, path: null },
      gemini_cli: { installed: false, authenticated: false, path: null },
      codex_cli:  { installed: false, authenticated: false, path: null },
      ollama:     { running: false, models: [] },
      env_keys:   { anthropic: false, openai: false, gemini: false, groq: false },
    });
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      installOllama: vi.fn(() => new Promise(() => { /* never resolves */ })),
    };
    const { result } = renderHook(() => useProviderHealth({ tiles: [] }));
    await waitFor(() => expect(result.current.ollama.kind).toBe("missing"));
    void result.current.installOllama();
    await waitFor(() => expect(result.current.ollama.kind).toBe("installing"));
    act(() => { result.current.cancelInstall(); });
    expect(result.current.ollama.kind).toBe("missing");
  });
});
