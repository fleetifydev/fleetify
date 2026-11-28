import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import type { Components } from "react-markdown";
import type { ChatMessage, ContentBlock, ArtifactBlock, ResourceCardBlock } from "@/types/chat";
import {
  SkillsCard, HooksCard, CommandsCard, UsageCard, MCPStatusCard,
  InfoCard, ModeNoticeCard, ContextCard, DiffCard, MemoryFilesCard,
} from "./staff-message-cards";
import { CitationCard } from "./citation-card";
import { AuthRequiredCard } from "./auth-required-card";
import { CliLoginCard } from "./cli-login-card";
import { SpawnFormCard } from "./spawn-form-card";
import { ChatError } from "./chat-error";
import { LogoMark } from "@/components/brand/logo-mark";
import { ChevronRight, Copy, Check, ArrowRightLeft, CheckCircle2, AlertCircle, Terminal, FileText, Globe, Search, Cpu, CheckSquare, FolderSearch, Pencil, Wrench, Brain, MoveHorizontal, Trash2, FolderOpen, Download, Code2, BarChart2, BookOpen, Image, CornerDownLeft, Send, Bookmark, BookmarkCheck, RotateCcw, X, Clock, ArrowUp, Database } from "lucide-react";
import { createSessionMemory, backendFetch } from "@/lib/api";
import { formatShortcut } from "@/lib/keyboard-shortcuts";
import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { claimEscape } from "@/hooks/use-escape-to-stop";
import { useChatStore, selectSession } from "@/stores/chat-store";
import { useAppStore } from "@/stores/app-store";
import { MarkdownLink } from "@/components/markdown-link";
import { AskImage, markdownUrlTransform } from "@/components/marketplace/detail/markdown-image";
import { useTypewriter } from "@/hooks/use-typewriter";
import { highlightToHtml, highlightLines, langFromPath } from "@/lib/shiki";
import { folderName } from "@/lib/utils";
import { humanizeToolName } from "@/lib/tool-names";

/* ── Shiki-backed highlighter hook ──
   Streams plain text through Shiki on mount → returns HTML string the
   caller paints with dangerouslySetInnerHTML. While the highlighter is
   loading (first call only, ~150ms) we return `null` so the caller can
   fall back to its plain-text rendering — no flicker. After load, the
   shared highlighter is cached for the rest of the session. */
function useShikiHTML(code: string, lang: string): string | null {
  const isDark = document.documentElement.classList.contains("dark");
  const [html, setHtml] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    highlightToHtml(code, lang, isDark).then(out => {
      if (!cancelled) setHtml(out);
    });
    return () => { cancelled = true; };
  }, [code, lang, isDark]);
  return html;
}

/** Strip Shiki's outer <pre><code>…</code></pre> wrapper so we can drop
 *  the highlighted spans into our own layout without inheriting Shiki's
 *  default background / padding. */
function stripShikiWrapper(html: string): string {
  return html
    .replace(/^<pre[^>]*>/, "")
    .replace(/<\/pre>\s*$/, "")
    .replace(/^<code[^>]*>/, "")
    .replace(/<\/code>\s*$/, "");
}

/** Multi-line highlighter — returns one HTML string per line, fired
 *  once per (code, lang) pair. Used by the diff renderer so we can
 *  drop pre-coloured spans into our own row layout (gutter + marker +
 *  text) instead of fighting Shiki's default wrapping. While loading,
 *  yields `null` so the caller falls back to the plain `row.text`. */
function useShikiLines(code: string, lang: string): string[] | null {
  const [lines, setLines] = useState<string[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    highlightLines(code, lang).then(out => {
      if (!cancelled) setLines(out);
    });
    return () => { cancelled = true; };
  }, [code, lang]);
  return lines;
}

/* ── Strip internal dispatch syntax ──
   Used on assistant text — Claude sometimes echoes its own [[DISPATCH:...]]
   tokens back; we don't want them showing up in the rendered chat. */
const DISPATCH_RE = /\[\[DISPATCH:[a-f0-9-]+\|[^\]]+\]\]/gi;
function stripDispatch(text: string): string {
  return text.replace(DISPATCH_RE, "").replace(/\n{3,}/g, "\n\n").trim();
}

/* ── Strip backend metadata from user-facing text ──
   The frontend appends three kinds of metadata to staff/agent messages
   so Claude has the context it needs: a fleet status snapshot, per-agent
   context blocks pulled by @mention, and routing prefixes for Auto mode.
   Claude needs them; the user does NOT — and the persisted message body
   includes them, so without this pass the chat history reads like a
   debug dump every time you scroll back.

   What we strip (in order):
     1. The trailing ``\n\n---\n[FLEET STATUS - ...]...[END STATUS]`` block
     2. Each ``[AGENT CONTEXT: name]...[END CONTEXT]`` block (@mention pull-ins)
     3. Leading ``[AUTO MODE]`` routing prefix
     4. Leading ``[Auto-planner routed N task(s): ...]`` planner summary
     5. Leftover ``[[DIRECT_DISPATCH:...]]`` tokens (defensive — backend
        rewrites them to ``(✓ dispatched)`` markers, but if a stale row
        slips through we shouldn't render the raw syntax) */
const FLEET_STATUS_RE      = /(?:\n+---\n+)?\[FLEET STATUS[\s\S]*?\[END STATUS\]\s*$/m;
const AGENT_CONTEXT_RE     = /\[AGENT CONTEXT:[\s\S]*?\[END CONTEXT\]\n*/g;
const RECALL_CONTEXT_RE    = /\[RECALL CONTEXT[\s\S]*?\[END RECALL CONTEXT\]\n*/g;
const AUTO_MODE_PREFIX_RE  = /^\[AUTO MODE\]\s*/i;
const AUTO_PLAN_PREFIX_RE  = /^\[Auto-planner routed[^\]]*\]\s*\n*/;
const DIRECT_DISPATCH_RE   = /\[\[DIRECT_DISPATCH:[a-f0-9-]+\|[^\]]+\]\]/gi;
// Internal staff-side tokens the backend rewrites on its way back out
// — guard the renderer in case a row sneaks through with the raw form.
const READ_AGENT_RE        = /\[\[READ_AGENT:[a-f0-9-]+\|\d+\]\]/gi;
const DISPATCH_RAW_RE      = /\[\[DISPATCH:[^\]]+\]\]/gi;
// Personal-memory save token — Fleet emits it to persist a durable fact about
// the user; the backend acts on it, the user shouldn't see the raw syntax.
const REMEMBER_USER_RE     = /\[\[REMEMBER_USER:[\s\S]*?\]\]/gi;
const REMEMBER_USER_PARTIAL_RE = /\[\[REMEMBER_USER:[\s\S]*$/i;
// Spawn directives — the payload is JSON (may span lines), captured up to
// the first "]]" to mirror the backend token grammar. The PARTIAL form
// masks a token still streaming in (no closing "]]" yet) so raw JSON never
// flashes in the live bubble.
const SPAWN_RAW_RE         = /\[\[SPAWN:[\s\S]*?\]\]/gi;
const SPAWN_PARTIAL_RE     = /\[\[SPAWN:[\s\S]*$/i;
// Internal routing markers — the backend reads these to branch into the
// compactor / prompt-rewrite flows but they shouldn't reach the chat UI.
// Strip them at render time so "/compact" shows in the bubble without the
// "[fleet:compaction]" tag glued onto the front.
const FLEET_TAG_RE         = /^\[fleet:(?:compaction|enhance-prompt|auto-intro)\]\s*/i;
function cleanUserText(text: string): string {
  let out = text;
  out = out.replace(FLEET_STATUS_RE, "");
  out = out.replace(AGENT_CONTEXT_RE, "");
  out = out.replace(RECALL_CONTEXT_RE, "");
  out = out.replace(AUTO_PLAN_PREFIX_RE, "");
  out = out.replace(AUTO_MODE_PREFIX_RE, "");
  out = out.replace(DIRECT_DISPATCH_RE, "");
  out = out.replace(REMEMBER_USER_RE, "");
  out = out.replace(FLEET_TAG_RE, "");
  // Collapse the blank-line gulf that the deletions can leave behind.
  out = out.replace(/\n{3,}/g, "\n\n").trim();
  return out;
}

/* ── Formatters ── */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60), rs = s % 60;
  return rs > 0 ? `${m}m ${rs}s` : `${m}m`;
}
/* fmtCost intentionally removed — per-message cost was pulled out of
   the footer per the user's "summary should be calmer, no dollars"
   note. Session-level spend still renders elsewhere (budget pill /
   workspace footer). Re-add this if a future surface needs to render
   one message's dollar cost. */

/* ── Tool helpers ── */
/* Strip the boilerplate shell wrapper agents almost always wrap their
   real command in. e.g. `/bin/zsh -lc 'cd makeup-check-api && pip install'`
   collapses to just `cd makeup-check-api && pip install`. Without this
   every Bash row in the chat reads `Run /bin/zsh -lc '...'` and the
   actually-interesting bit is hidden 20 chars to the right + truncated. */
function stripShellWrapper(cmd: string): string {
  if (!cmd) return cmd;
  // /bin/zsh -lc '...' / bash -lc "..." / sh -c '...' / etc.
  const m = cmd.match(
    /^(?:\/(?:bin|usr\/bin)\/)?(?:bash|zsh|sh|dash)\s+-[lic]+\s+(['"])([\s\S]+)\1\s*$/,
  );
  if (m && m[2]) return m[2].trim();
  return cmd;
}

/* Heuristic-based natural-language summary for shell commands. Maps
   common invocations to a short verb-phrase so the tool card header
   reads like a log entry ("Installed Python packages") instead of a
   raw command fragment ("pip install -U fastapi uvicorn …"). Returns
   null when no pattern matches — caller falls back to the literal
   command. The patterns are ordered by specificity. */
function describeShellCommand(cmd: string): string | null {
  const c = cmd.trim().replace(/\s+/g, " ");

  // Package managers
  const pip = c.match(/(?:^|&&\s*|;\s*)(?:python\s+-m\s+)?pip\s+install\s+(-U\s+|--upgrade\s+|-e\s+)?([^\s|;]+)/);
  if (pip) {
    const pkg = pip[2];
    if (pkg === ".") return "Installed package (editable)";
    return `Installed ${pkg}`;
  }
  if (/(?:^|&&\s*|;\s*)(?:npm|pnpm|bun|yarn)\s+install\b/.test(c)) return "Installed dependencies";
  if (/(?:^|&&\s*|;\s*)cargo\s+(?:build|install)\b/.test(c)) return "Built Rust project";
  if (/(?:^|&&\s*|;\s*)go\s+(?:build|install|mod\s+tidy)\b/.test(c)) return "Built Go project";

  // Network / ports
  const lsof = c.match(/lsof\s+-iTCP:(\d+)/);
  if (lsof) return `Checked port ${lsof[1]}`;
  const curl = c.match(/curl\s+[^|]*?https?:\/\/([^\s/'"]+)(\/[^\s|'"]*)?/);
  if (curl) {
    const host = curl[1];
    const path = curl[2] || "";
    return `Probed ${host}${path}`.slice(0, 80);
  }

  // Git
  if (/git\s+diff\b.*\|\s*wc\s+-l/.test(c)) return "Counted diff lines";
  const gitDiff = c.match(/git\s+diff\s+([^\s|;]+)/);
  if (gitDiff) return `Diffed ${gitDiff[1]}`;
  if (/^git\s+status\b/.test(c)) return "Checked git status";
  if (/^git\s+log\b/.test(c)) return "Read git log";
  if (/^git\s+commit\b/.test(c)) return "Committed changes";
  if (/^git\s+push\b/.test(c)) return "Pushed to remote";

  // Filesystem reads
  const cat = c.match(/^cat\s+([^\s|;]+)/);
  if (cat) return `Viewed ${cat[1]}`;
  const head = c.match(/^head\s+-(\d+)\s+([^\s|;]+)/);
  if (head) return `Read first ${head[1]} lines of ${head[2]}`;
  const tail = c.match(/^tail\s+-(\d+)\s+([^\s|;]+)/);
  if (tail) return `Read last ${tail[1]} lines of ${tail[2]}`;
  const sed = c.match(/sed\s+-n\s+['"]([\d,]+)p['"]\s+([^\s|;]+)/);
  if (sed) return `Read lines ${sed[1]} of ${sed[2]}`;
  const ls = c.match(/^ls\s+(?:-[A-Za-z]+\s+)*([^\s|;]*)/);
  if (ls) return ls[1] ? `Listed ${ls[1]}` : "Listed directory";

  // Search
  const rg = c.match(/(?:^|&&\s*)(?:rg|grep)\s+(?:-[A-Za-z]+\s+)*['"]([^'"]+)['"]/);
  if (rg) return `Searched for "${rg[1]}"`;

  // Docker / process
  if (/docker\s+ps\b/.test(c)) return "Listed containers";
  if (/docker\s+inspect\b/.test(c)) return "Inspected container";
  if (/docker\s+(?:build|compose\s+up|run)\b/.test(c)) return "Ran docker";

  // Python ad-hoc
  if (/python\s+-c\s+/.test(c) || /python\s+<<\s*['"]?PY/.test(c)) return "Ran Python snippet";

  // Activated venv chain → use whatever comes AFTER the activate
  const afterVenv = c.match(/\.\s+\.?\s*venv\/bin\/activate\s*&&\s*(.+)/);
  if (afterVenv && afterVenv[1]) return describeShellCommand(afterVenv[1].trim()) || afterVenv[1].split(" ").slice(0, 4).join(" ");

  // cd → describe what's after the cd
  const afterCd = c.match(/^cd\s+[^\s&;]+\s*&&\s*(.+)/);
  if (afterCd && afterCd[1]) return describeShellCommand(afterCd[1].trim());

  return null;
}

/** Strip directory portion of a path so the row stays scannable.
 *  "/Users/foo/bar/baz/qux.tsx" → "qux.tsx". Keeps short relative
 *  paths intact since those are already readable. */
function basename(p: string): string {
  const parts = p.split("/");
  return parts[parts.length - 1] || p;
}

/** Collapse Fleetify's machine-path noise inside ANY string (a shell command,
 *  a summary, a path) to its repo-relative form: everything up to and including
 *  `…/.fleetify-worktrees/<uuid>/` or `…/clones/<host>/<owner>/<repo>/` is
 *  dropped, so `find /Users/x/.fleetify-wt-97/clones/github.com/o/r/.fleetify-
 *  worktrees/<uuid>/app/models …` reads as `find app/models …`. */
export function shortenFleetPath(text: string): string {
  return text
    .replace(/\S*\/\.fleetify-worktrees\/[0-9a-f-]{8,}\//gi, "")
    .replace(/\S*\/clones\/[^/\s]+\/[^/\s]+\/[^/\s]+\//gi, "");
}

/** Turn a long absolute path into a clean, human-scannable one: strip the
 *  Fleetify worktree UUID segment and the `…/clones/<host>/<owner>/<repo>/`
 *  prefix so a cloned-repo file shows as `app/config.py` instead of a
 *  60-char machine path, then keep only the last few segments. Returns the
 *  directory part (dimmed) and the file name (highlighted) separately. */
function prettyFilePath(full: string): { dir: string; name: string } {
  let p = full.replace(/\\/g, "/");
  // Drop a `.fleetify-worktrees/<uuid>/` segment (pure noise to the reader).
  p = p.replace(/\/\.fleetify-worktrees\/[0-9a-f-]{8,}\//i, "/");
  // Collapse a clone path down to the repo-relative part.
  const clone = p.match(/\/clones\/[^/]+\/[^/]+\/[^/]+\/(.+)$/);
  if (clone?.[1]) p = clone[1];
  const segs = p.split("/").filter(Boolean);
  const name = segs.pop() ?? p;
  // Keep at most the last 2 dirs; prefix "…/" when we trimmed deeper.
  let dirSegs = segs;
  let truncated = false;
  if (segs.length > 2) {
    dirSegs = segs.slice(-2);
    truncated = true;
  }
  const dir = dirSegs.length ? `${truncated ? "…/" : ""}${dirSegs.join("/")}/` : "";
  return { dir, name };
}

/** Single-tool summary line: a Claude-Desktop-style phrase that
 *  describes the action in one short sentence. The row body is what
 *  the user scans; details live behind the chevron. Examples:
 *    Bash       → "Ran Installed fastapi"
 *    Edit       → "Edited config.py"
 *    Read       → "Read main.tsx"
 *    Grep       → "Searched for \"useState\""
 *    WebSearch  → "Searched the web for \"sqlite WAL\""
 *    TodoWrite  → "Updated todos"
 *    Agent      → "Dispatched: refactor auth flow"
 */
export function rowSummary(toolName: string, input: Record<string, unknown>): string {
  // MCP tools (e.g. mcp__fleet_browser__read_page) get a friendly label —
  // "Browser read page" — plus a key arg, instead of the raw id. Handled
  // first so a browser-navigate's `url` doesn't fall into the "Fetched …" path.
  if (toolName.startsWith("mcp__")) {
    const label = humanizeToolName(toolName);
    const url = input?.url;
    if (typeof url === "string" && url) {
      try { return `${label} ${new URL(url).host}`; } catch { return label; }
    }
    const sel = input?.selector;
    if (typeof sel === "string" && sel) return `${label} ${sel.slice(0, 40)}`;
    return label;
  }
  // Bash family — describeShellCommand already returns a past-tense
  // verb phrase, so just prefix the right action word.
  if ("command" in input) {
    const cleaned = shortenFleetPath(stripShellWrapper(String(input.command)));
    const described = describeShellCommand(cleaned);
    if (described) return `Ran ${described.charAt(0).toLowerCase() + described.slice(1)}`;
    const firstLine = (cleaned.split("\n")[0] ?? "").slice(0, 90);
    return firstLine ? `Ran ${firstLine}` : "Ran a command";
  }
  if ("file_path" in input) {
    const file = basename(String(input.file_path));
    if (toolName === "Edit" || toolName === "MultiEdit") {
      // Append +N -N diff counts so the inner row mirrors Claude
      // Code Desktop's "Edited foo.tsx +12 -3" inline summary —
      // the user can scan diff weight without expanding.
      const oldText = String(input.old_string ?? "");
      const newText = String(input.new_string ?? "");
      const minus = oldText ? oldText.split("\n").length : 0;
      const plus  = newText ? newText.split("\n").length : 0;
      const stats = (plus || minus)
        ? `  +${plus} -${minus}`
        : "";
      return `Edited ${file}${stats}`;
    }
    if (toolName === "Write") {
      const lines = String(input.content ?? "").split("\n").length;
      return `Wrote ${file}  +${lines}`;
    }
    if (toolName === "Read") return `Read ${file}`;
    return `Touched ${file}`;
  }
  if ("pattern" in input) {
    const pat = String(input.pattern).slice(0, 60);
    if (toolName === "Glob") return `Globbed ${pat}`;
    return `Searched for "${pat}"`;
  }
  if ("query" in input) {
    const q = String(input.query ?? "").trim();
    if (!q) return "Browsed the web";  // Codex webSearch with action:other has no query
    return `Searched the web for "${q.slice(0, 60)}"`;
  }
  if ("url" in input) return `Fetched ${basename(String(input.url))}`;
  if (toolName === "TodoWrite" || toolName === "TodoRead") return "Updated todos";
  if (toolName === "Agent" && "description" in input) {
    return `Dispatched: ${String(input.description).slice(0, 70)}`;
  }
  if ("prompt" in input) return String(input.prompt).slice(0, 90);
  return `Used ${toolName || "tool"}`;
}

function getToolMeta(toolName: string, toolKind?: string): { icon: React.ReactNode; color: string; verb: string } {
  // Claude tools — keyed by tool_name
  const claudeTools: Record<string, { icon: React.ReactNode; color: string; verb: string }> = {
    Bash:      { icon: <Terminal size={11} />,     color: "var(--c-med)",          verb: "Run"    },
    Read:      { icon: <FileText size={11} />,     color: "var(--c-ghost)",        verb: "Read"   },
    Edit:      { icon: <Pencil size={11} />,       color: "rgba(96,165,250,0.65)", verb: "Edit"   },
    Write:     { icon: <FileText size={11} />,     color: "rgba(96,165,250,0.65)", verb: "Write"  },
    Glob:      { icon: <FolderSearch size={11} />, color: "var(--c-ghost)",        verb: "Glob"   },
    Grep:      { icon: <Search size={11} />,       color: "var(--c-ghost)",        verb: "Search" },
    Agent:     { icon: <Cpu size={11} />,          color: "rgba(251,146,60,0.65)", verb: "Agent"  },
    WebFetch:  { icon: <Globe size={11} />,        color: "var(--c-ghost)",        verb: "Fetch"  },
    WebSearch: { icon: <Globe size={11} />,        color: "var(--c-ghost)",        verb: "Web"    },
    TodoWrite: { icon: <CheckSquare size={11} />,  color: "var(--c-ghost)",        verb: "Tasks"  },
    TodoRead:  { icon: <CheckSquare size={11} />,  color: "var(--c-ghost)",        verb: "Tasks"  },
  };
  if (claudeTools[toolName]) return claudeTools[toolName];

  // Fleetify agentic catalog — snake_case tool names emitted by the
  // shared `crates/fleetify-backend/src/agentic/` executor when an
  // HTTP-provider session is dispatched through `drive_agentic_loop`.
  // Names map 1:1 to the same icons / verbs as Claude's PascalCase
  // equivalents above so a user moving between providers sees the same
  // visual vocabulary.
  const agenticTools: Record<string, { icon: React.ReactNode; color: string; verb: string }> = {
    read_file:   { icon: <FileText size={11} />,     color: "var(--c-ghost)",        verb: "Read"   },
    edit_file:   { icon: <Pencil size={11} />,       color: "rgba(96,165,250,0.65)", verb: "Edit"   },
    write_file:  { icon: <FileText size={11} />,     color: "rgba(96,165,250,0.65)", verb: "Write"  },
    list_dir:    { icon: <FolderSearch size={11} />, color: "var(--c-ghost)",        verb: "List"   },
    grep:        { icon: <Search size={11} />,       color: "var(--c-ghost)",        verb: "Search" },
    glob:        { icon: <FolderSearch size={11} />, color: "var(--c-ghost)",        verb: "Glob"   },
    run_command: { icon: <Terminal size={11} />,     color: "var(--c-med)",          verb: "Run"    },
  };
  if (agenticTools[toolName]) return agenticTools[toolName];

  // Gemini tools — keyed by ACP `kind`
  const kindMap: Record<string, { icon: React.ReactNode; color: string; verb: string }> = {
    read:    { icon: <FileText size={11} />,        color: "var(--c-ghost)",        verb: "Read"   },
    edit:    { icon: <Pencil size={11} />,          color: "rgba(96,165,250,0.65)", verb: "Edit"   },
    execute: { icon: <Terminal size={11} />,        color: "var(--c-med)",          verb: "Run"    },
    search:  { icon: <Search size={11} />,          color: "var(--c-ghost)",        verb: "Search" },
    fetch:   { icon: <Globe size={11} />,           color: "var(--c-ghost)",        verb: "Fetch"  },
    move:    { icon: <MoveHorizontal size={11} />,  color: "var(--c-ghost)",        verb: "Move"   },
    delete:  { icon: <Trash2 size={11} />,          color: "rgba(239,68,68,0.65)",  verb: "Delete" },
    think:   { icon: <Brain size={11} />,           color: "rgba(142,117,178,0.65)",verb: "Think"  },
    other:   { icon: <Wrench size={11} />,          color: "var(--c-ghost)",        verb: "Tool"   },
  };
  if (toolKind && kindMap[toolKind]) return kindMap[toolKind];

  // Fallback
  return { icon: <ChevronRight size={11} />, color: "var(--c-ghost)", verb: toolName || "Tool" };
}

/* ── Bash tool detail with Shiki-coloured command + neutral stdout ──
   The command line gets shell-syntax highlighting (keywords, flags,
   strings) the way an IDE terminal would render it. Stdout / stderr
   stays in plain --c-low so test traces stay legible without painting
   the entire body red on failure. */
function BashView({ command, output }: { command: string; output: string }) {
  const copyPayload = output ? `$ ${command}\n\n${output}` : `$ ${command}`;
  const cmdHtml = useShikiHTML(command, "shell");
  return (
    <div style={{ fontFamily: "var(--font-mono)" }}>
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        // Hairline separator dropped — the "Bash" label + copy icon
        // now sit inline at the top of the card, with the command
        // body flowing right below on the same surface. Matches the
        // Claude Code Desktop "Bash" pattern the user pointed at.
        padding: "8px 12px 2px",
        fontSize: 10.5, color: "var(--c-dim)",
      }}>
        <span>Bash</span>
        <CopyIconOnly text={copyPayload} />
      </div>
      <pre style={{
        fontSize: 12.5, lineHeight: 1.6,
        color: "var(--c-high)",
        margin: 0, padding: "0 12px",
        whiteSpace: "pre-wrap", wordBreak: "break-word",
      }}>
        <span style={{ color: "var(--c-dim)" }}>$ </span>
        {cmdHtml ? (
          <span dangerouslySetInnerHTML={{ __html: stripShikiWrapper(cmdHtml) }} />
        ) : (
          command
        )}
      </pre>
      {output && (
        <pre style={{
          fontSize: 12, lineHeight: 1.6,
          color: "var(--c-low)",
          margin: "10px 0 0", padding: "0 12px 8px",
          whiteSpace: "pre-wrap", wordBreak: "break-word",
          maxHeight: 320, overflowY: "auto",
        }}>{output}</pre>
      )}
    </div>
  );
}

/* ── Edit / Write diff with Shiki-coloured code lines ──
   Top: slim file-path band matching the right-sidebar file viewer.
   Body: line-numbered diff where each row's text is Shiki-tokenised
   (keywords, strings, numbers, comments all get their IDE colours)
   on top of the red / green band that marks old vs new. While Shiki
   is loading we paint plain --c-high so there's no blank flash. */
function DiffView({ fpath, oldText, newText }: {
  fpath: string;
  oldText: string;
  newText: string;
}) {
  const filename = fpath.split("/").pop() || fpath;
  const oldLines = oldText ? oldText.split("\n") : [];
  const newLines = newText ? newText.split("\n") : [];
  const cap = 60;
  type DiffRow = { kind: "old" | "new"; text: string };
  const rows: DiffRow[] = [
    ...oldLines.map((t): DiffRow => ({ kind: "old", text: t })),
    ...newLines.map((t): DiffRow => ({ kind: "new", text: t })),
  ];
  const shown = rows.slice(0, cap);
  const overflow = Math.max(0, rows.length - cap);
  const copyPayload =
    (oldLines.length ? oldLines.map(l => `- ${l}`).join("\n") + "\n" : "") +
    newLines.map(l => `+ ${l}`).join("\n");

  // Highlight old and new sides separately so each side remains valid
  // code in the eyes of the tokeniser (a removed `}` without its
  // matching `{` would otherwise confuse the lexer when concatenated).
  const lang = langFromPath(fpath);
  const oldHighlighted = useShikiLines(oldText, lang);
  const newHighlighted = useShikiLines(newText, lang);

  return (
    <div style={{ fontFamily: "var(--font-mono)", fontSize: 12, lineHeight: 1.6 }}>
      <div style={{
        padding: "8px 12px 4px",
        fontSize: 11, color: "var(--c-dim)",
        display: "flex", alignItems: "center", justifyContent: "space-between",
        gap: 8,
      }}>
        <span
          onClick={(e) => { e.stopPropagation(); useAppStore.getState().openFile(fpath); }}
          style={{
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            flex: 1, minWidth: 0, cursor: "pointer",
          }}
          title={`Open ${fpath} in the editor`}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.textDecoration = "underline"; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.textDecoration = "none"; }}
        >
          <span style={{ color: "var(--c-high)", fontWeight: 500 }}>{filename}</span>
          <span style={{ marginLeft: 10, color: "var(--c-dim)" }}>{prettyFilePath(fpath).dir}</span>
        </span>
        <span style={{ flexShrink: 0, display: "flex", alignItems: "center", gap: 10 }}>
          {newLines.length > 0 && (
            <span style={{ color: "rgb(64,180,120)" }}>+{newLines.length}</span>
          )}
          {oldLines.length > 0 && (
            <span style={{ color: "rgb(248,113,113)" }}>−{oldLines.length}</span>
          )}
          <CopyIconOnly text={copyPayload} />
        </span>
      </div>
      <div style={{ overflow: "auto", maxHeight: 360 }}>
        {/* Empty-diff fallback — surfaces when a tool emits an Edit
            with both old_string and new_string empty (or stripped to
            whitespace) so the user doesn't stare at a blank panel and
            wonder if the click did anything. */}
        {shown.length === 0 && (
          <div style={{
            padding: "14px 16px",
            color: "var(--c-dim)", fontSize: 11.5,
          }}>
            No textual diff captured for this edit.
          </div>
        )}
        {shown.map((row, i) => {
          // Each row maps back to its index inside its own side, so we
          // can pull the matching Shiki-highlighted line if available.
          const sideIdx = row.kind === "old"
            ? i
            : i - oldLines.length;
          const sideArr = row.kind === "old" ? oldHighlighted : newHighlighted;
          const highlightedHtml = sideArr ? sideArr[sideIdx] : null;
          const marker = row.kind === "old" ? "-" : "+";
          const markerFg = row.kind === "old" ? "rgb(248,113,113)" : "rgb(74,222,128)";
          const rowBg = row.kind === "old" ? "rgba(248,113,113,0.14)" : "rgba(74,222,128,0.13)";
          return (
            <div key={i} style={{ display: "flex", background: rowBg }}>
              <span style={{
                width: 36, flexShrink: 0,
                textAlign: "right", paddingRight: 8,
                color: "var(--c-ghost)", opacity: 0.55,
                fontSize: 11, userSelect: "none",
                lineHeight: 1.6,
              }}>{i + 1}</span>
              <span style={{
                width: 14, flexShrink: 0,
                color: markerFg, opacity: 0.9,
                userSelect: "none",
              }}>{marker}</span>
              {highlightedHtml ? (
                <span
                  style={{
                    flex: 1, color: "var(--c-high)",
                    whiteSpace: "pre-wrap", wordBreak: "break-all",
                    paddingRight: 8,
                  }}
                  dangerouslySetInnerHTML={{ __html: highlightedHtml || "&nbsp;" }}
                />
              ) : (
                <span style={{
                  flex: 1, color: "var(--c-high)",
                  whiteSpace: "pre-wrap", wordBreak: "break-all",
                  paddingRight: 8,
                }}>{row.text || " "}</span>
              )}
            </div>
          );
        })}
        {overflow > 0 && (
          <div style={{
            padding: "4px 8px 4px 50px",
            fontSize: 10.5, color: "var(--c-dim)",
          }}>
            … {overflow} more line{overflow === 1 ? "" : "s"} hidden
          </div>
        )}
      </div>
    </div>
  );
}

/** Lazily read + preview a file's content inside a Read tool card when the
 *  agent didn't surface the read output itself (e.g. Claude Code, which shows
 *  "Read main.py" but doesn't echo the file body in its stream). Fetches via
 *  the backend `/api/fs/file` endpoint and renders a Shiki-highlighted preview
 *  matching the card style. Silent (renders nothing) if the file can't be read. */
function ReadFilePreview({ filePath }: { filePath: string }) {
  const [content, setContent] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    backendFetch(`/api/fs/file?path=${encodeURIComponent(filePath)}`)
      .then((r) => r.json())
      .then((j: { content?: string; error?: string }) => {
        if (cancelled) return;
        if (typeof j.content === "string") setContent(j.content);
        else setFailed(true);
      })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [filePath]);

  const MAX = 8000;
  const truncated = (content?.length ?? 0) > MAX;
  const shown = content ? (truncated ? content.slice(0, MAX) : content) : "";
  const html = useShikiHTML(shown, langFromPath(filePath) || "text");

  if (failed) return null;
  if (content == null) {
    return (
      <div style={{ padding: "0 12px 10px", fontSize: 11.5, color: "var(--c-dim)", fontFamily: "var(--font-mono)" }}>
        Loading…
      </div>
    );
  }
  return (
    <pre style={{
      margin: 0, padding: "2px 12px 10px",
      fontSize: 12, lineHeight: 1.55, color: "var(--c-high)",
      fontFamily: "var(--font-mono)",
      overflowX: "auto", whiteSpace: "pre",
      maxHeight: 340, overflowY: "auto",
    }}>
      {html
        ? <code dangerouslySetInnerHTML={{ __html: stripShikiWrapper(html) }} />
        : <code>{shown}</code>}
      {truncated && (
        <div style={{ color: "var(--c-dim)", marginTop: 8, fontSize: 11 }}>… truncated</div>
      )}
    </pre>
  );
}

/** Captured Read output → IDE-style: a line-number gutter + Shiki syntax
 *  highlighting (the agent's `cat -n` output is plain otherwise). Parses the
 *  "  30→code" / "  30\tcode" prefix Claude emits; falls back to no-gutter
 *  highlighting when the output isn't line-numbered. */
function ReadOutputView({ output, filePath }: { output: string; filePath: string }) {
  const rawLines = output.replace(/\n+$/, "").split("\n");
  const parsed = rawLines.map((l) => {
    const m = l.match(/^\s*(\d+)(?:→|\t)(.*)$/);
    return m ? { num: m[1] as string | null, code: m[2] ?? "" } : { num: null, code: l };
  });
  const matched = parsed.filter((p) => p.num != null).length;
  const hasGutter = matched > Math.max(1, rawLines.length * 0.5);
  const rows = hasGutter ? parsed : rawLines.map((l) => ({ num: null as string | null, code: l }));
  const codeText = rows.map((r) => r.code).join("\n");
  const lang = langFromPath(filePath) || "text";
  const hl = useShikiLines(codeText, lang);

  return (
    <div style={{
      borderTop: "1px solid var(--sidebar-border)",
      maxHeight: 320, overflow: "auto",
      fontFamily: "var(--font-mono)", fontSize: 11.5, lineHeight: 1.6,
      padding: "6px 0",
    }}>
      {rows.map((r, i) => (
        <div key={i} style={{ display: "flex", whiteSpace: "pre" }}>
          {hasGutter && (
            <span style={{
              flexShrink: 0, width: 46, textAlign: "right", paddingRight: 14,
              color: "var(--c-ghost)", userSelect: "none",
            }}>{r.num}</span>
          )}
          <span style={{
            flex: 1, minWidth: 0, paddingLeft: hasGutter ? 0 : 12, paddingRight: 12,
            color: "var(--c-high)",
          }}>
            {hl && hl[i] != null
              ? <span dangerouslySetInnerHTML={{ __html: hl[i] }} />
              : (r.code || " ")}
          </span>
        </div>
      ))}
    </div>
  );
}

function renderToolDetail(
  toolName: string,
  input: Record<string, unknown>,
  output?: string,
  _isError?: boolean,
) {
  void _isError; // surfaced via the row's "failed" badge — body stays neutral

  // Bash: Claude-Desktop-style card — "Bash" header, `$ <command>`
  // and optional `<stdout>` below a hairline. Shell wrapper is
  // stripped so the user sees the real command, not the
  // /bin/zsh -lc 'CMD' boilerplate.
  if (toolName === "Bash" && "command" in input) {
    // While a command is mid-stream, the tool_result block hasn't been
    // pushed yet — but Codex's `command/exec/outputDelta` feeds live
    // stdout/stderr into the active tool's input as `_output`. Fall
    // through to that buffer when `output` is still empty so the user
    // watches the shell output tick in line-by-line instead of staring
    // at a bare `$ command` until the tool ends.
    const liveOut = (output ?? "").trim() ||
      (typeof input._output === "string" ? input._output.trim() : "");
    return (
      <BashView
        command={shortenFleetPath(stripShellWrapper(String(input.command)))}
        output={shortenFleetPath(liveOut)}
      />
    );
  }
  // Edit / Write: file header + unified-style diff. Old lines render
  // with a red gutter + red-tinted background; new lines green +
  // green-tinted. File path sits at the top with +N / −N counts so
  // the user can scan diff weight without expanding every card.
  if ((toolName === "Edit" || toolName === "Write" || toolName === "MultiEdit") && "file_path" in input) {
    return (
      <DiffView
        fpath={String(input.file_path)}
        oldText={String(input.old_string ?? "")}
        newText={String(input.new_string ?? input.content ?? "")}
      />
    );
  }
  // Lightweight fallbacks for non-code tools (Read, Grep, Agent, etc).
  // These detail bodies need their own padding because the outer
  // container is now edge-to-edge for the Bash / Edit headers above.
  const padBox = (children: React.ReactNode) => (
    <div style={{ padding: "10px 12px" }}>{children}</div>
  );
  // Shared output panel — appended below the input summary so Read /
  // Grep / Glob / MCP tools surface stdout the same way Bash does.
  // Without this the user expanded a tool row and saw only the query;
  // the actual result was invisible even though the bridge captured it.
  const outputBlock = shortenFleetPath((output ?? "").trim());
  const outputPanel = outputBlock ? (
    <pre style={{
      margin: "0",
      padding: "8px 12px",
      borderTop: "1px solid var(--sidebar-border)",
      fontFamily: "var(--font-mono)", fontSize: 11.5,
      color: "var(--c-med)",
      whiteSpace: "pre-wrap", wordBreak: "break-word",
      maxHeight: 280, overflowY: "auto",
    }}>{outputBlock.slice(0, 4000)}</pre>
  ) : null;
  const withOutput = (head: React.ReactNode) => (
    <>{head}{outputPanel}</>
  );
  if ("file_path" in input) {
    const pp = prettyFilePath(String(input.file_path));
    const fullPath = String(input.file_path);
    const pathHead = padBox(
      <span
        onClick={(e) => { e.stopPropagation(); useAppStore.getState().openFile(fullPath); }}
        style={{ fontSize: 12, fontFamily: "var(--font-mono)", cursor: "pointer" }}
        title={`Open ${fullPath} in the editor`}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.textDecoration = "underline"; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.textDecoration = "none"; }}
      >
        <span style={{ color: "var(--c-dim)" }}>{pp.dir}</span>
        <span style={{ color: "var(--c-high)", fontWeight: 500 }}>{pp.name}</span>
      </span>,
    );
    // When the agent captured the read output, show it. Read/View output is
    // file content — render it IDE-style (line-number gutter + Shiki colours)
    // instead of the flat mono panel. Other file tools keep the plain panel.
    if (outputBlock) {
      if (toolName === "Read" || toolName === "View" || toolName === "NotebookRead") {
        return <>{pathHead}<ReadOutputView output={outputBlock} filePath={fullPath} /></>;
      }
      return withOutput(pathHead);
    }
    if (toolName === "Read" || toolName === "View") {
      return (
        <>
          {pathHead}
          <ReadFilePreview filePath={String(input.file_path)} />
        </>
      );
    }
    return pathHead;
  }
  if ("pattern" in input) {
    return withOutput(padBox(
      <div style={{ fontSize: 11.5, fontFamily: "var(--font-mono)" }}>
        <span style={{ color: "rgba(251,146,60,0.8)" }}>{String(input.pattern)}</span>
        {input.path != null && <span style={{ color: "var(--c-dim)" }}> in {shortenFleetPath(String(input.path))}</span>}
      </div>
    ));
  }
  if ("description" in input || "prompt" in input) {
    return withOutput(padBox(
      <div style={{ fontSize: 12, color: "var(--c-med)", lineHeight: 1.5 }}>
        {String(input.description ?? input.prompt ?? "").slice(0, 240)}
      </div>
    ));
  }
  // Strip Fleet-internal bookkeeping keys (_kind / _title) and empty
  // discriminator-only shapes like `action: {type: "other"}` before
  // falling back to the JSON dump. Without this, a webSearch with no
  // query renders as a verbose JSON brick exposing internal fields —
  // exactly the noisy thing the user flagged.
  const INTERNAL_KEYS = new Set(["_kind", "_title"]);
  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (INTERNAL_KEYS.has(k)) continue;
    if (v == null) continue;
    if (typeof v === "string" && v.trim() === "") continue;
    // Discriminator-only sub-object (e.g. {type: "other"}) — drop it.
    if (
      typeof v === "object" && !Array.isArray(v)
      && Object.keys(v as object).length === 1
      && "type" in (v as object)
    ) continue;
    cleaned[k] = v;
  }
  if (Object.keys(cleaned).length === 0) {
    // Nothing useful to show — render a minimal dim hint instead of
    // an empty bracket pair or the discarded JSON.
    return withOutput(padBox(
      <span style={{ fontSize: 11.5, color: "var(--c-dim)", fontStyle: "italic" }}>
        no further details
      </span>
    ));
  }
  return withOutput(padBox(
    <pre style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--c-dim)", margin: 0, maxHeight: 140, overflowY: "auto" }}>
      {JSON.stringify(cleaned, null, 2)}
    </pre>
  ));
}

/* ── Copy button ── */
/* ── Icon-only copy button — used in the right-sidebar-style headers
   above Bash and Edit details. Smaller than CopyButton and shows the
   icon alone so the header line stays compact. */
function CopyIconOnly({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    });
  }, [text]);
  return (
    <button
      onClick={copy}
      title={copied ? "Copied" : "Copy"}
      style={{
        display: "flex", alignItems: "center", justifyContent: "center",
        width: 22, height: 22,
        background: "transparent", border: "none",
        cursor: "pointer", borderRadius: 4,
        color: copied ? "var(--c-high)" : "var(--c-ghost)",
        transition: "color 0.1s, background 0.1s",
      }}
      onMouseEnter={e => { e.currentTarget.style.background = "var(--c-srf)"; e.currentTarget.style.color = "var(--c-med)"; }}
      onMouseLeave={e => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = copied ? "var(--c-high)" : "var(--c-ghost)"; }}
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
    </button>
  );
}

/* ── Code block ── */
// Connector glyphs that mark an ASCII flow diagram (arrows + box-drawing
// + flow triangles).
const DIAGRAM_GLYPHS = "→←↑↓↔⟶⟵⇒⇐⇄➜➝▸◂▶◀▼▲▾▴▿▵‣│─━┃┌┐└┘├┤┬┴┼╮╯╰╭╱╲";
const DIAGRAM_RE = new RegExp(`[${DIAGRAM_GLYPHS}]`);
const DIAGRAM_SPLIT = new RegExp(`([${DIAGRAM_GLYPHS}]+)`);

/** A fenced block reads as a flow diagram when it's plain text (no real
 *  language) and carries ≥2 unicode connector glyphs — which ordinary code
 *  essentially never does. */
function looksLikeDiagram(text: string, language: string): boolean {
  const lang = (language || "").toLowerCase();
  if (lang && !["text", "txt", "plain", "plaintext", "diagram", "flow", "ascii"].includes(lang)) {
    return false;
  }
  const matches = text.match(new RegExp(`[${DIAGRAM_GLYPHS}]`, "g"));
  return (matches?.length ?? 0) >= 2;
}

/** ASCII flow diagram → readable visual: monospace structure preserved, but
 *  connectors (arrows / box rules) lifted into the accent color so the flow
 *  pops, and ALL-CAPS state words gently emphasized. Airy line-height. */
function DiagramBlock({ text }: { text: string }) {
  const lines = text.replace(/\n+$/, "").split("\n");
  return (
    <div style={{
      margin: "12px 0", borderRadius: 10, overflow: "hidden",
      border: "1px solid var(--sidebar-border)",
      background: "color-mix(in srgb, var(--sidebar) 55%, transparent)",
    }}>
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "7px 12px 3px", fontSize: 9.5, color: "var(--c-dim)",
        letterSpacing: "0.1em", textTransform: "uppercase",
      }}>
        <span>Flow</span>
        <CopyIconOnly text={text} />
      </div>
      {/* Monospace alignment is sacred — ASCII art lives or dies by it. Style
          with COLOR ONLY below: any font-weight (faux-bold widens glyphs) or
          letter-spacing shifts columns and bends the diagram. Tight-ish
          line-height so vertical │/▼ connectors read as continuous. */}
      <div style={{
        padding: "6px 14px 12px", fontFamily: "var(--font-mono)",
        fontSize: 12.5, lineHeight: 1.5, color: "var(--c-dim)",
        overflowX: "auto", whiteSpace: "pre",
      }}>
        {lines.map((line, i) => (
          <div key={i}>
            {line === "" ? " " : line.split(DIAGRAM_SPLIT).map((seg, j) => {
              if (!seg) return null;
              if (DIAGRAM_RE.test(seg)) {
                return <span key={j} style={{ color: "rgb(64,180,120)" }}>{seg}</span>;
              }
              // Emphasize ALL-CAPS state words (PROBLEM, KAYDET, OCR…).
              return seg.split(/(\b[A-ZÇĞİÖŞÜ]{3,}\b)/).map((w, k) =>
                /^[A-ZÇĞİÖŞÜ]{3,}$/.test(w)
                  ? <span key={`${j}-${k}`} style={{ color: "var(--c-high)" }}>{w}</span>
                  : <span key={`${j}-${k}`}>{w}</span>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

function CodeBlock({ language, children }: { language: string; children: string }) {
  const isDiagram = looksLikeDiagram(children, language);
  const highlighted = useShikiHTML(children, isDiagram ? "text" : language || "text");
  const inner = highlighted ? stripShikiWrapper(highlighted) : null;
  if (isDiagram) return <DiagramBlock text={children} />;

  return (
    <div style={{ margin: "12px 0", borderRadius: 8, overflow: "hidden", border: "1px solid var(--sidebar-border)", background: "var(--sidebar)", fontFamily: "var(--font-mono)" }}>
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "8px 12px 2px",
        fontSize: 10.5, color: "var(--c-dim)",
      }}>
        <span>{language || "code"}</span>
        <CopyIconOnly text={children} />
      </div>
      <pre style={{
        margin: 0, padding: "4px 12px 12px",
        fontSize: 12.5, lineHeight: 1.6,
        color: "var(--c-high)",
        overflowX: "auto", whiteSpace: "pre",
      }}>
        {inner
          ? <code dangerouslySetInnerHTML={{ __html: inner }} />
          : <code>{children}</code>
        }
      </pre>
    </div>
  );
}

/* ── Markdown components ── */
const mdComponents: Components = {
  code({ className, children }) {
    const lang = className?.replace("language-", "") ?? "";
    const raw = String(children ?? "");
    // Inline vs block: react-markdown gives no className to BOTH inline code
    // AND no-language fenced blocks (```\n…\n```), so keying off className
    // alone mis-rendered language-less fenced blocks (e.g. ASCII flow
    // diagrams) as inline pills. A fenced block always carries a newline;
    // inline code never does — so the newline is the reliable signal.
    const isBlock = !!className || raw.includes("\n");
    if (!isBlock) {
      return (
        <code style={{
          fontFamily: "var(--font-mono)", fontSize: "0.86em",
          background: "var(--c-srf)", padding: "2px 6px",
          borderRadius: 5, color: "var(--c-high)",
          border: "1px solid var(--c-brd)",
          letterSpacing: "-0.005em",
        }}>{children}</code>
      );
    }
    return <CodeBlock language={lang}>{raw.replace(/\n$/, "")}</CodeBlock>;
  },
  p({ children }) {
    return <p style={{ margin: "0 0 14px", lineHeight: 1.65, fontSize: 14, color: "var(--c-high)" }}>{children}</p>;
  },
  ul({ children }) { return <ul style={{ paddingLeft: 20, margin: "0 0 14px", listStyleType: "disc" }}>{children}</ul>; },
  ol({ children }) { return <ol style={{ paddingLeft: 20, margin: "0 0 14px" }}>{children}</ol>; },
  li({ children }) { return <li style={{ marginBottom: 5, lineHeight: 1.65, fontSize: 14, color: "var(--c-high)" }}>{children}</li>; },
  h1({ children }) {
    return <h1 style={{ fontSize: 18, fontWeight: 700, margin: "8px 0 12px", letterSpacing: "-0.025em", color: "var(--c-high)" }}>{children}</h1>;
  },
  h2({ children }) {
    return (
      <h2 style={{ fontSize: 15.5, fontWeight: 650, margin: "24px 0 10px", letterSpacing: "-0.018em", color: "var(--c-high)" }}>
        {children}
      </h2>
    );
  },
  h3({ children }) {
    return <h3 style={{ fontSize: 14, fontWeight: 600, margin: "18px 0 8px", letterSpacing: "-0.01em", color: "var(--c-high)" }}>{children}</h3>;
  },
  blockquote({ children }) {
    return (
      <blockquote style={{
        margin: "14px 0", paddingLeft: 16,
        borderLeft: "2px solid var(--c-brd2)",
        color: "var(--c-low)",
        fontStyle: "normal",
      }}>{children}</blockquote>
    );
  },
  strong({ children }) { return <strong style={{ fontWeight: 600, color: "var(--c-high)" }}>{children}</strong>; },
  // A remote image loads only after a click.
  img: AskImage,
  // `a` is intentionally NOT defined here — MarkdownBody injects a
  // store-aware version so file-shaped hrefs can route to openFile()
  // instead of opening externally.
  table({ children }) {
    // Same frame as the Bash / code card — radius 8, --sidebar-border,
    // --sidebar bg — so every "box" in a message reads as one design family.
    return (
      <div style={{
        margin: "12px 0",
        borderRadius: 8,
        overflow: "hidden",
        border: "1px solid var(--sidebar-border)",
        background: "var(--sidebar)",
      }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>{children}</table>
      </div>
    );
  },
  th({ children }) {
    return <th style={{
      padding: "9px 14px",
      borderBottom: "1px solid var(--sidebar-border)",
      textAlign: "left",
      fontWeight: 600,
      color: "var(--c-dim)",
      fontSize: 10.5,
      letterSpacing: "0.06em",
      textTransform: "uppercase",
      verticalAlign: "middle",
    }}>{children}</th>;
  },
  td({ children }) {
    return <td style={{
      padding: "10px 14px",
      borderBottom: "1px solid var(--sidebar-border)",
      color: "var(--c-high)",
      fontSize: 13,
      lineHeight: 1.45,
      verticalAlign: "middle",
    }}>{children}</td>;
  },
  hr() {
    return <hr style={{ border: "none", borderTop: "1px solid var(--sidebar-border)", margin: "16px 0" }} />;
  },
};

/* ── File-extension allow-list for the link-as-file heuristic ─────────
 * Hrefs whose final segment ends in one of these are treated as
 * project-relative file paths and route through openFile() instead of
 * opening externally. Errs on the side of "common code / text / config"
 * extensions — markdown links to documentation URLs (which usually
 * carry no extension or end in .html on a host with a scheme) are
 * unaffected. */
const FILE_EXT_RE = new RegExp(
  "\\.(go|java|kt|kts|ts|tsx|js|jsx|mjs|cjs|py|pyi|rb|php|swift|" +
  "rs|c|cc|cpp|h|hpp|cs|scala|clj|cljs|ex|exs|elm|fs|fsx|dart|lua|r|m|mm|" +
  "html|htm|css|scss|sass|less|vue|svelte|astro|" +
  "json|jsonc|yaml|yml|toml|ini|env|conf|xml|md|mdx|markdown|txt|rst|" +
  "sh|bash|zsh|fish|ps1|bat|cmd|" +
  "sql|graphql|gql|proto|prisma|" +
  "dockerfile|makefile|gemfile|rakefile" +
  ")$",
  "i"
);

/** Quick "looks like a real URL" gate — anything with a known network
 *  scheme or starting with // is treated as external. Everything else
 *  is a candidate for the file-path heuristic. */
function isExternalHref(href: string): boolean {
  if (!href) return false;
  if (href.startsWith("//")) return true;
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return true; // http: https: mailto: file: ftp: etc
  if (href.startsWith("#")) return true;
  return false;
}

/** Parse a markdown href into a file-open target. Returns null if the
 *  href doesn't look like an in-project file path. Supports common
 *  line-suffix conventions emitted by language servers, jadx, ripgrep
 *  and the models themselves:
 *
 *    foo/bar.java
 *    foo/bar.java:41
 *    foo/bar.java:41:5
 *    foo/bar.java#L41
 *
 *  The trailing :LINE / :LINE:COL / #LNN gets stripped before the
 *  extension check (otherwise FILE_EXT_RE wouldn't match) and parsed
 *  out as `line` / `col` for the caller. */
function parseFileHref(href: string): { path: string; line?: number; col?: number } | null {
  if (!href || isExternalHref(href)) return null;

  // 1) Drop ?query first.
  let s = href.split("?")[0] ?? "";

  // 2) #L<NN> (github-style) → line. Anything else after # we drop.
  let line: number | undefined;
  const hashIdx = s.indexOf("#");
  if (hashIdx >= 0) {
    const frag = s.slice(hashIdx + 1);
    const m = /^L(\d+)$/.exec(frag);
    if (m && m[1]) line = parseInt(m[1], 10);
    s = s.slice(0, hashIdx);
  }

  // 3) Trailing :LINE or :LINE:COL — only valid AFTER a known
  //    extension, so a path like `/Users:foo` (no extension) doesn't
  //    get mis-parsed.
  let col: number | undefined;
  const colonMatch = /^(.*?\.[A-Za-z0-9]+)(?::(\d+))(?::(\d+))?$/.exec(s);
  if (colonMatch && colonMatch[1]) {
    s = colonMatch[1];
    if (line === undefined && colonMatch[2]) line = parseInt(colonMatch[2], 10);
    if (colonMatch[3]) col = parseInt(colonMatch[3], 10);
  }

  if (!s) return null;
  const last = s.split("/").pop() ?? "";
  if (!FILE_EXT_RE.test(last)) return null;
  return { path: s, line, col };
}

/** Internal routing tokens never belong in the rendered markdown.
 *  Backend handlers process them and SHOULD strip — but if a stale
 *  row or a still-streaming buffer slips through, the renderer is
 *  the last line of defence. Pure regex pass — no side effects. */
function stripInternalTokens(text: string): string {
  return text
    .replace(READ_AGENT_RE, "")
    .replace(DIRECT_DISPATCH_RE, "")
    .replace(DISPATCH_RAW_RE, "")
    .replace(SPAWN_RAW_RE, "")
    .replace(SPAWN_PARTIAL_RE, "")
    .replace(REMEMBER_USER_RE, "")
    .replace(REMEMBER_USER_PARTIAL_RE, "")
    .replace(/\n{3,}/g, "\n\n");
}

/** How many spawn directives the live stream carries — complete tokens plus
 *  one in flight (opened but not yet closed). Drives the "creating N
 *  agents" live label while the raw tokens themselves stay masked. */
function countSpawnTokens(text: string): number {
  const complete = text.match(SPAWN_RAW_RE)?.length ?? 0;
  const partial = SPAWN_PARTIAL_RE.test(text.replace(SPAWN_RAW_RE, "")) ? 1 : 0;
  return complete + partial;
}

function MarkdownBodyInner({ text }: { text: string }) {
  const openFile = useAppStore(s => s.openFile);
  const activeSession = useAppStore(s => {
    const sid = s.activeSessionId;
    return sid ? s.sessions.find(x => x.id === sid) ?? null : null;
  });
  const projectRoot = activeSession?.project_path ?? "";

  const components: Components = useMemo(() => ({
    ...mdComponents,
    a({ children, href }) {
      const parsed = href ? parseFileHref(href) : null;
      if (parsed) {
        const resolved = parsed.path.startsWith("/")
          ? parsed.path
          : projectRoot ? `${projectRoot.replace(/\/$/, "")}/${parsed.path}` : parsed.path;
        const tip = parsed.line
          ? `Open ${parsed.path}:${parsed.line}${parsed.col ? `:${parsed.col}` : ""}`
          : `Open ${parsed.path}`;
        return (
          <a
            href={href}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              openFile(resolved);
            }}
            title={tip}
            style={{
              color: "#58a6ff",
              textDecoration: "none",
              cursor: "pointer",
            }}
            onMouseEnter={e => e.currentTarget.style.textDecoration = "underline"}
            onMouseLeave={e => e.currentTarget.style.textDecoration = "none"}
          >
            {children}
          </a>
        );
      }
      // Anything else goes where a link may take the user (MarkdownLink): the
      // system browser for another site, never the app's own window. A
      // target="_blank" link opened nothing: Tauri's webview swallows it.
      return (
        <MarkdownLink
          href={href}
          style={{ color: "#58a6ff", textDecoration: "none" }}
          onMouseEnter={e => e.currentTarget.style.textDecoration = "underline"}
          onMouseLeave={e => e.currentTarget.style.textDecoration = "none"}
        >
          {children}
        </MarkdownLink>
      );
    },
  }), [openFile, projectRoot]);

  return (
    <div style={{ color: "var(--foreground)" }}>
      {/* markdownUrlTransform keeps a `data:` image, which react-markdown's
          default drops. */}
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]} components={components} urlTransform={markdownUrlTransform}>{stripInternalTokens(text)}</ReactMarkdown>
    </div>
  );
}

/**
 * Memoised wrapper. StreamingMessage maps over `contentSoFar`,
 * rendering a MarkdownBody per text/thinking block. Every streaming
 * token mutates the LAST block's text, which causes contentSoFar
 * to be a new array → StreamingMessage re-renders → every previous
 * MarkdownBody (with unchanged text) gets re-walked too, re-running
 * remark/rehype parsing on text that didn't change. With a long
 * assistant turn that interleaves text + tools, this re-parses N-1
 * stable markdown blocks per token. React.memo on text means only
 * the actively-growing block parses on each delta; the older blocks
 * bail out immediately. Store hooks inside the inner component
 * still subscribe externally, so a real change to activeSession /
 * openFile re-renders correctly regardless of memo.
 */
export const MarkdownBody = React.memo(MarkdownBodyInner, (prev, next) => prev.text === next.text);

/* ── Tool call row ──
   Claude-Desktop-style summary chip: "Ran <thing>" or "Read <file>"
   with a small chevron. Click to expand into the detail card
   (`renderToolDetail` paints the actual Bash/Edit/etc. card body)
   plus the tool's output (stdout / stderr / file contents). */
function ToolCallRow({ toolName, toolKind, input, output, isError, forceOpen }: {
  toolName: string;
  toolKind?: string;
  input: Record<string, unknown>;
  /** Result payload from the matching tool_result block. Undefined
   *  while the tool is still running, populated once it returns. */
  output?: string;
  isError?: boolean;
  /** When true, the row's expandable detail section is locked
   *  open. Driven by Verbose transcript view — the user wants
   *  to see every tool's raw payload without clicking each row. */
  forceOpen?: boolean;
}) {
  const [openLocal, setOpen] = useState(false);
  const open = forceOpen || openLocal;
  void toolKind; // legacy plumbing — kept on the prop for ToolGroup callers
  const summary = rowSummary(toolName, input);

  // Claude Code Desktop pattern: each tool action is a single line of
  // body-color text with the chevron at the END (not the start) and no
  // leading icon. The expand surface is the entire row; hover darkens
  // the background subtly. The heavy diff/output card only appears
  // BELOW the row when the user opens it.
  return (
    <div style={{ margin: "2px 0" }}>
      <button
        onClick={() => { if (!forceOpen) setOpen(!openLocal); }}
        style={{
          display: "inline-flex", alignItems: "center", gap: 6,
          padding: 0,
          background: "transparent", border: "none",
          cursor: forceOpen ? "default" : "pointer",
          textAlign: "left",
          color: "inherit",
        }}
      >
        <span style={{
          fontSize: 13, fontWeight: 400,
          color: "var(--c-low)",
          letterSpacing: "-0.005em",
        }}
          onMouseEnter={e => { if (!forceOpen) (e.currentTarget as HTMLElement).style.color = "var(--c-med)"; }}
          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = "var(--c-low)"; }}
        >
          {summary}
        </span>
        {isError && (
          <span style={{
            fontSize: 11, fontWeight: 500,
            color: "rgb(248,113,113)",
            fontFamily: "var(--font-mono)",
          }}>
            failed
          </span>
        )}
        <ChevronRight size={12} style={{
          color: "var(--c-ghost)",
          transform: open ? "rotate(90deg)" : "none",
          transition: "transform 220ms cubic-bezier(0.32, 0.72, 0, 1)",
        }} />
      </button>

      {/* Grid-row trick gives us a smooth 0fr → 1fr → 0fr height
          animation without measuring the content. The chevron rotation
          + opacity fade run in step, so opening/closing feels like
          one motion instead of pop-in / pop-out. */}
      <div style={{
        display: "grid",
        gridTemplateRows: open ? "1fr" : "0fr",
        opacity: open ? 1 : 0,
        transition: "grid-template-rows 220ms cubic-bezier(0.32, 0.72, 0, 1), opacity 200ms ease",
      }}>
        <div style={{ overflow: "hidden", minHeight: 0 }}>
          <div style={{
            margin: "6px 0 10px 0",
            borderRadius: 8,
            border: "1px solid var(--sidebar-border)",
            background: "var(--sidebar)",
            overflow: "hidden",
          }}>
            {renderToolDetail(toolName, input, output, isError)}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Tool group ──
   Claude Code Desktop collapses consecutive tool actions into a single
   "Edited a file, used N tools v" summary line; expanding it reveals
   the individual rows. Keeps the chat scannable when the model fires
   off five reads / two edits in a row — instead of five floating cards
   the user sees one summary, expands it on demand. */

/* ─── Sub-agent dispatch chat row ───
 *
 * Renders the "Ran agent Opus 4.7 MW3 security audit" line we see in
 * Claude Code Desktop's parent chat — one slim row per Task tool
 * dispatch. Clicking the row focuses the Agent pane on that sub-agent
 * and pops the right panel open (if it isn't already). The row
 * mirrors live state from the matching SubagentTask entry: pulsing
 * blue dot while running, a checkmark when complete.
 *
 * Matched to its task via tool_use_id — the parent tool_use that
 * triggered the dispatch is the tool_use_id field on TaskStartedMessage.
 */
function SubagentChatRow({
  toolUseId,
  fallbackTitle,
}: {
  toolUseId: string;
  fallbackTitle: string;
}) {
  // Per-field selectors — `useAppStore()` with no selector
  // subscribed every SubagentChatRow to the entire app store, so a
  // single notification push or pane-focus change re-rendered every
  // dispatch row in the chat.
  const activeSessionId = useAppStore(s => s.activeSessionId);
  const staffSessionId = useAppStore(s => s.staffSessionId);
  const sid = activeSessionId || staffSessionId;
  const subagentTasks = useChatStore(s => selectSession(sid)(s).subagentTasks);
  const setSelected = useChatStore(s => s.setSelectedSubagentTask);
  const addView = useAppStore(s => s.addWorkspaceView);

  // Match the SubagentTask by the parent's tool_use.id. The SDK's
  // TaskStartedMessage carries this in tool_use_id, which the bridge
  // copies onto our SubagentTask.toolUseId.
  const task = useMemo(() => {
    return Object.values(subagentTasks).find(t => t.toolUseId === toolUseId)
      ?? null;
  }, [subagentTasks, toolUseId]);

  const onClick = () => {
    if (!task || !sid) return;
    setSelected(sid, task.id);
    try { addView("process"); } catch { /* noop */ }
  };

  const running = task?.status === "running";
  const failed = task && (task.status === "failed" || task.status === "stopped");
  const title = task?.description ?? fallbackTitle;

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!task}
      style={{
        display: "inline-flex", alignItems: "center", gap: 7,
        padding: "3px 0",
        margin: "2px 0",
        background: "transparent", border: "none",
        cursor: task ? "pointer" : "default",
        fontSize: 13, color: "var(--c-low)",
        letterSpacing: "-0.005em",
        textAlign: "left",
        fontFamily: "inherit",
      }}
      onMouseEnter={e => {
        if (task) (e.currentTarget as HTMLElement).style.color = "var(--c-med)";
      }}
      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = "var(--c-low)"; }}
    >
      <span style={{
        flexShrink: 0,
        width: 10, height: 10,
        display: "inline-flex", alignItems: "center", justifyContent: "center",
      }}>
        {running ? (
          <span style={{
            width: 7, height: 7, borderRadius: "50%",
            background: "#3b82f6",
            boxShadow: "0 0 0 2.5px rgba(59,130,246,0.18)",
            animation: "fleetPulse 1.4s ease-in-out infinite",
          }}/>
        ) : failed ? (
          <X size={10} strokeWidth={2.4} color="#f87171" />
        ) : (
          <Check size={10} strokeWidth={2.4} color="var(--c-ghost)" />
        )}
      </span>
      <span>
        Ran agent{" "}
        <span style={{ color: "var(--c-med)", fontWeight: 500 }}>{title}</span>
      </span>
      {task && <ChevronRight size={11} style={{ color: "var(--c-ghost)" }} />}
    </button>
  );
}

function ToolGroup({ tools, results, forceOpen, dropTools }: {
  tools: Array<{
    tool_id?: string;
    tool_name?: string;
    name?: string;
    tool_kind?: string;
    input?: Record<string, unknown>;
  }>;
  results: Record<string, { output: string; is_error: boolean }>;
  forceOpen?: boolean;
  dropTools?: boolean;
}) {
  const [openLocal, setOpen] = useState(false);
  const open = forceOpen || openLocal;

  if (dropTools || tools.length === 0) return null;

  // Single tool runs render flat — the group wrapper would only add
  // noise (an extra "1 tool" header on top of the row that already
  // shows the verb and target).
  if (tools.length === 1) {
    const t = tools[0]!;
    const result = t.tool_id ? results[t.tool_id] : undefined;
    return (
      <ToolCallRow
        toolName={t.tool_name || t.name || ""}
        toolKind={t.tool_kind}
        input={t.input || {}}
        output={result?.output}
        isError={result?.is_error}
        forceOpen={forceOpen}
      />
    );
  }

  // Claude Code Desktop summary pattern: describe each verb bucket as
  // its own phrase ("edited a file" / "ran 2 commands") and join them
  // with commas — e.g. "Edited a file, ran 2 commands". A single-verb
  // run collapses to "Edited 4 files" / "Ran 2 commands". The user only
  // needs the headline at this level; the rows below carry the detail.
  const verbBuckets = new Map<string, number>();
  let errorCount = 0;
  for (const t of tools) {
    const meta = getToolMeta(t.tool_name || t.name || "", t.tool_kind);
    verbBuckets.set(meta.verb, (verbBuckets.get(meta.verb) ?? 0) + 1);
    if (t.tool_id && results[t.tool_id]?.is_error) errorCount++;
  }
  const pastVerb: Record<string, string> = {
    Run: "ran", Read: "read", Edit: "edited", Write: "wrote",
    Glob: "globbed", Search: "searched", Fetch: "fetched",
    Web: "searched the web", Tasks: "updated", Agent: "dispatched",
    Move: "moved", Delete: "deleted", Think: "thought",
  };
  const target: Record<string, [string, string]> = {
    // [singular, plural]
    Edit:  ["a file",  "files"],
    Write: ["a file",  "files"],
    Read:  ["a file",  "files"],
    Run:   ["a command", "commands"],
    Glob:  ["a pattern", "patterns"],
    Search:["a search", "searches"],
    Fetch: ["a request","requests"],
    Web:   ["the web", "the web"],
    Tasks: ["todos",   "todos"],
    Agent: ["an agent","agents"],
    Move:  ["a file",  "files"],
    Delete:["a file",  "files"],
  };
  const phrases: string[] = [];
  for (const [verb, count] of verbBuckets) {
    const word = pastVerb[verb] || verb.toLowerCase();
    const [sg, pl] = target[verb] || ["one thing", "things"];
    phrases.push(count === 1 ? `${word} ${sg}` : `${word} ${count} ${pl}`);
  }
  // Capitalize the leading phrase: "Edited a file, ran 2 commands".
  const summary = phrases.length
    ? phrases[0]!.charAt(0).toUpperCase() + phrases[0]!.slice(1) +
      (phrases.length > 1 ? ", " + phrases.slice(1).join(", ") : "")
    : `Used ${tools.length} tools`;

  return (
    <div style={{ margin: "2px 0" }}>
      <button
        onClick={() => { if (!forceOpen) setOpen(!openLocal); }}
        style={{
          display: "inline-flex", alignItems: "center", gap: 6,
          padding: 0,
          background: "transparent", border: "none",
          cursor: forceOpen ? "default" : "pointer",
          textAlign: "left",
          color: "inherit",
        }}
      >
        <span style={{
          fontSize: 13, fontWeight: 400,
          color: "var(--c-low)",
          letterSpacing: "-0.005em",
        }}
          onMouseEnter={e => { if (!forceOpen) (e.currentTarget as HTMLElement).style.color = "var(--c-med)"; }}
          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = "var(--c-low)"; }}
        >
          {summary}
        </span>
        {errorCount > 0 && (
          <span style={{
            fontSize: 11.5, fontWeight: 500,
            color: "rgb(248,113,113)",
            fontFamily: "var(--font-mono)",
          }}>
            {errorCount} failed
          </span>
        )}
        <ChevronRight size={12} style={{
          color: "var(--c-ghost)",
          transform: open ? "rotate(90deg)" : "none",
          transition: "transform 220ms cubic-bezier(0.32, 0.72, 0, 1)",
        }} />
      </button>

      {/* Same grid-row animation as ToolCallRow so the group + its
          inner rows feel like one continuous expand instead of two
          independent toggles. */}
      <div style={{
        display: "grid",
        gridTemplateRows: open ? "1fr" : "0fr",
        opacity: open ? 1 : 0,
        transition: "grid-template-rows 220ms cubic-bezier(0.32, 0.72, 0, 1), opacity 200ms ease",
      }}>
        <div style={{ overflow: "hidden", minHeight: 0 }}>
          <div style={{
            margin: "4px 0 8px 0",
            padding: "6px 12px",
            borderRadius: 8,
            border: "1px solid var(--sidebar-border)",
            background: "var(--sidebar)",
          }}>
            {tools.map((t, i) => {
              const result = t.tool_id ? results[t.tool_id] : undefined;
              return (
                <ToolCallRow
                  key={t.tool_id || i}
                  toolName={t.tool_name || t.name || ""}
                  toolKind={t.tool_kind}
                  input={t.input || {}}
                  output={result?.output}
                  isError={result?.is_error}
                  forceOpen={forceOpen}
                />
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Message stats + copy row ── */
function MessageStatsRow({ message, hovered, toolOnly = false, thinkingBursts = [], forceThoughtsOpen = false }: { message: ChatMessage; hovered: boolean; toolOnly?: boolean; thinkingBursts?: Array<{ text: string; durationMs?: number }>; forceThoughtsOpen?: boolean }) {
  const { usage, cost_usd, duration_ms } = message;
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  // The Fleetify mark doubles as the thoughts toggle: click it to reveal the
  // model's reasoning bursts inline below the stats row. Recedes to a static
  // signature when the message has no thinking.
  const [thoughtsOpen, setThoughtsOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Toggle the reasoning panel WITHOUT moving the viewport. Expanding/
  // collapsing changes the message height, and Lenis (smooth scroll) +
  // browser scroll-anchoring otherwise drift the page. We pin the chat
  // scroll container's scrollTop for a few frames across the open/close so
  // the clicked row stays exactly where it is.
  const toggleThoughts = useCallback(() => {
    const sc = rootRef.current?.closest("[data-chat-scroll]") as HTMLElement | null;
    if (!sc) { setThoughtsOpen(v => !v); return; }
    const pinned = sc.scrollTop;
    const startedAt = Date.now();
    const hold = () => {
      sc.scrollTop = pinned;
      if (Date.now() - startedAt < 360) requestAnimationFrame(hold);
    };
    setThoughtsOpen(v => !v);
    requestAnimationFrame(hold);
  }, []);
  // Per-field selectors so the stats row doesn't re-render on every
  // notification / draft / pane-focus change. With one stats row per
  // assistant message and dozens of messages on screen, this was
  // multiplying every app-store mutation by N.
  const activeSessionId = useAppStore(s => s.activeSessionId);
  const staffSessionId = useAppStore(s => s.staffSessionId);

  const fullText = message.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map(b => stripDispatch(b.text)).join("\n\n");

  const copy = useCallback(() => {
    navigator.clipboard.writeText(fullText).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [fullText]);

  // One-click "save this message to long-term memory". Auto-extracts a
  // title from the first non-empty line (truncated to ~80 chars), saves
  // the full body as content with kind="note". User can refine title /
  // change kind from the right-sidebar Memory section.
  const saveToMemory = useCallback(async () => {
    const sid = activeSessionId || staffSessionId;
    if (!sid || !fullText.trim() || saving) return;
    // Heuristic title — first non-empty line, strip markdown chrome.
    const firstLine = fullText
      .split("\n")
      .map(l => l.trim())
      .find(l => l.length > 0) ?? "Saved message";
    const cleanTitle = firstLine
      .replace(/^#+\s*/, "")          // markdown headers
      .replace(/^[-*•]\s*/, "")       // list bullets
      .replace(/^\*\*(.+?)\*\*$/, "$1") // bold-only
      .slice(0, 120) || "Saved message";
    setSaving(true);
    try {
      await createSessionMemory(sid, {
        title: cleanTitle,
        content: fullText,
        kind: "note",
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2400);
    } catch (err) {
      console.error("Save to memory failed:", err);
    } finally {
      setSaving(false);
    }
  }, [activeSessionId, staffSessionId, fullText, saving]);

  const outputTok = usage?.output_tokens ?? 0;
  const cacheTok  = usage?.cache_read_tokens ?? 0;

  // Cost is intentionally NOT surfaced in the per-message footer.
  void cost_usd;

  const hasThoughts = thinkingBursts.length > 0;
  const thoughtMs = thinkingBursts.reduce((a, b) => a + (b.durationMs ?? 0), 0);
  const open = thoughtsOpen || forceThoughtsOpen;

  // Structured meta segments rendered as discrete tokens (icon-led) rather
  // than one mono string — easier to scan: ⏱ time · ↑ tokens · ⛁ cached.
  const segs: Array<{ icon: React.ReactNode; text: string }> = [];
  if (duration_ms != null && duration_ms > 0) {
    segs.push({ icon: <Clock size={10} strokeWidth={1.9} />, text: fmtDuration(duration_ms) });
  }
  if (outputTok > 0) {
    segs.push({ icon: <ArrowUp size={10} strokeWidth={2} />, text: `${fmtTokens(outputTok)} tok` });
  }
  if (cacheTok > 0) {
    segs.push({ icon: <Database size={10} strokeWidth={1.8} />, text: `${fmtTokens(cacheTok)} cached` });
  }

  const hasMeta = segs.length > 0;
  const showRow = hasMeta || hasThoughts || !toolOnly;
  if (!showRow) return null;

  return (
    <div ref={rootRef} style={{ marginTop: 6 }}>
    <div style={{
      display: "flex", alignItems: "center", gap: 9,
      minHeight: 22,
      opacity: (hasMeta || hasThoughts || hovered) ? (hovered ? 1 : 0.5) : 0,
      transition: "opacity 0.2s",
    }}>
      {/* Fleetify mark — ALWAYS present at the foot of an assistant message.
          When the message has reasoning, it's a button: click to reveal the
          thoughts inline below. A subtle "Thought {time}" label sits beside
          it so the affordance is discoverable; otherwise it's a quiet static
          signature. */}
      {hasThoughts ? (
        <button
          type="button"
          onClick={toggleThoughts}
          title={open ? "Hide reasoning" : "Show reasoning"}
          style={{
            display: "inline-flex", alignItems: "center", gap: 6,
            padding: "2px 6px 2px 2px", marginLeft: -2,
            background: open ? "rgba(var(--fg-rgb),0.06)" : "none",
            border: "none", outline: "none", cursor: "pointer", borderRadius: 5,
            color: open ? "var(--c-med)" : "var(--c-dim)",
            transition: "background 0.12s, color 0.12s",
            flexShrink: 0,
          }}
          onMouseEnter={e => { e.currentTarget.style.background = "rgba(var(--fg-rgb),0.06)"; e.currentTarget.style.color = "var(--c-med)"; }}
          onMouseLeave={e => { if (!open) { e.currentTarget.style.background = "none"; e.currentTarget.style.color = "var(--c-dim)"; } }}
        >
          <LogoMark size={12} glow={open} style={{ flexShrink: 0, color: open ? "var(--c-high)" : "var(--c-med)" }} />
          <span style={{ fontSize: 11, fontFamily: "var(--font-sans)", fontWeight: 500 }}>
            Thought{thoughtMs > 0 ? ` ${fmtDuration(thoughtMs)}` : ""}
          </span>
          <ChevronRight size={10} strokeWidth={2} style={{
            color: "var(--c-ghost)", flexShrink: 0,
            transform: open ? "rotate(90deg)" : "none", transition: "transform 0.15s",
          }} />
        </button>
      ) : hasMeta ? (
        <LogoMark size={11} ariaLabel="Fleetify" style={{ color: "var(--c-dim)", opacity: 0.6, flexShrink: 0 }} />
      ) : null}

      {/* Meta segments — icon-led, evenly spaced. */}
      {hasMeta && (
        <div style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
          {segs.map((s, i) => (
            <span key={i} style={{
              display: "inline-flex", alignItems: "center", gap: 4,
              fontSize: 11, color: "var(--c-dim)",
              fontFamily: "var(--font-mono)", letterSpacing: "-0.01em",
            }}>
              <span style={{ display: "inline-flex", opacity: 0.7 }}>{s.icon}</span>
              {s.text}
            </span>
          ))}
        </div>
      )}

      {/* Action cluster — Save to memory + Copy. Both fade in on hover so
          they don't compete with the cost/token meta line at rest. */}
      <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 2 }}>
        {/* Save to memory — only when there's text body to save */}
        {fullText.trim() && (
          <button
            onClick={saveToMemory}
            disabled={saving}
            title={saved ? "Saved to memory" : "Save to memory"}
            style={{
              width: 22, height: 22,
              display: "flex", alignItems: "center", justifyContent: "center",
              borderRadius: 5, background: "none", border: "none", cursor: "pointer",
              color: saved ? "var(--c-high)" : "var(--c-dim)",
              opacity: hovered || saved ? 1 : 0,
              transition: "opacity 0.15s, color 0.1s, background 0.1s",
              pointerEvents: hovered ? "auto" : "none",
            }}
            onMouseEnter={e => { e.currentTarget.style.background = "var(--c-srf2)"; e.currentTarget.style.color = "var(--c-high)"; }}
            onMouseLeave={e => { e.currentTarget.style.background = "none"; e.currentTarget.style.color = saved ? "var(--c-high)" : "var(--c-dim)"; }}
          >
            {saved
              ? <BookmarkCheck size={12} strokeWidth={2} />
              : <Bookmark size={12} strokeWidth={1.75} />}
          </button>
        )}

        {/* Copy */}
        <button
          onClick={copy}
          title="Copy"
          style={{
            width: 22, height: 22,
            display: "flex", alignItems: "center", justifyContent: "center",
            borderRadius: 5, background: "none", border: "none", cursor: "pointer",
            color: copied ? "var(--c-high)" : "var(--c-dim)",
            opacity: hovered ? 1 : 0,
            transition: "opacity 0.15s, color 0.1s",
            pointerEvents: hovered ? "auto" : "none",
          }}
          onMouseEnter={e => { e.currentTarget.style.background = "var(--c-srf2)"; e.currentTarget.style.color = "var(--c-high)"; }}
          onMouseLeave={e => { e.currentTarget.style.background = "none"; e.currentTarget.style.color = copied ? "var(--c-high)" : "var(--c-dim)"; }}
        >
          {copied ? <Check size={12} strokeWidth={2} /> : <Copy size={12} strokeWidth={1.75} />}
        </button>
      </div>
    </div>

      {/* Reasoning panel — revealed when the Fleetify mark is clicked. Each
          burst is rendered as a quiet italic block with a left rail, the
          same treatment the old inline ThoughtsChip used. */}
      {hasThoughts && (
        <div style={{
          display: "grid",
          gridTemplateRows: open ? "1fr" : "0fr",
          transition: "grid-template-rows 0.2s ease",
        }}>
          <div style={{ overflow: "hidden" }}>
            <div style={{
              marginTop: 7, marginLeft: 2,
              paddingLeft: 11,
              borderLeft: "2px solid var(--c-brd)",
            }}>
              {thinkingBursts.map((b, i) => (
                <p key={i} style={{
                  fontSize: 12.5, color: "var(--c-dim)",
                  lineHeight: 1.65, margin: i === 0 ? 0 : "8px 0 0",
                  whiteSpace: "pre-wrap", fontStyle: "italic",
                }}>
                  {b.text}
                </p>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}


/* ── Live streaming stats (shown below content while generating) ── */
export function StreamingStats() {
  // Per-field selectors — full-state useAppStore() re-rendered the
  // stats row on every unrelated app-store mutation.
  const activeSessionId = useAppStore(s => s.activeSessionId);
  const staffSessionId = useAppStore(s => s.staffSessionId);
  const sid = activeSessionId || staffSessionId;
  const { streamStartTime, streamingText, isStreaming } = useChatStore(selectSession(sid));
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!isStreaming || !streamStartTime) { setElapsed(0); return; }
    const iv = setInterval(() => setElapsed(Date.now() - streamStartTime), 300);
    return () => clearInterval(iv);
  }, [isStreaming, streamStartTime]);

  if (!isStreaming || elapsed < 800) return null;

  const approxTokens = Math.round(streamingText.length / 4);

  return (
    <div style={{
      marginTop: 10, fontSize: 10.5, fontFamily: "var(--font-mono)",
      color: "var(--c-ghost)",
      display: "flex", alignItems: "center", gap: 6,
    }}>
      <span>{fmtDuration(elapsed)}</span>
      {approxTokens > 20 && (
        <>
          <span style={{ opacity: 0.4 }}>·</span>
          <span>~{fmtTokens(approxTokens)} tok</span>
        </>
      )}
    </div>
  );
}

/* ── Render text with @mention tokens highlighted ── */
function renderWithMentions(text: string): React.ReactNode {
  // Exclude trailing sentence punctuation from the mention token
  const parts = text.split(/(@[^\s.,!?;:'")\]>]+)/g);
  return parts.map((part, i) =>
    part.startsWith("@") && part.length > 1
      ? (
        <span key={i} style={{
          background: "rgba(96,165,250,0.12)",
          color: "rgba(96,165,250,0.9)",
          borderRadius: 4,
          padding: "0 3px",
          fontWeight: 500,
        }}>{part}</span>
      )
      : part
  );
}

/* ── User message ── */
function UserMessage({ content, msgRef }: { content: ContentBlock[]; msgRef?: React.RefObject<HTMLDivElement | null> }) {
  const images = content.filter((b): b is import("@/types/chat").ImageBlock => b.type === "image");
  const rawText = content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map(b => b.text).join("\n");
  // Strip ALL internal metadata — fleet status snapshot, agent-context
  // pull-ins, Auto-mode prefixes, leftover dispatch tokens. The user
  // sent only the prompt; that's all they should see when reading back.
  const text = cleanUserText(rawText);

  // Tool result messages have no text or images — don't render empty pills
  if (!text && images.length === 0) return null;

  // Slash-command rendering: when the bubble carries only a /command,
  // tint it blue and switch to a mono-ish stack so it reads as an
  // instruction issued to the system rather than a sentence said to
  // the agent. Single-line guard avoids hijacking long prompts that
  // happen to start with "/" (e.g. a path quoted by the user).
  const isSlashCommand = !!text && /^\/[a-zA-Z][\w-]*\b/.test(text) && !text.includes("\n");

  return (
    // Right-aligned bubble. Was: full-width outlined box that read as
    // a draft input field — confusing because user mentally maps
    // "outlined rectangle near the bottom of a chat" to "where I type".
    // Standard chat UX: user message on the right, solid subtle
    // accent background, NO outline border, capped max-width so the
    // line length stays comfortable.
    <div
      ref={msgRef}
      className="msg-in"
      style={{
        marginBottom: 20,
        display: "flex",
        justifyContent: "flex-end",
      }}
    >
      <div style={{
        // Bubble itself
        maxWidth: "75%",
        padding: "9px 13px",
        borderRadius: 14,
        // Smaller corner on the bottom-right so the bubble visually
        // "points" back to the input below — tiny detail, big polish.
        borderBottomRightRadius: 6,
        // The bubble keeps the normal neutral surface for every message —
        // the blue, mono command text below is what marks a slash command
        // as a "directive to the system", so the container itself shouldn't
        // also tint (it read as a different kind of message).
        background: "var(--secondary)",
        overflow: "hidden",
      }}>
        {images.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: text ? 8 : 0 }}>
            {images.map((img, i) => (
              <img
                key={i}
                src={img.preview ?? `data:${img.media_type};base64,${img.data}`}
                alt={img.name ?? `Image ${i + 1}`}
                style={{
                  maxWidth: "100%", maxHeight: 240,
                  borderRadius: 7, objectFit: "contain",
                  display: "block",
                }}
              />
            ))}
          </div>
        )}
        {text && (
          <p style={{
            fontSize: 13,
            color: isSlashCommand ? "#60a5fa" : "var(--c-high)",
            lineHeight: 1.55, whiteSpace: "pre-wrap", margin: 0,
            letterSpacing: "-0.004em",
            overflowWrap: "break-word", wordBreak: "break-word",
            fontFamily: isSlashCommand
              ? "var(--font-mono, ui-monospace, SFMono-Regular, monospace)"
              : undefined,
            fontWeight: isSlashCommand ? 500 : undefined,
          }}>
            {renderWithMentions(text)}
          </p>
        )}
      </div>
    </div>
  );
}

/* ── Compact summary ──
 *
 *  Rendered for the assistant message the compactor persists after a
 *  /compact run — this IS the "done" state of compaction (the running
 *  pill clears itself the moment this lands, and it renders the same way
 *  live and on reload). Plain, no box: a ✓ "Compacted successfully"
 *  confirmation in a calm (non-green) tone, with the model's structured
 *  summary (Goal / Decisions / Files / Open questions / Next steps) shown
 *  below as a faded peek — like the live "thinking" preview — that expands
 *  to the full summary on click. The next agent turn injects the same
 *  summary into its system prompt, so what the user reads here IS the
 *  continuity context. */
function CompactSummaryCard({
  summary,
  timestamp,
}: {
  summary: string;
  timestamp: string;
}) {
  // Expanded by default — the full summary shows on arrival; click the chevron
  // to collapse it (it animates open/closed via the grid-rows transition).
  const [open, setOpen] = useState(true);
  const stamp = useMemo(() => {
    const d = new Date(timestamp);
    if (Number.isNaN(d.getTime())) return null;
    return d.toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }, [timestamp]);

  // Calm, theme-adaptive foreground — the confirmation reads as a normal
  // (slightly dimmed) line, not a loud green success badge.
  const labelColor = "var(--c-low)";

  return (
    <div className="fade-in" style={{ margin: "6px 0 14px" }}>
      {/* Plain inline row — no box. Fleetify mark + the done line, then the
          timestamp + disclosure chevron on the right. Mirrors the live
          "thinking"/"Compacting…" treatment; click expands the summary. */}
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: 7,
          padding: "2px 0",
          background: "transparent",
          border: "none",
          cursor: "pointer",
          textAlign: "left",
        }}
      >
        <LogoMark size={14} style={{ flexShrink: 0 }} />
        <span
          style={{
            color: labelColor,
            fontSize: 12.5,
            fontWeight: 500,
            letterSpacing: "-0.01em",
          }}
        >
          Compacted successfully
        </span>
        <span
          style={{
            color: "var(--c-dim)",
            fontSize: 12.5,
            fontWeight: 450,
            letterSpacing: "-0.01em",
          }}
        >
          · Compaction summary
        </span>
        <span
          style={{
            marginLeft: "auto",
            display: "flex",
            alignItems: "center",
            gap: 8,
            flexShrink: 0,
          }}
        >
          {stamp && (
            <span
              style={{
                color: "var(--c-ghost)",
                fontWeight: 400,
                fontSize: 11.5,
                opacity: 0.8,
              }}
            >
              {stamp}
            </span>
          )}
          <ChevronRight
            size={12}
            style={{
              transform: open ? "rotate(90deg)" : "rotate(0deg)",
              transition: "transform 0.15s ease",
              color: "var(--c-ghost)",
            }}
          />
        </span>
      </button>
      {/* Body — a faded peek by default (mirrors the live "thinking"
          preview rail), expands to the full summary on click. */}
      {/* Collapsed by default — no peek. Click the chevron to reveal the full
          summary, which grows open with an animated grid-rows expand (the same
          smooth open/close used elsewhere), like the "Thought" disclosure. */}
      <div
        style={{
          display: "grid",
          gridTemplateRows: open ? "1fr" : "0fr",
          transition: "grid-template-rows 0.26s cubic-bezier(0.22,1,0.36,1)",
        }}
      >
        <div style={{ overflow: "hidden" }}>
          <div style={{ paddingLeft: 21, paddingTop: open ? 6 : 0, transition: "padding-top 0.26s" }}>
            <MarkdownBody text={summary} />
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Assistant message ── */
function AssistantMessage({ message }: { message: ChatMessage }) {
  const { content } = message;
  const [hovered, setHovered] = useState(false);
  // Transcript view drives which content blocks render and
  // whether thinking / tool rows come up auto-expanded:
  //
  //   normal    → render all blocks, collapsed by default
  //   thinking  → same as normal, but thinking blocks are
  //               force-expanded so the user sees the model's
  //               rationale without clicking
  //   verbose   → all blocks, both thinking AND tool rows
  //               force-expanded — full raw transcript
  //   summary   → text + artifacts only; thinking and tool
  //               rows are dropped entirely so the user gets
  //               just the conclusions
  const transcriptView = useAppStore(s => s.transcriptView);
  const forceThinkingOpen = transcriptView === "thinking" || transcriptView === "verbose";
  const forceToolOpen     = transcriptView === "verbose";
  const dropThinking      = transcriptView === "summary";
  const dropTools         = transcriptView === "summary";

  // Use tighter margin for tool-call-only messages (no text blocks).
  // Bumped 20 → 28 so the breathing room between an agent's prose
  // and the next user message feels deliberate, not a default.
  const hasText = content.some(b => b.type === "text" && (b as { type: "text"; text: string }).text.trim());
  const mb = hasText ? 28 : 6;

  // Build a tool_id → tool_result lookup so each tool_use row can
  // render its own output without a second pass through `content`.
  // The result block always arrives AFTER its tool_use in the same
  // message body, so this single iteration is enough.
  const toolResultById: Record<string, { output: string; is_error: boolean }> = {};
  for (const b of content) {
    if (b.type === "tool_result") {
      const tr = b as { tool_id: string; output: string; is_error: boolean };
      if (tr.tool_id) toolResultById[tr.tool_id] = { output: tr.output, is_error: tr.is_error };
    }
  }

  // ── Surface sub-agent dispatches in the Tasks panel ──
  // Agents spawned via the native `Task` tool OR a custom orchestration MCP
  // (tool named "Agent", result carrying `agentId:` + a `<usage>` block) don't
  // flow through Fleet's own dispatch_ack pipeline, so the right-side Tasks
  // pane stayed empty. Here we parse each such tool_use + its result straight
  // from the committed message and register a completed sub-agent task (id =
  // agentId or tool_use id), with tokens / tool_uses / duration pulled from
  // the `<usage>` block. startSubagent is idempotent, so re-renders are safe.
  const sessId = useAppStore.getState().activeSessionId || useAppStore.getState().staffSessionId;
  useEffect(() => {
    if (!sessId) return;
    const store = useChatStore.getState();
    for (const b of content) {
      if (b.type !== "tool_use") continue;
      const tb = b as { tool_id?: string; tool_name?: string; name?: string; input?: Record<string, unknown> };
      const tn = (tb.tool_name || tb.name || "").toLowerCase();
      if (tn !== "agent" && tn !== "task") continue;
      const res = tb.tool_id ? toolResultById[tb.tool_id] : undefined;
      const out = res?.output ?? "";
      // agentId from the result is the most stable id; fall back to tool id.
      const agentId = /agentId:\s*([A-Za-z0-9]+)/.exec(out)?.[1] || tb.tool_id || "";
      if (!agentId) continue;
      const desc = String(tb.input?.description ?? tb.input?.prompt ?? "Agent").trim().split("\n")[0] || "Agent";
      const tType = String(tb.input?.subagent_type ?? tb.input?.agent_type ?? "Agent");
      store.startSubagent(sessId, {
        id: agentId,
        toolUseId: tb.tool_id ?? null,
        description: desc.length > 80 ? desc.slice(0, 80) + "…" : desc,
        taskType: tType,
      });
      // If the result is present the run already finished — finalize with
      // the parsed usage so the card shows tokens / tool uses / duration.
      if (out) {
        const tok = Number(/total_tokens:\s*(\d+)/.exec(out)?.[1] ?? 0);
        const uses = Number(/tool_uses:\s*(\d+)/.exec(out)?.[1] ?? 0);
        const dur = Number(/duration_ms:\s*(\d+)/.exec(out)?.[1] ?? 0);
        const summary = out.replace(/<usage>[\s\S]*?<\/usage>/g, "").replace(/agentId:[\s\S]*/g, "").trim();
        store.endSubagent(sessId, agentId, res?.is_error ? "failed" : "completed", summary || null, {
          totalTokens: tok, toolUses: uses, durationMs: dur,
        });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [message.id, content.length, sessId]);

  return (
    <div
      className="msg-in"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{ marginBottom: mb }}
    >
      <div>
        {(() => {
          // Batch consecutive tool_use / tool_result blocks so we can
          // render them through ToolGroup (which collapses runs of ≥2
          // into a single "Edited N files" summary). tool_result blocks
          // never render on their own — they feed into the matching
          // tool_use row via toolResultById — so collecting them in the
          // same pass keeps the iteration simple.
          const out: React.ReactNode[] = [];
          let toolRun: Array<{
            tool_id?: string;
            tool_name?: string;
            name?: string;
            tool_kind?: string;
            input?: Record<string, unknown>;
          }> = [];
          const flushTools = (keyHint: string) => {
            if (toolRun.length === 0) return;
            // Short consecutive batches can stay as one mixed-verb group
            // ("Edited a file, ran 2 commands"). Long batches read as a
            // single mega-summary ("Ran 17 commands, edited 10 files")
            // which the user explicitly said feels like a status line and
            // not a transcript — Claude Code Desktop splits these by
            // tool-type into stacked groups instead. We follow the same
            // rule: ≤4 items stays mixed, otherwise group into runs of
            // consecutive same-verb tools.
            const SMALL_MIXED_LIMIT = 4;
            const runs: typeof toolRun[] = [];
            if (toolRun.length <= SMALL_MIXED_LIMIT) {
              runs.push(toolRun);
            } else {
              let current: typeof toolRun = [];
              let currentVerb: string | null = null;
              for (const t of toolRun) {
                const v = getToolMeta(t.tool_name || t.name || "", t.tool_kind).verb;
                if (currentVerb === null || v === currentVerb) {
                  current.push(t);
                  currentVerb = v;
                } else {
                  runs.push(current);
                  current = [t];
                  currentVerb = v;
                }
              }
              if (current.length) runs.push(current);
            }
            runs.forEach((run, ri) => {
              out.push(
                <ToolGroup
                  key={`tg-${keyHint}-${ri}`}
                  tools={run}
                  results={toolResultById}
                  forceOpen={forceToolOpen}
                  dropTools={dropTools}
                />
              );
            });
            toolRun = [];
          };
          content.forEach((block, i) => {
            if (block.type === "tool_use") {
              const tb = block as {
                tool_id?: string;
                tool_name?: string;
                name?: string;
                tool_kind?: string;
                input?: Record<string, unknown>;
              };
              const tn = tb.tool_name || tb.name || "";
              // Task tool dispatches are NOT regular tools — they're
              // sub-agent runs that own their own pane on the right.
              // Render an inline "Ran agent X" row instead of folding
              // into the ToolGroup summary; clicking that row focuses
              // the Agent pane on this sub-agent. Matches Claude Code
              // Desktop's chat where the sub-agent dispatch is a slim
              // standalone line linking out to its detail view.
              if (tn === "Task" || tn === "task" || tn === "Agent" || tn === "agent") {
                flushTools(`pre-subagent-${i}`);
                const desc = String(
                  (tb.input?.description ?? tb.input?.prompt ?? "Agent")
                ).trim().split("\n")[0] || "Agent";
                out.push(
                  <SubagentChatRow
                    key={i}
                    toolUseId={tb.tool_id ?? ""}
                    fallbackTitle={desc.length > 80 ? desc.slice(0, 80) + "…" : desc}
                  />
                );
                return;
              }
              toolRun.push(tb);
              return;
            }
            if (block.type === "tool_result") {
              // Consumed via toolResultById; doesn't break the run.
              return;
            }
            // Non-tool block — flush whatever we accumulated, then
            // render this block.
            flushTools(String(i));
            if (block.type === "text") {
              const cleaned = stripDispatch(block.text);
              if (cleaned) out.push(<MarkdownBody key={i} text={cleaned} />);
            } else if (block.type === "thinking") {
              // Thinking is rendered as one consolidated chip in the
              // stats row, not inline — see ThoughtsChip in
              // MessageStatsRow. Codex emits a fresh reasoning burst
              // per tool batch; inline rendering stacked 5+ chips
              // between tools and dominated the chat.
            } else if (block.type === "artifact") {
              out.push(<ArtifactCard key={i} block={block as ArtifactBlock} />);
            } else if (block.type === "resource_card") {
              const card = renderResourceCard(block as ResourceCardBlock);
              if (card) out.push(<div key={i}>{card}</div>);
            } else if (block.type === "citations") {
              out.push(<CitationCard key={i} block={block} />);
            }
          });
          flushTools("tail");
          return out;
        })()}
        {(() => {
          const bursts = dropThinking ? [] : content
            .filter((b): b is { type: "thinking"; text: string; duration_ms?: number } => b.type === "thinking")
            .map(b => ({ text: b.text, durationMs: b.duration_ms }));
          // Thinking now lives ON the Fleetify mark in the stats row — click
          // the logo to reveal the reasoning. No separate inline chip.
          return (
            <MessageStatsRow
              message={message}
              hovered={hovered}
              toolOnly={!hasText}
              thinkingBursts={bursts}
              forceThoughtsOpen={forceThinkingOpen}
            />
          );
        })()}
      </div>
    </div>
  );
}

/* ── Dispatch permission card ─────────────────────────────────────
   Permission state lives entirely in the right sidebar:
   - Pending  → PendingPermissionsQueue at the top of the Pulse panel
   - Resolved → Live Pulse event stream (audit trail)

   Chat NEVER renders these cards. Earlier we tried a "fallback when right
   panel is closed" mode but the user's feedback was that long sessions
   pile up dozens of `Allowed · WebSearch · agent` rows in chat history,
   which is pure noise. The right sidebar is the single source of truth.
   We keep the component as a typed no-op so DispatchPermissionBlock
   message lookups don't crash. */
function DispatchPermissionCard(_props: { block: import("@/types/chat").DispatchPermissionBlock }): React.JSX.Element | null {
  void _props;
  return null;
}

/* ── Dispatch pending — frameless inline indicator + live preview ── */
function DispatchPendingCard({ block }: { block: import("@/types/chat").DispatchPendingBlock }) {
  // Subscribe to the live preview buffer for this dispatch. The backend
  // mirrors the target agent's text/thinking deltas + last tool name to
  // the staff WS while the dispatch is in flight; we render a tail
  // (last ~280 chars of text, or current tool/thinking) under the
  // header so the user can watch the agent work without leaving Fleet.
  const preview = useChatStore(s => s.dispatchPreviews[block.agent_id]);
  // Selectors for the click-through on the agent name. Mirrors the
  // pattern in DispatchResultCard — wrap the name in a button that
  // sets the active session so the user can jump into the dispatched
  // agent's own chat (and watch the same stream live there) without
  // leaving the pill.
  const sessions = useAppStore(s => s.sessions);
  const setActiveSession = useAppStore(s => s.setActiveSession);
  const targetSession = sessions.find(s => s.id === block.agent_id);
  const [nameHover, setNameHover] = useState(false);
  const openTarget = useCallback(() => {
    if (!targetSession) return;
    setActiveSession(block.agent_id);
  }, [targetSession, setActiveSession, block.agent_id]);

  const tail = preview?.text?.trim().slice(-280) ?? "";
  const thinkingTail = preview?.thinking?.trim().slice(-160) ?? "";
  const showText = tail.length > 0;
  const showTool = !showText && !!preview?.lastTool;
  const showThinking = !showText && !showTool && thinkingTail.length > 0;

  // Phase badge — visible feedback during the 2-5s window between
  // "task accepted" and "first stream event arrived". Without this,
  // the user stares at three dots and can't tell whether the agent
  // is booting, stuck, or whether the dispatch even reached the
  // backend at all. Mapped from the dispatch_progress WS event:
  //   "starting" → "Waking up" (auto-wake of stopped/error agent)
  //   "received" → "Received"  (target was already idle/running)
  //   "running"  → no badge   (the live preview rail itself is the
  //                            signal — duplicating it as a badge
  //                            would be visual noise)
  const phase = preview?.phase;
  const autoWoken = !!preview?.autoWoken;
  const phaseLabel: string | null =
    phase === "starting" ? (autoWoken ? "Waking" : "Starting")
  : phase === "received" ? "Received"
  : null; // intentionally null on "running" — the preview rail is the signal

  return (
    <div className="fade-in" style={{ margin: "2px 0 16px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
        <span style={{ display: "flex", gap: 2.5, flexShrink: 0 }}>
          {[0,1,2].map(j => (
            <span key={j} style={{ width: 3, height: 3, borderRadius: "50%", background: "var(--c-ghost)", display: "block", animation: `dot-seq 1.4s ease-in-out ${j*0.22}s infinite` }} />
          ))}
        </span>
        <span style={{ fontSize: 12, color: "var(--c-dim)" }}>
          {"Dispatching to "}
          {/* Agent name is a click-through into the target session's own
              chat. Same affordance the result card carries — gives the
              user a way to jump out of Fleet and watch the dispatched
              agent live without waiting for it to finish. Disabled if
              the session record is missing (archived / deleted) so the
              click can't strand the user on an unresolvable id. */}
          <button
            type="button"
            onClick={openTarget}
            disabled={!targetSession}
            onMouseEnter={() => targetSession && setNameHover(true)}
            onMouseLeave={() => setNameHover(false)}
            title={targetSession ? `Open ${block.agent_name}'s session` : "Session no longer available"}
            style={{
              display: "inline",
              padding: 0, background: "transparent", border: "none",
              cursor: targetSession ? "pointer" : "default",
              fontFamily: "inherit", fontSize: "inherit",
              fontWeight: 500,
              color: nameHover ? "var(--c-high)" : "var(--c-med)",
              textDecoration: nameHover ? "underline" : "none",
              textDecorationThickness: 1,
              textUnderlineOffset: 2,
              transition: "color 0.12s",
              outline: "none",
            }}
          >
            {block.agent_name}
          </button>
          {block.task && <span style={{ color: "var(--c-ghost)" }}> — {block.task.length > 70 ? block.task.slice(0, 70) + "…" : block.task}</span>}
        </span>
        {phaseLabel && (
          <span
            title={autoWoken ? "Agent was stopped — auto-waking it for this dispatch" : undefined}
            style={{
              flexShrink: 0,
              fontSize: 9.5, fontWeight: 600,
              letterSpacing: "0.06em", textTransform: "uppercase",
              padding: "2px 6px", borderRadius: 999,
              background: "var(--c-srf)", color: "var(--c-low)",
              border: "1px solid var(--c-brd)",
            }}
          >
            {phaseLabel}
          </span>
        )}
      </div>

      {/* Live preview rail. Indented to align with the dot column above. */}
      {(showText || showTool || showThinking) && (
        <div style={{
          marginTop: 6, marginLeft: 18,
          paddingLeft: 8, borderLeft: "1.5px solid var(--c-brd)",
          fontSize: 11.5, lineHeight: 1.45,
          color: "var(--c-dim)",
          maxHeight: 110, overflow: "hidden",
          maskImage: "linear-gradient(to bottom, black 60%, transparent 100%)",
          WebkitMaskImage: "linear-gradient(to bottom, black 60%, transparent 100%)",
        }}>
          {showText && (
            <span style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
              {tail}
            </span>
          )}
          {showTool && (
            <span style={{
              fontFamily: "var(--font-mono, 'SF Mono', monospace)",
              color: "var(--c-low)",
            }}>
              ⚙ {preview!.lastTool}
            </span>
          )}
          {showThinking && (
            <span style={{ fontStyle: "italic", color: "var(--c-ghost)" }}>
              <span className="status-sheen" data-label="thinking">thinking</span> · {thinkingTail}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/* ── Dispatch result — frameless, looks like a regular message with a source tag ── */
function DispatchResultCard({ block }: { block: import("@/types/chat").DispatchResultBlock }) {
  // Per-field selectors — full-state useAppStore() re-rendered every
  // dispatch card on every notification / draft / pane-focus change.
  const sessions = useAppStore(s => s.sessions);
  const staffSessionId = useAppStore(s => s.staffSessionId);
  const setActiveSession = useAppStore(s => s.setActiveSession);
  const session = sessions.find(s => s.id === block.agent_id);
  // Prefer the path persisted on the block (survives session eviction /
  // cold reloads); fall back to the live session lookup. We show the
  // FULL absolute path next to the folder icon — short names hid which
  // worktree a dispatch ran in when two agents share a folder name.
  const folder = block.project_path || session?.project_path || null;
  const failColor = "rgba(248,113,113,0.85)";

  // Hover state for the attribution-row button — drives a subtle color
  // shift on `agent_name` to telegraph that the cluster is clickable.
  // Local state instead of CSS :hover so we can scope it to the row
  // only (the row sits inside a larger card whose own hover styles
  // would otherwise muddy the signal).
  const [headerHover, setHeaderHover] = useState(false);

  // Inline reply state — textarea is hidden until the user clicks Reply.
  // We deliberately don't auto-open it because every dispatch_result would
  // pile up open inputs in long staff conversations.
  const [replyOpen, setReplyOpen] = useState(false);
  const [replyText, setReplyText] = useState("");
  const [sending, setSending] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [retried, setRetried] = useState(false);
  const replyRef = useRef<HTMLTextAreaElement>(null);

  // Navigate into the dispatched agent's own chat. Disabled if the
  // session record is missing (archived or already deleted) — clicking
  // would otherwise switch to an id that the chat-view can't resolve.
  const openSession = useCallback(() => {
    if (!session) return;
    setActiveSession(block.agent_id);
  }, [session, setActiveSession, block.agent_id]);

  useEffect(() => {
    if (replyOpen) replyRef.current?.focus();
  }, [replyOpen]);

  const sendReply = useCallback(async () => {
    const t = replyText.trim();
    if (!t || sending) return;
    setSending(true);
    try {
      const { dispatchFollowUp } = await import("@/lib/api");
      await dispatchFollowUp(block.agent_id, t, staffSessionId ?? undefined);
      setReplyText("");
      setReplyOpen(false);
    } catch (err) {
      console.error("Reply failed:", err);
    } finally {
      setSending(false);
    }
  }, [replyText, sending, block.agent_id, staffSessionId]);

  // Re-dispatch the same task when a dispatch failed. Reuses the
  // existing follow-up endpoint — same backend code path as Reply,
  // just with the original task as payload. Shows a brief "Retried"
  // state so the user knows their click registered.
  const retryDispatch = useCallback(async () => {
    if (retrying || retried) return;
    const task = block.task?.trim();
    if (!task) return;
    setRetrying(true);
    try {
      const { dispatchFollowUp } = await import("@/lib/api");
      await dispatchFollowUp(block.agent_id, task, staffSessionId ?? undefined);
      setRetried(true);
      setTimeout(() => setRetried(false), 4000);
    } catch (err) {
      console.error("Retry failed:", err);
    } finally {
      setRetrying(false);
    }
  }, [retrying, retried, block.agent_id, block.task, staffSessionId]);

  return (
    <div
      className="fade-in"
      // Used by the notification stack to scroll-and-highlight the
      // matching result card when the user clicks "agent finished" —
      // they stay on the Fleet chat instead of being yanked to the
      // dispatched agent's session.
      data-dispatch-result-agent={block.agent_id}
      style={{
        margin: "4px 0 20px",
        // Highlight target — the notification onClick handler toggles
        // this class for ~2s when the user clicks to focus the result.
        transition: "background 0.4s ease, box-shadow 0.4s ease",
        borderRadius: 8,
      }}
    >
      {/* Attribution tag — the left cluster (icon + agent name + folder +
          status) is a single button that jumps into the dispatched
          agent's own chat. Retry/Reply stay outside this button so the
          HTML doesn't nest buttons (which browsers ignore the inner
          click on). When the session record is missing — archived or
          already removed — the button is disabled and visually quiet,
          since switching to a non-existent session would land the user
          on an empty chat-view. */}
      <div style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 8 }}>
        <button
          type="button"
          onClick={openSession}
          disabled={!session}
          onMouseEnter={() => session && setHeaderHover(true)}
          onMouseLeave={() => setHeaderHover(false)}
          title={session ? `Open ${block.agent_name}'s session` : "Session no longer available"}
          style={{
            display: "inline-flex", alignItems: "center", gap: 5,
            padding: 0, background: "transparent", border: "none",
            cursor: session ? "pointer" : "default",
            fontFamily: "inherit", textAlign: "left",
            color: "inherit", outline: "none",
          }}
        >
          <span style={{ color: block.success ? "var(--c-dim)" : failColor, display: "flex" }}>
            {block.success ? <CheckCircle2 size={11} /> : <AlertCircle size={11} />}
          </span>
          <span style={{
            fontSize: 11.5, fontWeight: 500,
            color: headerHover ? "var(--c-high)" : "var(--c-med)",
            textDecoration: headerHover ? "underline" : "none",
            textDecorationThickness: 1,
            textUnderlineOffset: 2,
            transition: "color 0.12s",
          }}>{block.agent_name}</span>
          {folder && (
            <>
              <span style={{ color: "var(--c-ghost)", fontSize: 10 }}>·</span>
              <span style={{ display: "flex", alignItems: "center", gap: 2, fontSize: 11, color: "var(--c-dim)", fontFamily: "var(--font-mono)" }}>
                <FolderOpen size={9} style={{ opacity: 0.6 }} />{folder}
              </span>
            </>
          )}
          <span style={{ color: "var(--c-ghost)", fontSize: 10 }}>·</span>
          <span style={{ fontSize: 11, color: block.success ? "var(--c-ghost)" : failColor }}>
            {block.success ? "done" : "failed"}
          </span>
        </button>
        {/* Action cluster — Retry (failed dispatches) + Reply. Only on the
            staff/Fleet view; agent-individual views don't dispatch back. */}
        {staffSessionId && (
          <div style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 2 }}>
            {/* Retry — only when this dispatch actually failed AND we have
                a task body to re-send. Disabled in the brief "Retried"
                window so users don't fire duplicates. */}
            {!block.success && block.task?.trim() && (
              <button
                onClick={retryDispatch}
                disabled={retrying || retried}
                title={retried ? "Retried" : "Re-run the same task on this agent"}
                style={{
                  display: "inline-flex", alignItems: "center", gap: 4,
                  fontSize: 10.5, fontWeight: 500,
                  color: retried ? "var(--c-high)" : "var(--c-ghost)",
                  background: "transparent", border: "none",
                  cursor: retrying || retried ? "default" : "pointer",
                  padding: "3px 7px", borderRadius: 5,
                  transition: "color 0.12s, background 0.12s",
                }}
                onMouseEnter={e => {
                  if (retrying || retried) return;
                  e.currentTarget.style.background = "var(--c-srf)";
                  e.currentTarget.style.color = "var(--c-low)";
                }}
                onMouseLeave={e => {
                  if (retrying || retried) return;
                  e.currentTarget.style.background = "transparent";
                  e.currentTarget.style.color = "var(--c-ghost)";
                }}
              >
                <RotateCcw size={9} />
                <span>{retrying ? "Retrying…" : retried ? "Retried" : "Retry"}</span>
              </button>
            )}
            <button
              onClick={() => setReplyOpen(v => !v)}
              title={replyOpen ? "Cancel reply" : "Reply to this agent without leaving Fleetify"}
              style={{
                display: "inline-flex", alignItems: "center", gap: 4,
                fontSize: 10.5, fontWeight: 500,
                color: replyOpen ? "var(--c-high)" : "var(--c-ghost)",
                background: "transparent", border: "none", cursor: "pointer",
                padding: "3px 7px", borderRadius: 5,
                transition: "color 0.12s, background 0.12s",
              }}
              onMouseEnter={e => { e.currentTarget.style.background = "var(--c-srf)"; e.currentTarget.style.color = "var(--c-low)"; }}
              onMouseLeave={e => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = replyOpen ? "var(--c-high)" : "var(--c-ghost)"; }}
            >
              <CornerDownLeft size={9} />
              <span>{replyOpen ? "Cancel" : "Reply"}</span>
            </button>
          </div>
        )}
      </div>

      {/* Full message — rendered as markdown, no container */}
      {block.summary && <MarkdownBody text={block.summary} />}

      {/* Inline reply composer */}
      {replyOpen && (
        <div style={{
          marginTop: 10,
          border: "1px solid var(--c-brd)", borderRadius: 8,
          background: "var(--c-srf)", overflow: "hidden",
        }}>
          <textarea
            ref={replyRef}
            value={replyText}
            onChange={e => setReplyText(e.target.value)}
            onKeyDown={e => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                sendReply();
              }
              if (e.key === "Escape") {
                // Claim the key so closing the box does nothing else: no
                // stop, no back to Fleet, no permission deny. React
                // handlers run before those window listeners.
                claimEscape(e.nativeEvent);
                setReplyOpen(false);
                setReplyText("");
              }
            }}
            placeholder={`Follow-up to ${block.agent_name}…`}
            rows={2}
            disabled={sending}
            style={{
              width: "100%", boxSizing: "border-box",
              padding: "9px 12px",
              background: "transparent", border: "none",
              color: "var(--c-high)", fontSize: 12.5,
              fontFamily: "inherit", resize: "vertical",
              outline: "none", minHeight: 50,
            }}
          />
          <div style={{
            display: "flex", alignItems: "center",
            padding: "5px 8px 6px",
            borderTop: "1px solid var(--c-brd)",
            gap: 6,
          }}>
            <span style={{ fontSize: 10, color: "var(--c-ghost)", flex: 1 }}>
              {formatShortcut(["Mod", "Enter"])} to send · Esc to cancel
            </span>
            <button
              onClick={sendReply}
              disabled={!replyText.trim() || sending}
              style={{
                display: "inline-flex", alignItems: "center", gap: 4,
                padding: "5px 10px", borderRadius: 5, border: "none",
                background: replyText.trim() && !sending ? "var(--c-high)" : "var(--c-srf2)",
                color: replyText.trim() && !sending ? "var(--c-srf)" : "var(--c-ghost)",
                fontSize: 11, fontWeight: 600,
                cursor: replyText.trim() && !sending ? "pointer" : "default",
                transition: "background 0.12s, color 0.12s",
              }}
            >
              <Send size={9} />
              {sending ? "Sending…" : "Send"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Agent report card ── */
function AgentReportCard({ block }: { block: import("@/types/chat").AgentReportBlock }) {
  // Per-field selector — full-state useAppStore() re-rendered the
  // report card on every unrelated app-store mutation.
  const sessions = useAppStore(s => s.sessions);
  const session = sessions.find(s => s.id === block.agent_id);
  const folder = folderName(session?.project_path) || null;

  const palette = {
    error: { dot: "rgba(248,113,113,0.9)", bg: "rgba(248,113,113,0.06)", brd: "rgba(248,113,113,0.18)", badge: "rgba(248,113,113,0.12)" },
    warn:  { dot: "rgba(251,146,60,0.9)",  bg: "rgba(251,146,60,0.06)",  brd: "rgba(251,146,60,0.18)",  badge: "rgba(251,146,60,0.12)"  },
    info:  { dot: "rgba(96,165,250,0.85)", bg: "rgba(96,165,250,0.05)",  brd: "rgba(96,165,250,0.15)",  badge: "rgba(96,165,250,0.10)"  },
  };
  const p = palette[block.level] ?? palette.info;

  return (
    <div className="fade-in" style={{
      margin: "4px 0 14px",
      borderRadius: 10,
      border: `1px solid ${p.brd}`,
      background: p.bg,
      overflow: "hidden",
    }}>
      {/* Header */}
      <div style={{
        display: "flex", alignItems: "center", gap: 7,
        padding: "8px 12px 7px",
        borderBottom: `1px solid ${p.brd}`,
      }}>
        {/* Animated level dot */}
        <span style={{
          width: 6, height: 6, borderRadius: "50%",
          background: p.dot, flexShrink: 0,
          boxShadow: `0 0 0 3px ${p.badge}`,
        }} />

        {/* Agent name */}
        <span style={{
          fontSize: 12, fontWeight: 600, color: p.dot,
          background: p.badge, padding: "1px 7px", borderRadius: 5,
        }}>
          {block.agent_name}
        </span>

        {/* Project folder */}
        {folder && (
          <>
            <span style={{ color: "var(--c-ghost)", fontSize: 10, opacity: 0.6 }}>in</span>
            <span style={{
              display: "flex", alignItems: "center", gap: 3,
              fontSize: 11, color: "var(--c-dim)", fontFamily: "var(--font-mono)",
            }}>
              <FolderOpen size={10} style={{ opacity: 0.7 }} />
              {folder}
            </span>
          </>
        )}

        <span style={{ flex: 1 }} />

        {/* Level badge */}
        <span style={{
          fontSize: 9.5, letterSpacing: "0.1em", textTransform: "uppercase",
          color: p.dot, fontWeight: 600, opacity: 0.8,
        }}>
          {block.level}
        </span>
      </div>

      {/* Message body */}
      <div style={{ padding: "9px 12px 10px 25px", fontSize: 13, color: "var(--c-high)", lineHeight: 1.6 }}>
        {block.message}
      </div>
    </div>
  );
}

/* ── Artifact helpers ── */
/** Dispatch a ResourceCardBlock to its specific card component.
 *  The data shape for each card_kind is determined by the chat-input
 *  slash-command dispatcher that produced the block (see chat-input.tsx
 *  handleIntent). Returning null when the kind isn't recognised keeps
 *  forward-compat soft — an older client sees an unknown card kind as
 *  a no-op instead of a crash. */
function renderResourceCard(block: ResourceCardBlock): React.ReactNode {
  const data = (block.data ?? {}) as Record<string, unknown>;
  switch (block.card_kind) {
    case "skills":
      return <SkillsCard items={(data.items as never) || []} provider={String(data.provider ?? "")} />;
    case "hooks":
      return <HooksCard items={(data.items as never) || []} provider={String(data.provider ?? "")} />;
    case "commands":
      return <CommandsCard items={(data.items as never) || []} provider={String(data.provider ?? "")} kind="commands" />;
    case "prompts":
      return <CommandsCard items={(data.items as never) || []} provider={String(data.provider ?? "")} kind="prompts" />;
    case "usage":
      return <UsageCard data={data as never} />;
    case "context":
      return <ContextCard
        usedTokens={Number(data.used_tokens ?? 0)}
        maxTokens={Number(data.max_tokens ?? 0)}
        percent={Number(data.percent ?? 0)}
      />;
    case "mcp":
      return <MCPStatusCard servers={(data.servers as never) || []} />;
    case "info":
      return <InfoCard
        title={String(data.title ?? "")}
        message={String(data.message ?? "")}
        tone={(data.tone as "info" | "warn" | "error" | undefined) ?? "info"}
      />;
    case "mode_notice":
      return <ModeNoticeCard
        mode={String(data.mode ?? "")}
        note={data.note ? String(data.note) : undefined}
      />;
    case "diff":
      return <DiffCard
        diff={String(data.diff ?? "")}
        files={Number(data.file_count ?? 0)}
        isRepo={Boolean(data.is_repo ?? false)}
      />;
    case "memory":
      return <MemoryFilesCard files={(data.files as never) || []} />;
    default:
      return null;
  }
}


function artifactIcon(artifactType: ArtifactBlock["artifact_type"]): React.ReactNode {
  switch (artifactType) {
    case "code":   return <Code2 size={13} />;
    case "data":   return <BarChart2 size={13} />;
    case "report": return <BookOpen size={13} />;
    case "image":  return <Image size={13} />;
    default:       return <FileText size={13} />;
  }
}

function fmtBytes(n: number): string {
  if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(1)} MB`;
  if (n >= 1_024)     return `${(n / 1_024).toFixed(1)} KB`;
  return `${n} B`;
}

/* ── Artifact card ── */
function ArtifactCard({ block }: { block: ArtifactBlock }) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied]     = useState(false);

  const isCode   = block.artifact_type === "code";
  const isReport = block.artifact_type === "report";
  const isFile   = block.artifact_type === "file";
  const isData   = block.artifact_type === "data";

  const sizeLabel = block.size_bytes != null ? fmtBytes(block.size_bytes) : null;

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(block.content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  }, [block.content]);

  const handleDownload = useCallback(() => {
    const blob = new Blob([block.content], { type: "text/plain" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href     = url;
    a.download = block.name;
    a.click();
    URL.revokeObjectURL(url);
  }, [block.content, block.name]);

  /* Badge colour — blue-toned, no green */
  const badgeBg    = "rgba(96,165,250,0.10)";
  const badgeColor = "rgba(96,165,250,0.80)";
  const accentBrd  = "rgba(96,165,250,0.18)";

  return (
    <div
      className="fade-in"
      style={{
        margin: "8px 0 14px",
        borderRadius: 10,
        border: "1px solid var(--c-brd)",
        background: "var(--c-srf)",
        overflow: "hidden",
      }}
    >
      {/* ── Header row ── */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "9px 12px",
          borderBottom: "1px solid var(--c-brd)",
          background: "var(--c-srf2)",
        }}
      >
        {/* Icon */}
        <span style={{ color: badgeColor, display: "flex", flexShrink: 0 }}>
          {artifactIcon(block.artifact_type)}
        </span>

        {/* Name */}
        <span
          style={{
            fontSize: 12.5,
            fontWeight: 600,
            color: "var(--c-high)",
            fontFamily: isCode || isData ? "var(--font-mono)" : "inherit",
            flex: 1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {block.name}
        </span>

        {/* Type badge */}
        <span
          style={{
            fontSize: 10,
            fontWeight: 600,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: badgeColor,
            background: badgeBg,
            border: `1px solid ${accentBrd}`,
            padding: "1px 6px",
            borderRadius: 4,
            flexShrink: 0,
          }}
        >
          {block.artifact_type}
        </span>

        {/* Language sub-badge (code only) */}
        {isCode && block.language && (
          <span
            style={{
              fontSize: 10,
              color: "var(--c-dim)",
              background: "var(--c-srf)",
              border: "1px solid var(--c-brd)",
              padding: "1px 5px",
              borderRadius: 4,
              fontFamily: "var(--font-mono)",
              flexShrink: 0,
            }}
          >
            {block.language}
          </span>
        )}

        {/* Size */}
        {sizeLabel && (
          <span style={{ fontSize: 10.5, color: "var(--c-ghost)", flexShrink: 0 }}>
            {sizeLabel}
          </span>
        )}

        {/* Copy button (not for file-type) */}
        {!isFile && (
          <button
            onClick={handleCopy}
            title="Copy content"
            style={{
              display: "flex", alignItems: "center", gap: 3,
              padding: "2px 7px", borderRadius: 5,
              background: "var(--c-srf)", border: "1px solid var(--c-brd)",
              color: "var(--c-dim)", fontSize: 11, cursor: "pointer",
              flexShrink: 0,
            }}
            onMouseEnter={e => { e.currentTarget.style.color = "var(--c-med)"; }}
            onMouseLeave={e => { e.currentTarget.style.color = "var(--c-dim)"; }}
          >
            {copied ? <Check size={10} /> : <Copy size={10} />}
            <span>{copied ? "Copied" : "Copy"}</span>
          </button>
        )}

        {/* Download button */}
        <button
          onClick={handleDownload}
          title="Download"
          style={{
            display: "flex", alignItems: "center", gap: 3,
            padding: "2px 7px", borderRadius: 5,
            background: "var(--c-srf)", border: "1px solid var(--c-brd)",
            color: "var(--c-dim)", fontSize: 11, cursor: "pointer",
            flexShrink: 0,
          }}
          onMouseEnter={e => { e.currentTarget.style.color = "var(--c-med)"; }}
          onMouseLeave={e => { e.currentTarget.style.color = "var(--c-dim)"; }}
        >
          <Download size={10} />
          <span>Save</span>
        </button>
      </div>

      {/* ── Body ── */}
      {/* File type: header only — no inline body */}
      {!isFile && (
        <div>
          {/* Code type: collapsible syntax block */}
          {isCode && (
            <div style={{ position: "relative" }}>
              <div
                style={{
                  maxHeight: expanded ? "none" : 200,
                  overflow: "hidden",
                  transition: "max-height 0.2s ease",
                }}
              >
                <pre
                  style={{
                    margin: 0,
                    padding: "14px 16px",
                    background: "var(--code-bg)",
                    fontSize: 12,
                    lineHeight: 1.7,
                    fontFamily: "var(--font-mono)",
                    color: "rgba(96,165,250,0.85)",
                    overflowX: "auto",
                    whiteSpace: "pre",
                  }}
                >
                  <code style={{ color: "var(--c-high)" }}>{block.content}</code>
                </pre>
              </div>

              {/* Expand / collapse toggle */}
              {block.content.split("\n").length > 8 && (
                <button
                  onClick={() => setExpanded(e => !e)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 5,
                    width: "100%",
                    padding: "5px 16px",
                    background: "var(--c-srf)",
                    borderTop: "1px solid var(--c-brd)",
                    border: "none",
                    color: "var(--c-dim)",
                    fontSize: 11,
                    cursor: "pointer",
                    justifyContent: "center",
                    letterSpacing: "-0.005em",
                  }}
                  onMouseEnter={e => { e.currentTarget.style.color = "var(--c-med)"; e.currentTarget.style.background = "var(--c-srf2)"; }}
                  onMouseLeave={e => { e.currentTarget.style.color = "var(--c-dim)"; e.currentTarget.style.background = "var(--c-srf)"; }}
                >
                  <ChevronRight
                    size={10}
                    style={{ transform: expanded ? "rotate(270deg)" : "rotate(90deg)", transition: "transform 220ms cubic-bezier(0.32, 0.72, 0, 1)" }}
                  />
                  {expanded ? "Collapse" : `Expand  ·  ${block.content.split("\n").length} lines`}
                </button>
              )}
            </div>
          )}

          {/* Report type: markdown body */}
          {isReport && (
            <div style={{ padding: "12px 16px" }}>
              <MarkdownBody text={block.content} />
            </div>
          )}

          {/* Data type: first 10 lines monospace */}
          {isData && (
            <pre
              style={{
                margin: 0,
                padding: "12px 16px",
                fontSize: 11.5,
                lineHeight: 1.65,
                fontFamily: "var(--font-mono)",
                color: "var(--c-med)",
                background: "var(--code-bg)",
                overflowX: "auto",
                whiteSpace: "pre",
              }}
            >
              {block.content.split("\n").slice(0, 10).join("\n")}
              {block.content.split("\n").length > 10 && (
                <span style={{ color: "var(--c-ghost)", display: "block", marginTop: 4 }}>
                  … {block.content.split("\n").length - 10} more rows
                </span>
              )}
            </pre>
          )}

          {/* Image type: inline preview */}
          {block.artifact_type === "image" && (
            <div style={{ padding: "12px 16px" }}>
              <img
                src={block.content}
                alt={block.name}
                style={{ maxWidth: "100%", borderRadius: 6, display: "block" }}
              />
            </div>
          )}
        </div>
      )}

      {/* Agent attribution footer */}
      {block.agent_name && (
        <div
          style={{
            padding: "5px 12px",
            borderTop: "1px solid var(--c-brd)",
            fontSize: 10.5,
            color: "var(--c-ghost)",
            display: "flex",
            alignItems: "center",
            gap: 4,
          }}
        >
          <span>from</span>
          <span style={{ color: "var(--c-dim)", fontWeight: 500 }}>{block.agent_name}</span>
        </div>
      )}
    </div>
  );
}

/* ── System message ── */
/** Inline marker the backend stamps onto the persisted compact-summary
 *  message body. We detect it here (vs. inventing a new role) so the
 *  summary survives a fresh fetch with no schema migration — the marker
 *  IS the type tag. */
const COMPACT_SUMMARY_MARKER = "[fleet:compact-summary]";

function MessageContentInner({ message, msgRef }: { message: ChatMessage; msgRef?: React.RefObject<HTMLDivElement | null> }) {
  // Compact-summary card short-circuit. The backend persists the
  // summary as a normal assistant row, but the body opens with the
  // marker — pull the body text out, strip the marker, hand it to
  // CompactSummaryCard so the user gets the dedicated card UI instead
  // of a wall-of-prose assistant turn.
  if (message.role === "assistant") {
    const firstText = message.content.find(b => b.type === "text") as
      | { type: "text"; text: string }
      | undefined;
    const raw = firstText?.text ?? "";
    if (raw.trimStart().startsWith(COMPACT_SUMMARY_MARKER)) {
      const body = raw
        .trimStart()
        .slice(COMPACT_SUMMARY_MARKER.length)
        .replace(/^\s*\n?/, "");
      return <CompactSummaryCard summary={body} timestamp={message.timestamp} />;
    }
  }

  if (message.role === "system") {
    // Inline dispatch-permission card (non-blocking, lives in chat feed).
    const permBlock = message.content.find(b => b.type === "dispatch_permission") as import("@/types/chat").DispatchPermissionBlock | undefined;
    if (permBlock) {
      return <DispatchPermissionCard block={permBlock} />;
    }

    // Inline spawn-agent card (editable form on a gap, result card otherwise).
    const spawnBlock = message.content.find(b => b.type === "spawn_form") as import("@/types/chat").SpawnFormBlock | undefined;
    if (spawnBlock) return <SpawnFormCard block={spawnBlock} />;

    // Dispatch inline cards — show in Fleet chat AND right panel
    const pendingBlock = message.content.find(b => b.type === "dispatch_pending") as import("@/types/chat").DispatchPendingBlock | undefined;
    if (pendingBlock) return <DispatchPendingCard block={pendingBlock} />;

    const resultBlock = message.content.find(b => b.type === "dispatch_result") as import("@/types/chat").DispatchResultBlock | undefined;
    if (resultBlock) return <DispatchResultCard block={resultBlock} />;

    // Proactive agent report — show as attributed card in Fleet chat
    const reportBlock = message.content.find(b => b.type === "agent_report") as import("@/types/chat").AgentReportBlock | undefined;
    if (reportBlock) return <AgentReportCard block={reportBlock} />;

    // Artifact produced by a dispatched agent
    const artifactBlock = message.content.find(b => b.type === "artifact") as ArtifactBlock | undefined;
    if (artifactBlock) return <ArtifactCard block={artifactBlock} />;

    // OAuth / bridge auth-required info card — amber, non-blocking.
    const authBlock = message.content.find(b => b.type === "auth_required") as import("@/types/chat").AuthRequiredBlock | undefined;
    if (authBlock) return <AuthRequiredCard block={authBlock} />;

    // Sign-in card: the session's CLI agent isn't signed in. Signs it in and
    // resumes the prompt on success.
    const cliLoginBlock = message.content.find(b => b.type === "cli_login") as import("@/types/chat").CliLoginBlock | undefined;
    if (cliLoginBlock) return <CliLoginCard block={cliLoginBlock} messageId={message.id} />;

    // Legacy text-based system messages. Errors get a more prominent
    // card so failures in Create PR / branch ops / WS / agent runs
    // can't be missed mid-conversation — the previous styling was so
    // muted the user mistook failed PR attempts for silent no-ops.
    const text = message.content.find(b => b.type === "text")?.text ?? "";
    // Errors route through the one shared in-chat error surface, so every
    // failure (WS / provider, git ops, a rejected slash command) looks the
    // same and adapts to light/dark via the --c-err* tokens.
    if (text.startsWith("Task failed:")) {
      return <ChatError message={text.replace(/^Task failed:\s*/, "")} />;
    }
    // Non-error system notices (Task complete / branch ops) keep the muted
    // neutral card.
    const isResult = text.startsWith("Task complete:");
    const icon = isResult ? <CheckCircle2 size={12} /> : <ArrowRightLeft size={12} />;
    return (
      <div className="fade-in" style={{
        margin: "4px 0 14px",
        padding: "7px 12px",
        borderRadius: 8, background: "var(--c-srf)", border: "1px solid var(--c-brd)",
        display: "flex", alignItems: "flex-start", gap: 9,
        overflow: "hidden",
      }}>
        <span style={{ color: "var(--c-dim)", flexShrink: 0, marginTop: 1 }}>{icon}</span>
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={{
            fontSize: 12.5,
            color: "var(--c-dim)",
            lineHeight: 1.5,
            wordBreak: "break-word", overflowWrap: "anywhere",
          }}>
            {text}
          </span>
        </div>
      </div>
    );
  }
  return message.role === "user"
    ? <UserMessage content={message.content} msgRef={msgRef} />
    : <AssistantMessage message={message} />;
}

/**
 * Memoised wrapper. ChatView re-renders on every store update (every
 * WS event ~30/sec during a stream). Without React.memo, ALL messages
 * in the conversation re-rendered on every tick — markdown re-parsing,
 * tool-call rendering, dispatch-card sub-components. With 50+ messages
 * and a 200-message conversation this was the single biggest perf
 * killer in the chat surface.
 *
 * Custom equality: a message is treated as unchanged if id + content
 * reference + cost_usd + duration_ms match. Streaming deltas mutate
 * `contentSoFar` (never an existing message), so finalised messages
 * never need to re-render. The msgRef callback is purposely excluded
 * from the comparison — it changes only for the "latest user message"
 * (used for scroll anchoring) and a stale ref one frame is invisible.
 */
export const MessageContent = React.memo(MessageContentInner, (prev, next) => {
  if (prev.message.id !== next.message.id) return false;
  if (prev.message.content !== next.message.content) return false;
  if (prev.message.cost_usd !== next.message.cost_usd) return false;
  if (prev.message.duration_ms !== next.message.duration_ms) return false;
  if (prev.message.usage !== next.message.usage) return false;
  return true;
});

/* Present-tense verb for the live activity line — "editing products.py",
 * "reading config", "running command"… Mirrors the tool-name → action
 * mapping used elsewhere; falls back to a generic verb for unknown tools. */
function liveVerb(name: string, input: Record<string, unknown> | undefined): string {
  const n = (name || "").toLowerCase();
  const base = (p: unknown) =>
    typeof p === "string" && p ? p.split(/[\\/]/).pop() || "" : "";
  const fp = base(input?.file_path ?? input?.path ?? input?.notebook_path);
  if (n === "read" || n === "notebookread") return fp ? `reading ${fp}` : "reading";
  if (n === "edit" || n === "multiedit" || n === "notebookedit")
    return fp ? `editing ${fp}` : "editing";
  if (n === "write") return fp ? `creating ${fp}` : "creating a file";
  if (n === "bash" || n === "powershell" || n === "shell") return "running a command";
  if (n === "grep") return "searching the code";
  if (n === "glob") return "finding files";
  if (n === "ls" || n === "listdir") return "listing files";
  if (n === "webfetch") return "reading a page";
  if (n === "websearch") return "searching the web";
  if (n === "task" || n === "agent" || n === "dispatch_to_agent") return "delegating to an agent";
  if (n === "todowrite" || n === "todoread") return "planning";
  if (n === "exitplanmode") return "finishing the plan";
  if (n.includes("remember") || n.includes("memory")) return "saving to memory";
  if (n.includes("recall")) return "recalling memory";
  if (n.includes("review")) return "reviewing changes";
  if (n.includes("commit")) return "committing";
  if (n.includes("test")) return "running tests";
  if (n.includes("build") || n.includes("compile")) return "building";
  if (n.includes("install")) return "installing packages";
  if (n.startsWith("mcp__")) {
    return `using ${humanizeToolName(name).toLowerCase()}`;
  }
  return name ? `running ${name}` : "working";
}

/* Full file path a file-touching tool is operating on (Read/Edit/Write/…),
 * or null for non-file tools — used to make the live activity line clickable
 * so it opens that file in the right-side editor pane. */
function toolFilePath(name: string, input: Record<string, unknown> | undefined): string | null {
  const n = (name || "").toLowerCase();
  if (["read", "edit", "multiedit", "write", "notebookread", "notebookedit"].includes(n)) {
    const p = input?.file_path ?? input?.path ?? input?.notebook_path;
    return typeof p === "string" && p ? p : null;
  }
  return null;
}

/* ── Streaming message ── */
export function StreamingMessage({ text, thinking }: { text: string; thinking: string }) {
  // Per-field selectors — full-state useAppStore() subscribed the
  // streaming bubble to every notification push, draft keystroke and
  // pane-focus change on top of the per-token deltas it already needs
  // to render. With markdown re-parse + content-block map per render
  // this is the hottest component during a stream.
  const activeSessionId = useAppStore(s => s.activeSessionId);
  const staffSessionId = useAppStore(s => s.staffSessionId);
  const sid = activeSessionId || staffSessionId;
  const { activeToolCalls, streamStartTime, isStreaming, contentSoFar } = useChatStore(selectSession(sid));
  const toolCallList = Object.entries(activeToolCalls);
  // Smoothly reveal the trailing (still-streaming) text block so the live
  // response types out at a steady cadence — decoupled from the bursty network
  // deltas — the way Claude / ChatGPT / Cursor animate their streams. Only the
  // LAST text block is typed; earlier ones (already capped by a following tool
  // call) stay fully shown, preserving the chronological text↔tool interleave
  // rendered below. The hook runs unconditionally to keep React hook order.
  let lastTextIdx = -1;
  for (let i = contentSoFar.length - 1; i >= 0; i--) {
    if (contentSoFar[i]?.type === "text") { lastTextIdx = i; break; }
  }
  const lastBlock = lastTextIdx >= 0 ? contentSoFar[lastTextIdx] : undefined;
  const lastTextRaw = lastBlock ? stripDispatch((lastBlock as { text: string }).text) : "";
  const typedTail = useTypewriter(lastTextRaw);

  // Apply the same transcript-view rules the finalised messages use,
  // otherwise the toggle silently no-ops on the row that's actually
  // moving (the live stream). Summary → drop thinking & tools;
  // thinking/verbose → force-expand the relevant rows.
  const transcriptView = useAppStore(s => s.transcriptView);
  const forceToolOpen     = transcriptView === "verbose";
  const dropThinking      = transcriptView === "summary";
  const dropTools         = transcriptView === "summary";

  // Build a tool_id → result lookup so each in-history tool_use row can
  // render with its output if the tool_result has already landed.
  const completedResults: Record<string, { output: string; is_error: boolean }> = {};
  for (const b of contentSoFar) {
    if (b.type === "tool_result") {
      const tr = b as { tool_id: string; output: string; is_error: boolean };
      if (tr.tool_id) completedResults[tr.tool_id] = { output: tr.output, is_error: tr.is_error };
    }
  }
  // Filter active tools that have already landed in contentSoFar so
  // we don't render the same tool twice (once from history, once from
  // the still-running map). Match by tool_id.
  const completedToolIds = new Set(
    contentSoFar.filter(b => b.type === "tool_use").map(b => (b as { tool_id: string }).tool_id)
  );
  const visibleTools = dropTools
    ? []
    : toolCallList.filter(([id]) => !completedToolIds.has(id));
  const hasContent = contentSoFar.length > 0;
  const showLiveThinking = !dropThinking && !!thinking;

  // Live activity line — the single morphing status word at the foot of the
  // stream. When a tool is running it reflects the action ("editing X",
  // "reading Y"); otherwise it reads "thinking". Shown while idle OR while a
  // tool runs, so the user always sees what the agent is doing right now.
  const lastVisible = visibleTools.at(-1);
  const activeTool = lastVisible
    ? (lastVisible[1] as { name: string; input: Record<string, unknown> })
    : null;
  // Spawn directives in the live text are masked from the markdown; the
  // label is where the user sees what's happening ("creating 3 agents").
  const spawnCount = countSpawnTokens(text);
  const liveLabel = activeTool
    ? liveVerb(activeTool.name, activeTool.input)
    : spawnCount > 1 ? `creating ${spawnCount} agents`
    : spawnCount === 1 ? "creating agent"
    : showLiveThinking ? "thinking"
    : (text || hasContent) ? "responding" : "thinking";
  const liveFilePath = activeTool ? toolFilePath(activeTool.name, activeTool.input) : null;

  // Unified elapsed timer — used by both ThinkingIndicator and StreamingStats
  const [elapsed, setElapsed] = useState(0);
  // Live reasoning is collapsed by default — the user clicks the Fleetify
  // mark to reveal it (no auto-expand). Same as the finished-message thoughts.
  const [liveThoughtsOpen, setLiveThoughtsOpen] = useState(false);
  useEffect(() => {
    if (!isStreaming || !streamStartTime) { setElapsed(0); return; }
    const iv = setInterval(() => setElapsed(Date.now() - streamStartTime), 300);
    return () => clearInterval(iv);
  }, [isStreaming, streamStartTime]);

  return (
    <div style={{ marginBottom: 28 }} className="fade-in">
      <div>
        {/* Render contentSoFar in chronological order so thinking,
            text and tool blocks interleave the way the model emitted
            them — Claude Code Desktop's pattern of "short comment →
            tool batch → short comment → tool batch" instead of
            "everything thinking then everything tools". Each block
            stays flat (no grouping). MessageContent's batching kicks
            in once the message lands in messages[]. */}
        {contentSoFar.map((block, i) => {
          if (block.type === "text") {
            // Trailing block reveals through the typewriter (typedTail); the
            // earlier, settled blocks render in full.
            const t = i === lastTextIdx ? typedTail : stripDispatch((block as { text: string }).text);
            if (!t) return null;
            return <MarkdownBody key={`cs-${i}`} text={t} />;
          }
          if (block.type === "thinking") {
            // Consolidated into the ThoughtsChip rendered below the
            // live tools — inline rendering stacks 5+ chips when
            // Codex emits one reasoning burst per tool batch.
            return null;
          }
          if (block.type === "tool_use") {
            if (dropTools) return null;
            const tb = block as {
              tool_id: string;
              tool_name: string;
              tool_kind?: string;
              input: Record<string, unknown>;
            };
            return (
              <ToolCallRow
                key={`cs-${tb.tool_id || i}`}
                toolName={tb.tool_name}
                toolKind={tb.tool_kind}
                input={tb.input}
                output={completedResults[tb.tool_id]?.output}
                isError={completedResults[tb.tool_id]?.is_error}
                forceOpen={forceToolOpen}
              />
            );
          }
          return null;
        })}
        {/* Still-running tools (no output yet) */}
        {visibleTools.map(([id, tc]) => (
          <ToolCallRow key={id} toolName={tc.name} input={tc.input} forceOpen={forceToolOpen} />
        ))}
        {/* Unified live indicator — ONE persistent glowing Fleetify mark
            that stays mounted across every working state (thinking →
            responding → editing X). Only the LABEL swaps, with a soft
            fade-slide crossfade (key forces the remount that triggers the
            animation). Previously two separate elements (a thinking chip
            and an activity line) each carried their own logo, so the mark
            "jumped" when the state changed. Now the logo never unmounts —
            just the text morphs. Below, the live reasoning text scrolls
            while the model is thinking. */}
        {isStreaming && (() => {
          const hasLiveThinking = !dropThinking && showLiveThinking && !!thinking && !!thinking.trim();
          const reasoningOpen = liveThoughtsOpen && hasLiveThinking;
          // The mark is clickable when there's either a file to open (tool)
          // or reasoning to reveal. File wins (open in editor); otherwise it
          // toggles the live reasoning — collapsed by default, never auto-open.
          const clickable = !!liveFilePath || hasLiveThinking;
          const onClick = liveFilePath
            ? (e: React.MouseEvent) => { e.stopPropagation(); useAppStore.getState().openFile(liveFilePath); }
            : hasLiveThinking
              ? () => setLiveThoughtsOpen(v => !v)
              : undefined;
          return (
          <div className="fade-in" style={{ margin: "8px 0", maxWidth: 640 }}>
            <button
              type="button"
              onClick={onClick}
              onMouseDown={e => e.preventDefault()}
              disabled={!clickable}
              title={liveFilePath ? `Open ${liveFilePath} in the editor` : hasLiveThinking ? (reasoningOpen ? "Hide reasoning" : "Show reasoning") : undefined}
              style={{
                display: "inline-flex", alignItems: "center", gap: 7,
                background: "none", border: "none", outline: "none", padding: 0,
                cursor: clickable ? "pointer" : "default",
                fontFamily: "inherit", textAlign: "left",
              }}
            >
              {/* PERSISTENT — same node for the whole stream, no key. */}
              <LogoMark size={13} glow style={{ flexShrink: 0, color: "var(--c-high)" }} />
              <span
                key={liveLabel}
                className="thinking-shimmer-text live-label-swap"
                data-label={liveLabel}
                style={{
                  fontSize: 12, fontWeight: 500,
                  fontFamily: "var(--font-sans)", letterSpacing: "-0.01em",
                  maxWidth: 460, overflow: "hidden",
                  textOverflow: "ellipsis", whiteSpace: "nowrap",
                  textDecoration: liveFilePath ? undefined : "none",
                }}
              >
                {liveLabel}
              </span>
              {hasLiveThinking && (
                <ChevronRight size={11} strokeWidth={2} style={{
                  color: "var(--c-ghost)", flexShrink: 0,
                  transform: reasoningOpen ? "rotate(90deg)" : "none",
                  transition: "transform 0.15s",
                }} />
              )}
              {elapsed >= 5000 && (
                <span style={{
                  fontSize: 9.5, color: "var(--c-ghost)", opacity: 0.5,
                  fontFamily: "var(--font-mono)", letterSpacing: 0,
                }}>
                  {fmtDuration(Math.floor(elapsed / 5000) * 5000)}
                </span>
              )}
            </button>

            {/* Live reasoning text — collapsed by default, eased open when the
                user clicks the mark. */}
            {hasLiveThinking && (
              <div style={{
                display: "grid",
                gridTemplateRows: reasoningOpen ? "1fr" : "0fr",
                transition: "grid-template-rows 0.25s ease",
              }}>
                <div style={{ overflow: "hidden" }}>
                  <p style={{
                    marginTop: 7, marginLeft: 2, paddingLeft: 11,
                    borderLeft: "2px solid var(--c-brd)",
                    fontSize: 12.5, color: "var(--c-dim)", lineHeight: 1.65,
                    whiteSpace: "pre-wrap", fontStyle: "italic",
                    maxHeight: 200, overflowY: "auto",
                  }}>
                    {thinking}
                  </p>
                </div>
              </div>
            )}
          </div>
          );
        })()}
        {/* The standalone elapsed/token stats row was removed: it rendered
            a SECOND timer ("3s") right under the ThoughtsChip's own
            "thinking · 0s", so two separate time readouts stacked during a
            turn. The reasoning chip (live) and the final committed message
            stats now carry timing — one element, not two. */}
      </div>
    </div>
  );
}
