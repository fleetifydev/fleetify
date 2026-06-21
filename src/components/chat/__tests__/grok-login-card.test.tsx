import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { act } from "react";

// We drive PTY callbacks manually via act(); tell React this is an act env so
// it doesn't warn about state updates outside the testing harness.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { copyTextMock, resumeMock, startLoginMock } = vi.hoisted(() => ({
  copyTextMock: vi.fn(),
  resumeMock: vi.fn(),
  startLoginMock: vi.fn(),
}));
vi.mock("@/lib/clipboard", () => ({ copyText: copyTextMock }));
vi.mock("@/services/ws-manager", () => ({ wsManager: { resumeAfterLogin: resumeMock } }));
vi.mock("@/lib/providers-api", () => ({ providers: { startAgentLogin: startLoginMock } }));

import { GrokLoginCard } from "../grok-login-card";

// The real `grok login` device-flow output (from the user's screenshots),
// written to stderr — clean, no escape codes (piped spawn).
const LOGIN_OUTPUT =
  "To sign in, open this URL in your browser:\r\n" +
  "  https://accounts.x.ai/oauth2/device?user_code=42EN-YCNG\r\n\r\n" +
  "Confirm this code in your browser:\r\n  42EN-YCNG\r\n\r\n" +
  "Waiting for authorization...\r\n";
const FULL_URL = "https://accounts.x.ai/oauth2/device?user_code=42EN-YCNG";

let exitCb: ((info: { exitCode: number }) => void) | null = null;
const ptyBufferMock = vi.fn();
const ptyKillMock = vi.fn();
const openExternalMock = vi.fn();

const block = (over: Partial<import("@/types/chat").GrokLoginBlock> = {}) => ({
  type: "grok_login" as const,
  provider: "grok-build",
  session_id: "s1",
  ...over,
});

beforeEach(() => {
  exitCb = null;
  startLoginMock.mockReset().mockResolvedValue({ ok: true, pty_id: "pty-1" });
  copyTextMock.mockReset().mockResolvedValue(true);
  resumeMock.mockReset();
  ptyBufferMock.mockReset().mockResolvedValue({ ok: true, data: "" });
  ptyKillMock.mockReset();
  openExternalMock.mockReset();
  Object.defineProperty(window, "electronAPI", {
    configurable: true,
    value: {
      onPtyExit: (_id: string, cb: (i: { exitCode: number }) => void) => {
        exitCb = cb;
        return () => {};
      },
      ptyBuffer: ptyBufferMock,
      ptyKill: ptyKillMock,
      openExternal: openExternalMock,
    },
  });
});

describe("GrokLoginCard", () => {
  it("spawns the login and parses the device URL + code from the PTY buffer", async () => {
    ptyBufferMock.mockResolvedValue({ ok: true, data: LOGIN_OUTPUT });
    render(<GrokLoginCard block={block()} />);
    expect(startLoginMock).toHaveBeenCalledWith("grok-build");

    await waitFor(() => expect(screen.getByText("42EN-YCNG")).toBeInTheDocument());
    expect(screen.getByText(/Waiting for authorization/i)).toBeInTheDocument();
    expect(screen.getByRole("link").getAttribute("href")).toBe(FULL_URL);
  });

  it("strips ANSI escape codes so a ConPTY-style stream still parses cleanly", async () => {
    // What a ConPTY surfaces: URL/code interleaved with real ESC cursor-move
    // codes. The parser must strip these (to spaces) before matching, or the
    // URL would swallow the trailing escape + next word.
    const E = "\x1b";
    const esc =
      `${E}[?25lTo sign in, open this URL in your browser:${E}[4;1H  ` +
      `https://accounts.x.ai/oauth2/device?user_code=42EN-YCNG${E}[6;1H${E}[?25h` +
      `Confirm this code in your browser:${E}[8;1H  42EN-YCNG${E}[12;1HWaiting for authorization...`;
    ptyBufferMock.mockResolvedValue({ ok: true, data: esc });
    render(<GrokLoginCard block={block()} />);
    await waitFor(() => expect(screen.getByText("42EN-YCNG")).toBeInTheDocument());
    // The link href is the clean URL — no escape bytes leaked in.
    expect(screen.getByRole("link").getAttribute("href")).toBe(FULL_URL);
    expect(openExternalMock).toHaveBeenCalledWith(FULL_URL);
  });

  it("auto-opens the sign-in URL in the browser", async () => {
    ptyBufferMock.mockResolvedValue({ ok: true, data: LOGIN_OUTPUT });
    render(<GrokLoginCard block={block()} />);
    await waitFor(() => expect(openExternalMock).toHaveBeenCalledWith(FULL_URL));
  });

  it("copies the device code", async () => {
    ptyBufferMock.mockResolvedValue({ ok: true, data: LOGIN_OUTPUT });
    render(<GrokLoginCard block={block()} />);
    await waitFor(() => expect(screen.getByText("42EN-YCNG")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /Copy/i }));
    expect(copyTextMock).toHaveBeenCalledWith("42EN-YCNG");
  });

  it("on clean exit, flips to a success line and resumes the original prompt", async () => {
    ptyBufferMock.mockResolvedValue({ ok: true, data: LOGIN_OUTPUT });
    render(<GrokLoginCard block={block({ session_id: "s9" })} />);
    await waitFor(() => expect(exitCb).not.toBeNull());
    act(() => exitCb!({ exitCode: 0 }));

    expect(screen.getByText(/Signed in to Grok Build/i)).toBeInTheDocument();
    expect(screen.getByText(/resuming your message/i)).toBeInTheDocument();
    expect(resumeMock).toHaveBeenCalledWith("s9");
  });

  it("on non-zero exit, shows an error with a Retry button and does not resume", async () => {
    render(<GrokLoginCard block={block()} />);
    await waitFor(() => expect(exitCb).not.toBeNull());
    act(() => exitCb!({ exitCode: 1 }));

    expect(screen.getByText(/Couldn.t sign in to Grok Build/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Try again/i })).toBeInTheDocument();
    expect(resumeMock).not.toHaveBeenCalled();
  });

  it("shows an error when the login process fails to start", async () => {
    startLoginMock.mockResolvedValue({ ok: false, error: "grok not found" });
    render(<GrokLoginCard block={block()} />);
    await waitFor(() => expect(screen.getByText(/grok not found/i)).toBeInTheDocument());
    expect(resumeMock).not.toHaveBeenCalled();
  });
});
