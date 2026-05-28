import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { AuthRequiredCard } from "../auth-required-card";

describe("AuthRequiredCard", () => {
  it("renders the headline + URL when opened_in_browser is true", () => {
    render(
      <AuthRequiredCard
        block={{
          type: "auth_required",
          provider: "antigravity",
          url: "https://accounts.google.com/o/oauth2/auth?x=1",
          opened_in_browser: true,
        }}
      />,
    );
    expect(screen.getByText(/Antigravity sign-in required/i)).toBeInTheDocument();
    // Re-open link with the URL still reachable
    const link = screen.getByRole("link", { name: /Re-open sign-in/i });
    expect(link.getAttribute("href")).toBe("https://accounts.google.com/o/oauth2/auth?x=1");
  });

  it("renders the primary 'Open sign-in' link when opened_in_browser is false", () => {
    render(
      <AuthRequiredCard
        block={{
          type: "auth_required",
          provider: "antigravity",
          url: "https://accounts.google.com/o/oauth2/auth?x=2",
          opened_in_browser: false,
        }}
      />,
    );
    const link = screen.getByRole("link", { name: /^Open sign-in/i });
    expect(link.getAttribute("href")).toBe("https://accounts.google.com/o/oauth2/auth?x=2");
  });

  it("mentions that codes can't be pasted", () => {
    render(
      <AuthRequiredCard
        block={{
          type: "auth_required",
          provider: "antigravity",
          url: "https://accounts.google.com/o/oauth2/auth?x=3",
          opened_in_browser: true,
        }}
      />,
    );
    expect(screen.getByText(/codes can.?t be pasted/i)).toBeInTheDocument();
  });

  it("falls back to '<provider> sign-in required' for non-antigravity providers", () => {
    render(
      <AuthRequiredCard
        block={{
          type: "auth_required",
          provider: "other-future-provider",
          url: "https://example.com/auth",
          opened_in_browser: false,
        }}
      />,
    );
    expect(screen.getByText(/other-future-provider sign-in required/i)).toBeInTheDocument();
  });
});
