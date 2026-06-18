import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// react-markdown is ESM-heavy in jsdom; passthrough it so we assert OUR
// structure (version headers, category labels, fallback) and the bullet
// text content, not the library's internal rendering.
vi.mock("react-markdown", () => ({
  default: ({ children }: { children: string }) => children,
}));
vi.mock("remark-gfm", () => ({ default: () => {} }));

import { ChangelogBody } from "../ChangelogBody";

const SAMPLE = `# Changelog

All notable changes to this plugin are documented in this file.

## [0.2.0] - 2026-06-18

### Added
- Per-plugin auto-update toggle.

### Fixed
- Crash on empty manifest.

## [0.1.0] - 2026-06-17

### Added
- Initial release.
`;

describe("ChangelogBody", () => {
  it("renders a header + formatted date for each version", () => {
    render(<ChangelogBody changelog={SAMPLE} />);
    expect(screen.getByText("0.2.0")).toBeTruthy();
    expect(screen.getByText("0.1.0")).toBeTruthy();
    expect(screen.getByText("18 Jun 2026")).toBeTruthy();
    expect(screen.getByText("17 Jun 2026")).toBeTruthy();
  });

  it("renders category labels and bullet items", () => {
    render(<ChangelogBody changelog={SAMPLE} />);
    expect(screen.getAllByText("Added").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("Fixed")).toBeTruthy();
    expect(screen.getByText("Per-plugin auto-update toggle.")).toBeTruthy();
    expect(screen.getByText("Crash on empty manifest.")).toBeTruthy();
  });

  it("marks the installed version with a badge", () => {
    render(<ChangelogBody changelog={SAMPLE} installedVersion="0.1.0" />);
    expect(screen.getByText("Installed")).toBeTruthy();
  });

  it("shows no Installed badge when nothing matches", () => {
    render(<ChangelogBody changelog={SAMPLE} installedVersion="9.9.9" />);
    expect(screen.queryByText("Installed")).toBeNull();
  });

  it("falls back to raw markdown when the format is not recognized", () => {
    render(<ChangelogBody changelog="Some freeform notes without versions." />);
    expect(screen.getByText("Some freeform notes without versions.")).toBeTruthy();
    // no version pill rendered
    expect(screen.queryByText("0.2.0")).toBeNull();
  });

  it("shows an empty state when there is no changelog", () => {
    render(<ChangelogBody changelog={null} />);
    expect(screen.getByText("No changelog published.")).toBeTruthy();
  });
});
