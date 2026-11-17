import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { CommandPalette } from "../command-palette";
import { FeedbackModal } from "../feedback-modal";
import { escapeOwnedElsewhere, escapeWasClaimed } from "@/hooks/use-escape-to-stop";

const modalSurfaces = () => document.querySelectorAll("[aria-modal='true']");

/** The one aria-modal element on the page. */
function modalSurface(): Element {
  expect(modalSurfaces()).toHaveLength(1);
  return modalSurfaces()[0]!;
}

/** Escape-to-stop and the permission cards leave alone an Escape that an
 *  overlay owns. That holds whichever window listener runs first:
 *  - before the overlay's handler runs, the open overlay is an aria-modal surface;
 *  - after it runs, the handler has claimed the key (claimEscape), which marks
 *    it handled for the stop and tells the cards it was used. */
function expectOwnsEscape(close: () => void) {
  expect(escapeOwnedElsewhere(new KeyboardEvent("keydown", { key: "Escape" }))).toBe(true);
  const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  fireEvent(document.body, escape);
  expect(escape.defaultPrevented).toBe(true);
  expect(escapeWasClaimed(escape)).toBe(true);
  expect(close).toHaveBeenCalledTimes(1);
}

describe("CommandPalette owns Escape", () => {
  it("is a modal surface while open and marks Escape handled when it closes", () => {
    const onClose = vi.fn();
    render(<CommandPalette open onClose={onClose} onAction={vi.fn()} />);
    expect(modalSurface()).toHaveAccessibleName("Command palette");
    expectOwnsEscape(onClose);
  });

  it("leaves no modal surface behind while closed", () => {
    // App.tsx keeps the palette mounted after its first open.
    render(<CommandPalette open={false} onClose={vi.fn()} onAction={vi.fn()} />);
    expect(modalSurfaces()).toHaveLength(0);
  });
});

describe("FeedbackModal owns Escape", () => {
  it("is a modal surface while open and marks Escape handled when it closes", () => {
    const onClose = vi.fn();
    render(<FeedbackModal open onClose={onClose} />);
    expect(modalSurface()).toHaveTextContent("Send Feedback");
    expectOwnsEscape(onClose);
  });

  it("leaves no modal surface behind while closed", () => {
    render(<FeedbackModal open={false} onClose={vi.fn()} />);
    expect(modalSurfaces()).toHaveLength(0);
  });
});
