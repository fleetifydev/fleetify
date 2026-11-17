import { it, expect, vi } from "vitest";

// message_error goes to product analytics. An error's message can carry
// paths, URLs or tokens, so the event keeps only what kind of error it was.

const analytics = vi.hoisted(() => ({ capture: vi.fn() }));
vi.mock("@/lib/posthog", () => analytics);

import { wsManager } from "@/services/ws-manager";

it("message_error sends the error's class, never its message", async () => {
  const manager = wsManager as unknown as { ensureConnected: (sid: string) => Promise<unknown> };
  vi.spyOn(manager, "ensureConnected").mockRejectedValue(
    new TypeError("connect failed: /home/u/.fleetify/run.sock token=sk-test-123"),
  );

  await expect(wsManager.send("sess-1234abcd-ef", "hello")).rejects.toThrow(TypeError);

  await vi.waitFor(() =>
    expect(analytics.capture).toHaveBeenCalledWith("message_error", expect.anything()),
  );
  const [, props] = analytics.capture.mock.calls.find(([name]) => name === "message_error")!;
  expect(props).toEqual({ session_id_short: "sess-123", error_type: "TypeError" });
});
