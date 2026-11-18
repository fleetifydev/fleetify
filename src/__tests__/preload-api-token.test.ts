/**
 * `window.fleetify.getApiToken()` asks the shell for this run's backend
 * token. The name it invokes must be the Rust command's
 * (`backend_api_token`, registered in src-tauri/src/lib.rs and allowed in
 * src-tauri/permissions/app-commands.toml); a mismatch would only show at
 * runtime. Loads the REAL injected preload script, like
 * preload-window-drag.test.ts.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const PRELOAD_SRC = readFileSync(
  resolve(process.cwd(), "src-tauri/src/preload.js"),
  "utf8",
);

const invoke = vi.fn((_cmd: string, _args?: unknown) => Promise.resolve("run-token"));
(window as unknown as { __TAURI__: unknown }).__TAURI__ = {
  core: { invoke },
  event: { listen: () => Promise.resolve(() => {}) },
};

new Function(PRELOAD_SRC)();

describe("preload window.fleetify.getApiToken", () => {
  it("invokes backend_api_token and resolves to what it answers", async () => {
    await expect(window.fleetify?.getApiToken()).resolves.toBe("run-token");
    expect(invoke).toHaveBeenCalledWith("backend_api_token", {});
  });
});
