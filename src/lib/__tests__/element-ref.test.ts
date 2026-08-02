import { describe, expect, it } from "vitest";
import {
  buildElementContextBlock,
  elementRefLabel,
  elementRefTitle,
  mergePromptIntoDraft,
  parsePickPayload,
  parseSelectMode,
  pickToRefDetail,
  selectModeLabel,
  type ElementRef,
} from "@/lib/element-ref";

const enc = (v: unknown) => encodeURIComponent(JSON.stringify(v));

const ref = (over: Partial<ElementRef> = {}): ElementRef => ({
  id: "1",
  selector: "button.submit",
  text: "",
  url: "",
  ...over,
});

describe("parsePickPayload", () => {
  it("decodes a URL-encoded JSON object", () => {
    expect(parsePickPayload(enc({ selector: "div.x", tag: "div" }))).toEqual({
      selector: "div.x",
      tag: "div",
    });
  });

  it("returns null for malformed, non-object, and array payloads", () => {
    expect(parsePickPayload("%7Bnope")).toBeNull();
    expect(parsePickPayload(enc(42))).toBeNull();
    expect(parsePickPayload(enc(null))).toBeNull();
    expect(parsePickPayload(enc([1, 2]))).toBeNull();
  });
});

describe("pickToRefDetail", () => {
  it("never turns action messages into chips", () => {
    expect(pickToRefDetail({ action: "copy", kind: "css", value: "div.x" })).toBeNull();
    expect(pickToRefDetail({ action: "dismiss" })).toBeNull();
  });

  it("falls back selector → tag → 'element'", () => {
    expect(pickToRefDetail({ tag: "div" })?.selector).toBe("div");
    expect(pickToRefDetail({})?.selector).toBe("element");
  });

  it("never leaks the submit flag into the chip", () => {
    const detail = pickToRefDetail({ selector: "div.x", submit: true });
    expect(detail).toEqual({ selector: "div.x", text: "", url: "" });
  });

  it("carries rich fields only when present and non-empty", () => {
    const rich = pickToRefDetail({
      selector: "button.cta",
      xpath: "/html[1]/body[1]/button[1]",
      component: "SubmitButton",
      componentTree: ["SubmitButton", "CheckoutForm"],
      source: "src/checkout/SubmitButton.tsx:42",
      rect: { x: 1, y: 2, w: 3, h: 4 },
      attrs: { role: "button" },
      styles: { display: "flex" },
      html: "<button/>",
    });
    expect(rich).toMatchObject({
      selector: "button.cta",
      component: "SubmitButton",
      source: "src/checkout/SubmitButton.tsx:42",
    });

    const bare = pickToRefDetail({ selector: "div.x", attrs: {}, styles: {}, componentTree: [] });
    expect(bare).toEqual({ selector: "div.x", text: "", url: "" });
  });
});

describe("elementRefLabel / elementRefTitle", () => {
  it("prefers component, then text, then selector", () => {
    expect(elementRefLabel(ref({ component: "Card", text: "hi" }))).toBe("<Card>");
    expect(elementRefLabel(ref({ text: "Click me" }))).toBe("Click me");
    expect(elementRefLabel(ref())).toBe("button.submit");
  });

  it("truncates long chip text to 40 chars", () => {
    expect(elementRefLabel(ref({ text: "x".repeat(80) }))).toHaveLength(40);
  });

  it("title lists selector, url, and source when present", () => {
    expect(elementRefTitle(ref({ url: "http://l", source: "src/a.tsx:1" }))).toBe(
      "button.submit · http://l\nsrc/a.tsx:1",
    );
    expect(elementRefTitle(ref())).toBe("button.submit");
  });
});

describe("buildElementContextBlock", () => {
  it("keeps the legacy single-line shape for a plain pick", () => {
    const block = buildElementContextBlock([
      ref({ text: "Submit order", url: "http://localhost:3000/checkout" }),
    ]);
    expect(block).toBe(
      '> Selected element `button.submit` (http://localhost:3000/checkout): "Submit order"',
    );
  });

  it("appends rich lines only for captured fields", () => {
    const block = buildElementContextBlock([
      ref({
        component: "SubmitButton",
        componentTree: ["SubmitButton", "CheckoutForm", "CheckoutPage"],
        source: "src/checkout/SubmitButton.tsx:42",
        xpath: "/html[1]/body[1]/button[1]",
        rect: { x: 612, y: 488, w: 320, h: 44 },
        styles: { display: "flex", "background-color": "rgb(76, 141, 255)" },
        attrs: { "data-testid": "checkout-submit", type: "submit", id: "skipme" },
      }),
    ]);
    expect(block).toContain("> · component: SubmitButton (in CheckoutForm < CheckoutPage)");
    expect(block).toContain("> · source: src/checkout/SubmitButton.tsx:42");
    expect(block).toContain("> · xpath: /html[1]/body[1]/button[1]");
    expect(block).toContain("> · size: 320×44 at (612, 488)");
    expect(block).toContain("> · styles: display: flex; background-color: rgb(76, 141, 255)");
    // id/class never repeat in the attrs line, ATTR_ORDER decides the order.
    expect(block).toContain('> · attrs: data-testid="checkout-submit" type="submit"');
    expect(block).not.toContain("skipme");
  });

  it("omits every optional line when the ref has no rich data", () => {
    const block = buildElementContextBlock([ref()]);
    expect(block.split("\n")).toHaveLength(1);
  });

  it("caps styles at 8 entries and text at 500 chars", () => {
    const styles = Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [`p${i}`, `${i}`]),
    );
    const block = buildElementContextBlock([ref({ styles, text: "y".repeat(600) })]);
    const styleLine = block.split("\n").find((l) => l.includes("styles:"))!;
    expect(styleLine.match(/p\d+:/g)).toHaveLength(8);
    expect(block).toContain(`"${"y".repeat(500)}"`);
    expect(block).not.toContain("y".repeat(501));
  });

  it("joins multiple refs with newlines", () => {
    const block = buildElementContextBlock([ref(), ref({ id: "2", selector: "a.nav" })]);
    expect(block).toBe("> Selected element `button.submit`\n> Selected element `a.nav`");
  });
});

describe("select modes", () => {
  it("parses persisted modes and falls back to ask", () => {
    expect(parseSelectMode("copy:xpath")).toBe("copy:xpath");
    expect(parseSelectMode("ask")).toBe("ask");
    expect(parseSelectMode("copy:emoji")).toBe("ask");
    expect(parseSelectMode(null)).toBe("ask");
    expect(parseSelectMode(undefined)).toBe("ask");
  });

  it("labels the pill per mode and armed state", () => {
    expect(selectModeLabel("ask", false)).toBe("Select");
    expect(selectModeLabel("copy:css", false)).toBe("Select");
    expect(selectModeLabel("ask", true)).toBe("Select: Ask");
    expect(selectModeLabel("copy:css", true)).toBe("Select: Copy (CSS)");
    expect(selectModeLabel("copy:component", true)).toBe("Select: Copy (Component)");
  });
});

describe("mergePromptIntoDraft", () => {
  it("returns the draft untouched for an empty prompt", () => {
    expect(mergePromptIntoDraft("keep me", "  ")).toBe("keep me");
  });

  it("uses the prompt alone when the draft is blank", () => {
    expect(mergePromptIntoDraft("   ", "fix this button")).toBe("fix this button");
  });

  it("appends below existing text, trimming trailing whitespace once", () => {
    expect(mergePromptIntoDraft("first line  \n", "second line")).toBe("first line\nsecond line");
  });
});
