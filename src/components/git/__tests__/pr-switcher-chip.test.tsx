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

describe("PrSwitcherChip dot", () => {
  const dotOf = (container: HTMLElement) => {
    // The status dot is the chip button's first span (6×6 rounded).
    const dot = container.querySelector("button span") as HTMLElement;
    return dot.style.background;
  };

  it("renders a gray dot for a selected draft PR", () => {
    const { container } = render(
      <PrSwitcherChip
        openPrs={[repoPr({ isDraft: true })]}
        selectedNumber={7}
        selectedStatus={status({ isDraft: true })}
        onSelect={vi.fn()}
        onOpenUrl={vi.fn()}
      />,
    );
    expect(dotOf(container)).toBe("var(--c-dim)");
  });

  it("renders a green dot for an active (non-draft) PR", () => {
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
    expect(dotOf(container)).toBe("rgb(64, 180, 120)");
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
    expect(dotOf(container)).toBe("var(--c-dim)");
  });
});
