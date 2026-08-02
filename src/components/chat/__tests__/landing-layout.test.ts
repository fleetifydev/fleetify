import { describe, it, expect } from "vitest";
import { isLandingLayout } from "../landing-layout";

const msg = (id: string) => ({ id });
const WELCOME = msg("welcome-__composer__");

describe("isLandingLayout", () => {
  it("centers a freshly opened compose surface", () => {
    expect(isLandingLayout({
      isControlCenter: false, isComposing: true, isStreaming: false, messages: [],
    })).toBe(true);
  });

  it("STILL centers it once the compose welcome line lands", () => {
    // The regression: the welcome line is seeded asynchronously, so whether it
    // had landed decided whether "New chat" opened centered or docked.
    expect(isLandingLayout({
      isControlCenter: false, isComposing: true, isStreaming: false, messages: [WELCOME],
    })).toBe(true);
  });

  it("docks once a folderless send echoes the attempt + warning", () => {
    expect(isLandingLayout({
      isControlCenter: false,
      isComposing: true,
      isStreaming: false,
      messages: [WELCOME, msg("attempt-folder-1"), msg("warn-folder-1")],
    })).toBe(false);
  });

  it("docks on any real conversation row", () => {
    expect(isLandingLayout({
      isControlCenter: false, isComposing: true, isStreaming: false, messages: [WELCOME, msg("m-1")],
    })).toBe(false);
  });

  it("centers the empty Fleet hub and docks it once it has a message", () => {
    expect(isLandingLayout({
      isControlCenter: true, isComposing: false, isStreaming: false, messages: [],
    })).toBe(true);
    // The hub's staff session has no compose scene-setting — anything docks it.
    expect(isLandingLayout({
      isControlCenter: true, isComposing: false, isStreaming: false, messages: [WELCOME],
    })).toBe(false);
  });

  it("never centers a real session, even an empty one", () => {
    expect(isLandingLayout({
      isControlCenter: false, isComposing: false, isStreaming: false, messages: [],
    })).toBe(false);
  });

  it("never centers while streaming", () => {
    expect(isLandingLayout({
      isControlCenter: false, isComposing: true, isStreaming: true, messages: [],
    })).toBe(false);
  });
});
