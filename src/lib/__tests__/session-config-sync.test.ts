import { describe, it, expect } from "vitest";
import { registerConfigPatch, awaitConfigPatch } from "../session-config-sync";

describe("session-config-sync", () => {
  it("resolves immediately when nothing is pending", async () => {
    await expect(awaitConfigPatch("none")).resolves.toBeUndefined();
  });

  it("waits for a registered patch to settle before resolving", async () => {
    let resolvePatch!: () => void;
    const patch = new Promise<void>((r) => {
      resolvePatch = r;
    });
    registerConfigPatch("s1", patch);

    let settled = false;
    const waiter = awaitConfigPatch("s1").then(() => {
      settled = true;
    });
    // Still in flight — the send must NOT proceed yet.
    await Promise.resolve();
    expect(settled).toBe(false);

    resolvePatch();
    await waiter;
    expect(settled).toBe(true);
  });

  it("resolves even if the patch rejects (error handling is the caller's job)", async () => {
    registerConfigPatch("s2", Promise.reject(new Error("network")));
    await expect(awaitConfigPatch("s2")).resolves.toBeUndefined();
  });

  it("a later await after the patch settles resolves (no stale pending)", async () => {
    let resolvePatch!: () => void;
    registerConfigPatch(
      "s3",
      new Promise<void>((r) => {
        resolvePatch = r;
      }),
    );
    resolvePatch();
    await awaitConfigPatch("s3");
    // Settled — a subsequent await must resolve, not hang on a stale entry.
    await expect(awaitConfigPatch("s3")).resolves.toBeUndefined();
  });

  it("the newest patch wins when a session is patched twice", async () => {
    let resolveSecond!: () => void;
    registerConfigPatch("s4", Promise.resolve());
    registerConfigPatch(
      "s4",
      new Promise<void>((r) => {
        resolveSecond = r;
      }),
    );
    let settled = false;
    const waiter = awaitConfigPatch("s4").then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false); // waits for the SECOND (latest) patch
    resolveSecond();
    await waiter;
    expect(settled).toBe(true);
  });
});
