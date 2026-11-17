/**
 * Links in rendered markdown never navigate the app's window. A page from
 * another site would replace the app: there is no back button, and since the
 * app's commands answer only its own origin, the page could do nothing but
 * strand the user. A link to another site opens in the system browser; a
 * link to another page of the app's origin does nothing; a fragment
 * (`#usage`) still scrolls in place.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, createEvent } from "@testing-library/react";
import ReactMarkdown from "react-markdown";

const { gitMock } = vi.hoisted(() => ({
  gitMock: { reviewDiff: vi.fn(), diagnoseFailure: vi.fn() },
}));
vi.mock("@/lib/git-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/git-api")>("@/lib/git-api");
  return { ...actual, git: gitMock };
});
vi.mock("@/lib/git-log", () => ({ glog: () => {} }));

import { MarkdownPreview, planMdComponents } from "@/components/workspace/workspace-panel";
import { ReviewDialog } from "@/components/git/review-dialog";
import { RecoveryDialog } from "@/components/git/recovery-dialog";
import { markdownComponents } from "@/components/marketplace/detail/markdown-image";

/** Markdown with one link of each kind. */
const MARKDOWN =
  "Read [the docs](https://example.com/docs), open [the dev server](http://localhost:3000/), " +
  "see [setup](docs/setup.md), or jump to [usage](#usage).";

const win = window as unknown as {
  electronAPI?: unknown;
  happyDOM?: { setURL(url: string): void };
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

/** Clicks the link named `name`, and says whether the webview would follow
 *  it in place: whether nothing in the app cancelled the click. */
function followedInPlace(name: string): boolean {
  const link = screen.getByRole("link", { name });
  const click = createEvent.click(link);
  // happy-dom follows an uncancelled link click with window.open(href,
  // "_self"); stub it so the test environment never navigates.
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  try {
    fireEvent(link, click);
  } finally {
    open.mockRestore();
  }
  return !click.defaultPrevented;
}

function expectLinksToStayInTheApp() {
  expect(followedInPlace("the docs")).toBe(false);
  expect(openExternal).toHaveBeenLastCalledWith("https://example.com/docs");
  expect(followedInPlace("the dev server")).toBe(false);
  expect(openExternal).toHaveBeenLastCalledWith("http://localhost:3000/");
  // Another page of the app's own origin: nothing happens.
  expect(followedInPlace("setup")).toBe(false);
  // A fragment of the page scrolls in place.
  expect(followedInPlace("usage")).toBe(true);
  expect(openExternal).toHaveBeenCalledTimes(2);
}

describe("markdown links never navigate the app's window", () => {
  it("in a project's markdown preview", () => {
    render(<MarkdownPreview source={MARKDOWN} />);
    expectLinksToStayInTheApp();
  });

  it("in the agent's plan", () => {
    render(<ReactMarkdown components={planMdComponents}>{MARKDOWN}</ReactMarkdown>);
    expectLinksToStayInTheApp();
  });

  it("in the AI code review", async () => {
    gitMock.reviewDiff.mockResolvedValue({ ok: true, review: MARKDOWN, cli: "claude" });
    render(<ReviewDialog folder="/repo" baseBranch="main" onClose={vi.fn()} />);
    await screen.findByRole("link", { name: "the docs" });
    expectLinksToStayInTheApp();
  });

  it("in the AI failure diagnosis", async () => {
    gitMock.diagnoseFailure.mockResolvedValue({
      ok: true,
      summary: MARKDOWN,
      action: "manual",
      rationale: "",
      command: null,
      risk: "low",
      cli: "claude",
    });
    render(
      <RecoveryDialog
        folder="/repo"
        baseBranch="main"
        errorMessage="push rejected"
        context="Create PR"
        onClose={vi.fn()}
        onRetry={vi.fn()}
      />,
    );
    await screen.findByRole("link", { name: "the docs" });
    expectLinksToStayInTheApp();
  });

  it("in a plugin's README and changelog", () => {
    render(<ReactMarkdown components={markdownComponents}>{MARKDOWN}</ReactMarkdown>);
    expectLinksToStayInTheApp();
  });
});
