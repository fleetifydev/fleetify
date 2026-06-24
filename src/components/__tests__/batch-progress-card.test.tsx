import { it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

const getFleetBatch = vi.fn();
vi.mock("@/lib/api", () => ({
  getFleetBatch: (...args: unknown[]) => getFleetBatch(...args),
}));

import { BatchProgressCard } from "@/components/dashboard/fleet-panel/batch-progress-card";

beforeEach(() => {
  getFleetBatch.mockReset();
});

it("renders each dispatch status and stops polling once done", async () => {
  getFleetBatch.mockResolvedValue({
    batch_id: "b1",
    done: true,
    dispatches: [
      { target_id: "a", target_title: "Alpha", status: "done", summary: "ok", error: "" },
      { target_id: "b", target_title: "Beta", status: "failed", summary: "", error: "budget" },
    ],
  });

  render(<BatchProgressCard batchId="b1" pollMs={20} />);

  await waitFor(() => expect(screen.getByText("Alpha")).toBeInTheDocument());
  expect(screen.getByText("Beta")).toBeInTheDocument();
  expect(screen.getByText("budget")).toBeInTheDocument();

  // Once the batch reports done, polling halts — the call count freezes.
  const callsAfterDone = getFleetBatch.mock.calls.length;
  await new Promise((r) => setTimeout(r, 80));
  expect(getFleetBatch.mock.calls.length).toBe(callsAfterDone);
});
