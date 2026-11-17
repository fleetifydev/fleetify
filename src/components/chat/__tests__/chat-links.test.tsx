/**
 * Links in chat messages, and citation cards. A chat link to a web page used
 * to be a `target="_blank"` link, and Tauri's webview swallows those: it
 * opened nothing. Now it opens in the system browser, like every markdown
 * link the app shows. A link to a project file still opens the file in the
 * app, and a fragment never changes the app's URL.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, createEvent } from "@testing-library/react";
import { MarkdownBody } from "@/components/chat/message-content";
import { CitationCard } from "@/components/chat/citation-card";
import { useAppStore } from "@/stores/app-store";
import type { Session } from "@/types/session";

const MARKDOWN =
  "Read [the docs](https://example.com/docs), jump to [usage](#usage), " +
  "or open [main](src/main.rs:10).";

const win = window as unknown as {
  electronAPI?: unknown;
  happyDOM?: { setURL(url: string): void };
};
let openExternal: ReturnType<typeof vi.fn>;
let openFile: ReturnType<typeof vi.fn>;

beforeEach(() => {
  // The release app's page: the embedded backend's origin.
  win.happyDOM?.setURL("http://127.0.0.1:8765/");
  openExternal = vi.fn(() => Promise.resolve(true));
  win.electronAPI = { openExternal };
  openFile = vi.fn();
  useAppStore.setState({
    sessions: [{ id: "s1", project_path: "/repo" } as Session],
    activeSessionId: "s1",
    openFile,
  });
});
afterEach(() => {
  delete win.electronAPI;
});

/** Clicks the link named `name`, and says whether the webview would follow
 *  it itself: whether nothing in the app cancelled the click. */
function followedInPlace(name: string): boolean {
  const link = screen.getByRole("link", { name });
  const click = createEvent.click(link);
  // happy-dom follows an uncancelled link click with window.open; stub it so
  // the test environment never navigates.
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  try {
    fireEvent(link, click);
  } finally {
    open.mockRestore();
  }
  return !click.defaultPrevented;
}

describe("chat links", () => {
  it("open a web link in the system browser", () => {
    render(<MarkdownBody text={MARKDOWN} />);
    expect(followedInPlace("the docs")).toBe(false);
    expect(openExternal).toHaveBeenCalledWith("https://example.com/docs");
    expect(openFile).not.toHaveBeenCalled();
  });

  it("keep a fragment link in the app: no browser, no URL change", () => {
    render(<MarkdownBody text={MARKDOWN} />);
    const before = window.location.href;
    followedInPlace("usage");
    expect(window.location.href).toBe(before);
    expect(openExternal).not.toHaveBeenCalled();
    expect(openFile).not.toHaveBeenCalled();
  });

  it("still open a project file in the app", () => {
    render(<MarkdownBody text={MARKDOWN} />);
    expect(followedInPlace("main")).toBe(false);
    expect(openFile).toHaveBeenCalledWith("/repo/src/main.rs");
    expect(openExternal).not.toHaveBeenCalled();
  });
});

describe("citation cards", () => {
  it("open their source in the system browser", () => {
    render(
      <CitationCard
        block={{
          type: "citations",
          items: [{ url: "https://example.com/source", title: "The source", kind: "search_result" }],
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /The source/ }));
    expect(openExternal).toHaveBeenCalledWith("https://example.com/source");
  });

  it("open nothing for a source that isn't a web link", () => {
    render(
      <CitationCard
        block={{
          type: "citations",
          items: [{ url: "javascript:alert(1)", title: "A script", kind: "citation" }],
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /A script/ }));
    expect(openExternal).not.toHaveBeenCalled();
  });
});
