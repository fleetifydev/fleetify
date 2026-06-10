import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { RouterCard } from "../router-card";
import type { RouterTile } from "@/lib/routers-api";

vi.mock("@/lib/routers-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/routers-api")>("@/lib/routers-api");
  return {
    ...actual,
    routers: {
      ...actual.routers,
      getKeyPreview: vi.fn(async () => ({ ok: false as const, code: "NO_USER" as const })),
      connect: vi.fn(),
      disconnect: vi.fn(),
      setActive: vi.fn(async () => ({ ok: true })),
    },
  };
});

function tile(overrides: Partial<RouterTile>): RouterTile {
  return {
    id: "weave",
    display_name: "Weave",
    capabilities: ["decision", "proxy"],
    modes: ["managed", "self_hosted"],
    connected: false,
    active_for_decision: false,
    active_for_proxy: false,
    metadata: null,
    ...overrides,
  } as RouterTile;
}

describe("RouterCard", () => {
  const noop = async () => {};
  const meta = { description: "Test router." };

  it("renders the Voice-style selection tick (not a green 'Activated' pill) when active", () => {
    render(
      <RouterCard
        tile={tile({ connected: true, active_for_decision: true })}
        category="decision"
        meta={meta}
        onChanged={noop}
      />,
    );
    expect(
      screen.getByTestId("router-active-check-decision-weave"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Activated")).not.toBeInTheDocument();
  });

  it("renders 'Connected' pill when connected but inactive", () => {
    render(
      <RouterCard
        tile={tile({ connected: true })}
        category="decision"
        meta={meta}
        onChanged={noop}
      />,
    );
    expect(screen.getByText("Connected")).toBeInTheDocument();
  });

  it("renders 'Needs setup' pill when modes exist but not connected", () => {
    render(
      <RouterCard
        tile={tile({ connected: false })}
        category="decision"
        meta={meta}
        onChanged={noop}
      />,
    );
    expect(screen.getByText("Needs setup")).toBeInTheDocument();
  });
});
