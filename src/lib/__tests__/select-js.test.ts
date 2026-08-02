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
  rclick: () => void;
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
    click: () => {
      // Real engines fire pointerdown -> mousedown -> mouseup -> click; the
      // script picks on the press and swallows the trailing click.
      for (const type of ["pointerdown", "mousedown", "click"]) {
        el.dispatchEvent(new win.MouseEvent(type, { bubbles: true, cancelable: true, clientX: 20, clientY: 20, button: 0 }));
      }
    },
    rclick: () => el.dispatchEvent(new win.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 20 })),
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

describe("crosshair cursor override", () => {
  it("injects a cursor:crosshair !important style for every element while armed, and removes it on stop", () => {
    const h = boot();
    const doc = h.win.document;
    const styleTags = () =>
      [...doc.querySelectorAll("style")].filter((s) => /crosshair\s*!important/.test(s.textContent || ""));
    expect(styleTags().length).toBe(0);
    fleet(h).__fleetStartSelect("ask");
    expect(styleTags().length).toBe(1);
    fleet(h).__fleetStopSelect();
    expect(styleTags().length).toBe(0);
  });

  it("keeps exactly one override across re-arms (navigation re-arm is idempotent)", () => {
    const h = boot();
    const doc = h.win.document;
    fleet(h).__fleetStartSelect("copy:css");
    fleet(h).__fleetStartSelect("ask"); // live mode switch while armed
    const count = [...doc.querySelectorAll("style")].filter((s) => /crosshair/.test(s.textContent || "")).length;
    expect(count).toBe(1);
  });
});

describe("hostile page delegation (YouTube-class apps)", () => {
  it("still opens the ask box when the page registered stopImmediatePropagation capture handlers first", () => {
    const h = boot();
    const doc = h.win.document;
    // Simulate YouTube: page code loaded long before the user arms Select,
    // with document-capture delegation that kills events for its widgets.
    const kill = (e: Event) => { e.stopImmediatePropagation(); e.preventDefault(); };
    for (const type of ["pointerdown", "mousedown", "click"]) {
      doc.addEventListener(type, kill, true);
    }
    fleet(h).__fleetStartSelect("ask");
    h.click();
    expect(h.boxOpen()).toBe(true);
  });
});

describe("right-click menu press interplay", () => {
  it("a press that closes the menu does not pick; the next press does", () => {
    const h = boot();
    fleet(h).__fleetStartSelect("ask");
    h.rclick();
    h.click(); // closes the menu — must not open the box
    expect(h.boxOpen()).toBe(false);
    h.click();
    expect(h.boxOpen()).toBe(true);
  });
});

describe("Trusted Types safety (YouTube / Google sign-in)", () => {
  it("never uses innerHTML — a plain-string assignment throws under require-trusted-types-for", () => {
    expect(SELECT_JS).not.toContain("innerHTML");
  });

  it("opens the ask box even when the page enforces Trusted Types", () => {
    const h = boot();
    // Simulate the enforcement: on TT pages every string->markup assignment
    // throws exactly like this. happy-dom SHARES Element.prototype across
    // Window instances, so the override must be restored or it poisons
    // every later boot() in this file.
    const proto = (h.win as unknown as { Element: { prototype: object } }).Element.prototype;
    const original = Object.getOwnPropertyDescriptor(proto, "innerHTML");
    try {
      Object.defineProperty(proto, "innerHTML", {
        configurable: true,
        get() { return ""; },
        set() { throw new TypeError("This document requires 'TrustedHTML' assignment."); },
      });
      fleet(h).__fleetStartSelect("ask");
      h.click();
      expect(h.boxOpen()).toBe(true);
    } finally {
      if (original) Object.defineProperty(proto, "innerHTML", original);
    }
  });
});

describe("Enter and the Send button post identical dispatch payloads", () => {
  type ShadowHost = { shadowRoot: { querySelector: (s: string) => unknown; querySelectorAll: (s: string) => unknown[] } };
  const openBoxAndSend = (act: (host: ShadowHost, ta: { value: string; dispatchEvent: (e: Event) => boolean }, h: Harness) => void) => {
    const h = boot();
    fleet(h).__fleetStartSelect("ask");
    h.click();
    const doc = h.win.document;
    const host = [...doc.documentElement.children, ...doc.body.children].find(
      (el) => (el as { shadowRoot?: unknown }).shadowRoot,
    ) as unknown as ShadowHost;
    const ta = host.shadowRoot.querySelector("textarea") as { value: string; dispatchEvent: (e: Event) => boolean };
    ta.value = "fix this";
    act(host, ta, h);
    const href = String(h.win.location.href);
    const i = href.indexOf("fleet.internal/pick/");
    expect(i).toBeGreaterThan(-1);
    return JSON.parse(decodeURIComponent(href.slice(i + "fleet.internal/pick/".length))) as { submit?: boolean; prompt?: string };
  };

  it("Enter dispatches with submit:true and the typed prompt", () => {
    const p = openBoxAndSend((_host, ta, h) => {
      ta.dispatchEvent(new h.win.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    expect(p).toMatchObject({ submit: true, prompt: "fix this" });
  });

  it("the Send button (and its icon) posts the exact same payload", () => {
    const viaButton = openBoxAndSend((host, _ta, h) => {
      const send = [...host.shadowRoot.querySelectorAll("button")].find(
        (b) => ((b as { textContent?: string }).textContent || "").includes("Send"),
      ) as { dispatchEvent: (e: Event) => boolean };
      send.dispatchEvent(new h.win.MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(viaButton).toMatchObject({ submit: true, prompt: "fix this" });

    const viaIcon = openBoxAndSend((host, _ta, h) => {
      const svg = host.shadowRoot.querySelector("svg") as { dispatchEvent: (e: Event) => boolean };
      svg.dispatchEvent(new h.win.MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(viaIcon).toMatchObject({ submit: true, prompt: "fix this" });
  });
});
