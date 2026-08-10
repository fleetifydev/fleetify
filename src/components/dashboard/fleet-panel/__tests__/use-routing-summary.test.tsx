import { it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

const fetchRoutingSummary = vi.fn();
vi.mock("@/lib/api", () => ({
  fetchRoutingSummary: (...args: unknown[]) => fetchRoutingSummary(...args),
}));

import { useRoutingSummary } from "@/components/dashboard/fleet-panel/hooks/use-routing-summary";

function Probe() {
  const s = useRoutingSummary(20);
  if (s === undefined) return <div>loading</div>;
  if (s === null) return <div>failed</div>;
  return <div>{s.active_decision_router.id}</div>;
}

beforeEach(() => fetchRoutingSummary.mockReset());

it("exposes the fetched summary and keeps polling", async () => {
  fetchRoutingSummary.mockResolvedValue({
    enabled: true,
    active_decision_router: { id: "notdiamond", display_name: "Not Diamond" },
    active_proxy_gateway: { id: "none-proxy", display_name: "None / Direct" },
    totals_24h: { decisions: 1, fallbacks: 0, avg_latency_ms: 300, last_decision_ts: 1 },
    last_decision: null,
    recent: [],
    routed_session_ids: [],
  });
  render(<Probe />);
  await waitFor(() => expect(screen.getByText("notdiamond")).toBeInTheDocument());
  const calls = fetchRoutingSummary.mock.calls.length;
  await new Promise(r => setTimeout(r, 70));
  expect(fetchRoutingSummary.mock.calls.length).toBeGreaterThan(calls);
});

it("surfaces fetch failure as null", async () => {
  fetchRoutingSummary.mockResolvedValue(null);
  render(<Probe />);
  await waitFor(() => expect(screen.getByText("failed")).toBeInTheDocument());
});
