import { describe, it, expect, vi, beforeEach } from "vitest";
import { fetchAgentModels, fetchProviderModels } from "@/lib/api";
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
}));

const mockedAgent = vi.mocked(fetchAgentModels);
const mockedProvider = vi.mocked(fetchProviderModels);

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
  useDiscoveredModelsStore.setState({ models: {}, hydrated: false });
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
