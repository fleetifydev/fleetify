/**
 * The updater bridge on `window.fleetify`: the shell's three updater commands
 * (`updater_status`, `updater_check`, `updater_restart`, registered in
 * src-tauri/src/lib.rs and allowed in src-tauri/permissions/app-commands.toml)
 * and the event every status change goes out as (`fleet:updater-status`,
 * `UPDATE_EVENT` in src-tauri/src/shell/updater.rs). A name that doesn't match
 * only shows at runtime. Loads the REAL injected preload script, like
 * preload-api-token.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const PRELOAD_SRC = readFileSync(
  resolve(process.cwd(), "src-tauri/src/preload.js"),
  "utf8",
);

type Handler = (message: { payload: unknown }) => void;

const invoke = vi.fn((_cmd: string, _args?: unknown) => Promise.resolve<unknown>({ state: "idle" }));

// Tauri's `listen` registers the handler at once, then resolves with the
// function that removes it.
const handlers = new Map<string, Set<Handler>>();
const unlisten = vi.fn();
function register(event: string, handler: Handler): () => void {
  const set = handlers.get(event) ?? new Set<Handler>();
  set.add(handler);
  handlers.set(event, set);
  return () => {
    unlisten();
    set.delete(handler);
  };
}
const listen = vi.fn((event: string, handler: Handler) => Promise.resolve(register(event, handler)));

/** Sends `payload` as the shell would, to every handler registered for `event`. */
function emit(event: string, payload: unknown) {
  for (const handler of handlers.get(event) ?? []) handler({ payload });
}

const tauri = { core: { invoke }, event: { listen } as { listen: typeof listen } | undefined };
(window as unknown as { __TAURI__: unknown }).__TAURI__ = tauri;

new Function(PRELOAD_SRC)();

const flush = () => new Promise<void>((done) => setTimeout(done, 0));

beforeEach(() => {
  invoke.mockClear();
  listen.mockClear();
  unlisten.mockClear();
  handlers.clear();
  tauri.event = { listen };
});

describe("preload window.fleetify updater commands", () => {
  it.each([
    ["updaterStatus", "updater_status"],
    ["updaterCheck", "updater_check"],
    ["updaterRestart", "updater_restart"],
  ] as const)("%s invokes %s with no arguments and resolves to its answer", async (method, command) => {
    invoke.mockResolvedValueOnce({ state: "ready", version: "0.2.1" });
    await expect(window.fleetify?.[method]()).resolves.toEqual({ state: "ready", version: "0.2.1" });
    expect(invoke.mock.calls).toEqual([[command, {}]]);
  });

  it("updaterRestart rejects with the shell's error, so the UI can show it", async () => {
    invoke.mockRejectedValueOnce("Couldn't install the update.");
    await expect(window.fleetify?.updaterRestart()).rejects.toBe("Couldn't install the update.");
  });
});

describe("preload window.fleetify.onUpdaterStatus", () => {
  it("listens on fleet:updater-status and passes each status the shell sends", async () => {
    const cb = vi.fn();
    const unsubscribe = window.fleetify!.onUpdaterStatus(cb);
    expect(listen).toHaveBeenCalledWith("fleet:updater-status", expect.any(Function));
    await flush();

    emit("fleet:updater-status", { state: "downloading", version: "0.2.1", downloaded: 5, total: 10 });
    emit("fleet:updater-status", { state: "ready", version: "0.2.1" });
    expect(cb.mock.calls).toEqual([
      [{ state: "downloading", version: "0.2.1", downloaded: 5, total: 10 }],
      [{ state: "ready", version: "0.2.1" }],
    ]);
    unsubscribe();
  });

  it("returns an unsubscribe that removes the listener", async () => {
    const cb = vi.fn();
    const unsubscribe = window.fleetify!.onUpdaterStatus(cb);
    await flush();

    unsubscribe();
    expect(unlisten).toHaveBeenCalledTimes(1);
    emit("fleet:updater-status", { state: "upToDate" });
    expect(cb).not.toHaveBeenCalled();
  });

  it("an unsubscribe before the listener is in place still removes it", async () => {
    // React runs an effect's cleanup at once when a component unmounts
    // straight after mounting, before `listen` has resolved.
    let finishListen!: () => void;
    listen.mockImplementationOnce((event, handler) => {
      const remove = register(event, handler);
      return new Promise<() => void>((done) => { finishListen = () => done(remove); });
    });
    const cb = vi.fn();
    const unsubscribe = window.fleetify!.onUpdaterStatus(cb);
    unsubscribe();

    emit("fleet:updater-status", { state: "checking" });
    expect(cb).not.toHaveBeenCalled();
    finishListen();
    await flush();
    expect(unlisten).toHaveBeenCalledTimes(1);
    expect(handlers.get("fleet:updater-status")?.size ?? 0).toBe(0);
  });

  it("without Tauri's event API it subscribes to nothing, and the unsubscribe is safe", () => {
    tauri.event = undefined;
    const unsubscribe = window.fleetify!.onUpdaterStatus(vi.fn());
    expect(() => unsubscribe()).not.toThrow();
  });
});
