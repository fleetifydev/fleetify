import { describe, it, expect, vi } from "vitest";
import { useRef } from "react";
import { render, fireEvent } from "@testing-library/react";
import { useEscapeToStop, isOnScreen } from "../use-escape-to-stop";

/** Mirrors App.tsx: the shell is parked under `display: none` while Settings
 *  or Library is open, and restored with `display: contents`. The chat surface
 *  inside stays MOUNTED the whole time, so its global key listeners stay live. */
function Harness({ parked, active, onStop }: { parked: boolean; active: boolean; onStop: () => void }) {
  const surface = useRef<HTMLDivElement>(null);
  useEscapeToStop(surface, active, onStop);
  return (
    <div style={{ display: parked ? "none" : "contents" }}>
      <div ref={surface}>chat</div>
    </div>
  );
}

const pressEscape = () => fireEvent.keyDown(window, { key: "Escape" });

describe("useEscapeToStop", () => {
  it("stops the stream on Escape while the chat surface is on screen", () => {
    const onStop = vi.fn();
    render(<Harness parked={false} active onStop={onStop} />);
    pressEscape();
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("ignores Escape while the surface is parked under another route", () => {
    // Regression: Library and Settings close on Escape. The same keypress used
    // to reach the hidden chat's listener and abort the in-flight response.
    const onStop = vi.fn();
    render(<Harness parked active onStop={onStop} />);
    pressEscape();
    expect(onStop).not.toHaveBeenCalled();
  });

  it("works again once the surface is back on screen", () => {
    const onStop = vi.fn();
    const { rerender } = render(<Harness parked active onStop={onStop} />);
    pressEscape();
    rerender(<Harness parked={false} active onStop={onStop} />);
    pressEscape();
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("does nothing when no stream is running", () => {
    const onStop = vi.fn();
    render(<Harness parked={false} active={false} onStop={onStop} />);
    pressEscape();
    expect(onStop).not.toHaveBeenCalled();
  });

  it("ignores other keys", () => {
    const onStop = vi.fn();
    render(<Harness parked={false} active onStop={onStop} />);
    fireEvent.keyDown(window, { key: "Enter" });
    expect(onStop).not.toHaveBeenCalled();
  });
});

describe("isOnScreen", () => {
  // Shared by every global key handler a chat surface registers — Escape-to-stop
  // above, and chat-input's permission shortcuts (Esc = deny, \u2318\u21b5 = allow).
  const mount = (parked: boolean) => {
    const shell = document.createElement("div");
    shell.style.display = parked ? "none" : "contents";
    const surface = document.createElement("div");
    shell.appendChild(surface);
    document.body.appendChild(shell);
    return { shell, surface };
  };

  it("is true for a surface the user can see", () => {
    expect(isOnScreen(mount(false).surface)).toBe(true);
  });

  it("is false under a display:none ancestor, however deep", () => {
    const { surface } = mount(true);
    const deep = document.createElement("span");
    surface.appendChild(deep);
    expect(isOnScreen(surface)).toBe(false);
    expect(isOnScreen(deep)).toBe(false);
  });

  it("is false for a missing or detached element", () => {
    expect(isOnScreen(null)).toBe(false);
    expect(isOnScreen(document.createElement("div"))).toBe(false);
  });
});
