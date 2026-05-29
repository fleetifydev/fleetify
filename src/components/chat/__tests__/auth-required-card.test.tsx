import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const { copyTextMock, sendAuthCodeMock } = vi.hoisted(() => ({
  copyTextMock: vi.fn(),
  sendAuthCodeMock: vi.fn(),
}));
vi.mock("@/lib/clipboard", () => ({ copyText: copyTextMock }));
vi.mock("@/services/ws-manager", () => ({ wsManager: { sendAuthCode: sendAuthCodeMock } }));

import { AuthRequiredCard } from "../auth-required-card";

const openExternalMock = vi.fn();

const block = (over: Partial<import("@/types/chat").AuthRequiredBlock> = {}) => ({
  type: "auth_required" as const,
  provider: "antigravity",
  url: "https://accounts.google.com/o/oauth2/auth?x=1",
  opened_in_browser: true,
  session_id: "sess-1",
  ...over,
});

beforeEach(() => {
  copyTextMock.mockReset();
  copyTextMock.mockResolvedValue(true);
  sendAuthCodeMock.mockReset();
  openExternalMock.mockReset();
  Object.defineProperty(window, "electronAPI", {
    configurable: true,
    value: { openExternal: openExternalMock },
  });
});

describe("AuthRequiredCard", () => {
  it("shows an active 'Signing in…' headline when opened_in_browser is true", () => {
    render(<AuthRequiredCard block={block()} />);
    expect(screen.getByText(/Signing in to Antigravity/i)).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /Re-open sign-in/i });
    expect(link.getAttribute("href")).toBe("https://accounts.google.com/o/oauth2/auth?x=1");
  });

  it("clicking the sign-in link opens the URL via the bridge, not in-webview", () => {
    render(<AuthRequiredCard block={block({ url: "https://accounts.google.com/o/oauth2/auth?x=2" })} />);
    fireEvent.click(screen.getByRole("link", { name: /Re-open sign-in/i }));
    expect(openExternalMock).toHaveBeenCalledWith("https://accounts.google.com/o/oauth2/auth?x=2");
  });

  it("renders the primary 'Open sign-in' link when opened_in_browser is false", () => {
    render(<AuthRequiredCard block={block({ opened_in_browser: false, url: "https://accounts.google.com/o/oauth2/auth?x=3" })} />);
    const link = screen.getByRole("link", { name: /^Open sign-in/i });
    expect(link.getAttribute("href")).toBe("https://accounts.google.com/o/oauth2/auth?x=3");
  });

  it("copies the URL and flips to 'Copied' when the copy button is clicked", async () => {
    render(<AuthRequiredCard block={block({ url: "https://accounts.google.com/o/oauth2/auth?x=4" })} />);
    fireEvent.click(screen.getByRole("button", { name: /Copy link/i }));
    expect(copyTextMock).toHaveBeenCalledWith("https://accounts.google.com/o/oauth2/auth?x=4");
    await waitFor(() => expect(screen.getByRole("button", { name: /Copied/i })).toBeInTheDocument());
  });

  it("sends the pasted code to the session's bridge and shows 'Code sent'", async () => {
    render(<AuthRequiredCard block={block({ session_id: "sess-9" })} />);
    const input = screen.getByPlaceholderText(/Paste the code/i);
    fireEvent.change(input, { target: { value: "  4/0AbcDEF  " } });
    fireEvent.click(screen.getByRole("button", { name: /^Submit/i }));
    // Surrounding whitespace is trimmed before send.
    expect(sendAuthCodeMock).toHaveBeenCalledWith("sess-9", "4/0AbcDEF");
    await waitFor(() => expect(screen.getByText(/Code sent/i)).toBeInTheDocument());
    // Input is gone once sent.
    expect(screen.queryByPlaceholderText(/Paste the code/i)).not.toBeInTheDocument();
  });

  it("submits the code on Enter", () => {
    render(<AuthRequiredCard block={block({ session_id: "sess-enter" })} />);
    const input = screen.getByPlaceholderText(/Paste the code/i);
    fireEvent.change(input, { target: { value: "4/0XYZ" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(sendAuthCodeMock).toHaveBeenCalledWith("sess-enter", "4/0XYZ");
  });

  it("collapses to a success line once signed_in is true", () => {
    render(<AuthRequiredCard block={block({ signed_in: true })} />);
    expect(screen.getByText(/Successfully signed in to Antigravity/i)).toBeInTheDocument();
    // The in-progress affordances are gone.
    expect(screen.queryByRole("link", { name: /sign-in/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Copy link/i })).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/Paste the code/i)).not.toBeInTheDocument();
  });

  it("hides the code field when no session_id is known", () => {
    render(<AuthRequiredCard block={block({ session_id: undefined })} />);
    expect(screen.queryByPlaceholderText(/Paste the code/i)).not.toBeInTheDocument();
  });

  it("falls back to '<provider> sign-in required' for non-antigravity providers", () => {
    render(<AuthRequiredCard block={block({ provider: "other-future-provider", opened_in_browser: false, url: "https://example.com/auth" })} />);
    expect(screen.getByText(/other-future-provider sign-in required/i)).toBeInTheDocument();
  });
});
