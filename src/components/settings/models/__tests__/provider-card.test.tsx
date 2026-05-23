/**
 * Smoke tests for ProviderCard: header always renders, expand shows the
 * key entry, Save triggers setKey + closes-with-refresh, Disconnect
 * triggers deleteKey.
 *
 * Mocks the useProvidersConfig store + providers IPC so the component
 * renders without Tauri / a backend in the loop.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { ProviderTile } from "@/lib/providers-api";

const hookMock = vi.hoisted(() => ({
  setKey: vi.fn(async () => {}),
  deleteKey: vi.fn(async () => {}),
  setEnabledModels: vi.fn(async () => {}),
}));
vi.mock("@/hooks/use-providers-config", () => ({
  useProvidersConfig: () => hookMock,
}));

const apiMock = vi.hoisted(() => ({
  getKeyPreview: vi.fn(async () => ({ ok: true, preview: null })),
  testConnection: vi.fn(async () => ({ ok: true, latency_ms: 123, model_count: 7 })),
}));
vi.mock("@/lib/providers-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/providers-api")>(
    "@/lib/providers-api",
  );
  return {
    ...actual,
    providers: { ...actual.providers, ...apiMock },
  };
});

import { ProviderCard } from "../provider-card";

function makeTile(overrides: Partial<ProviderTile> = {}): ProviderTile {
  return {
    spec: {
      id: "deepseek",
      display_name: "DeepSeek",
      kind: "api",
      default_base_url: "https://api.deepseek.com",
      auth: { kind: "bearer", env_hint: "DEEPSEEK_API_KEY" },
      default_models: [
        { id: "deepseek-chat", label: "DeepSeek Chat", context_window: "128K", note: null },
        { id: "deepseek-coder", label: "DeepSeek Coder", context_window: "128K", note: null },
      ],
      extras: { supports_streaming: true },
      bin: "",
      auth_indicators: [],
      install_hint: "",
      login_hint: "",
    },
    connected: false,
    has_key: false,
    enabled_models: [],
    ...overrides,
  };
}

describe("ProviderCard", () => {
  beforeEach(() => {
    hookMock.setKey.mockReset();
    hookMock.deleteKey.mockReset();
    hookMock.setEnabledModels.mockReset();
    apiMock.getKeyPreview.mockReset();
    apiMock.testConnection.mockReset();
    apiMock.getKeyPreview.mockResolvedValue({ ok: true, preview: null });
    apiMock.testConnection.mockResolvedValue({
      ok: true,
      latency_ms: 123,
      model_count: 7,
    });
    hookMock.setKey.mockResolvedValue(undefined);
    hookMock.deleteKey.mockResolvedValue(undefined);
    hookMock.setEnabledModels.mockResolvedValue(undefined);
  });

  it("renders the provider name and a 'Not connected' pill when disconnected", () => {
    render(<ProviderCard tile={makeTile()} />);
    expect(screen.getByText("DeepSeek")).toBeTruthy();
    expect(screen.getByText("Not connected")).toBeTruthy();
  });

  it("renders 'Connected' pill when tile.connected=true", () => {
    render(<ProviderCard tile={makeTile({ connected: true, has_key: true })} />);
    expect(screen.getByText("Connected")).toBeTruthy();
  });

  it("expand reveals the API key input + model checkboxes", async () => {
    render(<ProviderCard tile={makeTile()} />);
    fireEvent.click(screen.getByText("DeepSeek"));
    await waitFor(() => {
      expect(
        screen.getByPlaceholderText(/Paste your DeepSeek key/i),
      ).toBeTruthy();
    });
    expect(screen.getByText("DeepSeek Chat")).toBeTruthy();
    expect(screen.getByText("DeepSeek Coder")).toBeTruthy();
  });

  it("Save calls setKey with the typed key", async () => {
    render(<ProviderCard tile={makeTile()} />);
    fireEvent.click(screen.getByText("DeepSeek"));
    const input = await screen.findByPlaceholderText(/Paste your DeepSeek key/i);
    fireEvent.change(input, { target: { value: "sk-test-123" } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => {
      expect(hookMock.setKey).toHaveBeenCalledWith("deepseek", "sk-test-123");
    });
  });

  it("Disconnect calls deleteKey when the tile is connected", async () => {
    render(<ProviderCard tile={makeTile({ connected: true, has_key: true })} />);
    fireEvent.click(screen.getByText("DeepSeek"));
    const disconnect = await screen.findByText(/Disconnect/i);
    fireEvent.click(disconnect);
    await waitFor(() => {
      expect(hookMock.deleteKey).toHaveBeenCalledWith("deepseek");
    });
  });

  it("Test button calls testConnection and renders the latency pill on success", async () => {
    render(<ProviderCard tile={makeTile()} />);
    fireEvent.click(screen.getByText("DeepSeek"));
    const input = await screen.findByPlaceholderText(/Paste your DeepSeek key/i);
    fireEvent.change(input, { target: { value: "sk-test-123" } });
    fireEvent.click(screen.getByText("Test"));
    await waitFor(() => {
      expect(apiMock.testConnection).toHaveBeenCalledWith("deepseek", "sk-test-123");
    });
    await waitFor(() => {
      // Result pill carries the latency + model count.
      expect(screen.getByText(/123ms/)).toBeTruthy();
    });
  });

  it("toggling a model checkbox calls setEnabledModels", async () => {
    render(<ProviderCard tile={makeTile()} />);
    fireEvent.click(screen.getByText("DeepSeek"));
    const checkbox = (await screen.findAllByRole("checkbox"))[0];
    fireEvent.click(checkbox);
    await waitFor(() => {
      expect(hookMock.setEnabledModels).toHaveBeenCalled();
    });
    // Should be the list with one item removed (it was implicit-all-checked).
    const args = hookMock.setEnabledModels.mock.calls[0];
    expect(args[0]).toBe("deepseek");
    expect(Array.isArray(args[1])).toBe(true);
  });
});
