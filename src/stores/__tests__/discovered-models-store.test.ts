import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchAgentModels, fetchProviderModels, revalidateCatalog } from "@/lib/api";
import { buildPickerGroups, resolveModelChip } from "@/lib/picker-groups";
import type { ProviderTile } from "@/lib/providers-api";
import {
  useDiscoveredModelsStore,
  REMOTE_CATALOG_AGENTS,
  LIVE_PROBE_AGENTS,
} from "../discovered-models-store";

vi.mock("@/lib/api", () => ({
  fetchAgentModels: vi.fn(async () => ({ models: [], current: null })),
  fetchProviderModels: vi.fn(async () => []),
  // Default: the catalog hasn't moved, so discovery paths behave exactly as
  // they did before the freshness probe existed.
  revalidateCatalog: vi.fn(async () => ({
    changed: false,
    probed: true,
    commit: "c0",
    tag: "main",
  })),
  updateSession: vi.fn(async () => ({})),
}));

const mockedAgent = vi.mocked(fetchAgentModels);
const mockedProvider = vi.mocked(fetchProviderModels);
const mockedRevalidate = vi.mocked(revalidateCatalog);

const baseTile = (
  id: string,
  display_name: string,
  kind: "cli" | "api" | "local_http",
  opts: Partial<ProviderTile> = {},
): ProviderTile => ({
  spec: {
    id,
    display_name,
    kind,
    default_base_url: "",
    auth: { kind: "none" },
    default_models: [],
    extras: {},
    bin: "",
    auth_indicators: [],
    install_hint: "",
    login_hint: "",
  },
  connected: kind !== "cli",
  has_key: kind !== "cli",
  enabled_models: [],
  is_default: false,
  capabilities: {
    permission: { kind: "none" },
    tool_matrix: null,
    timing: { permission: "spawn", effort: "spawn" },
    model_efforts: [],
  },
  ...opts,
});

const TILES: ProviderTile[] = [
  baseTile("claude-code", "Claude Code", "cli", { connected: true }),
  baseTile("openai", "OpenAI", "api"),
];

beforeEach(() => {
  // mockReset (not mockClear): drops any per-test mockImplementation so the
  // empty-discovery default below can't leak between tests.
  mockedAgent.mockReset().mockResolvedValue({ models: [], current: null });
  mockedProvider.mockReset().mockResolvedValue([]);
  mockedRevalidate
    .mockReset()
    .mockResolvedValue({ changed: false, probed: true, commit: "c0", tag: "main" });
  useDiscoveredModelsStore.setState({ models: {}, hydrated: false, catalogCommit: null });
});

describe("discovered-models-store revalidate", () => {
  const OPUS_6 = [
    { id: "claude-opus-6", label: "Opus 6", default: true },
    { id: "claude-sonnet-5", label: "Sonnet 5" },
  ];

  it("does no work while the catalog hasn't moved", async () => {
    const did = await useDiscoveredModelsStore.getState().revalidate(TILES);
    expect(did).toBe(false);
    expect(mockedAgent).not.toHaveBeenCalled();
    // The probed identity is still recorded, so the next move is detectable.
    expect(useDiscoveredModelsStore.getState().catalogCommit).toBe("c0");
  });

  it("re-discovers and heals the selected model when the catalog moves", async () => {
    const { useAppStore } = await import("@/stores/app-store");
    useAppStore.setState({
      sessions: [
        // Pinned to a model the new catalog dropped.
        { id: "s1", tool: "claude-code", model_name: "claude-opus-5" },
        // Still served — must be left alone.
        { id: "s2", tool: "claude-code", model_name: "claude-sonnet-5" },
      ] as never,
      composer: {
        ...useAppStore.getState().composer,
        open: true,
        tool: "claude-code",
        modelName: "claude-opus-5",
      },
    });
    mockedRevalidate.mockResolvedValue({
      changed: true,
      probed: true,
      commit: "c1",
      tag: "v2026.08.01",
    });
    mockedAgent.mockImplementation(async (id: string) =>
      id === "claude-code" ? { models: OPUS_6, current: null } : { models: [], current: null },
    );

    const did = await useDiscoveredModelsStore.getState().revalidate(TILES);

    expect(did).toBe(true);
    const app = useAppStore.getState();
    expect(app.sessions.find((s) => s.id === "s1")?.model_name).toBe("claude-opus-6");
    expect(app.sessions.find((s) => s.id === "s2")?.model_name).toBe("claude-sonnet-5");
    expect(app.composer.modelName).toBe("claude-opus-6");
    expect(useDiscoveredModelsStore.getState().catalogCommit).toBe("c1");
  });

  it("leaves selections untouched when the move brings no discoverable lineup", async () => {
    const { useAppStore } = await import("@/stores/app-store");
    useAppStore.setState({
      sessions: [{ id: "s1", tool: "claude-code", model_name: "claude-opus-5" }] as never,
    });
    mockedRevalidate.mockResolvedValue({ changed: true, probed: true, commit: "c2", tag: "main" });
    // Catalog moved but discovery came back empty (offline mid-flight): the
    // user's pick must survive — resetting the fleet on a blip is far worse
    // than showing a model that's on its way out.
    mockedAgent.mockResolvedValue({ models: [], current: null });

    await useDiscoveredModelsStore.getState().revalidate(TILES);

    expect(useAppStore.getState().sessions[0]?.model_name).toBe("claude-opus-5");
  });
});

describe("discovered-models-store hydrate", () => {
  it("eagerly fetches remote-catalog agents + connected API providers, NOT live-probe agents", async () => {
    await useDiscoveredModelsStore.getState().hydrate(TILES);
    const agentIds = mockedAgent.mock.calls.map((c) => c[0]);
    for (const a of REMOTE_CATALOG_AGENTS) expect(agentIds).toContain(a);
    // Live-probe agents spawn a local CLI/ACP process — too heavy for mount.
    for (const a of LIVE_PROBE_AGENTS) expect(agentIds).not.toContain(a);
    expect(mockedProvider.mock.calls.map((c) => c[0])).toEqual(["openai"]);
  });

  it("resolves a remote-catalog-only model's display name after hydrate (the claude-fable-5 chip regression)", async () => {
    mockedAgent.mockImplementation(async (id: string) =>
      id === "claude-code"
        ? { models: [{ id: "claude-fable-5", label: "Fable 5", ctx: "200K" }], current: null }
        : { models: [], current: null },
    );
    await useDiscoveredModelsStore.getState().hydrate(TILES);
    // The composer chip resolves through the same groups — before this store,
    // a remount lost the picker-fetched catalog and the chip showed the raw id.
    const groups = buildPickerGroups(TILES, ["claude-code"], useDiscoveredModelsStore.getState().models);
    expect(resolveModelChip(groups, "claude-code", "claude-fable-5").label).toBe("Fable 5");
  });

  it("carries the catalog default flag into stored picker models", async () => {
    mockedAgent.mockImplementation(async (id: string) =>
      id === "claude-code"
        ? {
            models: [
              { id: "claude-opus-4-8", label: "Opus 4.8", ctx: "200K", default: true },
              { id: "claude-fable-5", label: "Fable 5", ctx: "200K" },
            ],
            current: null,
          }
        : { models: [], current: null },
    );
    await useDiscoveredModelsStore.getState().hydrate(TILES);
    const models = useDiscoveredModelsStore.getState().models["claude-code"] ?? [];
    expect(models.find((m) => m.id === "claude-opus-4-8")?.default).toBe(true);
    expect(models.find((m) => m.id !== "claude-opus-4-8")?.default).toBe(false);
  });

  it("is single-flight: a second hydrate does not refetch", async () => {
    await useDiscoveredModelsStore.getState().hydrate(TILES);
    const calls = mockedAgent.mock.calls.length;
    await useDiscoveredModelsStore.getState().hydrate(TILES);
    expect(mockedAgent.mock.calls.length).toBe(calls);
  });

  it("keeps the static fallback on empty discovery (no empty lists stored)", async () => {
    await useDiscoveredModelsStore.getState().hydrate(TILES);
    expect(useDiscoveredModelsStore.getState().models).toEqual({});
  });
});

describe("discovered-models-store discoverLive", () => {
  it("fetches ALL agents (incl. live-probe) + connected API providers, passing the cwd", async () => {
    await useDiscoveredModelsStore.getState().discoverLive(TILES, "/work/proj");
    const agentIds = mockedAgent.mock.calls.map((c) => c[0]);
    for (const a of [...REMOTE_CATALOG_AGENTS, ...LIVE_PROBE_AGENTS]) {
      expect(agentIds).toContain(a);
    }
    expect(mockedAgent.mock.calls.every((c) => c[1] === "/work/proj")).toBe(true);
    expect(mockedProvider.mock.calls.map((c) => c[0])).toEqual(["openai"]);
  });
});

describe("discovered-models-store reconcileFleetDefault", () => {
  afterEach(() => {
    // Drop the per-test electronAPI stub so it can't leak into other suites.
    delete (window as { electronAPI?: unknown }).electronAPI;
  });

  it("reconcileFleetDefault rewrites a stale config.defaultModel to the provider's flagged default", async () => {
    const setConfig = vi.fn(async () => true);
    Object.defineProperty(window, "electronAPI", {
      configurable: true,
      value: {
        getConfig: async () => ({ defaultProvider: "claude-code", defaultModel: "claude-opus-4-7" /* gone */ }),
        setConfig,
      },
    });
    // discovered models for claude-code, opus-4-8 flagged default
    useDiscoveredModelsStore.setState({ models: { "claude-code": [
      { id: "claude-sonnet-4-6", label: "Sonnet 4.6" } as any,
      { id: "claude-opus-4-8", label: "Opus 4.8", default: true } as any,
    ] } });
    await useDiscoveredModelsStore.getState().reconcileFleetDefault();
    expect(setConfig).toHaveBeenCalledWith(expect.objectContaining({ defaultModel: "claude-opus-4-8", defaultProvider: "claude-code" }));
  });

  it("reconcileFleetDefault leaves a still-valid config.defaultModel untouched", async () => {
    const setConfig = vi.fn(async () => true);
    Object.defineProperty(window, "electronAPI", {
      configurable: true,
      value: {
        getConfig: async () => ({ defaultProvider: "claude-code", defaultModel: "claude-opus-4-8" }),
        setConfig,
      },
    });
    useDiscoveredModelsStore.setState({ models: { "claude-code": [
      { id: "claude-opus-4-8", label: "Opus 4.8", default: true } as any,
    ] } });
    await useDiscoveredModelsStore.getState().reconcileFleetDefault();
    expect(setConfig).not.toHaveBeenCalled();
  });
});
