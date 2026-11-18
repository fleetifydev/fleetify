/**
 * The Preview pane's manual pin. happy-dom doesn't load the framed page:
 * the test must not reach whatever listens on the pinned port.
 *
 * @vitest-environment-options {"settings":{"disableIframePageLoading":true}}
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("@/components/workspace/use-active-cwd", () => ({
  useActiveCwd: () => "/proj",
}));

import { PreviewView } from "../preview-view";
import { useDevServerStore } from "@/stores/dev-server-store";

const REFUSED = "Preview shows local dev servers only (localhost or 127.0.0.1).";

/** Type `address` into the manual pin and submit it. */
function pin(address: string) {
  const input = screen.getByLabelText("Preview address");
  fireEvent.change(input, { target: { value: address } });
  const form = input.closest("form");
  if (!form) throw new Error("the address input is not in a form");
  fireEvent.submit(form);
}

describe("PreviewView manual pin", () => {
  beforeEach(() => useDevServerStore.setState({ byCwd: {} }, true));

  it.each(["https://example.com", "192.168.1.2:3000", "http://[::1]:3000"])(
    "refuses %s and says why",
    (address) => {
      render(<PreviewView />);
      pin(address);

      expect(screen.getByRole("alert")).toHaveTextContent(REFUSED);
      expect(document.querySelector("iframe")).toBeNull();
      expect(useDevServerStore.getState().byCwd["/proj"]?.manual ?? null).toBeNull();
    },
  );

  it("frames a local dev server", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<PreviewView />);
    pin("localhost:5173");

    expect(document.querySelector("iframe")?.getAttribute("src")).toBe("http://localhost:5173");
    expect(screen.queryByRole("alert")).toBeNull();
    // happy-dom says it didn't load the framed page, and nothing else.
    for (const [error] of errors.mock.calls) {
      expect(String(error)).toMatch(/Iframe page loading is disabled/);
    }
    errors.mockRestore();
  });

  it("drops the message once the address is edited", () => {
    render(<PreviewView />);
    pin("https://example.com");
    expect(screen.getByRole("alert")).toHaveTextContent(REFUSED);

    fireEvent.change(screen.getByLabelText("Preview address"), {
      target: { value: "127.0.0.1:3000" },
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
