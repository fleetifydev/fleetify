import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { SidebarShell, SIDEBAR_DEFAULT_WIDTH, SideRow } from "../sidebar-shell";

describe("SidebarShell", () => {
  it("renders caption, children rows, and footer", () => {
    render(
      <SidebarShell
        caption={{ icon: <span data-testid="cap-icon" />, label: "Settings" }}
        footer={<div>FOOT</div>}
      >
        <SideRow label="Account" />
        <SideRow label="General" />
      </SidebarShell>,
    );
    expect(screen.getByText("Settings")).toBeTruthy();
    expect(screen.getByText("Account")).toBeTruthy();
    expect(screen.getByText("General")).toBeTruthy();
    expect(screen.getByText("FOOT")).toBeTruthy();
  });

  it("default width constant is 224", () => {
    expect(SIDEBAR_DEFAULT_WIDTH).toBe(224);
  });

  it("chrome=false omits the outer card (nav is the root)", () => {
    const { container } = render(
      <SidebarShell chrome={false}><SideRow label="X" /></SidebarShell>,
    );
    // chrome=false → root element is the <nav>, not a wrapping card div.
    expect((container.firstChild as HTMLElement).tagName).toBe("NAV");
  });

  it("navTour sets data-tour on the nav", () => {
    const { container } = render(
      <SidebarShell chrome={false} navTour="sidebar-rail"><SideRow label="X" /></SidebarShell>,
    );
    expect(container.querySelector('nav[data-tour="sidebar-rail"]')).toBeTruthy();
  });

  it("aboveScroll renders its fixed content (outside the scroll area)", () => {
    render(
      <SidebarShell chrome={false} aboveScroll={<div>FIXED</div>}><SideRow label="X" /></SidebarShell>,
    );
    expect(screen.getByText("FIXED")).toBeTruthy();
  });

  it("scroll=false omits the scroll-subtle/overflow container (caller owns scrolling)", () => {
    const { container } = render(
      <SidebarShell chrome={false} scroll={false}><SideRow label="X" /></SidebarShell>,
    );
    // No internal scroller: the .scroll-subtle overflowY:auto div is gone so a
    // caller-supplied scroller (e.g. Fleet's <ReactLenis>) owns scrolling.
    expect(container.querySelector(".scroll-subtle")).toBeNull();
  });
});
