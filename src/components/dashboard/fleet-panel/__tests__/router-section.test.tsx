import { it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

import { RouterSection } from "@/components/dashboard/fleet-panel/router-section";
import type { RoutingSummary, SessionDetail } from "@/lib/api";
import type { Session } from "@/types/session";

const baseSummary: RoutingSummary = {
  enabled: true,
  active_decision_router: { id: "notdiamond", display_name: "Not Diamond" },
  active_proxy_gateway: { id: "none-proxy", display_name: "None / Direct" },
  totals_24h: { decisions: 14, fallbacks: 2, avg_latency_ms: 380, last_decision_ts: null },
  last_decision: {
    ts: Math.floor(Date.now() / 1000) - 240,
    agent: "claude-code", model: "claude-sonnet-4-6",
    source: "notdiamond", fallback_used: false, task_flow: "chat",
  },
  recent: [],
  routed_session_ids: ["sa"],
};

function makeSession(): Session {
  return {
    id: "sa", title: "T", project_path: "", group_path: "", tool: "claude-code",
    command: "", status: "stopped", created_at: new Date().toISOString(),
    model_name: null, budget_used: 0,
  } as unknown as Session;
}

it("hides entirely when there is nothing to show", () => {
  const { container } = render(
    <RouterSection summary={null} sessions={[]} details={{}} activityBySession={new Map()} />,
  );
  expect(container.firstChild).toBeNull();
});

it("hides when routing is off and no decisions and no auto sessions", () => {
  const s: RoutingSummary = {
    ...baseSummary, enabled: false, last_decision: null,
    totals_24h: { ...baseSummary.totals_24h, decisions: 0 },
  };
  const { container } = render(
    <RouterSection summary={s} sessions={[makeSession()]} details={{}} activityBySession={new Map()} />,
  );
  expect(container.firstChild).toBeNull();
});

it("renders router identity, last decision and metrics when enabled", () => {
  render(
    <RouterSection
      summary={baseSummary}
      sessions={[makeSession()]}
      details={{ sa: { total_cost_usd: 1.24 } as unknown as SessionDetail }}
      activityBySession={new Map()}
    />,
  );
  expect(screen.getByText(/Not Diamond/)).toBeInTheDocument();
  expect(screen.getByText(/claude-sonnet-4-6/)).toBeInTheDocument();
  expect(screen.getByText(/14 decisions/)).toBeInTheDocument();
  expect(screen.getByText(/2 fallbacks/)).toBeInTheDocument();
  expect(screen.getByText(/\$1\.24/)).toBeInTheDocument();
  // active_proxy_gateway.id is "none-proxy" (the real Direct id) — the
  // "via <gateway>" suffix must NOT appear for Direct.
  expect(screen.getByText(/Not Diamond · active/)).toBeInTheDocument();
  expect(screen.queryByText(/via/)).toBeNull();
});

it("shows the via-proxy suffix when a non-direct gateway is active", () => {
  const s: RoutingSummary = {
    ...baseSummary,
    active_proxy_gateway: { id: "litellm", display_name: "LiteLLM" },
  };
  render(
    <RouterSection summary={s} sessions={[]} details={{}} activityBySession={new Map()} />,
  );
  expect(screen.getByText(/via LiteLLM/)).toBeInTheDocument();
});

it("shows the fallback badge on a fallback decision", () => {
  const s: RoutingSummary = {
    ...baseSummary,
    last_decision: { ...baseSummary.last_decision!, fallback_used: true },
  };
  render(
    <RouterSection summary={s} sessions={[]} details={{}} activityBySession={new Map()} />,
  );
  expect(screen.getByText("fallback")).toBeInTheDocument();
});

it("shows empty state when enabled but no decisions yet", () => {
  const s: RoutingSummary = {
    ...baseSummary, last_decision: null,
    totals_24h: { decisions: 0, fallbacks: 0, avg_latency_ms: 0, last_decision_ts: null },
    routed_session_ids: [],
  };
  render(
    <RouterSection summary={s} sessions={[]} details={{}} activityBySession={new Map()} />,
  );
  expect(screen.getByText("no routing yet")).toBeInTheDocument();
});

it("renders the Auto row from local sessions even when the endpoint failed", () => {
  const auto = makeSession();
  (auto as { tool: string }).tool = "auto";
  render(
    <RouterSection summary={null} sessions={[auto]} details={{}} activityBySession={new Map()} />,
  );
  expect(screen.getByText(/1 session/)).toBeInTheDocument();
});
