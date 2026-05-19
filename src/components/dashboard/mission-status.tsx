/**
 * Mission Status — top sticky bar of the right-sidebar Pulse layout.
 *
 * Five tactical readouts, one strip:
 *   1. Live cost today (large) + 24h sparkline
 *   2. Status counters (running / idle / waiting / error)
 *   3. Agent-hours under load (live, ticks each second while anything streams)
 *   4. Cache efficiency badge
 *   5. Fleet budget bar (only when at least one session has a budget set)
 *
 * Reads:
 *   - app-store sessions (status, budget_limit, budget_used)
 *   - chat-store sessions[*].messages (per-message cost for sparkline)
 *   - chat-store sessions[*].streamStartTime (for live agent-hours)
 *   - bulk stats (passed in as `stats`) for token totals
 *
 * No interaction — this is a heads-up display.
 */
import { useEffect, useMemo, useState } from "react";
import { useChatStore } from "@/stores/chat-store";
import type { Session } from "@/types/session";
import {
  Sparkline,
  bucketCostByHour,
  liveAgentHours,
  fmtAgentHours,
} from "./pulse-bits";

/** Bulk-stats shape — mirrors what ControlCenterPanel keeps in `statsMap`. */
interface Stats {
  message_count: number;
  total_cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  cache_tokens: number;
  last_model?: string | null;
}

interface Props {
  sessions: Session[];
  stats: Record<string, Stats>;
}

function fmtCostBig(cost: number): string {
  if (cost === 0) return "$0";
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  if (cost < 1) return `$${cost.toFixed(2)}`;
  return `$${cost.toFixed(2)}`;
}

export function MissionStatus({ sessions, stats }: Props) {
  const chatSessions = useChatStore(s => s.sessions);

  // Tick once per second so the agent-hours readout looks alive while
  // anything is streaming. No-op when nothing is live (the effect tears
  // itself down). Hooks must run on every render so the effect itself
  // unconditional, but the interval only fires when needed.
  const [, setTick] = useState(0);
  const anyStreaming = sessions.some(s => chatSessions[s.id]?.isStreaming);
  useEffect(() => {
    if (!anyStreaming) return;
    const iv = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(iv);
  }, [anyStreaming]);

  // ── Smart cost picker ────────────────────────────────────────
  // The big number ALWAYS shows something meaningful: prefer "today"
  // when there's spend, otherwise fall back to last-7-days, otherwise
  // all-time. The label switches with it so "$0 TODAY" never lies
  // when there's clearly recent activity in the fleet.
  const costView = useMemo(() => {
    const now = Date.now();
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const todayCut = startOfDay.getTime();
    const sevenCut = now - 7 * 86_400_000;
    let today = 0, last7d = 0;
    for (const s of sessions) {
      const cs = chatSessions[s.id];
      if (!cs) continue;
      for (const m of cs.messages) {
        if (typeof m.cost_usd !== "number" || !m.timestamp) continue;
        const ts = new Date(m.timestamp).getTime();
        if (Number.isNaN(ts)) continue;
        if (ts >= sevenCut) last7d += m.cost_usd;
        if (ts >= todayCut) today += m.cost_usd;
      }
    }
    let allTime = 0;
    for (const m of Object.values(stats)) allTime += m.total_cost_usd;
    // Pick the smallest non-empty window so the headline reflects the
    // most recent activity. Falls all the way back to all-time so the
    // panel never reads as "$0" when there's real spend on file.
    if (today > 0)   return { primary: today,   label: "today",   today, last7d, allTime };
    if (last7d > 0)  return { primary: last7d,  label: "7 days",  today, last7d, allTime };
    return            { primary: allTime, label: "total",   today, last7d, allTime };
  }, [sessions, chatSessions, stats]);

  // ── Live burn rate ($/h) ─────────────────────────────────────
  // Cost charged in the last 60 minutes — already in $/hour units.
  // Hidden when nothing is streaming so it doesn't read as a stale figure.
  const burnRate = useMemo(() => {
    if (!anyStreaming) return 0;
    const cut = Date.now() - 3_600_000;
    let cost = 0;
    for (const s of sessions) {
      const cs = chatSessions[s.id];
      if (!cs) continue;
      for (const m of cs.messages) {
        if (typeof m.cost_usd !== "number" || !m.timestamp) continue;
        const ts = new Date(m.timestamp).getTime();
        if (!Number.isNaN(ts) && ts >= cut) cost += m.cost_usd;
      }
    }
    return cost;
  }, [sessions, chatSessions, anyStreaming]);

  // ── Live throughput (tokens / min) ───────────────────────────
  // Output tokens stamped onto messages in the last minute — only meaningful
  // while at least one session is live, since otherwise it's always 0.
  const tokensPerMin = useMemo(() => {
    if (!anyStreaming) return 0;
    const cut = Date.now() - 60_000;
    let toks = 0;
    for (const s of sessions) {
      const cs = chatSessions[s.id];
      if (!cs) continue;
      for (const m of cs.messages) {
        if (!m.timestamp) continue;
        const ts = new Date(m.timestamp).getTime();
        if (Number.isNaN(ts) || ts < cut) continue;
        // ChatMessage.usage may be absent on streaming-only deltas.
        const u = m.usage;
        if (u?.output_tokens) toks += u.output_tokens;
      }
    }
    return toks;
  }, [sessions, chatSessions, anyStreaming]);

  // 24h cost sparkline — derive from in-memory message history. For
  // large fleets we'd want a backend rollup, but at typical usage
  // (handful of agents, hundreds of messages) this is fine.
  const trend = useMemo(() => {
    const all = sessions.flatMap(s => chatSessions[s.id]?.messages ?? []);
    return bucketCostByHour(all, 24);
  }, [sessions, chatSessions]);

  // Status counts — running / waiting / idle / error.
  const counts = useMemo(() => {
    let running = 0, waiting = 0, idle = 0, error = 0;
    for (const s of sessions) {
      const cs = chatSessions[s.id];
      const isWaiting = s.status === "waiting" || cs?.permissionRequest != null;
      if (isWaiting) { waiting++; continue; }
      if (s.status === "running" || s.status === "starting") { running++; continue; }
      if (s.status === "error") { error++; continue; }
      idle++;
    }
    return { running, waiting, idle, error };
  }, [sessions, chatSessions]);

  // Live agent-hours — sum of (now - streamStartTime) across streaming sessions.
  const agentHours = useMemo(() => {
    return liveAgentHours(sessions.map(s => chatSessions[s.id]?.streamStartTime));
    // Recomputes every render (which is every second when streaming).
  }, [sessions, chatSessions]);

  // Cache efficiency — total cache reads / total tokens. The bigger the
  // cache hit rate, the more we're saving on Anthropic prompt cache.
  const cacheRatio = useMemo(() => {
    let cached = 0, total = 0;
    for (const m of Object.values(stats)) {
      cached += m.cache_tokens;
      total += m.input_tokens + m.output_tokens + m.cache_tokens;
    }
    return total > 0 ? Math.round((cached / total) * 100) : 0;
  }, [stats]);

  // Fleet budget — sum across sessions that opted in.
  const budget = useMemo(() => {
    let limit = 0, used = 0, anySet = false;
    for (const s of sessions) {
      if (typeof s.budget_limit === "number" && s.budget_limit > 0) {
        anySet = true;
        limit += s.budget_limit;
        used += s.budget_used ?? 0;
      }
    }
    return anySet ? { limit, used, ratio: limit > 0 ? Math.min(used / limit, 1.2) : 0 } : null;
  }, [sessions]);

  return (
    <div
      style={{
        flexShrink: 0,
        // Tighter — was 10/12/12 + gap 8. New: 8/12/8 + gap 4.
        // The two rows are intrinsically related (cost trend + live
        // readouts), so they don't need the breathing room of unrelated
        // sections. Keeps the mission header from eating ~50px when 90%
        // of the time there's no streaming activity.
        padding: "8px 12px 8px",
        display: "flex",
        flexDirection: "column",
        gap: 4,
      }}
    >
      {/* Row 1 — cost (smart-windowed) + sparkline + status counters */}
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span
          title={`today $${costView.today.toFixed(2)} · 7d $${costView.last7d.toFixed(2)} · total $${costView.allTime.toFixed(2)}`}
          style={{
            fontSize: 17,
            fontWeight: 600,
            color: "var(--c-high)",
            letterSpacing: "-0.02em",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {fmtCostBig(costView.primary)}
        </span>
        <span style={{ fontSize: 10.5, color: "var(--c-ghost)", letterSpacing: "0.06em", textTransform: "uppercase" }}>
          {costView.label}
        </span>
        <Sparkline
          values={trend}
          width={70}
          height={14}
          color="var(--c-low)"
          strokeWidth={1.1}
          ariaLabel="24-hour cost trend"
          style={{ marginLeft: 2, flex: 1 }}
        />
        <StatusCounter color="#4ade80" count={counts.running} pulse={counts.running > 0} label="running" />
        <StatusCounter color="#fb923c" count={counts.waiting} pulse={counts.waiting > 0} label="waiting" hideIfZero />
        <StatusCounter color="var(--c-low)" count={counts.idle} label="idle" />
        <StatusCounter color="#f87171" count={counts.error} label="error" hideIfZero />
      </div>

      {/* Row 2 — live readouts: burn rate, throughput, cache, uptime.
          Burn rate + throughput show only while at least one session is
          live so they stop reading as stale ghost numbers when idle. */}
      <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: "4px 14px", fontSize: 11, color: "var(--c-ghost)" }}>
        {anyStreaming && burnRate > 0 && (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
            <span style={{
              width: 5, height: 5, borderRadius: 999,
              background: "#fb923c",
              animation: "cc-pulse 1.4s ease-in-out infinite",
            }} />
            <span style={{ color: "var(--c-high)", fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
              ${burnRate.toFixed(burnRate < 1 ? 3 : 2)}
            </span>
            <span>/hour burn</span>
          </span>
        )}
        {anyStreaming && tokensPerMin > 0 && (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
            <span style={{ color: "var(--c-low)", fontWeight: 500, fontVariantNumeric: "tabular-nums" }}>
              {tokensPerMin >= 1000 ? `${(tokensPerMin / 1000).toFixed(1)}k` : tokensPerMin}
            </span>
            <span>tok/min</span>
          </span>
        )}
        <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
          <span style={{ color: "var(--c-low)", fontWeight: 500, fontVariantNumeric: "tabular-nums" }}>
            {fmtAgentHours(agentHours)}
          </span>
          <span>under load</span>
        </span>
        {cacheRatio > 0 && (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
            <span style={{ color: "var(--c-high)", fontWeight: 500, fontVariantNumeric: "tabular-nums" }}>
              {cacheRatio}%
            </span>
            <span>cached</span>
          </span>
        )}
      </div>

      {/* Row 3 — fleet budget bar (only when set) */}
      {budget && (
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div
            style={{
              flex: 1,
              height: 4,
              borderRadius: 2,
              background: "var(--c-srf)",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                width: `${Math.min(budget.ratio, 1) * 100}%`,
                height: "100%",
                background: budget.ratio > 0.9 ? "#f87171" : budget.ratio > 0.7 ? "#fb923c" : "#4ade80",
                transition: "width 0.4s ease, background 0.2s ease",
              }}
            />
          </div>
          <span
            style={{
              fontSize: 10.5,
              color: budget.ratio > 0.9 ? "#f87171" : "var(--c-ghost)",
              fontVariantNumeric: "tabular-nums",
              flexShrink: 0,
            }}
          >
            ${budget.used.toFixed(2)} / ${budget.limit.toFixed(0)}
          </span>
        </div>
      )}
    </div>
  );
}

function StatusCounter({
  color, count, label, pulse, hideIfZero,
}: { color: string; count: number; label: string; pulse?: boolean; hideIfZero?: boolean }) {
  if (hideIfZero && count === 0) return null;
  return (
    <span
      title={`${count} ${label}`}
      style={{ display: "inline-flex", alignItems: "center", gap: 4, flexShrink: 0 }}
    >
      <span
        style={{
          width: 6, height: 6, borderRadius: 999,
          background: color,
          animation: pulse ? "cc-pulse 2s ease-in-out infinite" : "none",
        }}
      />
      <span style={{ fontSize: 11, fontWeight: 600, color: "var(--c-low)", fontVariantNumeric: "tabular-nums" }}>
        {count}
      </span>
    </span>
  );
}
