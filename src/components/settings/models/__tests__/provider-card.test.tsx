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
import type { ProviderHealth } from "@/hooks/use-provider-health";

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
        { id: "deepseek-chat", label: "DeepSeek Chat", context_window: "128K", note: null, supports_effort: false },
        { id: "deepseek-coder", label: "DeepSeek Coder", context_window: "128K", note: null, supports_effort: false },
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

const noKey: ProviderHealth = { kind: "no_key" };

describe("ProviderCard health pill", () => {
  beforeEach(() => {
    hookMock.setKey.mockReset();
    hookMock.deleteKey.mockReset();
    hookMock.setEnabledModels.mockReset();
    apiMock.getKeyPreview.mockReset();
    apiMock.testConnection.mockReset();
    apiMock.getKeyPreview.mockResolvedValue({ ok: true, preview: null });
    hookMock.setKey.mockResolvedValue(undefined);
    hookMock.deleteKey.mockResolvedValue(undefined);
    hookMock.setEnabledModels.mockResolvedValue(undefined);
  });

  it("renders 'Not connected' when health is no_key", () => {
    const health: ProviderHealth = { kind: "no_key" };
    render(
      <ProviderCard
        tile={makeTile({ has_key: false })}
        health={health}
        onHealthChange={() => {}}
      />,
    );
    expect(screen.getByText(/Not connected/i)).toBeInTheDocument();
  });

  it("renders 'Testing…' when health is testing", () => {
    const health: ProviderHealth = { kind: "testing" };
    render(
      <ProviderCard
        tile={makeTile({ has_key: true })}
        health={health}
        onHealthChange={() => {}}
      />,
    );
    expect(screen.getByText(/Testing/i)).toBeInTheDocument();
  });

  it("renders 'Connected · Xms' when health is ok", () => {
    const health: ProviderHealth = { kind: "ok", latencyMs: 142, modelCount: 7 };
    render(
      <ProviderCard
        tile={makeTile({ has_key: true, connected: true })}
        health={health}
        onHealthChange={() => {}}
      />,
    );
    expect(screen.getByText(/Connected · 142ms/)).toBeInTheDocument();
  });

  it("renders 'Error · CODE' when health is failed", () => {
    const health: ProviderHealth = { kind: "failed", code: "AUTH", message: "401" };
    render(
      <ProviderCard
        tile={makeTile({ has_key: true })}
        health={health}
        onHealthChange={() => {}}
      />,
    );
    expect(screen.getByText(/Error · AUTH/)).toBeInTheDocument();
  });

  it("calls onHealthChange after Save", async () => {
    const onHealthChange = vi.fn();
    const t = makeTile({ has_key: false });
    render(
      <ProviderCard
        tile={t}
        health={{ kind: "no_key" }}
        onHealthChange={onHealthChange}
      />,
    );
    // Expand the card.
    fireEvent.click(screen.getByRole("button", { name: /DeepSeek/i }));
    // Type a draft key.
    const input = screen.getByPlaceholderText(/Paste your DeepSeek key/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "sk-test" } });
    // Click Save.
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
    // Wait for async setKey + onHealthChange.
    await screen.findByPlaceholderText(/Enter a new key to replace/i, {}, { timeout: 2000 }).catch(() => {});
    expect(onHealthChange).toHaveBeenCalled();
  });
});

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
    render(<ProviderCard tile={makeTile()} health={noKey} onHealthChange={() => {}} />);
    expect(screen.getByText("DeepSeek")).toBeTruthy();
    expect(screen.getByText("Not connected")).toBeTruthy();
  });

  it("renders 'Connected' pill when health is ok", () => {
    const health: ProviderHealth = { kind: "ok", latencyMs: 50 };
    render(
      <ProviderCard
        tile={makeTile({ connected: true, has_key: true })}
        health={health}
        onHealthChange={() => {}}
      />,
    );
    expect(screen.getByText(/Connected/)).toBeTruthy();
  });

  it("expand reveals the API key input + model checkboxes", async () => {
    render(<ProviderCard tile={makeTile()} health={noKey} onHealthChange={() => {}} />);
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
    render(<ProviderCard tile={makeTile()} health={noKey} onHealthChange={() => {}} />);
    fireEvent.click(screen.getByText("DeepSeek"));
    const input = await screen.findByPlaceholderText(/Paste your DeepSeek key/i);
    fireEvent.change(input, { target: { value: "sk-test-123" } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => {
      expect(hookMock.setKey).toHaveBeenCalledWith("deepseek", "sk-test-123");
    });
  });

  it("Disconnect calls deleteKey when the tile is connected", async () => {
    render(
      <ProviderCard
        tile={makeTile({ connected: true, has_key: true })}
        health={noKey}
        onHealthChange={() => {}}
      />,
    );
    fireEvent.click(screen.getByText("DeepSeek"));
    const disconnect = await screen.findByText(/Disconnect/i);
    fireEvent.click(disconnect);
    await waitFor(() => {
      expect(hookMock.deleteKey).toHaveBeenCalledWith("deepseek");
    });
  });

  it("Test button calls testConnection and renders the latency pill on success", async () => {
    render(<ProviderCard tile={makeTile()} health={noKey} onHealthChange={() => {}} />);
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
    render(<ProviderCard tile={makeTile()} health={noKey} onHealthChange={() => {}} />);
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

function buildPerplexityTile(): ProviderTile {
  return {
    spec: {
      id: "perplexity",
      display_name: "Perplexity",
      kind: "api",
      default_base_url: "https://api.perplexity.ai",
      auth: { kind: "bearer", env_hint: "PERPLEXITY_API_KEY" },
      default_models: [
        { id: "sonar",                            label: "Sonar",            context_window: "128K", group: "Sonar API",  supports_effort: false },
        { id: "sonar-pro",                        label: "Sonar Pro",        context_window: "200K", group: "Sonar API",  supports_effort: false },
        { id: "anthropic/claude-sonnet-4-6",      label: "Claude Sonnet 4.6",context_window: "200K", group: "Agent API", endpoint: "https://api.perplexity.ai/v1/agent", supports_effort: false },
        { id: "google/gemini-3.5-flash",          label: "Gemini 3.5 Flash", context_window: "1M",   group: "Agent API", endpoint: "https://api.perplexity.ai/v1/agent", supports_effort: false },
      ],
      extras: { citations: true, search_results: true, supports_streaming: true },
      bin: "",
      auth_indicators: [],
      install_hint: "",
      login_hint: "",
    },
    connected: true,
    has_key: true,
    enabled_models: [],
  };
}

describe("ProviderCard Edit/Cancel flow (has_key tile)", () => {
  beforeEach(() => {
    hookMock.setKey.mockReset();
    hookMock.deleteKey.mockReset();
    hookMock.setEnabledModels.mockReset();
    apiMock.getKeyPreview.mockReset();
    apiMock.testConnection.mockReset();
    apiMock.getKeyPreview.mockResolvedValue({ ok: true, preview: "sk-•••N5kJ" });
    hookMock.setKey.mockResolvedValue(undefined);
    hookMock.deleteKey.mockResolvedValue(undefined);
    hookMock.setEnabledModels.mockResolvedValue(undefined);
  });

  it("collapses the input behind an Edit button when has_key is true", async () => {
    const tile = makeTile({ has_key: true, connected: true });
    render(<ProviderCard tile={tile} health={{ kind: "ok", latencyMs: 50 }} onHealthChange={() => {}} />);

    // Expand the card.
    fireEvent.click(screen.getByRole("button", { name: /DeepSeek/i }));

    // Saved-key view: masked preview loads async, then Edit + Disconnect appear;
    // raw key input must NOT be in the DOM.
    expect(await screen.findByText("sk-•••N5kJ")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Edit$/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Disconnect/ })).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/Enter a new key/i)).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/Paste your/i)).not.toBeInTheDocument();

    // Click Edit → input + Cancel appear.
    fireEvent.click(screen.getByRole("button", { name: /^Edit$/ }));
    await waitFor(() =>
      expect(screen.getByPlaceholderText(/Replace key/i)).toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: /Cancel/ })).toBeInTheDocument();

    // Cancel → back to saved-key view; input gone, Edit button back.
    fireEvent.click(screen.getByRole("button", { name: /Cancel/ }));
    await waitFor(() =>
      expect(screen.queryByPlaceholderText(/Replace key/i)).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: /^Edit$/ })).toBeInTheDocument();
  });
});

describe("ProviderCard grouping", () => {
  beforeEach(() => {
    apiMock.getKeyPreview.mockResolvedValue({ ok: true, preview: null });
    hookMock.setKey.mockResolvedValue(undefined);
    hookMock.deleteKey.mockResolvedValue(undefined);
    hookMock.setEnabledModels.mockResolvedValue(undefined);
  });

  it("renders both group headers for Perplexity", async () => {
    render(
      <ProviderCard
        tile={buildPerplexityTile()}
        health={noKey}
        onHealthChange={() => {}}
      />,
    );
    // Header expand: click the header button so the body renders.
    await fireEvent.click(screen.getByRole("button", { name: /Perplexity/ }));
    expect(screen.getByText("Sonar API")).toBeInTheDocument();
    expect(screen.getByText("Agent API")).toBeInTheDocument();
  });

  it("places models in their declared group", async () => {
    render(
      <ProviderCard
        tile={buildPerplexityTile()}
        health={noKey}
        onHealthChange={() => {}}
      />,
    );
    await fireEvent.click(screen.getByRole("button", { name: /Perplexity/ }));
    // Find the Sonar API heading's parent section and assert "Sonar Pro"
    // lives under it (not under Agent API).
    const sonarHeading = screen.getByText("Sonar API");
    const sonarSection = sonarHeading.parentElement!;
    expect(sonarSection.textContent).toContain("Sonar Pro");
    expect(sonarSection.textContent).not.toContain("Claude Sonnet");
  });
});
