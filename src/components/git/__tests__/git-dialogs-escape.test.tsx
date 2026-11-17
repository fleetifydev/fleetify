import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";

const { gitMock } = vi.hoisted(() => ({
  gitMock: {
    // Never settle, so each dialog stays in its loading state for the test.
    reviewDiff: vi.fn(() => new Promise<never>(() => {})),
    diagnoseFailure: vi.fn(() => new Promise<never>(() => {})),
  },
}));
vi.mock("@/lib/git-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/git-api")>("@/lib/git-api");
  return { ...actual, git: gitMock };
});
vi.mock("@/lib/git-log", () => ({ glog: () => {} }));

import { ReviewDialog } from "../review-dialog";
import { RecoveryDialog } from "../recovery-dialog";
import { PreflightDialog } from "../preflight-dialog";
import { escapeOwnedElsewhere } from "@/hooks/use-escape-to-stop";

/** The one aria-modal element on the page. */
function modalSurface(): Element {
  const all = document.querySelectorAll("[aria-modal='true']");
  expect(all).toHaveLength(1);
  return all[0]!;
}

/** Escape-to-stop leaves alone an Escape that an overlay owns. That holds
 *  whichever window listener runs first:
 *  - before the overlay's handler runs, the open overlay is an aria-modal surface;
 *  - after it runs, the handler has marked the key handled. */
function expectOwnsEscape(close: () => void) {
  expect(escapeOwnedElsewhere(new KeyboardEvent("keydown", { key: "Escape" }))).toBe(true);
  expect(fireEvent.keyDown(document.body, { key: "Escape" })).toBe(false); // preventDefault was called
  expect(close).toHaveBeenCalledTimes(1);
}

describe("BranchStrip dialogs own Escape", () => {
  it("ReviewDialog is a modal surface and marks Escape handled when it closes", () => {
    const onClose = vi.fn();
    render(<ReviewDialog folder="/repo" baseBranch="main" onClose={onClose} />);
    expect(modalSurface()).toHaveAccessibleName("Code review");
    expectOwnsEscape(onClose);
  });

  it("RecoveryDialog is a modal surface and marks Escape handled when it closes", () => {
    const onClose = vi.fn();
    render(
      <RecoveryDialog
        folder="/repo"
        baseBranch="main"
        errorMessage="push rejected"
        context="Create PR"
        onClose={onClose}
        onRetry={vi.fn()}
      />,
    );
    expect(modalSurface()).toHaveAccessibleName("Recovery");
    expectOwnsEscape(onClose);
  });

  it("PreflightDialog is a modal surface and marks Escape handled when it cancels", () => {
    const onCancel = vi.fn();
    render(<PreflightDialog folder="/repo" issues={[]} onContinue={vi.fn()} onCancel={onCancel} />);
    expect(modalSurface()).toHaveAccessibleName("Pre-flight checks");
    expectOwnsEscape(onCancel);
  });
});
