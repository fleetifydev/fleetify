import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

const api = vi.hoisted(() => ({
  listAccounts: vi.fn(),
  createAccount: vi.fn(),
  openAccountLogin: vi.fn(),
  setDefaultAccount: vi.fn(),
}));
vi.mock("@/lib/providers-api", () => ({ providers: api }));
vi.mock("../login-terminal-modal", () => ({
  LoginTerminalModal: (p: { ptyId: string; title: string; onClose: () => void }) => (
    <div role="dialog">
      {p.title} {p.ptyId}
      <button onClick={p.onClose}>Done</button>
    </div>
  ),
}));

import { AccountsManager } from "../accounts-manager";

const system = {
  id: "system", provider_id: "claude-code", label: "System", detail: null,
  kind: "cli" as const, is_default: true, authenticated: false, system: true,
};

beforeEach(() => {
  api.listAccounts.mockReset().mockResolvedValue([system]);
  api.createAccount.mockReset();
  api.openAccountLogin.mockReset().mockResolvedValue({ ok: true, pty_id: "pty-1" });
  api.setDefaultAccount.mockReset().mockResolvedValue({ ok: true });
});

describe("AccountsManager (CLI)", () => {
  it("lets the System account sign in too", async () => {
    render(<AccountsManager providerId="claude-code" kind="cli" providerName="Claude Code" />);
    fireEvent.click(await screen.findByRole("button", { name: /Sign in/ }));
    await waitFor(() => expect(api.openAccountLogin).toHaveBeenCalledWith("claude-code", "system"));
    expect(await screen.findByRole("dialog")).toHaveTextContent("Claude Code · System pty-1");
  });

  it("opens the sign-in for a newly added login and keeps the list mounted", async () => {
    const onChanged = vi.fn();
    api.createAccount.mockResolvedValue({
      ok: true,
      account: { ...system, id: "acc-1", label: "Work", system: false, is_default: false },
    });
    render(<AccountsManager providerId="claude-code" kind="cli" onChanged={onChanged} />);
    await screen.findByText("System");
    fireEvent.change(screen.getByPlaceholderText(/Add another login/), { target: { value: "Work" } });
    fireEvent.click(screen.getByRole("button", { name: /Add/ }));
    await waitFor(() => expect(api.openAccountLogin).toHaveBeenCalledWith("claude-code", "acc-1"));
    expect(await screen.findByRole("dialog")).toHaveTextContent("Work pty-1");
    // The parent hears about the change when the dialog closes, not before
    // (a parent refresh used to unmount this list and lose the dialog).
    expect(onChanged).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("shows why a sign-in couldn't start", async () => {
    api.openAccountLogin.mockResolvedValue({ ok: false, error: "no login command for this agent" });
    render(<AccountsManager providerId="claude-code" kind="cli" />);
    fireEvent.click(await screen.findByRole("button", { name: /Sign in/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("no login command");
  });
});
