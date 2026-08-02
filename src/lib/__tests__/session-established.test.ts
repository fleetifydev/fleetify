import { describe, it, expect, beforeEach } from "vitest";
import {
  isSessionEstablished,
  markSessionEstablished,
  __resetSessionEstablishedCache,
} from "../session-established";

const KEY = "fleet:sessions-established";

beforeEach(() => {
  localStorage.clear();
  __resetSessionEstablishedCache();
});

describe("session-established", () => {
  it("starts unlatched and latches one way", () => {
    expect(isSessionEstablished("s1")).toBe(false);
    markSessionEstablished("s1");
    expect(isSessionEstablished("s1")).toBe(true);
  });

  it("survives a reload — the whole point over a per-mount ref", () => {
    markSessionEstablished("s1");
    __resetSessionEstablishedCache(); // simulate a fresh app run
    expect(isSessionEstablished("s1")).toBe(true);
  });

  it("keeps sessions independent", () => {
    markSessionEstablished("s1");
    expect(isSessionEstablished("s2")).toBe(false);
  });

  it("is idempotent and stores no duplicates", () => {
    markSessionEstablished("s1");
    markSessionEstablished("s1");
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual(["s1"]);
  });

  it("ignores a missing id", () => {
    markSessionEstablished(null);
    markSessionEstablished("");
    expect(isSessionEstablished(null)).toBe(false);
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("caps the list, evicting the least recently latched", () => {
    for (let i = 0; i < 520; i++) markSessionEstablished(`s${i}`);
    const stored = JSON.parse(localStorage.getItem(KEY)!) as string[];
    expect(stored).toHaveLength(500);
    expect(stored[0]).toBe("s519"); // newest first
    expect(isSessionEstablished("s519")).toBe(true);
    expect(isSessionEstablished("s0")).toBe(false); // evicted
  });

  it("degrades to unlatched on corrupt storage instead of throwing", () => {
    localStorage.setItem(KEY, "{not json");
    __resetSessionEstablishedCache();
    expect(() => isSessionEstablished("s1")).not.toThrow();
    expect(isSessionEstablished("s1")).toBe(false);
  });

  it("ignores non-string entries left by an older/other writer", () => {
    localStorage.setItem(KEY, JSON.stringify(["s1", 42, null]));
    __resetSessionEstablishedCache();
    expect(isSessionEstablished("s1")).toBe(true);
  });
});
