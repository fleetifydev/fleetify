import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

// frontend_error goes to PostHog. An error's message and stack can carry
// file paths, message text or tokens, so the event keeps only what kind of
// error it was. The local log keeps the details.

const analytics = vi.hoisted(() => ({
  capture: vi.fn(),
  isReady: vi.fn(() => true),
}));
vi.mock("@/lib/posthog", () => analytics);

import { installGlobalErrorCapture } from "../log";

beforeAll(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  installGlobalErrorCapture();
});

beforeEach(() => {
  analytics.capture.mockClear();
});

/** Wait until the lazy analytics import has delivered `count` events. */
async function captured(count: number) {
  await vi.waitFor(() => expect(analytics.capture).toHaveBeenCalledTimes(count));
  return analytics.capture.mock.calls;
}

function rejectUnhandled(reason: unknown) {
  const event = new Event("unhandledrejection");
  Object.defineProperty(event, "reason", { value: reason });
  window.dispatchEvent(event);
}

describe("frontend_error", () => {
  it("sends an uncaught error's class, never its message, file or stack", async () => {
    const error = new TypeError("could not read /home/u/notes/secret.md");
    window.dispatchEvent(
      new ErrorEvent("error", {
        error,
        message: error.message,
        filename: "tauri://localhost/assets/index.js",
        lineno: 3,
        colno: 7,
      }),
    );
    expect(await captured(1)).toEqual([
      ["frontend_error", { source: "uncaught", error_type: "TypeError" }],
    ]);
  });

  it("sends a rejection's class, or its JS type when it isn't an Error", async () => {
    // One at a time: when several lazy imports of a mocked module are in
    // flight at once, only the first gets vitest's mock.
    rejectUnhandled(new RangeError("token sk-test-123 was rejected"));
    await captured(1);
    rejectUnhandled("prompt: refactor the auth module");
    await captured(2);
    rejectUnhandled(undefined);
    expect(await captured(3)).toEqual([
      ["frontend_error", { source: "unhandled-rejection", error_type: "RangeError" }],
      ["frontend_error", { source: "unhandled-rejection", error_type: "string" }],
      ["frontend_error", { source: "unhandled-rejection", error_type: "unknown" }],
    ]);
  });
});
