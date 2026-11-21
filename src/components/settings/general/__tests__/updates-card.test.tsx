/**
 * Settings → General → Updates: the Automatic updates switch (`updatesAuto`),
 * the shell's updater status, Check now, and Restart to update once an
 * update has downloaded. One stable channel, so no channel picker.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import type { UpdateStatus } from "@/lib/api";
import { useUpdateStore } from "@/stores/update-store";
import { UpdatesCard } from "../updates-card";

type Bridge = NonNullable<Window["fleetify"]>;
type Mock = ReturnType<typeof vi.fn>;

const AUTOMATIC_UPDATES_DESC =
  "Check for updates when Fleetify starts and every six hours, and download them in the background.";
const READY: UpdateStatus = { state: "ready", version: "0.2.1" };

function installApi(saved: Record<string, unknown> = {}): { getConfig: Mock; setConfig: Mock } {
  const api = {
    getConfig: vi.fn(async () => ({ onboardingComplete: true, ...saved })),
    setConfig: vi.fn(async () => ({ ok: true })),
  };
  (window as unknown as { electronAPI: unknown }).electronAPI = api;
  return api;
}

function installBridge(over: Partial<Bridge> = {}) {
  const bridge = {
    updaterStatus: vi.fn(async (): Promise<UpdateStatus> => ({ state: "idle" })),
    updaterCheck: vi.fn(async (): Promise<UpdateStatus> => ({ state: "upToDate" })),
    updaterRestart: vi.fn(async (): Promise<void> => {}),
    onUpdaterStatus: vi.fn(() => () => {}),
    ...over,
  };
  (window as { fleetify?: Partial<Bridge> }).fleetify = bridge;
  return bridge;
}

/** Renders the card and waits for it to read the config. */
async function renderCard() {
  const view = render(<UpdatesCard />);
  await screen.findByRole("switch", { name: "Automatic updates" });
  return view;
}

const checkNow = () => screen.getByRole("button", { name: "Check now" });
const initial = useUpdateStore.getState();

beforeEach(() => {
  useUpdateStore.setState(initial, true);
  delete (window as { fleetify?: unknown }).fleetify;
  // Vite defines __APP_VERSION__ at build time; the test run has no define.
  vi.stubGlobal("__APP_VERSION__", "0.1.0");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("UpdatesCard — Automatic updates", () => {
  it("describes the switch exactly", async () => {
    installApi();
    await renderCard();
    expect(screen.getByText("Automatic updates")).toBeInTheDocument();
    expect(screen.getByText(AUTOMATIC_UPDATES_DESC)).toBeInTheDocument();
  });

  it("has no Coming soon text and no Update channel row", async () => {
    installApi({ updatesChannel: "beta" });
    const { container } = await renderCard();
    expect(container.textContent).not.toMatch(/coming soon/i);
    expect(container.textContent).not.toMatch(/update channel/i);
    expect(container.textContent).not.toMatch(/beta/i);
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it.each([true, false])("shows the saved choice (updatesAuto: %s)", async (on) => {
    installApi({ updatesAuto: on });
    await renderCard();
    expect(screen.getByRole("switch", { name: "Automatic updates" }))
      .toHaveAttribute("aria-checked", String(on));
  });

  it("is on when nothing is saved, as the shell reads it", async () => {
    installApi();
    await renderCard();
    expect(screen.getByRole("switch", { name: "Automatic updates" }))
      .toHaveAttribute("aria-checked", "true");
  });

  it("saves updatesAuto when switched", async () => {
    const api = installApi({ updatesAuto: true });
    await renderCard();
    const sw = screen.getByRole("switch", { name: "Automatic updates" });

    fireEvent.click(sw);
    await waitFor(() =>
      expect(api.setConfig).toHaveBeenLastCalledWith({ onboardingComplete: true, updatesAuto: false }));
    expect(sw).toHaveAttribute("aria-checked", "false");

    fireEvent.click(sw);
    await waitFor(() => expect(api.setConfig).toHaveBeenCalledTimes(2));
    expect(api.setConfig).toHaveBeenLastCalledWith(expect.objectContaining({ updatesAuto: true }));
    expect(sw).toHaveAttribute("aria-checked", "true");
  });
});

describe("UpdatesCard — Check for updates", () => {
  it.each<[string, UpdateStatus | null, string]>([
    ["no status yet", null, "Current: v0.1.0"],
    ["idle", { state: "idle" }, "Current: v0.1.0"],
    ["checking", { state: "checking" }, "Checking…"],
    ["upToDate", { state: "upToDate" }, "v0.1.0 is the latest version."],
    ["downloading", { state: "downloading", version: "0.2.1", downloaded: 5, total: 10 }, "Downloading v0.2.1… 50%"],
    ["downloading, size unknown", { state: "downloading", version: "0.2.1", downloaded: 5, total: null }, "Downloading v0.2.1…"],
    ["ready", READY, "v0.2.1 is ready."],
    ["installing", { state: "installing", version: "0.2.1" }, "Installing v0.2.1…"],
    ["failed", { state: "failed", message: "Couldn't check for updates." }, "Couldn't check for updates."],
    ["disabled", { state: "disabled" }, "Updates are off in development builds."],
  ])("%s: says %j", async (_name, status, line) => {
    installApi();
    useUpdateStore.setState({ status });
    await renderCard();
    expect(screen.getByText(line)).toBeInTheDocument();
  });

  it("rounds the download down to a whole percent", async () => {
    installApi();
    useUpdateStore.setState({
      status: { state: "downloading", version: "0.2.1", downloaded: 2, total: 3 },
    });
    await renderCard();
    expect(screen.getByText("Downloading v0.2.1… 66%")).toBeInTheDocument();
  });

  it.each<UpdateStatus>([
    { state: "checking" },
    { state: "downloading", version: "0.2.1", downloaded: 5, total: 10 },
    // The shell starts no check while an update is ready (after a failed
    // install too), so Check now would do nothing there.
    READY,
    { state: "installing", version: "0.2.1" },
    { state: "disabled" },
  ])("Check now is shown but disabled while the status is %j", async (status) => {
    installApi();
    useUpdateStore.setState({ status });
    await renderCard();
    expect(checkNow()).toBeDisabled();
  });

  it.each<UpdateStatus | null>([
    null,
    { state: "idle" },
    { state: "upToDate" },
    { state: "failed", message: "Couldn't check for updates." },
  ])("Check now can be clicked while the status is %j", async (status) => {
    installApi();
    useUpdateStore.setState({ status });
    await renderCard();
    expect(checkNow()).toBeEnabled();
  });

  it("Check now asks the shell to check and shows the answer", async () => {
    installApi();
    const bridge = installBridge();
    useUpdateStore.setState({ status: { state: "idle" } });
    await renderCard();

    fireEvent.click(checkNow());
    expect(bridge.updaterCheck).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("v0.1.0 is the latest version.")).toBeInTheDocument();
  });

  it("follows the status as it changes", async () => {
    installApi();
    useUpdateStore.setState({ status: { state: "checking" } });
    await renderCard();
    act(() => useUpdateStore.setState({
      status: { state: "downloading", version: "0.2.1", downloaded: 0, total: 10 },
    }));
    expect(screen.getByText("Downloading v0.2.1… 0%")).toBeInTheDocument();
    act(() => useUpdateStore.setState({ status: READY }));
    expect(screen.getByText("v0.2.1 is ready.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Restart to update" })).toBeInTheDocument();
  });
});

describe("UpdatesCard — Restart to update", () => {
  it.each<UpdateStatus | null>([
    null,
    { state: "idle" },
    { state: "upToDate" },
    { state: "downloading", version: "0.2.1", downloaded: 5, total: 10 },
    { state: "installing", version: "0.2.1" },
    { state: "failed", message: "Couldn't download the update." },
  ])("is not offered while the status is %j", async (status) => {
    installApi();
    useUpdateStore.setState({ status });
    await renderCard();
    expect(screen.queryByRole("button", { name: "Restart to update" })).toBeNull();
  });

  it("is offered once an update is ready, and installs it", async () => {
    installApi();
    const bridge = installBridge();
    useUpdateStore.setState({ status: READY });
    await renderCard();

    fireEvent.click(screen.getByRole("button", { name: "Restart to update" }));
    expect(bridge.updaterRestart).toHaveBeenCalledTimes(1);
  });

  it("says why under the row when the install fails, and stays offered", async () => {
    // An install that fails while the shell keeps the update: it answers
    // with an error and puts the status back to ready (R-P3-9).
    installApi();
    const bridge = installBridge({
      updaterRestart: vi.fn(async () => { throw "Couldn't install the update."; }),
    });
    useUpdateStore.setState({ status: READY });
    await renderCard();

    fireEvent.click(screen.getByRole("button", { name: "Restart to update" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't install the update.");
    expect(alert.parentElement).toHaveTextContent("Check for updates");
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    // Restart to update is the way on; the shell starts no check meanwhile.
    expect(checkNow()).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Restart to update" }));
    expect(bridge.updaterRestart).toHaveBeenCalledTimes(2);
  });
});
