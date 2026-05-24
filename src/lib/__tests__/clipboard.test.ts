import { describe, it, expect, vi, beforeEach } from "vitest";
import { copyText } from "../clipboard";

describe("copyText", () => {
  const realClipboard = globalThis.navigator?.clipboard;
  beforeEach(() => {
    vi.restoreAllMocks();
    // Reset window.electronAPI between tests.
    (window as unknown as { electronAPI?: unknown }).electronAPI = undefined;
    if (realClipboard) {
      Object.defineProperty(globalThis.navigator, "clipboard", {
        value: undefined, configurable: true, writable: true,
      });
    }
    // happy-dom doesn't expose document.execCommand by default — define
    // a no-op stub so the per-test vi.spyOn calls have something to
    // attach to. The execCommand-fallback path in copyText only fires
    // when the prior two paths fail, so this stub is shadowed in the
    // happy-path tests by them returning early.
    if (typeof document.execCommand !== "function") {
      Object.defineProperty(document, "execCommand", {
        value: () => false, configurable: true, writable: true,
      });
    }
  });

  it("uses the Tauri IPC bridge when available", async () => {
    const writeText = vi.fn(async (_t: string) => true);
    (window as unknown as { electronAPI: { writeText: typeof writeText } }).electronAPI = { writeText };
    const ok = await copyText("hello");
    expect(ok).toBe(true);
    expect(writeText).toHaveBeenCalledWith("hello");
  });

  it("falls back to navigator.clipboard when IPC is unavailable", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(globalThis.navigator, "clipboard", {
      value: { writeText }, configurable: true, writable: true,
    });
    const ok = await copyText("hello");
    expect(ok).toBe(true);
    expect(writeText).toHaveBeenCalledWith("hello");
  });

  it("falls back to execCommand when clipboard API throws", async () => {
    Object.defineProperty(globalThis.navigator, "clipboard", {
      value: { writeText: vi.fn(async () => { throw new Error("denied"); }) },
      configurable: true, writable: true,
    });
    const execSpy = vi.spyOn(document, "execCommand").mockReturnValue(true);
    const ok = await copyText("hello");
    expect(ok).toBe(true);
    expect(execSpy).toHaveBeenCalledWith("copy");
  });

  it("returns false when every path fails", async () => {
    Object.defineProperty(globalThis.navigator, "clipboard", {
      value: { writeText: vi.fn(async () => { throw new Error("denied"); }) },
      configurable: true, writable: true,
    });
    vi.spyOn(document, "execCommand").mockReturnValue(false);
    const ok = await copyText("hello");
    expect(ok).toBe(false);
  });
});
