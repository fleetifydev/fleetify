import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { PrChecksIndicator } from "../pr-checks-indicator";
import { PrChecksPopover } from "../pr-checks-popover";
import type { CheckRun } from "@/lib/git-api";

describe("PrChecksIndicator", () => {
  it("renders nothing when the PR has no checks", () => {
    const { container } = render(
      <PrChecksIndicator checks={{ passing: 0, failing: 0, pending: 0, total: 0 }} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders the ring with a counts aria-label and fires onClick", () => {
    const onClick = vi.fn();
    render(
      <PrChecksIndicator
        checks={{ passing: 2, failing: 1, pending: 1, total: 4 }}
        onClick={onClick}
      />,
    );
    const ring = screen.getByTestId("pr-checks-ring");
    expect(ring.getAttribute("aria-label")).toMatch(/2 passed/);
    expect(ring.getAttribute("aria-label")).toMatch(/1 failing/);
    expect(ring.getAttribute("aria-label")).toMatch(/1 running/);
    fireEvent.click(ring);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

const runs: CheckRun[] = [
  { name: "build", status: "COMPLETED", conclusion: "SUCCESS", bucket: "passing", url: "https://gh/build" },
  { name: "lint", status: "COMPLETED", conclusion: "FAILURE", bucket: "failing", url: "https://gh/lint" },
  { name: "test", status: "IN_PROGRESS", conclusion: null, bucket: "pending", url: null },
];

describe("PrChecksPopover", () => {
  it("renders the summary line and one row per check", () => {
    render(
      <PrChecksPopover
        runs={runs}
        summary={{ passing: 1, failing: 1, pending: 1, total: 3 }}
        onOpenCheck={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByText("1 passed")).toBeTruthy();
    expect(screen.getByText("1 failing")).toBeTruthy();
    expect(screen.getByText("1 running")).toBeTruthy();
    expect(screen.getByText("build")).toBeTruthy();
    expect(screen.getByText("lint")).toBeTruthy();
    expect(screen.getByText("test")).toBeTruthy();
  });

  it("uses a green check for passing rows and an X for failing rows", () => {
    const { container } = render(
      <PrChecksPopover
        runs={runs}
        summary={{ passing: 1, failing: 1, pending: 1, total: 3 }}
        onOpenCheck={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    const check = container.querySelector(".lucide-check") as SVGElement | null;
    expect(check?.style.color).toContain("64, 180, 120"); // the app's green
    expect(container.querySelector(".lucide-x")).toBeTruthy(); // failing → X icon
  });

  it("opens a check on GitHub when its row is clicked (and not for url-less rows)", () => {
    const onOpenCheck = vi.fn();
    render(
      <PrChecksPopover
        runs={runs}
        summary={{ passing: 1, failing: 1, pending: 1, total: 3 }}
        onOpenCheck={onOpenCheck}
        onDismiss={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText("build"));
    expect(onOpenCheck).toHaveBeenCalledWith("https://gh/build");
    // the "test" row has no url → disabled, no callback
    fireEvent.click(screen.getByText("test"));
    expect(onOpenCheck).toHaveBeenCalledTimes(1);
  });

  it("dismisses on Escape and on outside click", () => {
    const onDismiss = vi.fn();
    render(
      <PrChecksPopover
        runs={runs}
        summary={{ passing: 1, failing: 1, pending: 1, total: 3 }}
        onOpenCheck={vi.fn()}
        onDismiss={onDismiss}
      />,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onDismiss).toHaveBeenCalledTimes(1);
    fireEvent.mouseDown(document.body);
    expect(onDismiss).toHaveBeenCalledTimes(2);
  });

  it("handles an empty checks list gracefully", () => {
    render(
      <PrChecksPopover
        runs={[]}
        summary={{ passing: 0, failing: 0, pending: 0, total: 0 }}
        onOpenCheck={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByText(/No individual checks reported/)).toBeTruthy();
  });
});
