/**
 * Minimal agent card — one open zone, generous breathing room.
 *
 * Collapsed (default):
 *
 *   ●  agent-name                                  $0.04
 *      editing src/api.ts · 3m
 *
 *      ▰▰▱▱▱▱▱▱▱▱
 *      12k of 200k context
 *
 * Expanded inline (click anywhere on card):
 *
 *   …above…
 *
 *      Recent
 *        edited  src/api.ts                  3m
 *        read    src/auth.ts                 5m
 *        ran     pytest                      8m
 *
 *      Memory
 *        API uses Bearer tokens
 *        Auth refresh on 401
 *
 *      [ Open chat ]               [ Stop ]
 *
 * No nested headers, no chips, no tabs. Each card is one card.
 */
import { useState, useMemo } from "react";
import { useChatStore } from "@/stores/chat-store";
import { stopSession, restartSession, type SessionDetail } from "@/lib/api";
import type { Session } from "@/types/session";
import { StatusDot, ContextRail, Sep, fmtCost, fmtTokens, relativeTime } from "./primitives";
import type { FleetActivityRow, FleetMemoryRow } from "./hooks/use-fleet-data";

interface Stats {
  message_count: number;
  total_cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  cache_tokens: number;
}

interface Props {
  session: Session;
  detail?: SessionDetail;
  stats?: Stats;
  agentActivity: FleetActivityRow[];
  agentMemory: FleetMemoryRow[];
  onOpenChat: (id: string) => void;
}

function ctxLimit(model: string | null | undefined): number | null {
  if (!model) return null;
  if (model.includes("claude")) return 200_000;
  if (model.includes("gpt-4")) return 128_000;
  return null;
}

function liveLineFor(
  isStreaming: boolean,
  isWaiting: boolean,
  permTool: string | undefined,
  recentSummary: string | undefined,
  status: string,
  lastAccessed: string | null,
): { text: string; tone: "live" | "wait" | "idle" } {
  if (isWaiting) {
    return { text: permTool ? `awaiting ${permTool}` : "awaiting input", tone: "wait" };
  }
  if (isStreaming) {
    return { text: recentSummary ?? "thinking…", tone: "live" };
  }
  if (status === "error") return { text: "error — needs restart", tone: "wait" };
  const ago = relativeTime(lastAccessed);
  return { text: ago ? `idle · ${ago}` : "idle", tone: "idle" };
}

export function FleetAgentCard({
  session, detail, stats, agentActivity, agentMemory, onOpenChat,
}: Props) {
  const [expanded, setExpanded] = useState(false);
  const [working, setWorking] = useState(false);

  const chatState = useChatStore(s => s.sessions[session.id]);
  const isStreaming = chatState?.isStreaming ?? false;
  const permReq = chatState?.permissionRequest ?? null;
  const isWaiting = session.status === "waiting" || permReq != null;
  const status = isWaiting ? "waiting" : session.status;

  const cost = stats?.total_cost_usd ?? 0;
  const limit = ctxLimit(detail?.model ?? session.model_name);
  const lastCtx = detail?.tokens.last_input ?? 0;

  const live = liveLineFor(
    isStreaming, isWaiting, permReq?.tool_name,
    agentActivity[0]?.summary, session.status,
    session.last_accessed,
  );

  const recent = useMemo(
    () => agentActivity.filter(a =>
      a.kind === "file_edit" || a.kind === "file_read" || a.kind === "command"
    ).slice(0, 5),
    [agentActivity],
  );

  const memory = useMemo(
    () => agentMemory.filter(m => m.kind !== "plan").slice(0, 4),
    [agentMemory],
  );

  const handleStop = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setWorking(true);
    try { await stopSession(session.id); } finally { setWorking(false); }
  };
  const handleRestart = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setWorking(true);
    try { await restartSession(session.id); } finally { setWorking(false); }
  };

  return (
    <div
      onClick={() => setExpanded(v => !v)}
      className="fp-card"
      style={{
        padding: "16px 18px",
        borderTop: "1px solid var(--c-brd)",
        cursor: "pointer",
        display: "flex", flexDirection: "column", gap: 12,
        animation: "fp-fade-in 0.15s ease-out",
      }}
    >
      {/* Title row — name + cost only */}
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <StatusDot status={status} />
        <span style={{
          flex: 1, minWidth: 0,
          fontSize: 13.5, fontWeight: 600,
          color: "var(--c-high)", letterSpacing: "-0.005em",
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>
          {session.title}
        </span>
        {cost > 0 && (
          <span style={{
            fontSize: 12, fontWeight: 500,
            color: "var(--c-low)",
            fontVariantNumeric: "tabular-nums",
          }}>
            {fmtCost(cost)}
          </span>
        )}
      </div>

      {/* Live line */}
      <div style={{
        fontSize: 11.5,
        color: live.tone === "wait" ? "#fb923c"
             : live.tone === "live" ? "var(--c-med)"
             : "var(--c-dim)",
        fontFamily: live.tone === "live" && !live.text.endsWith("…") ? "var(--font-mono)" : undefined,
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        lineHeight: 1.4,
        paddingLeft: 18, /* aligns under the title (8px dot + 10px gap) */
      }}>
        {live.text}
      </div>

      {/* Context — only shown when there's data */}
      {limit && lastCtx > 0 && (
        <div style={{ paddingLeft: 18, display: "flex", flexDirection: "column", gap: 6 }}>
          <ContextRail used={lastCtx} limit={limit} />
          <span style={{
            fontSize: 10.5, color: "var(--c-ghost)",
            fontVariantNumeric: "tabular-nums",
          }}>
            {fmtTokens(lastCtx)} of {fmtTokens(limit)} context
          </span>
        </div>
      )}

      {/* Expanded body */}
      {expanded && (
        <>
          {recent.length > 0 && (
            <Section label="Recent">
              {recent.map(a => (
                <div key={a.id} style={{
                  display: "flex", alignItems: "baseline", gap: 10,
                  fontSize: 11, lineHeight: 1.5,
                }}>
                  <span style={{
                    width: 50, flexShrink: 0,
                    color: "var(--c-ghost)",
                    fontFamily: "var(--font-mono)",
                  }}>
                    {verbFor(a.kind)}
                  </span>
                  <span style={{
                    flex: 1, minWidth: 0,
                    color: "var(--c-med)",
                    fontFamily: "var(--font-mono)",
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                  }}>
                    {a.summary}
                  </span>
                  <span style={{
                    flexShrink: 0, color: "var(--c-ghost)",
                    fontVariantNumeric: "tabular-nums", fontSize: 10.5,
                  }}>
                    {relativeTime(a.ts)}
                  </span>
                </div>
              ))}
            </Section>
          )}

          {memory.length > 0 && (
            <Section label="Memory">
              {memory.map(m => (
                <div key={m.id} style={{
                  fontSize: 11, lineHeight: 1.5, color: "var(--c-med)",
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                }}>
                  {m.title}
                </div>
              ))}
            </Section>
          )}

          {/* Inline meta — msgs, tokens — only here, never in collapsed view */}
          {(stats?.message_count || stats?.input_tokens) && (
            <div style={{
              display: "flex", alignItems: "center", gap: 8,
              fontSize: 10.5, color: "var(--c-ghost)",
              fontVariantNumeric: "tabular-nums",
              paddingLeft: 18,
            }}>
              <span>{stats?.message_count ?? 0} messages</span>
              <Sep />
              <span>{fmtTokens((stats?.input_tokens ?? 0) + (stats?.output_tokens ?? 0) + (stats?.cache_tokens ?? 0))} tokens</span>
            </div>
          )}

          {/* Actions */}
          <div style={{
            display: "flex", gap: 8, alignItems: "center",
            paddingLeft: 18,
          }}>
            <button
              onClick={(e) => { e.stopPropagation(); onOpenChat(session.id); }}
              style={primaryBtn()}
              onMouseEnter={(e) => { e.currentTarget.style.background = "var(--c-med)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "var(--c-high)"; }}
            >
              Open chat
            </button>
            {(session.status === "running" || session.status === "starting" || isStreaming) ? (
              <button onClick={handleStop} disabled={working} style={ghostBtn()}>
                Stop
              </button>
            ) : (
              <button onClick={handleRestart} disabled={working} style={ghostBtn()}>
                Restart
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{
      paddingLeft: 18,
      display: "flex", flexDirection: "column", gap: 6,
    }}>
      <span style={{
        fontSize: 10, fontWeight: 600, color: "var(--c-low)",
        textTransform: "uppercase", letterSpacing: "0.08em",
      }}>
        {label}
      </span>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {children}
      </div>
    </div>
  );
}

function verbFor(kind: string): string {
  switch (kind) {
    case "file_edit":  return "edited";
    case "file_read":  return "read";
    case "command":    return "ran";
    case "web_fetch":  return "fetched";
    case "todo":       return "task";
    case "plan":       return "planned";
    case "error":      return "error";
    default:           return kind;
  }
}

function primaryBtn(): React.CSSProperties {
  return {
    padding: "6px 14px", borderRadius: 6,
    border: "1px solid var(--c-high)", background: "var(--c-high)",
    color: "var(--card)",
    fontSize: 11, fontWeight: 600, cursor: "pointer",
    transition: "background 0.12s",
  };
}

function ghostBtn(): React.CSSProperties {
  return {
    padding: "6px 12px", borderRadius: 6,
    border: "1px solid var(--c-brd)", background: "transparent",
    color: "var(--c-low)",
    fontSize: 11, fontWeight: 500, cursor: "pointer",
    transition: "color 0.12s, border-color 0.12s",
  };
}
