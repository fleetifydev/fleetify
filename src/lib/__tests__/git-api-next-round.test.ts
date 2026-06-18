import { describe, it, expect, vi, beforeEach } from "vitest";
import { git } from "@/lib/git-api";

describe("git.deleteRemoteBranch", () => {
  beforeEach(() => {
    (globalThis as any).window = {};
  });

  it("forwards folder + branch + stored auth to the IPC", async () => {
    const spy = vi.fn().mockResolvedValue({ ok: true });
    // electronAPI property name matches the GitAPI interface method name —
    // same convention as mergePR (no `git` prefix). See preload.js.
    (window as any).electronAPI = { deleteRemoteBranch: spy };
    const r = await git.deleteRemoteBranch("/repo", "fleet/foo-abc123");
    // authMethod is left undefined (backend probes); authStored carries the
    // persisted method, which is undefined when localStorage is empty.
    expect(spy).toHaveBeenCalledWith("/repo", "fleet/foo-abc123", undefined, undefined);
    expect(r.ok).toBe(true);
  });

  it("no-ops to ok:false when electron is unavailable", async () => {
    (window as any).electronAPI = undefined;
    const r = await git.deleteRemoteBranch("/repo", "x");
    expect(r.ok).toBe(false);
  });
});
