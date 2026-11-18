/**
 * The backend's per-run API token on the renderer side: it is asked of the
 * shell once (`window.fleetify.getApiToken`), then rides on every backend
 * request — the `X-Fleetify-Token` header on fetches, the `api_token` query
 * parameter on WebSocket URLs, which can't carry a header.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  API_TOKEN_HEADER,
  API_TOKEN_QUERY,
  apiToken,
  resetApiTokenForTests,
  withApiToken,
  withApiTokenQuery,
} from "@/lib/api-token";
import { apiFetch, backendFetch, createSessionsWebSocket } from "@/lib/api";

type Bridge = NonNullable<Window["fleetify"]>;

/** Install a `window.fleetify` with only the calls a test needs. */
function bridge(calls: Partial<Bridge>): void {
  (window as { fleetify?: Partial<Bridge> }).fleetify = calls;
}

/** A stubbed fetch that answers every request with `status`. */
function fetchAnswering(status: number) {
  return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    new Response(status === 200 ? "{}" : "", { status }));
}

/** The headers of the `n`-th call to a stubbed fetch. */
function headersOf(fetchMock: ReturnType<typeof fetchAnswering>, n = 0): Headers {
  return new Headers(fetchMock.mock.calls[n]?.[1]?.headers);
}

beforeEach(() => {
  resetApiTokenForTests();
  delete (window as { fleetify?: unknown }).fleetify;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete (window as { fleetify?: unknown }).fleetify;
});

describe("apiToken", () => {
  it("asks the shell once, however many callers wait for it", async () => {
    const getApiToken = vi.fn(async () => "run-token");
    bridge({ getApiToken });

    const tokens = await Promise.all([apiToken(), apiToken(), apiToken()]);

    expect(tokens).toEqual(["run-token", "run-token", "run-token"]);
    expect(getApiToken).toHaveBeenCalledTimes(1);
    await apiToken();
    expect(getApiToken).toHaveBeenCalledTimes(1);
  });

  it("is null without the Tauri bridge", async () => {
    await expect(apiToken()).resolves.toBeNull();
  });

  it("asks again after a failed ask instead of keeping the failure", async () => {
    const getApiToken = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("ipc down"))
      .mockResolvedValueOnce("run-token");
    bridge({ getApiToken });

    await expect(apiToken()).resolves.toBeNull();
    await expect(apiToken()).resolves.toBe("run-token");
    expect(getApiToken).toHaveBeenCalledTimes(2);
  });
});

describe("withApiToken", () => {
  it("adds the token header and keeps the headers already there", async () => {
    bridge({ getApiToken: async () => "run-token" });

    const init = await withApiToken({ method: "POST", headers: { A: "1" } });
    const headers = new Headers(init.headers);

    expect(init.method).toBe("POST");
    expect(headers.get("A")).toBe("1");
    expect(headers.get(API_TOKEN_HEADER)).toBe("run-token");
  });

  it("adds nothing without the Tauri bridge", async () => {
    const init = await withApiToken({ headers: { A: "1" } });
    const headers = new Headers(init.headers);

    expect(headers.get("A")).toBe("1");
    expect(headers.has(API_TOKEN_HEADER)).toBe(false);
  });
});

describe("withApiTokenQuery", () => {
  it("appends the token with ? or &, URL-encoded", async () => {
    bridge({ getApiToken: async () => "a b/c+d&e" });
    const encoded = "a%20b%2Fc%2Bd%26e";

    await expect(withApiTokenQuery("/ws/x")).resolves.toBe(`/ws/x?${API_TOKEN_QUERY}=${encoded}`);
    await expect(withApiTokenQuery("/ws/x?token=j")).resolves.toBe(
      `/ws/x?token=j&${API_TOKEN_QUERY}=${encoded}`,
    );
  });

  it("leaves the URL alone without the Tauri bridge", async () => {
    await expect(withApiTokenQuery("/ws/x?token=j")).resolves.toBe("/ws/x?token=j");
  });
});

describe("the backend requests in api.ts", () => {
  it("apiFetch sends both the access token and the API token", async () => {
    bridge({
      getApiToken: async () => "run-token",
      getAccessToken: async () => ({ token: "jwt", expiresAt: 0 }),
    });
    const fetchMock = fetchAnswering(200);
    vi.stubGlobal("fetch", fetchMock);

    await apiFetch("/api/sessions", { headers: { "Content-Type": "application/json" } });

    const headers = headersOf(fetchMock);
    expect(headers.get("Authorization")).toBe("Bearer jwt");
    expect(headers.get(API_TOKEN_HEADER)).toBe("run-token");
    expect(headers.get("Content-Type")).toBe("application/json");
  });

  it("backendFetch sends only the API token, and a 401 doesn't sign out", async () => {
    const signOut = vi.fn(async () => ({ ok: true }));
    const getAccessToken = vi.fn(async () => ({ token: "jwt", expiresAt: 0 }));
    bridge({ getApiToken: async () => "run-token", getAccessToken, signOut });
    const fetchMock = fetchAnswering(401);
    vi.stubGlobal("fetch", fetchMock);

    const res = await backendFetch("/api/fs/dir?path=%2Ftmp");

    expect(res.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/fs/dir?path=%2Ftmp");
    const headers = headersOf(fetchMock);
    expect(headers.get(API_TOKEN_HEADER)).toBe("run-token");
    expect(headers.has("Authorization")).toBe(false);
    expect(getAccessToken).not.toHaveBeenCalled();
    expect(signOut).not.toHaveBeenCalled();
  });

  it("the sessions socket URL carries the access token and the API token", async () => {
    bridge({
      getApiToken: async () => "run-token",
      getAccessToken: async () => ({ token: "jwt", expiresAt: 0 }),
    });
    const urls: string[] = [];
    vi.stubGlobal(
      "WebSocket",
      class {
        constructor(url: string) {
          urls.push(url);
        }
      },
    );

    await createSessionsWebSocket();

    expect(urls).toHaveLength(1);
    const url = urls[0] ?? "";
    expect(url).toContain("/ws/sessions?");
    const query = new URLSearchParams(url.slice(url.indexOf("?") + 1));
    expect(query.get("token")).toBe("jwt");
    expect(query.get(API_TOKEN_QUERY)).toBe("run-token");
  });
});
