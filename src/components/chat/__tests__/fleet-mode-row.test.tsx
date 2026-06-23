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
import { FleetModeRow } from "../fleet-mode-row";

beforeEach(() => {
  setGlobalMode.mockReset();
  setMode.mockReset();
});

it("renders the four modes and sets global mode on the hub", () => {
  render(<FleetModeRow sessionId={null} controlCenter />);
  expect(screen.getByText(/manual/i)).toBeTruthy();
  expect(screen.getByText(/refine/i)).toBeTruthy();
  expect(screen.getByText(/co-?pilot/i)).toBeTruthy();
  expect(screen.getByText(/auto/i)).toBeTruthy();
  fireEvent.click(screen.getByText(/auto/i));
  expect(setGlobalMode).toHaveBeenCalledWith("auto");
});

// session path: controlCenter=false + a sessionId → uses setMode(id, mode)
it("sets per-session mode on an agent session", () => {
  render(<FleetModeRow sessionId="s1" controlCenter={false} />);
  fireEvent.click(screen.getByText(/co-?pilot/i));
  expect(setMode).toHaveBeenCalledWith("s1", "copilot");
});
