import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { PrChecksPopover } from "../pr-checks-popover";
import type { CheckRun } from "@/lib/git-api";

const runs: CheckRun[] = [
  { name: "lint", status: "COMPLETED", conclusion: "FAILURE", bucket: "failing", url: "u1", runId: 10, jobId: 1, rerunnable: true },
  { name: "ext", status: "COMPLETED", conclusion: "FAILURE", bucket: "failing", url: "u2", rerunnable: false },
  { name: "ok", status: "COMPLETED", conclusion: "SUCCESS", bucket: "passing", url: "u3" },
];
const summary = { passing: 1, failing: 2, pending: 0, total: 3 };

describe("PrChecksPopover re-run", () => {
  it("shows the bulk button when a failing rerunnable run exists, and fires onRerunFailed", () => {
    const onRerunFailed = vi.fn();
    render(
      <PrChecksPopover
        runs={runs}
        summary={summary}
        onOpenCheck={() => {}}
        onDismiss={() => {}}
        onRerunFailed={onRerunFailed}
        onRerunCheck={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Re-run failed checks" }));
    expect(onRerunFailed).toHaveBeenCalledOnce();
  });

  it("renders a per-row re-run only for rerunnable failing rows, and fires onRerunCheck", () => {
    const onRerunCheck = vi.fn();
    render(
      <PrChecksPopover
        runs={runs}
        summary={summary}
        onOpenCheck={() => {}}
        onDismiss={() => {}}
        onRerunFailed={() => {}}
        onRerunCheck={onRerunCheck}
      />,
    );
    // lint is failing + rerunnable → has a control; ext is failing but not
    // rerunnable, ok is passing → neither does.
    expect(screen.queryByRole("button", { name: "Re-run ext" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Re-run lint" }));
    expect(onRerunCheck).toHaveBeenCalledWith(runs[0]);
  });

  it("hides the bulk button when no failing run is rerunnable", () => {
    const noActions: CheckRun[] = [
      { name: "ext", status: "C", conclusion: "FAILURE", bucket: "failing", url: "u", rerunnable: false },
    ];
    render(
      <PrChecksPopover
        runs={noActions}
        summary={{ passing: 0, failing: 1, pending: 0, total: 1 }}
        onOpenCheck={() => {}}
        onDismiss={() => {}}
        onRerunFailed={() => {}}
        onRerunCheck={() => {}}
      />,
    );
    expect(screen.queryByRole("button", { name: "Re-run failed checks" })).toBeNull();
  });
});
