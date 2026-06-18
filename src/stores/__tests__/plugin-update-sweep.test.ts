import { describe, it, expect, vi, beforeEach } from "vitest";

const { applyUpdateMock, fetchInstallsMock, listCatalogMock } = vi.hoisted(() => ({
  applyUpdateMock: vi.fn(),
  fetchInstallsMock: vi.fn(),
  listCatalogMock: vi.fn(),
}));

// The plugin-store does `import * as api from "@/lib/plugin-api"`, so the mock
// factory must export EVERY symbol the store touches off that namespace — any
// missing one is `undefined` and the store throws the moment an action calls it.
vi.mock("@/lib/plugin-api", () => ({
  applyUpdate: applyUpdateMock,
  fetchInstalls: fetchInstallsMock,
  listCatalog: listCatalogMock,
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

// applyUpdate mirrors install, which refreshes the MCP store after the mutation.
vi.mock("@/stores/mcp-store", () => ({
  useMCPStore: { getState: () => ({ fetchAll: vi.fn(), refresh: vi.fn() }) },
}));

import { usePluginStore } from "../plugin-store";

const install = (over: any) => ({
  id: over.plugin_name, plugin_name: over.plugin_name, version: over.version,
  source_id: "s", auto_update: over.auto_update ?? true, master_enabled: true,
  manifest: { requires_secrets: over.secrets ?? [] }, enablements: [], ...over,
});
const cat = (over: any) => ({
  path: over.plugin_name, name: over.plugin_name,
  manifest: { name: over.plugin_name, version: over.version, requires_secrets: over.secrets ?? [] },
});

beforeEach(() => {
  applyUpdateMock.mockReset().mockResolvedValue({ ok: true, version: "x" });
  fetchInstallsMock.mockReset().mockResolvedValue([]);
  listCatalogMock.mockReset().mockResolvedValue([]);
  usePluginStore.setState({ installs: [], catalog: [] });
});

describe("autoUpdateSweep", () => {
  it("auto-applies safe updates for auto-on plugins, skips major/secret/opted-out", async () => {
    usePluginStore.setState({
      installs: [
        install({ plugin_name: "safe", version: "0.1.0" }),                    // minor → apply
        install({ plugin_name: "major", version: "0.9.0" }),                   // major → skip
        install({ plugin_name: "secret", version: "0.1.0", secrets: [{key:"A",label:"A"}] }), // adds B → skip
        install({ plugin_name: "off", version: "0.1.0", auto_update: false }), // opted out → skip
        install({ plugin_name: "current", version: "0.1.0" }),                 // no update → skip
      ],
      catalog: [
        cat({ plugin_name: "safe", version: "0.2.0" }),
        cat({ plugin_name: "major", version: "1.0.0" }),
        cat({ plugin_name: "secret", version: "0.2.0", secrets: [{key:"A",label:"A"},{key:"B",label:"B"}] }),
        cat({ plugin_name: "off", version: "0.2.0" }),
        cat({ plugin_name: "current", version: "0.1.0" }),
      ],
    });
    await usePluginStore.getState().autoUpdateSweep();
    const applied = applyUpdateMock.mock.calls.map((c: any[]) => c[0]).sort();
    expect(applied).toEqual(["safe"]);
  });

  it("a second concurrent sweep is a no-op while one is in flight", async () => {
    // one safe update available
    usePluginStore.setState({
      installs: [install({ plugin_name: "safe", version: "0.1.0" })],
      catalog: [cat({ plugin_name: "safe", version: "0.2.0" })],
    });
    // make applyUpdate hang until we release it, so the first sweep is "in flight"
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    applyUpdateMock.mockReset().mockImplementation(() => gate.then(() => ({ ok: true, version: "0.2.0" })));

    const first = usePluginStore.getState().autoUpdateSweep();   // starts, blocks on applyUpdate
    await Promise.resolve();                                     // let `first` reach the await
    const second = usePluginStore.getState().autoUpdateSweep();  // should early-return immediately
    await second;                                                // resolves now (no-op)
    expect(applyUpdateMock).toHaveBeenCalledTimes(1);            // second did NOT call applyUpdate again
    release();                                                   // let the first finish
    await first;
    expect(applyUpdateMock).toHaveBeenCalledTimes(1);            // still exactly one apply for "safe"
  });
});
