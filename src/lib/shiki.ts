/**
 * Shiki singleton + a tiny React hook for IDE-style code highlighting.
 *
 * Why a singleton: each `createHighlighter` call ships its own copy of
 * the requested grammars + theme (a few MB). Letting every Bash card
 * spin up its own highlighter would jank the chat surface and balloon
 * memory in long sessions. Instead we lazy-construct one shared
 * instance on first use and reuse it everywhere.
 *
 * Languages cover what tool calls actually emit in this app:
 * shell for Bash command rendering, then the file extensions Edit /
 * Write targets most often (JS/TS/Python/etc). Theme `github-dark`
 * was picked because it sits closest to the chat's #0c0c0c surface
 * without flipping any token's contrast against our dark UI.
 */
import type { Highlighter } from "shiki";

let highlighterPromise: Promise<Highlighter> | null = null;

/** Map file path → shiki language id. Anything we don't recognise
 *  falls back to plaintext so the line still renders, just unstyled. */
export function langFromPath(path: string): string {
  const name = path.toLowerCase().split("/").pop() || "";
  if (name === "dockerfile" || name.startsWith("dockerfile.")) return "dockerfile";
  const ext = name.includes(".") ? name.split(".").pop()! : "";
  const map: Record<string, string> = {
    ts: "typescript", tsx: "tsx",
    js: "javascript", jsx: "jsx", mjs: "javascript", cjs: "javascript",
    py: "python", pyi: "python",
    rs: "rust",
    go: "go",
    rb: "ruby",
    java: "java",
    kt: "kotlin", kts: "kotlin",
    swift: "swift",
    c: "c", h: "c",
    cpp: "cpp", cc: "cpp", hpp: "cpp", hh: "cpp", cxx: "cpp",
    cs: "csharp",
    php: "php",
    sh: "shell", bash: "shell", zsh: "shell",
    json: "json", json5: "json5", jsonc: "jsonc",
    yaml: "yaml", yml: "yaml",
    toml: "toml",
    md: "markdown", mdx: "mdx",
    css: "css", scss: "scss", less: "less",
    html: "html", htm: "html", xml: "xml", svg: "xml",
    sql: "sql",
    graphql: "graphql", gql: "graphql",
    vue: "vue",
    svelte: "svelte",
    ini: "ini", conf: "ini", cfg: "ini",
    lua: "lua",
    r: "r",
    dart: "dart",
    proto: "proto",
    tf: "terraform", hcl: "hcl",
  };
  return map[ext] || "text";
}

/** Lazy-construct (or return the in-flight) shared highlighter. */
export function getHighlighter(): Promise<Highlighter> {
  if (highlighterPromise) return highlighterPromise;
  highlighterPromise = (async () => {
    const { createHighlighter } = await import("shiki");
    return createHighlighter({
      themes: ["github-dark"],
      langs: [
        "shell",
        "typescript", "tsx",
        "javascript", "jsx",
        "python",
        "rust", "go", "ruby", "java", "kotlin", "swift",
        "c", "cpp", "csharp", "php",
        "json", "json5", "jsonc",
        "yaml", "toml",
        "markdown", "mdx",
        "css", "scss", "html", "xml",
        "sql", "graphql", "vue", "svelte",
        "ini", "lua", "dockerfile",
      ],
    });
  })();
  return highlighterPromise;
}

/** Highlight a snippet → HTML string. Returns null on failure so the
 *  caller can fall back to the plain text it already has. */
export async function highlightToHtml(code: string, lang: string): Promise<string | null> {
  try {
    const hl = await getHighlighter();
    const safeLang = hl.getLoadedLanguages().includes(lang as never) ? lang : "text";
    return hl.codeToHtml(code, {
      lang: safeLang,
      theme: "github-dark",
    });
  } catch {
    return null;
  }
}

/** Highlight a multi-line snippet and return the inner HTML of each
 *  `<span class="line">…</span>` Shiki emits. Lets a caller render
 *  each line into its own layout row (e.g. a diff with gutter +
 *  marker) while keeping Shiki's IDE-quality token colouring. */
export async function highlightLines(code: string, lang: string): Promise<string[] | null> {
  const html = await highlightToHtml(code, lang);
  if (!html) return null;
  // Strip the outer <pre><code> wrapper, then pluck each line span.
  const inner = html
    .replace(/^<pre[^>]*>/, "")
    .replace(/<\/pre>\s*$/, "")
    .replace(/^<code[^>]*>/, "")
    .replace(/<\/code>\s*$/, "");
  const lines: string[] = [];
  const re = /<span class="line">([\s\S]*?)<\/span>(?:\n|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(inner)) !== null) {
    lines.push(m[1] ?? "");
  }
  return lines.length ? lines : null;
}
