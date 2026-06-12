// HTTP client + pure helpers for the `/prompts` command. `listPrompts` hits the
// backend aggregation endpoint; `filterPrompts` / `resolvePromptArg` are pure so
// the picker and the `/prompts <slug>` path are unit-testable without a DOM.
import { apiFetch } from "./api";

export interface PromptSummary {
  id: string;
  name: string;
  slug: string;
  description?: string | null;
  /** "user" for Library-authored prompts, else the contributing plugin name. */
  source: string;
  body: string;
}

/** Fetch every prompt (Library-authored + plugin-shipped). Throws on non-2xx so
 *  callers can surface the failure (the picker shows a load error; the
 *  `/prompts <slug>` path toasts). */
export async function listPrompts(): Promise<PromptSummary[]> {
  const res = await apiFetch("/api/prompts");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** Case-insensitive search over name + slug, for the picker's search box. */
export function filterPrompts(list: PromptSummary[], query: string): PromptSummary[] {
  const q = query.trim().toLowerCase();
  if (!q) return list;
  return list.filter(
    (p) => p.name.toLowerCase().includes(q) || p.slug.toLowerCase().includes(q),
  );
}

/** Resolve a `/prompts <arg>` argument to one prompt. Matches the first
 *  whitespace-delimited token against `slug` (case-insensitive), then `id`.
 *  Returns null when nothing matches. */
export function resolvePromptArg(list: PromptSummary[], arg: string): PromptSummary | null {
  const key = (arg.trim().split(/\s+/)[0] ?? "").toLowerCase();
  if (!key) return null;
  return (
    list.find((p) => p.slug.toLowerCase() === key) ??
    list.find((p) => p.id.toLowerCase() === key) ??
    null
  );
}
