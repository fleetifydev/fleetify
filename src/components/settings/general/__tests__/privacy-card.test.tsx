import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, within, act } from "@testing-library/react";
import { PrivacyCard } from "../privacy-card";
import { optIn, optOut } from "@/lib/posthog";

vi.mock("@/lib/posthog", () => ({
  optIn: vi.fn(),
  optOut: vi.fn(),
}));

const DASHBOARD_SYNC_DESC =
  "Shows your sessions on your fleetify.dev dashboard. Sends session titles (the start of your first message), project folder names, the kind of each agent action, token usage and cost, linked to your account. Never your code, file contents, commands or API keys. Off by default.";
const PRODUCT_ANALYTICS_DESC =
  "Usage data that helps us see which features matter (for example, whether onboarding is too long), linked to your account after you sign in. Never message content, API keys or file paths. Off by default.";
const UNSAVED =
  "Couldn't save the setting: disk full. The change applies until Fleetify restarts.";
const CALL_FAILED = "Couldn't change this setting.";

type Mock = ReturnType<typeof vi.fn>;
interface Api {
  getConfig: Mock;
  setConfig: Mock;
  telemetryGetConfig: Mock;
  telemetrySetCloudEnabled?: Mock;
  telemetrySetPosthogEnabled?: Mock;
}

function installApi(saved: { cloud_enabled?: boolean; posthog_enabled?: boolean } = {}): Api {
  const api: Api = {
    getConfig: vi.fn(async () => ({ onboardingComplete: true, apiKeys: {} })),
    setConfig: vi.fn(async () => ({ ok: true })),
    telemetryGetConfig: vi.fn(async () => ({
      distinct_id: "device-test",
      posthog_enabled: saved.posthog_enabled ?? false,
      cloud_enabled: saved.cloud_enabled ?? false,
    })),
    telemetrySetCloudEnabled: vi.fn(async () => ({ ok: true })),
    telemetrySetPosthogEnabled: vi.fn(async () => ({ ok: true })),
  };
  (window as unknown as { electronAPI: unknown }).electronAPI = api;
  return api;
}

const toggle = (name: string) => screen.findByRole("switch", { name });

beforeEach(() => {
  vi.mocked(optIn).mockClear();
  vi.mocked(optOut).mockClear();
});

describe("PrivacyCard — copy", () => {
  it("describes Dashboard sync exactly", async () => {
    installApi();
    render(<PrivacyCard />);
    expect(await screen.findByText("Dashboard sync")).toBeInTheDocument();
    expect(screen.getByText(DASHBOARD_SYNC_DESC)).toBeInTheDocument();
  });

  it("describes Product analytics exactly", async () => {
    installApi();
    render(<PrivacyCard />);
    expect(await screen.findByText("Product analytics")).toBeInTheDocument();
    expect(screen.getByText(PRODUCT_ANALYTICS_DESC)).toBeInTheDocument();
  });

  it("has no Crash reports row and never says Anonymous", async () => {
    installApi();
    const { container } = render(<PrivacyCard />);
    await screen.findByText("Dashboard sync");
    expect(container.textContent).not.toMatch(/crash reports/i);
    expect(container.textContent).not.toMatch(/anonymous/i);
    expect(screen.getAllByRole("switch")).toHaveLength(2);
  });
});

describe("PrivacyCard — Dashboard sync switch", () => {
  it.each([true, false])("shows the saved choice (cloud_enabled: %s)", async (on) => {
    installApi({ cloud_enabled: on });
    render(<PrivacyCard />);
    expect(await toggle("Dashboard sync")).toHaveAttribute("aria-checked", String(on));
  });

  it.each([false, true])(
    "a click from %s calls telemetrySetCloudEnabled with the flipped value",
    async (on) => {
      const api = installApi({ cloud_enabled: on });
      render(<PrivacyCard />);
      const sw = await toggle("Dashboard sync");
      fireEvent.click(sw);
      await waitFor(() => expect(api.telemetrySetCloudEnabled).toHaveBeenCalledWith(!on));
      expect(api.telemetrySetCloudEnabled).toHaveBeenCalledTimes(1);
      expect(sw).toHaveAttribute("aria-checked", String(!on));
      // Only through its own command: a whole-config save could write back a
      // stale `telemetry` section.
      expect(api.setConfig).not.toHaveBeenCalled();
      expect(screen.queryByRole("alert")).toBeNull();
    },
  );

  it("ignores clicks while a change is still being applied", async () => {
    const api = installApi();
    let finish!: (result: unknown) => void;
    api.telemetrySetCloudEnabled!.mockImplementationOnce(
      () => new Promise((resolve) => { finish = resolve; }),
    );
    render(<PrivacyCard />);
    const sw = await toggle("Dashboard sync");
    fireEvent.click(sw);
    fireEvent.click(sw);
    // A second command in flight could land first and leave the backend's
    // gate disagreeing with the switch.
    expect(api.telemetrySetCloudEnabled.mock.calls).toEqual([[true]]);
    await act(async () => finish({ ok: true }));
    expect(sw).toHaveAttribute("aria-checked", "true");
    expect(api.telemetrySetCloudEnabled).toHaveBeenCalledTimes(1);
  });

  it("reads the saved choices once, from telemetryGetConfig", async () => {
    const api = installApi();
    render(<PrivacyCard />);
    await toggle("Dashboard sync");
    expect(api.telemetryGetConfig).toHaveBeenCalledTimes(1);
    expect(api.getConfig).not.toHaveBeenCalled();
  });
});

describe("PrivacyCard — Product analytics switch", () => {
  it("shows the saved choice and flips the SDK with the backend", async () => {
    const api = installApi({ posthog_enabled: true });
    render(<PrivacyCard />);
    const sw = await toggle("Product analytics");
    expect(sw).toHaveAttribute("aria-checked", "true");
    fireEvent.click(sw);
    await waitFor(() => expect(api.telemetrySetPosthogEnabled).toHaveBeenCalledWith(false));
    expect(optOut).toHaveBeenCalledTimes(1);
    expect(optIn).not.toHaveBeenCalled();
    expect(sw).toHaveAttribute("aria-checked", "false");
    expect(api.setConfig).not.toHaveBeenCalled();
  });

  it("stops capturing again when an opt-in never reached the backend", async () => {
    const api = installApi();
    api.telemetrySetPosthogEnabled!.mockRejectedValueOnce(new Error("ipc down"));
    render(<PrivacyCard />);
    const sw = await toggle("Product analytics");
    fireEvent.click(sw);
    await screen.findByRole("alert");
    expect(optIn).toHaveBeenCalledTimes(1);
    expect(optOut).toHaveBeenCalledTimes(1);
    expect(vi.mocked(optOut).mock.invocationCallOrder[0]).toBeGreaterThan(
      vi.mocked(optIn).mock.invocationCallOrder[0]!,
    );
    expect(sw).toHaveAttribute("aria-checked", "false");
  });
});

describe.each([
  { name: "Dashboard sync", method: "telemetrySetCloudEnabled" },
  { name: "Product analytics", method: "telemetrySetPosthogEnabled" },
] as const)("PrivacyCard — $name save failures", ({ name, method }) => {
  /** The alert must sit in this row, under its description. */
  async function rowAlert() {
    const alert = await screen.findByRole("alert");
    expect(within(alert.parentElement!).getByText(name)).toBeInTheDocument();
    return alert;
  }

  it("ok: false keeps the choice and shows the backend's error text", async () => {
    const api = installApi();
    api[method]!.mockResolvedValueOnce({ ok: false, error: UNSAVED });
    render(<PrivacyCard />);
    const sw = await toggle(name);
    fireEvent.click(sw);
    expect((await rowAlert()).textContent).toBe(UNSAVED);
    // The live gate already took the change, so the switch keeps showing it.
    expect(sw).toHaveAttribute("aria-checked", "true");
    expect(screen.getAllByRole("alert")).toHaveLength(1);
  });

  it("a rejected call reverts the switch and shows the fallback text", async () => {
    const api = installApi();
    api[method]!.mockRejectedValueOnce(new Error("ipc down"));
    render(<PrivacyCard />);
    const sw = await toggle(name);
    fireEvent.click(sw);
    expect((await rowAlert()).textContent).toBe(CALL_FAILED);
    expect(sw).toHaveAttribute("aria-checked", "false");
  });

  it("a missing bridge reverts the switch and shows the fallback text", async () => {
    const api = installApi({ cloud_enabled: true, posthog_enabled: true });
    delete api[method];
    render(<PrivacyCard />);
    const sw = await toggle(name);
    fireEvent.click(sw);
    expect((await rowAlert()).textContent).toBe(CALL_FAILED);
    expect(sw).toHaveAttribute("aria-checked", "true");
  });

  it("the next successful toggle clears the error", async () => {
    const api = installApi();
    api[method]!.mockResolvedValueOnce({ ok: false, error: UNSAVED });
    render(<PrivacyCard />);
    const sw = await toggle(name);
    fireEvent.click(sw);
    await rowAlert();
    fireEvent.click(sw);
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(api[method]).toHaveBeenLastCalledWith(false);
    expect(sw).toHaveAttribute("aria-checked", "false");
  });
});
