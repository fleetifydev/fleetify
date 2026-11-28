/** Text for Fleet's quiet lines: markdown marks taken out, model ids said the way people say them. */
import { CLI_MODEL_LABELS } from "@/lib/picker-groups";

/** Text without markdown marks, for one quiet line: **bold**, `code`, # headings, list bullets, [links](…). */
export const plain = (s: string) => s
  .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
  .replace(/(\*\*|__|`)/g, "")
  .replace(/^#+\s*/gm, "")
  .replace(/^\s*[-*]\s+/gm, "")
  .trim();

/** A model id as people say it: claude-sonnet-5-5 → Sonnet 5.5, gpt-5.3-codex → GPT-5.3 Codex. */
export function modelName(id: string | null | undefined): string {
  if (!id) return "";
  const known = CLI_MODEL_LABELS[id];
  if (known) return known;
  const words = id.replace(/^claude-/, "").replace(/-(\d+)-(\d+)(?=$|-)/, " $1.$2").split(/[-\s]+/);
  return words.map(w => (/^gpt/i.test(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1))).join(" ").replace(/^GPT (\d)/, "GPT-$1");
}
