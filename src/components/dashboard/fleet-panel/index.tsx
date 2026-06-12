/**
 * FleetPanel — the right-side Fleet hub.
 *
 * Designed as a COMMAND CENTER, not a data list. The user should
 * never feel like "I'm just looking at JSON" — every zone has a
 * job: status at-a-glance, what to do next, who needs attention.
 *
 * Layout:
 *   ┌─ Title bar ────────────────────────────────────┐
 *   │ Fleet                                       ✕   │
 *   ├─ Big watching strip ───────────────────────────┤
 *   │   6     0       0       $3.70    609k          │
 *   │  AGTS  ACTIVE  PENDING  SPENT   TOKENS         │
 *   │  [ Catch me up ]  [ Stop all ]  [ Archive idle ]│
 *   ├─ Insights ─────────────────────────────────────┤
 *   │ ⚠ 3 sessions idle > 24h                       →│
 *   │ 💡 makeup_check + agent_media share repo        │
 *   ├─ Ask Fleet ────────────────────────────────────┤
 *   │ 🧠 Ask Fleet                                  ▾│
 *   ├─ Sessions ─────────────────────────────────────┤
 *   │ ◐ ct                            IDLE  $0.19  2d│
 *   │   ct · GPT-5                                    │
 *   │   Fleet · Explored shell, no edits yet          │  ← Fleet's verdict
 *   │   12 EDITS · 4 FILES · 8 CMD            [▁▂▅█] │
 *   ├────────────────────────────────────────────────┤
 *   │  ...                                             │
 *   └─ Activity (last 10, parsed) ───────────────────┘
 *
 * Color palette — solid hex matching the rest of the app:
 *   #4ade80 / #fb923c / #f87171 / #fbbf24 / #60a5fa
 *
 * Surface rules:
 *   panel outer    → var(--sidebar)
 *   hover bg       → var(--c-srf)
 *   inset chip bg  → var(--c-srf) (only when needed for separation)
 *   waiting glow   → rgba(251,146,60,0.06) tint + 2px strip
 */
import {
  X, ArrowRight, FileText, Check, ChevronRight, ChevronLeft,
  ChevronDown, ChevronUp, Loader2,
  Brain, Send, AlertCircle, Sparkles, Archive,
  StopCircle, Pencil, Terminal, Eye, Globe, HelpCircle,
} from "lucide-react";
import { memo, useMemo, useState, useCallback } from "react";
import { useAppStore } from "@/stores/app-store";
import { useChatStore } from "@/stores/chat-store";
import { useFleetStore, type FleetReport, type FleetDecision } from "@/stores/fleet-store";
import { useFleetData, type FleetActivityRow } from "./hooks/use-fleet-data";
import { askFleet, stopSession, archiveSession, type SessionDetail, type SessionActivityItem } from "@/lib/api";
import { ProviderLogo } from "@/components/ui/provider-logo";
import type { Session } from "@/types/session";
import { folderName } from "@/lib/utils";

interface Props {
  sessions: Session[];
  onSelectAgent: (id: string) => void;
}

const MONO = "'SF Mono','Menlo','Consolas',monospace";
const C_GREEN  = "#4ade80";
const C_ORANGE = "#fb923c";
const C_RED    = "#f87171";
const C_BLUE   = "#60a5fa";

/* ── Primitives ────────────────────────────────────────────────── */

const SPINNER_DURATION_MS = 1400;
function useSpinnerSyncDelay(): string {
  const [delay] = useState(() => {
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    return `-${Math.round(now % SPINNER_DURATION_MS)}ms`;
  });
  return delay;
}

function StatusRing({ status, size = 12 }: { status: string; size?: number }) {
  const ring = Math.max(8, Math.round(size * 0.66));
  const stroke = 1;
  const inset = ring / 2 - stroke;
  const animationDelay = useSpinnerSyncDelay();

  if (status === "running" || status === "starting") {
    const accent = status === "running" ? "var(--c-high)" : "var(--c-low)";
    return (
      <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: size, height: size, flexShrink: 0 }}>
        <span aria-hidden style={{
          display: "block", width: ring, height: ring, borderRadius: "50%",
          backgroundImage: `conic-gradient(from 0deg, transparent 0deg 90deg, ${accent} 360deg)`,
          WebkitMask: `radial-gradient(circle at center, transparent ${inset}px, #000 ${inset + 0.5}px)`,
          mask: `radial-gradient(circle at center, transparent ${inset}px, #000 ${inset + 0.5}px)`,
          animation: `ring-spin ${SPINNER_DURATION_MS}ms linear infinite`,
          animationDelay, transformOrigin: "center",
        }} />
      </span>
    );
  }
  if (status === "waiting") {
    return (
      <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 2, width: size, height: size, flexShrink: 0 }}>
        <style>{`@keyframes fp-pause { 0%,100%{opacity:0.4;transform:scaleY(0.7)} 50%{opacity:1;transform:scaleY(1)} }`}</style>
        {[0, 1].map(i => (
          <span key={i} style={{
            width: 2, height: Math.round(size * 0.55), borderRadius: 1.5,
            display: "inline-block", flexShrink: 0, background: C_ORANGE,
            animation: `fp-pause 1.8s ease-in-out ${i * 0.25}s infinite`,
            transformOrigin: "center",
          }} />
        ))}
      </span>
    );
  }
  if (status === "error" || status === "paused") {
    return (
      <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: size, height: size, flexShrink: 0 }}>
        <span aria-hidden style={{
          display: "block", width: ring, height: ring, borderRadius: "50%",
          border: `${stroke}px solid ${C_RED}`,
          background: status === "paused" ? "transparent" : `${C_RED}22`,
        }} />
      </span>
    );
  }
  return (
    <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: size, height: size, flexShrink: 0 }}>
      <span aria-hidden style={{
        display: "block", width: ring, height: ring, borderRadius: "50%",
        border: `${stroke}px solid var(--c-brd2)`,
      }} />
    </span>
  );
}

function StatPair({ value, label, accent }: { value: number | string; label: string; accent?: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 2, minWidth: 0 }}>
      <span style={{
        fontSize: 22, fontWeight: 800,
        color: accent ?? "var(--c-high)",
        fontVariantNumeric: "tabular-nums",
        letterSpacing: "-0.025em",
        lineHeight: 1,
      }}>{value}</span>
      <span style={{
        fontSize: 9, fontWeight: 600,
        color: "var(--c-ghost)",
        textTransform: "uppercase",
        letterSpacing: "0.08em",
      }}>{label}</span>
    </div>
  );
}

function ActionBtn({ children, icon: Icon, onClick, tone = "default" }: {
  children: React.ReactNode;
  icon: React.ComponentType<{ size?: number; strokeWidth?: number }>;
  onClick: () => void;
  tone?: "default" | "danger";
}) {
  const [hov, setHov] = useState(false);
  const baseColor = tone === "danger" ? C_RED : "var(--c-med)";
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        display: "inline-flex", alignItems: "center", gap: 5,
        padding: "4px 9px",
        fontSize: 11, fontWeight: 600,
        color: hov ? (tone === "danger" ? C_RED : "var(--c-high)") : baseColor,
        background: hov ? "var(--c-srf)" : "transparent",
        border: `1px solid ${hov ? "var(--c-brd2)" : "var(--c-brd)"}`,
        borderRadius: 5,
        cursor: "pointer", fontFamily: "inherit",
        transition: "all 0.1s",
      }}
    >
      <Icon size={10} strokeWidth={2.2} />
      {children}
    </button>
  );
}

/* ── Helpers ───────────────────────────────────────────────────── */

function relativeAgo(iso: string | number | null | undefined): string {
  if (!iso) return "";
  const t = typeof iso === "number" ? iso : Date.parse(iso);
  if (!isFinite(t)) return "";
  const d = Date.now() - t;
  if (d < 1_000) return "now";
  const s = Math.floor(d / 1_000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(d / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(d / 3_600_000);
  if (h < 24) return `${h}h`;
  const day = Math.floor(d / 86_400_000);
  return `${day}d`;
}

function fmtCost(c: number | null | undefined): string {
  const n = c ?? 0;
  if (n === 0) return "$0";
  if (n < 0.01) return "<$0.01";
  return `$${n.toFixed(2)}`;
}

function fmtTokens(n: number | null | undefined): string {
  const v = n ?? 0;
  if (v === 0) return "0";
  if (v < 1000) return String(v);
  if (v < 1_000_000) return `${(v / 1000).toFixed(v < 10_000 ? 1 : 0)}k`;
  return `${(v / 1_000_000).toFixed(1)}M`;
}

function shortModel(m: string | null | undefined): string | null {
  if (!m) return null;
  if (m.includes("opus"))   return "Opus";
  if (m.includes("sonnet")) return "Sonnet";
  if (m.includes("haiku"))  return "Haiku";
  if (m.includes("gpt-5"))  return "GPT-5";
  if (m.includes("gpt-4"))  return "GPT-4";
  if (m.includes("gemini")) return "Gemini";
  return m.length > 16 ? m.slice(0, 16) : m;
}

function shortPath(p: string | null | undefined): string {
  if (!p) return "";
  const parts = p.split("/").filter(Boolean);
  return parts.slice(-2).join("/");
}

/** Synthesize a one-line Fleet "verdict" caption from the session's
 *  activity ledger. This is the SMART part — instead of dumping the
 *  agent's last text quote, Fleet tells the user what THIS session
 *  is fundamentally doing. The user reads one line and knows. */
/** Strip the noisy shell wrapper from activity summaries to reach
 *  the actual command. Backend stores rows like:
 *    /bin/zsh -lc 'rg -n "import jwt" *.py'
 *  We pull the first 2-3 useful tokens out so the activity feed
 *  reads as "rg -n …" instead of the whole pipeline. */
function humanActivity(row: SessionActivityItem): string {
  const tool = row.payload?.tool ?? "";
  const summary = row.summary ?? "";
  if (row.kind === "file_edit" || row.kind === "file_read") {
    // Strip leading path prefix.
    const m = /([A-Za-z0-9_\-./]+\.\w+)/.exec(summary);
    return m ? shortPath(m[1]!) : summary.slice(0, 80);
  }
  if (row.kind === "command" || tool === "Bash") {
    // /bin/zsh -lc '...'  → strip wrapper
    let cmd = summary;
    const wrapped = cmd.match(/^\/bin\/(?:z|ba)sh\s+-l?c\s+(['"])(.+)\1\s*$/);
    if (wrapped) cmd = wrapped[2]!;
    // Take first 60 chars.
    return cmd.slice(0, 60);
  }
  return summary.slice(0, 80);
}

/* ── Watching strip ────────────────────────────────────────────── */

function WatchingStrip({ agentCount, activeCount, pendingCount, spend, totalTokens, fleetSpend, onCatchUp, onStopAll, onArchiveIdle, canStopAll, canArchiveIdle, showCatchUp }: {
  agentCount: number; activeCount: number; pendingCount: number;
  spend: number; totalTokens: number; fleetSpend: number;
  onCatchUp: () => void; onStopAll: () => void; onArchiveIdle: () => void;
  canStopAll: boolean; canArchiveIdle: boolean;
  /** Hides "Catch me up" when Fleet co-pilot is in manual mode — the
   *  button routes to Ask Fleet, which is also hidden in manual. */
  showCatchUp: boolean;
}) {
  return (
    <div style={{
      padding: "14px 14px 13px",
      borderBottom: "1px solid var(--c-brd)",
      display: "flex", flexDirection: "column", gap: 12,
    }}>
      {/* Big stat row */}
      <div style={{
        display: "flex", alignItems: "flex-start", gap: 18,
        flexWrap: "wrap",
      }}>
        <StatPair value={agentCount} label="Agents" />
        <StatPair value={activeCount} label="Active" accent={activeCount > 0 ? C_GREEN : undefined} />
        <StatPair value={pendingCount} label="Pending" accent={pendingCount > 0 ? C_ORANGE : undefined} />
        <StatPair value={fmtCost(spend)} label="Spent" />
        <StatPair value={fmtTokens(totalTokens)} label="Tokens" />
      </div>

      {/* Fleet brain spend chip */}
      {fleetSpend > 0 && (
        <div style={{
          display: "inline-flex", alignItems: "center", gap: 4,
          fontSize: 10, color: "var(--c-low)",
          fontFamily: MONO, fontVariantNumeric: "tabular-nums",
        }}>
          <Brain size={9} strokeWidth={2.2} style={{ color: C_BLUE }} />
          Fleet brain: {fmtCost(fleetSpend)}
        </div>
      )}

      {/* Action bar */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
        {showCatchUp && <ActionBtn icon={Sparkles} onClick={onCatchUp}>Catch me up</ActionBtn>}
        {canStopAll && <ActionBtn icon={StopCircle} onClick={onStopAll} tone="danger">Stop all</ActionBtn>}
        {canArchiveIdle && <ActionBtn icon={Archive} onClick={onArchiveIdle}>Archive idle</ActionBtn>}
      </div>
    </div>
  );
}

/* ── Observations / insights ───────────────────────────────────── */

interface Insight {
  id: string;
  tone: "warning" | "info";
  icon: React.ComponentType<{ size?: number; strokeWidth?: number; style?: React.CSSProperties }>;
  text: string;
  /** Click action — usually jump to a specific session OR fire a
   *  bulk operation. */
  onClick?: () => void;
  cta?: string;
}

function InsightsList({ insights }: { insights: Insight[] }) {
  if (insights.length === 0) return null;
  return (
    <div style={{
      padding: "10px 14px 12px",
      borderBottom: "1px solid var(--c-brd)",
      display: "flex", flexDirection: "column", gap: 7,
    }}>
      <span style={{
        fontSize: 10, fontWeight: 700, color: "var(--c-ghost)",
        letterSpacing: "0.08em", textTransform: "uppercase",
      }}>Observations</span>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {insights.map(ins => (
          <button
            key={ins.id}
            onClick={ins.onClick}
            disabled={!ins.onClick}
            style={{
              display: "flex", alignItems: "center", gap: 8,
              padding: "6px 8px", borderRadius: 5,
              background: "transparent",
              border: "1px solid var(--c-brd)",
              borderLeft: `2px solid ${ins.tone === "warning" ? C_ORANGE : C_BLUE}`,
              cursor: ins.onClick ? "pointer" : "default",
              fontFamily: "inherit", textAlign: "left",
              transition: "background 0.1s",
            }}
            onMouseEnter={e => { if (ins.onClick) (e.currentTarget as HTMLElement).style.background = "var(--c-srf)"; }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
          >
            <ins.icon size={11} strokeWidth={2.2} style={{ color: ins.tone === "warning" ? C_ORANGE : C_BLUE, flexShrink: 0 }} />
            <span style={{
              flex: 1, minWidth: 0,
              fontSize: 11.5, color: "var(--c-med)", lineHeight: 1.35,
              overflow: "hidden", textOverflow: "ellipsis",
              display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical",
            }}>{ins.text}</span>
            {ins.cta && (
              <span style={{
                flexShrink: 0,
                fontSize: 10.5, fontWeight: 600,
                color: "var(--c-low)",
                display: "inline-flex", alignItems: "center", gap: 3,
              }}>
                {ins.cta}
                <ArrowRight size={9} strokeWidth={2.4} />
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

/* ── Session row ───────────────────────────────────────────────── */

const SessionRow = memo(function SessionRow({
  session, detail, onOpen,
}: {
  session: Session;
  detail: SessionDetail | undefined;
  onOpen: (id: string) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const cs = useChatStore(s => s.sessions[session.id]);
  const staffSessionId = useAppStore(s => s.staffSessionId);
  const isStaff = staffSessionId !== null && session.id === staffSessionId;
  const isRunning = session.status === "running" || session.status === "starting";
  const isWaiting = session.status === "waiting" || !!cs?.permissionRequest;
  const isError = session.status === "error";
  const cost = detail?.total_cost_usd ?? session.budget_used ?? 0;
  const costLabel = cost > 0 ? fmtCost(cost) : "$0";
  const modelShort = shortModel(detail?.model ?? session.model_name);
  const project = session.project_path ? folderName(session.project_path) : null;
  const msgCount = detail?.message_count ?? cs?.messages?.length ?? 0;
  const ago = relativeAgo(session.last_accessed ?? session.created_at);
  const statusLabel = isError ? "ERROR" : isWaiting ? "WAITING" : isRunning ? "RUNNING" : "IDLE";
  const statusColor = isError ? C_RED : isWaiting ? C_ORANGE : isRunning ? C_GREEN : "var(--c-dim)";

  return (
    <button
      onClick={() => onOpen(session.id)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        position: "relative", display: "flex", flexDirection: "column", gap: 0, width: "100%",
        padding: "12px 16px", border: "none", borderBottom: "1px solid var(--c-brd)",
        cursor: "pointer", textAlign: "left",
        background: isWaiting ? "rgba(251,146,60,0.05)" : hovered ? "var(--c-srf)" : "transparent",
        transition: "background 0.12s", fontFamily: "inherit",
      }}
    >
      {isWaiting && <span aria-hidden style={{ position: "absolute", left: 0, top: 12, bottom: 12, width: 2, background: C_ORANGE, borderRadius: 2 }} />}
      <div style={{ display: "flex", alignItems: "center", gap: 8, width: "100%" }}>
        <StatusRing status={isWaiting ? "waiting" : isError ? "error" : session.status} size={11} />
        {session.tool && <ProviderLogo tool={session.tool} size={11} />}
        <span style={{ minWidth: 0, maxWidth: 150, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 13.5, fontWeight: 600, color: "var(--c-high)" }}>{session.title || "Untitled"}</span>
        {isStaff && <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.06em", padding: "2px 6px", borderRadius: 4, background: "rgba(var(--fg-rgb),0.07)", border: "1px solid var(--c-brd)", color: "var(--c-med)", flexShrink: 0 }}>FLEET</span>}
        <span style={{ flex: 1 }} />
        <div style={{ textAlign: "right", flexShrink: 0 }}>
          <div style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: "0.06em", color: statusColor }}>{statusLabel}</div>
          <div style={{ fontSize: 12, fontWeight: 600, fontFamily: MONO, color: "var(--c-med)", marginTop: 2, fontVariantNumeric: "tabular-nums" }}>{costLabel}</div>
        </div>
        <ChevronRight size={14} style={{ color: "var(--c-ghost)", flexShrink: 0, marginLeft: 2 }} />
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginLeft: 19, marginTop: 4, fontFamily: MONO, fontSize: 10.5, color: "var(--c-ghost)", overflow: "hidden", whiteSpace: "nowrap" }}>
        {project && <span>{project}</span>}
        {project && modelShort && <span style={{ color: "var(--c-brd2)" }}>·</span>}
        {modelShort && <span style={{ color: "var(--c-dim)" }}>{modelShort}</span>}
        {msgCount > 0 && <><span style={{ color: "var(--c-brd2)" }}>·</span><span>{msgCount} msg</span></>}
        <span style={{ marginLeft: "auto", color: "var(--c-ghost)" }}>{ago}</span>
      </div>
    </button>
  );
});

/* ── Agent detail — the full visualised drill-down opened on click ── */
function AgentDetail({ session, detail, activity, onBack, onOpenChat }: {
  session: Session;
  detail: SessionDetail | undefined;
  activity: SessionActivityItem[];
  onBack: () => void;
  onOpenChat: () => void;
}) {
  const [stopping, setStopping] = useState(false);
  const cs = useChatStore(s => s.sessions[session.id]);
  const isRunning = session.status === "running" || session.status === "starting";
  const isWaiting = session.status === "waiting" || !!cs?.permissionRequest;
  const isError = session.status === "error";
  const statusLabel = isError ? "ERROR" : isWaiting ? "WAITING" : isRunning ? "RUNNING" : "IDLE";
  const statusColor = isError ? C_RED : isWaiting ? C_ORANGE : isRunning ? C_GREEN : "var(--c-dim)";

  const cost = detail?.total_cost_usd ?? session.budget_used ?? 0;
  const modelShort = shortModel(detail?.model ?? session.model_name);
  const project = session.project_path ? folderName(session.project_path) : null;
  const msgCount = detail?.message_count ?? cs?.messages?.length ?? 0;
  const ago = relativeAgo(session.last_accessed ?? session.created_at);

  const tk = detail?.tokens;
  const tokensTotal = tk ? tk.input + tk.output : 0;
  const cachePct = tk && tk.input + tk.cache_read > 0 ? Math.round((tk.cache_read / (tk.input + tk.cache_read)) * 100) : 0;
  const todos = detail?.todos ?? [];
  const stepsDone = todos.filter(t => t.status === "completed").length;
  const tools = detail?.tools ?? {};
  const tcTotal = Object.values(tools).reduce((a, b) => a + b, 0);
  const tc: Array<[string, number]> = [
    ["read", tools.Read ?? 0],
    ["bash", tools.Bash ?? 0],
    ["edit", (tools.Edit ?? 0) + (tools.Write ?? 0) + (tools.MultiEdit ?? 0)],
    ["web", (tools.WebFetch ?? 0) + (tools.WebSearch ?? 0) + (tools.fetch_url ?? 0)],
  ].filter(([, n]) => (n as number) > 0) as Array<[string, number]>;
  const tcMax = Math.max(1, ...tc.map(([, n]) => n));

  const memory = (detail?.memory_items ?? []).map((m) => {
    if (typeof m === "string") return { title: "", content: m };
    const o = m as { title?: string; text?: string; content?: string; summary?: string; value?: string };
    return { title: o.title ?? "", content: o.content ?? o.text ?? o.summary ?? o.value ?? "" };
  }).filter(x => x.content);

  const files = (() => {
    const seen = new Map<string, { edits: number; reads: number }>();
    for (const a of activity) {
      if (a.kind !== "file_edit" && a.kind !== "file_read") continue;
      const label = (a.summary || "").trim();
      if (!label) continue;
      const e = seen.get(label) ?? { edits: 0, reads: 0 };
      if (a.kind === "file_edit") e.edits++; else e.reads++;
      seen.set(label, e);
    }
    return [...seen.entries()].map(([path, c]) => ({ path, ...c }));
  })();

  const freshPct = tk && tk.input + tk.cache_read > 0 ? Math.round((tk.input / (tk.input + tk.cache_read)) * 100) : 100;

  const doStop = async () => { setStopping(true); try { await stopSession(session.id); } catch { /* ignore */ } setStopping(false); };

  return (
    <div style={{ animation: "fp-detail-in 0.22s cubic-bezier(0.22,1,0.36,1) both" }}>
      <style>{`@keyframes fp-detail-in { from { opacity: 0; transform: translateX(12px); } to { opacity: 1; transform: none; } }`}</style>
      {/* nav bar */}
      <div style={{ display: "flex", alignItems: "center", padding: "12px 14px", borderBottom: "1px solid var(--c-brd)" }}>
        <button onClick={onBack} style={{ display: "inline-flex", alignItems: "center", gap: 5, background: "none", border: "none", cursor: "pointer", fontFamily: "inherit", fontSize: 12, fontWeight: 500, color: "var(--c-dim)" }}>
          <ChevronLeft size={14} /> Fleet
        </button>
        <span style={{ flex: 1 }} />
        <button onClick={onOpenChat} style={{ background: "none", border: "none", cursor: "pointer", fontFamily: "inherit", fontSize: 11.5, fontWeight: 600, color: "var(--c-med)" }}>Open chat</button>
        {isRunning && <button onClick={doStop} style={{ marginLeft: 14, background: "none", border: "none", cursor: "pointer", fontFamily: "inherit", fontSize: 11.5, fontWeight: 500, color: "var(--c-dim)" }}>{stopping ? "Stopping…" : "Stop"}</button>}
      </div>

      {/* header + token gauge */}
      <div style={{ padding: "14px 16px", borderBottom: "1px solid var(--c-brd)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 9 }}>
          <StatusRing status={isWaiting ? "waiting" : isError ? "error" : session.status} size={12} />
          {session.tool && <ProviderLogo tool={session.tool} size={12} />}
          <span style={{ fontSize: 15, fontWeight: 600, color: "var(--c-high)" }}>{session.title || "Untitled"}</span>
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: "0.06em", color: statusColor }}>{statusLabel}</span>
        </div>
        <div style={{ fontFamily: MONO, fontSize: 11, color: "var(--c-dim)", marginBottom: 12 }}>
          {[project, modelShort, msgCount > 0 ? `${msgCount} msg` : null, cost > 0 ? fmtCost(cost) : null, ago].filter(Boolean).join("  ·  ")}
        </div>
        {tokensTotal > 0 && (
          <>
            <div style={{ height: 6, borderRadius: 3, background: "var(--c-srf)", overflow: "hidden", display: "flex", marginBottom: 5 }}>
              <span style={{ height: "100%", width: `${freshPct}%`, background: "var(--c-med)" }} />
              <span style={{ height: "100%", width: `${100 - freshPct}%`, background: "rgba(var(--fg-rgb),0.18)" }} />
            </div>
            <div style={{ fontFamily: MONO, fontSize: 10.5, color: "var(--c-dim)" }}>
              <b style={{ color: "var(--c-med)", fontWeight: 600 }}>{fmtTokens(tokensTotal)}</b> tokens <span style={{ color: "var(--c-brd2)" }}>·</span> <b style={{ color: "var(--c-med)", fontWeight: 600 }}>{cachePct}%</b> from cache
            </div>
          </>
        )}
      </div>

      {/* TASKS */}
      {todos.length > 0 && (
        <div style={{ padding: "14px 16px", borderBottom: "1px solid var(--c-brd)" }}>
          <DetailLabel label="Tasks" count={`${stepsDone}/${todos.length}`} />
          <div style={{ height: 3, borderRadius: 2, background: "var(--c-srf)", overflow: "hidden", marginBottom: 11 }}>
            <span style={{ display: "block", height: "100%", width: `${Math.round((stepsDone / todos.length) * 100)}%`, background: "var(--c-med)" }} />
          </div>
          {todos.map((t, i) => {
            const done = t.status === "completed"; const prog = t.status === "in_progress";
            return (
              <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 9, padding: "3px 0", fontSize: 12.5, lineHeight: 1.45, color: done ? "var(--c-dim)" : prog ? "var(--c-high)" : "var(--c-med)" }}>
                <span aria-hidden style={{ width: 14, height: 14, borderRadius: 4, flexShrink: 0, marginTop: 1, display: "inline-flex", alignItems: "center", justifyContent: "center", background: done ? "var(--c-med)" : "transparent", border: done ? "none" : "1.5px solid var(--c-ghost)" }}>
                  {done && <Check size={9} strokeWidth={3} style={{ color: "var(--background)" }} />}
                  {prog && <span style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--c-high)" }} />}
                </span>
                <span style={{ textDecoration: done ? "line-through" : "none", textDecorationColor: "var(--c-ghost)" }}>{t.activeForm && prog ? t.activeForm : t.content}</span>
              </div>
            );
          })}
        </div>
      )}

      {/* TOOL CALLS — visual bars */}
      {tcTotal > 0 && (
        <div style={{ padding: "14px 16px", borderBottom: "1px solid var(--c-brd)" }}>
          <DetailLabel label="Tool calls" count={tcTotal} />
          {tc.map(([k, n]) => (
            <div key={k} style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 7, fontFamily: MONO, fontSize: 11 }}>
              <span style={{ width: 36, color: "var(--c-dim)" }}>{k}</span>
              <span style={{ flex: 1, height: 5, borderRadius: 3, background: "var(--c-srf)", overflow: "hidden" }}>
                <span style={{ display: "block", height: "100%", width: `${Math.round((n / tcMax) * 100)}%`, background: "var(--c-med)" }} />
              </span>
              <span style={{ width: 32, textAlign: "right", color: "var(--c-med)", fontWeight: 600 }}>{n}</span>
            </div>
          ))}
        </div>
      )}

      {/* MEMORY */}
      {memory.length > 0 && (
        <div style={{ padding: "14px 16px", borderBottom: "1px solid var(--c-brd)" }}>
          <DetailLabel label="Memory" count={memory.length} />
          {memory.map((m, i) => (
            <div key={i} style={{ padding: "5px 0 6px", borderTop: i > 0 ? "1px solid var(--c-brd)" : "none" }}>
              {m.title && <div style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase", color: "var(--c-dim)", marginBottom: 3 }}>{m.title}</div>}
              <div style={{ fontSize: 12, color: "var(--c-med)", lineHeight: 1.5 }}>{m.content}</div>
            </div>
          ))}
        </div>
      )}

      {/* FILES — click to open in the workspace */}
      {files.length > 0 && (
        <div style={{ padding: "14px 16px", borderBottom: "1px solid var(--c-brd)" }}>
          <DetailLabel label="Files" count={files.length} />
          {files.map((f) => (
            <button
              key={f.path}
              onClick={onOpenChat}
              title="Open in workspace"
              style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, width: "100%", padding: "4px 6px", margin: "0 -6px", borderRadius: 5, border: "none", background: "none", cursor: "pointer", fontFamily: MONO, fontSize: 11, textAlign: "left" }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = "var(--c-srf)"; }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = "none"; }}
            >
              <span style={{ color: "var(--c-med)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{f.path}</span>
              <span style={{ color: "var(--c-ghost)", flexShrink: 0 }}>{f.edits > 0 ? `${f.edits} edit${f.edits === 1 ? "" : "s"}` : `${f.reads} read${f.reads === 1 ? "" : "s"}`}</span>
              <ChevronRight size={12} style={{ color: "var(--c-ghost)", flexShrink: 0 }} />
            </button>
          ))}
        </div>
      )}

      {/* ACTIVITY — expandable monochrome timeline (todo writes live in Tasks) */}
      {activity.some(r => r.kind !== "todo") && (
        <div style={{ padding: "14px 16px" }}>
          <DetailLabel label="Activity" count={activity.filter(r => r.kind !== "todo").length} />
          {activity.filter(r => r.kind !== "todo").map((row) => (
            <ActivityRow key={row.id} row={row} />
          ))}
        </div>
      )}
    </div>
  );
}

/** One activity row — collapsed by default, expands to show the agent's
 *  raw output (command result, error detail) in a mono block. */
function ActivityRow({ row }: { row: SessionActivityItem }) {
  const [open, setOpen] = useState(false);
  const Icon = logIcon(row);
  const isErr = row.kind === "error";
  const mono = row.kind === "command";
  const output = (row.payload?.output ?? "").trim();
  const hasMore = output.length > 0;
  return (
    <div>
      <button
        onClick={() => hasMore && setOpen(o => !o)}
        style={{ display: "flex", gap: 9, width: "100%", padding: "4.5px 0", alignItems: "baseline", background: "none", border: "none", cursor: hasMore ? "pointer" : "default", textAlign: "left", fontFamily: "inherit" }}
      >
        <span style={{ width: 38, flexShrink: 0, fontFamily: MONO, fontSize: 10, color: "var(--c-ghost)", fontVariantNumeric: "tabular-nums" }}>{clockTime(row.ts)}</span>
        <Icon size={12} strokeWidth={2} style={{ color: isErr ? "var(--c-med)" : "var(--c-dim)", flexShrink: 0, position: "relative", top: 1 }} />
        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: mono ? 11 : 11.5, fontFamily: mono ? MONO : "inherit", color: isErr ? "var(--c-med)" : "var(--c-dim)" }}>{logText(row)}</span>
        {hasMore && <ChevronRight size={12} style={{ color: "var(--c-ghost)", flexShrink: 0, transform: open ? "rotate(90deg)" : "none", transition: "transform 0.15s" }} />}
      </button>
      {open && hasMore && (
        <div style={{ margin: "1px 0 8px 38px", padding: "8px 10px", background: "var(--c-srf)", border: "1px solid var(--c-brd)", borderRadius: 6, fontFamily: MONO, fontSize: 10.5, color: "var(--c-med)", whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 200, overflowY: "auto", lineHeight: 1.55 }}>
          {output}
        </div>
      )}
    </div>
  );
}

function DetailLabel({ label, count }: { label: string; count?: React.ReactNode }) {
  return (
    <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", color: "var(--c-ghost)", marginBottom: 10 }}>
      {label}{count != null && <span style={{ color: "var(--c-dim)", marginLeft: 5, fontWeight: 600 }}>{count}</span>}
    </div>
  );
}

/** Monochrome lucide icon for an activity row — the kind is read at a glance
 *  from the icon, not a colour. */
function logIcon(row: SessionActivityItem): typeof Pencil {
  const t = (row.payload?.tool ?? "").replace(/^mcp__[a-z0-9_]+?__/i, "");
  if (row.kind === "file_edit") return Pencil;
  if (row.kind === "file_read") return Eye;
  if (row.kind === "command")   return Terminal;
  if (row.kind === "web_fetch") return Globe;
  if (row.kind === "error")     return AlertCircle;
  if (row.kind === "plan")      return FileText;
  if (t === "ask_user" || t === "AskUserQuestion") return HelpCircle;
  return Sparkles;
}

/** Wall-clock HH:MM for one activity row. */
function clockTime(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Cleaned, human log text for one activity row (de-namespaced, no select: junk). */
function logText(row: SessionActivityItem): string {
  const t = (row.payload?.tool ?? "").replace(/^mcp__[a-z0-9_]+?__/i, "");
  if (t === "ask_user" || t === "AskUserQuestion") return "asked you a question";
  const clean = (s: string) => s.replace(/select:/gi, "").replace(/mcp__[a-z0-9_]+?__/gi, "").trim();
  const base = humanActivity(row);
  const out = clean(base);
  return out || clean(row.summary || "") || row.kind;
}

/* ── Ask Fleet ─────────────────────────────────────────────────── */

function AskFleetCard({ buildSnapshot, initialOpen, initialQuestion }: {
  buildSnapshot: () => string;
  initialOpen?: boolean;
  initialQuestion?: string;
}) {
  const [open, setOpen] = useState(!!initialOpen);
  const [draft, setDraft] = useState(initialQuestion ?? "");
  const [pending, setPending] = useState(false);
  const [history, setHistory] = useState<Array<{ q: string; a: string; t: number }>>([]);

  const submit = useCallback(async (override?: string) => {
    const q = (override ?? draft).trim();
    if (!q || pending) return;
    setPending(true);
    try {
      const { text } = await askFleet({ question: q, fleetSnapshot: buildSnapshot() });
      setHistory(prev => [{ q, a: text, t: Date.now() }, ...prev].slice(0, 6));
      setDraft("");
    } catch {
      setHistory(prev => [{ q, a: "Couldn't reach Fleet — try again.", t: Date.now() }, ...prev].slice(0, 6));
    } finally {
      setPending(false);
    }
  }, [draft, pending, buildSnapshot]);

  return (
    <div style={{
      borderBottom: "1px solid var(--c-brd)",
      padding: "10px 14px",
    }}>
      <button
        onClick={() => setOpen(v => !v)}
        style={{
          display: "flex", alignItems: "center", gap: 8,
          padding: 0, width: "100%",
          background: "transparent", border: "none",
          cursor: "pointer", fontFamily: "inherit",
          textAlign: "left", color: "var(--c-high)",
        }}
      >
        <Brain size={12} strokeWidth={2.2} style={{ color: C_BLUE }} />
        <span style={{ flex: 1, fontSize: 12, fontWeight: 600, color: "var(--c-high)" }}>Ask Fleet</span>
        {history.length > 0 && (
          <span style={{ fontSize: 10, color: "var(--c-ghost)", fontVariantNumeric: "tabular-nums" }}>{history.length}</span>
        )}
        {open ? <ChevronUp size={11} style={{ color: "var(--c-ghost)" }} /> : <ChevronDown size={11} style={{ color: "var(--c-ghost)" }} />}
      </button>

      {open && (
        <div style={{ marginTop: 9, display: "flex", flexDirection: "column", gap: 9 }}>
          <div style={{ display: "flex", alignItems: "stretch", gap: 6 }}>
            <input
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } }}
              placeholder="What's ct stuck on? Who's idle?"
              disabled={pending}
              style={{
                flex: 1, minWidth: 0, padding: "6px 10px",
                fontSize: 12, fontFamily: "inherit", color: "var(--c-high)",
                background: "var(--c-srf)", border: "1px solid var(--c-brd)",
                borderRadius: 5, outline: "none",
              }}
            />
            <button
              onClick={() => submit()}
              disabled={pending || !draft.trim()}
              style={{
                padding: "0 10px",
                fontSize: 11, fontWeight: 600,
                color: pending || !draft.trim() ? "var(--c-ghost)" : "var(--c-high)",
                background: pending || !draft.trim() ? "transparent" : "var(--c-srf2)",
                border: "1px solid var(--c-brd)",
                borderRadius: 5,
                cursor: pending || !draft.trim() ? "default" : "pointer",
                fontFamily: "inherit",
                display: "flex", alignItems: "center", gap: 4,
              }}
            >
              {pending ? <Loader2 size={11} className="animate-spin" /> : <><Send size={10} strokeWidth={2.2} /> Ask</>}
            </button>
          </div>
          {history.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
              {history.map((qa, i) => (
                <div key={i} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                  <div style={{ fontSize: 11, color: "var(--c-med)", lineHeight: 1.4 }}>{qa.q}</div>
                  <div style={{ display: "flex", gap: 7, alignItems: "flex-start" }}>
                    <Brain size={10} strokeWidth={2.2} style={{ color: C_BLUE, marginTop: 2, flexShrink: 0 }} />
                    <div style={{
                      fontSize: 11.5, color: "var(--c-low)", lineHeight: 1.45,
                      whiteSpace: "pre-wrap",
                    }}>{qa.a}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ── Activity feed row ─────────────────────────────────────────── */

function ActivityFeedRow({ row }: { row: FleetActivityRow }) {
  const isError = row.kind === "error";
  // De-namespace MCP tool ids (mcp__server__tool → tool) so the feed never
  // shows the raw "mcp__fleet_permission__ask_user" twice.
  const rawTool = (row.payload?.tool ?? "").replace(/^mcp__[a-z0-9_]+?__/i, "");
  const verb = (() => {
    if (row.kind === "file_edit") return "Edit";
    if (row.kind === "file_read") return "Read";
    if (row.kind === "command")   return "Run";
    if (row.kind === "web_fetch") return "Fetch";
    if (row.kind === "error")     return "Error";
    if (rawTool === "ask_user" || rawTool === "AskUserQuestion") return "Ask";
    if (rawTool === "ToolSearch") return "Search";
    return rawTool || "Tool";
  })();
  const cleanText = (s: string) =>
    s.replace(/select:/gi, "").replace(/mcp__[a-z0-9_]+?__/gi, "").trim();
  const detail = (() => {
    if (row.kind === "error") return rawTool ? `${rawTool} failed` : (row.summary || "failed");
    if (rawTool === "ask_user" || rawTool === "AskUserQuestion") return "asked you a question";
    if (rawTool === "ToolSearch") {
      const t = cleanText(row.summary || "");
      return t ? `for ${t}` : "";
    }
    const h = cleanText(humanActivity(row));
    return h && h !== (row.payload?.tool ?? "") ? h : "";
  })();
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 7,
      padding: "3px 4px",
      fontSize: 10.5, lineHeight: 1.4,
      color: "var(--c-dim)",
    }}>
      <span style={{
        flexShrink: 0,
        fontFamily: MONO, fontSize: 10,
        color: "var(--c-ghost)",
        minWidth: 28,
        fontVariantNumeric: "tabular-nums",
      }}>{relativeAgo(row.ts)}</span>
      <span style={{
        flexShrink: 0,
        color: "var(--c-low)", fontWeight: 600,
        minWidth: 0, maxWidth: 70,
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        fontSize: 10.5,
      }}>{row.session_title}</span>
      <span style={{
        flexShrink: 0,
        color: isError ? C_RED : "var(--c-med)",
        fontFamily: MONO, fontSize: 10, fontWeight: 600,
      }}>{verb}</span>
      <span style={{
        flex: 1, minWidth: 0,
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        color: "var(--c-dim)",
        fontFamily: verb === "Run" ? MONO : "inherit",
      }}>{detail}</span>
    </div>
  );
}

/* ── Report row ────────────────────────────────────────────────── */

function SectionBullets({ label, color, items }: { label: string; color: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <span style={{
        fontSize: 9.5, fontWeight: 700, color,
        letterSpacing: "0.06em", textTransform: "uppercase",
      }}>{label}</span>
      <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 2 }}>
        {items.map((it, i) => (
          <li key={i} style={{
            fontSize: 11, color: "var(--c-low)", lineHeight: 1.4,
            paddingLeft: 11, position: "relative",
          }}>
            <span style={{
              position: "absolute", left: 1, top: "0.55em",
              width: 3, height: 3, borderRadius: 999,
              background: color, opacity: 0.8,
            }} />
            {it}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ReportRow({ title, body, sections, ago }: {
  title: string; body: string; sections?: FleetReport["sections"]; ago: string;
}) {
  const hasSections = !!(sections?.whatDone?.length || sections?.decisions?.length || sections?.uncertain?.length || sections?.options?.length);
  return (
    <div style={{
      position: "relative",
      padding: "10px 12px 11px",
      borderBottom: "1px solid var(--c-brd)",
      display: "flex", flexDirection: "column", gap: 6,
    }}>
      <span aria-hidden style={{
        position: "absolute", left: 0, top: 10, bottom: 10, width: 2,
        background: C_GREEN, borderRadius: 2,
      }} />
      <div style={{ display: "flex", alignItems: "center", gap: 7, marginLeft: 10 }}>
        <span style={{ fontSize: 9.5, fontWeight: 700, color: C_GREEN, letterSpacing: "0.06em" }}>DONE</span>
        <span style={{
          flex: 1, minWidth: 0,
          fontSize: 12, fontWeight: 600, color: "var(--c-high)",
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>{title}</span>
        <span style={{ fontSize: 10, color: "var(--c-ghost)", flexShrink: 0, fontFamily: MONO }}>{ago}</span>
      </div>
      <div style={{ marginLeft: 10 }}>
        {hasSections ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
            {sections?.whatDone?.length ? <SectionBullets label="What Fleet did" color={C_GREEN}  items={sections.whatDone}  /> : null}
            {sections?.decisions?.length ? <SectionBullets label="Decisions"      color={C_BLUE}   items={sections.decisions} /> : null}
            {sections?.uncertain?.length ? <SectionBullets label="Uncertain"      color={C_ORANGE} items={sections.uncertain} /> : null}
            {sections?.options?.length   ? <SectionBullets label="Options"        color="var(--c-med)" items={sections.options} /> : null}
          </div>
        ) : (
          <span style={{
            fontSize: 11.5, color: "var(--c-low)", lineHeight: 1.45,
            overflow: "hidden", textOverflow: "ellipsis",
            display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical",
          }}>{body}</span>
        )}
      </div>
    </div>
  );
}

function SectionLabel({ children, count }: { children: React.ReactNode; count?: number }) {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 6,
      padding: "10px 14px 7px",
    }}>
      <span style={{
        fontSize: 10, fontWeight: 700, color: "var(--c-ghost)",
        letterSpacing: "0.08em", textTransform: "uppercase",
      }}>{children}</span>
      {count != null && count > 0 && (
        <span style={{ fontSize: 10, color: "var(--c-dim)", fontVariantNumeric: "tabular-nums" }}>{count}</span>
      )}
    </div>
  );
}

/* ── Main ──────────────────────────────────────────────────────── */

export function FleetPanel({ sessions, onSelectAgent }: Props) {
  const toggleRightPanel = useAppStore(s => s.toggleRightPanel);
  const setActiveSession = useAppStore(s => s.setActiveSession);

  const { activity, details } = useFleetData(sessions);

  const fleetSessions = useFleetStore(s => s.sessions);
  const decisions = useFleetStore(s => s.decisions);
  const reports = useFleetStore(s => s.reports);
  // Manual mode hides the co-pilot meta surfaces (Observations + Ask
  // Fleet) so the right panel reduces to the watching strip + session
  // rows + reports list. Keeps the demo path uncluttered.
  const fleetGlobalMode = useFleetStore(s => s.globalMode);
  const coPilotActive = fleetGlobalMode !== "manual";

  // Bridge for the "Catch me up" button — pre-fills Ask Fleet input
  // and auto-opens the section.
  const [askInitial, setAskInitial] = useState<{ q: string; tick: number } | null>(null);
  // Master-detail: which session is drilled into (full visual detail view).
  const [detailId, setDetailId] = useState<string | null>(null);

  const agents = useMemo(
    () => sessions.filter(s => (s.title || "").trim() !== "New chat"),
    [sessions],
  );

  const activityBySession = useMemo(() => {
    const map = new Map<string, FleetActivityRow[]>();
    for (const row of activity) {
      const arr = map.get(row.session_id) ?? [];
      arr.push(row);
      map.set(row.session_id, arr);
    }
    return map;
  }, [activity]);

  const decisionBySession = useMemo(() => {
    const map = new Map<string, FleetDecision>();
    for (const d of decisions) if (!map.has(d.sessionId)) map.set(d.sessionId, d);
    return map;
  }, [decisions]);

  const activeCount = agents.filter(s => s.status === "running" || s.status === "starting").length;
  const idleSessions = useMemo(() => agents.filter(s => {
    const last = s.last_accessed ?? s.created_at;
    if (!last) return false;
    const age = Date.now() - Date.parse(last);
    return isFinite(age) && age > 24 * 3_600_000;
  }), [agents]);

  const spend = agents.reduce((sum, s) => sum + (details[s.id]?.total_cost_usd ?? s.budget_used ?? 0), 0);
  const totalTokens = Object.values(details).reduce((sum, d) => {
    if (!d) return sum;
    return sum + d.tokens.input + d.tokens.output + d.tokens.cache_read + d.tokens.cache_write;
  }, 0);
  const fleetTotalSpend = useMemo(
    () => Object.values(fleetSessions).reduce((sum, s) => sum + s.costSpent, 0),
    [fleetSessions],
  );
  const pendingCount = decisions.length;

  // Cross-fleet observations.
  const insights = useMemo<Insight[]>(() => {
    const list: Insight[] = [];

    // Idle warning
    if (idleSessions.length >= 2) {
      list.push({
        id: "idle-many",
        tone: "warning",
        icon: AlertCircle,
        text: `${idleSessions.length} sessions untouched 24h+ · consider archiving`,
        cta: "Review",
      });
    }

    // Permission requests pending
    const waitingPerms = agents.filter(s => s.status === "waiting");
    if (waitingPerms.length > 0) {
      list.push({
        id: "perms",
        tone: "warning",
        icon: AlertCircle,
        text: `${waitingPerms.length} session${waitingPerms.length === 1 ? "" : "s"} waiting on permission`,
        cta: "Jump in",
        onClick: () => { setActiveSession(waitingPerms[0]!.id); onSelectAgent(waitingPerms[0]!.id); },
      });
    }

    // Shared-project cluster
    const byProject = new Map<string, Session[]>();
    for (const s of agents) {
      if (!s.project_path) continue;
      const key = s.project_path;
      byProject.set(key, [...(byProject.get(key) ?? []), s]);
    }
    for (const [proj, ss] of byProject) {
      if (ss.length >= 2) {
        const projShort = proj.split("/").filter(Boolean).slice(-1)[0] ?? proj;
        list.push({
          id: `cluster-${proj}`,
          tone: "info",
          icon: Sparkles,
          text: `${ss.length} sessions on the same project (${projShort}) — work could overlap`,
        });
      }
    }

    // Pending decisions across the fleet
    if (decisions.length > 0) {
      list.push({
        id: "decisions",
        tone: "info",
        icon: Brain,
        text: `Fleet has ${decisions.length} decision${decisions.length === 1 ? "" : "s"} for you · check the highlighted rows`,
      });
    }

    return list.slice(0, 4);
  }, [idleSessions, agents, decisions, setActiveSession, onSelectAgent]);

  const sortedAgents = useMemo(() => {
    const rank = (s: Session): number => {
      const fs = fleetSessions[s.id];
      const live = s.status === "running" || s.status === "starting";
      const hasDecision = decisionBySession.has(s.id);
      const isWaiting = s.status === "waiting";
      if (hasDecision || isWaiting) return 0;
      if (fs?.status === "paused") return 1;
      if (live) return 2;
      if (fs?.status === "auto-continuing") return 3;
      if (fs?.status === "done") return 4;
      return 5;
    };
    return [...agents].sort((a, b) => rank(a) - rank(b));
  }, [agents, fleetSessions, decisionBySession]);

  const jumpTo = useCallback((sessionId: string) => {
    setActiveSession(sessionId);
    onSelectAgent(sessionId);
  }, [setActiveSession, onSelectAgent]);

  // Stable per-row dismiss handler. Looks up the decision from the
  // latest map via the closure variable; the SessionRow itself only
  // sees a (sessionId) => void signature so its callback identity
  // stays the same across parent re-renders.
  const buildSnapshot = useCallback((): string => {
    const lines: string[] = [];
    lines.push(`Fleet has ${agents.length} agents (${activeCount} active, ${pendingCount} pending).`);
    if (spend > 0) lines.push(`Total spend so far: ${fmtCost(spend)}.`);
    lines.push("");
    lines.push("Sessions:");
    for (const s of agents.slice(0, 30)) {
      const fs = fleetSessions[s.id];
      const d = details[s.id];
      const live = s.status === "running" || s.status === "starting";
      const arr = activityBySession.get(s.id);
      const last = arr?.[0];
      const proj = s.project_path ? (folderName(s.project_path) || "?") : "—";
      const fleetStatus = fs?.status ?? "idle";
      const parts = [
        `- ${s.title || "Untitled"}`,
        `(${live ? "running" : s.status})`,
        `· fleet: ${fleetStatus}`,
        `· project: ${proj}`,
        `· spend: ${fmtCost(d?.total_cost_usd ?? s.budget_used ?? 0)}`,
      ];
      if (last) parts.push(`· last: ${humanActivity(last).slice(0, 80)} (${relativeAgo(last.ts)})`);
      if (fs?.lastAction) parts.push(`· fleet's last take: ${fs.lastAction}`);
      lines.push(parts.join(" "));
    }
    if (decisions.length > 0) {
      lines.push("");
      lines.push("Pending decisions:");
      for (const d of decisions.slice(0, 6)) {
        const s = agents.find(a => a.id === d.sessionId);
        const tag = d.kind === "ask" ? "ASK" : d.kind === "continue" ? "CONTINUE" : "DONE";
        const txt = d.kind === "ask" ? d.question : d.kind === "continue" ? d.nextPrompt : d.summary;
        lines.push(`- [${tag}] ${s?.title ?? "session"}: ${txt ?? d.reasoning}`);
      }
    }
    return lines.join("\n");
  }, [agents, fleetSessions, details, activityBySession, activeCount, pendingCount, spend, decisions]);

  // Bulk action handlers.
  const handleCatchUp = useCallback(() => {
    setAskInitial({ q: "Catch me up on what each session has been doing and where I should focus.", tick: Date.now() });
  }, []);

  const handleStopAll = useCallback(async () => {
    const running = agents.filter(s => s.status === "running" || s.status === "starting");
    if (running.length === 0) return;
    if (!confirm(`Stop ${running.length} running session${running.length === 1 ? "" : "s"}?`)) return;
    await Promise.allSettled(running.map(s => stopSession(s.id)));
  }, [agents]);

  const handleArchiveIdle = useCallback(async () => {
    if (idleSessions.length === 0) return;
    if (!confirm(`Archive ${idleSessions.length} session${idleSessions.length === 1 ? "" : "s"} idle 24h+?`)) return;
    await Promise.allSettled(idleSessions.map(s => archiveSession(s.id)));
  }, [idleSessions]);

  return (
    <div style={{
      height: "100%", minHeight: 0, minWidth: 0,
      background: "var(--sidebar)",
      border: "1px solid var(--c-brd)",
      borderRadius: 10,
      boxShadow: "0 1px 2px rgba(0,0,0,0.30), 0 4px 12px rgba(0,0,0,0.18)",
      animation: "fleet-pane-in 0.22s cubic-bezier(0.22, 1, 0.36, 1) both",
      display: "flex", flexDirection: "column",
      overflow: "hidden",
    }}>
      <style>{`@keyframes ring-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>

      {/* Title row */}
      <div style={{
        flexShrink: 0,
        height: 44, padding: "0 12px",
        display: "flex", alignItems: "center", gap: 6,
        borderBottom: "1px solid var(--c-brd)",
      }}>
        <span style={{
          flex: 1,
          fontFamily: "'Geist Variable', 'Geist', system-ui, sans-serif",
          fontWeight: 700, fontSize: 14, letterSpacing: "-0.025em", lineHeight: 1,
          color: "var(--foreground)",
        }}>Fleet</span>
        <button
          onClick={toggleRightPanel}
          title="Hide Fleet"
          style={{
            width: 22, height: 22,
            display: "flex", alignItems: "center", justifyContent: "center",
            background: "none", border: "none", cursor: "pointer",
            color: "var(--c-ghost)", borderRadius: 5,
            transition: "background 0.1s, color 0.1s",
          }}
          onMouseEnter={e => { const el = e.currentTarget as HTMLElement; el.style.background = "var(--c-srf)"; el.style.color = "var(--c-med)"; }}
          onMouseLeave={e => { const el = e.currentTarget as HTMLElement; el.style.background = "none"; el.style.color = "var(--c-ghost)"; }}
        >
          <X size={12} />
        </button>
      </div>

      {/* Body */}
      <div className="scroll-subtle" style={{
        flex: 1, minHeight: 0,
        overflowY: "auto",
      }}>
        {agents.length === 0 ? (
          <div style={{
            padding: "40px 16px",
            color: "var(--c-dim)", fontSize: 12, lineHeight: 1.5,
            textAlign: "center",
            display: "flex", flexDirection: "column", alignItems: "center", gap: 7,
          }}>
            <FileText size={20} strokeWidth={1.5} style={{ color: "var(--c-ghost)" }} />
            <span style={{ color: "var(--c-low)" }}>No agents yet.</span>
            <span style={{ fontSize: 11, color: "var(--c-ghost)" }}>Spawn one from the canvas to start.</span>
          </div>
        ) : detailId && agents.some(a => a.id === detailId) ? (
          (() => {
            const ds = agents.find(a => a.id === detailId)!;
            return (
              <AgentDetail
                session={ds}
                detail={details[ds.id]}
                activity={activityBySession.get(ds.id) ?? []}
                onBack={() => setDetailId(null)}
                onOpenChat={() => { setDetailId(null); jumpTo(ds.id); }}
              />
            );
          })()
        ) : (
          <>
            <WatchingStrip
              agentCount={agents.length}
              activeCount={activeCount}
              pendingCount={pendingCount}
              spend={spend}
              totalTokens={totalTokens}
              fleetSpend={fleetTotalSpend}
              onCatchUp={handleCatchUp}
              onStopAll={handleStopAll}
              onArchiveIdle={handleArchiveIdle}
              canStopAll={activeCount > 0}
              canArchiveIdle={idleSessions.length > 0}
              showCatchUp={coPilotActive}
            />

            {coPilotActive && <InsightsList insights={insights} />}

            {coPilotActive && (
              <AskFleetCard
                key={askInitial?.tick ?? "ask"}
                buildSnapshot={buildSnapshot}
                initialOpen={!!askInitial}
                initialQuestion={askInitial?.q}
              />
            )}

            <SectionLabel count={agents.length}>Sessions</SectionLabel>
            {sortedAgents.map((s) => (
              <SessionRow
                key={s.id}
                session={s}
                detail={details[s.id]}
                onOpen={setDetailId}
              />
            ))}

            {activity.length > 0 && (
              <>
                <SectionLabel count={Math.min(10, activity.length)}>Recent activity</SectionLabel>
                <div style={{ padding: "0 12px 10px", display: "flex", flexDirection: "column", gap: 0 }}>
                  {activity.slice(0, 10).map(row => (
                    <ActivityFeedRow key={row.id} row={row} />
                  ))}
                </div>
              </>
            )}

            {reports.length > 0 && (
              <>
                <SectionLabel count={reports.length}>Reports</SectionLabel>
                {reports.slice(0, 6).map(r => (
                  <ReportRow key={r.id} title={r.title} body={r.body} sections={r.sections} ago={relativeAgo(r.createdAt)} />
                ))}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

declare global {
  interface WindowEventMap {
    "fleet:send-prompt": CustomEvent<{ sessionId: string; text: string }>;
  }
}
