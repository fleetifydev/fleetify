import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { StartupCard } from "../startup-card";
import { NotificationsCard } from "../notifications-card";
import { UpdatesCard } from "../updates-card";

// Every General card that saves through saveConfigPatch handles a failed
// save the same way: the control goes back to what the file still says, the
// shell's message shows under that row (role="alert"), and the next save
// that works clears it. config_set reports a failed save as
// `{ ok: false, error }`, not as a throw.

beforeEach(() => {
  localStorage.clear();
});

const cases = [
  { card: "StartupCard", Card: StartupCard, row: "Launch on system startup", initiallyOn: false },
  { card: "StartupCard", Card: StartupCard, row: "Restore last session", initiallyOn: true },
  { card: "NotificationsCard", Card: NotificationsCard, row: "Do Not Disturb", initiallyOn: false },
  { card: "UpdatesCard", Card: UpdatesCard, row: "Automatic updates", initiallyOn: true },
] as const;

describe.each(cases)("$card — $row", ({ Card, row, initiallyOn }) => {
  it("flips back and shows the message under its row when the save fails", async () => {
    window.electronAPI = {
      getConfig: vi.fn().mockResolvedValue({ onboardingComplete: true }),
      setConfig: vi.fn().mockResolvedValue({ ok: false, error: "y" }),
      openFolderDialog: vi.fn().mockResolvedValue(null),
    } as never;
    render(<Card />);
    const toggle = await screen.findByRole("switch", { name: row });
    expect(toggle).toHaveAttribute("aria-checked", String(initiallyOn));

    fireEvent.click(toggle);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("y");
    // Under the row whose save failed, not another one.
    expect(alert.parentElement).toHaveTextContent(row);
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(toggle).toHaveAttribute("aria-checked", String(initiallyOn));
  });

  it("clears the message on the next save that works", async () => {
    const setConfig = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: "y" })
      .mockResolvedValue({ ok: true });
    window.electronAPI = {
      getConfig: vi.fn().mockResolvedValue({ onboardingComplete: true }),
      setConfig,
      openFolderDialog: vi.fn().mockResolvedValue(null),
    } as never;
    render(<Card />);
    const toggle = await screen.findByRole("switch", { name: row });

    fireEvent.click(toggle);
    expect(await screen.findByRole("alert")).toHaveTextContent("y");

    fireEvent.click(toggle);
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(toggle).toHaveAttribute("aria-checked", String(!initiallyOn));
    expect(setConfig).toHaveBeenCalledTimes(2);
  });
});

describe("StartupCard — default workspace folder", () => {
  it("keeps the saved folder and shows the message when choosing a new one fails", async () => {
    window.electronAPI = {
      getConfig: vi.fn().mockResolvedValue({ defaultFolder: "/work/old" }),
      setConfig: vi.fn().mockResolvedValue({ ok: false, error: "z" }),
      openFolderDialog: vi.fn().mockResolvedValue("/work/new"),
    } as never;
    render(<StartupCard />);
    fireEvent.click(await screen.findByText("/work/old"));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("z");
    expect(alert.parentElement).toHaveTextContent("Default workspace folder");
    expect(screen.getByText("/work/old")).toBeInTheDocument();
    expect(screen.queryByText("/work/new")).toBeNull();
  });
});
