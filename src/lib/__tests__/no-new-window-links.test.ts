/**
 * No renderer code asks the webview for a new window. Tauri's webview refuses
 * new windows, so a `target="_blank"` link or a `window.open(…)` call opens
 * nothing at all. A link to another site goes through `followLink`
 * (`@/components/markdown-link`), and any other code through `openExternalUrl`
 * (`@/lib/links`): both hand the URL to the system browser.
 *
 * This parses the renderer's own sources (tests are skipped) and flags:
 *   - a string that names the new-window target: `"_blank"` itself, which
 *     covers `target="_blank"` in any spelling, or markup such as
 *     `<a target="_blank">` inside a string;
 *   - any use of `window.open` (also `globalThis.open`, `self.open`).
 * Comments are not code, so they may still mention either.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SRC = resolve(__dirname, "../..");

/** The text of a string in code that names the new-window target. */
const NEW_WINDOW_TEXT = /^\s*_blank\s*$|\btarget\s*=\s*["']?_blank\b/i;
/** The globals whose `open` is `window.open`. */
const WINDOW_GLOBALS = new Set(["window", "globalThis", "self"]);

/** The renderer sources this guard covers, as `src/`-relative paths. */
function sources(): { file: string; text: string }[] {
  return readdirSync(SRC, { recursive: true, encoding: "utf8" })
    .map((file) => file.split(sep).join("/"))
    .filter((file) => /\.tsx?$/.test(file))
    .filter((file) => !file.split("/").includes("__tests__") && !/\.test\.tsx?$/.test(file))
    .map((file) => ({ file, text: readFileSync(join(SRC, file), "utf8") }));
}

/** `node` without the parentheses, casts and `!` around it. */
function unwrap(node: ts.Expression): ts.Expression {
  while (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isNonNullExpression(node)
  ) {
    node = node.expression;
  }
  return node;
}

/** Whether `node` reads `open` off a window global: `window.open`,
 *  `window?.open`, `window["open"]`, `(window as X).open`. */
function isWindowOpen(node: ts.Node): boolean {
  let key: string | undefined;
  if (ts.isPropertyAccessExpression(node)) key = node.name.text;
  else if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
    key = node.argumentExpression.text;
  } else return false;
  const owner = unwrap(node.expression);
  return key === "open" && ts.isIdentifier(owner) && WINDOW_GLOBALS.has(owner.text);
}

/** Whether `node` is a string, or a template's literal text, that names the
 *  new-window target. */
function namesNewWindow(node: ts.Node): boolean {
  const text =
    ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)
      ? node.text
      : undefined;
  return text !== undefined && NEW_WINDOW_TEXT.test(text);
}

/** `file:line` for each line of `text` that asks for a new window. */
function newWindowRequests(file: string, text: string): string[] {
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, kind);
  const lines = new Set<number>();
  const visit = (node: ts.Node): void => {
    if (namesNewWindow(node) || isWindowOpen(node)) {
      lines.add(source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...lines].map((line) => `${file}:${line}`);
}

describe("no renderer code opens a new window", () => {
  it("the check catches new-window links and window.open, and nothing else", () => {
    const caught = [
      '<a href={url} target="_blank" rel="noreferrer">Docs</a>',
      "<a href={url} target='_blank'>Docs</a>",
      '<a href={url} target={"_blank"}>Docs</a>',
      "<form action={url} target={`_blank`} />",
      '<button formTarget="_blank" />',
      'window.open(url, "_blank", "noopener,noreferrer");',
      "window.open(url);",
      "window?.open(url);",
      'window["open"](url);',
      "(window as unknown as { open: (u: string) => void }).open(url);",
      "globalThis.open(url);",
      "const openWindow = window.open;",
      'link.target = "_blank";',
      'link.setAttribute("target", "_blank");',
      "const html = '<a href=\"x\" target=\"_blank\">x</a>';",
      'const html = `<a href="${url}" target=_blank>x</a>`;',
    ];
    const ignored = [
      '// a target="_blank" link opens nothing in Tauri',
      "/** falls back to window.open(url) in a browser */",
      '<p>{/* target="_blank" opens nothing */}Docs</p>',
      "<a href={url} onClick={(e) => followLink(e, url)}>Docs</a>",
      '<a href={url} target="_self">Docs</a>',
      "openExternalUrl(url);",
      "dialog.open(); socket.open(url); menu.open = true;",
      "window.openFile(path);",
      "const is_blank = line.trim() === '';",
      'const option = "allow_blank";',
      "<p>Links with target=\"_blank\" open nothing here.</p>",
    ];
    for (const text of caught) expect(newWindowRequests("x.tsx", text), text).toHaveLength(1);
    for (const text of ignored) expect(newWindowRequests("x.tsx", text), text).toEqual([]);
  });

  it("scans the renderer's sources", () => {
    const files = sources().map((s) => s.file);
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain("lib/links.ts");
    expect(files).toContain("components/git/pr-dialog.tsx");
    expect(files.filter((file) => file.includes("__tests__") || /\.test\.tsx?$/.test(file))).toEqual([]);
  });

  it("no source links to a new window or calls window.open", () => {
    const offenders = sources().flatMap(({ file, text }) => newWindowRequests(file, text));
    expect(offenders, "open external links with followLink or openExternalUrl").toEqual([]);
  });
});
