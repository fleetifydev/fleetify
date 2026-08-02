import { describe, it, expect } from "vitest";
import { detectDevServerUrl } from "@/lib/dev-server-url";

describe("detectDevServerUrl", () => {
  it("finds a Vite banner (ANSI-coloured)", () => {
    const s = "\x1b[32m  ➜  \x1b[1mLocal\x1b[22m:   \x1b[36mhttp://localhost:5173/\x1b[39m";
    expect(detectDevServerUrl(s)).toBe("http://localhost:5173");
  });

  it("finds a Next.js banner", () => {
    expect(detectDevServerUrl("   - Local:        http://localhost:3000")).toBe("http://localhost:3000");
  });

  it("finds a CRA banner", () => {
    expect(detectDevServerUrl("  Local:            http://localhost:3000")).toBe("http://localhost:3000");
  });

  it("normalises 0.0.0.0 to localhost", () => {
    expect(detectDevServerUrl("Server running at http://0.0.0.0:8080")).toBe("http://localhost:8080");
  });

  it("normalises IPv6 loopback to localhost", () => {
    expect(detectDevServerUrl("listening on http://[::1]:4321")).toBe("http://localhost:4321");
  });

  it("normalises 127.0.0.1 to localhost", () => {
    expect(detectDevServerUrl("http://127.0.0.1:4200")).toBe("http://localhost:4200");
  });

  it("takes the LAST match so a restart on a new port wins", () => {
    const s = "http://localhost:3000\nrestarting…\nhttp://localhost:3001";
    expect(detectDevServerUrl(s)).toBe("http://localhost:3001");
  });

  it("ignores a production https URL", () => {
    expect(detectDevServerUrl("deployed to https://fleetify.dev")).toBeNull();
  });

  it("ignores a loopback URL with no port", () => {
    expect(detectDevServerUrl("open http://localhost")).toBeNull();
  });

  it("returns null for unrelated output", () => {
    expect(detectDevServerUrl("$ npm run build\n✓ built in 1.2s")).toBeNull();
  });
});
