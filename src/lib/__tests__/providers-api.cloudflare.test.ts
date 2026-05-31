import { describe, it, expect, vi, beforeEach } from "vitest";
import { providers } from "@/lib/providers-api";

describe("providers.cloudflareVerify", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("posts the token and returns the parsed verify result", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ valid: true, accounts: [{ id: "acc_1", name: "Acme" }] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const r = await providers.cloudflareVerify("tok-abc");
    expect(r.valid).toBe(true);
    expect(r.accounts).toEqual([{ id: "acc_1", name: "Acme" }]);
    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ token: "tok-abc" });
  });

  it("returns valid:false on transport failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network")));
    const r = await providers.cloudflareVerify("tok");
    expect(r.valid).toBe(false);
  });

  it("returns valid:false with http error on a non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 403, json: async () => ({}) }));
    const r = await providers.cloudflareVerify("bad-token");
    expect(r.valid).toBe(false);
    expect(r.error).toBe("http 403");
  });
});
