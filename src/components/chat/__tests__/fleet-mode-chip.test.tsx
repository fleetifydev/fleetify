import { it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

const setGlobalMode = vi.fn();
const setMode = vi.fn();
vi.mock("@/stores/fleet-store", () => ({
  useFleetStore: (sel: (s: unknown) => unknown) => sel({
    globalMode: "manual", setGlobalMode,
    getSession: () => ({ mode: "manual", status: "idle" }),
    setMode,
  }),
}));
import { FleetModeChip } from "../fleet-mode-chip";

beforeEach(() => {
  setGlobalMode.mockReset();
  setMode.mockReset();
});

it("is collapsed until opened, then reveals the four modes", () => {
  render(<FleetModeChip sessionId={null} controlCenter />);
  // Collapsed: options are not in the DOM yet.
  expect(screen.queryByTestId("fleet-mode-opt-auto")).toBeNull();
  fireEvent.click(screen.getByTestId("fleet-mode-trigger"));
  expect(screen.getByTestId("fleet-mode-opt-manual")).toBeTruthy();
  expect(screen.getByTestId("fleet-mode-opt-refine-only")).toBeTruthy();
  expect(screen.getByTestId("fleet-mode-opt-copilot")).toBeTruthy();
  expect(screen.getByTestId("fleet-mode-opt-auto")).toBeTruthy();
});

it("sets the global mode on the hub and closes", () => {
  render(<FleetModeChip sessionId={null} controlCenter />);
  fireEvent.click(screen.getByTestId("fleet-mode-trigger"));
  fireEvent.click(screen.getByTestId("fleet-mode-opt-auto"));
  expect(setGlobalMode).toHaveBeenCalledWith("auto");
  // Picking closes the dropdown.
  expect(screen.queryByTestId("fleet-mode-opt-auto")).toBeNull();
});

it("sets the per-session mode when bound to a session", () => {
  render(<FleetModeChip sessionId="s1" controlCenter={false} />);
  fireEvent.click(screen.getByTestId("fleet-mode-trigger"));
  fireEvent.click(screen.getByTestId("fleet-mode-opt-copilot"));
  expect(setMode).toHaveBeenCalledWith("s1", "copilot");
});
