/**
 * Element references picked from the embedded Browser pane.
 *
 * The content script in the native webview (SELECT_JS in src-tauri) captures
 * a rich element payload and hands it back to the app via the fleet.internal
 * navigation sentinel. These helpers are the single place that payload is
 * parsed, shaped into composer chips, and serialised into the context block
 * that precedes an outgoing message. Pure functions — unit tested without
 * Tauri.
 */

export type PickAction = "copy" | "dismiss";

/** Sticky behaviour of the Select pill: ask opens the prompt box, the copy
 * modes put the chosen representation straight on the clipboard per click. */
export const SELECT_MODES = [
  "ask",
  "copy:css",
  "copy:xpath",
  "copy:component",
  "copy:html",
  "copy:text",
] as const;
export type SelectMode = (typeof SELECT_MODES)[number];

/** Validate a persisted/raw mode string; anything unknown falls back to ask. */
export function parseSelectMode(raw: string | null | undefined): SelectMode {
  return (SELECT_MODES as readonly string[]).includes(raw ?? "") ? (raw as SelectMode) : "ask";
}

const MODE_SHORT: Record<SelectMode, string> = {
  "ask": "Ask",
  "copy:css": "Copy (CSS)",
  "copy:xpath": "Copy (XPath)",
  "copy:component": "Copy (Component)",
  "copy:html": "Copy (HTML)",
  "copy:text": "Copy (Text)",
};

/** Pill label: "Select" idle, "Select: <mode>" while armed. */
export function selectModeLabel(mode: SelectMode, active: boolean): string {
  return active ? `Select: ${MODE_SHORT[mode]}` : "Select";
}

/** Menu row label for the mode popover. */
export function selectModeMenuLabel(mode: SelectMode): string {
  return MODE_SHORT[mode];
}

/** Merge a prompt typed in the browser's in-page box into the composer
 * draft — append below any existing text, never clobber it. */
export function mergePromptIntoDraft(draft: string, typed: string): string {
  const t = typed.trim();
  if (!t) return draft;
  return draft.trim() ? `${draft.replace(/\s+$/, "")}\n${t}` : t;
}

/** Raw message the content script sends through the pick channel. */
export type PickPayload = {
  /** Present on action messages; absent on a real element pick. */
  action?: PickAction;
  /** copy: which representation was copied (css | xpath | component | html | text). */
  kind?: string;
  /** copy: the string to place on the clipboard. */
  value?: string;
  /** True when the box's Send fired — the turn should dispatch immediately. */
  submit?: boolean;
  selector?: string;
  xpath?: string;
  tag?: string;
  text?: string;
  url?: string;
  /** Typed into the in-page composer; empty when sent without writing. */
  prompt?: string;
  rect?: { x: number; y: number; w: number; h: number };
  attrs?: Record<string, string>;
  styles?: Record<string, string>;
  /** Nearest framework component (React/Vue), when detectable. */
  component?: string;
  /** Component ancestry, nearest first (includes `component`). */
  componentTree?: string[];
  /** file:line from dev-build debug info, when available. */
  source?: string;
  html?: string;
};

/** An element reference held by the composer and shown as a chip. */
export type ElementRef = {
  id: string;
  selector: string;
  text: string;
  url: string;
  xpath?: string;
  component?: string;
  componentTree?: string[];
  source?: string;
  rect?: { x: number; y: number; w: number; h: number };
  attrs?: Record<string, string>;
  styles?: Record<string, string>;
  html?: string;
};

/** Decode the URL-encoded JSON the content script navigated out. */
export function parsePickPayload(raw: string): PickPayload | null {
  try {
    const v = JSON.parse(decodeURIComponent(raw)) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as PickPayload) : null;
  } catch {
    return null;
  }
}

/**
 * Shape a pick payload into the composer's element-ref (id added by the
 * composer). Action messages (copy/dismiss) return null — they must never
 * become chips.
 */
export function pickToRefDetail(p: PickPayload): Omit<ElementRef, "id"> | null {
  if (p.action) return null;
  const detail: Omit<ElementRef, "id"> = {
    selector: p.selector || p.tag || "element",
    text: p.text || "",
    url: p.url || "",
  };
  if (p.xpath) detail.xpath = p.xpath;
  if (p.component) detail.component = p.component;
  if (p.componentTree?.length) detail.componentTree = p.componentTree;
  if (p.source) detail.source = p.source;
  if (p.rect) detail.rect = p.rect;
  if (p.attrs && Object.keys(p.attrs).length) detail.attrs = p.attrs;
  if (p.styles && Object.keys(p.styles).length) detail.styles = p.styles;
  if (p.html) detail.html = p.html;
  return detail;
}

/** Chip label: component name reads best, then visible text, then selector. */
export function elementRefLabel(r: ElementRef): string {
  if (r.component) return `<${r.component}>`;
  return r.text ? r.text.slice(0, 40) : r.selector;
}

/** Chip tooltip: selector · url, plus the source file when we have one. */
export function elementRefTitle(r: ElementRef): string {
  let t = r.selector;
  if (r.url) t += ` · ${r.url}`;
  if (r.source) t += `\n${r.source}`;
  return t;
}

const STYLE_LINE_MAX = 8;
const ATTR_LINE_MAX = 5;
/** Attributes worth surfacing (id/class already live in the selector). */
const ATTR_ORDER = [
  "data-testid",
  "aria-label",
  "role",
  "name",
  "type",
  "placeholder",
  "href",
  "alt",
  "title",
  "for",
  "value",
];

/**
 * Serialise picked elements into the quoted context block that precedes the
 * user's message. The first line keeps the original shape; richer fields
 * append as `· key: value` lines only when the picker captured them, so a
 * plain pick on a non-framework page reads exactly as before.
 */
export function buildElementContextBlock(refs: ElementRef[]): string {
  return refs
    .map((r) => {
      const lines = [
        `> Selected element \`${r.selector}\`${r.url ? ` (${r.url})` : ""}${r.text ? `: "${r.text.slice(0, 500)}"` : ""}`,
      ];
      if (r.component) {
        const tree = (r.componentTree ?? []).slice(1);
        lines.push(`> · component: ${r.component}${tree.length ? ` (in ${tree.join(" < ")})` : ""}`);
      }
      if (r.source) lines.push(`> · source: ${r.source}`);
      if (r.xpath) lines.push(`> · xpath: ${r.xpath}`);
      if (r.rect) lines.push(`> · size: ${r.rect.w}×${r.rect.h} at (${r.rect.x}, ${r.rect.y})`);
      if (r.styles) {
        const entries = Object.entries(r.styles).slice(0, STYLE_LINE_MAX);
        if (entries.length) {
          lines.push(`> · styles: ${entries.map(([k, v]) => `${k}: ${v}`).join("; ")}`);
        }
      }
      if (r.attrs) {
        const attrs = r.attrs;
        const picked = ATTR_ORDER.flatMap((k) => {
          const v = attrs[k];
          return v ? [`${k}="${v.slice(0, 80)}"`] : [];
        }).slice(0, ATTR_LINE_MAX);
        if (picked.length) lines.push(`> · attrs: ${picked.join(" ")}`);
      }
      return lines.join("\n");
    })
    .join("\n");
}
