import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";

// The prompts picker loads the saved prompts when it opens.
vi.mock("@/lib/prompts-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/prompts-api")>()),
  listPrompts: vi.fn(async () => []),
}));

import { ConfirmDialog } from "../ui/confirm-dialog";
import { HelpDialog } from "../chat/help-dialog";
import { PromptsPicker } from "../chat/prompts-picker";
import { GithubAuthChoiceDialog } from "../git/github-auth-choice-dialog";
import { escapeOwnedElsewhere, escapeWasClaimed } from "@/hooks/use-escape-to-stop";

const modalSurfaces = () => document.querySelectorAll("[aria-modal='true']");

/** A modal drawn over the chat owns the Escape that closes it, whichever
 *  window listener runs first. Before its handler runs, the open modal is an
 *  aria-modal surface, which Escape-to-stop and the permission cards leave
 *  alone. After it runs, the handler has claimed the key (claimEscape): the
 *  stop sees it handled, and a pending card sees it used. In a real browser
 *  the modal may already be unmounted by then, so only the claim is left. */
function expectClaimsEscape(close: () => void) {
  expect(modalSurfaces()).toHaveLength(1);
  expect(escapeOwnedElsewhere(new KeyboardEvent("keydown", { key: "Escape" }))).toBe(true);
  const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  fireEvent(document.body, escape);
  expect(escape.defaultPrevented).toBe(true);
  expect(escapeWasClaimed(escape)).toBe(true);
  expect(close).toHaveBeenCalledTimes(1);
}

describe("Modals claim the Escape that closes them", () => {
  it("ConfirmDialog", () => {
    const onCancel = vi.fn();
    render(<ConfirmDialog title="Delete this session?" confirmLabel="Delete" onConfirm={vi.fn()} onCancel={onCancel} />);
    expectClaimsEscape(onCancel);
  });

  it("HelpDialog", () => {
    const onClose = vi.fn();
    render(<HelpDialog open onClose={onClose} />);
    expectClaimsEscape(onClose);
  });

  it("PromptsPicker, which is a modal surface while open and leaves none behind when closed", () => {
    // Like Help, it covers the window with a scrim. As a modal surface it also
    // keeps a pending permission card from taking ⌘↵ (its Enter picks a prompt).
    const onClose = vi.fn();
    const { rerender } = render(<PromptsPicker open onClose={onClose} onPick={vi.fn()} />);
    expect(modalSurfaces()[0]).toHaveAccessibleName("Prompts");
    expectClaimsEscape(onClose);
    rerender(<PromptsPicker open={false} onClose={onClose} onPick={vi.fn()} />);
    expect(modalSurfaces()).toHaveLength(0);
  });

  it("GithubAuthChoiceDialog, while no sign-in is in flight", () => {
    const onDismiss = vi.fn();
    render(<GithubAuthChoiceDialog onChoose={vi.fn()} onDismiss={onDismiss} />);
    expectClaimsEscape(onDismiss);
  });
});
