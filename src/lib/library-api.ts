// Frontend HTTP client for /api/library/* — the user's own authored
// content (prompts / skills / commands / hooks / templates) that Fleet
// materializes to the per-provider on-disk homes. Mirrors the recipe
// used by mcp-api.ts / plugin-api.ts: a thin apiFetch wrapper + a small
// `handle` that surfaces the backend's `detail` message on non-2xx so
// the create dialog can render 400/409 errors inline.
import { apiFetch } from "./api";
import type { Provider } from "@/types/plugin";

/** The authorable content kinds. Mirrors the backend `LibraryKind`.
 *  Provider gating per kind lives in `PROVIDERS_FOR_KIND` below. */
export type LibraryKind =
  | "prompt"
  | "skill"
  | "hook"
  | "template"
  | "subagent"
  | "rule";

/** One materialized on-disk artifact for a library item — the provider it
 *  was written for and the absolute path it landed at. */
export interface Materialized {
  provider: string;
  path: string;
}

/** Which rule "shape" (modal tab) a `rule` item uses. Mirrors backend `RuleFormat`. */
export type RuleFormat = "general" | "cursor" | "copilot";
/** Where a rule is written. Mirrors backend `RuleScope`. */
export type RuleScope = "global" | "folder";
/** Cursor rule type → `.mdc` frontmatter. Mirrors backend `CursorRuleType`. */
export type CursorRuleType = "always" | "intelligent" | "specific" | "manual";

/** Extra config persisted on a `rule` item (format/scope/folder + the
 *  format-specific bits). Mirrors backend `RuleSpec`. */
export interface RuleSpec {
  format: RuleFormat;
  scope: RuleScope;
  folder?: string;
  cursor_rule_type?: CursorRuleType;
  globs?: string;
}

/** Cursor rule types with their labels + which extra field each requires
 *  (per cursor.com/docs/rules). Drives the Cursor tab's selector. */
export const CURSOR_RULE_TYPES: ReadonlyArray<{
  value: CursorRuleType;
  label: string;
  hint: string;
  needs: "none" | "description" | "globs";
}> = [
  { value: "always", label: "Always", hint: "Always included in context.", needs: "none" },
  { value: "intelligent", label: "Apply Intelligently", hint: "Agent includes it when the description is relevant.", needs: "description" },
  { value: "specific", label: "Apply to Specific Files", hint: "Auto-attached when a matching file is in context.", needs: "globs" },
  { value: "manual", label: "Manual", hint: "Only when you @-mention the rule.", needs: "none" },
];

/** A single authored library item as returned by the backend. `providers`
 *  is the set of agent ids the item targets (empty for provider-agnostic
 *  kinds like `prompt`); `materialized` is the realised on-disk fan-out. */
export interface LibraryItem {
  id: string;
  kind: LibraryKind;
  name: string;
  slug: string;
  description?: string;
  providers: string[];
  materialized: Materialized[];
  /** Present only on `rule` items — the format/scope/folder + format-specific
   *  bits. Absent ⇒ a legacy global general rule. */
  rule_spec?: RuleSpec;
  created_at: string;
  updated_at: string;
  /** Origin: "user" for your own items, or a plugin name. Plugin-contributed
   *  items are read-only (no edit/delete). Absent ⇒ treat as your own. */
  source?: string;
  editable?: boolean;
}

/** Create-item request body. `body` is the authored content (SKILL.md text
 *  for skills, command/prompt markdown otherwise). `providers` must be a
 *  subset of the kind's allowed set — the backend 400s on an empty list for
 *  provider-scoped kinds. */
export interface CreateLibraryItem {
  kind: LibraryKind;
  name: string;
  slug: string;
  description?: string;
  providers: string[];
  body: string;
  // ── Rule-only (ignored for other kinds) ──
  rule_format?: RuleFormat;
  scope?: RuleScope;
  folder?: string;
  cursor_rule_type?: CursorRuleType;
  globs?: string;
}

/** Provider gating per kind — the EXACT id sets the backend accepts. The
 *  create dialog renders one chip per id; `prompt` is provider-agnostic so
 *  it carries no picker. Kept here (next to the types) so the dialog and any
 *  validation read the same source of truth. */
export const PROVIDERS_FOR_KIND: Record<LibraryKind, Provider[]> = {
  skill: ["claude-code", "codex", "gemini", "kimi", "opencode", "github-copilot", "cursor", "hermes", "agy"],
  hook: ["claude-code", "cursor", "agy", "kimi", "github-copilot", "opencode", "hermes"],
  // Sub-agents need an on-disk `agents/` surface — Kimi/Hermes have none.
  subagent: ["claude-code", "codex", "gemini", "opencode", "github-copilot", "cursor", "agy"],
  // The Rule modal's *General* tab — the plain-markdown providers
  // (CLAUDE.md / GEMINI.md / AGENTS.md). Cursor + GitHub Copilot have their own
  // tabs (distinct on-disk formats), so they're not in this multi-select.
  rule: ["claude-code", "gemini", "codex", "kimi", "opencode", "agy"],
  prompt: [],
  template: [],
};

/** Slug regex the backend enforces — lowercase alnum, then any of
 *  alnum/hyphen. Surfaced in the dialog for an inline pre-submit check so
 *  the user doesn't round-trip to the server just to learn the slug is
 *  malformed. */
export const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

/** Derive a kebab-case slug from a free-text name. Lowercases, strips
 *  diacritics, collapses every run of non-alnum into a single hyphen, and
 *  trims leading/trailing hyphens. The dialog seeds the slug field from this
 *  as the user types the name (until they hand-edit the slug). */
export function slugify(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")        // drop combining accents
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")            // non-alnum runs → hyphen
    .replace(/^-+|-+$/g, "");               // trim edge hyphens
}

export class LibraryHttpError extends Error {
  status: number;
  body: unknown;
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function handle<T>(res: Response): Promise<T> {
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  // The backend returns 400/404 as plain text and 409 as JSON (`{error}`), so
  // parse defensively: fall back to the raw text when it isn't JSON.
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    const obj = (data && typeof data === "object" ? data : {}) as {
      error?: string;
      message?: string;
    };
    const message =
      (typeof data === "string" && data) ||
      obj.error ||
      obj.message ||
      `HTTP ${res.status}`;
    throw new LibraryHttpError(message, res.status, data);
  }
  return data as T;
}

/** List authored items, optionally filtered to a single kind. Omit `kind`
 *  for every kind in one call. */
export async function listLibraryItems(kind?: LibraryKind): Promise<LibraryItem[]> {
  const qs = kind ? `?kind=${encodeURIComponent(kind)}` : "";
  const res = await apiFetch(`/api/library/items${qs}`);
  return handle(res);
}

/** Fetch a single item by id. */
export async function getLibraryItem(id: string): Promise<LibraryItem> {
  const res = await apiFetch(`/api/library/items/${encodeURIComponent(id)}`);
  return handle(res);
}

/** Create an item. Throws `LibraryHttpError` with `.status` 400 (invalid
 *  slug / empty providers for a provider-scoped kind) or 409 (slug already
 *  exists for that kind) so the dialog can branch on the code. */
export async function createLibraryItem(body: CreateLibraryItem): Promise<LibraryItem> {
  const res = await apiFetch("/api/library/items", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return handle(res);
}

/** Edit an item. `kind`/`slug` are immutable; an empty `body` keeps the current
 *  payload (e.g. a providers-only edit). Throws `LibraryHttpError` like create. */
export async function updateLibraryItem(id: string, body: CreateLibraryItem): Promise<LibraryItem> {
  const res = await apiFetch(`/api/library/items/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return handle(res);
}

/** Delete an item by id. */
export async function deleteLibraryItem(id: string): Promise<{ ok: true }> {
  const res = await apiFetch(`/api/library/items/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  return handle(res);
}
