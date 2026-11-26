/**
 * Visual-state tests for OllamaConfigCard. The card derives its
 * presence-detection state from the `health` prop owned by
 * useProviderHealth in the parent (Settings → Models). These tests pin
 * the health-kind branches and the Install / Cancel callbacks, plus the
 * optional API-key field and the per-model "Running" badge.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { OllamaConfigCard } from "../ollama-config-card";
import type { ProviderTile } from "@/lib/providers-api";
import type { OllamaHealth } from "@/hooks/use-provider-health";

vi.mock("@/hooks/use-providers-config", () => ({
  useProvidersConfig: () => ({
    setOllamaBaseUrl: vi.fn(),
    setEnabledModels: vi.fn(),
  }),
}));

const apiMock = vi.hoisted(() => ({
  ollamaProbe: vi.fn(),
  ollamaSuggestions: vi.fn(),
  ollamaPs: vi.fn(),
  getKeyPreview: vi.fn(),
  setKey: vi.fn(),
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

beforeEach(() => {
  apiMock.ollamaProbe.mockReset();
  apiMock.ollamaSuggestions.mockResolvedValue([]);
  apiMock.ollamaPs.mockReset();
  apiMock.getKeyPreview.mockReset();
  apiMock.setKey.mockReset();
  // Safe defaults: daemon unreachable, nothing running, no stored key.
  apiMock.ollamaProbe.mockResolvedValue({
    ok: false,
    running: false,
    base_url: "",
    code: "NETWORK",
  });
  apiMock.ollamaPs.mockResolvedValue({
    ok: false,
    running: false,
    base_url: "",
    code: "NETWORK",
  });
  apiMock.getKeyPreview.mockResolvedValue({ ok: true, preview: null });
  apiMock.setKey.mockResolvedValue({ ok: true });
});

function tile(): ProviderTile {
  return {
    spec: {
      id: "ollama",
      display_name: "Ollama",
      kind: "local_http",
      default_base_url: "http://localhost:11434",
      auth: { kind: "none" },
      default_models: [],
      extras: {},
      bin: "",
      auth_indicators: [],
      install_hint: "",
      login_hint: "",
    },
    connected: false,
    has_key: false,
    enabled_models: [],
  };
}

describe("OllamaConfigCard health-driven states", () => {
  it("renders 'Detecting…' pill when scanning", () => {
    const health: OllamaHealth = { kind: "scanning" };
    render(
      <OllamaConfigCard
        tile={tile()}
        health={health}
        onInstall={() => {}}
        onCancelInstall={() => {}}
      />,
    );
    expect(screen.getByText(/Detecting/i)).toBeInTheDocument();
  });

  it("renders 'Not connected' + Install button when missing", () => {
    const health: OllamaHealth = { kind: "missing" };
    render(
      <OllamaConfigCard
        tile={tile()}
        health={health}
        onInstall={() => {}}
        onCancelInstall={() => {}}
      />,
    );
    expect(screen.getByText(/Not connected/i)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Install Ollama/i }),
    ).toBeInTheDocument();
  });

  it("renders 'Connected' + N models when running", () => {
    const health: OllamaHealth = {
      kind: "running",
      models: ["llama3", "qwen2"],
    };
    render(
      <OllamaConfigCard
        tile={tile()}
        health={health}
        onInstall={() => {}}
        onCancelInstall={() => {}}
      />,
    );
    expect(screen.getByText(/2 models/i)).toBeInTheDocument();
  });

  it("renders install progress panel when installing (waiting-daemon)", () => {
    const health: OllamaHealth = {
      kind: "installing",
      substate: "waiting-daemon",
    };
    render(
      <OllamaConfigCard
        tile={tile()}
        health={health}
        onInstall={() => {}}
        onCancelInstall={() => {}}
      />,
    );
    // "Starting Ollama" appears twice — pill label + progress panel
    // heading — so getAllByText.
    expect(screen.getAllByText(/Starting Ollama/i).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /Cancel/i })).toBeInTheDocument();
  });

  it("renders 'browser opened' notice when openedBrowser=true", () => {
    const health: OllamaHealth = {
      kind: "installing",
      substate: "waiting-daemon",
      openedBrowser: true,
    };
    render(
      <OllamaConfigCard
        tile={tile()}
        health={health}
        onInstall={() => {}}
        onCancelInstall={() => {}}
      />,
    );
    expect(
      screen.getByText(/Installer opened in your browser/i),
    ).toBeInTheDocument();
  });

  it("clicking Install calls onInstall", () => {
    const onInstall = vi.fn();
    const health: OllamaHealth = { kind: "missing" };
    render(
      <OllamaConfigCard
        tile={tile()}
        health={health}
        onInstall={onInstall}
        onCancelInstall={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Install Ollama/i }));
    expect(onInstall).toHaveBeenCalled();
  });

  it("clicking Cancel during install calls onCancelInstall", () => {
    const onCancelInstall = vi.fn();
    const health: OllamaHealth = {
      kind: "installing",
      substate: "running-installer",
    };
    render(
      <OllamaConfigCard
        tile={tile()}
        health={health}
        onInstall={() => {}}
        onCancelInstall={onCancelInstall}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Cancel/i }));
    expect(onCancelInstall).toHaveBeenCalled();
  });
});

describe("OllamaConfigCard optional key + running badge", () => {
  it("shows an optional API key field and reads any saved preview on mount", async () => {
    const health: OllamaHealth = { kind: "running", models: [] };
    render(
      <OllamaConfigCard
        tile={tile()}
        health={health}
        onInstall={() => {}}
        onCancelInstall={() => {}}
      />,
    );
    expect(await screen.findByLabelText("API key (optional)")).toBeInTheDocument();
    expect(apiMock.getKeyPreview).toHaveBeenCalledWith("ollama");
  });

  it("displays a masked preview when a key is already stored", async () => {
    apiMock.getKeyPreview.mockResolvedValue({ ok: true, preview: "sk-•••N5kJ" });
    const health: OllamaHealth = { kind: "running", models: [] };
    render(
      <OllamaConfigCard
        tile={tile()}
        health={health}
        onInstall={() => {}}
        onCancelInstall={() => {}}
      />,
    );
    expect(await screen.findByText(/sk-•••N5kJ/)).toBeInTheDocument();
  });

  it("saving the optional key calls providers.setKey('ollama', value)", async () => {
    const health: OllamaHealth = { kind: "running", models: [] };
    render(
      <OllamaConfigCard
        tile={tile()}
        health={health}
        onInstall={() => {}}
        onCancelInstall={() => {}}
      />,
    );
    const input = await screen.findByLabelText("API key (optional)");
    fireEvent.change(input, { target: { value: "secret-token-123" } });
    fireEvent.click(screen.getByRole("button", { name: /save api key/i }));
    await waitFor(() =>
      expect(apiMock.setKey).toHaveBeenCalledWith("ollama", "secret-token-123"),
    );
  });

  it("badges a model that appears in /api/ps as Running", async () => {
    apiMock.ollamaProbe.mockResolvedValue({
      ok: true,
      running: true,
      base_url: "http://localhost:11434",
      models: [{ name: "llama3" }, { name: "qwen2" }],
    });
    apiMock.ollamaPs.mockResolvedValue({
      ok: true,
      running: true,
      base_url: "http://localhost:11434",
      models: [{ name: "llama3" }],
    });
    const health: OllamaHealth = { kind: "running", models: ["llama3", "qwen2"] };
    render(
      <OllamaConfigCard
        tile={tile()}
        health={health}
        onInstall={() => {}}
        onCancelInstall={() => {}}
      />,
    );
    // Wait for probe → ps to resolve and the badge to render.
    expect(await screen.findByText("Running")).toBeInTheDocument();
    expect(screen.getAllByText("Running")).toHaveLength(1);
    expect(screen.getByText("llama3").closest("label")).toHaveTextContent("Running");
    expect(
      screen.getByText("qwen2").closest("label"),
    ).not.toHaveTextContent("Running");
  });
});

describe("OllamaConfigCard base-URL removed + auto-detect", () => {
  it("does not render a Base URL input or Detect button (base URL is auto-detected)", async () => {
    const health: OllamaHealth = { kind: "running", models: [] };
    render(
      <OllamaConfigCard
        tile={tile()}
        health={health}
        onInstall={() => {}}
        onCancelInstall={() => {}}
      />,
    );
    // The API-key field proves the card is expanded (auto-expands on running).
    await screen.findByLabelText("API key (optional)");
    expect(screen.queryByText("Base URL")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /detect/i }),
    ).not.toBeInTheDocument();
  });

  it("auto-detects an auth-gated endpoint: shows 'Needs API key' and hides Install even when health=missing", async () => {
    apiMock.ollamaProbe.mockResolvedValue({
      ok: false,
      running: true,
      base_url: "http://remote:11434",
      code: "AUTH",
      error: "HTTP 401",
    });
    const health: OllamaHealth = { kind: "missing" };
    render(
      <OllamaConfigCard
        tile={tile()}
        health={health}
        onInstall={() => {}}
        onCancelInstall={() => {}}
      />,
    );
    expect(await screen.findByText(/Needs API key/i)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Install Ollama/i }),
    ).not.toBeInTheDocument();
  });

  it("auto-expands and reveals the API key field when the endpoint needs a key", async () => {
    apiMock.ollamaProbe.mockResolvedValue({
      ok: false,
      running: true,
      base_url: "http://remote:11434",
      code: "AUTH",
      error: "HTTP 401",
    });
    const health: OllamaHealth = { kind: "missing" };
    render(
      <OllamaConfigCard
        tile={tile()}
        health={health}
        onInstall={() => {}}
        onCancelInstall={() => {}}
      />,
    );
    expect(
      await screen.findByLabelText("API key (optional)"),
    ).toBeInTheDocument();
  });
});

describe("OllamaConfigCard auth-needed states", () => {
  it("shows 'Needs API key' when a probe returns AUTH and no key is saved", async () => {
    apiMock.ollamaProbe.mockResolvedValue({
      ok: false,
      running: true,
      base_url: "http://remote:11434",
      code: "AUTH",
      error: "HTTP 401",
    });
    const health: OllamaHealth = { kind: "running", models: [] };
    render(
      <OllamaConfigCard
        tile={tile()}
        health={health}
        onInstall={() => {}}
        onCancelInstall={() => {}}
      />,
    );
    expect(await screen.findByText(/Needs API key/i)).toBeInTheDocument();
  });

  it("shows 'Key rejected' when a probe returns AUTH but a key is already saved", async () => {
    apiMock.getKeyPreview.mockResolvedValue({ ok: true, preview: "sk-•••abc" });
    apiMock.ollamaProbe.mockResolvedValue({
      ok: false,
      running: true,
      base_url: "http://remote:11434",
      code: "AUTH",
      error: "HTTP 403",
    });
    const health: OllamaHealth = { kind: "running", models: [] };
    render(
      <OllamaConfigCard
        tile={tile()}
        health={health}
        onInstall={() => {}}
        onCancelInstall={() => {}}
      />,
    );
    expect(await screen.findByText(/Key rejected/i)).toBeInTheDocument();
  });
});
