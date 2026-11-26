/**
 * index.html paints the onboarding backdrop's light as its first frame, before
 * the app draws (and the shell's placeholder page does the same). Those copies
 * are static CSS, so they must follow the brand colour in src/globals.css or
 * the window would open in one blue and turn another a moment later.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

/** `#rrggbb` → `r, g, b`, as the static frames write it inside rgba(). */
function rgb(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
}

const css = read("src/globals.css");
// The light theme's --m-brand comes first in globals.css, the .dark one second.
const [light, dark] = [...css.matchAll(/--m-brand:\s*(#[0-9a-f]{6})/gi)].map((m) => m[1]!);

describe("the static first frame", () => {
  it("finds both brand tones in globals.css", () => {
    expect(light).toMatch(/^#/);
    expect(dark).toMatch(/^#/);
  });

  it.each([
    ["index.html", read("index.html")],
    ["the placeholder page", read("src-tauri/src/shell/startup_window.rs")],
  ])("paints %s's light in the brand colour, both themes", (_, source) => {
    expect(source).toContain(`rgba(${rgb(light!)}, 0.16)`);
    expect(source).toContain(`rgba(${rgb(dark!)}, 0.16)`);
  });
});
