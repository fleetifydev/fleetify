import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { PrSwitcherChip, prIconColor } from "@/components/git/pr-switcher-chip";
import type { PRStatus } from "@/lib/git-api";
import type { RepoPr } from "@/stores/pr-store";

const status = (over: Partial<PRStatus> = {}): PRStatus => ({
  number: 7,
  url: "https://github.com/o/r/pull/7",
  state: "OPEN",
  mergeable: "MERGEABLE",
  isDraft: false,
  baseRefName: "main",
  headRefName: "fleet/topic-abc12345",
  checks: { passing: 1, failing: 0, pending: 0, total: 1 },
  commentsCount: 0,
  ...over,
});

const repoPr = (over: Partial<RepoPr> = {}): RepoPr => ({
  number: 7,
  state: "OPEN",
  headRefName: "fleet/topic-abc12345",
  isDraft: false,
  ...over,
});

describe("prIconColor draft handling", () => {
  it("active open PR with passing checks → green", () => {
    expect(prIconColor(status())).toBe("rgb(64,180,120)");
  });

  it("draft open PR → neutral gray, even with green-state checks", () => {
    expect(prIconColor(status({ isDraft: true }))).toBe("var(--c-dim)");
  });

  it("draft gray loses to terminal states (MERGED stays purple)", () => {
    expect(prIconColor(status({ state: "MERGED", isDraft: true }))).toBe("#a78bfa");
  });
});

describe("PrSwitcherChip state label", () => {
  const stateOf = (container: HTMLElement) => {
    // The state word ("Open", "Draft", …) is the chip button's last span,
    // coloured by state.
    const spans = container.querySelectorAll<HTMLElement>("button span");
    const label = spans[spans.length - 1] as HTMLElement;
    return { word: label.textContent, color: label.style.color };
  };

  it("labels a selected draft PR 'Draft' in gray", () => {
    const { container } = render(
      <PrSwitcherChip
        openPrs={[repoPr({ isDraft: true })]}
        selectedNumber={7}
        selectedStatus={status({ isDraft: true })}
        onSelect={vi.fn()}
        onOpenUrl={vi.fn()}
      />,
    );
    expect(stateOf(container)).toEqual({ word: "Draft", color: "var(--c-dim)" });
  });

  it("labels an active (non-draft) PR 'Open' in green", () => {
    const { container } = render(
      <PrSwitcherChip
        openPrs={[repoPr()]}
        selectedNumber={7}
        selectedStatus={status()}
        onSelect={vi.fn()}
        onOpenUrl={vi.fn()}
      />,
    );
    // The DOM style engine normalizes rgb() with spaces after commas.
    expect(stateOf(container)).toEqual({ word: "Open", color: "rgb(64, 180, 120)" });
  });

  it("falls back to the prList entry's draft flag before the detail poll lands", () => {
    const { container } = render(
      <PrSwitcherChip
        openPrs={[repoPr({ isDraft: true })]}
        selectedNumber={7}
        selectedStatus={null}
        onSelect={vi.fn()}
        onOpenUrl={vi.fn()}
      />,
    );
    expect(stateOf(container)).toEqual({ word: "Draft", color: "var(--c-dim)" });
  });
});
