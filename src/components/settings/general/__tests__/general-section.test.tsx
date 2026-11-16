import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { fireEvent } from "@testing-library/react";
import { GeneralSection } from "../general-section";

beforeEach(() => {
  localStorage.clear();
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    getConfig: vi.fn(async () => ({})),
    setConfig: vi.fn(async () => true),
    openFolderDialog: vi.fn(async () => null),
  };
});

describe("GeneralSection (composed)", () => {
  it("renders all five section headers", async () => {
    render(<GeneralSection />);
    await waitFor(() => {
      expect(screen.getByText(/^Startup$/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/^Notifications$/i)).toBeInTheDocument();
    expect(screen.getByText(/^Updates$/i)).toBeInTheDocument();
    expect(screen.getByText(/^Privacy$/i)).toBeInTheDocument();
    expect(screen.getByText(/^Attribution$/i)).toBeInTheDocument();
  });

  it("renders the five signature rows", async () => {
    render(<GeneralSection />);
    await waitFor(() => {
      expect(screen.getByText(/Launch on system startup/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/Desktop notifications/i)).toBeInTheDocument();
    expect(screen.getByText(/Automatic updates/i)).toBeInTheDocument();
    expect(screen.getByText(/Anonymous usage analytics/i)).toBeInTheDocument();
    expect(
      await screen.findByText(/Credit Fleetify in commits and pull requests/i),
    ).toBeInTheDocument();
  });
});

describe("GeneralSection — cards share one config file", () => {
  // config_set replaces the whole fleet.config.json, so each card has to merge
  // its change into the config as it is when it saves. Merging into the copy
  // it read at mount would quietly undo what another card saved meanwhile.
  it("a later change in another card keeps the attribution opt-out", async () => {
    let stored: Record<string, unknown> = {
      onboardingComplete: true,
      apiKeys: {},
      defaultFolder: "/Users/me/code",
    };
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      getConfig: vi.fn(async () => ({ ...stored })),
      setConfig: vi.fn(async (next: Record<string, unknown>) => {
        stored = next;
        return true;
      }),
      openFolderDialog: vi.fn(async () => null),
    };
    render(<GeneralSection />);

    const attribution = await screen.findByRole("switch", {
      name: /credit fleetify in commits and pull requests/i,
    });
    fireEvent.click(attribution);
    await waitFor(() => expect(stored.gitAttribution).toBe(false));

    // Startup card mounted before the opt-out; clearing its folder must not
    // write the old config (without gitAttribution) back.
    fireEvent.mouseEnter(screen.getByText("/Users/me/code").closest("div")!);
    fireEvent.click(screen.getByLabelText(/clear default folder/i));
    await waitFor(() => expect(stored.defaultFolder).toBe(""));
    expect(stored.gitAttribution).toBe(false);

    // And the other way round: switching attribution back on keeps the
    // Startup card's change.
    fireEvent.click(attribution);
    await waitFor(() => expect(stored.gitAttribution).toBe(true));
    expect(stored.defaultFolder).toBe("");
    expect(stored.onboardingComplete).toBe(true);
  });
});

describe("StartupCard — default workspace folder clear", () => {
  it("does not render the X when no folder is set", async () => {
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      getConfig: vi.fn(async () => ({})),
      setConfig: vi.fn(async () => true),
      openFolderDialog: vi.fn(async () => null),
    };
    render(<GeneralSection />);
    await waitFor(() => {
      expect(screen.getByText(/Choose folder…/i)).toBeInTheDocument();
    });
    const row = screen.getByText(/Choose folder…/i).closest("div")!;
    fireEvent.mouseEnter(row);
    expect(screen.queryByLabelText(/clear default folder/i)).toBeNull();
  });

  it("renders the X clear button on hover when a folder is set", async () => {
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      getConfig: vi.fn(async () => ({ defaultFolder: "/Users/me/code" })),
      setConfig: vi.fn(async () => true),
      openFolderDialog: vi.fn(async () => null),
    };
    render(<GeneralSection />);
    await waitFor(() => {
      expect(screen.getByText("/Users/me/code")).toBeInTheDocument();
    });
    expect(screen.queryByLabelText(/clear default folder/i)).toBeNull();
    const folderLabel = screen.getByText("/Users/me/code");
    const groupShell = folderLabel.closest("div")!;
    fireEvent.mouseEnter(groupShell);
    expect(screen.getByLabelText(/clear default folder/i)).toBeInTheDocument();
  });

  it("clicking the X clears defaultFolder and persists the change", async () => {
    const setConfig = vi.fn(async () => true);
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      getConfig: vi.fn(async () => ({ defaultFolder: "/Users/me/code" })),
      setConfig,
      openFolderDialog: vi.fn(async () => null),
    };
    render(<GeneralSection />);
    await waitFor(() => {
      expect(screen.getByText("/Users/me/code")).toBeInTheDocument();
    });
    const folderLabel = screen.getByText("/Users/me/code");
    const groupShell = folderLabel.closest("div")!;
    fireEvent.mouseEnter(groupShell);
    fireEvent.click(screen.getByLabelText(/clear default folder/i));
    await waitFor(() => {
      expect(setConfig).toHaveBeenLastCalledWith(
        expect.objectContaining({ defaultFolder: "" }),
      );
    });
    expect(screen.getByText(/Choose folder…/i)).toBeInTheDocument();
  });
});
