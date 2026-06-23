import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { SettingsSidebar } from "../../settings-page";

describe("SettingsSidebar", () => {
  it("renders the Settings rail caption and NAV tabs via SidebarShell", () => {
    render(<SettingsSidebar active="General" setActive={vi.fn()} onClose={vi.fn()} setFeedbackOpen={vi.fn()} />);
    expect(screen.getByText("Settings")).toBeTruthy();     // caption
    expect(screen.getByText("Account")).toBeTruthy();      // a NAV tab
    expect(screen.getByText("General")).toBeTruthy();
  });
});
