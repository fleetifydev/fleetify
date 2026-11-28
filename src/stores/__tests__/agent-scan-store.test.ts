import { describe, it, expect, vi, beforeEach } from "vitest";

const backendFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ backendFetch }));

import { useAgentScanStore, resetAgentScanStoreForTests } from "../agent-scan-store";

const ok = (body: unknown) => ({ ok: true, json: async () => body });
const row = (id: string, authenticated: boolean) => ({
  id, display_name: id, installed: true, authenticated, path: "/x", install_hint: "", login_hint: "",
});

beforeEach(() => {
  resetAgentScanStoreForTests();
  backendFetch.mockReset();
});

describe("agent scan store", () => {
  it("loads the scan and forces a rescan on demand", async () => {
    backendFetch.mockResolvedValue(ok({ "claude-code": row("claude-code", false) }));
    await useAgentScanStore.getState().refresh();
    expect(backendFetch).toHaveBeenLastCalledWith("/api/agents/scan", expect.anything());
    expect(useAgentScanStore.getState().status).toBe("ready");

    backendFetch.mockResolvedValue(ok({ "claude-code": row("claude-code", true) }));
    await useAgentScanStore.getState().refresh(true);
    expect(backendFetch).toHaveBeenLastCalledWith("/api/agents/scan?refresh=1", expect.anything());
    expect(useAgentScanStore.getState().scan["claude-code"]!.authenticated).toBe(true);
  });

  it("keeps the last good scan when a refresh fails", async () => {
    backendFetch.mockResolvedValue(ok({ "codex-cli": row("codex-cli", true) }));
    await useAgentScanStore.getState().refresh();
    backendFetch.mockRejectedValue(new Error("offline"));
    await useAgentScanStore.getState().refresh(true);
    const s = useAgentScanStore.getState();
    expect(s.status).toBe("ready");
    expect(s.refreshing).toBe(false);
    expect(s.scan["codex-cli"]!.authenticated).toBe(true);
  });

  it("reports an error only when no scan ever loaded", async () => {
    backendFetch.mockResolvedValue({ ok: false, status: 500 });
    await useAgentScanStore.getState().refresh();
    expect(useAgentScanStore.getState().status).toBe("error");
  });

  it("shares one request between concurrent callers", async () => {
    let resolve: (v: unknown) => void = () => {};
    backendFetch.mockReturnValue(new Promise((r) => (resolve = r)));
    const a = useAgentScanStore.getState().refresh();
    const b = useAgentScanStore.getState().refresh();
    resolve(ok({}));
    await Promise.all([a, b]);
    expect(backendFetch).toHaveBeenCalledTimes(1);
  });
});
