import { describe, it, expect } from "vitest";
import {
  isFleetifyKeychainTarget,
  parseMacKeychainDump,
  parseSecretToolDump,
} from "../../scripts/wipe/keychain-filter.mjs";

describe("isFleetifyKeychainTarget", () => {
  it("matches the legacy Fleetify service", () => {
    expect(isFleetifyKeychainTarget("Fleetify")).toBe(true);
  });
  it("matches Fleetify-GitHub", () => {
    expect(isFleetifyKeychainTarget("Fleetify-GitHub")).toBe(true);
  });
  it("matches Fleetify-Provider-<id> (the bug)", () => {
    expect(isFleetifyKeychainTarget("Fleetify-Provider-anthropic")).toBe(true);
    expect(isFleetifyKeychainTarget("Fleetify-Provider-openai")).toBe(true);
    expect(isFleetifyKeychainTarget("Fleetify-Provider-antigravity-sdk")).toBe(true);
  });
  it("matches Fleetify/<user> keyring-crate form", () => {
    expect(isFleetifyKeychainTarget("Fleetify/jackson")).toBe(true);
  });
  it("strips the LegacyGeneric:target= wrapper Windows uses", () => {
    expect(
      isFleetifyKeychainTarget("LegacyGeneric:target=Fleetify-Provider-anthropic"),
    ).toBe(true);
  });
  it("rejects unrelated targets", () => {
    expect(isFleetifyKeychainTarget("Microsoft_Office")).toBe(false);
    expect(isFleetifyKeychainTarget("github.com")).toBe(false);
    expect(isFleetifyKeychainTarget("")).toBe(false);
  });
  it("rejects substrings that aren't Fleetify-anchored", () => {
    expect(isFleetifyKeychainTarget("NotFleetify")).toBe(false);
    expect(isFleetifyKeychainTarget("something/Fleetify")).toBe(false);
  });
});

describe("parseMacKeychainDump", () => {
  it("returns every Fleetify* svce value, deduped", () => {
    const dump = [
      `"svce"<blob>="Fleetify"`,
      `"acct"<blob>="jackson"`,
      `"svce"<blob>="Fleetify-Provider-anthropic"`,
      `"svce"<blob>="iCloud"`,
      `"svce"<blob>="Fleetify-Provider-anthropic"`,
    ].join("\n");
    expect(parseMacKeychainDump(dump)).toEqual([
      "Fleetify",
      "Fleetify-Provider-anthropic",
    ]);
  });
  it("returns an empty array when nothing matches", () => {
    expect(parseMacKeychainDump('"svce"<blob>="iCloud"')).toEqual([]);
  });
});

describe("parseSecretToolDump", () => {
  it("returns every Fleetify* service attribute, deduped", () => {
    const dump = [
      `[/org/freedesktop/secrets/collection/login/1]`,
      `attribute.service = Fleetify`,
      `attribute.account = jackson`,
      ``,
      `[/org/freedesktop/secrets/collection/login/2]`,
      `attribute.service = Fleetify-Provider-openai`,
      ``,
      `[/org/freedesktop/secrets/collection/login/3]`,
      `attribute.service = Fleetify`,
      ``,
      `[/org/freedesktop/secrets/collection/login/4]`,
      `attribute.service = unrelated`,
    ].join("\n");
    expect(parseSecretToolDump(dump)).toEqual([
      "Fleetify",
      "Fleetify-Provider-openai",
    ]);
  });
  it("returns an empty array when nothing matches", () => {
    expect(parseSecretToolDump("attribute.service = unrelated")).toEqual([]);
  });
});
