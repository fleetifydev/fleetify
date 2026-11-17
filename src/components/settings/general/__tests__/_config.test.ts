import { describe, it, expect, vi, beforeEach } from "vitest";
import { saveConfigPatch } from "../_config";

// config_set replaces the whole fleet.config.json. Two saves that overlap
// must not both merge into the same old copy, or the second write undoes the
// first. saveConfigPatch runs them one at a time, each reading the config
// just before it writes.
//
// config_set answers `{ ok: true }`, or `{ ok: false, error }` when the file
// couldn't be written; it doesn't throw for a failed save. saveConfigPatch
// turns that answer into a rejection, so a card can't miss it.

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

  it("rejects with the shell's message when the save fails, and runs the next save", async () => {
    let writes = 0;
    installConfig(async (next) => {
      writes += 1;
      if (writes === 1) {
        return { ok: false, error: "Couldn't save Fleetify's settings: disk full" };
      }
      stored = next;
      return { ok: true };
    });
    const failed = saveConfigPatch({ launchOnStartup: true });
    const next = saveConfigPatch({ updatesAuto: false });
    // The caller of the failed save sees the shell's message…
    await expect(failed).rejects.toThrow("Couldn't save Fleetify's settings: disk full");
    // …and the save queued behind it still runs, without the failed change.
    await expect(next).resolves.toBeUndefined();
    expect(stored).toEqual({ onboardingComplete: true, updatesAuto: false });
  });

  it("rejects with a fallback message when a failed save carries no message", async () => {
    installConfig(async () => ({ ok: false }));
    await expect(saveConfigPatch({ launchOnStartup: true })).rejects.toThrow(
      "Couldn't save this setting.",
    );
  });

  it("rejects when the bridge throws, and runs the next save", async () => {
    let writes = 0;
    installConfig(async (next) => {
      writes += 1;
      if (writes === 1) throw new Error("IPC closed");
      stored = next;
      return { ok: true };
    });
    const failed = saveConfigPatch({ launchOnStartup: true });
    const next = saveConfigPatch({ updatesAuto: false });
    await expect(failed).rejects.toThrow("IPC closed");
    await expect(next).resolves.toBeUndefined();
    expect(stored).toEqual({ onboardingComplete: true, updatesAuto: false });
  });

  it("rejects with an Error when the bridge throws a bare string", async () => {
    installConfig(async () => {
      throw "command config_set not found";
    });
    const failed = saveConfigPatch({ launchOnStartup: true });
    await expect(failed).rejects.toBeInstanceOf(Error);
    await expect(failed).rejects.toThrow("Couldn't save this setting.");
  });

  it("rejects when the bridge is missing", async () => {
    (window as unknown as { electronAPI: unknown }).electronAPI = undefined;
    await expect(saveConfigPatch({ launchOnStartup: true })).rejects.toThrow(
      "Couldn't save this setting.",
    );
  });

  it("never writes a config it couldn't read first", async () => {
    // Without getConfig the write would replace the whole file with the patch.
    const setConfig = vi.fn(async () => ({ ok: true }));
    (window as unknown as { electronAPI: unknown }).electronAPI = { setConfig };
    await expect(saveConfigPatch({ launchOnStartup: true })).rejects.toThrow(
      "Couldn't save this setting.",
    );
    expect(setConfig).not.toHaveBeenCalled();
  });
});
