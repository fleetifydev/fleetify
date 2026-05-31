import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { CloudflareConfigCard } from "../cloudflare-config-card";
import type { ProviderTile } from "@/lib/providers-api";

const tile: ProviderTile = {
  spec: {
    id: "cloudflare-workers-ai",
    display_name: "Cloudflare Workers AI",
    kind: "api",
    default_base_url:
      "https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1",
    auth: { kind: "bearer", env_hint: "CLOUDFLARE_API_TOKEN" },
    default_models: [
      {
        id: "@cf/meta/llama-3.1-8b-instruct",
        label: "Llama 3.1 8B",
        supports_effort: false,
      },
    ],
    extras: { supports_streaming: true },
    bin: "",
    auth_indicators: [],
    install_hint: "",
    login_hint: "",
  },
  connected: false,
  has_key: false,
  enabled_models: [],
  is_default: false,
};

const mocks = vi.hoisted(() => ({
  openExternal: vi.fn().mockResolvedValue({ ok: true }),
  setKey: vi.fn().mockResolvedValue(undefined),
  deleteKey: vi.fn().mockResolvedValue(undefined),
  setEnabled: vi.fn().mockResolvedValue(undefined),
  setCloudflareAccountId: vi.fn().mockResolvedValue(undefined),
  cloudflareVerify: vi.fn(),
}));

vi.mock("@/hooks/use-providers-config", () => ({
  useProvidersConfig: () => ({
    setKey: mocks.setKey,
    deleteKey: mocks.deleteKey,
    setEnabled: mocks.setEnabled,
    setCloudflareAccountId: mocks.setCloudflareAccountId,
  }),
}));

vi.mock("@/lib/providers-api", async () => {
  const real = await vi.importActual<typeof import("@/lib/providers-api")>(
    "@/lib/providers-api",
  );
  return {
    ...real,
    providers: { ...real.providers, cloudflareVerify: mocks.cloudflareVerify },
  };
});

const { openExternal, setKey, deleteKey, setCloudflareAccountId, cloudflareVerify } =
  mocks;

// Stub window.electronAPI.openExternal before each test
beforeEach(() => {
  vi.clearAllMocks();
  // @ts-expect-error — stubbing the electronAPI on the happy-dom window
  window.electronAPI = { openExternal };
});

// Workers AI tokens can't list accounts, so connecting takes a token AND a
// hand-entered Account ID. Fill both inputs.
function fillConnectForm(token: string, accountId: string) {
  fireEvent.change(screen.getByPlaceholderText(/paste your cloudflare/i), {
    target: { value: token },
  });
  fireEvent.change(screen.getByPlaceholderText(/account id/i), {
    target: { value: accountId },
  });
}

describe("CloudflareConfigCard", () => {
  it("opens Cloudflare's official Workers AI token page on Connect", () => {
    render(<CloudflareConfigCard tile={tile} onHealthChange={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /open cloudflare/i }));
    expect(openExternal).toHaveBeenCalledTimes(1);
    const url = openExternal.mock.calls[0][0] as string;
    // First-party Workers AI page → "Use REST API → Create a Workers AI API
    // Token" (the only path that grants Workers AI permissions).
    expect(url).toContain("dash.cloudflare.com/?to=/:account/ai/workers-ai");
  });

  it("verifies a pasted token + account id and stores both", async () => {
    cloudflareVerify.mockResolvedValue({ valid: true });
    render(<CloudflareConfigCard tile={tile} onHealthChange={() => {}} />);
    fillConnectForm("tok-xyz", "acc-123");
    fireEvent.click(screen.getByRole("button", { name: /verify & connect/i }));
    await waitFor(() =>
      expect(cloudflareVerify).toHaveBeenCalledWith("tok-xyz", "acc-123"),
    );
    expect(setKey).toHaveBeenCalledWith("cloudflare-workers-ai", "tok-xyz");
    expect(setCloudflareAccountId).toHaveBeenCalledWith("acc-123");
  });

  it("shows the error and stores nothing when verify fails", async () => {
    cloudflareVerify.mockResolvedValue({
      valid: false,
      error:
        "Token can't access Workers AI on this account — check the Account ID.",
    });
    render(<CloudflareConfigCard tile={tile} onHealthChange={() => {}} />);
    fillConnectForm("tok", "wrong-acct");
    fireEvent.click(screen.getByRole("button", { name: /verify & connect/i }));
    await waitFor(() =>
      expect(screen.getByText(/can't access workers ai/i)).toBeInTheDocument(),
    );
    expect(setKey).not.toHaveBeenCalled();
    expect(setCloudflareAccountId).not.toHaveBeenCalled();
  });

  it("keeps Verify disabled until both token and account id are present", () => {
    render(<CloudflareConfigCard tile={tile} onHealthChange={() => {}} />);
    const verify = screen.getByRole("button", { name: /verify & connect/i });
    expect(verify).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText(/paste your cloudflare/i), {
      target: { value: "tok-only" },
    });
    expect(verify).toBeDisabled(); // account id still missing
    fireEvent.change(screen.getByPlaceholderText(/account id/i), {
      target: { value: "acc-1" },
    });
    expect(verify).not.toBeDisabled();
  });

  it("shows a saved view with Disconnect for a connected tile", async () => {
    const connected: ProviderTile = { ...tile, connected: true, has_key: true };
    render(<CloudflareConfigCard tile={connected} onHealthChange={() => {}} />);
    // A connected tile starts collapsed — expand to reveal the saved view.
    fireEvent.click(screen.getByText("Cloudflare Workers AI"));
    const disconnect = await screen.findByRole("button", { name: /disconnect/i });
    fireEvent.click(disconnect);
    await waitFor(() =>
      expect(deleteKey).toHaveBeenCalledWith("cloudflare-workers-ai"),
    );
    // Disconnect also clears the account id (empty → None server-side).
    expect(setCloudflareAccountId).toHaveBeenCalledWith("");
  });

  it("renders the enable/disable toggle for a connected tile", () => {
    const connected: ProviderTile = { ...tile, connected: true, has_key: true };
    render(<CloudflareConfigCard tile={connected} onHealthChange={() => {}} />);
    // Master toggle lives in the always-visible header (mirrors ProviderCard).
    expect(screen.getByTitle(/toggle off to hide/i)).toBeInTheDocument();
  });
});
