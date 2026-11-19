import { describe, it, expect, vi, afterEach } from "vitest";
import { linkTarget, openExternalUrl, openLink, scrollToFragment } from "@/lib/links";

/** The page a release build shows: the embedded backend's origin. */
const APP = "http://127.0.0.1:8765/";
/** The page a debug build shows: Vite on devUrl. */
const DEV = "http://localhost:3000/";

describe("linkTarget", () => {
  it("reads a fragment of the current page as the element to scroll to", () => {
    expect(linkTarget("#usage", APP)).toEqual({ kind: "anchor", id: "usage" });
    expect(linkTarget("#", APP)).toEqual({ kind: "anchor", id: "" });
    expect(linkTarget("http://127.0.0.1:8765/#usage", APP)).toEqual({ kind: "anchor", id: "usage" });
    expect(linkTarget("#caf%C3%A9", APP)).toEqual({ kind: "anchor", id: "café" });
    // A fragment that doesn't decode is kept as it is.
    expect(linkTarget("#100%", APP)).toEqual({ kind: "anchor", id: "100%" });
  });

  it("sends a link to another site to the system browser", () => {
    expect(linkTarget("https://example.com/docs?q=1", APP)).toEqual({
      kind: "external",
      url: "https://example.com/docs?q=1",
    });
    // A dev server is another site to the release app.
    expect(linkTarget("http://localhost:3000/", APP)).toEqual({
      kind: "external",
      url: "http://localhost:3000/",
    });
    // So is the same host on another port.
    expect(linkTarget("http://127.0.0.1:8899/", APP)).toEqual({
      kind: "external",
      url: "http://127.0.0.1:8899/",
    });
    expect(linkTarget("mailto:team@example.com", APP)).toEqual({
      kind: "external",
      url: "mailto:team@example.com",
    });
  });

  it("never follows a link to another page of the app's own origin", () => {
    // A relative link in a README resolves against the app's page.
    expect(linkTarget("docs/setup.md", APP)).toEqual({ kind: "blocked" });
    expect(linkTarget("/settings", APP)).toEqual({ kind: "blocked" });
    expect(linkTarget("http://localhost:3000/other", DEV)).toEqual({ kind: "blocked" });
  });

  it("hands no other scheme to the system", () => {
    for (const href of [
      "file:///etc/hosts",
      "javascript:alert(1)",
      "data:text/html,hi",
      "vscode://file/tmp/x",
      "tauri://localhost/",
      "http://[not a host",
      "",
      undefined,
      null,
    ]) {
      expect(linkTarget(href, APP), String(href)).toEqual({ kind: "blocked" });
    }
  });
});

describe("scrollToFragment", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("scrolls to the element and leaves the page's URL alone", () => {
    // The app reads its own hash (`#logos` swaps the app for a dev gallery):
    // a link must never set it.
    const heading = document.createElement("h2");
    heading.id = "logos";
    document.body.appendChild(heading);
    const scroll = vi.fn();
    heading.scrollIntoView = scroll;
    const before = window.location.href;
    scrollToFragment("logos");
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(window.location.href).toBe(before);
    expect(window.location.hash).toBe("");
  });

  it("does nothing when no element has that id", () => {
    expect(() => scrollToFragment("nowhere")).not.toThrow();
    expect(() => scrollToFragment("")).not.toThrow();
    expect(window.location.hash).toBe("");
  });
});

describe("openLink", () => {
  const win = window as unknown as { electronAPI?: unknown };
  afterEach(() => {
    delete win.electronAPI;
  });

  it("opens a web or mail link in the system browser, and nothing else", () => {
    const openExternal = vi.fn(() => Promise.resolve(true));
    win.electronAPI = { openExternal };
    openLink("https://example.com/source");
    openLink("mailto:team@example.com");
    for (const href of ["javascript:alert(1)", "file:///etc/hosts", "#usage", "/settings", "", undefined]) {
      openLink(href);
    }
    expect(openExternal.mock.calls).toEqual([["https://example.com/source"], ["mailto:team@example.com"]]);
  });
});

describe("openExternalUrl", () => {
  const win = window as unknown as { electronAPI?: unknown };
  afterEach(() => {
    delete win.electronAPI;
    vi.restoreAllMocks();
  });

  it("opens the URL through the app's bridge", () => {
    const openExternal = vi.fn(() => Promise.resolve(true));
    win.electronAPI = { openExternal };
    openExternalUrl("https://example.com/");
    expect(openExternal).toHaveBeenCalledWith("https://example.com/");
  });

  it("does nothing where there is no bridge (the renderer in a browser)", () => {
    // Tauri's webview refuses new windows, so the app never asks for one.
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    openExternalUrl("https://example.com/");
    openLink("https://example.com/");
    expect(open).not.toHaveBeenCalled();
  });
});
