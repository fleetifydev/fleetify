/**
 * Visual-state tests for OllamaConfigCard. The card now derives all of
 * its presence-detection state from the `health` prop owned by
 * useProviderHealth in the parent (Settings → Models). These tests
 * pin the 5 health-kind branches plus the Install / Cancel callbacks.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { OllamaConfigCard } from "../ollama-config-card";
import type { ProviderTile } from "@/lib/providers-api";
import type { OllamaHealth } from "@/hooks/use-provider-health";

vi.mock("@/hooks/use-providers-config", () => ({
  useProvidersConfig: () => ({
    setOllamaBaseUrl: vi.fn(),
    setEnabledModels: vi.fn(),
  }),
}));

vi.mock("@/lib/providers-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/providers-api")>(
    "@/lib/providers-api",
  );
  return {
    ...actual,
    providers: {
      ...actual.providers,
      ollamaProbe: vi.fn(async () => ({
        ok: false as const,
        running: false,
        base_url: "",
        code: "NETWORK" as const,
      })),
    },
  };
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

  it("renders 'Not installed' + Install button when missing", () => {
    const health: OllamaHealth = { kind: "missing" };
    render(
      <OllamaConfigCard
        tile={tile()}
        health={health}
        onInstall={() => {}}
        onCancelInstall={() => {}}
      />,
    );
    expect(screen.getByText(/Not installed/i)).toBeInTheDocument();
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
