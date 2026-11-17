import { describe, it, expect, vi, afterEach } from "vitest";
import { linkTarget, openExternalUrl } from "@/lib/links";

/** The page a release build shows: the embedded backend's origin. */
const APP = "http://127.0.0.1:8765/";
/** The page a debug build shows: Vite on devUrl. */
const DEV = "http://localhost:3000/";

describe("linkTarget", () => {
  it("leaves a fragment of the current page to the webview", () => {
    expect(linkTarget("#usage", APP)).toEqual({ kind: "anchor" });
    expect(linkTarget("#", APP)).toEqual({ kind: "anchor" });
    expect(linkTarget("http://127.0.0.1:8765/#usage", APP)).toEqual({ kind: "anchor" });
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

  it("opens a new tab where there is no bridge (the renderer in a browser)", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    openExternalUrl("https://example.com/");
    expect(open).toHaveBeenCalledWith("https://example.com/", "_blank", "noopener,noreferrer");
  });
});
