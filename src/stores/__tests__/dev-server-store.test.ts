import { describe, it, expect, beforeEach } from "vitest";
import { useDevServerStore, feedPtyChunk, setManualUrl, selectDevUrl } from "@/stores/dev-server-store";

const CWD = "/proj";
const read = (cwd: string) => selectDevUrl(cwd)(useDevServerStore.getState());

describe("dev-server-store", () => {
  beforeEach(() => useDevServerStore.setState({ byCwd: {} }, true));

  it("starts with no URL", () => {
    expect(read(CWD)).toBeNull();
  });

  it("detects from a single chunk", () => {
    feedPtyChunk(CWD, "  ➜  Local:   http://localhost:5173/\n");
    expect(read(CWD)).toBe("http://localhost:5173");
  });

  it("detects a URL split across two chunks", () => {
    feedPtyChunk(CWD, "  ➜  Local:   http://localh");
    feedPtyChunk(CWD, "ost:5173/\n");
    expect(read(CWD)).toBe("http://localhost:5173");
  });

  it("keeps separate URLs per cwd", () => {
    feedPtyChunk("/a", "http://localhost:3000\n");
    feedPtyChunk("/b", "http://localhost:4000\n");
    expect(read("/a")).toBe("http://localhost:3000");
    expect(read("/b")).toBe("http://localhost:4000");
  });

  it("follows a restart onto a new port", () => {
    feedPtyChunk(CWD, "http://localhost:3000\n");
    feedPtyChunk(CWD, "restarting\nhttp://localhost:3001\n");
    expect(read(CWD)).toBe("http://localhost:3001");
  });

  it("manual URL wins over detected", () => {
    feedPtyChunk(CWD, "http://localhost:3000\n");
    setManualUrl(CWD, "http://localhost:9999");
    expect(read(CWD)).toBe("http://localhost:9999");
  });

  it("clearing the manual URL falls back to detected", () => {
    feedPtyChunk(CWD, "http://localhost:3000\n");
    setManualUrl(CWD, "http://localhost:9999");
    setManualUrl(CWD, null);
    expect(read(CWD)).toBe("http://localhost:3000");
  });

  it("caps the tail so a long-running shell cannot grow it unbounded", () => {
    feedPtyChunk(CWD, "x".repeat(10_000));
    expect(useDevServerStore.getState().byCwd[CWD].tail.length).toBeLessThanOrEqual(4096);
  });

  it("ignores empty cwd and empty chunks", () => {
    feedPtyChunk("", "http://localhost:3000\n");
    feedPtyChunk(CWD, "");
    expect(read("")).toBeNull();
    expect(read(CWD)).toBeNull();
  });
});
