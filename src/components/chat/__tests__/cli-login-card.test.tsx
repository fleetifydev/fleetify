import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { act } from "react";

// PTY callbacks are driven by hand via act().
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  copyText: vi.fn(),
  resume: vi.fn(),
  startLogin: vi.fn(),
  openLogin: vi.fn(),
  setKey: vi.fn(),
  backendFetch: vi.fn(),
  terminalExit: null as ((code: number) => void) | null,
}));
vi.mock("@/lib/clipboard", () => ({ copyText: mocks.copyText }));
vi.mock("@/services/ws-manager", () => ({ wsManager: { resumeAfterLogin: mocks.resume } }));
vi.mock("@/lib/providers-api", () => ({
  providers: {
    startAgentLogin: mocks.startLogin,
    openAccountLogin: mocks.openLogin,
    setKey: mocks.setKey,
  },
}));
vi.mock("@/lib/api", () => ({ backendFetch: mocks.backendFetch }));
vi.mock("@/components/settings/shared/account-login-terminal", () => ({
  AccountLoginTerminal: ({ ptyId, onExit }: { ptyId: string; onExit: (c: number) => void }) => {
    mocks.terminalExit = onExit;
    return <div data-testid="login-terminal">{ptyId}</div>;
  },
}));

import { CliLoginCard } from "../cli-login-card";
import { useChatStore } from "@/stores/chat-store";
import { resetAgentScanStoreForTests } from "@/stores/agent-scan-store";
import type { CliLoginBlock } from "@/types/chat";

// Real `grok login --device-auth` and `claude auth login` output.
const GROK_OUTPUT =
  "To sign in, open this URL in your browser:\n\n" +
  "  https://accounts.x.ai/oauth2/device?user_code=42EN-YCNG\n\n" +
  "Confirm this code in your browser:\n\n  42EN-YCNG\n\nWaiting for authorization...\n";
const CLAUDE_OUTPUT =
  "Opening browser to sign in…\nIf the browser didn't open, visit:\n" +
  "https://claude.ai/oauth/authorize?abc\nPaste code here if prompted > ";

let exitCb: ((info: { exitCode: number }) => void) | null = null;
const ptyBuffer = vi.fn();
const ptyKill = vi.fn();
const ptyWrite = vi.fn();
let seq = 0;
let ptyId = "";

function scanResponse(rows: Record<string, { authenticated: boolean }>) {
  const body: Record<string, unknown> = {};
  for (const [id, r] of Object.entries(rows)) {
    body[id] = { id, display_name: id, installed: true, path: "/x", install_hint: "", login_hint: "", ...r };
  }
  return { ok: true, json: async () => body };
}

/** Put a sign-in block in the transcript and render it the way the
 *  transcript does: from the store, so the card's own updates flow back. */
function mount(block: Partial<CliLoginBlock> & { provider: string }) {
  const messageId = `msg-${++seq}`;
  const sessionId = `s-${seq}`;
  useChatStore.getState().addMessage(sessionId, {
    id: messageId,
    role: "system",
    content: [{ type: "cli_login", session_id: sessionId, ...block }],
    timestamp: new Date().toISOString(),
  });
  function Harness() {
    const msg = useChatStore((s) => s.sessions[sessionId]?.messages.find((m) => m.id === messageId));
    const b = msg?.content[0] as CliLoginBlock | undefined;
    return b ? <CliLoginCard block={b} messageId={messageId} /> : null;
  }
  return { sessionId, messageId, ...render(<Harness />), Harness };
}

beforeEach(() => {
  exitCb = null;
  mocks.terminalExit = null;
  useChatStore.setState({ sessions: {} });
  resetAgentScanStoreForTests();
  // A fresh login id per test: the card remembers exits by id across mounts.
  ptyId = `pty-${++seq}`;
  mocks.startLogin.mockReset().mockResolvedValue({ ok: true, pty_id: ptyId });
  mocks.openLogin.mockReset().mockResolvedValue({ ok: true, pty_id: `${ptyId}-t` });
  mocks.setKey.mockReset().mockResolvedValue({ ok: true });
  mocks.copyText.mockReset().mockResolvedValue(true);
  mocks.resume.mockReset().mockResolvedValue(true);
  mocks.backendFetch.mockReset().mockResolvedValue(scanResponse({}));
  ptyBuffer.mockReset().mockResolvedValue({ ok: true, data: "" });
  ptyKill.mockReset();
  ptyWrite.mockReset().mockResolvedValue(true);
  Object.defineProperty(window, "electronAPI", {
    configurable: true,
    value: {
      onPtyExit: (_id: string, cb: (i: { exitCode: number }) => void) => {
        exitCb = cb;
        return () => {};
      },
      ptyBuffer,
      ptyKill,
      ptyWrite,
      openExternal: vi.fn(),
    },
  });
});

describe("CliLoginCard — browser / device logins", () => {
  it("starts the agent's login once and shows the device URL and code", async () => {
    ptyBuffer.mockResolvedValue({ ok: true, data: GROK_OUTPUT });
    mount({ provider: "grok-build", login_kind: "browser" });
    await waitFor(() => expect(screen.getByText("42EN-YCNG")).toBeInTheDocument());
    expect(mocks.startLogin).toHaveBeenCalledTimes(1);
    expect(mocks.startLogin).toHaveBeenCalledWith("grok-build", null);
    expect(screen.getByRole("link").getAttribute("href")).toBe(
      "https://accounts.x.ai/oauth2/device?user_code=42EN-YCNG",
    );
    fireEvent.click(screen.getByRole("button", { name: /Copy/i }));
    expect(mocks.copyText).toHaveBeenCalledWith("42EN-YCNG");
  });

  it("checks the agent after a clean exit, then resumes the prompt", async () => {
    mocks.backendFetch.mockResolvedValue(scanResponse({ "claude-code": { authenticated: true } }));
    const { sessionId } = mount({ provider: "claude-code", login_kind: "browser" });
    await waitFor(() => expect(exitCb).not.toBeNull());
    await act(async () => exitCb!({ exitCode: 0 }));

    await waitFor(() => expect(screen.getByText(/Signed in to claude-code/)).toBeInTheDocument());
    expect(mocks.backendFetch).toHaveBeenCalledWith("/api/agents/scan?refresh=1", expect.anything());
    expect(mocks.resume).toHaveBeenCalledWith(sessionId);
    // The block remembers the result, so a remount shows the result line.
    const block = useChatStore.getState().sessions[sessionId]!.messages[0]!.content[0] as CliLoginBlock;
    expect(block.signed_in).toBe(true);
  });

  it("doesn't resume when the login exited but the agent still isn't signed in", async () => {
    mocks.backendFetch.mockResolvedValue(scanResponse({ "codex-cli": { authenticated: false } }));
    mount({ provider: "codex-cli", login_kind: "browser" });
    await waitFor(() => expect(exitCb).not.toBeNull());
    await act(async () => exitCb!({ exitCode: 0 }));
    await waitFor(() => expect(screen.getByText(/still isn’t signed in/)).toBeInTheDocument());
    expect(mocks.resume).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /Try again/i })).toBeInTheDocument();
  });

  it("shows an error with Try again on a failed exit", async () => {
    mount({ provider: "grok-build", login_kind: "browser" });
    await waitFor(() => expect(exitCb).not.toBeNull());
    await act(async () => exitCb!({ exitCode: 1 }));
    expect(screen.getByText(/Couldn.t sign in to grok-build|Couldn.t sign in to Grok Build/)).toBeInTheDocument();
    expect(screen.getByText(/exited with code 1/)).toBeInTheDocument();
    expect(mocks.resume).not.toHaveBeenCalled();
  });

  it("quotes what the agent said without Fleetify's ACP plumbing", async () => {
    mount({
      provider: "grok-build",
      login_kind: "browser",
      detail: "session/new failed: ACP error -32000: Authentication required — no auth method id provided",
    });
    expect(
      await screen.findByText(/said: “Authentication required — no auth method id provided”/),
    ).toBeInTheDocument();
  });

  it("shows why the login couldn't start", async () => {
    mocks.startLogin.mockResolvedValue({ ok: false, error: "grok not found" });
    mount({ provider: "grok-build", login_kind: "browser" });
    await waitFor(() => expect(screen.getByText(/grok not found/)).toBeInTheDocument());
    expect(mocks.resume).not.toHaveBeenCalled();
  });

  it("passes a pasted code to Claude Code's login", async () => {
    ptyBuffer.mockResolvedValue({ ok: true, data: CLAUDE_OUTPUT });
    mount({ provider: "claude-code", login_kind: "browser" });
    const input = await screen.findByLabelText("Sign-in code");
    fireEvent.change(input, { target: { value: "abc#def" } });
    fireEvent.click(screen.getByRole("button", { name: /Submit/i }));
    await waitFor(() => expect(ptyWrite).toHaveBeenCalledWith(ptyId, "abc#def\n"));
    expect(await screen.findByText(/Code sent/)).toBeInTheDocument();
  });

  it("signs in the session's account and trusts a clean exit for it", async () => {
    mocks.backendFetch.mockResolvedValue(scanResponse({ "claude-code": { authenticated: false } }));
    mount({ provider: "claude-code", login_kind: "browser", account_id: "acc-1" });
    await waitFor(() => expect(exitCb).not.toBeNull());
    expect(mocks.startLogin).toHaveBeenCalledWith("claude-code", "acc-1");
    await act(async () => exitCb!({ exitCode: 0 }));
    // The scan only sees the System account, so it can't veto this one.
    await waitFor(() => expect(mocks.resume).toHaveBeenCalled());
  });

  it("re-attaches to the running login after a remount instead of starting another", async () => {
    const first = mount({ provider: "grok-build", login_kind: "browser" });
    await waitFor(() => expect(mocks.startLogin).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      const b = useChatStore.getState().sessions[first.sessionId]!.messages[0]!.content[0] as CliLoginBlock;
      expect(b.pty_id).toBe(ptyId);
    });
    first.unmount();
    render(<first.Harness />);
    await waitFor(() => expect(ptyBuffer).toHaveBeenCalledWith(ptyId));
    expect(mocks.startLogin).toHaveBeenCalledTimes(1);
  });

  it("says to send again when there's nothing to resume", async () => {
    mocks.resume.mockResolvedValue(false);
    mocks.backendFetch.mockResolvedValue(scanResponse({ "grok-build": { authenticated: true } }));
    mount({ provider: "grok-build", login_kind: "browser" });
    await waitFor(() => expect(exitCb).not.toBeNull());
    await act(async () => exitCb!({ exitCode: 0 }));
    await waitFor(() => expect(screen.getByText(/Send your message again/)).toBeInTheDocument());
  });
});

describe("CliLoginCard — interactive and API-key sign-ins", () => {
  it("runs an interactive login in a terminal and resumes after it", async () => {
    mocks.backendFetch.mockResolvedValue(scanResponse({ "hermes-agent": { authenticated: true } }));
    const { sessionId } = mount({ provider: "hermes-agent", login_kind: "terminal" });
    await waitFor(() => expect(screen.getByTestId("login-terminal")).toHaveTextContent(`${ptyId}-t`));
    expect(mocks.openLogin).toHaveBeenCalledWith("hermes-agent", "system");
    expect(mocks.startLogin).not.toHaveBeenCalled();
    await act(async () => mocks.terminalExit!(0));
    await waitFor(() => expect(mocks.resume).toHaveBeenCalledWith(sessionId));
  });

  it("asks the Antigravity SDK for a Gemini key and resumes once it's saved", async () => {
    mocks.backendFetch.mockResolvedValue(scanResponse({ "antigravity-sdk": { authenticated: true } }));
    const { sessionId } = mount({ provider: "antigravity-sdk", login_kind: "api_key" });
    expect(mocks.startLogin).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Gemini API key"), { target: { value: "AIza-test" } });
    fireEvent.click(screen.getByRole("button", { name: /Save and continue/i }));
    await waitFor(() => expect(mocks.setKey).toHaveBeenCalledWith("antigravity-sdk", "AIza-test"));
    await waitFor(() => expect(mocks.resume).toHaveBeenCalledWith(sessionId));
  });
});
