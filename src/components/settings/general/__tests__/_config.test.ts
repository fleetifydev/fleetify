import { describe, it, expect, vi, beforeEach } from "vitest";
import { saveConfigPatch } from "../_config";

// config_set replaces the whole fleet.config.json. Two saves that overlap
// must not both merge into the same old copy, or the second write undoes the
// first. saveConfigPatch runs them one at a time, each reading the config
// just before it writes.

let stored: Record<string, unknown>;

function installConfig(
  setConfig: (next: Record<string, unknown>) => Promise<unknown> = async (next) => {
    stored = next;
    return { ok: true };
  },
) {
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    // A copy taken when the read is made, like the real IPC.
    getConfig: vi.fn(async () => ({ ...stored })),
    setConfig: vi.fn(setConfig),
  };
}

beforeEach(() => {
  stored = { onboardingComplete: true };
});

describe("saveConfigPatch", () => {
  it("keeps both of two overlapping saves", async () => {
    installConfig();
    await Promise.all([
      saveConfigPatch({ launchOnStartup: true }),
      saveConfigPatch({ updatesAuto: false }),
    ]);
    expect(stored).toEqual({
      onboardingComplete: true,
      launchOnStartup: true,
      updatesAuto: false,
    });
  });

  it("runs the next save after one that failed", async () => {
    let writes = 0;
    installConfig(async (next) => {
      writes += 1;
      if (writes === 1) throw new Error("disk full");
      stored = next;
      return { ok: true };
    });
    const failed = saveConfigPatch({ launchOnStartup: true });
    const next = saveConfigPatch({ updatesAuto: false });
    // The caller of the failed save still sees its error…
    await expect(failed).rejects.toThrow("disk full");
    // …and the save queued behind it still runs.
    await expect(next).resolves.toBeUndefined();
    expect(stored).toEqual({ onboardingComplete: true, updatesAuto: false });
  });
});
