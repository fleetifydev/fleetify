import { describe, it, expect } from "vitest";
import { semverGt, isMajorBump } from "../semver";
import { computeUpdateInfo } from "../plugin-update";

describe("semver", () => {
  it("semverGt compares numerically", () => {
    expect(semverGt("0.2.0", "0.1.0")).toBe(true);
    expect(semverGt("1.0.0", "0.9.9")).toBe(true);
    expect(semverGt("0.1.0", "0.1.0")).toBe(false);
    expect(semverGt("0.1.0", "0.2.0")).toBe(false);
    expect(semverGt("1.2.10", "1.2.9")).toBe(true);
    expect(semverGt("garbage", "0.1.0")).toBe(false); // unparseable → no update
  });
  it("isMajorBump detects a major increase", () => {
    expect(isMajorBump("1.4.0", "2.0.0")).toBe(true);
    expect(isMajorBump("0.1.0", "0.2.0")).toBe(false);
    expect(isMajorBump("0.9.0", "1.0.0")).toBe(true);
  });
});

// Mocks mirror the real shapes: PluginInstall carries `version` at the top
// level and its installed manifest's secrets under `manifest.requires_secrets`;
// CatalogPlugin carries the latest version + secrets under `manifest`.
const inst = (version: string, secretKeys: string[] = []) => ({
  plugin_name: "p", version,
  manifest: { requires_secrets: secretKeys.map(k => ({ key: k, label: k })) },
} as any);
const cat = (version: string, secretKeys: string[] = []) => ({
  manifest: { version, requires_secrets: secretKeys.map(k => ({ key: k, label: k })) },
} as any);

describe("computeUpdateInfo", () => {
  it("no update when versions equal", () => {
    expect(computeUpdateInfo(inst("0.1.0"), cat("0.1.0")).updateAvailable).toBe(false);
  });
  it("minor update is safe", () => {
    const u = computeUpdateInfo(inst("0.1.0"), cat("0.2.0"));
    expect(u.updateAvailable).toBe(true);
    expect(u.isMajor).toBe(false);
    expect(u.addsSecret).toBe(false);
    expect(u.newVersion).toBe("0.2.0");
  });
  it("major update flagged", () => {
    expect(computeUpdateInfo(inst("0.9.0"), cat("1.0.0")).isMajor).toBe(true);
  });
  it("adds-secret flagged when catalog declares a new key", () => {
    const u = computeUpdateInfo(inst("0.1.0", ["A"]), cat("0.2.0", ["A", "B"]));
    expect(u.addsSecret).toBe(true);
    expect(u.newSecretKeys).toEqual(["B"]);
  });
});
