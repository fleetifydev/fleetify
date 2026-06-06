import { describe, it, expect, vi, beforeEach } from "vitest";
import { apiFetch } from "@/lib/api";
import { studioApi } from "../studio-api";

vi.mock("@/lib/api", () => ({ apiFetch: vi.fn() }));
const mockFetch = apiFetch as unknown as ReturnType<typeof vi.fn>;
const res = (body: unknown, ok = true) => ({ ok, json: async () => body }) as Response;

beforeEach(() => mockFetch.mockReset());

describe("studioApi", () => {
  it("getTools hits /api/studio/tools", async () => {
    mockFetch.mockResolvedValue(res([{ id: "higgsfield", display_name: "Higgsfield", install_hint: "x", installed: true, authenticated: true }]));
    const t = await studioApi.getTools();
    expect(mockFetch).toHaveBeenCalledWith("/api/studio/tools");
    expect(t[0].id).toBe("higgsfield");
  });
  it("listModels passes the type query (and omits it when absent)", async () => {
    mockFetch.mockResolvedValue(res([]));
    await studioApi.listModels("image");
    expect(mockFetch).toHaveBeenCalledWith("/api/studio/higgsfield/models?type=image");
    await studioApi.listModels();
    expect(mockFetch).toHaveBeenCalledWith("/api/studio/higgsfield/models");
  });
  it("getModel hits /models/{id}", async () => {
    mockFetch.mockResolvedValue(res({ display_name: "x", job_set_type: "nano_banana_2", type: "image", params: [] }));
    const d = await studioApi.getModel("nano_banana_2");
    expect(mockFetch).toHaveBeenCalledWith("/api/studio/higgsfield/models/nano_banana_2");
    expect(d.job_set_type).toBe("nano_banana_2");
  });
  it("getAccount hits /account", async () => {
    mockFetch.mockResolvedValue(res({ email: "a@b.com", credits: 3, subscription_plan_type: "free" }));
    const a = await studioApi.getAccount();
    expect(mockFetch).toHaveBeenCalledWith("/api/studio/higgsfield/account");
    expect(a.credits).toBe(3);
  });
  it("throws on non-ok", async () => {
    mockFetch.mockResolvedValue(res(null, false));
    await expect(studioApi.getTools()).rejects.toThrow();
  });
  it("cost POSTs to /api/studio/higgsfield/cost with {model, params}", async () => {
    mockFetch.mockResolvedValue(res({ credits: 5, credits_exact: 4.8 }));
    const result = await studioApi.cost("nano_banana_2", { prompt: "a cat" });
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/studio/higgsfield/cost",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ model: "nano_banana_2", params: { prompt: "a cat" } }),
      }),
    );
    expect(result.credits).toBe(5);
  });
  it("generate POSTs to /api/studio/higgsfield/generate with {session_id, model, params}", async () => {
    mockFetch.mockResolvedValue(res({ id: "j1", status: "completed", result_url: "x.png", job_set_type: "nano_banana_2" }));
    const result = await studioApi.generate("s1", "nano_banana_2", { prompt: "a dog" });
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/studio/higgsfield/generate",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ session_id: "s1", model: "nano_banana_2", params: { prompt: "a dog" } }),
      }),
    );
    expect(result.id).toBe("j1");
  });
  it("listMessages GETs /api/sessions/{id}/messages", async () => {
    mockFetch.mockResolvedValue(res([{ role: "user", content: "[]" }]));
    const msgs = await studioApi.listMessages("sess-abc");
    expect(mockFetch).toHaveBeenCalledWith("/api/sessions/sess-abc/messages");
    expect(msgs[0].role).toBe("user");
  });
});
