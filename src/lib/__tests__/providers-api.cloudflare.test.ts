import { describe, it, expect, vi, beforeEach } from "vitest";
import { providers } from "@/lib/providers-api";

describe("providers.cloudflareVerify", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("posts the token + account id and returns the parsed verify result", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ valid: true }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const r = await providers.cloudflareVerify("tok-abc", "acc-1");
    expect(r.valid).toBe(true);
    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe("POST");
    // The account id can't be auto-discovered (Workers AI tokens can't list
    // accounts), so the user-supplied id rides along in the body.
    expect(JSON.parse(init.body as string)).toEqual({
      token: "tok-abc",
      account_id: "acc-1",
    });
  });

  it("returns valid:false on transport failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network")));
    const r = await providers.cloudflareVerify("tok", "acc");
    expect(r.valid).toBe(false);
  });

  it("returns valid:false with http error on a non-ok response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 403, json: async () => ({}) }),
    );
    const r = await providers.cloudflareVerify("bad-token", "acc");
    expect(r.valid).toBe(false);
    expect(r.error).toBe("http 403");
  });
});
