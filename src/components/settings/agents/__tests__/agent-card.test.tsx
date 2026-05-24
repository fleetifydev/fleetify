import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { AgentCard, type AgentScanEntry } from "../agent-card";
import type { ProviderSpec } from "@/lib/providers-api";

const spec: ProviderSpec = {
  id: "claude",
  display_name: "Claude Code",
  kind: "cli",
  default_base_url: "",
  auth: { kind: "none" },
  default_models: [],
  extras: {},
  bin: "claude",
  auth_indicators: [],
  install_hint: "npm install -g @anthropic-ai/claude-code",
  login_hint: "claude login",
};

const installedScan: AgentScanEntry = {
  id: "claude",
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

beforeEach(() => {
  (window as any).electronAPI = {
    installProvider: vi.fn().mockResolvedValue({ success: true }),
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
});
