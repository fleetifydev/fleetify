import { describe, expect, it } from "vitest";
import { resolveTarget } from "@/components/workspace/views/browser-view";

describe("resolveTarget", () => {
  it("defaults loopback hosts to http — dev servers speak plain http", () => {
    expect(resolveTarget("localhost:3000")).toBe("http://localhost:3000");
    expect(resolveTarget("localhost")).toBe("http://localhost");
    expect(resolveTarget("127.0.0.1:8765/api")).toBe("http://127.0.0.1:8765/api");
    expect(resolveTarget("0.0.0.0:4000")).toBe("http://0.0.0.0:4000");
  });

  it("still defaults real hosts to https", () => {
    expect(resolveTarget("example.com")).toBe("https://example.com");
    expect(resolveTarget("localhost.dev")).toBe("https://localhost.dev");
  });

  it("never rewrites an explicit scheme", () => {
    expect(resolveTarget("https://localhost:3000")).toBe("https://localhost:3000");
    expect(resolveTarget("http://example.com")).toBe("http://example.com");
  });

  it("sends non-URLs to search", () => {
    expect(resolveTarget("what is rust")).toBe("https://www.google.com/search?q=what%20is%20rust");
  });
});
