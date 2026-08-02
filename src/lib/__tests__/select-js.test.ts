/**
 * State-machine tests for the embedded browser's element-select content
 * script (SELECT_JS). The script ships as a Rust string constant — extracted
 * here and run inside an isolated happy-dom Window, the same way the webview
 * evaluates it. Catches regressions a node --check can't: arming, the ask
 * box, mode switches, and the fresh-document-after-navigation state.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";
import { beforeEach, describe, expect, it } from "vitest";

const rs = readFileSync(resolve(__dirname, "../../../src-tauri/src/shell/ipc/mod.rs"), "utf8");
const MARKER = 'const SELECT_JS: &str = r#"';
const start = rs.indexOf(MARKER);
const end = rs.indexOf('"#;', start + MARKER.length);
const SELECT_JS = rs.slice(start + MARKER.length, end);

type Harness = {
  win: InstanceType<typeof Window>;
  el: HTMLElement;
  click: () => void;
  esc: () => void;
  boxOpen: () => boolean;
};

function boot(): Harness {
  const win = new Window({ url: "http://localhost:3000/" });
  const doc = win.document;
  doc.body.innerHTML = '<button id="t" class="cta">Hello</button>';
  const el = doc.getElementById("t") as unknown as HTMLElement;
  (el as { getBoundingClientRect: () => unknown }).getBoundingClientRect = () =>
    ({ left: 10, top: 10, right: 110, bottom: 40, width: 100, height: 30 });
  (doc as unknown as { elementFromPoint: () => unknown }).elementFromPoint = () => el;
  win.eval(SELECT_JS);
  const hosts = () =>
    [...doc.documentElement.children, ...doc.body.children].filter((h) => (h as { shadowRoot?: unknown }).shadowRoot);
  return {
    win,
    el,
    click: () => el.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true, clientX: 20, clientY: 20 })),
    esc: () => doc.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })),
    boxOpen: () => hosts().some((h) => (h as { shadowRoot: { querySelector: (s: string) => unknown } }).shadowRoot.querySelector("textarea")),
  };
}

type FleetWindow = { __fleetStartSelect: (mode: string) => void; __fleetStopSelect: () => void };
const fleet = (h: Harness) => h.win as unknown as FleetWindow;

describe("SELECT_JS state machine", () => {
  let h: Harness;
  beforeEach(() => { h = boot(); });

  it("opens the ask box on click while armed", () => {
    fleet(h).__fleetStartSelect("ask");
    h.click();
    expect(h.boxOpen()).toBe(true);
  });

  it("closes the box on document-level Escape even when focus left the textarea", () => {
    fleet(h).__fleetStartSelect("ask");
    h.click();
    expect(h.boxOpen()).toBe(true);
    h.esc();
    expect(h.boxOpen()).toBe(false);
  });

  it("copy mode never opens the box and stays armed for the next pick", () => {
    fleet(h).__fleetStartSelect("copy:css");
    h.click();
    expect(h.boxOpen()).toBe(false);
    h.click(); // still armed — a second copy click must not throw
    expect(h.boxOpen()).toBe(false);
  });

  it("live mode switch while armed takes effect on the next click", () => {
    fleet(h).__fleetStartSelect("copy:css");
    h.click();
    fleet(h).__fleetStartSelect("ask");
    h.click();
    expect(h.boxOpen()).toBe(true);
  });

  it("a fresh document starts dead and revives when re-armed (navigation contract)", () => {
    // No arming call — this is the state right after a page navigation.
    h.click();
    expect(h.boxOpen()).toBe(false);
    fleet(h).__fleetStartSelect("ask");
    h.click();
    expect(h.boxOpen()).toBe(true);
  });
});
