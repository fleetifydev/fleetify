import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

const loginModal = vi.hoisted(() => ({ props: null as null | { ptyId: string; title: string } }));
vi.mock("@/components/settings/shared/login-terminal-modal", () => ({
  LoginTerminalModal: (p: { ptyId: string; title: string }) => {
    loginModal.props = p;
    return <div role="dialog">login {p.ptyId}</div>;
  },
}));
// The accounts list has its own tests; keep it out of these.
vi.mock("@/components/settings/shared/accounts-manager", () => ({
  AccountsManager: () => null,
}));

import { AgentCard, type AgentScanEntry } from "../agent-card";
import type { ProviderSpec } from "@/lib/providers-api";

const spec: ProviderSpec = {
  id: "claude-code",
  display_name: "Claude Code",
  kind: "cli",
  default_base_url: "",
  auth: { kind: "none" },
  default_models: [],
  extras: {},
  bin: "claude-code",
  auth_indicators: [],
  install_hint: "npm install -g @anthropic-ai/claude-code",
  login_hint: "claude auth login",
};

const installedScan: AgentScanEntry = {
  id: "claude-code",
  display_name: "Claude Code",
  installed: true,
  authenticated: true,
  path: "C:\\Users\\Tester\\AppData\\Roaming\\npm\\claude.cmd",
  install_hint: spec.install_hint,
  login_hint: spec.login_hint,
};

const uninstalledScan: AgentScanEntry = {
  ...installedScan,
  installed: false,
  authenticated: false,
  path: null,
};

const openAccountLogin = vi.fn();

beforeEach(() => {
  loginModal.props = null;
  openAccountLogin.mockReset().mockResolvedValue({ ok: true, pty_id: "pty-9" });
  (window as any).electronAPI = {
    installProvider: vi.fn().mockResolvedValue({ success: true }),
    providers: {
      openAccountLogin,
      listCatalog: vi.fn().mockResolvedValue({ ok: true, tiles: [] }),
      onChanged: () => () => {},
    },
  };
});

describe("AgentCard", () => {
  it("never renders the executable path", () => {
    render(<AgentCard spec={spec} scan={installedScan} onChanged={() => {}} />);
    expect(screen.queryByText(installedScan.path!)).toBeNull();
    expect(screen.queryByText(/claude\.cmd/)).toBeNull();
  });

  it("uses a neutral border regardless of detection state", () => {
    const { container } = render(
      <AgentCard spec={spec} scan={installedScan} onChanged={() => {}} />
    );
    const card = container.firstChild as HTMLElement;
    // The "green border" used rgba(74,222,128,…) — assert it's gone.
    expect(card.style.border).not.toMatch(/74,\s*222,\s*128/);
  });

  it("shows an Install button when the agent is not installed", () => {
    render(
      <AgentCard
        spec={spec}
        scan={uninstalledScan}
        onChanged={() => {}}
        installing={false}
        onInstall={vi.fn()}
      />
    );
    // Expand the card so the install section renders.
    fireEvent.click(screen.getByRole("button", { name: /Claude Code/ }));
    expect(screen.getByRole("button", { name: /^Install$/ })).toBeInTheDocument();
  });

  it("invokes onInstall when the Install button is clicked", () => {
    const onInstall = vi.fn();
    render(
      <AgentCard
        spec={spec}
        scan={uninstalledScan}
        onChanged={() => {}}
        installing={false}
        onInstall={onInstall}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /Claude Code/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Install$/ }));
    expect(onInstall).toHaveBeenCalledTimes(1);
  });

  it("disables the Install button and shows a spinner while installing", () => {
    render(
      <AgentCard
        spec={spec}
        scan={uninstalledScan}
        onChanged={() => {}}
        installing={true}
        onInstall={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /Claude Code/ }));
    const installBtn = screen.getByRole("button", { name: /Installing/i });
    expect(installBtn).toBeDisabled();
  });

  it("renders the AntigravitySdkSetupRow for the antigravity-sdk provider", async () => {
    // Mock electronAPI.checkPythonRuntime to return no Python.
    (window as any).electronAPI = {
      ...(window as any).electronAPI,
      checkPythonRuntime: vi.fn().mockResolvedValue({ installed: false, version: null, path: null }),
    };
    const sdkSpec: ProviderSpec = {
      id: "antigravity-sdk",
      display_name: "Antigravity SDK",
      kind: "cli",
      default_base_url: "",
      auth: { kind: "none" },
      default_models: [],
      extras: {},
      bin: "python3",
      auth_indicators: [],
      install_hint: "pip install google-antigravity",
      login_hint: "",
    };
    const sdkScan: AgentScanEntry = {
      id: "antigravity-sdk",
      display_name: "Antigravity SDK",
      installed: false,
      authenticated: false,
      path: null,
      install_hint: "pip install google-antigravity",
      login_hint: "",
    };
    render(
      <AgentCard
        spec={sdkSpec}
        scan={sdkScan}
        onChanged={vi.fn()}
        installing={false}
        installError={undefined}
        onInstall={vi.fn()}
      />
    );
    // Expand the card to reveal the body.
    fireEvent.click(screen.getByRole("button", { name: /antigravity sdk/i }));
    // Wait for the Python probe to resolve.
    await waitFor(() => {
      expect(screen.getByText(/Python required/i)).toBeInTheDocument();
    });
    // The legacy "$ pip install" hint + Install button should NOT render.
    expect(screen.queryByText(/\$ pip install/)).not.toBeInTheDocument();
  });

  it("says Signed in when the agent is installed and signed in", () => {
    render(<AgentCard spec={spec} scan={installedScan} onChanged={() => {}} />);
    expect(screen.getByText("Signed in")).toBeInTheDocument();
  });

  it("offers a Sign in button that runs the login in a terminal for the System account", async () => {
    const onChanged = vi.fn();
    render(
      <AgentCard
        spec={spec}
        scan={{ ...installedScan, authenticated: false }}
        onChanged={onChanged}
      />,
    );
    expect(screen.getByText("Sign in required")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Claude Code/ }));
    // The command users would type is still shown, with the right command.
    expect(screen.getByText("claude auth login")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Sign in to Claude Code/ }));
    await waitFor(() => expect(openAccountLogin).toHaveBeenCalledWith("claude-code", "system"));
    expect(await screen.findByRole("dialog")).toHaveTextContent("pty-9");
    expect(loginModal.props?.title).toBe("Claude Code");
  });

  it("shows why a sign-in couldn't start", async () => {
    openAccountLogin.mockResolvedValue({ ok: false, error: "claude not found" });
    render(<AgentCard spec={spec} scan={{ ...installedScan, authenticated: false }} onChanged={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Claude Code/ }));
    fireEvent.click(screen.getByRole("button", { name: /Sign in to Claude Code/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("claude not found");
  });

  it("says it couldn't check instead of claiming Not installed when the scan failed", () => {
    render(<AgentCard spec={spec} scan={undefined} scanFailed onChanged={() => {}} />);
    expect(screen.getByText("Couldn't check")).toBeInTheDocument();
    expect(screen.queryByText("Not installed")).toBeNull();
  });

  it("calls an agent that needs no sign-in Ready", () => {
    const oc: ProviderSpec = { ...spec, id: "opencode", display_name: "OpenCode" };
    render(
      <AgentCard
        spec={oc}
        scan={{ ...installedScan, id: "opencode", auth_required: false, authenticated: true }}
        onChanged={() => {}}
      />,
    );
    expect(screen.getByText("Ready")).toBeInTheDocument();
  });
});
