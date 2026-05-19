import { useState, useEffect, useRef, useMemo } from "react";
import {
  CheckCircle2, Circle, Loader2,
  ArrowLeft, AlertCircle,
  Square, RotateCcw, ChevronDown,
} from "lucide-react";
import {
  fetchBulkStats, fetchSessionDetail, stopSession, restartSession, setBudgetLimit,
  fetchSessionActivity, fetchSessionFiles, fetchSessionMemory,
  createSessionMemory, updateSessionMemory, deleteSessionMemory,
} from "@/lib/api";
import { useAppStore } from "@/stores/app-store";
import { useChatStore } from "@/stores/chat-store";
import { useShallow } from "zustand/react/shallow";
import { ProviderLogo } from "@/components/ui/provider-logo";
import { folderName } from "@/lib/utils";
import type { Session } from "@/types/session";
import type {
  SessionDetail, SessionActivityItem, SessionFileEntry, SessionMemoryItem,
} from "@/lib/api";
import { PendingPermissionsQueue } from "./pending-permissions-queue";
import {
  Sparkline, bucketToolCallsByMinute, GroupLabel,
} from "./pulse-bits";
import { MissionStatus } from "./mission-status";

type Stats = {
  message_count: number;
  total_cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  cache_tokens: number;
  last_model?: string | null;
};

interface Props {
  sessions: Session[];
  onSelectAgent: (id: string) => void;
  onNewAgent: () => void;
  onClose: () => void;
}

/* ─── Injected keyframes ─── */
function CcStyles() {
  return (
    <style>{`
      @keyframes cc-fade-up {
        from { opacity: 0; transform: translateY(6px); }
        to   { opacity: 1; transform: translateY(0); }
      }
      @keyframes cc-pulse {
        0%, 100% { opacity: 0.55; transform: scale(0.85); }
        50%       { opacity: 1;    transform: scale(1.15); }
      }
      @keyframes dot-seq {
        0%, 60%, 100% { opacity: 0.15; }
        20%           { opacity: 1; }
      }
      .cc-row:hover  { background: var(--c-srf) !important; }
      .cc-stat:hover { transform: translateY(-1px); background: color-mix(in srgb, var(--c-srf) 85%, white 15%) !important; }
      .cc-row-actions { opacity: 0; transition: opacity 0.12s; }
      .cc-row:hover .cc-row-actions { opacity: 1; }
    `}</style>
  );
}

/* ─── Helpers ─── */
function fmtCost(n: number) {
  if (n <= 0)    return "$0.00";
  if (n < 0.001) return `$${n.toFixed(5)}`;
  if (n < 0.01)  return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}
function fmtTokens(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** Magazine-stat pair: bold tabular number on top, dim small uppercase
 *  label underneath. Used in Hub agent cards so a glance scan picks
 *  up "12 edits, 4 files, 47 cmd" via the numbers without reading
 *  the labels. The previous flat "label · number · label · number"
 *  layout had no anchor. */
function StatPair({ value, label }: { value: number | string; label: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "baseline", gap: 4 }}>
      <span style={{
        fontSize: 13,
        fontWeight: 700,
        color: "var(--c-high)",
        fontVariantNumeric: "tabular-nums",
        letterSpacing: "-0.01em",
      }}>
        {value}
      </span>
      <span style={{
        fontSize: 9.5,
        fontWeight: 500,
        color: "var(--c-ghost)",
        textTransform: "uppercase",
        letterSpacing: "0.06em",
      }}>
        {label}
      </span>
    </span>
  );
}
function shortModel(m: string | null | undefined) {
  if (!m) return null;
  if (m.includes("opus"))   return "Opus";
  if (m.includes("sonnet")) return "Sonnet";
  if (m.includes("haiku"))  return "Haiku";
  if (m.includes("gpt-4o")) return "GPT-4o";
  if (m.includes("gpt-4"))  return "GPT-4";
  if (m.includes("gemini")) return "Gemini";
  return m.split("-").slice(0, 2).join("-");
}

/* Full-identifier form used in the Models breakdown. Preserves the whole
   model id (including "-preview" and date stamps) so variants stay fully
   (fullModelLabel was deleted along with FleetSummary; if a future
   session-detail view needs the long form, restore it from git.) */
function ctxLimit(model: string | null | undefined): number | null {
  if (!model) return null;
  if (model.includes("claude"))  return 200_000;
  if (model.includes("gpt-4"))   return 128_000;
  if (model.includes("gemini-2") || model.includes("gemini-1.5")) return 1_000_000;
  if (model.includes("gemini"))  return 32_000;
  return null;
}
function fmtCtx(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${Math.round(n / 1_000)}k`;
  return String(n);
}
function relativeTime(ts: string | null | undefined): string {
  if (!ts) return "never";
  const diff = Date.now() - new Date(ts).getTime();
  const m = Math.floor(diff / 60000);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (diff < 60000) return "just now";
  if (m < 60)       return `${m}m ago`;
  if (h < 24)       return `${h}h ago`;
  return `${d}d ago`;
}




/* ─── Status config ─── */
type StatusKey = "running" | "waiting" | "error" | "starting" | "idle" | "stopped";
const STATUS_CFG: Record<StatusKey, { color: string | null; label: string; glow: string | null }> = {
  running:  { color: "#4ade80", label: "Running",  glow: "cc-glow-green"  },
  waiting:  { color: "#fb923c", label: "Waiting",  glow: "cc-glow-orange" },
  starting: { color: "#60a5fa", label: "Starting", glow: "cc-glow-blue"   },
  error:    { color: "#f87171", label: "Error",    glow: null              },
  idle:     { color: null,      label: "Idle",     glow: null              },
  stopped:  { color: null,      label: "Stopped",  glow: null              },
};

/* ─── Shared spinner timing ──
 *
 * Mirror of the left sidebar's spinner timing tokens so every active
 * spinner in the app rotates at the same speed AND in the same phase.
 * Sync trick: each spinner sets a NEGATIVE animation-delay equal to its
 * current offset from the page-load epoch. Computed once per mount via
 * useMemo, so the value never jitters during a render.
 *
 * Keep these constants in sync with the matching ones in sidebar.tsx —
 * they have to use the same duration AND the same anchor (performance.now())
 * for cross-panel sync to hold.
 */
const SPINNER_DURATION_MS = 1400;
function useSpinnerSyncDelay(): string {
  return useMemo(() => {
    const now = (typeof performance !== "undefined" && performance.now)
      ? performance.now()
      : 0;
    return `-${Math.round(now % SPINNER_DURATION_MS)}ms`;
  }, []);
}


/* ─── Status ring ──
 *
 * Mirrors the left-sidebar AgentStatusIcon family so the right Control
 * Center reads as the same product. Same design tokens, same rhythm:
 *
 *   • A 14px touch box surrounds a smaller (~9px) visual ring. Decouples
 *     the click-target / row-rhythm from the perceived icon weight, so
 *     the panel never feels checkbox-heavy.
 *   • All ring states render at the same outer silhouette so an agent
 *     transitioning running → idle → running doesn't shift the row.
 *   • Active states use a conic-gradient + radial-gradient mask to
 *     produce a smooth comet-trail spin (Apple/Linear/Vercel style),
 *     not a dasharray arc with jagged caps and not three sequentially-
 *     pulsing dots that read as static punctuation.
 *   • State is encoded by *colour inside the ring*, not by changing the
 *     shape. Waiting (∥) and error (●) are the two intentional shape
 *     exceptions — they demand attention or signal a hard state.
 */
function StatusRing({ status, size = 12 }: { status: string; size?: number }) {
  // Visual ring is rendered smaller than the touch box so it doesn't
  // dominate the dense Fleet rows. 0.66 ratio matches the left sidebar.
  const ring = Math.max(8, Math.round(size * 0.66));
  const stroke = 1; // paper-thin; thicker reads as a checkbox waiting
  const inset = ring / 2 - stroke;
  // Negative delay anchored to performance.now() epoch — keeps every
  // active spinner across the app rotating in lockstep.
  const animationDelay = useSpinnerSyncDelay();

  // ── Active states: conic-gradient sweep ──
  // 90° transparent gap + 270° accent fill → unambiguous comet trail.
  // "starting" uses a cooler dim accent ("warming up"); "running" uses
  // the theme high tone ("alive"). Same animation speed → in-sync feel
  // across a busy fleet of agents.
  if (status === "running" || status === "starting") {
    const accent = status === "running" ? "var(--c-high)" : "var(--c-low)";
    return (
      <span style={{
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        width: size, height: size, flexShrink: 0,
      }}>
        <span
          aria-hidden
          style={{
            display: "block",
            width: ring,
            height: ring,
            borderRadius: "50%",
            backgroundImage: `conic-gradient(from 0deg, transparent 0deg 90deg, ${accent} 360deg)`,
            WebkitMask: `radial-gradient(circle at center, transparent ${inset}px, #000 ${inset + 0.5}px)`,
            mask: `radial-gradient(circle at center, transparent ${inset}px, #000 ${inset + 0.5}px)`,
            animation: `ring-spin ${SPINNER_DURATION_MS}ms linear infinite`,
            animationDelay,
            transformOrigin: "center",
          }}
        />
      </span>
    );
  }

  if (status === "waiting") {
    return (
      <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 2, width: size, height: size, flexShrink: 0 }}>
        <style>{`@keyframes pause-bar { 0%,100%{opacity:0.4;transform:scaleY(0.7)} 50%{opacity:1;transform:scaleY(1)} }`}</style>
        {[0, 1].map(i => (
          <span key={i} style={{
            width: 2, height: Math.round(size * 0.55), borderRadius: 1.5, display: "inline-block", flexShrink: 0,
            background: "#fb923c",
            animation: `pause-bar 1.8s ease-in-out ${i * 0.25}s infinite`,
            transformOrigin: "center",
          }} />
        ))}
      </span>
    );
  }

  if (status === "error") {
    return (
      <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: size, height: size, flexShrink: 0 }}>
        <span style={{ width: 4, height: 4, borderRadius: "50%", background: "#f87171", display: "inline-block" }} />
      </span>
    );
  }

  // idle / stopped — hollow ring outline (matches sidebar
  // AgentStatusIcon). User picked this style; it reads at a glance
  // without competing with active-state spinners.
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", justifyContent: "center",
      width: size, height: size, flexShrink: 0,
    }}>
      <span
        aria-hidden
        style={{
          display: "block",
          width: 5,
          height: 5,
          borderRadius: "50%",
          border: "1px solid var(--c-ghost)",
          boxSizing: "border-box",
          background: "transparent",
        }}
      />
    </span>
  );
}

/* ─── Section ─── Quiet GroupLabel-rhythm header — matches the rest of the
   right sidebar (Tokens / Tools today / Models active / Today). Drops the
   uppercase-700 "BIG SECTION" treatment that read like a hacker dashboard. */
function Section({ title, defaultOpen = true, children, badge }: {
  title: string; icon?: React.ReactNode; defaultOpen?: boolean;
  children: React.ReactNode; badge?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{ marginBottom: 4 }}>
      <button onClick={() => setOpen(!open)} style={{
        display: "flex", alignItems: "center", gap: 6, width: "100%",
        padding: "10px 0 4px", background: "none", border: "none",
        cursor: "pointer", textAlign: "left",
      }}>
        <ChevronDown size={9} style={{
          color: "var(--c-ghost)", flexShrink: 0,
          transform: open ? "rotate(0deg)" : "rotate(-90deg)",
          transition: "transform 0.18s ease",
        }} />
        <span style={{
          fontSize: 10.5, fontWeight: 500, color: "var(--c-ghost)", flex: 1,
          letterSpacing: "0.01em",
        }}>
          {title}
        </span>
        {badge && (
          <span style={{
            fontSize: 10, color: "var(--c-ghost)", fontWeight: 500,
            fontFamily: "var(--font-mono)",
          }}>
            {badge}
          </span>
        )}
      </button>
      {open && (
        <div style={{ paddingBottom: 6, animation: "cc-fade-up 0.15s ease-out" }}>
          {children}
        </div>
      )}
    </div>
  );
}

/* ─── Active agent card — shows live tool call / streaming / permission ─── */
function ActiveAgentCard({ session, stats, onClick, delay = 0, dimmed = false }: {
  session: Session; stats?: Stats; onClick: () => void; delay?: number; dimmed?: boolean;
}) {
  // Render an active/waiting agent as a flat row (same shape as left sidebar's
  // AgentRow). Card chrome, accent stripes and inline tool-call previews moved
  // out — rich info belongs in the drill-down view, not the operations hub
  // where every row is competing for attention.
  const chatState  = useChatStore(s => s.sessions[session.id]);
  const permReq    = chatState?.permissionRequest ?? null;
  const isWaiting  = session.status === "waiting" || permReq != null;

  const [stopping, setStopping] = useState(false);
  const handleStop = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setStopping(true);
    try { await stopSession(session.id); } catch { /**/ }
    setStopping(false);
  };

  const cost  = stats?.total_cost_usd ?? 0;

  return (
    <FleetRow
      session={session}
      cost={cost}
      stats={stats}
      onClick={onClick}
      delay={delay}
      isWaiting={isWaiting}
      dimmed={dimmed}
      action={
        <button
          className="cc-row-actions"
          onClick={handleStop}
          title="Stop"
          style={{
            width: 18, height: 18, borderRadius: 4, border: "none", cursor: "pointer",
            display: "flex", alignItems: "center", justifyContent: "center",
            background: "none", color: "var(--c-ghost)",
          }}
          onMouseEnter={e => { e.currentTarget.style.color = "#f87171"; }}
          onMouseLeave={e => { e.currentTarget.style.color = "var(--c-ghost)"; }}
        >
          {stopping ? <Loader2 size={9} style={{ animation: "spin 1s linear infinite" }} /> : <Square size={9} />}
        </button>
      }
    />
  );
}

/**
 * FleetRow — shared one-line agent row for the right sidebar.
 *
 * Mirrors the visual rhythm of the left sidebar's AgentRow:
 *   [status icon] [title (fades on right)] [time-ago | hover: action + cost]
 *
 * Single source of truth so Running and Idle groups render identically and
 * the operations hub stops feeling like a separate UI dialect.
 */
function FleetRow({
  session, cost, onClick, action, delay = 0, isWaiting = false,
  dimmed = false, stats,
}: {
  session: Session;
  cost: number;
  onClick: () => void;
  action: React.ReactNode;
  delay?: number;
  isWaiting?: boolean;
  /** When some other row is demanding attention (pending permission), ask
   *  this row to step back. Goes to 0.5 opacity so the permission row pops. */
  dimmed?: boolean;
  /** Per-session bulk stats for the dense meta line (model · msgs · tokens). */
  stats?: Stats;
}) {
  const [hovered, setHovered] = useState(false);
  const cs = useChatStore(s => s.sessions[session.id]);
  const isRunning = session.status === "running" || session.status === "starting";
  const costLabel = cost > 0 ? fmtCost(cost) : null;
  const modelShort = shortModel(stats?.last_model ?? null);
  const totalToks = stats ? stats.input_tokens + stats.output_tokens + stats.cache_tokens : 0;
  const msgs = stats?.message_count ?? 0;

  // ── Output summary (the agent's "what did I actually do today") ──
  // We mine processLog for filesystem-modifying tool calls (Edit / Write /
  // MultiEdit) so the row can show concrete output instead of abstract
  // token counts. Bash commands surface as a "last cmd" fallback.
  const output = useMemo(() => {
    if (!cs?.processLog?.length) return { edits: 0, files: 0, lastCmd: null as string | null, lastTool: null as string | null };
    const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
    const cutoff = startOfDay.getTime();
    const files = new Set<string>();
    let edits = 0;
    let lastCmd: string | null = null;
    let lastTool: string | null = null;
    for (const e of cs.processLog) {
      if (e.status !== "completed") continue;
      const ts = e.endedAt ?? e.startedAt;
      const inDay = ts >= cutoff;
      if (e.name === "Edit" || e.name === "Write" || e.name === "MultiEdit" || e.name === "NotebookEdit") {
        if (inDay) {
          edits++;
          const fp = e.input.file_path;
          if (typeof fp === "string") files.add(fp);
        }
      } else if (e.name === "Bash") {
        const cmd = e.input.command;
        if (typeof cmd === "string") {
          // Keep the verb + first arg, capped — `pytest tests/auth` not the full pipeline.
          lastCmd = cmd.split(/\s+/).slice(0, 2).join(" ").slice(0, 28);
        }
      }
      lastTool = e.name;
    }
    return { edits, files: files.size, lastCmd, lastTool };
  }, [cs?.processLog]);

  // ── Live activity (only when agent is actually doing something now) ──
  // Streamlined to just the "in-flight" cases. Last-said quote is surfaced
  // separately below as the centrepiece of the card.
  const liveActivity = useMemo<string | null>(() => {
    if (!cs) return null;
    const calls = Object.values(cs.activeToolCalls);
    const c = calls[0];
    if (c) {
      const inp = c.input;
      const detail =
        typeof inp.command   === "string" ? inp.command :
        typeof inp.file_path === "string" ? inp.file_path.split("/").slice(-2).join("/") :
        typeof inp.pattern   === "string" ? inp.pattern :
        typeof inp.url       === "string" ? inp.url :
        typeof inp.query     === "string" ? inp.query :
        null;
      return detail ? `${c.name} · ${detail.slice(0, 56)}` : c.name;
    }
    if (cs.streamingText) {
      const s = cs.streamingText.trim();
      if (s.length > 0) return s.slice(-90);
    }
    if (cs.streamingThinking) {
      const s = cs.streamingThinking.trim();
      if (s.length > 0) return `thinking · ${s.slice(-72)}`;
    }
    return null;
  }, [cs]);

  // ── Latest said — the agent's most recent assistant text, cleaned to
  //    a single readable sentence. This is the *centrepiece* of the card:
  //    it's what the agent last produced in human language, the answer
  //    to "what did they actually do for me?". ──
  const latestSaid = useMemo<string | null>(() => {
    if (!cs?.messages?.length) return null;
    for (let i = cs.messages.length - 1; i >= 0; i--) {
      const m = cs.messages[i]!;
      if (m.role !== "assistant") continue;
      let text = "";
      for (const block of m.content) {
        if (block.type === "text" && typeof block.text === "string") {
          text += (text ? " " : "") + block.text;
        }
      }
      // Strip markdown noise so the preview reads as prose.
      const cleaned = text
        .replace(/^#+\s+/gm, "")
        .replace(/```[\s\S]*?```/g, "")
        .replace(/`[^`]+`/g, "")
        .replace(/\*\*([^*]+)\*\*/g, "$1")
        .replace(/\s+/g, " ")
        .trim();
      if (cleaned.length >= 3) {
        return cleaned.slice(0, 140) + (cleaned.length > 140 ? "…" : "");
      }
    }
    return null;
  }, [cs?.messages]);

  // ── Today's productivity counters — the "what did they actually
  //    produce" stats. We separate cmd / msg / file from the existing
  //    `output` so they can render as a stat strip on the card. ──
  const counters = useMemo(() => {
    const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
    const cutoff = startOfDay.getTime();
    let cmdCount = 0;
    let msgCount = 0;
    if (cs) {
      for (const e of cs.processLog) {
        if (e.status !== "completed") continue;
        const ts = e.endedAt ?? e.startedAt;
        if (ts < cutoff) continue;
        if (e.name === "Bash") cmdCount++;
      }
      for (const m of cs.messages) {
        if (m.role !== "user") continue;
        if (!m.timestamp) continue;
        const ts = new Date(m.timestamp).getTime();
        if (Number.isNaN(ts) || ts < cutoff) continue;
        msgCount++;
      }
    }
    return { cmds: cmdCount, msgs: msgCount };
  }, [cs]);

  // Per-row sparkline. Two sources, picked in priority order:
  //   1. 1h tool-call rate from processLog — only meaningful when the agent
  //      has been actively working in the current browser session.
  //   2. 7d cost-by-day from messages — survives across sessions because
  //      it derives from message timestamps, so even stopped agents that
  //      were used days ago carry a real spend trace.
  const sparkValues = useMemo(() => {
    const hourly = bucketToolCallsByMinute(cs?.processLog ?? [], 60);
    if (hourly.some(v => v > 0)) return { values: hourly, label: "1h", source: "tools" as const };
    // Fallback: cost over last 7 days, one slot per day.
    const days = 7;
    const now = Date.now();
    const slots = new Array<number>(days).fill(0);
    for (const m of cs?.messages ?? []) {
      if (typeof m.cost_usd !== "number" || !m.timestamp) continue;
      const ts = new Date(m.timestamp).getTime();
      if (Number.isNaN(ts)) continue;
      const ageD = (now - ts) / 86_400_000;
      if (ageD < 0 || ageD >= days) continue;
      const idx = days - 1 - Math.floor(ageD);
      slots[idx] = (slots[idx] ?? 0) + m.cost_usd;
    }
    return { values: slots, label: "7d", source: "cost" as const };
  }, [cs?.processLog, cs?.messages]);

  // Persistent waiting (permission) wins over hover styling — the row
  // glows orange so background-dispatched permission asks can never get
  // buried in the list.
  const waitingGlow = isWaiting;

  // The card has 4 vertical zones, top-down:
  //   1. Header   — status dot · agent title · cost (right)
  //   2. Meta     — project · model · time-ago    (small, dim)
  //   3. Quote    — agent's most recent assistant text, in a quote-block
  //                 with a left rail. This is the WHAT — the answer to
  //                 "what did this agent actually produce for me?".
  //   4. Counters — today's edits / files / cmds / msgs · sparkline
  //
  // When the agent is live (streaming / active tool call), zone 3 is
  // replaced with a live-activity strip in mono font with a pulsing dot.
  const isLiveStreaming = !!liveActivity;
  const showQuote = !isLiveStreaming && !!latestSaid;
  const hasAnyCounter =
    output.edits > 0 || output.files > 0 || counters.cmds > 0 ||
    counters.msgs > 0 || msgs > 0 || totalToks > 0;

  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        position: "relative",
        display: "flex", flexDirection: "column", gap: 4,
        width: "100%",
        padding: "11px 12px 12px",
        borderRadius: 8,
        border: "none",
        // Hairline divider between cards — defines each agent as its own
        // self-contained block without heavy card chrome.
        borderBottom: "1px solid var(--c-brd)",
        cursor: "pointer", textAlign: "left",
        transition: "background 0.12s, opacity 0.2s",
        background: waitingGlow
          ? "rgba(251,146,60,0.06)"
          : hovered ? "var(--c-srf)" : "transparent",
        opacity: dimmed ? 0.5 : 1,
        animation: `cc-fade-up 0.15s ease-out ${delay}ms both`,
      }}
    >
      {waitingGlow && (
        <span
          aria-hidden
          style={{
            position: "absolute", left: 0, top: 8, bottom: 8, width: 2,
            background: "#fb923c", borderRadius: 2,
          }}
        />
      )}

      {/* ── Zone 1: header — status + name on left, cost on right ── */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, width: "100%" }}>
        <StatusRing status={isWaiting ? "waiting" : session.status} size={9} />
        {session.tool && <ProviderLogo tool={session.tool} size={11} />}
        <span style={{
          flex: 1, minWidth: 0, overflow: "hidden",
          WebkitMaskImage: "linear-gradient(to right, black 90%, transparent 100%)",
          maskImage: "linear-gradient(to right, black 90%, transparent 100%)",
          fontSize: 13.5,
          fontWeight: isRunning ? 600 : 500,
          letterSpacing: "-0.005em",
          lineHeight: 1.2,
          color: isRunning ? "var(--c-high)" : "var(--c-low)",
          whiteSpace: "nowrap",
        }}>
          {session.title}
        </span>
        {hovered ? (
          <span style={{ flexShrink: 0 }}>{action}</span>
        ) : costLabel && (
          <span style={{
            flexShrink: 0,
            fontSize: 12,
            color: "var(--c-low)", fontWeight: 600,
            fontFamily: "'SF Mono','Menlo','Consolas',monospace",
            fontVariantNumeric: "tabular-nums",
          }}>
            {costLabel}
          </span>
        )}
      </div>

      {/* ── Zone 2: meta — project · model · time, all small + dim ── */}
      <div style={{
        display: "flex", alignItems: "baseline", gap: 6,
        marginLeft: 19,
        fontSize: 10.5, color: "var(--c-ghost)", lineHeight: 1.2,
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
      }}>
        {(() => {
          const project = session.project_path
            ? folderName(session.project_path)
            : null;
          const parts: React.ReactNode[] = [];
          if (project) parts.push(<span key="p">{project}</span>);
          if (modelShort) parts.push(<span key="m" style={{ color: "var(--c-dim)" }}>{modelShort}</span>);
          parts.push(
            <span key="t" style={{ marginLeft: "auto", color: "var(--c-ghost)" }}>
              {relativeTime(session.last_accessed ?? session.created_at)}
            </span>
          );
          return parts.flatMap((node, i) =>
            i === 0 || i === parts.length - 1
              ? [node]
              : [<span key={`s${i}`} aria-hidden style={{ color: "var(--c-brd2)" }}>·</span>, node]
          );
        })()}
      </div>

      {/* ── Zone 3a: live activity strip (only while streaming/working) ── */}
      {isLiveStreaming && liveActivity && (
        <div style={{
          display: "flex", alignItems: "center", gap: 7,
          marginTop: 6, marginLeft: 19,
          padding: "5px 8px",
          borderRadius: 5,
          background: "var(--c-srf)",
          fontSize: 10.5, color: "var(--c-low)",
          lineHeight: 1.35,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          fontFamily: cs && Object.keys(cs.activeToolCalls).length > 0
            ? "'SF Mono','Menlo','Consolas',monospace"
            : undefined,
        }}>
          <span aria-hidden style={{
            width: 5, height: 5, borderRadius: 999,
            background: "var(--c-high)",
            animation: "cc-pulse 1.6s ease-in-out infinite",
            flexShrink: 0,
          }} />
          <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis" }}>
            {liveActivity}
          </span>
        </div>
      )}

      {/* ── Zone 3b: latest "said" quote — the centrepiece of the card.
          Real prose of what the agent last produced, with a left rail
          to read as a quote block. No italics, no curly quote marks —
          plain prose with structural decoration. ── */}
      {showQuote && latestSaid && (
        <div style={{
          display: "flex", gap: 8,
          marginTop: 6, marginLeft: 19,
        }}>
          <span aria-hidden style={{
            width: 2, flexShrink: 0,
            background: "var(--c-brd2)",
            borderRadius: 2,
          }} />
          <span style={{
            flex: 1, minWidth: 0,
            fontSize: 11.5, color: "var(--c-low)",
            lineHeight: 1.45,
            // Cap visible lines so very long messages don't dominate the card.
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
          }}>
            {latestSaid}
          </span>
        </div>
      )}

      {/* ── Zone 4: today's counters strip + sparkline ──
          Magazine-stat hierarchy: numbers POP at 13/700/c-high, labels
          recede at 9.5/uppercase/c-ghost. Was: numbers and labels
          rendered at the same 10.5 size with similar weights — visually
          a mushy block, hard to scan. */}
      {hasAnyCounter && (
        <div style={{
          display: "flex", alignItems: "baseline", gap: 14,
          marginTop: 7, marginLeft: 19,
          fontVariantNumeric: "tabular-nums",
        }}>
          {output.edits > 0 && <StatPair value={output.edits} label={output.edits !== 1 ? "edits" : "edit"} />}
          {output.files > 0 && <StatPair value={output.files} label={output.files !== 1 ? "files" : "file"} />}
          {counters.cmds > 0 && <StatPair value={counters.cmds} label="cmd" />}
          {counters.msgs > 0 && <StatPair value={counters.msgs} label="msg" />}
          {!output.edits && !output.files && !counters.cmds && !counters.msgs && totalToks > 0 && (
            <StatPair value={fmtTokens(totalToks)} label="tok" />
          )}
          {sparkValues.values.filter(v => v > 0).length >= 2 && (
            <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center" }}>
              <Sparkline
                values={sparkValues.values}
                width={56} height={11}
                color={isRunning ? "var(--c-high)" : "var(--c-low)"}
                strokeWidth={1.25}
                ariaLabel={sparkValues.source === "tools" ? "1h tool-call trend" : "7-day cost trend"}
              />
            </span>
          )}
        </div>
      )}
    </button>
  );
}


/* ─── Idle agent row — uses shared FleetRow ─── */
function IdleAgentRow({ session, stats, onClick, delay = 0, dimmed = false }: {
  session: Session; stats?: Stats; onClick: () => void; delay?: number; dimmed?: boolean;
}) {
  const cost = stats?.total_cost_usd ?? 0;
  const [restarting, setRestarting] = useState(false);
  const handleRestart = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setRestarting(true);
    try { await restartSession(session.id); } catch { /**/ }
    setRestarting(false);
  };

  return (
    <FleetRow
      session={session}
      cost={cost}
      stats={stats}
      onClick={onClick}
      delay={delay}
      dimmed={dimmed}
      action={
        <button
          onClick={handleRestart}
          title="Restart"
          style={{
            width: 18, height: 18, borderRadius: 4, border: "none", cursor: "pointer",
            display: "flex", alignItems: "center", justifyContent: "center",
            background: "none", color: "var(--c-ghost)",
          }}
          onMouseEnter={e => { e.currentTarget.style.color = "#60a5fa"; }}
          onMouseLeave={e => { e.currentTarget.style.color = "var(--c-ghost)"; }}
        >
          {restarting ? <Loader2 size={9} style={{ animation: "spin 1s linear infinite" }} /> : <RotateCcw size={9} />}
        </button>
      }
    />
  );
}

/* ─── Todo item ─── */
function TodoItem({ todo, delay = 0 }: {
  todo: { content: string; status: string; activeForm?: string };
  delay?: number;
}) {
  const isDone   = todo.status === "completed";
  const isActive = todo.status === "in_progress";
  return (
    <div style={{
      display: "flex", alignItems: "flex-start", gap: 8, padding: "5px 0",
      opacity: isDone ? 0.38 : 1,
      animation: `cc-fade-up 0.15s ease-out ${delay}ms both`,
    }}>
      <span style={{
        flexShrink: 0, marginTop: 2,
        color: isDone ? "var(--c-dim)" : isActive ? "#4ade80" : "var(--c-low)",
      }}>
        {isDone
          ? <CheckCircle2 size={12} />
          : isActive
            ? <Loader2 size={12} style={{ animation: "spin 1.5s linear infinite" }} />
            : <Circle size={12} />
        }
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 12.5, lineHeight: 1.45,
          color: isDone ? "var(--c-dim)" : isActive ? "var(--c-high)" : "var(--c-med)",
          textDecoration: isDone ? "line-through" : "none",
        }}>
          {todo.content}
        </div>
        {isActive && todo.activeForm && (
          <div style={{ fontSize: 10.5, color: "var(--c-dim)", marginTop: 2 }}>{todo.activeForm}</div>
        )}
      </div>
    </div>
  );
}

/* ─── Token bar ─── Solid theme-color fills, no rgba on dark surfaces. The
   `color` prop is now a theme var token (kept for back-compat; fall back
   to --c-low when callers still pass an rgba string). */
function TokenBar({ label, value, max, color, delay = 0 }: {
  label: string; value: number; max: number; color?: string; delay?: number;
}) {
  const pct = max > 0 ? Math.min((value / max) * 100, 100) : 0;
  // Reject rgba/translucent fills — fall back to the quiet theme low.
  const fill = (color && !color.toLowerCase().startsWith("rgba")) ? color : "var(--c-low)";
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 8, padding: "4px 0",
      animation: `cc-fade-up 0.15s ease-out ${delay}ms both`,
    }}>
      <span style={{ fontSize: 11.5, color: "var(--c-low)", width: 80, flexShrink: 0 }}>{label}</span>
      <div style={{ flex: 1, height: 3, borderRadius: 2, background: "var(--c-srf)", overflow: "hidden" }}>
        <div style={{
          width: `${pct}%`, height: "100%", borderRadius: 2,
          background: fill, transition: "width 0.5s ease-out",
        }} />
      </div>
      <span style={{ fontSize: 11, color: "var(--c-high)", fontWeight: 500, fontVariantNumeric: "tabular-nums", minWidth: 44, textAlign: "right", flexShrink: 0 }}>
        {fmtTokens(value)}
      </span>
    </div>
  );
}

/* ─── Tool row (mini bar chart) ─── */
function ToolRow({ name, count, maxCount, delay = 0 }: {
  name: string; count: number; maxCount: number; delay?: number;
}) {
  const LABELS: Record<string, string> = {
    Bash: "Bash", Read: "File read", Write: "File write", Edit: "File edit",
    Glob: "Glob", Grep: "Code search", Agent: "Sub-agent",
    WebFetch: "Web fetch", WebSearch: "Web search",
    TodoWrite: "Tasks", TodoRead: "Tasks", NotebookEdit: "Notebook", LSP: "LSP",
    Task: "Task", SendMessage: "Send message", ExitPlanMode: "Exit plan",
    EnterPlanMode: "Enter plan", ExitWorktree: "Exit worktree",
    EnterWorktree: "Enter worktree", CronCreate: "Cron job", CronList: "Cron list",
    CronDelete: "Cron delete", RemoteTrigger: "Remote trigger",
    dispatch: "Dispatch", computer: "Computer use",
  };
  const pct = maxCount > 0 ? (count / maxCount) * 100 : 0;
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 8, padding: "4px 0",
      animation: `cc-fade-up 0.15s ease-out ${delay}ms both`,
    }}>
      <span style={{
        fontSize: 11.5, color: "var(--c-med)", width: 72, flexShrink: 0,
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
      }}>
        {LABELS[name] ?? name}
      </span>
      <div style={{ flex: 1, height: 3, borderRadius: 2, background: "var(--c-srf)", overflow: "hidden" }}>
        <div style={{
          width: `${pct}%`, height: "100%", borderRadius: 2,
          background: "var(--c-ghost)", transition: "width 0.5s ease-out",
        }} />
      </div>
      <span style={{ fontSize: 11, color: "var(--c-low)", width: 26, textAlign: "right", flexShrink: 0 }}>
        {count}×
      </span>
    </div>
  );
}

/* ─── Budget section ─── */
function BudgetSection({ session }: { session?: Session }) {
  const [inputVisible, setInputVisible] = useState(false);
  const [inputVal, setInputVal]         = useState("");
  const [saving, setSaving]             = useState(false);

  if (!session) return null;

  const limit = session.budget_limit ?? null;
  const used  = session.budget_used ?? 0;
  const pct   = limit != null && limit > 0 ? Math.min(used / limit, 1) : 0;
  const exceeded = limit != null && used >= limit;

  // Bar fill: solid theme color when healthy; only saturated when actually
  // critical so the panel doesn't read as "alarm" at idle.
  const barColor =
    pct > 0.9  ? "#f87171"
    : pct > 0.75 ? "#fb923c"
    : "var(--c-high)";

  async function handleSet() {
    const parsed = parseFloat(inputVal);
    if (isNaN(parsed) || parsed <= 0) return;
    setSaving(true);
    try {
      await setBudgetLimit(session!.id, parsed);
      // Update local session in store (optimistic)
      useAppStore.getState().updateSession(session!.id, { budget_limit: parsed } as Partial<Session>);
    } catch { /* noop */ }
    setSaving(false);
    setInputVisible(false);
    setInputVal("");
  }

  async function handleClear() {
    setSaving(true);
    try {
      await setBudgetLimit(session!.id, null);
      useAppStore.getState().updateSession(session!.id, { budget_limit: null } as Partial<Session>);
    } catch { /* noop */ }
    setSaving(false);
  }

  return (
    <div style={{ marginBottom: 4 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "10px 0 4px" }}>
        <span style={{
          fontSize: 10.5, fontWeight: 500, color: "var(--c-ghost)", flex: 1,
          letterSpacing: "0.01em",
        }}>
          Budget
        </span>
        {exceeded && (
          <span style={{
            fontSize: 10, fontWeight: 600, color: "#f87171",
            letterSpacing: "0.01em",
          }}>
            exceeded
          </span>
        )}
      </div>

      {limit != null ? (
        <div style={{ paddingBottom: 8 }}>
          {/* Progress bar row */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
            <div style={{ flex: 1, height: 5, borderRadius: 3, background: "var(--c-srf)", overflow: "hidden" }}>
              <div style={{
                width: `${Math.max(pct * 100, 0)}%`, height: "100%", borderRadius: 3,
                background: barColor, transition: "width 0.4s ease-out",
              }} />
            </div>
            <span style={{ fontSize: 11, color: pct > 0.75 ? barColor : "var(--c-med)", flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>
              {fmtCost(used)} / {fmtCost(limit)}
            </span>
            <span style={{ fontSize: 10, color: "var(--c-ghost)", flexShrink: 0 }}>
              {(pct * 100).toFixed(0)}%
            </span>
          </div>

          {/* Actions */}
          {inputVisible ? (
            <div style={{ display: "flex", gap: 5, alignItems: "center" }}>
              <input
                autoFocus
                type="number"
                step="0.01"
                min="0.01"
                placeholder="New limit ($)"
                value={inputVal}
                onChange={e => setInputVal(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") handleSet(); if (e.key === "Escape") setInputVisible(false); }}
                style={{
                  flex: 1, padding: "4px 8px", borderRadius: 6,
                  border: "1px solid var(--c-brd2)", background: "var(--c-srf)",
                  color: "var(--c-high)", fontSize: 11.5, outline: "none",
                }}
              />
              <button
                onClick={handleSet}
                disabled={saving}
                style={{
                  padding: "4px 10px", borderRadius: 6, border: "none", cursor: "pointer",
                  fontSize: 11, fontWeight: 600, background: "var(--c-brd2)", color: "var(--c-med)",
                }}
              >
                {saving ? "…" : "Set"}
              </button>
              <button
                onClick={() => setInputVisible(false)}
                style={{
                  padding: "4px 8px", borderRadius: 6, border: "none", cursor: "pointer",
                  fontSize: 11, background: "none", color: "var(--c-ghost)",
                }}
              >
                Cancel
              </button>
            </div>
          ) : (
            <div style={{ display: "flex", gap: 5 }}>
              <button
                onClick={() => { setInputVal(String(limit)); setInputVisible(true); }}
                style={{
                  padding: "3px 9px", borderRadius: 5, border: "none", cursor: "pointer",
                  fontSize: 11, background: "var(--c-brd)", color: "var(--c-dim)",
                }}
                onMouseEnter={e => { e.currentTarget.style.color = "var(--c-med)"; }}
                onMouseLeave={e => { e.currentTarget.style.color = "var(--c-dim)"; }}
              >
                Change limit
              </button>
              <button
                onClick={handleClear}
                disabled={saving}
                style={{
                  padding: "3px 9px", borderRadius: 5, border: "none", cursor: "pointer",
                  fontSize: 11, background: "none", color: "var(--c-ghost)",
                }}
                onMouseEnter={e => { e.currentTarget.style.color = "#f87171"; }}
                onMouseLeave={e => { e.currentTarget.style.color = "var(--c-ghost)"; }}
              >
                {saving ? "…" : "Remove"}
              </button>
            </div>
          )}
        </div>
      ) : (
        <div style={{ paddingBottom: 8 }}>
          {inputVisible ? (
            <div style={{ display: "flex", gap: 5, alignItems: "center" }}>
              <input
                autoFocus
                type="number"
                step="0.01"
                min="0.01"
                placeholder="Limit in USD (e.g. 1.00)"
                value={inputVal}
                onChange={e => setInputVal(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") handleSet(); if (e.key === "Escape") setInputVisible(false); }}
                style={{
                  flex: 1, padding: "4px 8px", borderRadius: 6,
                  border: "1px solid var(--c-brd2)", background: "var(--c-srf)",
                  color: "var(--c-high)", fontSize: 11.5, outline: "none",
                }}
              />
              <button
                onClick={handleSet}
                disabled={saving}
                style={{
                  padding: "4px 10px", borderRadius: 6, border: "none", cursor: "pointer",
                  fontSize: 11, fontWeight: 600, background: "var(--c-brd2)", color: "var(--c-med)",
                }}
              >
                {saving ? "…" : "Set"}
              </button>
              <button
                onClick={() => setInputVisible(false)}
                style={{
                  padding: "4px 8px", borderRadius: 6, border: "none", cursor: "pointer",
                  fontSize: 11, background: "none", color: "var(--c-ghost)",
                }}
              >
                Cancel
              </button>
            </div>
          ) : (
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 11.5, color: "var(--c-ghost)" }}>No limit set</span>
              <button
                onClick={() => setInputVisible(true)}
                style={{
                  padding: "3px 9px", borderRadius: 5, border: "1px solid var(--c-brd2)",
                  background: "none", cursor: "pointer",
                  fontSize: 11, color: "var(--c-dim)",
                }}
                onMouseEnter={e => { e.currentTarget.style.color = "var(--c-med)"; e.currentTarget.style.borderColor = "var(--c-low)"; }}
                onMouseLeave={e => { e.currentTarget.style.color = "var(--c-dim)"; e.currentTarget.style.borderColor = "var(--c-brd2)"; }}
              >
                Set limit
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════
   SESSION DETAIL VIEW — supporting components
═══════════════════════════════════════ */

/** Activity-feed kind filter pills. Mirrors LivePulse's pattern but
 *  scoped to one session. Hides zero-count kinds so the bar stays calm. */
function ActivityFilter({
  active, onChange, activity,
}: {
  active: string;
  onChange: (k: string) => void;
  activity: SessionActivityItem[];
}) {
  const counts: Record<string, number> = { all: activity.length };
  for (const a of activity) counts[a.kind] = (counts[a.kind] ?? 0) + 1;
  const FILTERS: Array<{ id: string; label: string }> = [
    { id: "all", label: "All" },
    { id: "file_edit", label: "Edits" },
    { id: "file_read", label: "Reads" },
    { id: "command", label: "Commands" },
    { id: "web_fetch", label: "Web" },
    { id: "todo", label: "Todos" },
    { id: "error", label: "Errors" },
  ];
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 6 }}>
      {FILTERS.map(f => {
        const n = counts[f.id] ?? 0;
        if (n === 0 && f.id !== "all") return null;
        const isActive = active === f.id;
        return (
          <button
            key={f.id}
            onClick={() => onChange(f.id)}
            style={{
              display: "inline-flex", alignItems: "center", gap: 5,
              padding: "2px 8px", borderRadius: 999, border: "none",
              background: isActive ? "var(--c-srf2)" : "transparent",
              color: isActive ? "var(--c-high)" : "var(--c-low)",
              fontSize: 10.5, fontWeight: 500, cursor: "pointer",
              transition: "background 0.12s, color 0.12s",
            }}
            onMouseEnter={e => { if (!isActive) e.currentTarget.style.background = "var(--c-srf)"; }}
            onMouseLeave={e => { if (!isActive) e.currentTarget.style.background = "transparent"; }}
          >
            {f.label}
            <span style={{
              fontSize: 9.5, color: isActive ? "var(--c-low)" : "var(--c-ghost)",
              fontVariantNumeric: "tabular-nums",
            }}>
              {n}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** One row of the activity feed. Compact: kind icon → summary → time-ago.
 *  The summary IS the meaningful content (file path / command / URL), so
 *  the row reads at a glance. */
function ActivityFeed({
  activity, kindFilter,
}: {
  activity: SessionActivityItem[];
  kindFilter: string;
}) {
  const filtered = kindFilter === "all"
    ? activity
    : activity.filter(a => a.kind === kindFilter);

  if (filtered.length === 0) {
    return (
      <div style={{ fontSize: 11.5, color: "var(--c-dim)", padding: "2px 0 6px" }}>
        {activity.length === 0 ? "No activity recorded yet" : "No events match this filter"}
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      {filtered.slice(0, 50).map((a, i) => (
        <ActivityRow key={a.id} a={a} delay={i * 12} />
      ))}
    </div>
  );
}

function ActivityRow({ a, delay }: { a: SessionActivityItem; delay: number }) {
  const ageS = (Date.now() - new Date(a.ts).getTime()) / 1000;
  const ago = ageS < 5 ? "now"
    : ageS < 60 ? `${Math.round(ageS)}s`
    : ageS < 3600 ? `${Math.round(ageS / 60)}m`
    : ageS < 86400 ? `${Math.round(ageS / 3600)}h`
    : `${Math.round(ageS / 86400)}d`;
  const isErr = a.kind === "error" || a.payload?.error;
  const dotColor =
    isErr             ? "#f87171" :
    a.kind === "todo" ? "var(--c-low)" :
                        "var(--c-ghost)";
  const summaryColor = isErr ? "#f87171" : "var(--c-low)";
  const dur = a.payload?.duration_ms;
  return (
    <div
      style={{
        display: "flex", alignItems: "center", gap: 8,
        padding: "4px 0",
        animation: `cc-fade-up 0.15s ease-out ${delay}ms both`,
      }}
      title={new Date(a.ts).toLocaleString()}
    >
      <span aria-hidden style={{
        flexShrink: 0, width: 4, height: 4, borderRadius: 999, background: dotColor,
      }} />
      <span style={{
        flexShrink: 0, width: 64, fontSize: 10,
        color: "var(--c-ghost)", fontFamily: "var(--font-mono)",
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
      }}>
        {a.payload?.tool ?? a.kind}
      </span>
      <span style={{
        flex: 1, minWidth: 0, fontSize: 11.5, color: summaryColor,
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        fontFamily: "var(--font-mono)",
      }}>
        {a.summary}
      </span>
      {dur != null && dur > 50 && (
        <span style={{
          flexShrink: 0, fontSize: 9.5, color: "var(--c-ghost)",
          fontVariantNumeric: "tabular-nums",
        }}>
          {dur < 1000 ? `${dur}ms` : `${(dur / 1000).toFixed(dur < 10000 ? 1 : 0)}s`}
        </span>
      )}
      <span style={{
        flexShrink: 0, fontSize: 10, color: "var(--c-ghost)",
        fontVariantNumeric: "tabular-nums",
      }}>
        {ago}
      </span>
    </div>
  );
}

/** One file row — path, edit/read counts, last-touched. */
function FileRow({ file, delay }: { file: SessionFileEntry; delay: number }) {
  const ageS = file.last_ts ? (Date.now() - new Date(file.last_ts).getTime()) / 1000 : 0;
  const ago = !file.last_ts ? "" :
    ageS < 60 ? `${Math.round(ageS)}s` :
    ageS < 3600 ? `${Math.round(ageS / 60)}m` :
    ageS < 86400 ? `${Math.round(ageS / 3600)}h` :
    `${Math.round(ageS / 86400)}d`;
  // Show the last 2 path segments — full path on hover.
  const tail = file.path.split("/").filter(Boolean).slice(-2).join("/") || file.path;
  return (
    <div
      title={file.path}
      style={{
        display: "flex", alignItems: "center", gap: 8,
        padding: "4px 0",
        animation: `cc-fade-up 0.15s ease-out ${delay}ms both`,
      }}
    >
      <span style={{
        flex: 1, minWidth: 0, fontSize: 11.5, color: "var(--c-low)",
        fontFamily: "var(--font-mono)",
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
      }}>
        {tail}
      </span>
      {file.edits > 0 && (
        <span style={{ fontSize: 10, color: "var(--c-high)", fontWeight: 500, fontVariantNumeric: "tabular-nums" }}>
          {file.edits}<span style={{ color: "var(--c-ghost)", fontWeight: 400 }}>e</span>
        </span>
      )}
      {file.reads > 0 && (
        <span style={{ fontSize: 10, color: "var(--c-low)", fontVariantNumeric: "tabular-nums" }}>
          {file.reads}<span style={{ color: "var(--c-ghost)" }}>r</span>
        </span>
      )}
      <span style={{ fontSize: 10, color: "var(--c-ghost)", fontVariantNumeric: "tabular-nums", width: 28, textAlign: "right" }}>
        {ago}
      </span>
    </div>
  );
}

/** One curated memory item — title, body, kind tag. Hover reveals
 *  Edit + Delete actions. Click Edit → inline edit composer for title/
 *  content/kind, Save persists via PATCH endpoint. */
function MemoryItem({
  item, delay, compact, onDelete, onEdit,
}: {
  item: SessionMemoryItem;
  delay: number;
  compact?: boolean;
  onDelete: () => void;
  onEdit: (patch: { title?: string; content?: string; kind?: string }) => Promise<void>;
}) {
  const [hovered, setHovered] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState(item.title);
  const [draftContent, setDraftContent] = useState(item.content);
  const [draftKind, setDraftKind] = useState(item.kind);
  const [saving, setSaving] = useState(false);
  const fromOther = !!item.from_other_session;

  const startEdit = () => {
    setDraftTitle(item.title);
    setDraftContent(item.content);
    setDraftKind(item.kind);
    setEditing(true);
  };
  const cancelEdit = () => {
    setEditing(false);
  };
  const commitEdit = async () => {
    const patch: { title?: string; content?: string; kind?: string } = {};
    if (draftTitle.trim() && draftTitle !== item.title) patch.title = draftTitle.trim();
    if (draftContent.trim() && draftContent !== item.content) patch.content = draftContent.trim();
    if (draftKind && draftKind !== item.kind) patch.kind = draftKind;
    if (Object.keys(patch).length === 0) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      await onEdit(patch);
      setEditing(false);
    } catch (err) {
      console.error("Edit memory failed:", err);
    } finally {
      setSaving(false);
    }
  };

  if (editing) {
    return (
      <div style={{
        padding: 8, marginTop: 4,
        border: "1px solid var(--c-brd)", borderRadius: 8,
        background: "var(--c-srf)",
        animation: `cc-fade-up 0.12s ease-out`,
        display: "flex", flexDirection: "column", gap: 6,
      }}>
        <input
          autoFocus
          value={draftTitle}
          onChange={e => setDraftTitle(e.target.value)}
          style={{
            background: "transparent", border: "none", outline: "none",
            color: "var(--c-high)", fontSize: 12, fontWeight: 500,
            fontFamily: "inherit",
          }}
        />
        <textarea
          value={draftContent}
          onChange={e => setDraftContent(e.target.value)}
          onKeyDown={e => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); commitEdit(); }
            if (e.key === "Escape") { cancelEdit(); }
          }}
          rows={3}
          style={{
            background: "transparent", border: "none", outline: "none",
            color: "var(--c-med)", fontSize: 11.5,
            fontFamily: "inherit", resize: "vertical", minHeight: 40,
          }}
        />
        <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <select
            value={draftKind}
            onChange={e => setDraftKind(e.target.value)}
            style={{
              background: "var(--c-srf2)", border: "1px solid var(--c-brd)",
              color: "var(--c-low)", fontSize: 10.5, padding: "2px 6px",
              borderRadius: 4, outline: "none",
            }}
          >
            <option value="note">note</option>
            <option value="decision">decision</option>
            <option value="learning">learning</option>
            <option value="gotcha">gotcha</option>
            <option value="plan">plan</option>
          </select>
          <span style={{ flex: 1, fontSize: 10, color: "var(--c-ghost)" }}>⌘↵ save · Esc cancel</span>
          <button
            onClick={cancelEdit}
            style={{
              background: "transparent", border: "none", cursor: "pointer",
              color: "var(--c-ghost)", fontSize: 10.5,
              padding: "4px 8px", borderRadius: 5,
            }}
          >
            Cancel
          </button>
          <button
            onClick={commitEdit}
            disabled={saving || !draftTitle.trim() || !draftContent.trim()}
            style={{
              border: "1px solid var(--c-high)",
              background: !saving && draftTitle.trim() && draftContent.trim()
                ? "var(--c-high)" : "var(--c-srf2)",
              color: !saving && draftTitle.trim() && draftContent.trim()
                ? "var(--card)" : "var(--c-ghost)",
              fontSize: 10.5, fontWeight: 600, padding: "4px 11px",
              borderRadius: 5, cursor: "pointer",
            }}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        position: "relative",
        padding: compact ? "5px 0" : "7px 0",
        animation: `cc-fade-up 0.15s ease-out ${delay}ms both`,
        opacity: fromOther ? 0.7 : 1,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{
          flex: 1, fontSize: 12, fontWeight: 500, color: "var(--c-high)",
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>
          {item.title}
        </span>
        {item.kind !== "note" && (
          <span style={{
            fontSize: 9.5, color: "var(--c-ghost)", letterSpacing: "0.04em",
            fontFamily: "var(--font-mono)",
          }}>
            {item.kind}
          </span>
        )}
        {fromOther && (
          <span title="From a prior session on the same project" style={{
            fontSize: 9, color: "var(--c-ghost)",
            border: "1px solid var(--c-brd2)", padding: "0 5px",
            borderRadius: 3, lineHeight: "13px",
          }}>
            project
          </span>
        )}
        {hovered && (
          <>
            <button
              onClick={startEdit}
              title="Edit"
              style={{
                background: "transparent", border: "none", cursor: "pointer",
                color: "var(--c-ghost)", fontSize: 10,
                padding: "0 4px",
              }}
              onMouseEnter={e => { e.currentTarget.style.color = "var(--c-high)"; }}
              onMouseLeave={e => { e.currentTarget.style.color = "var(--c-ghost)"; }}
            >
              edit
            </button>
            <button
              onClick={onDelete}
              title="Remove this memory item"
              style={{
                background: "transparent", border: "none", cursor: "pointer",
                color: "var(--c-ghost)", fontSize: 11,
                padding: "0 4px",
              }}
              onMouseEnter={e => { e.currentTarget.style.color = "#f87171"; }}
              onMouseLeave={e => { e.currentTarget.style.color = "var(--c-ghost)"; }}
            >
              ×
            </button>
          </>
        )}
      </div>
      {!compact && (
        <div style={{
          fontSize: 11, color: "var(--c-dim)", lineHeight: 1.45,
          marginTop: 3, whiteSpace: "pre-wrap", wordBreak: "break-word",
        }}>
          {item.content}
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════
   SESSION DETAIL VIEW
═══════════════════════════════════════ */
function SessionDetailView({ sessionId, session }: { sessionId: string; session?: Session }) {
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [error, setError]   = useState(false);
  // Must be declared before any early returns (Rules of Hooks)
  const [showAllPending, setShowAllPending] = useState(false);

  // Auto-captured activity ledger + derived file usage. Both poll alongside
  // the main detail fetch so the panel stays in sync as the agent works.
  const [activity, setActivity] = useState<SessionActivityItem[]>([]);
  const [files, setFiles] = useState<SessionFileEntry[]>([]);
  const [memory, setMemory] = useState<SessionMemoryItem[]>([]);
  const [activityKindFilter, setActivityKindFilter] = useState<string>("all");
  const [memoryAdding, setMemoryAdding] = useState(false);
  const [memoryDraftTitle, setMemoryDraftTitle] = useState("");
  const [memoryDraftContent, setMemoryDraftContent] = useState("");

  useEffect(() => {
    setDetail(null); setError(false); setActivity([]); setFiles([]); setMemory([]);
    const load = async () => {
      try {
        const [d, a, f, m] = await Promise.all([
          fetchSessionDetail(sessionId),
          fetchSessionActivity(sessionId, { limit: 80 }).catch(() => [] as SessionActivityItem[]),
          fetchSessionFiles(sessionId).catch(() => [] as SessionFileEntry[]),
          fetchSessionMemory(sessionId).catch(() => [] as SessionMemoryItem[]),
        ]);
        setDetail(d);
        setActivity(a);
        setFiles(f);
        setMemory(m);
      } catch {
        setError(true);
      }
    };
    load();
    const iv = setInterval(load, 5_000);
    return () => clearInterval(iv);
  }, [sessionId]);

  const saveMemory = async () => {
    const title = memoryDraftTitle.trim();
    const content = memoryDraftContent.trim();
    if (!title || !content) return;
    try {
      const item = await createSessionMemory(sessionId, { title, content });
      setMemory(m => [item, ...m]);
      setMemoryDraftTitle("");
      setMemoryDraftContent("");
      setMemoryAdding(false);
    } catch (err) {
      console.error("Save memory failed:", err);
    }
  };

  const removeMemory = async (id: string) => {
    try {
      await deleteSessionMemory(sessionId, id);
      setMemory(m => m.filter(x => x.id !== id));
    } catch (err) {
      console.error("Delete memory failed:", err);
    }
  };

  const editMemory = async (id: string, patch: { title?: string; content?: string; kind?: string }) => {
    const updated = await updateSessionMemory(sessionId, id, patch);
    setMemory(m => m.map(x => x.id === id ? { ...x, ...updated } : x));
  };

  // Search filter for the Memory section. Substring + lowercase across
  // title + content + kind. When the user grows past ~10-20 items the
  // panel becomes search-driven; below that the box is still useful for
  // grepping by file name or decision keyword.
  const [memoryQuery, setMemoryQuery] = useState("");
  const filteredMemory = useMemo(() => {
    const q = memoryQuery.trim().toLowerCase();
    if (!q) return memory;
    return memory.filter(m =>
      m.title.toLowerCase().includes(q)
      || m.content.toLowerCase().includes(q)
      || m.kind.toLowerCase().includes(q)
    );
  }, [memory, memoryQuery]);

  if (error) return (
    <div style={{ padding: "24px 14px", display: "flex", alignItems: "center", gap: 8, color: "#f87171" }}>
      <AlertCircle size={13} />
      <span style={{ fontSize: 12 }}>Failed to load agent detail</span>
    </div>
  );

  if (!detail) return (
    <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <Loader2 size={15} style={{ color: "var(--c-ghost)", animation: "spin 1.5s linear infinite" }} />
    </div>
  );

  const cfg        = STATUS_CFG[session?.status as StatusKey] ?? STATUS_CFG.idle;
  const maxToken   = Math.max(detail.tokens.input, detail.tokens.output, detail.tokens.cache_read + detail.tokens.cache_write, 1);
  const inProgress = detail.todos.filter(t => t.status === "in_progress");
  const pending    = detail.todos.filter(t => t.status !== "completed" && t.status !== "in_progress");
  const done       = detail.todos.filter(t => t.status === "completed");
  const PENDING_LIMIT = 8;
  const visiblePending = showAllPending ? pending : pending.slice(0, PENDING_LIMIT);
  const topTools  = Object.entries(detail.tools).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const maxTool   = topTools[0]?.[1] ?? 1;
  const totalTok  = detail.tokens.input + detail.tokens.output + detail.tokens.cache_read + detail.tokens.cache_write;
  const cacheEff  = totalTok > 0 ? ((detail.tokens.cache_read + detail.tokens.cache_write) / totalTok * 100) : 0;
  const limit     = ctxLimit(detail.model);
  const lastCtx   = detail.tokens.last_input || 0;
  const ctxPct    = limit && lastCtx > 0 ? Math.min(lastCtx / limit, 1) : 0;
  // Context fill: only saturated when actually critical (>80%). Below that
  // it's a quiet theme color so the panel doesn't glow neon at idle.
  const ctxFill   = ctxPct > 0.8 ? "#f87171" : "var(--c-high)";
  const project   = folderName(detail.project_path) || undefined;
  const model     = shortModel(detail.model);
  const totalCalls = Object.values(detail.tools).reduce((a, b) => a + b, 0);

  return (
    <div className="scroll-subtle" style={{ flex: 1, overflowY: "auto", padding: "10px 12px 18px" }}>

      {/* ── Header — minimal: status + title + provider + model + status label ── */}
      <div style={{
        display: "flex", alignItems: "center", gap: 8,
        padding: "6px 0 8px",
        animation: "cc-fade-up 0.2s ease-out",
      }}>
        <StatusRing status={session?.status ?? "idle"} size={11} />
        {session?.tool && <ProviderLogo tool={session.tool} size={13} />}
        <span style={{
          flex: 1, fontSize: 14, fontWeight: 600, color: "var(--c-high)",
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0,
        }}>
          {session?.title ?? "Agent"}
        </span>
        {model && (
          <span style={{
            fontSize: 10, fontWeight: 500, color: "var(--c-low)",
            background: "var(--c-srf)", padding: "2px 7px", borderRadius: 4, flexShrink: 0,
          }}>
            {model}
          </span>
        )}
        {cfg.color && (
          <span style={{
            fontSize: 10, fontWeight: 500, letterSpacing: "0.01em",
            color: "var(--c-ghost)", flexShrink: 0,
          }}>
            {cfg.label.toLowerCase()}
          </span>
        )}
      </div>

      {/* ── Stats line — inline, no card boxes. Same rhythm as the
            agent-row meta line in the Fleet list. ── */}
      <div style={{
        display: "flex", alignItems: "baseline", flexWrap: "wrap",
        gap: "4px 14px",
        padding: "0 0 8px",
        fontSize: 11.5, color: "var(--c-ghost)",
        fontVariantNumeric: "tabular-nums",
        animation: "cc-fade-up 0.2s ease-out 30ms both",
      }}>
        <span>
          <span style={{ color: "var(--c-high)", fontWeight: 600, fontSize: 14 }}>
            {fmtCost(detail.total_cost_usd)}
          </span>
          <span style={{ marginLeft: 4 }}>cost</span>
        </span>
        <span>
          <span style={{ color: "var(--c-high)", fontWeight: 600, fontSize: 14 }}>
            {detail.message_count}
          </span>
          <span style={{ marginLeft: 4 }}>msg{detail.message_count !== 1 ? "s" : ""}</span>
        </span>
        {cacheEff > 0 && (
          <span>
            <span style={{ color: "var(--c-high)", fontWeight: 600, fontSize: 14 }}>
              {cacheEff.toFixed(0)}%
            </span>
            <span style={{ marginLeft: 4 }}>cached</span>
          </span>
        )}
        {totalCalls > 0 && (
          <span>
            <span style={{ color: "var(--c-high)", fontWeight: 600, fontSize: 14 }}>
              {totalCalls}
            </span>
            <span style={{ marginLeft: 4 }}>tool call{totalCalls !== 1 ? "s" : ""}</span>
          </span>
        )}
      </div>

      {/* ── Context window — frameless rail. Color only on critical fill. ── */}
      {limit && (
        <div style={{
          padding: "8px 0 10px",
          animation: "cc-fade-up 0.2s ease-out 60ms both",
        }}>
          <div style={{ display: "flex", alignItems: "center", marginBottom: 5 }}>
            <span style={{
              flex: 1, fontSize: 10.5, fontWeight: 500,
              color: "var(--c-ghost)", letterSpacing: "0.01em",
            }}>
              Context window
            </span>
            <span style={{
              fontSize: 10.5, color: "var(--c-ghost)",
              fontVariantNumeric: "tabular-nums",
            }}>
              {lastCtx > 0
                ? `${fmtCtx(lastCtx)} / ${fmtCtx(limit)} · ${(ctxPct * 100).toFixed(0)}%`
                : `${fmtCtx(limit)} limit`}
            </span>
          </div>
          <div style={{ height: 4, borderRadius: 2, background: "var(--c-srf)", overflow: "hidden" }}>
            <div style={{
              width: `${Math.max(ctxPct * 100, 0)}%`, height: "100%", borderRadius: 2,
              background: ctxPct > 0 ? ctxFill : "transparent", transition: "width 0.5s ease-out",
            }} />
          </div>
          {detail.tokens.last_cache_read > 0 && (
            <div style={{ fontSize: 10.5, color: "var(--c-ghost)", marginTop: 5, fontVariantNumeric: "tabular-nums" }}>
              <span style={{ color: "var(--c-low)", fontWeight: 500 }}>{fmtCtx(detail.tokens.last_cache_read)}</span> tokens from cache last turn
            </div>
          )}
        </div>
      )}

      {/* ── Token economics — single tabular line ── */}
      {totalTok > 0 && (
        <div style={{
          padding: "6px 0 8px",
          fontSize: 11, color: "var(--c-ghost)", lineHeight: 1.7,
          fontVariantNumeric: "tabular-nums",
          animation: "cc-fade-up 0.2s ease-out 90ms both",
        }}>
          <span style={{ color: "var(--c-low)", fontWeight: 500 }}>{fmtTokens(totalTok)}</span> total
          {cacheEff > 0 && <>
            <span style={{ color: "var(--c-brd2)", margin: "0 6px" }}>·</span>
            <span style={{ color: "var(--c-high)", fontWeight: 500 }}>{cacheEff.toFixed(0)}%</span> cached
          </>}
          {detail.total_cost_usd > 0 && <>
            <span style={{ color: "var(--c-brd2)", margin: "0 6px" }}>·</span>
            <span style={{ color: "var(--c-low)", fontWeight: 500 }}>
              ${((detail.total_cost_usd / totalTok) * 1000).toFixed(4)}
            </span>/1k tok
          </>}
          {detail.tokens.cache_read > 0 && <>
            <span style={{ color: "var(--c-brd2)", margin: "0 6px" }}>·</span>
            saved <span style={{ color: "var(--c-low)", fontWeight: 500 }}>{fmtCost(detail.tokens.cache_read * 0.000003)}</span>
          </>}
        </div>
      )}

      {/* ── Meta tags — permission mode, project, age ── */}
      <div style={{
        display: "flex", flexWrap: "wrap", alignItems: "center", gap: "4px 8px",
        padding: "4px 0 12px",
        animation: "cc-fade-up 0.2s ease-out 120ms both",
      }}>
        {detail.permission_mode && detail.permission_mode !== "default" && (
          <span style={{
            fontSize: 10, color: "var(--c-low)",
            background: "var(--c-srf)", padding: "2px 7px", borderRadius: 4,
            fontFamily: "var(--font-mono)",
          }}>
            {detail.permission_mode}
          </span>
        )}
        {project && (
          <span style={{
            fontSize: 10, color: "var(--c-low)",
            background: "var(--c-srf)", padding: "2px 7px", borderRadius: 4,
            fontFamily: "var(--font-mono)",
          }}>
            ~/{project}
          </span>
        )}
        {detail.created_at && (
          <span style={{ fontSize: 10, color: "var(--c-ghost)" }}>
            Created {relativeTime(detail.created_at)}
          </span>
        )}
      </div>

      {/* ── Budget — frameless, GroupLabel rhythm. ── */}
      <div style={{ padding: "0 0 4px", animation: "cc-fade-up 0.2s ease-out 150ms both" }}>
        <BudgetSection session={session} />
      </div>

      {/* ── Tasks ── */}
      <Section
        title="Tasks"
        badge={
          inProgress.length > 0 ? `${inProgress.length} active · ${pending.length} pending`
          : pending.length > 0  ? `${pending.length} open`
          : done.length > 0     ? "all done"
          : undefined
        }
        defaultOpen
      >
        {detail.todos.length === 0 && (
          <div style={{ fontSize: 11.5, color: "var(--c-dim)", padding: "2px 0 6px" }}>No tasks yet</div>
        )}

        {/* In progress */}
        {inProgress.map((t, i) => <TodoItem key={`ip-${i}`} todo={t} delay={i * 30} />)}

        {/* Pending — capped with show more */}
        {pending.length > 0 && inProgress.length > 0 && (
          <div style={{ height: 1, background: "var(--c-brd)", margin: "6px 0 4px", opacity: 0.5 }} />
        )}
        {visiblePending.map((t, i) => <TodoItem key={`p-${i}`} todo={t} delay={i * 25} />)}
        {pending.length > PENDING_LIMIT && (
          <button
            onClick={() => setShowAllPending(v => !v)}
            style={{
              background: "none", border: "none", cursor: "pointer", padding: "3px 0",
              fontSize: 11, color: "var(--c-dim)",
            }}
            onMouseEnter={e => { e.currentTarget.style.color = "var(--c-med)"; }}
            onMouseLeave={e => { e.currentTarget.style.color = "var(--c-dim)"; }}
          >
            {showAllPending ? "Show less" : `+${pending.length - PENDING_LIMIT} more`}
          </button>
        )}

        {/* Done count */}
        {done.length > 0 && (pending.length > 0 || inProgress.length > 0) && (
          <div style={{ fontSize: 10.5, color: "var(--c-ghost)", marginTop: 6 }}>
            {done.length} completed
          </div>
        )}
        {pending.length === 0 && inProgress.length === 0 && done.slice(-5).map((t, i) => (
          <TodoItem key={`d-${i}`} todo={t} delay={i * 25} />
        ))}
      </Section>

      {/* ── Tokens ── Solid theme colors only. The four bars share one
          family — quietly differentiated by weight, not by neon hue. */}
      <Section title="Tokens" defaultOpen>
        <div style={{ paddingTop: 2 }}>
          <TokenBar label="Input"       value={detail.tokens.input}       max={maxToken} color="var(--c-low)"   delay={0}  />
          <TokenBar label="Output"      value={detail.tokens.output}      max={maxToken} color="var(--c-high)"  delay={40} />
          <TokenBar label="Cache read"  value={detail.tokens.cache_read}  max={maxToken} color="var(--c-med)"   delay={80} />
          <TokenBar label="Cache write" value={detail.tokens.cache_write} max={maxToken} color="var(--c-brd2)"  delay={120} />
        </div>
      </Section>

      {/* ── Tools ── */}
      {topTools.length > 0 && (
        <Section
          title="Tools"
          defaultOpen={false}
          badge={`${totalCalls} calls`}
        >
          {topTools.map(([name, count], i) => (
            <ToolRow key={name} name={name} count={count} maxCount={maxTool} delay={i * 30} />
          ))}
        </Section>
      )}

      {/* ── Activity ── Auto-captured ledger of every tool the agent ran.
          Filter chips narrow by kind. Each row = one tool_end event with
          its summary (file path / command / URL) and timestamp. */}
      <Section title="Activity" defaultOpen badge={activity.length > 0 ? `${activity.length}` : undefined}>
        <ActivityFilter active={activityKindFilter} onChange={setActivityKindFilter} activity={activity} />
        <ActivityFeed activity={activity} kindFilter={activityKindFilter} />
      </Section>

      {/* ── Files ── Unique files the agent read or wrote, with edit/read
          counts and last-touched. Replaces a fake "Tools" count-only view
          with what the user actually wants to see — concrete output. */}
      {files.length > 0 && (
        <Section title="Files touched" defaultOpen={false} badge={`${files.length}`}>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {files.slice(0, 20).map((f, i) => (
              <FileRow key={f.path} file={f} delay={i * 20} />
            ))}
          </div>
        </Section>
      )}

      {/* ── Memory ── Curated knowledge items. Cross-session per-project
          recall: items saved on prior sessions for the same project show
          here too, faded slightly to mark provenance. The "+ Add" button
          opens an inline composer; agents can also write here via the
          remember() MCP tool. */}
      <Section title="Memory" defaultOpen badge={memory.length > 0 ? `${memory.length}` : undefined}>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {/* Search box — only render when we have enough items to make
              filtering useful (≥ 4). Below that, scrolling is faster. */}
          {memory.length >= 4 && (
            <input
              type="search"
              placeholder="Search memory…"
              value={memoryQuery}
              onChange={e => setMemoryQuery(e.target.value)}
              style={{
                background: "var(--c-srf)", border: "1px solid var(--c-brd)",
                borderRadius: 6, padding: "5px 9px",
                color: "var(--c-high)", fontSize: 11.5,
                fontFamily: "inherit", outline: "none",
                transition: "border-color 0.12s",
              }}
              onFocus={e => { e.currentTarget.style.borderColor = "var(--c-brd2)"; }}
              onBlur={e => { e.currentTarget.style.borderColor = "var(--c-brd)"; }}
            />
          )}
          {!memoryAdding && (
            <button
              onClick={() => setMemoryAdding(true)}
              style={{
                alignSelf: "flex-start",
                background: "transparent", border: "1px dashed var(--c-brd2)",
                borderRadius: 6, padding: "5px 10px",
                fontSize: 11, color: "var(--c-low)", cursor: "pointer",
                transition: "color 0.12s, border-color 0.12s",
              }}
              onMouseEnter={e => { e.currentTarget.style.color = "var(--c-high)"; e.currentTarget.style.borderColor = "var(--c-low)"; }}
              onMouseLeave={e => { e.currentTarget.style.color = "var(--c-low)"; e.currentTarget.style.borderColor = "var(--c-brd2)"; }}
            >
              + Add memory item
            </button>
          )}
          {memoryAdding && (
            <div style={{
              border: "1px solid var(--c-brd)", borderRadius: 8,
              background: "var(--c-srf)", padding: 8, display: "flex",
              flexDirection: "column", gap: 6,
            }}>
              <input
                autoFocus
                placeholder="Title"
                value={memoryDraftTitle}
                onChange={e => setMemoryDraftTitle(e.target.value)}
                style={{
                  background: "transparent", border: "none", outline: "none",
                  color: "var(--c-high)", fontSize: 12, fontWeight: 500,
                  fontFamily: "inherit",
                }}
              />
              <textarea
                placeholder="What's worth remembering?"
                value={memoryDraftContent}
                onChange={e => setMemoryDraftContent(e.target.value)}
                onKeyDown={e => {
                  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); saveMemory(); }
                  if (e.key === "Escape") { setMemoryAdding(false); setMemoryDraftTitle(""); setMemoryDraftContent(""); }
                }}
                rows={3}
                style={{
                  background: "transparent", border: "none", outline: "none",
                  color: "var(--c-med)", fontSize: 11.5,
                  fontFamily: "inherit", resize: "vertical", minHeight: 40,
                }}
              />
              <div style={{ display: "flex", gap: 5, alignItems: "center" }}>
                <span style={{ flex: 1, fontSize: 10, color: "var(--c-ghost)" }}>⌘↵ to save · Esc to cancel</span>
                <button
                  onClick={() => { setMemoryAdding(false); setMemoryDraftTitle(""); setMemoryDraftContent(""); }}
                  style={{
                    background: "transparent", border: "none",
                    color: "var(--c-ghost)", fontSize: 10.5, cursor: "pointer",
                    padding: "4px 8px", borderRadius: 5,
                  }}
                >
                  Cancel
                </button>
                <button
                  onClick={saveMemory}
                  disabled={!memoryDraftTitle.trim() || !memoryDraftContent.trim()}
                  style={{
                    border: "1px solid var(--c-high)",
                    background: memoryDraftTitle.trim() && memoryDraftContent.trim()
                      ? "var(--c-high)" : "var(--c-srf2)",
                    color: memoryDraftTitle.trim() && memoryDraftContent.trim()
                      ? "var(--card)" : "var(--c-ghost)",
                    fontSize: 10.5, fontWeight: 600, padding: "4px 11px",
                    borderRadius: 5, cursor: "pointer",
                  }}
                >
                  Save
                </button>
              </div>
            </div>
          )}
          {memory.length === 0 && !memoryAdding && (
            <div style={{ fontSize: 11.5, color: "var(--c-dim)", padding: "2px 0 6px" }}>
              No memory items yet
            </div>
          )}
          {memory.length > 0 && filteredMemory.length === 0 && memoryQuery.trim() && (
            <div style={{ fontSize: 11, color: "var(--c-dim)", padding: "4px 0" }}>
              No matches for &ldquo;{memoryQuery}&rdquo;
            </div>
          )}
          {filteredMemory.filter(m => m.kind !== "plan").map((item, i) => (
            <MemoryItem
              key={item.id} item={item} delay={i * 20}
              onDelete={() => removeMemory(item.id)}
              onEdit={(patch) => editMemory(item.id, patch)}
            />
          ))}
        </div>
      </Section>

      {/* ── Plans ── Subset of memory with kind=plan. No more global
          ~/.claude/plans/*.md leak — plans are now per-session+project. */}
      {memory.some(m => m.kind === "plan") && (
        <Section title="Plans" defaultOpen={false} badge={`${memory.filter(m => m.kind === "plan").length}`}>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {filteredMemory.filter(m => m.kind === "plan").map((item, i) => (
              <MemoryItem
                key={item.id} item={item} delay={i * 20} compact
                onDelete={() => removeMemory(item.id)}
                onEdit={(patch) => editMemory(item.id, patch)}
              />
            ))}
          </div>
        </Section>
      )}

      <div style={{ height: 24 }} />
    </div>
  );
}

/* MODEL_PALETTE / DispatchFeed / FleetSummary / StatsDrawer / FleetLegend
 * all deleted in the single-column rewrite. The sidebar no longer carries
 * a separate Stats zone, a separate Live Pulse zone, or a duplicated
 * Activity feed — the agent rows themselves carry their latest event
 * inline. Stats live one click deep in each agent's drill-in detail view. */


/* ═══════════════════════════════════════
   MAIN PANEL
═══════════════════════════════════════ */
export function ControlCenterPanel({ sessions: allSessions, onClose }: Props) {
  const { staffSessionId } = useAppStore();
  void onClose;
  // ── Memoized derived collections ──
  // Without useMemo every render produced fresh arrays, which cascaded
  // into recompute storms in groups/effectiveSessions/activeSessions
  // every 5s SSE status refresh + every 8s stats poll, and again on
  // every notification push. With many agents + long-running fleets
  // the panel paints noticeably. The deps are the minimal set that
  // actually changes the filter result.
  const sessions = useMemo(
    () => allSessions.filter(s => s.id !== staffSessionId),
    [allSessions, staffSessionId],
  );
  const [selectedId, setSelectedId]   = useState<string | null>(null);
  const [statsMap, setStatsMap]       = useState<Record<string, Stats>>({});

  useEffect(() => {
    const load = () => {
      // Skip the poll when the window/tab isn't visible. Stats don't
      // need to refresh while the user is in another app — the next
      // visibility transition will refetch immediately. Saves a round
      // trip every 8s × however many tabs of Fleet are minimised,
      // and also stops the cascade of store updates that re-renders
      // the panel + every FleetRow when nobody is watching.
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      fetchBulkStats().then(s => setStatsMap(s as Record<string, Stats>)).catch(() => {});
    };
    load();
    const iv = setInterval(load, 8_000);
    // Refresh on tab-back so the user sees fresh data the moment they
    // refocus, instead of waiting up to 8s for the next tick.
    const onVis = () => { if (document.visibilityState === "visible") load(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { clearInterval(iv); document.removeEventListener("visibilitychange", onVis); };
  }, []);

  // Budget warning: fire a notification when any session crosses 80% of its limit
  const pushNotification = useAppStore((s) => s.pushNotification);
  const warnedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const s of sessions) {
      const limit = s.budget_limit;
      const used  = s.budget_used ?? 0;
      if (limit == null || limit <= 0) continue;
      const ratio = used / limit;
      if (ratio >= 0.8 && ratio < 1.0 && !warnedRef.current.has(s.id)) {
        warnedRef.current.add(s.id);
        pushNotification({
          id: crypto.randomUUID(),
          sessionId: s.id,
          title: "Budget warning",
          summary: `${s.title} has used ${(ratio * 100).toFixed(0)}% of its budget ($${used.toFixed(2)} / $${limit.toFixed(2)})`,
          success: false,
          timestamp: Date.now(),
        });
      }
      // Reset warning token if usage drops below 80% (e.g., limit was raised)
      if (ratio < 0.8) {
        warnedRef.current.delete(s.id);
      }
    }
  }, [sessions, pushNotification]);

  // ── Narrow selector ──
  // Project per-session permissionRequest values DIRECTLY (not wrapped
  // in `{permissionRequest}` objects) so useShallow's Object.is per-
  // value comparison holds across renders. The earlier wrapper-object
  // version created fresh inner objects every call → useShallow always
  // returned a new reference → infinite re-render → black screen on
  // boot. Recompose into the shape the rest of the panel expects via
  // a useMemo whose identity only changes when at least one
  // permission request appears/resolves.
  const permRequestMap = useChatStore(useShallow((s) => {
    const out: Record<string, typeof s.sessions[string]["permissionRequest"]> = {};
    for (const id in s.sessions) out[id] = s.sessions[id]!.permissionRequest;
    return out;
  }));
  const chatSessions = useMemo(() => {
    const out: Record<string, { permissionRequest: typeof permRequestMap[string] }> = {};
    for (const id in permRequestMap) {
      out[id] = { permissionRequest: permRequestMap[id]! };
    }
    return out;
  }, [permRequestMap]);
  const waitingIds = useMemo(
    () => new Set(Object.entries(chatSessions).filter(([, cs]) => cs.permissionRequest != null).map(([id]) => id)),
    [chatSessions],
  );
  // Decorate sessions with the waiting-permission state. Memoized so a
  // new array identity is only produced when sessions OR waitingIds
  // genuinely changed — every consumer downstream (groups, FleetRow,
  // status-icon useEffects) re-renders only on real changes.
  const effectiveSessions = useMemo(
    () => sessions.map(s => waitingIds.has(s.id) ? { ...s, status: "waiting" as const } : s),
    [sessions, waitingIds],
  );
  const selectedSession = useMemo(
    () => effectiveSessions.find(s => s.id === selectedId),
    [effectiveSessions, selectedId],
  );
  const activeSessions = useMemo(
    () => effectiveSessions.filter(s =>
      s.status === "running" || s.status === "waiting" || s.status === "starting",
    ),
    [effectiveSessions],
  );

  return (
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", background: "var(--sidebar)" }}>
      <CcStyles />

      {/* ── Detail view ── */}
      {selectedId ? (
        <>
          <div style={{
            height: 44, flexShrink: 0, borderBottom: "1px solid var(--c-brd)",
            display: "flex", alignItems: "center", gap: 8, padding: "0 12px",
          }}>
            <button
              onClick={() => setSelectedId(null)}
              style={{
                display: "flex", alignItems: "center", gap: 5,
                background: "none", border: "none", cursor: "pointer",
                padding: "5px 8px", borderRadius: 6, color: "var(--c-low)",
                transition: "background 0.12s, color 0.12s",
              }}
              onMouseEnter={e => { e.currentTarget.style.background = "var(--c-srf)"; e.currentTarget.style.color = "var(--c-med)"; }}
              onMouseLeave={e => { e.currentTarget.style.background = "none"; e.currentTarget.style.color = "var(--c-low)"; }}
            >
              <ArrowLeft size={13} />
              <span style={{ fontSize: 12, fontWeight: 500 }}>Fleet</span>
            </button>
            <div style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 6 }}>
              <StatusRing status={selectedSession?.status ?? "idle"} size={9} />
              <span style={{ fontSize: 12.5, fontWeight: 500, color: "var(--c-high)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {selectedSession?.title}
              </span>
            </div>
          </div>
          <SessionDetailView sessionId={selectedId} session={selectedSession} />
        </>

      ) : (
        /* ── Pulse overview ── */
        <PulseOverview
          sessions={effectiveSessions}
          statsMap={statsMap}
          chatSessions={chatSessions}
          activeSessions={activeSessions}
          staffSessionId={staffSessionId}
          onSelect={setSelectedId}
        />
      )}
    </div>
  );
}

/* ─── Pulse overview — three-tier ops dashboard ─────────────────── */

// Narrowed shape — PulseOverview only reads `permissionRequest` per
// session. Keeping the type tight matches the new top-level selector
// (which projects only that field) and prevents callers from
// accidentally over-subscribing again.
type ChatSessionsDigest = Record<string, {
  permissionRequest: ReturnType<typeof useChatStore.getState>["sessions"][string]["permissionRequest"];
}>;

interface PulseOverviewProps {
  sessions: Session[];
  statsMap: Record<string, Stats>;
  chatSessions: ChatSessionsDigest;
  activeSessions: Session[];
  staffSessionId: string | null;
  onSelect: (id: string) => void;
}

function PulseOverview({
  sessions, statsMap, chatSessions,
  activeSessions,
  staffSessionId,
  onSelect,
}: PulseOverviewProps) {
  // staffSessionId reserved for cross-agent peeks (e.g. surfacing the latest
  // dispatch_result targeting a row). Read once so TS sees it consumed even
  // when the consumer code isn't yet branching on it.
  void staffSessionId;
  // ── Permission auto-surface ───────────────────────────────────
  // Sessions with a pending request rise to the top of the agent list,
  // and every other row dims so attention lands on what's blocking.
  const waitingIds = useMemo(() => {
    const ids = new Set<string>();
    for (const s of sessions) {
      if (chatSessions[s.id]?.permissionRequest) ids.add(s.id);
    }
    return ids;
  }, [sessions, chatSessions]);
  const anyWaiting = waitingIds.size > 0;

  // ── Group agents by project (mirrors the left sidebar's grouping)
  // ──────────────────────────────────────────────────────────────
  // Each group: { name, sessions[] }. Pending-permission sessions get
  // their own "Awaiting" group at the top so they're impossible to miss.
  const groups = useMemo(() => {
    const out: Array<{ id: string; label: string; sessions: Session[] }> = [];

    if (anyWaiting) {
      out.push({
        id: "__waiting__",
        label: "Awaiting approval",
        sessions: sessions.filter(s => waitingIds.has(s.id)),
      });
    }

    // Group by group_path or fall back to last segment of project_path.
    // We collapse 1-agent groups into a single "All agents" bucket so the
    // panel doesn't show 4 group labels for 4 unrelated agents — the
    // group label "Proton (1)" above a single proton_login row is pure
    // visual overhead.
    const byProject = new Map<string, Session[]>();
    for (const s of sessions) {
      if (waitingIds.has(s.id)) continue;
      const key =
        s.group_path?.trim() ||
        folderName(s.project_path) ||
        "Ungrouped";
      const arr = byProject.get(key) ?? [];
      arr.push(s);
      byProject.set(key, arr);
    }

    // Split into multi-agent groups (worth a label) and singletons
    // (collapsed into one "Agents" bucket sorted by recency).
    const singletons: Session[] = [];
    for (const [name, arr] of byProject) {
      if (arr.length >= 2) {
        out.push({ id: `proj:${name}`, label: name, sessions: arr });
      } else {
        singletons.push(...arr);
      }
    }
    if (singletons.length > 0) {
      // Sort singletons by recent activity so the most-recently-touched
      // agent is on top — usually what the user wants to glance at.
      singletons.sort((a, b) => {
        const ta = new Date(a.last_accessed ?? a.created_at ?? 0).getTime();
        const tb = new Date(b.last_accessed ?? b.created_at ?? 0).getTime();
        return tb - ta;
      });
      // When there are NO multi-agent groups (the typical case), show no
      // label at all — the agent list is the whole panel and a header is
      // redundant. Otherwise label it "Agents" so the multi-agent groups
      // above stand apart visually.
      const hasMultiGroup = out.some(g => g.id !== "__waiting__");
      out.push({
        id: "__singletons__",
        label: hasMultiGroup ? "Agents" : "",
        sessions: singletons,
      });
    }
    return out;
  }, [sessions, waitingIds, anyWaiting]);

  // ── Render ────────────────────────────────────────────────────
  // SINGLE-COLUMN STREAM. The previous design split the sidebar into 3+
  // zones (Mission, Agents, Stats drawer, Live Pulse) and the user's
  // attention had to jump between them — same agent name appearing 6×
  // across zones, a flex:1 spacer that left a 500px empty band whenever
  // content was short. The new design is one continuous list:
  //
  //   1. Mission strip (sticky-top)
  //   2. Permission queue
  //   3. Agent rows — each row carries its own latest-event peek inline,
  //      so there's no need for a separate Live Pulse zone underneath.
  //
  // Stats (token bars, model split, tool histograms) live one click deep
  // in each agent's drill-in detail view — they don't need permanent
  // sidebar real estate.
  return (
    <div style={{
      display: "flex", flexDirection: "column",
      height: "100%", overflow: "hidden",
    }}>
      <MissionStatus sessions={sessions} stats={statsMap} />

      <PendingPermissionsQueue
        sessions={sessions}
        chatSessions={chatSessions}
        onJump={onSelect}
      />

      <div className="scroll-subtle" style={{
        flex: 1, minHeight: 0,
        overflowY: "auto",
        padding: "2px 0 0",
      }}>
        {sessions.length === 0 ? (
          <PulseEmpty />
        ) : (
          <>
            <div style={{ padding: "0 10px 8px", display: "flex", flexDirection: "column" }}>
              {groups.map(g => (
                <div key={g.id} style={{ marginBottom: 4 }}>
                  {g.label && (
                    <GroupLabel count={g.sessions.length}>
                      {g.id === "__waiting__"
                        ? g.label
                        : g.label.charAt(0).toUpperCase() + g.label.slice(1)}
                    </GroupLabel>
                  )}
                  <div style={{ display: "flex", flexDirection: "column" }}>
                    {g.sessions.map((s, i) => {
                      const isActiveLike =
                        activeSessions.includes(s) ||
                        waitingIds.has(s.id);
                      const dim = anyWaiting && !waitingIds.has(s.id);
                      return isActiveLike ? (
                        <ActiveAgentCard
                          key={s.id}
                          session={s}
                          stats={statsMap[s.id]}
                          onClick={() => onSelect(s.id)}
                          delay={i * 18}
                          dimmed={dim}
                        />
                      ) : (
                        <IdleAgentRow
                          key={s.id}
                          session={s}
                          stats={statsMap[s.id]}
                          onClick={() => onSelect(s.id)}
                          delay={i * 18}
                          dimmed={dim}
                        />
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>

            {/* RecentFeed and TodayStrip both removed.
                The earlier flat activity feed read as a *log viewer* — a
                stream of equally-weighted "Responded · $0.02" rows that
                didn't tell the user what their money bought. The fix is
                NOT a richer log: it's collapsing each agent's events
                into the agent's own card (RichAgentCard above), so the
                sidebar reads as one narrative paragraph per agent rather
                than a chronological tape. */}
          </>
        )}
      </div>
    </div>
  );
}

function PulseEmpty() {
  // Single-line empty state — the center surface and sidebar already
  // explain the "create your first agent" flow; the right panel just
  // needs to confirm "nothing here yet" without repeating instructions.
  return (
    <div style={{
      flex: 1, display: "flex", alignItems: "center", justifyContent: "center",
      padding: "32px 20px",
      fontSize: 11.5, color: "var(--c-ghost)",
    }}>
      Idle
    </div>
  );
}

