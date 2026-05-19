/**
 * Live Pulse — bottom tactical comms log of the right-sidebar Pulse layout.
 *
 * Stripe-/Datadog-style real-time stream of fleet events: tool calls,
 * errors, permission asks, dispatch results, cost finalisations. Filter
 * pills narrow the stream. Pause stops auto-scroll so the reader can
 * inspect a row without it sliding away.
 *
 * Design discipline:
 *   - Rich 2-line rows: top = agent · project · time / count badge,
 *     bottom = tool icon + tool name + input preview (or message text).
 *   - One pulsing focal per active session, color reserved for status
 *     (error, permission, success). Everything else monochrome.
 *
 * Reads:
 *   - chat-store sessions[*].processLog (tool start / update / end / error)
 *   - chat-store sessions[*].messages (turn completes, dispatch results)
 *   - app-store sessions (resolve session_id → title, project)
 *
 * Writes: nothing (pure visualisation).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Pause, Play,
  Terminal, FileText, Pencil, Search, Globe, FolderSearch,
  Wrench, Brain, MessageSquare, CheckCircle2, AlertCircle, ShieldAlert,
  ClipboardList, ListTodo, Cpu, DollarSign,
} from "lucide-react";
import { useChatStore } from "@/stores/chat-store";
import { useShallow } from "zustand/react/shallow";
import type { Session } from "@/types/session";
import { GroupLabel } from "./pulse-bits";
import { folderName } from "@/lib/utils";

type EventKind = "tool" | "error" | "permission" | "complete" | "message" | "dispatch";

interface PulseEvent {
  id: string;
  ts: number;
  sessionId: string;
  agentName: string;
  project?: string | null;
  kind: EventKind;
  /** Headline text (used for non-tool events: prompt, error message, etc.). */
  text: string;
  /** Tool-specific fields (only for kind === "tool" or "error" with a tool). */
  toolName?: string;
  /** Concise input preview — `command` for Bash, `file_path` for edits, etc. */
  detail?: string;
  /** Wall-clock duration of the tool call in ms (start → end). */
  durationMs?: number;
  /** Cost in USD attached to a "complete" message event. */
  costUsd?: number;
  /** True when a tool call ended in error. */
  isError?: boolean;
}

const FILTERS: Array<{ id: "all" | EventKind; label: string }> = [
  { id: "all",         label: "All" },
  { id: "tool",        label: "Tools" },
  { id: "error",       label: "Errors" },
  { id: "permission",  label: "Permissions" },
  { id: "complete",    label: "Costs" },
];

/* ── Helpers ─────────────────────────────────────────────────────── */

function relTimeShort(ts: number): string {
  const dt = (Date.now() - ts) / 1000;
  if (dt < 5) return "now";
  if (dt < 60) return `${Math.round(dt)}s`;
  if (dt < 3600) return `${Math.round(dt / 60)}m`;
  if (dt < 86400) return `${Math.round(dt / 3600)}h`;
  return `${Math.round(dt / 86400)}d`;
}

function absTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleString(undefined, {
    month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

function fmtUsd(c: number): string {
  if (c < 0.01) return `$${c.toFixed(4)}`;
  if (c < 1)    return `$${c.toFixed(2)}`;
  return `$${c.toFixed(2)}`;
}

function fmtDur(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s - m * 60)}s`;
}

/* ── Tool input → concise preview ──────────────────────────────────
   The `name` arg is kept in the signature for future per-tool tweaks
   (e.g. truncate Bash commands more aggressively than file paths) but
   the current implementation is field-driven — pick the most useful
   string from the input regardless of which tool it came from. */
function toolDetail(_name: string, input: Record<string, unknown> | undefined): string | undefined {
  if (!input) return undefined;
  const get = (k: string): string | undefined => {
    const v = input[k];
    return typeof v === "string" ? v : undefined;
  };
  // Order matters: pick the most informative field first.
  const cmd = get("command"); if (cmd) return cmd;
  const fp  = get("file_path"); if (fp) return fp;
  const pat = get("pattern"); if (pat) return pat;
  const url = get("url"); if (url) return url;
  const q   = get("query"); if (q) return q;
  const desc = get("description"); if (desc) return desc;
  const path = get("path"); if (path) return path;
  // Agent / dispatch tools: surface the prompt.
  const prompt = get("prompt"); if (prompt) return prompt;
  return undefined;
}

/* ── Tool kind → lucide icon ─────────────────────────────────────── */
function toolIcon(name: string): React.ReactNode {
  switch (name) {
    case "Bash":              return <Terminal size={10} />;
    case "Read":              return <FileText size={10} />;
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":      return <Pencil size={10} />;
    case "Grep":              return <Search size={10} />;
    case "Glob":              return <FolderSearch size={10} />;
    case "WebFetch":
    case "WebSearch":         return <Globe size={10} />;
    case "TodoWrite":
    case "TodoRead":          return <ListTodo size={10} />;
    case "Agent":
    case "Task":              return <Brain size={10} />;
    case "ClipboardList":     return <ClipboardList size={10} />;
    case "computer":          return <Cpu size={10} />;
    default:                  return <Wrench size={10} />;
  }
}

/* ── Component ───────────────────────────────────────────────────── */

interface Props {
  sessions: Session[];
  onJump?: (sessionId: string) => void;
  /** Cap the stream. Default 50 — bigger than the old 30 since rows are taller. */
  cap?: number;
}

export function LivePulse({ sessions, onJump, cap = 50 }: Props) {
  // ── Narrow selectors split into 3 flat projections ──
  // `useShallow` compares its result with shallow Object.is per key.
  // The earlier "one projection that builds wrapper objects per
  // session" version produced fresh `{processLog, messages, ...}`
  // wrapper objects every render → useShallow saw them as always-new
  // → infinite re-render loop → React bailed out → black screen.
  // Three separate selectors return Records whose VALUES are the
  // original stable array refs from the store, so shallow comparison
  // actually holds. Each selector triggers a re-render only when its
  // specific slice changes — message_delta floods (which only touch
  // streamingText/contentSoFar) no longer touch any of these.
  const processLogMap = useChatStore(useShallow((s) => {
    const out: Record<string, typeof s.sessions[string]["processLog"]> = {};
    for (const id in s.sessions) out[id] = s.sessions[id]!.processLog;
    return out;
  }));
  const messagesMap = useChatStore(useShallow((s) => {
    const out: Record<string, typeof s.sessions[string]["messages"]> = {};
    for (const id in s.sessions) out[id] = s.sessions[id]!.messages;
    return out;
  }));
  const permRequestMap = useChatStore(useShallow((s) => {
    const out: Record<string, typeof s.sessions[string]["permissionRequest"]> = {};
    for (const id in s.sessions) out[id] = s.sessions[id]!.permissionRequest;
    return out;
  }));
  // Recombine into the shape the rest of LivePulse expects. This
  // memo's identity changes when ANY of the 3 slices change — same as
  // before, but at least no infinite loop.
  const chatSessions = useMemo(() => {
    const out: Record<string, {
      processLog: typeof processLogMap[string];
      messages: typeof messagesMap[string];
      permissionRequest: typeof permRequestMap[string];
    }> = {};
    for (const id in processLogMap) {
      out[id] = {
        processLog: processLogMap[id]!,
        messages: messagesMap[id] ?? [],
        permissionRequest: permRequestMap[id] ?? null,
      };
    }
    return out;
  }, [processLogMap, messagesMap, permRequestMap]);
  const [filter, setFilter] = useState<typeof FILTERS[number]["id"]>("all");
  const [paused, setPaused] = useState(false);
  const feedRef = useRef<HTMLDivElement>(null);
  const lastEventCount = useRef(0);

  // Re-render every 5s so timestamps refresh ("3s" → "8s" → "1m"). Cheap.
  const [, setTick] = useState(0);
  useEffect(() => {
    const iv = setInterval(() => setTick(t => t + 1), 5000);
    return () => clearInterval(iv);
  }, []);

  const events = useMemo<PulseEvent[]>(() => {
    const out: PulseEvent[] = [];
    for (const s of sessions) {
      const cs = chatSessions[s.id];
      if (!cs) continue;
      const project = folderName(s.project_path) || null;

      // Process-log events (tool runs).
      for (const e of cs.processLog) {
        const ts = e.endedAt ?? e.startedAt;
        if (!ts) continue;
        const detail = toolDetail(e.name, e.input);
        const durationMs = e.endedAt && e.startedAt ? e.endedAt - e.startedAt : undefined;

        if (e.status === "errored") {
          out.push({
            id: `err:${e.tool_id}`,
            ts, sessionId: s.id, agentName: s.title, project,
            kind: "error",
            toolName: e.name,
            detail: e.output ? e.output.slice(0, 140) : detail,
            durationMs,
            isError: true,
            text: `${e.name} failed`,
          });
        } else if (e.status === "completed") {
          out.push({
            id: `tool:${e.tool_id}`,
            ts, sessionId: s.id, agentName: s.title, project,
            kind: "tool",
            toolName: e.name,
            detail,
            durationMs,
            text: e.name,
          });
        } else if (e.status === "running") {
          out.push({
            id: `toolrun:${e.tool_id}`,
            ts: e.startedAt, sessionId: s.id, agentName: s.title, project,
            kind: "tool",
            toolName: e.name,
            detail,
            text: `${e.name}…`,
          });
        }
      }

      // Permission asks — current outstanding only (resolved ones disappear
      // from the store, so this acts as "what's blocking right now").
      if (cs.permissionRequest) {
        // Use the stable `requestedAt` captured by setPermissionRequest.
        // Was: Date.now() inside the useMemo body, which re-stamped the
        // permission row on every recompute (sessions/chatSessions
        // change), so its relative-time label kept resetting to "now"
        // and the row kept jumping to the top of the time-sorted list.
        out.push({
          id: `perm:${cs.permissionRequest.id}`,
          ts: cs.permissionRequest.requestedAt ?? Date.now(),
          sessionId: s.id, agentName: s.title, project,
          kind: "permission",
          toolName: cs.permissionRequest.tool_name,
          detail: cs.permissionRequest.command,
          text: `awaits approval — ${cs.permissionRequest.tool_name}`,
        });
      }

      // Message-derived events: assistant complete + cost.
      for (const msg of cs.messages) {
        if (!msg.timestamp) continue;
        const ts = new Date(msg.timestamp).getTime();
        if (Number.isNaN(ts)) continue;
        if (msg.role === "assistant") {
          out.push({
            id: `done:${msg.id}`,
            ts, sessionId: s.id, agentName: s.title, project,
            kind: "complete",
            costUsd: msg.cost_usd,
            text: msg.cost_usd ? `response · ${fmtUsd(msg.cost_usd)}` : "response complete",
          });
        } else if (msg.role === "user") {
          const blk = msg.content.find(b => b.type === "text");
          const text = blk && blk.type === "text" ? blk.text.slice(0, 120) : "(prompt)";
          out.push({
            id: `msg:${msg.id}`,
            ts, sessionId: s.id, agentName: s.title, project,
            kind: "message",
            text,
          });
        }
      }
    }
    return out.sort((a, b) => b.ts - a.ts).slice(0, cap);
  }, [sessions, chatSessions, cap]);

  // Per-kind counters for the filter pills (always over the unfiltered set).
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: events.length };
    for (const e of events) c[e.kind] = (c[e.kind] ?? 0) + 1;
    return c;
  }, [events]);

  const filtered = useMemo(() => {
    const base = filter === "all" ? events : events.filter(e => e.kind === filter);

    // ── Pass 1 — exact duplicates ──
    // Same agent + same kind + same tool + same text/detail in a row →
    // collapse to one row with "×N" badge. Catches "Bash ×7" spam.
    const exact: Array<PulseEvent & { count?: number; totalCost?: number }> = [];
    for (const e of base) {
      const last = exact[exact.length - 1];
      const same =
        last &&
        last.sessionId === e.sessionId &&
        last.kind === e.kind &&
        (last.toolName ?? "") === (e.toolName ?? "") &&
        last.text === e.text &&
        (last.detail ?? "") === (e.detail ?? "");
      if (same) {
        last!.count = (last!.count ?? 1) + 1;
        if (e.ts > last!.ts) last!.ts = e.ts;
        if (typeof e.costUsd === "number") {
          last!.totalCost = (last!.totalCost ?? last!.costUsd ?? 0) + e.costUsd;
        }
      } else {
        exact.push({ ...e });
      }
    }

    // ── Pass 2 — time-bucketed rollup ──
    // Same agent + same kind within ~30 minutes → roll up into one
    // summary row. This is what unrolls a 5-row "zara_login · response"
    // wall into "zara_login · 5 responses · $0.45 total" with a peek
    // at the latest text. Permissions are NEVER rolled — each ask is
    // its own actionable signal.
    const ROLLUP_WINDOW_MS = 30 * 60 * 1000;
    const ROLLUP_MIN_COUNT = 3;
    const out: Array<PulseEvent & { count?: number; totalCost?: number; rolledUp?: boolean; firstTs?: number }> = [];
    for (const e of exact) {
      const last = out[out.length - 1];
      const candidate =
        last &&
        last.sessionId === e.sessionId &&
        last.kind === e.kind &&
        last.kind !== "permission" &&
        Math.abs(last.ts - e.ts) <= ROLLUP_WINDOW_MS;
      if (candidate) {
        // Merge into rolling bucket. Newest text wins so the user sees
        // recent context; count + totalCost accumulate.
        last!.count = (last!.count ?? 1) + (e.count ?? 1);
        last!.firstTs = Math.min(last!.firstTs ?? last!.ts, e.ts);
        if (e.ts > last!.ts) {
          last!.ts = e.ts;
          last!.text = e.text;
          last!.detail = e.detail;
          last!.toolName = e.toolName;
        }
        if (typeof e.costUsd === "number") {
          last!.totalCost = (last!.totalCost ?? last!.costUsd ?? 0) + e.costUsd;
        } else if (typeof e.totalCost === "number") {
          last!.totalCost = (last!.totalCost ?? last!.costUsd ?? 0) + e.totalCost;
        }
        last!.rolledUp = (last!.count ?? 1) >= ROLLUP_MIN_COUNT;
      } else {
        out.push({ ...e, firstTs: e.ts });
      }
    }
    return out;
  }, [events, filter]);

  // Auto-scroll to top (newest) when new events arrive — unless paused.
  useEffect(() => {
    if (paused) return;
    if (filtered.length > lastEventCount.current && feedRef.current) {
      feedRef.current.scrollTop = 0;
    }
    lastEventCount.current = filtered.length;
  }, [filtered.length, paused]);

  return (
    <div
      style={{
        flexShrink: 0,
        display: "flex",
        flexDirection: "column",
        // Min ensures it never collapses; max grows with sidebar height
        // up to a generous cap. Old 240 was cramped at every-row 2-line.
        minHeight: 200,
        maxHeight: 420,
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          padding: "10px 12px 4px",
          gap: 6,
        }}
      >
        <span
          style={{
            flex: 1,
            fontSize: 10.5,
            fontWeight: 500,
            letterSpacing: "0.01em",
            color: "var(--c-ghost)",
          }}
        >
          Live Pulse
        </span>
        <button
          onClick={() => setPaused(p => !p)}
          title={paused ? "Resume auto-scroll" : "Pause auto-scroll"}
          style={{
            width: 18, height: 18, borderRadius: 4, border: "none",
            background: paused ? "var(--c-srf2)" : "transparent",
            color: paused ? "var(--c-med)" : "var(--c-ghost)",
            cursor: "pointer",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}
          onMouseEnter={(e) => { if (!paused) e.currentTarget.style.background = "var(--c-srf)"; }}
          onMouseLeave={(e) => { if (!paused) e.currentTarget.style.background = "transparent"; }}
        >
          {paused ? <Play size={9} /> : <Pause size={9} />}
        </button>
      </div>

      {/* Filter pills with per-kind counts */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 4,
          padding: "0 12px 6px",
        }}
      >
        {FILTERS.map(f => {
          const active = filter === f.id;
          const n = counts[f.id] ?? 0;
          // Hide zero-count filters (except "all" which always shows so the
          // user has a way back to the unfiltered stream).
          if (n === 0 && f.id !== "all") return null;
          return (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              style={{
                display: "inline-flex", alignItems: "center", gap: 5,
                padding: "2px 9px",
                borderRadius: 999,
                border: "none",
                background: active ? "var(--c-srf2)" : "transparent",
                color: active ? "var(--c-high)" : "var(--c-low)",
                fontSize: 10.5,
                fontWeight: 500,
                cursor: "pointer",
                transition: "background 0.12s, color 0.12s",
              }}
              onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = "var(--c-srf)"; }}
              onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = "transparent"; }}
            >
              {f.label}
              <span style={{
                fontSize: 9.5,
                color: active ? "var(--c-low)" : "var(--c-ghost)",
                fontWeight: 500,
                fontVariantNumeric: "tabular-nums",
              }}>
                {n}
              </span>
            </button>
          );
        })}
      </div>

      {/* Stream */}
      <div
        ref={feedRef}
        className="scroll-subtle"
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "4px 8px 12px",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {filtered.length === 0 ? (
          <span style={{ fontSize: 11.5, color: "var(--c-ghost)", padding: "8px 12px" }}>
            {filter === "all" ? "No activity yet" : `No ${filter} events`}
          </span>
        ) : (
          filtered.map(e => (
            <PulseRow
              key={e.id}
              evt={e}
              onJump={onJump ? () => onJump(e.sessionId) : undefined}
            />
          ))
        )}
      </div>
    </div>
  );
}

/* ── Row ─────────────────────────────────────────────────────────── */

function PulseRow({
  evt, onJump,
}: {
  evt: PulseEvent & { count?: number; totalCost?: number; rolledUp?: boolean; firstTs?: number };
  onJump?: () => void;
}) {
  // Severity stripe (left edge): only colored for events that actually
  // need attention. Tool/message/complete-without-cost stay quiet.
  const stripe =
    evt.kind === "error"      ? "#f87171" :
    evt.kind === "permission" ? "#fb923c" :
    evt.kind === "complete"   ? "var(--c-low)" :  // muted, success but quiet
    "var(--c-srf2)";

  // Leading icon — picks the right glyph for the event kind/tool.
  const leadIcon =
    evt.kind === "error"      ? <AlertCircle size={11} />
  : evt.kind === "permission" ? <ShieldAlert size={11} />
  : evt.kind === "complete"   ? <CheckCircle2 size={11} />
  : evt.kind === "message"    ? <MessageSquare size={11} />
  : evt.toolName              ? toolIcon(evt.toolName)
  : <Wrench size={11} />;

  const leadColor =
    evt.kind === "error"      ? "#f87171" :
    evt.kind === "permission" ? "#fb923c" :
    evt.kind === "complete"   ? "var(--c-low)" :
    "var(--c-low)";

  const Tag: keyof React.JSX.IntrinsicElements = onJump ? "button" : "div";
  // Whether to render the second (detail) line. Some events have nothing
  // useful to put there, so we collapse to a single line for those.
  const hasDetail = !!(evt.detail || evt.text) && !(evt.kind === "complete" && !evt.costUsd);

  return (
    <Tag
      onClick={onJump}
      title={absTime(evt.ts)}
      style={{
        position: "relative",
        display: "flex",
        flexDirection: "column",
        gap: 2,
        padding: "6px 8px 7px 12px",
        background: "transparent",
        border: "none",
        cursor: onJump ? "pointer" : "default",
        textAlign: "left",
        width: "100%",
        color: "inherit",
        transition: "background 0.1s",
        borderRadius: 6,
      }}
      onMouseEnter={(e) => {
        if (onJump) (e.currentTarget as HTMLElement).style.background = "var(--c-srf)";
      }}
      onMouseLeave={(e) => {
        if (onJump) (e.currentTarget as HTMLElement).style.background = "transparent";
      }}
    >
      {/* Severity stripe */}
      <span
        aria-hidden
        style={{
          position: "absolute",
          left: 2, top: 7, bottom: 7, width: 2,
          background: stripe,
          borderRadius: 2,
        }}
      />

      {/* Top line — agent · project · time · count */}
      <div style={{
        display: "flex", alignItems: "center", gap: 6,
        fontSize: 11.5, lineHeight: 1.2,
      }}>
        <span style={{
          color: "var(--c-high)", fontWeight: 500,
          maxWidth: 160, overflow: "hidden",
          textOverflow: "ellipsis", whiteSpace: "nowrap",
          flexShrink: 1, minWidth: 0,
        }}>
          {evt.agentName}
        </span>
        {evt.project && (
          <>
            <span style={{ color: "var(--c-brd2)", fontSize: 10 }}>·</span>
            <span style={{
              color: "var(--c-ghost)",
              fontFamily: "var(--font-mono)",
              fontSize: 10.5,
              maxWidth: 90, overflow: "hidden",
              textOverflow: "ellipsis", whiteSpace: "nowrap",
              flexShrink: 1, minWidth: 0,
            }}>
              {evt.project}
            </span>
          </>
        )}
        <span style={{ flex: 1 }} />
        {evt.count && evt.count > 1 && (
          <span
            title={`${evt.count} consecutive identical events`}
            style={{
              flexShrink: 0,
              fontSize: 10, fontWeight: 600,
              color: "var(--c-low)",
              background: "var(--c-srf)",
              padding: "1px 6px", borderRadius: 999,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            ×{evt.count}
          </span>
        )}
        <span style={{
          flexShrink: 0,
          fontSize: 10.5, color: "var(--c-ghost)",
          fontVariantNumeric: "tabular-nums",
        }}>
          {relTimeShort(evt.ts)}
        </span>
      </div>

      {/* Bottom line — icon + content (tool name + detail, message text, etc.) */}
      {hasDetail && (
        <div style={{
          display: "flex", alignItems: "center", gap: 6,
          fontSize: 11.5, lineHeight: 1.35,
          color: "var(--c-dim)",
          minWidth: 0,
        }}>
          <span style={{
            display: "inline-flex", alignItems: "center",
            color: leadColor, flexShrink: 0,
          }}>
            {leadIcon}
          </span>

          {/* Rolled-up summary — fires when the time-bucket aggregator has
              folded 3+ same-(agent,kind) events into one row. We render a
              single human-readable line ("5 responses · $0.45 total · last:
              ...") so the user reads the *trend* not 5 near-identical rows. */}
          {evt.rolledUp ? (
            <>
              <span style={{ color: "var(--c-low)", fontWeight: 500, flexShrink: 0 }}>
                {evt.count} {pluralKindLabel(evt.kind, evt.count ?? 1)}
              </span>
              {evt.kind === "complete" && (evt.totalCost ?? 0) > 0 && (
                <>
                  <span style={{ color: "var(--c-brd2)", fontSize: 10, flexShrink: 0 }}>·</span>
                  <span style={{
                    color: "var(--c-high)", fontWeight: 500,
                    fontVariantNumeric: "tabular-nums",
                    flexShrink: 0,
                  }}>
                    {fmtUsd(evt.totalCost!)} total
                  </span>
                </>
              )}
              {evt.detail && (
                <>
                  <span style={{ color: "var(--c-brd2)", fontSize: 10, flexShrink: 0 }}>·</span>
                  <span style={{
                    flex: 1, minWidth: 0,
                    fontFamily: "var(--font-mono)",
                    color: "var(--c-dim)",
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                  }}>
                    last: {evt.detail}
                  </span>
                </>
              )}
              {!evt.detail && evt.text && evt.kind !== "complete" && (
                <>
                  <span style={{ color: "var(--c-brd2)", fontSize: 10, flexShrink: 0 }}>·</span>
                  <span style={{
                    flex: 1, minWidth: 0,
                    color: "var(--c-low)",
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                  }}>
                    last: {evt.text}
                  </span>
                </>
              )}
            </>
          ) : (
            <>
          {/* Tool events: tool name (mono) + " · " + detail (mono, dim) */}
          {evt.kind === "tool" && evt.toolName && (
            <>
              <span style={{
                fontFamily: "var(--font-mono)",
                color: "var(--c-low)", fontWeight: 500,
                flexShrink: 0,
              }}>
                {evt.toolName}
              </span>
              {evt.detail && (
                <>
                  <span style={{ color: "var(--c-brd2)", fontSize: 10, flexShrink: 0 }}>·</span>
                  <span style={{
                    flex: 1, minWidth: 0,
                    fontFamily: "var(--font-mono)",
                    color: "var(--c-dim)",
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                  }}>
                    {evt.detail}
                  </span>
                </>
              )}
              {evt.durationMs != null && evt.durationMs > 50 && (
                <span style={{
                  flexShrink: 0,
                  fontSize: 10, color: "var(--c-ghost)",
                  fontVariantNumeric: "tabular-nums",
                }}>
                  {fmtDur(evt.durationMs)}
                </span>
              )}
            </>
          )}

          {/* Error: tool name in red + reason */}
          {evt.kind === "error" && (
            <>
              {evt.toolName && (
                <span style={{
                  fontFamily: "var(--font-mono)",
                  color: "#f87171", fontWeight: 500,
                  flexShrink: 0,
                }}>
                  {evt.toolName}
                </span>
              )}
              {evt.detail && (
                <>
                  <span style={{ color: "var(--c-brd2)", fontSize: 10, flexShrink: 0 }}>·</span>
                  <span style={{
                    flex: 1, minWidth: 0,
                    color: "var(--c-low)",
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                  }}>
                    {evt.detail}
                  </span>
                </>
              )}
            </>
          )}

          {/* Permission: orange tool name + command preview */}
          {evt.kind === "permission" && (
            <>
              <span style={{ color: "var(--c-low)", flexShrink: 0 }}>
                awaits approval
              </span>
              {evt.toolName && (
                <>
                  <span style={{ color: "var(--c-brd2)", fontSize: 10, flexShrink: 0 }}>·</span>
                  <span style={{
                    fontFamily: "var(--font-mono)",
                    color: "#fb923c", fontWeight: 500,
                    flexShrink: 0,
                  }}>
                    {evt.toolName}
                  </span>
                </>
              )}
              {evt.detail && (
                <>
                  <span style={{ color: "var(--c-brd2)", fontSize: 10, flexShrink: 0 }}>·</span>
                  <span style={{
                    flex: 1, minWidth: 0,
                    fontFamily: "var(--font-mono)",
                    color: "var(--c-dim)",
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                  }}>
                    {evt.detail}
                  </span>
                </>
              )}
            </>
          )}

          {/* Cost / completion */}
          {evt.kind === "complete" && evt.costUsd != null && (
            <>
              <span style={{ color: "var(--c-low)", flexShrink: 0 }}>response</span>
              <span style={{ color: "var(--c-brd2)", fontSize: 10, flexShrink: 0 }}>·</span>
              <span style={{
                color: "var(--c-high)", fontWeight: 500,
                fontVariantNumeric: "tabular-nums",
                flexShrink: 0,
                display: "inline-flex", alignItems: "center", gap: 3,
              }}>
                <DollarSign size={9} style={{ opacity: 0.6 }} />
                {fmtUsd(evt.costUsd).slice(1)}
              </span>
            </>
          )}

          {/* User message: just the text, plain */}
          {evt.kind === "message" && (
            <span style={{
              flex: 1, minWidth: 0,
              color: "var(--c-low)",
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            }}>
              {evt.text}
            </span>
          )}

          {/* Dispatch / fallback */}
          {evt.kind === "dispatch" && (
            <span style={{
              flex: 1, minWidth: 0,
              color: "var(--c-low)",
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            }}>
              {evt.text}
            </span>
          )}
            </>
          )}
        </div>
      )}
    </Tag>
  );
}

/** Plural-aware label for rolled-up Live Pulse summary rows.
 *  E.g. ("complete", 5) → "responses", ("tool", 1) → "tool call". */
function pluralKindLabel(kind: string, n: number): string {
  const s = n === 1 ? "" : "s";
  switch (kind) {
    case "complete":   return `response${s}`;
    case "message":    return `message${s}`;
    case "tool":       return `tool call${s}`;
    case "error":      return `error${s}`;
    case "dispatch":   return `dispatch${kind ? "es" : ""}`;
    case "permission": return `permission${s}`;
    default:           return `event${s}`;
  }
}

export { GroupLabel };
