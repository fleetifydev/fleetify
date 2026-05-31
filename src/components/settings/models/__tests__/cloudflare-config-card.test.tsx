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

const { openExternal, setKey, deleteKey, setEnabled, setCloudflareAccountId, cloudflareVerify } =
  mocks;

// Stub window.electronAPI.openExternal before each test
beforeEach(() => {
  vi.clearAllMocks();
  // @ts-expect-error — stubbing the electronAPI on the happy-dom window
  window.electronAPI = { openExternal };
});

describe("CloudflareConfigCard", () => {
  it("opens the token-template URL with pre-filled permissions on Connect", () => {
    render(<CloudflareConfigCard tile={tile} onHealthChange={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /open cloudflare/i }));
    expect(openExternal).toHaveBeenCalledTimes(1);
    const url = openExternal.mock.calls[0][0] as string;
    expect(url).toContain("dash.cloudflare.com/profile/api-tokens");
    expect(url).toContain("permissionGroupKeys=");
    expect(decodeURIComponent(url)).toContain("workers_ai");
  });

  it("verifies a pasted token, stores token + single account", async () => {
    cloudflareVerify.mockResolvedValue({
      valid: true,
      accounts: [{ id: "acc_1", name: "Acme" }],
    });
    render(<CloudflareConfigCard tile={tile} onHealthChange={() => {}} />);
    fireEvent.change(
      screen.getByPlaceholderText(/paste your cloudflare/i),
      { target: { value: "tok-xyz" } },
    );
    fireEvent.click(screen.getByRole("button", { name: /verify & connect/i }));
    await waitFor(() =>
      expect(setKey).toHaveBeenCalledWith("cloudflare-workers-ai", "tok-xyz"),
    );
    expect(setCloudflareAccountId).toHaveBeenCalledWith("acc_1");
  });

  it("shows an error and stores nothing for an invalid token", async () => {
    cloudflareVerify.mockResolvedValue({
      valid: false,
      accounts: [],
      error: "token not active",
    });
    render(<CloudflareConfigCard tile={tile} onHealthChange={() => {}} />);
    fireEvent.change(
      screen.getByPlaceholderText(/paste your cloudflare/i),
      { target: { value: "bad" } },
    );
    fireEvent.click(screen.getByRole("button", { name: /verify & connect/i }));
    await waitFor(() =>
      expect(screen.getByText(/token not active/i)).toBeInTheDocument(),
    );
    expect(setKey).not.toHaveBeenCalled();
    expect(setCloudflareAccountId).not.toHaveBeenCalled();
  });

  it("shows an account picker for >1 account and persists the chosen one", async () => {
    cloudflareVerify.mockResolvedValue({
      valid: true,
      accounts: [
        { id: "acc_a", name: "Acme" },
        { id: "acc_b", name: "Beta Co" },
      ],
    });
    render(<CloudflareConfigCard tile={tile} onHealthChange={() => {}} />);
    fireEvent.change(
      screen.getByPlaceholderText(/paste your cloudflare/i),
      { target: { value: "tok-multi" } },
    );
    fireEvent.click(screen.getByRole("button", { name: /verify & connect/i }));
    // Picker appears; nothing persisted until a choice is made.
    await waitFor(() =>
      expect(screen.getByText(/choose an account/i)).toBeInTheDocument(),
    );
    expect(setKey).not.toHaveBeenCalled();
    // Choose the second account.
    fireEvent.click(screen.getByRole("button", { name: /beta co/i }));
    await waitFor(() =>
      expect(setKey).toHaveBeenCalledWith("cloudflare-workers-ai", "tok-multi"),
    );
    expect(setCloudflareAccountId).toHaveBeenCalledWith("acc_b");
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
