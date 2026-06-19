import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { MainAgentWidget } from "../onboarding-chat";
import { useDiscoveredModelsStore } from "@/stores/discovered-models-store";
import type { ProviderTile } from "@/lib/providers-api";

// The onboarding fleet-default picker must source models from the SAME live
// discovery store the in-app composer / Fleet / Settings pickers use — not the
// static CLI_MODELS fallback. This regression guards against it silently
// reverting to the stale hardcoded list (the reported bug).

// discoverLive (fired on the widget's mount) must not hit the network; empty
// results keep whatever we've pre-seeded into the store.
vi.mock("@/lib/api", () => ({
  fetchAgentModels: vi.fn(async () => ({ models: [], current: null })),
  fetchProviderModels: vi.fn(async () => []),
  // OnboardingChat (pulled in transitively) imports these; never called here.
  apiScanProviders: vi.fn(async () => null),
  checkPythonRuntime: vi.fn(async () => null),
}));

// Neutralise import-time analytics side effects.
vi.mock("@/lib/posthog", () => ({
  capture: vi.fn(),
  optIn: vi.fn(),
  optOut: vi.fn(),
}));

const claudeTile: ProviderTile = {
  spec: {
    id: "claude-code",
    display_name: "Claude Code",
    kind: "cli",
    default_base_url: "",
    auth: { kind: "none" },
    // CLI agents ship an EMPTY catalog list — the live lineup arrives via
    // discovery. With no discovered models the picker falls to CLI_MODELS.
    default_models: [],
    extras: {},
    bin: "",
    auth_indicators: [],
    install_hint: "",
    login_hint: "",
  },
  connected: true,
  has_key: false,
  enabled_models: [],
  is_default: false,
  capabilities: {
    permission: { kind: "none" },
    tool_matrix: null,
    timing: { permission: "spawn", effort: "spawn" },
    model_efforts: [],
  },
};

const claudeProvider = {
  id: "claude-code",
  label: "Claude Code",
  logo: "claude-code",
  kind: "cli" as const,
  hint: "",
};

beforeEach(() => {
  useDiscoveredModelsStore.setState({ models: {}, hydrated: false });
});

describe("onboarding MainAgentWidget — live model discovery", () => {
  it("shows the discovered (live) models, not the hardcoded CLI_MODELS fallback", () => {
    // A live catalog whose labels are deliberately distinct from CLI_MODELS'
    // ("Opus 4.8" etc.) so we can tell which source the picker read.
    useDiscoveredModelsStore.setState({
      models: {
        "claude-code": [
          { id: "live-opus", label: "LIVE Opus", effort: { kind: "none" }, supports_effort: false },
          { id: "live-sonnet", label: "LIVE Sonnet", effort: { kind: "none" }, supports_effort: false },
        ],
      },
      hydrated: true,
    });

    render(<MainAgentWidget providers={[claudeProvider]} tiles={[claudeTile]} onPick={vi.fn()} />);
    // Two-stage: click the provider to reach its model list.
    fireEvent.click(screen.getByText("Claude Code"));

    expect(screen.getByText("LIVE Opus")).toBeInTheDocument();
    expect(screen.getByText("LIVE Sonnet")).toBeInTheDocument();
    // The stale hardcoded fallback must NOT appear when live models exist.
    expect(screen.queryByText("Opus 4.8")).not.toBeInTheDocument();
  });

  it("picks the live first model when a provider auto-resolves (single model)", () => {
    useDiscoveredModelsStore.setState({
      models: {
        "claude-code": [
          { id: "live-only", label: "LIVE Only", effort: { kind: "none" }, supports_effort: false },
        ],
      },
      hydrated: true,
    });
    const onPick = vi.fn();
    render(<MainAgentWidget providers={[claudeProvider]} tiles={[claudeTile]} onPick={onPick} />);
    // One discovered model → the second click is skipped; onPick fires with the
    // live id/label directly (not a CLI_MODELS entry).
    fireEvent.click(screen.getByText("Claude Code"));
    expect(onPick).toHaveBeenCalledWith(claudeProvider, "live-only", "LIVE Only");
  });

  it("falls back to the static CLI list only when discovery is empty", () => {
    render(<MainAgentWidget providers={[claudeProvider]} tiles={[claudeTile]} onPick={vi.fn()} />);
    fireEvent.click(screen.getByText("Claude Code"));
    // No discovered models seeded → CLI_MODELS is the safety net so the picker
    // is never blank.
    expect(screen.getByText("Opus 4.8")).toBeInTheDocument();
  });
});
