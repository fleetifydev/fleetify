import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { CatalogPlugin, PluginInstall } from "@/types/plugin";

// The plugin-store does `import * as api from "@/lib/plugin-api"`, so the mock
// factory must export EVERY symbol the store touches off that namespace — any
// missing one is `undefined` and the store throws the moment an action runs.
// `applyUpdate` is the one this test asserts on; the rest are inert stubs.
const { applyUpdateMock, fetchInstallsMock } = vi.hoisted(() => ({
  applyUpdateMock: vi.fn(),
  fetchInstallsMock: vi.fn(),
}));

vi.mock("@/lib/plugin-api", () => ({
  applyUpdate: applyUpdateMock,
  fetchInstalls: fetchInstallsMock,
  listCatalog: vi.fn().mockResolvedValue([]),
  fetchSources: vi.fn().mockResolvedValue([]),
  setAutoUpdate: vi.fn(),
  installPlugin: vi.fn(),
  uninstallPlugin: vi.fn(),
  uninstallScope: vi.fn(),
  setMasterEnabled: vi.fn(),
  setScope: vi.fn(),
  addSource: vi.fn(),
  deleteSource: vi.fn(),
  setSourceEnabled: vi.fn(),
  refreshSource: vi.fn(),
}));

// applyUpdate mirrors install: it refreshes + probes the MCP store afterwards.
vi.mock("@/stores/mcp-store", () => ({
  useMCPStore: { getState: () => ({ fetchAll: vi.fn(), refresh: vi.fn() }) },
}));

import { usePluginStore } from "@/stores/plugin-store";
import { InstalledTab } from "../InstalledTab";

function manifest(name: string, version: string) {
  return {
    name, version,
    description: "",
    providers: [],
    tags: [],
    requires_secrets: [],
    declares: { mcp_servers: 0, templates: 0, workflows: 0, prompts: 0, providers: {} },
  };
}

function install(name: string, version: string): PluginInstall {
  return {
    id: name,
    plugin_name: name,
    version,
    source_id: "s",
    commit_sha: "abc",
    install_path: "/tmp",
    auto_update: true,
    master_enabled: true,
    installed_at: null,
    last_updated_at: null,
    manifest: manifest(name, version),
    enablements: [],
  };
}

function catalog(name: string, version: string): CatalogPlugin {
  return {
    source_id: "s",
    source_name: "Src",
    source_is_official: false,
    path: name,
    featured: false,
    manifest: manifest(name, version),
  };
}

beforeEach(() => {
  applyUpdateMock.mockReset().mockResolvedValue(undefined);
  fetchInstallsMock.mockReset().mockResolvedValue([]);
  usePluginStore.setState({ installs: [], catalog: [], loadingInstalls: false });
});

describe("InstalledTab update banner", () => {
  it("shows 'N updates available' and Update all triggers applyUpdate per updatable install", async () => {
    usePluginStore.setState({
      installs: [install("alpha", "0.1.0"), install("beta", "1.0.0")],
      catalog: [catalog("alpha", "0.2.0"), catalog("beta", "1.0.0")], // only alpha has an update
    });

    render(<InstalledTab onOpenDetail={() => {}} />);

    // Singular/plural copy + only the updatable count.
    expect(screen.getByText("1 update available")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Update all"));

    await waitFor(() => expect(applyUpdateMock).toHaveBeenCalledTimes(1));
    expect(applyUpdateMock).toHaveBeenCalledWith("alpha");
  });

  it("renders no banner when nothing is updatable", () => {
    usePluginStore.setState({
      installs: [install("alpha", "0.2.0")],
      catalog: [catalog("alpha", "0.2.0")],
    });

    render(<InstalledTab onOpenDetail={() => {}} />);

    expect(screen.queryByText(/update.*available/i)).not.toBeInTheDocument();
    expect(screen.queryByText("Update all")).not.toBeInTheDocument();
  });
});
