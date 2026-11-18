/**
 * The file tree's actions against the backend's file API
 * (crates/fleetify-backend/src/routers/workspace.rs): create sends
 * `{ path, is_dir }`, delete sends `DELETE` with `{ path }` as its JSON body,
 * rename sends `{ from, to }`. Each answers `{ ok, error? }`, and the actions
 * report success from that `ok`, not from the HTTP status.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiCreate, apiDelete, apiRename } from "@/components/workspace/workspace-panel";

/** A stubbed fetch that answers every request with `body` as JSON. */
function answering(body: unknown, status = 200) {
  return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
}

/** What the `n`-th request sent. */
function sent(fetchMock: ReturnType<typeof answering>, n = 0) {
  const [input, init] = fetchMock.mock.calls[n] ?? [];
  return {
    url: String(input),
    method: init?.method,
    contentType: new Headers(init?.headers).get("Content-Type"),
    body: JSON.parse(String(init?.body)) as unknown,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("workspace file actions", () => {
  it("create sends the path and whether it is a folder", async () => {
    const fetchMock = answering({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    await expect(apiCreate("/repo/src", "folder")).resolves.toBe(true);
    await expect(apiCreate("/repo/a.ts", "file")).resolves.toBe(true);

    expect(sent(fetchMock, 0)).toEqual({
      url: "/api/fs/create",
      method: "POST",
      contentType: "application/json",
      body: { path: "/repo/src", is_dir: true },
    });
    expect(sent(fetchMock, 1).body).toEqual({ path: "/repo/a.ts", is_dir: false });
  });

  it("delete sends DELETE with the path as its JSON body", async () => {
    const fetchMock = answering({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    await expect(apiDelete("/repo/a.ts")).resolves.toBe(true);

    expect(sent(fetchMock)).toEqual({
      url: "/api/fs/delete",
      method: "DELETE",
      contentType: "application/json",
      body: { path: "/repo/a.ts" },
    });
  });

  it("rename sends from and to, the new name in the same folder", async () => {
    const fetchMock = answering({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    await expect(apiRename("/repo/src/old.ts", "new.ts")).resolves.toEqual({
      ok: true,
      path: "/repo/src/new.ts",
    });

    expect(sent(fetchMock)).toEqual({
      url: "/api/fs/rename",
      method: "POST",
      contentType: "application/json",
      body: { from: "/repo/src/old.ts", to: "/repo/src/new.ts" },
    });
  });

  it("rename keeps a Windows path's separator", async () => {
    const fetchMock = answering({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    await expect(apiRename("C:\\x\\old.txt", "new.txt")).resolves.toEqual({
      ok: true,
      path: "C:\\x\\new.txt",
    });
    expect(sent(fetchMock).body).toEqual({ from: "C:\\x\\old.txt", to: "C:\\x\\new.txt" });
  });

  it("rename refuses a name with a separator, or . or .., without a request", async () => {
    const fetchMock = answering({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    for (const name of ["a/b", "a\\b", ".", "..", ""]) {
      await expect(apiRename("/repo/old.ts", name), JSON.stringify(name)).resolves.toEqual({ ok: false });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("each reports success from the reply's ok, not from the HTTP status", async () => {
    vi.stubGlobal("fetch", answering({ ok: false, error: "permission denied" }));

    await expect(apiCreate("/repo/x", "file")).resolves.toBe(false);
    await expect(apiDelete("/repo/x")).resolves.toBe(false);
    await expect(apiRename("/repo/x", "y")).resolves.toMatchObject({ ok: false });

    // A reply that isn't the JSON envelope (here the access guard's 403).
    vi.stubGlobal("fetch", vi.fn(async () => new Response("forbidden", { status: 403 })));

    await expect(apiCreate("/repo/x", "file")).resolves.toBe(false);
    await expect(apiDelete("/repo/x")).resolves.toBe(false);
    await expect(apiRename("/repo/x", "y")).resolves.toMatchObject({ ok: false });
  });
});
