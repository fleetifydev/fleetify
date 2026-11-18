/**
 * Every renderer request to the backend carries the per-run API token, so
 * none may go out through a bare `fetch` or open a socket or stream without
 * the token in its URL. This scans the renderer's own sources:
 *   - no `fetch(` whose first argument is a backend path (`/api…`,
 *     `${API_BASE}…`, `/events…`): those go through `apiFetch` (JWT routes)
 *     or `backendFetch`;
 *   - every file that opens a `WebSocket` or `EventSource` also calls
 *     `withApiTokenQuery`.
 * Tests are skipped, and so are `api.ts` and `api-token.ts`, which define the
 * helpers; `api.ts`'s socket builders are covered by api-token.test.ts.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = resolve(__dirname, "../..");
const HELPERS = new Set(["lib/api.ts", "lib/api-token.ts"]);

/** A bare `fetch(` (also `window.fetch(`) whose first argument is a backend path. */
const RAW_BACKEND_FETCH = /(?<![\w$])fetch\(\s*(?:["'`]\/(?:api|events)|`\$\{API_BASE\})/g;
const OPENS_SOCKET_OR_STREAM = /\bnew\s+(?:WebSocket|EventSource)\s*\(/;

/** The renderer sources this guard covers, as `src/`-relative paths. */
function sources(): { file: string; text: string }[] {
  return readdirSync(SRC, { recursive: true, encoding: "utf8" })
    .map((file) => file.split(sep).join("/"))
    .filter((file) => /\.tsx?$/.test(file))
    .filter((file) => !file.split("/").includes("__tests__") && !/\.test\.tsx?$/.test(file))
    .filter((file) => !HELPERS.has(file))
    .map((file) => ({ file, text: readFileSync(join(SRC, file), "utf8") }));
}

/** `file:line` for each bare backend fetch in `text`. */
function rawFetches(file: string, text: string): string[] {
  return [...text.matchAll(RAW_BACKEND_FETCH)].map(
    (m) => `${file}:${text.slice(0, m.index).split("\n").length}`,
  );
}

describe("backend requests carry the API token", () => {
  it("the fetch pattern catches bare backend fetches and nothing else", () => {
    const caught = [
      'fetch("/api/fs/dir")',
      "fetch('/api/groups')",
      "fetch(`/api/sessions/${id}`, { method: \"PATCH\" })",
      "fetch(`${API_BASE}/groups`)",
      'fetch("/events/status")',
      'await window.fetch("/api/x")',
      'fetch(\n  "/api/fs/file",\n  { method: "PUT" })',
    ];
    const ignored = [
      'apiFetch("/api/sessions")',
      'backendFetch("/api/fs/dir")',
      'fetch("https://example.com/api/x")',
      "fetch(url)",
      "const fetch = useCallback(() => {}, []); fetch();",
    ];
    for (const text of caught) expect(rawFetches("x.ts", text), text).toHaveLength(1);
    for (const text of ignored) expect(rawFetches("x.ts", text), text).toEqual([]);
  });

  it("scans the renderer's sources", () => {
    const files = sources().map((s) => s.file);
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain("components/workspace/workspace-panel.tsx");
    expect(files).not.toContain("lib/api.ts");
  });

  it("no source fetches a backend path without apiFetch or backendFetch", () => {
    const offenders = sources().flatMap(({ file, text }) => rawFetches(file, text));
    expect(offenders).toEqual([]);
  });

  it("every file that opens a WebSocket or EventSource adds the token to its URL", () => {
    const offenders = sources()
      .filter(({ text }) => OPENS_SOCKET_OR_STREAM.test(text) && !text.includes("withApiTokenQuery("))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });
});
