import { describe, it, expect } from "vitest";
import { SOURCE_KINDS } from "../chat-input";

describe("SOURCE_KINDS", () => {
  it("lists the four source tabs in order", () => {
    expect(SOURCE_KINDS.map((s) => s.tab)).toEqual(["local", "git", "remote", "container"]);
  });
});
