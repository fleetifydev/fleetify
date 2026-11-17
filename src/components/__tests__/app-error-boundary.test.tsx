import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// A render error anywhere in the app used to unmount the whole tree and
// leave a blank window. The root boundary shows a recovery screen instead
// and hands the error to the logger, which keeps the details local.

const logger = vi.hoisted(() => ({ logRenderError: vi.fn() }));
vi.mock("@/lib/log", () => logger);

import { AppErrorBoundary } from "../app-error-boundary";

const failure = new TypeError("render failed");

function Broken(): never {
  throw failure;
}

beforeEach(() => {
  logger.logRenderError.mockClear();
  // React reports every error a boundary catches on the console.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AppErrorBoundary", () => {
  it("renders the app while nothing throws", () => {
    render(<AppErrorBoundary><p>the app</p></AppErrorBoundary>);
    expect(screen.getByText("the app")).toBeInTheDocument();
    expect(screen.queryByText("Something went wrong")).toBeNull();
    expect(logger.logRenderError).not.toHaveBeenCalled();
  });

  it("shows the recovery screen when a child throws while rendering", () => {
    render(<AppErrorBoundary><Broken /></AppErrorBoundary>);
    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
    expect(
      screen.getByText("Fleetify hit an unexpected error. Reload to continue — your sessions are saved."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
  });

  it("reloads the window from the Reload button", () => {
    const reload = vi.fn();
    vi.spyOn(window, "location", "get").mockReturnValue({ ...window.location, reload } as Location);
    render(<AppErrorBoundary><Broken /></AppErrorBoundary>);
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("hands the error and where it happened to the logger", () => {
    render(<AppErrorBoundary><Broken /></AppErrorBoundary>);
    expect(logger.logRenderError).toHaveBeenCalledTimes(1);
    const [error, componentStack] = logger.logRenderError.mock.calls[0]!;
    expect(error).toBe(failure);
    expect(componentStack).toContain("Broken");
  });
});
