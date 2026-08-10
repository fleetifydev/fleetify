/**
 * Router section of the Fleet right sidebar.
 *
 * Shows BOTH routing surfaces, read-only (docs/ROUTING.md §4 boundary
 * respected): the user's Settings → Routers state + Auto-mode sessions.
 * Data comes from GET /api/routing/summary (5 s poll upstream); Auto
 * detection, spend and working time are derived locally from the
 * sessions/details the panel already holds — so the Auto row still
 * renders when the endpoint fails (summary === null).
 *
 * Visibility: null unless routing is enabled, an Auto session exists,
 * or a decision landed in the last 24 h.
 */
import { GitBranch } from "lucide-react";
import { useMemo } from "react";
import type { RoutingSummary } from "@/lib/api";
import type { Session } from "@/types/session";
import type { AgentDetailMap, FleetActivityRow } from "./hooks/use-fleet-data";
import { activeWorkingMs, formatWorkingTime } from "./working-time";

interface Props {
  summary: RoutingSummary | null | undefined;
  sessions: Session[];
  details: AgentDetailMap;
  activityBySession: Map<string, FleetActivityRow[]>;
}

const C_ORANGE = "#fb923c";

function agoLabel(tsSec: number): string {
  const mins = Math.floor((Date.now() / 1000 - tsSec) / 60);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function fmtUsd(v: number): string {
  return `$${v.toFixed(2)}`;
}

/** Quiet label/value row matching the panel's rhythm. */
function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{
      display: "flex", alignItems: "baseline", gap: 8,
      padding: "2px 14px", fontSize: 11, lineHeight: 1.6,
    }}>
      <span style={{
        width: 62, flexShrink: 0, color: "var(--c-ghost)",
        fontSize: 10, letterSpacing: "0.02em",
      }}>{label}</span>
      <span style={{ color: "var(--c-low)", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {children}
      </span>
    </div>
  );
}

export function RouterSection({ summary, sessions, details, activityBySession }: Props) {
  const autoSessions = useMemo(
    () => sessions.filter(s => s.tool === "auto" || s.model_name === "auto"),
    [sessions],
  );

  const decisions = summary?.totals_24h.decisions ?? 0;
  const visible = summary?.enabled === true || autoSessions.length > 0 || decisions > 0;

  // Today's routed set = chat-flow decisions' sessions ∪ live Auto sessions.
  const routedIds = useMemo(() => {
    const ids = new Set<string>(summary?.routed_session_ids ?? []);
    for (const s of autoSessions) ids.add(s.id);
    return ids;
  }, [summary?.routed_session_ids, autoSessions]);

  const bySessionId = useMemo(() => {
    const m = new Map<string, Session>();
    for (const s of sessions) m.set(s.id, s);
    return m;
  }, [sessions]);

  const spend = useMemo(() => {
    let sum = 0;
    for (const id of routedIds) {
      sum += details[id]?.total_cost_usd ?? bySessionId.get(id)?.budget_used ?? 0;
    }
    return sum;
  }, [routedIds, details, bySessionId]);

  const workingMs = useMemo(() => {
    let total: number | null = null;
    for (const id of routedIds) {
      const ms = activeWorkingMs(activityBySession.get(id) ?? []);
      if (ms !== null) total = (total ?? 0) + ms;
    }
    return total;
  }, [routedIds, activityBySession]);

  if (!visible) return null;

  const last = summary?.last_decision ?? null;
  // DirectGateway's real id is "none-proxy" (display "None / Direct") —
  // NOT "direct"; the ROUTING.md table uses shorthand. Verified in
  // services/routing/proxy/direct.rs.
  const proxied = summary && summary.active_proxy_gateway.id !== "none-proxy";

  return (
    <div style={{ paddingBottom: 6 }}>
      {/* Header — mirrors the panel's SectionLabel rhythm. */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "10px 14px 7px" }}>
        <GitBranch size={10} style={{ color: "var(--c-ghost)", flexShrink: 0 }} />
        <span style={{
          fontSize: 10, fontWeight: 700, color: "var(--c-ghost)",
          letterSpacing: "0.08em", textTransform: "uppercase",
        }}>Router</span>
      </div>

      {summary?.enabled && (
        <InfoRow label="Router">
          {summary.active_decision_router.display_name} · active
          {proxied ? ` · via ${summary.active_proxy_gateway.display_name}` : ""}
        </InfoRow>
      )}

      {autoSessions.length > 0 && (
        <InfoRow label="Auto">
          {autoSessions.length} session{autoSessions.length === 1 ? "" : "s"}
        </InfoRow>
      )}

      {last ? (
        <InfoRow label="Last route">
          {last.model} · {last.source} · {agoLabel(last.ts)}
          {last.fallback_used && (
            <span style={{
              marginLeft: 6, padding: "0 5px", borderRadius: 4,
              fontSize: 9, fontWeight: 600, color: C_ORANGE,
              background: "rgba(251,146,60,0.12)",
            }}>fallback</span>
          )}
        </InfoRow>
      ) : summary?.enabled ? (
        <InfoRow label="Last route">no routing yet</InfoRow>
      ) : null}

      {decisions > 0 && summary && (
        <InfoRow label="Today">
          {decisions} decisions · {summary.totals_24h.fallbacks} fallbacks · avg {summary.totals_24h.avg_latency_ms} ms
        </InfoRow>
      )}

      {routedIds.size > 0 && (
        <InfoRow label="Spend">
          {fmtUsd(spend)} · {formatWorkingTime(workingMs)} working
        </InfoRow>
      )}
    </div>
  );
}
