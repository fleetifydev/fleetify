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
  it("renders all four section headers", async () => {
    render(<GeneralSection />);
    await waitFor(() => {
      expect(screen.getByText(/^Startup$/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/^Notifications$/i)).toBeInTheDocument();
    expect(screen.getByText(/^Updates$/i)).toBeInTheDocument();
    expect(screen.getByText(/^Privacy$/i)).toBeInTheDocument();
  });

  it("renders the four signature rows", async () => {
    render(<GeneralSection />);
    await waitFor(() => {
      expect(screen.getByText(/Launch on system startup/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/Desktop notifications/i)).toBeInTheDocument();
    expect(screen.getByText(/Automatic updates/i)).toBeInTheDocument();
    expect(screen.getByText(/Anonymous usage analytics/i)).toBeInTheDocument();
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
