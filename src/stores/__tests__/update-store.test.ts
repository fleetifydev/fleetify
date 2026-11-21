/**
 * The renderer's copy of the shell's updater status (src-tauri/src/shell/
 * updater.rs). It reads the status once, then follows the
 * `fleet:updater-status` events, and passes Check now and Restart to update
 * on to the shell.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { UpdateStatus } from "@/lib/api";
import { useUpdateStore } from "../update-store";

type Bridge = NonNullable<Window["fleetify"]>;

const READY: UpdateStatus = { state: "ready", version: "0.2.1" };
const INSTALLING: UpdateStatus = { state: "installing", version: "0.2.1" };
const downloading = (downloaded: number): UpdateStatus =>
  ({ state: "downloading", version: "0.2.1", downloaded, total: 10 });

/**
 * Installs a `window.fleetify` with the updater calls, each overridable.
 * `emit` sends a status the way the shell's event does, to whatever
 * `onUpdaterStatus` subscribed.
 */
function installBridge(over: Partial<Bridge> = {}) {
  let listener: ((status: UpdateStatus) => void) | null = null;
  const unsubscribe = vi.fn(() => { listener = null; });
  const bridge = {
    updaterStatus: vi.fn(async (): Promise<UpdateStatus> => ({ state: "idle" })),
    updaterCheck: vi.fn(async (): Promise<UpdateStatus> => ({ state: "upToDate" })),
    updaterRestart: vi.fn(async (): Promise<void> => {}),
    onUpdaterStatus: vi.fn((cb: (status: UpdateStatus) => void) => {
      listener = cb;
      return unsubscribe;
    }),
    ...over,
  };
  (window as { fleetify?: Partial<Bridge> }).fleetify = bridge;
  return { bridge, unsubscribe, emit: (status: UpdateStatus) => listener?.(status) };
}

const flush = () => new Promise<void>((done) => setTimeout(done, 0));
const state = () => useUpdateStore.getState();
const initial = useUpdateStore.getState();

beforeEach(() => {
  useUpdateStore.setState(initial, true);
  delete (window as { fleetify?: unknown }).fleetify;
});

describe("useUpdateStore.init", () => {
  it("reads the shell's status, then follows its events", async () => {
    const { bridge, emit } = installBridge({
      updaterStatus: vi.fn(async (): Promise<UpdateStatus> => ({ state: "upToDate" })),
    });
    const stop = state().init();
    await vi.waitFor(() => expect(state().status).toEqual({ state: "upToDate" }));
    expect(bridge.updaterStatus).toHaveBeenCalledTimes(1);
    expect(bridge.onUpdaterStatus).toHaveBeenCalledTimes(1);

    emit(downloading(5));
    expect(state().status).toEqual(downloading(5));
    emit(READY);
    expect(state().status).toEqual(READY);
    stop();
  });

  it("keeps a status from an event that arrives before the read answers", async () => {
    // The read may have been answered before that event went out.
    let answer!: (status: UpdateStatus) => void;
    const { emit } = installBridge({
      updaterStatus: vi.fn(() => new Promise<UpdateStatus>((done) => { answer = done; })),
    });
    const stop = state().init();
    emit(READY);
    answer(downloading(9));
    await flush();
    expect(state().status).toEqual(READY);
    stop();
  });

  it("returns an unsubscribe that stops following the shell", async () => {
    const { emit, unsubscribe } = installBridge();
    const stop = state().init();
    await vi.waitFor(() => expect(state().status).toEqual({ state: "idle" }));

    stop();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    emit(READY);
    expect(state().status).toEqual({ state: "idle" });
  });

  it("without window.fleetify the status stays null and nothing throws", async () => {
    const stop = state().init();
    expect(() => stop()).not.toThrow();
    await expect(state().check()).resolves.toBeUndefined();
    await expect(state().restart()).resolves.toBeUndefined();
    await flush();
    expect(state().status).toBeNull();
    expect(state().restartError).toBeNull();
  });

  it("with a bridge that has no updater calls, the status stays null and nothing throws", async () => {
    // Other tests, and older shells, install a window.fleetify without them.
    (window as { fleetify?: Partial<Bridge> }).fleetify = { getApiToken: vi.fn(async () => "t") };
    const stop = state().init();
    expect(() => stop()).not.toThrow();
    await state().check();
    await state().restart();
    await flush();
    expect(state().status).toBeNull();
  });
});

describe("useUpdateStore.check", () => {
  it("asks the shell to check and stores its answer", async () => {
    const { bridge } = installBridge({
      updaterCheck: vi.fn(async (): Promise<UpdateStatus> => READY),
    });
    await state().check();
    expect(bridge.updaterCheck).toHaveBeenCalledTimes(1);
    expect(state().status).toEqual(READY);
  });

  it("keeps a newer status from an event over the answer", async () => {
    // A check asked for while a background download runs is answered with
    // the status as it was then; the download may finish before that answer
    // arrives.
    let answer!: (status: UpdateStatus) => void;
    const { emit } = installBridge({
      updaterCheck: vi.fn(() => new Promise<UpdateStatus>((done) => { answer = done; })),
    });
    const stop = state().init();
    await vi.waitFor(() => expect(state().status).toEqual({ state: "idle" }));
    const checking = state().check();
    emit(READY);
    answer(downloading(9));
    await checking;
    expect(state().status).toEqual(READY);
    stop();
  });
});

describe("useUpdateStore.restart", () => {
  it("asks the shell to install the update", async () => {
    const { bridge } = installBridge();
    useUpdateStore.setState({ status: READY });
    await state().restart();
    expect(bridge.updaterRestart).toHaveBeenCalledTimes(1);
    expect(state().restartError).toBeNull();
  });

  it("keeps the update ready and says why when the install fails", async () => {
    // The shell puts the status back to ready and answers with an error,
    // so Restart to update can try again (R-P3-9).
    const { bridge, emit } = installBridge();
    vi.mocked(bridge.updaterRestart).mockImplementationOnce(async () => {
      emit(INSTALLING);
      emit(READY);
      throw "Couldn't install the update.";
    });
    const stop = state().init();
    await vi.waitFor(() => expect(state().status).toEqual({ state: "idle" }));
    emit(READY);

    await state().restart();
    expect(state().status).toEqual(READY);
    expect(state().restartError).toBe("Couldn't install the update.");

    // The next try starts without the old error.
    let finish!: () => void;
    vi.mocked(bridge.updaterRestart).mockImplementationOnce(() => new Promise<void>((done) => { finish = done; }));
    const again = state().restart();
    expect(state().restartError).toBeNull();
    finish();
    await again;
    expect(state().restartError).toBeNull();
    stop();
  });

  it("says the install failed when the error has no message of its own", async () => {
    installBridge({
      updaterRestart: vi.fn(async () => { throw new Error("tauri-ipc-unavailable"); }),
    });
    useUpdateStore.setState({ status: READY });
    await state().restart();
    expect(state().restartError).toBe("Couldn't install the update.");
  });

  it("a new check clears the error of an install that failed", async () => {
    const { emit } = installBridge({
      updaterRestart: vi.fn(async () => { throw "Couldn't install the update."; }),
    });
    const stop = state().init();
    emit(READY);
    await state().restart();
    expect(state().restartError).toBe("Couldn't install the update.");

    emit({ state: "checking" });
    expect(state().restartError).toBeNull();
    stop();
  });

  it("asks the shell once while an install is running", async () => {
    let finish!: () => void;
    const { bridge } = installBridge({
      updaterRestart: vi.fn(() => new Promise<void>((done) => { finish = done; })),
    });
    useUpdateStore.setState({ status: READY });
    const first = state().restart();
    const second = state().restart();
    expect(bridge.updaterRestart).toHaveBeenCalledTimes(1);
    finish();
    await Promise.all([first, second]);

    // Once it has settled, the next Restart asks again.
    vi.mocked(bridge.updaterRestart).mockResolvedValueOnce(undefined);
    await state().restart();
    expect(bridge.updaterRestart).toHaveBeenCalledTimes(2);
  });
});

describe("useUpdateStore.dismiss", () => {
  it("puts off the version that is ready", () => {
    useUpdateStore.setState({ status: READY });
    state().dismiss();
    expect(state().dismissedVersion).toBe("0.2.1");
  });

  it("does nothing while no update is ready", () => {
    useUpdateStore.setState({ status: downloading(5) });
    state().dismiss();
    expect(state().dismissedVersion).toBeNull();
  });
});
