import { describe, it, expect, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { pinSession, pinnedSessionIds, usePinnedSession, usePinnedSessions } from "../session-pins";

// The registry is module state. Give back every pin a test takes — even one
// whose assertions failed halfway — so no test inherits another's pins.
const held: Array<() => void> = [];
const pin = (id: string) => {
  const release = pinSession(id);
  held.push(release);
  return release;
};
afterEach(() => {
  for (const release of held.splice(0)) release();
});

const pinned = () => pinnedSessionIds().sort();

describe("pinSession", () => {
  it("pins a session until the returned function releases it", () => {
    const release = pin("run-1");
    expect(pinned()).toEqual(["run-1"]);
    release();
    expect(pinned()).toEqual([]);
  });

  it("is reference-counted: pinned twice and released once, it stays pinned", () => {
    const first = pin("run-1");
    const second = pin("run-1");
    first();
    expect(pinned()).toEqual(["run-1"]);
    second();
    expect(pinned()).toEqual([]);
  });

  it("unpins once: calling one release twice cannot drop another holder's pin", () => {
    const first = pin("run-1");
    pin("run-1");
    first();
    first();
    expect(pinned()).toEqual(["run-1"]);
  });
});

describe("usePinnedSession", () => {
  it("pins the session while mounted and unpins it on unmount", () => {
    const { unmount } = renderHook(() => usePinnedSession("run-1"));
    expect(pinned()).toEqual(["run-1"]);
    unmount();
    expect(pinned()).toEqual([]);
  });

  it("moves the pin when the id changes, and drops it when the id goes away", () => {
    const { rerender } = renderHook<void, { id: string | null | undefined }>(
      ({ id }) => usePinnedSession(id),
      { initialProps: { id: "run-1" } },
    );
    expect(pinned()).toEqual(["run-1"]);
    rerender({ id: "run-2" });
    expect(pinned()).toEqual(["run-2"]);
    rerender({ id: null });
    expect(pinned()).toEqual([]);
  });

  it("pins nothing without an id", () => {
    renderHook(() => usePinnedSession(null));
    renderHook(() => usePinnedSession(undefined));
    expect(pinned()).toEqual([]);
  });

  it("leaves another holder's pin on the same session in place", () => {
    pin("run-1");
    const { unmount } = renderHook(() => usePinnedSession("run-1"));
    unmount();
    expect(pinned()).toEqual(["run-1"]);
  });
});

describe("usePinnedSessions", () => {
  it("pins every listed session while mounted and releases them all on unmount", () => {
    const { unmount } = renderHook(() => usePinnedSessions(["a", "b"]));
    expect(pinned()).toEqual(["a", "b"]);
    unmount();
    expect(pinned()).toEqual([]);
  });

  it("releases the sessions that leave the list and pins the ones that join it", () => {
    const { rerender } = renderHook(
      ({ ids }: { ids: string[] }) => usePinnedSessions(ids),
      { initialProps: { ids: ["a", "b"] } },
    );
    rerender({ ids: ["b", "c"] });
    expect(pinned()).toEqual(["b", "c"]);
    rerender({ ids: [] });
    expect(pinned()).toEqual([]);
  });

  it("releases a listed-twice session only as often as it pinned it", () => {
    pin("a");
    const { unmount } = renderHook(() => usePinnedSessions(["a", "a"]));
    unmount();
    expect(pinned()).toEqual(["a"]);
  });
});
