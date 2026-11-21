/**
 * The update banner: once the shell has downloaded and verified an update,
 * the top of the main window offers Restart to update, or Later.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import type { UpdateStatus } from "@/lib/api";
import { useUpdateStore } from "@/stores/update-store";
import { UpdateReadyBanner } from "../update-ready-banner";

type Bridge = NonNullable<Window["fleetify"]>;

const ready = (version: string): UpdateStatus => ({ state: "ready", version });
const initial = useUpdateStore.getState();
const setStatus = (status: UpdateStatus | null) => act(() => useUpdateStore.setState({ status }));

beforeEach(() => {
  useUpdateStore.setState(initial, true);
  delete (window as { fleetify?: unknown }).fleetify;
});

describe("UpdateReadyBanner", () => {
  it.each<UpdateStatus | null>([
    null,
    { state: "disabled" },
    { state: "idle" },
    { state: "checking" },
    { state: "upToDate" },
    { state: "downloading", version: "0.2.1", downloaded: 5, total: 10 },
    { state: "installing", version: "0.2.1" },
    { state: "failed", message: "Couldn't download the update." },
  ])("renders nothing while the status is %j", (status) => {
    useUpdateStore.setState({ status });
    const { container } = render(<UpdateReadyBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the version, Restart to update and Later once an update is ready", () => {
    useUpdateStore.setState({ status: ready("0.2.1") });
    render(<UpdateReadyBanner />);
    const banner = screen.getByRole("status");
    expect(banner).toContainElement(screen.getByText("Fleetify 0.2.1 is ready to install."));
    expect(banner).toContainElement(screen.getByRole("button", { name: "Restart to update" }));
    expect(banner).toContainElement(screen.getByRole("button", { name: "Later" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("appears when the status turns ready", () => {
    const { container } = render(<UpdateReadyBanner />);
    expect(container).toBeEmptyDOMElement();
    setStatus(ready("0.2.1"));
    expect(screen.getByText("Fleetify 0.2.1 is ready to install.")).toBeInTheDocument();
  });

  it("Restart to update calls restart", () => {
    const restart = vi.fn(async () => {});
    useUpdateStore.setState({ status: ready("0.2.1"), restart });
    render(<UpdateReadyBanner />);
    fireEvent.click(screen.getByRole("button", { name: "Restart to update" }));
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it("Restart to update asks the shell to install", () => {
    const updaterRestart = vi.fn(async () => {});
    (window as { fleetify?: Partial<Bridge> }).fleetify = { updaterRestart };
    useUpdateStore.setState({ status: ready("0.2.1") });
    render(<UpdateReadyBanner />);
    fireEvent.click(screen.getByRole("button", { name: "Restart to update" }));
    expect(updaterRestart).toHaveBeenCalledTimes(1);
  });

  it("Later hides it until another version is ready", () => {
    useUpdateStore.setState({ status: ready("0.2.1") });
    const { container } = render(<UpdateReadyBanner />);
    fireEvent.click(screen.getByRole("button", { name: "Later" }));
    expect(container).toBeEmptyDOMElement();

    // The same version again (after a failed install, say) stays put off.
    setStatus({ state: "installing", version: "0.2.1" });
    setStatus(ready("0.2.1"));
    expect(container).toBeEmptyDOMElement();

    setStatus(ready("0.2.2"));
    expect(screen.getByText("Fleetify 0.2.2 is ready to install.")).toBeInTheDocument();
  });

  it("says why when the install fails, and keeps Restart to update", async () => {
    // The shell answers a failed install with an error and puts the status
    // back to ready (R-P3-9).
    const updaterRestart = vi.fn(async () => { throw "Couldn't install the update."; });
    (window as { fleetify?: Partial<Bridge> }).fleetify = { updaterRestart };
    useUpdateStore.setState({ status: ready("0.2.1") });
    render(<UpdateReadyBanner />);
    fireEvent.click(screen.getByRole("button", { name: "Restart to update" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't install the update.");
    expect(screen.getByRole("status")).toContainElement(alert);
    expect(screen.getByText("Fleetify 0.2.1 is ready to install.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Restart to update" }));
    expect(updaterRestart).toHaveBeenCalledTimes(2);
  });
});
