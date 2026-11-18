/**
 * Images in chat replies, in the agent's plan, in a project's markdown
 * preview and in an AI review load only after a click. A remote image shows
 * a "Load image from <host>" button instead, and once clicked it loads
 * without a Referer. No host is exempt here, unlike in a plugin's README.
 * A `data:` image loads where its renderer keeps it (chat replies), and an
 * `http:` image shows its alt text.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, createEvent } from "@testing-library/react";
import ReactMarkdown from "react-markdown";

const { gitMock } = vi.hoisted(() => ({
  gitMock: { reviewDiff: vi.fn() },
}));
vi.mock("@/lib/git-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/git-api")>("@/lib/git-api");
  return { ...actual, git: gitMock };
});
vi.mock("@/lib/git-log", () => ({ glog: () => {} }));

import { MessageContent } from "@/components/chat/message-content";
import { MarkdownPreview, planMdComponents } from "@/components/workspace/workspace-panel";
import { ReviewDialog } from "@/components/git/review-dialog";
import type { ChatMessage } from "@/types/chat";

const REMOTE = "https://evil.example/a.png?d=s";
const DATA = "data:image/png;base64,iVBORw0KGgo=";

const win = window as unknown as {
  electronAPI?: unknown;
  happyDOM?: {
    setURL(url: string): void;
    settings: { navigation: { disableFallbackToSetURL: boolean } };
  };
};
let openExternal: ReturnType<typeof vi.fn>;

beforeEach(() => {
  // The release app's page: the embedded backend's origin.
  win.happyDOM?.setURL("http://127.0.0.1:8765/");
  openExternal = vi.fn(() => Promise.resolve(true));
  win.electronAPI = { openExternal };
});
afterEach(() => {
  delete win.electronAPI;
});

/** An assistant reply holding `text`. */
function reply(text: string): ChatMessage {
  return { id: "m-1", role: "assistant", timestamp: "2026-11-18T00:00:00Z", content: [{ type: "text", text }] };
}

const images = () => Array.from(document.querySelectorAll("img"));
const loadButton = () => screen.getByRole("button", { name: /Load image/ });

/** `REMOTE` waits behind a button that names its host, and loads, with no
 *  referrer, only once that button is clicked. */
function expectRemoteImageAfterClick() {
  expect(images()).toHaveLength(0);
  expect(loadButton()).toHaveTextContent("evil.example");
  fireEvent.click(loadButton());
  const loaded = images();
  expect(loaded).toHaveLength(1);
  expect(loaded[0]).toHaveAttribute("src", REMOTE);
  expect(loaded[0]).toHaveAttribute("referrerpolicy", "no-referrer");
}

describe("an image in a chat reply", () => {
  it("loads from another host only after a click, with no referrer", () => {
    render(<MessageContent message={reply(`![x](${REMOTE})`)} />);
    expectRemoteImageAfterClick();
  });

  it("waits for a click even from a host a plugin's README loads from", () => {
    render(<MessageContent message={reply("![badge](https://img.shields.io/badge/a-b-green)")} />);
    expect(images()).toHaveLength(0);
    expect(loadButton()).toHaveTextContent("img.shields.io");
  });

  it("loads a data: image straight away", () => {
    render(<MessageContent message={reply(`![x](${DATA})`)} />);
    const loaded = images();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toHaveAttribute("src", DATA);
    expect(screen.queryByRole("button", { name: /Load image/ })).toBeNull();
  });

  it("shows the alt text for an http: image", () => {
    render(<MessageContent message={reply("![x](http://x.example/a.png)")} />);
    expect(images()).toHaveLength(0);
    expect(screen.getByText("x")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Load image/ })).toBeNull();
  });
});

describe("an image in workspace markdown", () => {
  it("in the agent's plan, loads only after a click", () => {
    render(<ReactMarkdown components={planMdComponents}>{`![x](${REMOTE})`}</ReactMarkdown>);
    expectRemoteImageAfterClick();
  });

  it("in the agent's plan, waits for a new click when a new plan puts another image in its place", () => {
    const { rerender } = render(<ReactMarkdown components={planMdComponents}>{`![x](${REMOTE})`}</ReactMarkdown>);
    fireEvent.click(loadButton());
    expect(images()).toHaveLength(1);
    rerender(<ReactMarkdown components={planMdComponents}>{"![x](https://other.example/b.png)"}</ReactMarkdown>);
    expect(images()).toHaveLength(0);
    expect(loadButton()).toHaveTextContent("other.example");
  });

  it("in a project's markdown preview, loads only after a click", () => {
    render(<MarkdownPreview source={`![x](${REMOTE})`} />);
    expectRemoteImageAfterClick();
  });

  it("in a project's markdown preview, stays loaded when the preview renders again", () => {
    const source = `![x](${REMOTE})`;
    const { rerender } = render(<MarkdownPreview source={source} />);
    fireEvent.click(loadButton());
    rerender(<MarkdownPreview source={source} />);
    expect(images()).toHaveLength(1);
  });

  it("inside a link, loads on a click without following the link", () => {
    render(<MarkdownPreview source={`[![build](${REMOTE})](https://example.com/ci)`} />);
    const button = loadButton();
    const click = createEvent.click(button);
    // happy-dom follows a link while the click bubbles past it, before the
    // app's handlers (at the root) have run, by setting the page's URL; a
    // browser decides once the click is over. Keep the page as it is, so
    // what the app's handlers do is all that happens.
    const navigation = win.happyDOM!.settings.navigation;
    navigation.disableFallbackToSetURL = true;
    try {
      fireEvent(button, click);
    } finally {
      navigation.disableFallbackToSetURL = false;
    }
    expect(click.defaultPrevented).toBe(true);
    expect(openExternal).not.toHaveBeenCalled();
    expect(images()).toHaveLength(1);
  });
});

describe("an image in an AI code review", () => {
  it("loads only after a click", async () => {
    gitMock.reviewDiff.mockResolvedValue({ ok: true, review: `![x](${REMOTE})`, cli: "claude" });
    render(<ReviewDialog folder="/repo" baseBranch="main" onClose={vi.fn()} />);
    await screen.findByRole("button", { name: /Load image/ });
    expectRemoteImageAfterClick();
  });
});
