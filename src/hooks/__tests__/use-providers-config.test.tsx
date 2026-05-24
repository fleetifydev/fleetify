/**
 * Smoke tests for the useProvidersConfig Zustand-backed hook. Mocks the
 * providers IPC wrapper at module level so we can drive store mutations
 * without Tauri in the loop.
 *
 * Each test calls `vi.resetModules()` + dynamic import so the
 * module-level store is fresh — module-level state would otherwise leak
 * across tests and make `fetchStarted` flicker between runs.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

const providersMock = vi.hoisted(() => ({
  listCatalog: vi.fn(),
  setKey: vi.fn(),
  getKeyPreview: vi.fn(),
  deleteKey: vi.fn(),
  testConnection: vi.fn(),
  ollamaProbe: vi.fn(),
  setEnabledModels: vi.fn(),
  setOllamaBaseUrl: vi.fn(),
  onChanged: vi.fn(() => () => {}),
}));

vi.mock("@/lib/providers-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/providers-api")>(
    "@/lib/providers-api",
  );
  return { ...actual, providers: providersMock };
});

const sampleTile = {
  spec: {
    id: "openai",
    display_name: "OpenAI",
    kind: "api" as const,
    default_base_url: "https://api.openai.com/v1",
    auth: { kind: "bearer" as const, env_hint: "OPENAI_API_KEY" },
    default_models: [
      { id: "o3", label: "o3", context_window: "200K", note: null, supports_effort: true },
    ],
    extras: { supports_streaming: true },
    bin: "",
    auth_indicators: [],
    install_hint: "",
    login_hint: "",
  },
  connected: false,
  has_key: false,
  enabled_models: [] as string[],
};

describe("useProvidersConfig", () => {
  beforeEach(() => {
    vi.resetModules();
    providersMock.listCatalog.mockReset();
    providersMock.setKey.mockReset();
    providersMock.deleteKey.mockReset();
    providersMock.setEnabledModels.mockReset();
    providersMock.setOllamaBaseUrl.mockReset();
    providersMock.onChanged.mockReset();
    providersMock.onChanged.mockReturnValue(() => {});
  });

  it("starts in loading, then populates tiles after initial listCatalog", async () => {
    providersMock.listCatalog.mockResolvedValueOnce({ ok: true, tiles: [sampleTile] });
    const { useProvidersConfig } = await import("../use-providers-config");

    const { result } = renderHook(() => useProvidersConfig());
    expect(result.current.loading).toBe(true);
    expect(result.current.tiles).toEqual([]);

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.tiles).toHaveLength(1);
    expect(result.current.tiles[0].spec.id).toBe("openai");
    expect(providersMock.listCatalog).toHaveBeenCalledTimes(1);
  });

  it("setKey calls IPC and triggers a refresh", async () => {
    // Initial fetch returns the disconnected tile, refresh returns the connected one.
    providersMock.listCatalog
      .mockResolvedValueOnce({ ok: true, tiles: [sampleTile] })
      .mockResolvedValueOnce({
        ok: true,
        tiles: [{ ...sampleTile, connected: true, has_key: true }],
      });
    providersMock.setKey.mockResolvedValueOnce({ ok: true });
    const { useProvidersConfig } = await import("../use-providers-config");

    const { result } = renderHook(() => useProvidersConfig());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.setKey("openai", "sk-test");
    });
    expect(providersMock.setKey).toHaveBeenCalledWith("openai", "sk-test");
    expect(providersMock.listCatalog).toHaveBeenCalledTimes(2);
    expect(result.current.tiles[0].connected).toBe(true);
  });

  it("setOllamaBaseUrl calls IPC and refreshes", async () => {
    providersMock.listCatalog.mockResolvedValue({ ok: true, tiles: [sampleTile] });
    providersMock.setOllamaBaseUrl.mockResolvedValueOnce({ ok: true });
    const { useProvidersConfig } = await import("../use-providers-config");

    const { result } = renderHook(() => useProvidersConfig());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.setOllamaBaseUrl("http://192.168.1.50:11434");
    });
    expect(providersMock.setOllamaBaseUrl).toHaveBeenCalledWith(
      "http://192.168.1.50:11434",
    );
    // Initial mount + refresh after mutation.
    expect(providersMock.listCatalog).toHaveBeenCalledTimes(2);
  });

  it("subscribes to providers-config-changed events and refreshes on fire", async () => {
    providersMock.listCatalog.mockResolvedValue({ ok: true, tiles: [sampleTile] });
    let firedHandler: ((p: unknown) => void) | null = null;
    providersMock.onChanged.mockImplementationOnce((cb) => {
      firedHandler = cb;
      return () => {};
    });
    const { useProvidersConfig } = await import("../use-providers-config");

    const { result } = renderHook(() => useProvidersConfig());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(firedHandler).toBeTruthy();
    expect(providersMock.listCatalog).toHaveBeenCalledTimes(1);

    await act(async () => {
      firedHandler!({});
      // Give the async refresh a microtask to flush.
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(providersMock.listCatalog).toHaveBeenCalledTimes(2),
    );
  });
});
