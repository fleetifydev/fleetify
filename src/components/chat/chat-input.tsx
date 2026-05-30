import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import {
  Square, ChevronDown, Check,
  GitBranch, GitPullRequest, ArrowLeft,
  FolderOpen, Mic, X, FileText,
  Plus, Loader2, Copy,
  CornerDownLeft,
  GitMerge, AlertCircle, CheckCircle2, Circle,
  CircleSlash,
  ExternalLink,
  AlignLeft,
  Sparkles, Undo2, Wand2,
  ScanEye, Plug, RefreshCw, FolderTree,
} from "lucide-react";
import { truncateMid, folderName } from "@/lib/utils";
import { searchProjectFiles, apiFetch, type FileSearchEntry, updateSession as apiUpdateSession, fetchSessionDetail, enhancePrompt } from "@/lib/api";
import { useFleetStore, type FleetMode } from "@/stores/fleet-store";
import { LogoMark } from "@/components/brand/logo-mark";
import { wsManager } from "@/services/ws-manager";
import { FileMentionPopup } from "./file-mention-popup";
import { PRDialog } from "@/components/git/pr-dialog";
import { ReviewDialog } from "@/components/git/review-dialog";
import { AuthChoicePopover } from "@/components/git/auth-choice-popover";
import { BranchPickerMenu } from "@/components/git/branch-picker-menu";
import { RecoveryDialog } from "@/components/git/recovery-dialog";
import { PreflightDialog } from "@/components/git/preflight-dialog";
import type { PreflightIssue } from "@/lib/git-api";
import { git, type PRStatus, defaultPRTitle, defaultPRBody } from "@/lib/git-api";
import { github } from "@/lib/github-link-api";
import { glog } from "@/lib/git-log";
import { useAppStore } from "@/stores/app-store";
import { useChatStore, pushChatError } from "@/stores/chat-store";
import { COMPOSER_CHAT_KEY } from "@/stores/app-store";
import { useMCPStore } from "@/stores/mcp-store";
import { ProviderLogo } from "@/components/ui/provider-logo";
import { RoutingChip } from "@/components/settings/routers/routing-chip";
import { commandsForContext, type SlashCmdDef } from "@/lib/slash-commands";
import { useProvidersConfig } from "@/hooks/use-providers-config";
import { UnifiedModelPicker, type Effort as UMEffort } from "./unified-model-picker";
import { buildPickerGroups, resolveDispatchTool, resolveModelChip } from "@/lib/picker-groups";

/* ─────────────────── constants ─────────────────── */

interface ModelOption { id: string; label: string; ctx: string }

const CLAUDE_MODELS: ModelOption[] = [
  { id: "claude-opus-4-8",           label: "Opus 4.8",   ctx: "200K" },
  { id: "claude-sonnet-4-6",         label: "Sonnet 4.6", ctx: "200K" },
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5",  ctx: "200K" },
];
const GEMINI_MODELS: ModelOption[] = [
  { id: "gemini-3.1-pro-preview",        label: "3.1 Pro",  ctx: "1M" },
  { id: "gemini-3-flash-preview",        label: "3 Flash",  ctx: "1M" },
  { id: "gemini-3.1-flash-lite-preview", label: "3.1 Lite", ctx: "1M" },
];
// Codex (gpt-5.x) — keep parity with the New Agent dialog options.
const CODEX_MODELS: ModelOption[] = [
  { id: "gpt-5.2", label: "GPT-5.2", ctx: "200K" },
  { id: "gpt-5.4", label: "GPT-5.4", ctx: "200K" },
  { id: "gpt-5.5", label: "GPT-5.5", ctx: "200K" },
];
// Antigravity print mode pins to the user's server-side model selection
// (set via the TUI's `/model` slash command and persisted by agy's
// backend). No local override surface exists — see `picker-groups.ts`
// for the long list of vectors we tested. Single "Auto" entry until
// PTY-driven dispatch lands and we can run `/model <id>` per turn.
const AGY_MODELS: ModelOption[] = [
  { id: "agy-default", label: "Auto", ctx: "1M" },
];
// Antigravity SDK exposes full per-(model × effort) selection because
// `LocalAgentConfig(model=...)` accepts the id at construction. List
// mirrors agy's `/model` TUI output verbatim.
const AGY_SDK_MODELS: ModelOption[] = [
  { id: "gemini-3.5-flash-medium",     label: "Gemini 3.5 Flash (Medium)",   ctx: "1M"   },
  { id: "gemini-3.5-flash-high",       label: "Gemini 3.5 Flash (High)",     ctx: "1M"   },
  { id: "gemini-3.1-pro-low",          label: "Gemini 3.1 Pro (Low)",        ctx: "1M"   },
  { id: "gemini-3.1-pro-high",         label: "Gemini 3.1 Pro (High)",       ctx: "1M"   },
  { id: "claude-sonnet-4-6-thinking",  label: "Claude Sonnet 4.6 (Thinking)", ctx: "200K" },
  { id: "claude-opus-4-6-thinking",    label: "Claude Opus 4.6 (Thinking)",   ctx: "200K" },
  { id: "gpt-oss-120b-medium",         label: "GPT-OSS 120B (Medium)",        ctx: "128K" },
];
const OPENAI_MODELS: ModelOption[] = [
  { id: "gpt-4o",      label: "GPT-4o",  ctx: "128K" },
  { id: "gpt-4o-mini", label: "4o mini", ctx: "128K" },
  { id: "o3",          label: "o3",      ctx: "200K" },
];

function modelsFor(tool: string | null | undefined): ModelOption[] {
  if (tool === "gemini") return GEMINI_MODELS;
  if (tool === "codex")  return CODEX_MODELS;
  if (tool === "agy")    return AGY_MODELS;
  if (tool === "antigravity-sdk") return AGY_SDK_MODELS;
  if (tool === "openai") return OPENAI_MODELS;
  return CLAUDE_MODELS;
}


type Effort = "low" | "medium" | "high" | "extra_high" | "max";
const EFFORTS: { id: Effort; label: string }[] = [
  { id: "low",        label: "Low"        },
  { id: "medium",     label: "Medium"     },
  { id: "high",       label: "High"       },
  { id: "extra_high", label: "Extra high" },
  { id: "max",        label: "Max"        },
];


// Built-in slash commands now come from the provider-aware registry in
// `@/lib/slash-commands`. The registry returns fleet-domain commands plus the
// session-domain commands native to the current provider (so a Gemini session
// sees `/compress` instead of `/compact`, etc.). Plugin-contributed commands
// are still merged in via `slashAll`; on `cmd` collisions plugins win.

function fmtModel(id: string | null | undefined, tool?: string | null): string {
  // Look up the label from the provider's model list first.
  const list = modelsFor(tool);
  const exact = list.find(m => m.id === id);
  if (exact) return exact.label;
  // For codex, fall back to the dialog default rather than the legacy GPT-4o.
  if (!id) {
    if (tool === "codex") return "GPT-5.4";
    if (tool === "agy") return "Auto";
    if (tool === "antigravity-sdk") return "Gemini 3.5 Flash (Medium)";
    return list[0]?.label ?? "Model";
  }
  // Fallback: best-effort label inference from the id substring.
  const m = id.toLowerCase();
  if (m.includes("opus"))    return "Opus 4.8";
  if (m.includes("sonnet"))  return "Sonnet 4.6";
  if (m.includes("haiku"))   return "Haiku 4.5";
  if (m.includes("3.1-pro")) return "3.1 Pro";
  if (m.includes("3-flash")) return "3 Flash";
  if (m.includes("3.1-flash-lite")) return "3.1 Lite";
  if (m.startsWith("gpt-5.")) return `GPT-${id.slice(4)}`;  // gpt-5.2 → GPT-5.2
  return id;
}

const EFFORT_SHORT: Record<Effort, string> = {
  low: "Low", medium: "Med", high: "High", extra_high: "X-Hi", max: "Max",
};

/* ─────────────────── tiny components ─────────────────── */

/** Circular context-window usage indicator.
 *
 * Always renders. Color crosses three thresholds:
 *   pct ≥ 0.85  → red     (almost full, urgent)
 *   pct ≥ 0.65  → orange  (filling fast, watch)
 *   pct  < 0.65 → blue    (plenty of room, nominal)
 *
 * The low-usage state is BLUE (#3b82f6) instead of grey so the empty
 * ring is clearly a context indicator, not a faded spinner. Empty
 * track sits at rgba(fg, 0.14) — visible enough to communicate the
 * full circumference even when nothing's filled yet. */
function ContextArc({ pct, size = 13 }: { pct: number; size?: number }) {
  // Stroke scales with size so a small ring still reads as a
  // status indicator (not a hairline). Track alpha 0.22 makes
  // the empty ring legible against dark surfaces — at 0.18 it
  // was almost invisible, so the fill arc looked like it was
  // floating on nothing. Fill arc clamps to a 4% minimum so
  // even a fresh-session 0.5% shows a real sliver.
  const stroke = Math.max(2, size * 0.18);
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const safe = Math.max(0, Math.min(pct, 1));
  const visible = safe > 0 ? Math.max(safe, 0.04) : 0;
  const offset = circ * (1 - visible);
  // Match the popover bar: vibrant blue at low fills so the arc
  // POPS rather than reads as a thin hairline of white.
  const fillColor = safe > 0.85 ? "#f87171"
                 : safe > 0.65 ? "#fb923c"
                 : "#60a5fa";
  const pctLabel = Math.round(safe * 100);
  return (
    <svg
      width={size} height={size}
      style={{ transform: "rotate(-90deg)", flexShrink: 0 }}
      aria-label={`Context ${pctLabel}%`}
    >
      <title>{`Context ${pctLabel}% used`}</title>
      <circle cx={size / 2} cy={size / 2} r={r}
        stroke="rgba(var(--fg-rgb),0.22)" strokeWidth={stroke} fill="none" />
      {safe > 0 && (
        <circle cx={size / 2} cy={size / 2} r={r}
          stroke={fillColor} strokeWidth={stroke} fill="none"
          strokeDasharray={circ} strokeDashoffset={offset}
          strokeLinecap="round"
          style={{ transition: "stroke-dashoffset 0.5s, stroke 0.3s" }}
        />
      )}
    </svg>
  );
}

/** Format a token count compactly: 262_900 → "262.9k", 1_000_000 → "1.0M" */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** Format a duration in seconds into a compact "1h 23m" / "2m 14s" string. */
function fmtDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/** ContextArcPopover — wraps ContextArc with a click-to-expand
 *  popover that shows BOTH the current context-window fill AND
 *  the cumulative session usage. The closed state is just the
 *  small ring next to the model button.
 *
 *  Layout (matches the user's reference but adapted to what we
 *  actually track):
 *
 *    Context window       262.9k / 1.0M  (26%)
 *    [████████░░░░░░░░░░░░░░░░░░░░░░]
 *
 *    Session usage              ─────────────
 *    Input  12.4k    [████████░░░░░░░░░░]
 *    Output  3.2k    [██░░░░░░░░░░░░░░░░]
 *    Cache   8.1k    [████░░░░░░░░░░░░░░]
 *
 *    ─────────────────────────────────────
 *    Turns   5            Cost   $0.03
 *    Active  2m 14s
 */
function ContextArcPopover({
  sessionId, max, fallbackPct, fallbackUsed, fallbackUsage,
}: {
  sessionId?: string | null;
  /** Model's max context window. Caller derives this from the
   *  session.model_name (200K vs 1M for wide-context variants). */
  max?: number;
  /** Live fallbacks for the closed-state arc — when the popover
   *  hasn't fetched yet OR the user is mid-stream and we want
   *  the ring to reflect in-flight tokens. Computed from the
   *  in-store messages array by chat-view. */
  fallbackPct: number;
  fallbackUsed?: number;
  fallbackUsage?: ChatInputProps["sessionUsage"];
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Backend-aggregated session detail. Fetched on first open, then
  // re-polled every 8s while the popover stays open. The
  // messages-array fallback (computed by chat-view) keeps rendering
  // until the API resolves AND covers the case where backend is
  // unreachable.
  const [detail, setDetail] = useState<{
    input: number; output: number; cache_read: number; cache_write: number;
    last_input: number; last_cache_read: number;
    cost: number; turns: number; createdAt?: string;
  } | null>(null);

  // Re-render every 30s while open so the "Active 2m 14s" duration
  // ticks up live instead of freezing at the open-time snapshot.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!open) return;
    const iv = setInterval(() => setTick(n => n + 1), 30_000);
    return () => clearInterval(iv);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Backend fetch — runs CONTINUOUSLY in the background (not just
  // when the popover is open) so the closed-state ring fills as
  // the conversation progresses. Re-polls every 8s; the backend's
  // /sessions/:id/detail endpoint reads usage_json off every
  // persisted message so this is authoritative even after a page
  // reload (where the in-store messages array might have dropped
  // its usage attachments). When the popover IS open we tighten
  // the cadence to 3s so the user sees fresh numbers while
  // they're looking at them.
  useEffect(() => {
    if (!sessionId) return;
    // Local-only (compose-phase) sessions live in the renderer only —
    // the backend has no row for them yet, so /detail would 404 on
    // every poll until commitDraft swaps in the real backend row.
    // The fallback usage numbers below cover the compose window.
    const session = useAppStore.getState().sessions.find(s => s.id === sessionId);
    if (session?.local_only) return;
    let cancelled = false;
    const load = () => {
      fetchSessionDetail(sessionId).then(d => {
        if (cancelled) return;
        setDetail({
          input: d.tokens.input,
          output: d.tokens.output,
          cache_read: d.tokens.cache_read,
          cache_write: d.tokens.cache_write,
          last_input: d.tokens.last_input,
          last_cache_read: d.tokens.last_cache_read,
          cost: d.total_cost_usd ?? 0,
          // Prefer assistant_turns (counts only assistant replies);
          // fall back to message_count for older backends that
          // haven't been updated yet.
          turns: d.assistant_turns ?? d.message_count,
          createdAt: d.created_at ?? undefined,
        });
      }).catch(() => { /* swallow — fallback values keep rendering */ });
    };
    load();
    const iv = setInterval(load, open ? 3_000 : 8_000);
    return () => { cancelled = true; clearInterval(iv); };
  }, [open, sessionId]);

  // Pick the authoritative source for each value: backend detail
  // when it has resolved, otherwise the in-store fallback.
  const inputTotal      = detail?.input          ?? fallbackUsage?.inputTotal      ?? 0;
  const outputTotal     = detail?.output         ?? fallbackUsage?.outputTotal     ?? 0;
  const cacheReadTotal  = detail?.cache_read     ?? fallbackUsage?.cacheReadTotal  ?? 0;
  const cacheWriteTotal = detail?.cache_write    ?? fallbackUsage?.cacheWriteTotal ?? 0;
  const turns           = detail?.turns          ?? fallbackUsage?.turns           ?? 0;
  const costUsd         = detail?.cost           ?? fallbackUsage?.costUsd;
  const startedAt       = detail?.createdAt      ?? fallbackUsage?.startedAt;

  // Last assistant turn's "what the model saw" — backend gives it
  // directly via tokens.last_input + tokens.last_cache_read; the
  // fallback uses the message-array derivation chat-view passes.
  const lastInputView = detail
    ? detail.last_input + detail.last_cache_read
    : (fallbackUsed ?? 0);
  const pct = max && max > 0 ? lastInputView / max : fallbackPct;

  const safe = Math.max(0, Math.min(pct, 1));
  const pctLabel = Math.round(safe * 100);
  // Vibrant accent at low fills — white fill on a dark popover
  // surface kept reading as "empty" to the user even when the
  // bar was correctly at 45%. Using a saturated blue (matches
  // the Cache bar below) makes the fill UNMISTAKABLE — any
  // colored fill on a grey track screams "progress" the way a
  // white-on-grey hairline never could. Threshold colors stay
  // for the warning bands.
  const barColor = safe > 0.85 ? "#f87171"
                : safe > 0.65 ? "#fb923c"
                : "#60a5fa";

  const cacheTotal = cacheReadTotal + cacheWriteTotal;
  const sessionMax = Math.max(1, inputTotal, outputTotal, cacheTotal);
  const cacheHitRate = (inputTotal + cacheTotal) > 0
    ? cacheTotal / (inputTotal + cacheTotal)
    : 0;
  const hasUsage = inputTotal + outputTotal + cacheTotal > 0;
  const activeSeconds = startedAt
    ? Math.max(0, (Date.now() - Date.parse(startedAt)) / 1000)
    : 0;

  return (
    <div ref={wrapRef} style={{ position: "relative", flexShrink: 0 }}>
      <button
        onClick={() => setOpen(o => !o)}
        onMouseDown={e => e.preventDefault()}
        title={`Context ${pctLabel}% · ${turns} turns`}
        style={{
          width: 22, height: 22, padding: 0,
          background: "transparent", border: "none", outline: "none",
          cursor: "pointer",
          display: "inline-flex", alignItems: "center", justifyContent: "center",
        }}
      >
        <ContextArc pct={pct} size={13} />
      </button>
      {open && (
        <div style={{
          // Anchored to the RIGHT (arc lives in the right cluster
          // beside the model button); right:0 keeps the popover
          // from extending past the chat-input edge.
          position: "absolute", bottom: "calc(100% + 8px)", right: 0,
          width: 280,
          background: "var(--popover, #161616)",
          border: "1px solid var(--c-brd, rgba(255,255,255,0.08))",
          borderRadius: 9,
          padding: 0,
          boxShadow: "0 -10px 28px rgba(0,0,0,0.42)",
          zIndex: 80,
          fontFamily: "var(--font-sans)",
          animation: "fleet-popover-up 0.14s ease-out both",
          overflow: "hidden",
        }}>
          {/* HEADER — single tight row with context fill + bar */}
          <div style={{ padding: "10px 12px 9px" }}>
            <div style={{
              display: "flex", alignItems: "center", justifyContent: "space-between",
              gap: 8, marginBottom: 6,
            }}>
              <span style={{
                fontSize: 11.5, fontWeight: 500, color: "var(--c-fg)",
              }}>Context window</span>
              <span style={{
                fontSize: 10.5, color: "var(--c-dim)",
                fontFamily: "var(--font-mono)",
                fontVariantNumeric: "tabular-nums",
              }}>
                {max
                  ? <>{fmtTokens(lastInputView)} / {fmtTokens(max)} <span style={{
                      color: barColor, marginLeft: 2, fontWeight: 500,
                    }}>{pctLabel}%</span></>
                  : "—"
                }
              </span>
            </div>
            <ProgressBar fill={safe} color={barColor} height={8} />
          </div>

          {/* SESSION USAGE — three compact lanes */}
          {hasUsage && (
            <div style={{
              padding: "9px 12px 4px",
              borderTop: "1px solid var(--c-brd, rgba(255,255,255,0.06))",
            }}>
              <div style={{
                display: "flex", alignItems: "center", justifyContent: "space-between",
                marginBottom: 6,
              }}>
                <span style={{
                  fontSize: 11.5, fontWeight: 500, color: "var(--c-fg)",
                }}>Session usage</span>
                {cacheHitRate > 0 && (
                  <span style={{
                    fontSize: 10, color: "var(--c-dim)",
                    fontFamily: "var(--font-mono)",
                    fontVariantNumeric: "tabular-nums",
                  }}>
                    {Math.round(cacheHitRate * 100)}% cache
                  </span>
                )}
              </div>

              <CompactUsageRow
                label="Input"
                value={inputTotal}
                fill={inputTotal / sessionMax}
                color="var(--c-fg)"
              />
              <CompactUsageRow
                label="Output"
                value={outputTotal}
                fill={outputTotal / sessionMax}
                color="#4ade80"
              />
              <CompactUsageRow
                label="Cache"
                value={cacheTotal}
                fill={cacheTotal / sessionMax}
                color="#60a5fa"
              />
            </div>
          )}

          {/* FOOTER — turns · cost · duration */}
          <div style={{
            padding: "8px 12px 9px",
            background: "rgba(var(--fg-rgb), 0.025)",
            borderTop: "1px solid var(--c-brd, rgba(255,255,255,0.06))",
            display: "flex", alignItems: "center",
          }}>
            <FooterStat label="Turns" value={String(turns)} />
            <FooterDot />
            <FooterStat
              label="Cost"
              value={costUsd != null && costUsd > 0
                ? (costUsd >= 1 ? `$${costUsd.toFixed(2)}` : `$${costUsd.toFixed(4)}`)
                : "—"}
            />
            <FooterDot />
            <FooterStat
              label="Active"
              value={startedAt ? fmtDuration(activeSeconds) : "—"}
            />
          </div>
        </div>
      )}
    </div>
  );
}

/** MCPStatusButton — compact composer indicator showing how many MCP
 *  servers are connected, with a click-to-expand popover that lists
 *  each one and its probe status. Sits in the right cluster to the
 *  LEFT of ContextArcPopover so the two live-system-state indicators
 *  cluster together (tools vs. tokens). Subscribes to useMCPStore so
 *  status updates while the popover is closed land for free; the
 *  popover triggers a probe-all refresh on open and via its button.
 */
function MCPStatusButton() {
  const servers = useMCPStore((s) => s.servers);
  const fetchAll = useMCPStore((s) => s.fetchAll);
  const refresh = useMCPStore((s) => s.refresh);
  const refreshing = useMCPStore((s) => s.refreshing);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Lazy-load on first mount if the store is empty (settings page is
  // the usual prefetcher, but the composer renders before settings).
  useEffect(() => {
    if (servers.length === 0) {
      void fetchAll();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Click-outside close
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  // Roll the per-server status into one overall colour for the badge.
  // failed > auth_needed > checking > all-connected. Empty store
  // collapses to a neutral grey so the icon doesn't shout when there's
  // nothing configured.
  const connectedCount = servers.filter((s) => s.status?.status === "connected").length;
  const hasFailed = servers.some((s) => s.status?.status === "failed");
  const hasAuthNeeded = servers.some((s) => s.status?.status === "auth_needed");
  const allConnected = servers.length > 0 && connectedCount === servers.length;
  const dotColor = servers.length === 0
    ? "var(--c-low)"
    : hasFailed ? "#ef4444"
    : hasAuthNeeded ? "#eab308"
    : allConnected ? "#22c55e"
    : "#3b82f6";

  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={`MCP — ${connectedCount}/${servers.length} connected`}
        style={{
          display: "flex", alignItems: "center", gap: 4,
          padding: "3px 7px", borderRadius: 6,
          background: "transparent", border: "1px solid var(--border)",
          color: "var(--c-low)", fontSize: 10.5, fontWeight: 500,
          cursor: "pointer",
        }}
      >
        <span style={{ width: 6, height: 6, borderRadius: "50%", background: dotColor }} />
        <Plug size={10} strokeWidth={2} />
        <span>{connectedCount}/{servers.length}</span>
      </button>
      {open && (
        <div style={{
          position: "absolute", bottom: "calc(100% + 6px)", right: 0,
          minWidth: 280, maxWidth: 360,
          background: "var(--card)", border: "1px solid var(--border)",
          borderRadius: 10, padding: "10px 12px",
          boxShadow: "0 8px 24px rgba(0,0,0,0.15)", zIndex: 50,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
            <Plug size={12} style={{ color: dotColor }} />
            <span style={{ fontSize: 12, fontWeight: 600, color: "var(--foreground)" }}>MCP servers</span>
            <span style={{ fontSize: 10, color: "var(--muted-foreground)", marginLeft: "auto" }}>
              {connectedCount}/{servers.length} connected
            </span>
          </div>
          {servers.length === 0 ? (
            <div style={{ fontSize: 11, color: "var(--muted-foreground)", padding: "8px 0", fontStyle: "italic" }}>
              No MCP servers configured. Add some in Settings.
            </div>
          ) : (
            <div style={{ maxHeight: 240, overflowY: "auto", marginBottom: 8 }}>
              {servers.map((s) => {
                const st = s.status?.status ?? "checking";
                const color = st === "connected" ? "#22c55e"
                  : st === "auth_needed" ? "#eab308"
                  : st === "failed" ? "#ef4444"
                  : "#3b82f6";
                return (
                  <div key={s.name} style={{
                    display: "flex", alignItems: "center", gap: 6,
                    padding: "5px 0",
                    borderBottom: "1px solid var(--border)",
                  }}>
                    <span style={{ width: 6, height: 6, borderRadius: "50%", background: color, flexShrink: 0 }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 11, fontWeight: 500, color: "var(--foreground)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {s.name}
                      </div>
                      <div style={{ fontSize: 10, color: "var(--muted-foreground)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {st === "failed" && s.status?.error
                          ? s.status.error
                          : st === "auth_needed"
                            ? (s.status?.auth_hint ?? "needs authentication")
                            : `${s.status?.tool_count ?? 0} tools`}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          <button
            type="button"
            onClick={() => { void refresh(); }}
            disabled={refreshing}
            style={{
              display: "flex", alignItems: "center", gap: 4,
              padding: "4px 8px", borderRadius: 6,
              border: "1px solid var(--border)", background: "transparent",
              color: "var(--muted-foreground)", fontSize: 10.5,
              cursor: refreshing ? "wait" : "pointer",
              opacity: refreshing ? 0.6 : 1,
            }}
          >
            <RefreshCw size={10} style={{ animation: refreshing ? "spin 1s linear infinite" : undefined }} />
            {refreshing ? "Probing…" : "Probe all"}
          </button>
        </div>
      )}
    </div>
  );
}

/** Single tight row in the Session usage section: label + bar +
 *  value all on ONE line so the popover stays dense. */
function CompactUsageRow({ label, value, fill, color }: {
  label: string; value: number; fill: number; color: string;
}) {
  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "44px 1fr 44px",
      alignItems: "center",
      gap: 8,
      marginBottom: 6,
    }}>
      <span style={{
        fontSize: 11, color: "var(--c-low)",
      }}>{label}</span>
      <ProgressBar fill={fill} color={color} height={5} />
      <span style={{
        fontSize: 10.5, color: "var(--c-fg)",
        fontFamily: "var(--font-mono)",
        fontVariantNumeric: "tabular-nums",
        textAlign: "right",
      }}>{fmtTokens(value)}</span>
    </div>
  );
}

/** Vertical dot divider between footer stats. */
function FooterDot() {
  return (
    <span aria-hidden style={{
      width: 2, height: 2, borderRadius: 999,
      background: "var(--c-dim)",
      margin: "0 9px",
      flexShrink: 0, opacity: 0.5,
    }} />
  );
}

/** Reusable progress bar. The track is intentionally a clear,
 *  visible chip — at low alpha the bar reads as "fill on nothing"
 *  rather than "fill inside a container". The user explicitly
 *  called this out: even at 45% the bar looked empty because the
 *  unfilled portion blended into the popover surface.
 *
 *  We now lift the track to 0.18 alpha + a 1-px inset border so
 *  the bar reads as an actual container that fills up. The fill
 *  color stays as the caller passes it (theme-driven white at low
 *  fills, warm/red at thresholds). */
function ProgressBar({ fill, color, height = 7 }: {
  fill: number; color: string; height?: number;
}) {
  const safe = Math.max(0, Math.min(fill, 1));
  return (
    <div style={{
      position: "relative",
      width: "100%", height, borderRadius: 999,
      background: "rgba(var(--fg-rgb), 0.18)",
      // Inset shadow gives the track a hint of depth so the
      // empty section reads as recessed, not flat.
      boxShadow: "inset 0 0 0 1px rgba(var(--fg-rgb), 0.04)",
      overflow: "hidden",
    }}>
      <div style={{
        position: "absolute", top: 0, left: 0, bottom: 0,
        width: `${safe * 100}%`,
        background: color,
        borderRadius: 999,
        transition: "width 0.4s ease-out, background 0.3s",
      }} />
    </div>
  );
}

// (UsageRow removed — replaced by CompactUsageRow above. The
// two-line layout was too tall when stacked 3x and made the
// popover read as "padded" rather than dense.)

/** Footer stat tile — uppercase eyebrow label + mono value
 *  stacked. Three of these fit on a 280px popover. */
function FooterStat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{
      flex: 1, minWidth: 0,
      display: "flex", flexDirection: "column", gap: 1,
    }}>
      <span style={{
        fontSize: 8.5, color: "var(--c-dim)",
        textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 600,
      }}>{label}</span>
      <span style={{
        fontSize: 11, color: "var(--c-fg)", fontWeight: 500,
        fontFamily: "var(--font-mono)",
        fontVariantNumeric: "tabular-nums",
        whiteSpace: "nowrap",
        overflow: "hidden", textOverflow: "ellipsis",
      }}>{value}</span>
    </div>
  );
}

/** Keyboard shortcut badge */
function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", justifyContent: "center",
      minWidth: 16, height: 16, padding: "0 3px", borderRadius: 3,
      background: "rgba(var(--fg-rgb),0.06)", border: "1px solid rgba(var(--fg-rgb),0.09)",
      fontSize: 9.5, color: "var(--c-dim)", fontFamily: "inherit",
    }}>{children}</span>
  );
}

/** Toolbar icon button — compact 22×22, ghosted at rest, lifts on
 *  hover. Sized down from 26×26 so the toolbar reads as one tight
 *  control row rather than spaced affordances. */
function ToolBtn({ children, title, onClick }: {
  children: React.ReactNode; title?: string; onClick?: () => void;
}) {
  return (
    <button onClick={onClick} title={title} onMouseDown={e => e.preventDefault()} style={{
      width: 22, height: 22, borderRadius: 5, flexShrink: 0,
      display: "flex", alignItems: "center", justifyContent: "center",
      background: "none", border: "none", outline: "none", cursor: "pointer",
      // Refined: ghost icons at rest, no chunky bg/border on hover.
      // Just a subtle color shift up to high. Reads as deliberate
      // status-bar affordances, not chunky toolbar buttons.
      color: "var(--c-low)",
      transition: "color 0.12s",
    }}
      onMouseEnter={e => { e.currentTarget.style.color = "var(--c-high)"; }}
      onMouseLeave={e => { e.currentTarget.style.color = "var(--c-low)"; }}
    >{children}</button>
  );
}

/** Mic button with a device picker. The user wanted the mic icon
 *  to open a small menu listing the system's input devices so they
 *  can choose which mic the dictation flow will use, rather than
 *  the icon being a no-op affordance. We persist the selected
 *  deviceId in localStorage so it sticks across sessions. */
function MicButton() {
  const [open, setOpen] = useState(false);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selected, setSelected] = useState<string | null>(() => {
    try { return localStorage.getItem("fleet.mic.deviceId"); } catch { return null; }
  });
  const [needsPerm, setNeedsPerm] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Lazy-load the device list when the menu opens. We only ask for
  // permission if the labels come back empty (browsers redact them
  // until the page has at least once been granted mic access).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        const list = await navigator.mediaDevices.enumerateDevices();
        if (cancelled) return;
        const mics = list.filter(d => d.kind === "audioinput");
        setDevices(mics);
        // If we got a list but every label is empty, the browser
        // wants the user to grant permission first.
        setNeedsPerm(mics.length > 0 && mics.every(d => !d.label));
      } catch {
        if (!cancelled) setDevices([]);
      }
    })();
    return () => { cancelled = true; };
  }, [open]);

  // Outside-click closes the popover.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const requestPermission = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // Stop tracks immediately — we only needed permission, not a stream.
      stream.getTracks().forEach(t => t.stop());
      const list = await navigator.mediaDevices.enumerateDevices();
      const mics = list.filter(d => d.kind === "audioinput");
      setDevices(mics);
      setNeedsPerm(false);
    } catch {
      // Permission denied — leave the prompt up.
    }
  };

  const pick = (id: string) => {
    setSelected(id);
    try { localStorage.setItem("fleet.mic.deviceId", id); } catch { /* ignore */ }
    setOpen(false);
  };

  return (
    <div ref={wrapRef} style={{
      position: "relative", flexShrink: 0,
      // Mic icon + dropdown chevron sit GLUED together as a split
      // button — the user wanted the "voice toggle" right next to
      // the mic, not floating off as a separate "More actions"
      // button. -2px gap brings them visually adjacent without
      // overlapping at hover state.
      display: "inline-flex", alignItems: "center",
      gap: -2,
    }}>
      <ToolBtn title="Voice input" onClick={() => setOpen(o => !o)}>
        <Mic size={12} />
      </ToolBtn>
      <button
        onClick={() => setOpen(o => !o)}
        onMouseDown={e => e.preventDefault()}
        title="Choose input device"
        style={{
          width: 14, height: 22, padding: 0, marginLeft: -2,
          background: "none", border: "none", outline: "none",
          color: "var(--c-low)",
          cursor: "pointer",
          display: "inline-flex", alignItems: "center", justifyContent: "center",
          flexShrink: 0,
          transition: "color 0.12s",
        }}
        onMouseEnter={e => { e.currentTarget.style.color = "var(--c-high)"; }}
        onMouseLeave={e => { e.currentTarget.style.color = "var(--c-low)"; }}
      >
        <ChevronDown size={9} strokeWidth={2.25} style={{
          transform: open ? "rotate(180deg)" : "none",
          transition: "transform 0.15s",
        }} />
      </button>
      {open && (
        <div style={{
          position: "absolute", bottom: "calc(100% + 6px)", left: 0,
          minWidth: 220, maxWidth: 280,
          background: "var(--popover, #161616)",
          border: "1px solid var(--c-brd, rgba(255,255,255,0.08))",
          borderRadius: 8,
          padding: 4,
          boxShadow: "0 -8px 28px rgba(0,0,0,0.42)",
          zIndex: 60,
          fontFamily: "var(--font-sans)",
          animation: "fleet-popover-up 0.14s ease-out both",
        }}>
          <div style={{
            padding: "4px 8px 6px",
            fontSize: 9.5, fontWeight: 600,
            letterSpacing: 0.6, textTransform: "uppercase",
            color: "var(--c-dim)",
          }}>Input device</div>
          {needsPerm && (
            <button
              onClick={requestPermission}
              onMouseDown={e => e.preventDefault()}
              style={{
                width: "100%", textAlign: "left",
                padding: "6px 8px",
                background: "transparent", border: "none", outline: "none",
                color: "var(--c-fg)", fontSize: 12, cursor: "pointer",
                borderRadius: 5, fontFamily: "inherit",
              }}
              onMouseEnter={e => { e.currentTarget.style.background = "var(--c-srf)"; }}
              onMouseLeave={e => { e.currentTarget.style.background = "transparent"; }}
            >
              Grant microphone access…
            </button>
          )}
          {!needsPerm && devices.length === 0 && (
            <div style={{ padding: "8px 10px", fontSize: 11.5, color: "var(--c-dim)" }}>
              No input devices found.
            </div>
          )}
          {!needsPerm && devices.map(d => {
            const active = (selected ?? devices[0]?.deviceId) === d.deviceId;
            return (
              <button
                key={d.deviceId}
                onClick={() => pick(d.deviceId)}
                onMouseDown={e => e.preventDefault()}
                style={{
                  width: "100%", textAlign: "left",
                  display: "flex", alignItems: "center", gap: 7,
                  padding: "5px 8px",
                  background: "transparent", border: "none", outline: "none",
                  color: "var(--c-fg)",
                  cursor: "pointer", borderRadius: 5,
                  fontFamily: "inherit",
                }}
                onMouseEnter={e => { e.currentTarget.style.background = "var(--c-srf)"; }}
                onMouseLeave={e => { e.currentTarget.style.background = "transparent"; }}
              >
                {active
                  ? <Check size={11} strokeWidth={2.5} style={{ color: "var(--c-fg)", flexShrink: 0 }} />
                  : <span style={{ width: 11, flexShrink: 0 }} />
                }
                <span style={{
                  flex: 1, fontSize: 11.5,
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                }}>{d.label || `Microphone ${d.deviceId.slice(0, 6)}`}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Transcript view button + popover — sits in the chat-input
 *  toolbar to the LEFT of the Mic button. Mirrors Claude Code's
 *  reference popover (the user wanted SAME feature):
 *
 *    ┌──────────────────────────────────┐
 *    │  Transcript view         [^] [○] │
 *    │  Normal                          │
 *    │  Thinking                        │
 *    │  Verbose                       ✓ │
 *    │  Summary                         │
 *    │  ─────────────────               │
 *    │  [Aa]   [Aa]   [Aa]              │
 *    └──────────────────────────────────┘
 *
 *  Mode + font scale persist via app-store actions which write to
 *  localStorage. Application of the modes lives in the message
 *  renderer (filters thinking / tool blocks etc.); font scale
 *  applies via a CSS variable on the chat surface.
 */
function TranscriptViewButton() {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const view  = useAppStore(s => s.transcriptView);
  const scale = useAppStore(s => s.transcriptFontScale);
  const setView  = useAppStore(s => s.setTranscriptView);
  const setScale = useAppStore(s => s.setTranscriptFontScale);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const modes: { id: typeof view; label: string }[] = [
    { id: "normal",   label: "Normal"   },
    { id: "thinking", label: "Thinking" },
    { id: "verbose",  label: "Verbose"  },
    { id: "summary",  label: "Summary"  },
  ];
  const scales = [0.875, 1, 1.125];

  return (
    <div ref={wrapRef} style={{ position: "relative", flexShrink: 0 }}>
      <ToolBtn
        title="Transcript view"
        onClick={() => setOpen(o => !o)}
      >
        {/* AlignLeft reads as "lines of text" — much closer to
            the reference's transcript glyph than the Notebook
            icon, which felt journal-y. */}
        <AlignLeft size={12} strokeWidth={1.75} />
      </ToolBtn>
      {open && (
        <div style={{
          position: "absolute", bottom: "calc(100% + 6px)", left: 0,
          width: 200,
          background: "var(--popover, #161616)",
          border: "1px solid var(--c-brd, rgba(255,255,255,0.08))",
          borderRadius: 8,
          padding: 4,
          boxShadow: "0 -8px 28px rgba(0,0,0,0.42)",
          zIndex: 60,
          fontFamily: "var(--font-sans)",
          animation: "fleet-popover-up 0.14s ease-out both",
        }}>
          {/* Compact eyebrow — matches the menu chrome elsewhere
              in Fleet (model picker, permission picker). */}
          <div style={{
            display: "flex", alignItems: "center", justifyContent: "space-between",
            padding: "4px 7px 5px",
          }}>
            <span style={{
              fontSize: 9.5, color: "var(--c-dim)", fontWeight: 600,
              letterSpacing: 0.6, textTransform: "uppercase",
            }}>Transcript view</span>
            <div style={{ display: "flex", gap: 2 }}>
              <Kbd>⇧</Kbd><Kbd>T</Kbd>
            </div>
          </div>

          {/* Mode rows — tighter padding, smaller font to match
              the model / permission pickers. */}
          {modes.map(m => {
            const active = view === m.id;
            return (
              <button
                key={m.id}
                onClick={() => { setView(m.id); setOpen(false); }}
                onMouseDown={(e) => e.preventDefault()}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "space-between",
                  width: "100%", padding: "4px 8px",
                  background: active ? "var(--c-srf)" : "transparent",
                  border: "none", outline: "none", cursor: "pointer",
                  borderRadius: 4,
                  textAlign: "left",
                  fontFamily: "inherit",
                }}
                onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = "var(--c-srf)"; }}
                onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = "transparent"; }}
              >
                <span style={{
                  fontSize: 12,
                  fontWeight: active ? 500 : 400,
                  color: active ? "var(--c-fg)" : "var(--c-low)",
                }}>{m.label}</span>
                {active && <Check size={11} strokeWidth={2.25} style={{ color: "var(--c-fg)" }} />}
              </button>
            );
          })}

          {/* Font scale — three Aa pills, sized to MATCH the rest
              of the popover chrome (28-px tall, not the chunky
              48-px pills from the previous pass). The font-size
              of each pill still grows so the user sees the
              scale, but proportionally smaller. */}
          <div style={{
            marginTop: 4, paddingTop: 5,
            borderTop: "1px solid var(--c-brd, rgba(255,255,255,0.06))",
            display: "flex", gap: 4,
            padding: "5px 4px 2px",
          }}>
            {scales.map((s, i) => {
              const active = Math.abs(scale - s) < 0.01;
              const fontPx = i === 0 ? 9.5 : i === 1 ? 11 : 13;
              return (
                <button
                  key={s}
                  onClick={() => setScale(s)}
                  onMouseDown={(e) => e.preventDefault()}
                  style={{
                    flex: 1, height: 24,
                    padding: 0,
                    background: active ? "var(--c-srf)" : "transparent",
                    border: "1px solid " + (active ? "var(--c-brd2)" : "var(--c-brd)"),
                    color: active ? "var(--c-fg)" : "var(--c-low)",
                    cursor: "pointer", outline: "none",
                    borderRadius: 5,
                    fontFamily: "var(--font-sans)",
                    fontSize: fontPx, fontWeight: 500,
                    display: "inline-flex", alignItems: "center", justifyContent: "center",
                    transition: "background 0.12s, border-color 0.12s, color 0.12s",
                  }}
                  onMouseEnter={(e) => {
                    if (!active) e.currentTarget.style.background = "var(--c-srf)";
                  }}
                  onMouseLeave={(e) => {
                    if (!active) e.currentTarget.style.background = "transparent";
                  }}
                >Aa</button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/** Permission-mode picker — clickable label that opens a dropdown
 *  mirroring Claude Code's mode menu (Ask / Accept / Plan / Auto /
 *  Bypass). The label colour shifts with the active mode so the
 *  toolbar reads as a status flag at a glance:
 *    • Ask         — neutral
 *    • Accept      — neutral (less loud than the unsafe modes)
 *    • Plan        — blue (read-only, exploration tone)
 *    • Auto        — yellow (auto-accept everything; warning tone)
 *    • Bypass      — yellow (no confirmation; warning tone)
 */
const PERM_MODES: { id: string; label: string; idx: number }[] = [
  { id: "default",            label: "Ask permissions", idx: 1 },
  { id: "acceptEdits",        label: "Accept edits",    idx: 2 },
  { id: "plan",               label: "Plan mode",       idx: 3 },
  { id: "auto",               label: "Auto mode",       idx: 4 },
  { id: "bypassPermissions",  label: "Bypass permissions", idx: 5 },
];

function PermissionModePicker({
  mode, onPick,
}: {
  mode: string;
  onPick: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Compact label for the trigger — full text is in the menu.
  const trigger = mode === "default"           ? "Ask permissions"
                : mode === "acceptEdits"       ? "Accept edits"
                : mode === "plan"              ? "Plan mode"
                : mode === "auto"              ? "Auto mode"
                : mode === "bypassPermissions" ? "Bypass permissions"
                : mode;
  const loud = mode === "bypassPermissions" || mode === "auto";

  return (
    <div ref={wrapRef} style={{ position: "relative", flexShrink: 0 }}>
      <button
        onClick={() => setOpen(o => !o)}
        onMouseDown={e => e.preventDefault()}
        title={`Permission mode: ${trigger}`}
        style={{
          padding: "3px 7px", marginRight: 1,
          border: "none", background: open ? "rgba(var(--fg-rgb), 0.05)" : "none",
          color: loud ? "#eab308" : "var(--c-low)",
          fontSize: 12, fontWeight: 600, cursor: "pointer",
          letterSpacing: "0.005em",
          borderRadius: 5,
          transition: "color 0.12s, background 0.12s",
          flexShrink: 0,
          fontFamily: "var(--font-sans)",
          outline: "none",
        }}
        onMouseEnter={e => { if (!open) e.currentTarget.style.background = "rgba(var(--fg-rgb),0.05)"; }}
        onMouseLeave={e => { if (!open) e.currentTarget.style.background = "none"; }}
      >
        {trigger}
      </button>
      {open && (
        <div style={{
          position: "absolute", bottom: "calc(100% + 6px)", left: 0,
          minWidth: 240,
          background: "var(--popover, #161616)",
          border: "1px solid var(--c-brd, rgba(255,255,255,0.08))",
          borderRadius: 8,
          padding: 4,
          boxShadow: "0 -8px 28px rgba(0,0,0,0.42)",
          zIndex: 60,
          fontFamily: "var(--font-sans)",
          animation: "fleet-popover-up 0.14s ease-out both",
        }}>
          <div style={{
            display: "flex", alignItems: "center", justifyContent: "space-between",
            padding: "5px 9px 4px",
          }}>
            <span style={{ fontSize: 10.5, color: "var(--c-dim)", fontWeight: 500 }}>Mode</span>
            <div style={{ display: "flex", gap: 2 }}>
              <Kbd>⇧</Kbd><Kbd>⌘</Kbd><Kbd>M</Kbd>
            </div>
          </div>
          {PERM_MODES.map(m => {
            const active = mode === m.id;
            const loudRow = m.id === "bypassPermissions" || m.id === "auto";
            return (
              <button
                key={m.id}
                onClick={() => { onPick(m.id); setOpen(false); }}
                onMouseDown={e => e.preventDefault()}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "space-between",
                  width: "100%", padding: "5px 10px",
                  background: active ? "var(--c-srf)" : "transparent",
                  border: "none", outline: "none", cursor: "pointer",
                  borderRadius: 5,
                  textAlign: "left",
                  fontFamily: "inherit",
                }}
                onMouseEnter={e => { if (!active) e.currentTarget.style.background = "var(--c-srf)"; }}
                onMouseLeave={e => { if (!active) e.currentTarget.style.background = "transparent"; }}
              >
                <span style={{
                  fontSize: 12.5,
                  fontWeight: active ? 600 : 500,
                  color: loudRow && active ? "#eab308" : "var(--c-fg)",
                }}>{m.label}</span>
                <span style={{ display: "flex", alignItems: "center", gap: 7 }}>
                  {active && <Check size={10} style={{ color: "var(--c-dim)" }} />}
                  <span style={{
                    fontSize: 10.5, color: "var(--c-dim)",
                    fontFamily: "var(--font-mono)",
                  }}>{m.idx}</span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ─────────────────── types ─────────────────── */

export interface Attachment {
  id: string; name: string; mimeType: string; data: string; preview?: string;
}

export interface AgentMention {
  id: string;
  name: string;
  status: string;
  project_path?: string;
  /** "agent" = a session, "folder" = a project directory */
  kind?: "agent" | "folder";
}

/** Color + label table for the Fleet mode cycle button. Shared
 *  between the toolbar icon and tooltips. */
function fleetModeMeta(mode: FleetMode): { label: string; color: string; hint: string } {
  switch (mode) {
    case "manual":      return { label: "Manual",      color: "var(--c-dim)",            hint: "Fleet off" };
    case "refine-only": return { label: "Refine only", color: "rgba(148,163,184,0.95)",  hint: "rewrite on send" };
    case "copilot":     return { label: "Co-pilot",    color: "rgba(96,165,250,0.95)",   hint: "refine + decision card" };
    case "auto":        return { label: "Auto",        color: "rgba(74,222,128,0.95)",   hint: "refine + auto-continue" };
  }
}

interface ChatInputProps {
  onSend: (msg: string, attachments?: Attachment[]) => void;
  onStop?: () => void;
  onModelChange?: (modelId: string) => void;
  onEffortChange?: (effort: Effort) => void;
  disabled?: boolean;
  streaming?: boolean;
  /** Fully locks typing & send — used while a permission prompt is waiting. */
  locked?: boolean;
  placeholder?: string;
  model?: string | null;
  effort?: Effort;
  /** 0–1 fraction of context window consumed */
  contextPercent?: number;
  /** Raw token usage for the latest assistant turn — drives the
   *  ContextArc popover so it can show "262.9k / 1.0M" alongside
   *  the percent. When absent we just hide the numeric breakdown
   *  and keep the percent. */
  contextUsedTokens?: number;
  /** Model's max context window (e.g. 200_000, 1_000_000). Used
   *  in the popover label as the divisor next to "/". Caller
   *  picks this off the model id. */
  contextMaxTokens?: number;
  /** Aggregate session usage so the popover can render the
   *  per-session breakdown (input / output / cache / turns / cost
   *  / duration) below the context-window bar. The shape mirrors
   *  what chat-view computes from the in-store messages array. */
  sessionUsage?: {
    inputTotal: number;
    outputTotal: number;
    cacheReadTotal: number;
    cacheWriteTotal: number;
    turns: number;
    /** USD cost — pulled from Session.budget_used. */
    costUsd?: number;
    /** ISO timestamp the session was created at — drives the
     *  "Active 2m 14s" duration row. */
    startedAt?: string;
  };
  projectPath?: string | null;
  /** Path of the per-session git worktree (under
   *  <project>/.fleetify-worktrees/<sid>/). When non-null we point
   *  BranchStrip's git-context probe at the WORKTREE rather than
   *  the source repo, so the strip shows the agent's actual feature
   *  branch (fleet/<slug>-<id>) instead of the source repo's HEAD. */
  worktreePath?: string | null;
  branch?: string | null;
  /** Provider/tool of the current agent ("claude" | "gemini" | ...). Drives the model dropdown. */
  tool?: string | null;
  /** Session ID — used to scope plugin slash commands. Optional (no plugin commands when absent). */
  sessionId?: string | null;
  /** Fleet auto mode toggle — when provided, shows the Auto button in the toolbar */
  autoMode?: boolean;
  onToggleAutoMode?: () => void;
  /** When provided, @ shows an agent picker instead of file search */
  agentMentions?: AgentMention[];
  /** Optional content rendered ABOVE the BranchStrip and input box.
   *  Used by chat-view to attach the permission card to the input
   *  cluster instead of floating it as a separate element above. */
  slotAbove?: React.ReactNode;
  /** True on the Fleet / staff / control-center chat. Suppresses the
   *  BranchStrip — PR/branch context doesn't apply to the orchestrator
   *  conversation, only to agent sessions bound to a worktree. */
  controlCenter?: boolean;
  /** Session permission mode ("default" | "acceptEdits" | "bypassPermissions" | "plan").
   *  Drives the Permissions chip in the SessionSetupStrip. */
  permissionMode?: string;
  /** Hide the BranchStrip (base ← branch / +X-Y / Create PR). Set
   *  while the SessionToolbar is rendered, so the user sees the
   *  setup chip row INSTEAD of git/PR state during pre-deploy. */
  hideBranchStrip?: boolean;
  /** Session title — fed to BranchStrip's auto-PR effect so the
   *  draft PR opens with a real human title instead of just the
   *  branch slug. */
  sessionTitle?: string | null;
}

/** Builds innerHTML for the @mention highlight mirror.
 *  Mirror sits BEHIND the textarea (lower z-index). Marks provide background only —
 *  their text is transparent so the textarea's own text renders on top without doubling.
 *
 *  A token only gets the chip background if it's a recognized mention —
 *  either a name the user picked from the popover (tracked in
 *  `validated`) or a currently-known agent name. This stops nonsense
 *  like `@gochecker'asdadsads` from rendering as a styled chip when
 *  the popover itself is reporting "No matches".
 *
 *  Trailing punctuation (`.`, `,`, `!`, `?`, `:`, `;`) is stripped
 *  before lookup so `@alice.` matches `alice` — a comma/period after
 *  a mention is part of the surrounding prose, not the token. */
function buildMentionHtml(text: string, valid: Set<string>): string {
  return text
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/((?:^|\n|\s))(@\S+)/g, (_, pre, tag) => {
      const inner = (tag as string).slice(1).replace(/[.,!?:;]+$/, "");
      if (!inner || !valid.has(inner)) return `${pre}${tag}`;
      return `${pre}<mark style="background:rgba(96,165,250,0.18);color:transparent;border-radius:3px;padding:0 2px;">${tag}</mark>`;
    });
}


/* ── BranchStrip ──
   The Claude-Code-style git context strip that sits ABOVE the chat
   textarea. Layout (left → right):

     [pr icon] base ← branch                         [+X −Y]  [Create PR]

   Visible only when:
     1) we have a project folder (renderer can ask main for git data)
     2) git returned a branch (i.e. the folder is a real repo)
     3) the current branch is NOT the base branch (no point showing
        "main ← main" with zero diff — it's noise)

   Diff stats poll on a slow cadence + on focus so the user sees fresh
   numbers without us hammering git every keystroke. Create PR opens
   `<remote>/pull/new/<branch>` via shell.openExternal — works for both
   GitHub and most GitLab setups.
*/
type GitContext = {
  branch: string | null;
  baseBranch: string | null;
  plus: number;
  minus: number;
  remoteHttpsUrl: string | null;
};

/** Branch names that conventionally serve as the integration branch
 *  when `baseBranch` is unknown. Used to detect "on default branch"
 *  in the no-remote case where we can't resolve the upstream HEAD. */
const KNOWN_DEFAULTS = new Set(["main", "master"]);

/* ── Copyable branch label ──
   Inline pill that shows a branch name and reveals a copy icon on
   hover; clicking anywhere on the pill copies the full branch name.
   Matches the user's reference: text + faint copy glyph sliding in
   under a soft hover background. */
function BranchPill({ text, tone, dim }: {
  /** Full branch name. The pill MIDDLE-truncates for display when the
   *  name exceeds 32 chars, but `text` is what lands in the clipboard
   *  — copying a `fleet/long-feature-branch-name-deadbeef` gave us a
   *  truncated `fleet/long-fe…ef` instead of the original because
   *  callers used to pass the already-truncated string. Internalising
   *  the truncation keeps display and copy in lockstep. */
  text: string;
  tone: "low" | "med";
  dim?: boolean;
}) {
  const [hovered, setHovered] = useState(false);
  const [copied, setCopied] = useState(false);
  const onClick = useCallback(() => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    });
  }, [text]);
  const display = truncateMid(text, 32);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      title={copied ? "Copied" : `Copy ${text}`}
      style={{
        display: "inline-flex", alignItems: "center", gap: 5,
        padding: "1px 6px",
        borderRadius: 5,
        cursor: "pointer",
        fontFamily: "var(--font-mono)", fontSize: 12,
        fontWeight: 500, letterSpacing: -0.15,
        // Compact reference: --c-med for base, --c-high for current
        // branch keeps contrast legible at the smaller 12px scale
        // without making the strip feel oversized.
        color: tone === "low" ? "var(--c-med)" : "var(--c-high)",
        background: hovered ? "rgba(var(--fg-rgb), 0.08)" : "transparent",
        transition: "background 0.12s",
        maxWidth: 320,
        overflow: "hidden", whiteSpace: "nowrap",
        opacity: dim ? 0.55 : 1,
        border: dim ? "1px dashed rgba(var(--fg-rgb), 0.20)" : "none",
      }}
    >
      <span>{display}</span>
      {(hovered || copied) && (
        copied
          ? <Check size={10} strokeWidth={2.2} style={{ color: "var(--c-high)" }} />
          : <Copy size={10} strokeWidth={1.85} style={{ color: "var(--c-low)" }} />
      )}
    </button>
  );
}

/* ── No-git state pill ──
   Fallback when we don't have a planned branch name to show yet (no
   sessionId, or sessionId hasn't reached BranchStrip). Once the
   session id is wired through, the strip renders "main ← fleet/…" as
   a dimmed planned label instead so the user sees what bootstrap
   will produce. */
function NoGitPill() {
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 4,
      padding: "1px 8px",
      fontSize: 12, fontWeight: 500,
      background: "rgba(var(--fg-rgb), 0.04)",
      border: "1px dashed rgba(var(--fg-rgb), 0.20)",
      color: "var(--c-dim)",
      borderRadius: 5,
      fontFamily: "var(--font-mono)",
    }}>
      <CircleSlash size={11} strokeWidth={1.75} />
      No git
    </span>
  );
}

/* ── PillTrigger ──
   Click-only wrapper around a BranchPill so the base + working pills
   in BranchStrip can open their respective BranchPickerMenu modes
   independently. Keeps the per-pill hover feedback subtle (just a soft
   surface lift), separate from any outer container hover. */
function PillTrigger({
  onClick,
  children,
}: {
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <span
      role="button"
      tabIndex={0}
      onClick={e => { e.stopPropagation(); onClick(); }}
      onKeyDown={e => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          e.stopPropagation();
          onClick();
        }
      }}
      onMouseEnter={e => {
        e.currentTarget.style.background = "rgba(var(--fg-rgb), 0.04)";
      }}
      onMouseLeave={e => {
        e.currentTarget.style.background = "transparent";
      }}
      style={{
        display: "inline-flex",
        alignItems: "center",
        borderRadius: 5,
        cursor: "pointer",
        transition: "background 0.1s",
      }}
    >
      {children}
    </span>
  );
}

/* ── computeBranchName ──
   Renderer-side mirror of backend/app/services/worktree.py's
   `compute_branch_name`. Used by the BranchStrip to render the
   "planned" fleet/<slug>-<id> label BEFORE backend session-start
   has carved it (or when the carve failed silently and the source
   repo is still on main). Keep the slug rules byte-identical to
   the Python helper — drift means the renderer shows one name and
   the backend creates a different one. */
export function computeBranchName(
  label: string | null | undefined,
  sessionId: string,
  /** Optional fallback when `label` is empty or the "New chat"
   *  placeholder — derives the slug from the folder basename instead
   *  of the raw session id. Lets compose-mode strips show
   *  `fleet/<folder>-<id>` immediately when the user picks a folder
   *  without us having to mirror the title into composer state. */
  projectPath?: string | null,
): string {
  const labelTrimmed = label?.trim();
  const usableLabel = labelTrimmed && labelTrimmed !== "New chat"
    ? labelTrimmed
    : null;
  const fallback = projectPath ? folderName(projectPath) : "";
  const raw = usableLabel || fallback || sessionId;
  const cleaned = raw.replace(/[^A-Za-z0-9._/-]+/g, "-").replace(/^[-/]+|[-/]+$/g, "");
  const slug = cleaned.slice(0, 48) || "session";
  return `fleet/${slug}-${sessionId.slice(0, 8)}`;
}

export function BranchStrip({ projectPath, sourcePath, tool, controlCenter, sessionTitle, plannedBranch, isWorktree }: {
  projectPath?: string | null;
  /** True when the resolved projectPath is a git worktree under
   *  `<source-repo>/.fleetify-worktrees/<session-id>/`. Drives the
   *  small "Worktree" indicator pill — communicates to the user that
   *  their file ops live in an isolated checkout, not the source
   *  repo's working tree. */
  isWorktree?: boolean;
  /** Always the SOURCE repo — even when `projectPath` points to a
   *  worktree (worktree-on sessions). Post-merge "Sync main" acts on
   *  this path so the user's main repo catches up with the merged
   *  remote, independent of the worktree's lifecycle. Falls back to
   *  `projectPath` for worktree-off sessions where the two are the
   *  same. */
  sourcePath?: string | null;
  tool?: string | null;
  /** When true (Fleet/staff view), the strip is suppressed entirely —
   *  PR/branch context only makes sense when an agent session is
   *  active and bound to a worktree. The early return MUST come after
   *  hooks (below) to satisfy the rules of hooks; we use it as the
   *  first render-condition gate. */
  controlCenter?: boolean;
  /** Session title — used as the auto-generated PR title when we
   *  open a draft PR on the user's behalf. Falls back to the branch
   *  name when absent. */
  sessionTitle?: string | null;
  /** The fleet/<slug>-<id> branch this session SHOULD live on. Driven
   *  by `computeBranchName(sessionTitle, sessionId)` in the caller —
   *  available even when the folder hasn't been git-init'd yet, so
   *  the strip can render "main ← fleet/…" as a dimmed placeholder
   *  and the Create PR dispatcher knows which branch to carve. */
  plannedBranch?: string | null;
}) {
  const [ctx, setCtx]       = useState<GitContext | null>(null);
  const [pr, setPr]         = useState<PRStatus | null>(null);
  const [folder, setFolder] = useState<string | null>(null);
  const [showDialog, setShowDialog] = useState(false);
  // Mid-flow GitHub auth picker — shown when the user clicks Create PR
  // without having picked a method during onboarding (or after they
  // explicitly Skipped). The promise resolver is captured so the
  // surrounding await in `executeCreatePR` can suspend on it.
  const [authChoiceOpen, setAuthChoiceOpen] = useState(false);
  const authChoiceResolverRef = useRef<((m: "oauth" | "cli" | null) => void) | null>(null);
  // Branch-switcher popover. Anchored to the BranchStrip pills. Two
  // distinct modes — "base" pops from the base/main pill (list current
  // base + "Create new main branch"), "working" pops from the working
  // pill (list every other branch + "Create new branch"). null = closed.
  // Refresh ctx + pr on every successful checkout so the strip's PR
  // badge / Merge button stays in sync.
  const [branchMenuMode, setBranchMenuMode] = useState<"base" | "working" | null>(null);
  const [draftDialog, setDraftDialog] = useState(false);
  // Review dialog state — Conductor-style. Open via the small ScanEye
  // button beside Create PR; the dialog runs the session agent over
  // the current diff and shows the markdown review.
  const [reviewOpen, setReviewOpen] = useState(false);
  // Sad-path recovery dialog state. Holds the raw error from the
  // failed Create PR call so the RecoveryDialog can hand it to the
  // session agent for a diagnosis + whitelisted recovery action.
  // Cleared via Close / Retry / successful re-attempt.
  const [recovery, setRecovery] = useState<{ error: string } | null>(null);
  // Pre-flight dialog state. Holds the issues that the deterministic
  // scan found (nested-no-commits, mid-rebase). When set, the
  // PreflightDialog opens and `executeCreatePR` is gated behind the
  // user clicking Continue. The agent isn't involved at this layer
  // — these are cases with a single obvious fix.
  const [preflight, setPreflight] = useState<{ issues: PreflightIssue[] } | null>(null);
  // Folders for which we've already auto-fired a draft PR. Per-
  // folder (worktree path) so every session's worktree gets its
  // own one-shot, with retry-on-failure handled inline.
  const autoPrFiredRef = useRef<Set<string>>(new Set());
  // True while the background auto-PR effect is mid-dispatch (its
  // `git.createPR` is in flight). Drives the BranchStrip's "Checking…"
  // placeholder so we never flash Create PR during the 1-3s window
  // when an existing PR exists but the optimistic setPr hasn't fired
  // yet. Cleared in the .then/.catch/.finally branches below.
  const [autoPrInFlight, setAutoPrInFlight] = useState(false);
  // True once prStatus has resolved at least once for the current
  // folder. Without this, the auto-PR effect can't tell "no PR
  // exists" apart from "PR status hasn't loaded yet" — both look
  // like pr === null. Firing too early races a real existing PR
  // and gh pr create errors out with "a PR for this branch already
  // exists", which is then silently swallowed.
  const [prStatusLoaded, setPrStatusLoaded] = useState(false);
  const [merging, setMerging] = useState(false);
  const [syncing, setSyncing] = useState(false);
  // True between the in-app merge click and the moment we observe
  // `pr.state` flip to MERGED via prStatus poll. Gates the auto-
  // cleanup useEffect below — without this we'd also auto-sync when
  // someone merged via the GitHub web UI or when the app boots into
  // an already-merged session, both of which would surprise the user.
  const justMergedRef = useRef(false);
  // True after a successful sync+carve (auto or manual). Tells the
  // prStatus load() callback to IGNORE the stale MERGED PR that
  // `gh pr view` keeps returning for the just-recreated branch
  // (GitHub still associates the branch name with the merged PR's
  // headRefName). Cleared when an OPEN PR for the same branch
  // surfaces (round 2 has started) or when the user clicks Create
  // PR. Without this gate the strip oscillates forever between
  // null and MERGED, the Sync main button keeps reappearing, and
  // re-clicking it just re-runs the cleanup with no visible change.
  const postMergeCleanedRef = useRef(false);
  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  const createMenuRef = useRef<HTMLDivElement>(null);
  // Auto-create flow state — true while we're drafting + submitting
  // a PR straight from the BranchStrip's Create PR button (no
  // dialog). The button label flips to "Creating…" and the click
  // is no-op'd until the in-flight call completes.
  const [autoCreating, setAutoCreating] = useState(false);

  // Close the Create-PR dropdown when clicking outside it.
  useEffect(() => {
    if (!createMenuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (createMenuRef.current && !createMenuRef.current.contains(e.target as Node)) {
        setCreateMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [createMenuOpen]);

  // Diagnostic: log mount + every projectPath change so the user can
  // verify BranchStrip is rendering for their session at all. Common
  // miss is that hideBranchStrip kept it from mounting, in which case
  // no log appears.
  useEffect(() => {
    console.info("[BranchStrip] mounted/updated", { projectPath, controlCenter });
  }, [projectPath, controlCenter]);

  // Folder resolution — agent's project_path, falling back to Electron's
  // PROJECT_ROOT so the strip works on the Fleet control-center view too.
  useEffect(() => {
    let cancelled = false;
    if (projectPath) { setFolder(projectPath); return; }
    const w = window as unknown as { electronAPI?: { getProjectRoot?: () => Promise<string | null> } };
    w.electronAPI?.getProjectRoot?.().then(root => {
      if (!cancelled) setFolder(root ?? null);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [projectPath]);

  // Branch / diff stats. Two-channel refresh:
  //   1. fs.watch on `<gitdir>/HEAD` fires INSTANTLY when the user
  //      runs `git checkout`, `git switch`, branch creation, etc.
  //      Worktree-safe — `rev-parse --absolute-git-dir` resolves
  //      to the per-worktree gitdir.
  //   2. 5s poll as a fallback for things HEAD doesn't capture —
  //      uncommitted diff stats from file edits, the user staging
  //      from another tool, etc.
  useEffect(() => {
    if (!folder) { setCtx(null); return; }
    let cancelled = false;
    const w = window as unknown as { electronAPI?: {
      getGitContext?: (folder: string) => Promise<GitContext>;
      watchHead?: (folder: string, key: string) => Promise<{ ok: boolean; error?: string }>;
      unwatchHead?: (key: string) => Promise<{ ok: boolean }>;
      onHeadChanged?: (cb: (p: { folder: string; key: string }) => void) => () => void;
    } };
    const api = w.electronAPI;
    if (!api?.getGitContext) return;
    const load = () => {
      api.getGitContext!(folder).then(c => {
        if (!cancelled) setCtx(c ?? null);
      }).catch(() => {});
    };
    load();
    const iv = setInterval(load, 5000);

    const watchKey = `branchstrip:${folder}`;
    let offWatcher: (() => void) | null = null;
    if (api.watchHead && api.onHeadChanged) {
      api.watchHead(folder, watchKey).catch(() => {});
      offWatcher = api.onHeadChanged(({ key }) => {
        if (!cancelled && key === watchKey) load();
      });
    }

    return () => {
      cancelled = true;
      clearInterval(iv);
      offWatcher?.();
      api.unwatchHead?.(watchKey).catch(() => {});
    };
  }, [folder]);

  // PR status poll — every 15s. Slower than git context because gh
  // hits the GitHub API (rate limits) and PR state changes less often
  // than working-tree edits. Skipped when we don't have a feature
  // branch (no PR can exist).
  useEffect(() => {
    setPrStatusLoaded(false);
    if (!folder || !ctx?.branch || ctx.branch === ctx.baseBranch) {
      setPr(null);
      return;
    }
    // While the Create PR dispatcher is mid-run, the local branch is
    // in flux: it may have been force-recreated (round 2 carve) but
    // not yet pushed. `gh pr view` against such a branch can transiently
    // return the OLD merged PR (which still references the name), and
    // we'd flash "Sync main" in the action area until the next poll
    // returns the new OPEN PR. Pausing the effect here removes that
    // window entirely; the post-createPR success handler triggers a
    // fresh poll once the new state is settled.
    if (autoCreating) return;
    let cancelled = false;
    const load = () => {
      git.prStatus(folder).then(r => {
        if (cancelled) return;
        // Diagnostic so we can see, in DevTools, exactly what each
        // poll's `gh` call returned — the flicker between Create PR
        // and Merge in earlier traces was hard to root-cause without
        // a line per poll.
        const peek = r.ok ? (r.pr ?? null) : null;
        console.info("[pr-status] poll", {
          folder,
          ok: r.ok,
          error: r.ok ? undefined : r.error,
          number: peek?.number ?? null,
          state: peek?.state ?? null,
          isDraft: peek?.isDraft ?? null,
        });
        // gh transient failure (rc != 0): do NOT clear pr. Could be a
        // network blip, rate limit, or default-repo-not-set hiccup —
        // none of which mean the PR went away. The next interval poll
        // retries; keep the strip on whatever state we already had.
        if (!r.ok) {
          setPrStatusLoaded(true);
          return;
        }
        const incoming = r.pr ?? null;
        // Post-merge cleanup filter. After we've sync+carved this
        // branch, gh keeps returning the merged PR for the recreated
        // branch name. Suppress non-OPEN states so the strip stays
        // in the "ready for next round" shape (Create PR button)
        // instead of bouncing back to Sync main. Clear the flag the
        // moment a real OPEN PR shows up (round 2 surfaced).
        if (postMergeCleanedRef.current && incoming && incoming.state !== "OPEN") {
          setPr(null);
          setPrStatusLoaded(true);
          return;
        }
        if (incoming && incoming.state === "OPEN") {
          postMergeCleanedRef.current = false;
        }
        setPr(incoming);
        setPrStatusLoaded(true);
      }).catch(() => {
        // Network / IPC blip — don't strand the BranchStrip on the
        // "Checking…" placeholder. Mark resolved but DON'T clear pr;
        // a transient failure shouldn't wipe known state.
        if (!cancelled) setPrStatusLoaded(true);
      });
    };
    load();
    const iv = setInterval(load, 15000);
    return () => { cancelled = true; clearInterval(iv); };
  }, [folder, ctx?.branch, ctx?.baseBranch, autoCreating]);

  // ── Auto-create draft PR ──
  // First time we see actual diff on a feature branch with no PR
  // yet, kick off a draft PR with a sensible auto-title. Mirrors
  // Claude Code's flow: every session has a draft PR open against
  // the base branch from the moment the agent commits.
  //
  // Three guards keep this from misfiring:
  //   1. prStatusLoaded — we MUST know the PR is actually missing,
  //      not just unfetched, before firing. Without this we race
  //      the prStatus call and try to recreate an existing PR,
  //      which gh rejects with "a pull request already exists".
  //   2. autoPrFiredRef — per-folder one-shot, with retry-on-fail.
  //   3. ctx.plus + ctx.minus > 0 — no PR for an empty diff.
  useEffect(() => {
    // Diagnostic: every state change emits a one-liner so the user
    // can see exactly which guard is currently holding the auto-PR
    // back. Open devtools console and look for "[auto-PR] check".
    const reason = !folder ? "no-folder"
      : !ctx?.branch ? "no-branch"
      : !ctx.baseBranch ? "no-base-branch"
      : ctx.branch === ctx.baseBranch ? "on-default-branch"
      : !prStatusLoaded ? "pr-status-unloaded"
      : pr ? "pr-already-exists"
      : autoCreating ? "manual-create-in-flight"
      : (ctx.plus === 0 && ctx.minus === 0) ? "no-diff"
      : autoPrFiredRef.current.has(folder) ? "already-fired"
      : "ready-to-fire";
    console.info("[auto-PR] check", {
      reason,
      folder,
      branch: ctx?.branch,
      base: ctx?.baseBranch,
      plus: ctx?.plus,
      minus: ctx?.minus,
      hasPr: !!pr,
      prStatusLoaded,
      autoCreating,
    });

    if (!folder || !ctx?.branch || !ctx.baseBranch) return;
    if (ctx.branch === ctx.baseBranch) return;
    if (!prStatusLoaded) return;
    if (pr) return;
    // Don't race the manual click. The user's click sets autoCreating
    // before its first API call; without this guard the background
    // draft-PR effect can fire concurrently — both succeed (the second
    // returns existed:true) BUT the AI summary inside `git_create_pr`
    // (~12-25s) keeps the second request alive even after the first
    // landed, so the trace shows duplicate `gh pr create` attempts.
    if (autoCreating) return;
    if (ctx.plus === 0 && ctx.minus === 0) return;
    if (autoPrFiredRef.current.has(folder)) return;

    autoPrFiredRef.current.add(folder);
    setAutoPrInFlight(true);
    const branchSlug = (ctx.branch || "")
      .replace(/^fleet\//, "").replace(/^claude\//, "")
      .replace(/-[a-f0-9]{8}$/, "");
    const title = (sessionTitle || branchSlug || ctx.branch || "Working session").slice(0, 80);
    const body  = `Draft PR auto-opened by Fleet for branch \`${ctx.branch}\`.`;

    console.info("[auto-PR] firing", { folder, branch: ctx.branch, base: ctx.baseBranch, title });
    // Wrap in try/catch so a missing IPC method (e.g. test
    // harness without the full electronAPI surface) doesn't
    // throw synchronously and bubble up as an unhandled effect
    // error before .catch can grab it.
    try {
      git.createPR(folder, { title, body, base: ctx.baseBranch, draft: false })
        .then(r => {
          setAutoPrInFlight(false);
          if (r.ok) {
            console.info("[auto-PR] created", { number: r.prNumber, url: r.prUrl, existed: r.existed });
            // Optimistic Merge UI — flip the strip from "Create PR"
            // to "Open + Merge" synchronously. Without this, the
            // strip stayed on Create PR for the full 800ms +
            // prStatus round-trip window after an `existed:true`
            // response, and the user could click Create PR a second
            // time during that window (which then races into yet
            // another duplicate dispatch).
            if (typeof r.prNumber === "number") {
              const nr = r.prNumber;
              setPr(prev => prev?.number === nr ? prev : {
                number: nr,
                url: r.prUrl ?? "",
                state: "OPEN",
                mergeable: "UNKNOWN",
                isDraft: false,
                baseRefName: ctx.baseBranch ?? "main",
                headRefName: ctx.branch ?? "",
                checks: { passing: 0, failing: 0, pending: 0, total: 0 },
                commentsCount: 0,
              });
              setPrStatusLoaded(true);
            }
            // Refine the optimistic state from gh — checks counts,
            // draft status, etc. Lookup by the specific number to
            // avoid gh's branch-resolution lag for freshly-created
            // PRs.
            setTimeout(() => {
              if (folder) git.prStatus(folder, r.prNumber).then(s => {
                if (s.ok) { setPr(s.pr ?? null); setPrStatusLoaded(true); }
              });
            }, 800);
          } else {
            // Re-arm by default so the NEXT diff event retries. We only
            // hold the ref when the PR almost certainly exists already
            // ("a pull request for branch X already exists") — in that
            // case the prStatus poll will pick it up. Everything else
            // (timeout, network, auth, push rejected, no commits, no
            // remote) was historically sticky and blocked retries
            // forever on transient failures — including the 4s push
            // timeout we just fixed. Clearing the ref is safe because
            // a real existing PR returns r.ok with r.existed=true and
            // takes the success branch above.
            console.warn("[auto-PR] failed", r.error);
            const err = (r.error || "").toLowerCase();
            const stickyExisting = err.includes("already exists") || err.includes("pull request for branch");
            if (!stickyExisting) {
              autoPrFiredRef.current.delete(folder);
            }
          }
        })
        .catch(e => {
          setAutoPrInFlight(false);
          console.warn("[auto-PR] threw", e);
          autoPrFiredRef.current.delete(folder);
        });
    } catch (e) {
      setAutoPrInFlight(false);
      console.warn("[auto-PR] threw (sync)", e);
      autoPrFiredRef.current.delete(folder);
    }
  }, [folder, ctx?.branch, ctx?.baseBranch, ctx?.plus, ctx?.minus, pr, prStatusLoaded, autoCreating, sessionTitle]);

  // Auto-cleanup after merge. When prStatus poll observes the PR
  // flip to MERGED AND we were the ones who triggered the merge
  // (justMergedRef set in onMerge), run the same Sync main + carve
  // next round flow the manual button does. The user no longer has
  // to click Sync main after every merge — the session immediately
  // reaches the "ready for next round" state.
  //
  // Gating: justMergedRef is the safeguard against firing this for
  // MERGED states the user didn't trigger (e.g. someone merged via
  // GitHub web, or the app boots into a session whose PR was merged
  // last week). In those cases the strip still shows Open + Sync
  // main and the user has manual control.
  //
  // HOISTED above the `controlCenter` early return below: React's
  // Rules of Hooks require the hook call count to stay constant
  // across renders for the same component instance. Without this
  // hoist, navigating from the Fleet hub (controlCenter=true → early
  // return BEFORE the hook) to a real session (controlCenter=false →
  // hook fires) shifted the hook count and React tore the tree down
  // with `Rendered more hooks than during the previous render.`
  useEffect(() => {
    if (controlCenter) return;
    if (pr?.state !== "MERGED") return;
    if (!justMergedRef.current) return;
    glog("ui", "auto-cleanup.fire", { prNumber: pr.number });
    void onSyncMain();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pr?.state, controlCenter]);

  if (controlCenter) return null;

  const noGit = !ctx?.branch;
  const onDefaultBranch =
    !noGit && (
      (!!ctx!.baseBranch && ctx!.branch === ctx!.baseBranch) ||
      (!ctx!.baseBranch && KNOWN_DEFAULTS.has(ctx!.branch!))
    );
  const hasDiff = (ctx?.plus ?? 0) > 0 || (ctx?.minus ?? 0) > 0;
  // Show Create PR whenever we have something the dispatcher can act
  // on. Three shapes flow through:
  //   - feature branch (existing happy path)
  //   - noGit with plannedBranch → dispatcher bootstraps + carves it
  //   - on default branch with plannedBranch → dispatcher carves
  // Without plannedBranch the bootstrap states can't pick a target
  // branch, so we fall back to hiding the button.
  const showCreatePR =
    (!noGit && !onDefaultBranch) ||
    ((noGit || onDefaultBranch) && !!plannedBranch);
  // Review is available whenever a git repo exists with something
  // the agent can read — noGit folders have no diff yet, so the
  // button stays hidden until bootstrap. (Conductor's parity: their
  // Review action is only useful once there's a workspace state.)
  const showReview = !!folder && !noGit;

  // noGit may be true here; we render <NoGitPill /> from the unified
  // JSX path below. The legacy non-noGit render uses ctxR.branch /
  // ctxR.baseBranch directly, gated by the `noGit ? <NoGitPill /> : …`
  // ternary so the cast is only consumed when noGit is provably false.
  const ctxR = ctx as GitContext & { branch: string };

  const onMerge = async () => {
    if (!folder || !pr || pr.state !== "OPEN") return;
    // Capture base + prNumber BEFORE the mergePR call, because by the
    // time the auto-cleanup runs we'll have cleared `pr` and gh may
    // have switched the local checkout to main.
    const baseBranch = pr.baseRefName || ctx?.baseBranch || "main";
    const mergedPrNumber = pr.number;
    glog("ui", "merge.start", { prNumber: mergedPrNumber, baseRef: baseBranch, wasDraft: pr.isDraft });
    setMerging(true);
    // Mark so the fallback auto-cleanup useEffect could ALSO fire if
    // the state-flip path beats the direct trigger below. Cleared in
    // doSyncAndCarve so we never double-run.
    justMergedRef.current = true;
    // Always attempt `gh pr ready` before merge — the local
    // `pr.isDraft` flag can be stale (optimistic setPr defaults it
    // to false even when the actual PR on GitHub is still a draft
    // from an earlier auto-PR run that hardcoded draft:true). The
    // backend's pr_ready treats "already ready" as a silent no-op so
    // running it unconditionally is cheap. Without this, hitting
    // Merge on a stale-draft PR produced "GraphQL: Pull Request is
    // still a draft" from `gh pr merge`.
    const ready = await git.markPRReady(folder, mergedPrNumber);
    if (!ready.ok) {
      setMerging(false);
      justMergedRef.current = false;
      return;
    }
    setPr(prev => prev && prev.number === mergedPrNumber ? { ...prev, isDraft: false } : prev);
    const r = await git.mergePR(folder, mergedPrNumber, "squash");
    setMerging(false);
    glog("ui", "merge.result", { ok: r.ok, error: r.ok ? undefined : r.error });
    if (r.ok) {
      // Drop the OPEN pr immediately. The prStatus poll will not be
      // re-fetched here — doSyncAndCarve clears pr at its end too,
      // and the regular poll resumes when ctx settles.
      setPr(null);
      // Trigger sync+carve DIRECTLY. We don't wait for pr.state to
      // flip to MERGED via prStatus — `gh pr merge --auto
      // --delete-branch` switches the local checkout to main and
      // deletes the feature branch, so by the time our poll runs
      // again the state has skipped from OPEN straight to null (no
      // PR for main). The useEffect waiting on state===MERGED would
      // never fire. Running it directly here is deterministic.
      void doSyncAndCarve(baseBranch);
    } else {
      // mergePR rejected (checks failing, auth, …) — wasn't really
      // a merge, clear the flag so the useEffect can't fire either.
      // Surface the failure as a red bubble so the user sees it
      // without having to dig through devtools.
      justMergedRef.current = false;
      const errSid = useAppStore.getState().activeSessionId || COMPOSER_CHAT_KEY;
      pushChatError(errSid, r.error || "Merge failed");
    }
  };

  // Post-merge cleanup: switch the SOURCE repo to the base branch
  // and pull --ff-only, THEN carve the next-round feature branch in
  // the AGENT's working dir (worktree or source) so the session is
  // immediately ready for the next chunk of work. Two distinct repo
  // ops separated because for worktree-on sessions they touch
  // different paths.
  // Shared body for both onSyncMain (button click, requires `pr`) and
  // the post-merge auto-trigger (onMerge done-ok, where `pr` may
  // already have been cleared and we pass `base` explicitly). Runs
  // source pull-ff-only + worktree branch reset to origin/<base>.
  const doSyncAndCarve = async (base: string) => {
    const sourceTarget = sourcePath || folder;
    if (!sourceTarget) return;
    glog("ui", "syncMain.start", { folder: sourceTarget, base });
    justMergedRef.current = false;
    setSyncing(true);
    const r = await git.syncMain(sourceTarget, base);
    glog("ui", "syncMain.result", { ok: r.ok, error: r.ok ? undefined : r.error });
    if (!r.ok) {
      setSyncing(false);
      const errSid = useAppStore.getState().activeSessionId || COMPOSER_CHAT_KEY;
      pushChatError(errSid, r.error || `Sync ${base} failed`);
      return;
    }

    // Source is now up-to-date. Try to carve the session's next
    // round in the agent's working dir (worktree for worktree-on,
    // source for worktree-off). Carve failure isn't fatal — Sync
    // already succeeded — but we still surface it so the user knows
    // the next-round branch reset didn't happen.
    if (folder && plannedBranch) {
      glog("ui", "carveNextRound.start", { folder, branch: plannedBranch, base: r.base });
      const c = await git.carveNextRound(folder, plannedBranch, r.base);
      glog("ui", "carveNextRound.result", { ok: c.ok, error: c.ok ? undefined : c.error });
      if (!c.ok) {
        const errSid = useAppStore.getState().activeSessionId || COMPOSER_CHAT_KEY;
        pushChatError(errSid, c.error || `Carve ${plannedBranch} failed`);
      }
    }
    setSyncing(false);

    // Mark the branch as "post-cleanup". The next prStatus poll
    // would otherwise return the just-merged PR (GitHub keeps the
    // branch ↔ merged-PR association), making the strip render
    // Sync main again. The flag tells load() to drop any non-OPEN
    // PR it gets back until a fresh OPEN PR (round 2) shows up.
    postMergeCleanedRef.current = true;
    setPr(null);
  };

  // Manual Sync main click — only valid when we have a current pr to
  // pull the base branch off of.
  const onSyncMain = async () => {
    if (!pr) return;
    const base = pr.baseRefName || ctx?.baseBranch || "main";
    return doSyncAndCarve(base);
  };

  const onOpenPR = () => folder && git.openPR(folder);

  // ── Create PR pipeline ──
  // Two phases:
  //   submitCreatePR  — entry point. Runs the deterministic pre-flight
  //                     check first. If structural blockers are found
  //                     (nested-no-commits, mid-rebase) opens the
  //                     PreflightDialog and gates the rest behind the
  //                     user clicking Continue.
  //   executeCreatePR — the actual happy path (diff/AI summary +
  //                     git.createPR + success/failure routing). Also
  //                     re-invoked when the user clicks Retry in the
  //                     RecoveryDialog after a sad-path failure.
  // Splitting it lets both the pre-flight gate AND the recovery retry
  // re-enter without simulating a click on the button.
  const executeCreatePR = async () => {
    if (!folder || autoCreating) {
      glog("ui", "executeCreatePR.bail", { reason: !folder ? "no-folder" : "already-creating" });
      return;
    }
    const isBootstrap = noGit || (onDefaultBranch && !!plannedBranch);
    if (isBootstrap && !plannedBranch) {
      glog("ui", "executeCreatePR.bail", { reason: "bootstrap-without-planned-branch" });
      return;
    }
    if (!isBootstrap && (!ctx || !ctx.branch)) {
      glog("ui", "executeCreatePR.bail", { reason: "no-branch" });
      return;
    }
    const branch = isBootstrap ? plannedBranch! : ctx!.branch!;
    const baseBranch = ctx?.baseBranch || "main";
    const featureBranch = isBootstrap ? plannedBranch! : undefined;
    glog("ui", "executeCreatePR.start", { folder, branch, baseBranch, isBootstrap, featureBranch: featureBranch || null, tool: tool || null });
    setAutoCreating(true);
    // Clear any stale PR state from a previous round (especially a
    // just-MERGED one) so the action area doesn't briefly flash
    // "Open + Sync main" while the dispatcher runs. The new PR's
    // status will populate via prStatus poll after createPR succeeds.
    setPr(null);
    // Mark this folder as "auto-PR'd" so the background draft-PR
    // effect doesn't race the manual click. Without this, both the
    // user's createPR and the auto-PR's draft createPR fire
    // concurrently — the second one hits `gh repo create` after the
    // first already created the repo and fails with "Name already
    // exists", producing a confusing failure log even though the
    // user's PR succeeds.
    if (folder) autoPrFiredRef.current.add(folder);
    try {
      // Pre-flight auth. The dispatcher's createPR bounces with NO_AUTH
      // when neither `gh` CLI nor a Fleetify GitHub link is available,
      // and the only recovery the user gets is a "Connect in Settings"
      // toast. Triggering the App OAuth flow inline turns one click on
      // Create PR into "browser tab opens → authorize → PR fires" with
      // no detour through Settings.
      const [ghProbe, linkProbe] = await Promise.all([
        git.hasGhCli(),
        github.getLink(),
      ]);
      if (!ghProbe.authed && !linkProbe.link) {
        // No live auth. Read the user's onboarding choice — if they
        // picked one we honour it silently; if they skipped (or never
        // chose) we open the mid-flow picker.
        const stored = (() => {
          try { return localStorage.getItem("fleet:github-auth-method"); }
          catch { return null; }
        })();
        let chosen: "oauth" | "cli" | null =
          stored === "oauth" || stored === "cli" ? stored : null;
        if (!chosen) {
          glog("ui", "executeCreatePR.auth-choice.open", {});
          chosen = await new Promise<"oauth" | "cli" | null>((resolve) => {
            authChoiceResolverRef.current = resolve;
            setAuthChoiceOpen(true);
          });
          setAuthChoiceOpen(false);
          authChoiceResolverRef.current = null;
          if (!chosen) {
            glog("ui", "executeCreatePR.auth-choice.dismissed", {});
            return;
          }
          glog("ui", "executeCreatePR.auth-choice.picked", { method: chosen });
        }
        if (chosen === "oauth") {
          glog("ui", "executeCreatePR.auto-oauth", {});
          const oauth = await github.beginOAuth();
          if (!oauth.ok) {
            glog("ui", "executeCreatePR.auto-oauth-failed", { code: oauth.code || "", error: oauth.error });
            return;
          }
          glog("ui", "executeCreatePR.auto-oauth-ok", { login: oauth.link.github_login });
        } else {
          // "cli" — the dialog already drove `gh auth login` to
          // completion (it only resolves "cli" once `hasGhCli` reports
          // authed). If we got here via the stored preference path the
          // probe at the top of this branch may have been pre-auth, so
          // re-probe once before proceeding.
          const re = await git.hasGhCli();
          if (!re.authed) {
            glog("ui", "executeCreatePR.cli-not-authed", {});
            // Pop the picker so the user can complete auth or switch
            // to OAuth — same as if no preference was stored.
            const retry = await new Promise<"oauth" | "cli" | null>((resolve) => {
              authChoiceResolverRef.current = resolve;
              setAuthChoiceOpen(true);
            });
            setAuthChoiceOpen(false);
            authChoiceResolverRef.current = null;
            if (!retry) return;
            // Re-enter the OAuth branch if the user switched method
            // mid-flow. Falls through to PR creation otherwise.
            if (retry === "oauth") {
              const oauth = await github.beginOAuth();
              if (!oauth.ok) {
                return;
              }
            }
          }
        }
      }

      let title = sessionTitle || defaultPRTitle(branch);
      let body = "";
      // Renderer-side AI / diff summary only makes sense when there's
      // ALREADY-COMMITTED diff between base and HEAD. Pre-commit
      // states — bootstrap (no commits yet) AND round-2-on-freshly-
      // carved-branch (uncommitted edits, branch == origin/main) —
      // produce empty diff queries here. The agent sees nothing,
      // returns a generic "no changes" body, and that body then
      // BLOCKS the dispatcher's post-commit AI fallback (which gates
      // on `!finalBody`). Leaving body empty in those cases hands
      // off cleanly to the dispatcher, which re-runs AI AFTER the
      // auto-commit captures the real changes.
      const hasCommittedDiff = (ctx?.plus ?? 0) + (ctx?.minus ?? 0) > 0;
      if (!isBootstrap && hasCommittedDiff) {
        try {
          const sum = await git.diffSummary(folder, baseBranch);
          if (sum.ok) {
            body = defaultPRBody(sum);
            glog("ui", "executeCreatePR.diff-summary", { ok: true, bodyLen: body.length });
          } else {
            glog("ui", "executeCreatePR.diff-summary", { ok: false });
          }
        } catch { /* ignore */ }
        try {
          const ai = await git.generatePRSummary(folder, baseBranch, tool ?? undefined);
          if (ai.ok) {
            if (ai.title) title = ai.title;
            if (ai.body)  body  = ai.body;
            glog("ui", "executeCreatePR.ai-summary", { ok: true, title });
          } else {
            glog("ui", "executeCreatePR.ai-summary", { ok: false, error: ai.error });
          }
        } catch { /* ignore */ }
      } else {
        glog("ui", "executeCreatePR.skip-renderer-ai", {
          isBootstrap,
          hasCommittedDiff,
          reason: !hasCommittedDiff ? "no-committed-diff" : "bootstrap",
        });
      }
      // Resolve the auth method the user picked during onboarding (or
      // mid-flow earlier in this call). Empty / unrecognised → undefined,
      // which makes the backend fall back to its legacy gh-first / link
      // order. Honouring the explicit choice means "Use GitHub CLI"
      // never silently routes through OAuth and vice versa, even when
      // both auths happen to be live on the machine.
      const persistedMethod = (() => {
        try { return localStorage.getItem("fleet:github-auth-method"); }
        catch { return null; }
      })();
      const method: "gh" | "oauth" | undefined =
        persistedMethod === "cli" ? "gh"
        : persistedMethod === "oauth" ? "oauth"
        : undefined;
      glog("ui", "executeCreatePR.dispatch", { titleLen: title.length, bodyLen: body.length, featureBranch: featureBranch || null, method: method || null });
      const r = await git.createPR(folder, {
        title: title.slice(0, 80),
        body, base: baseBranch, draft: false,
        ...(featureBranch ? { featureBranch } : {}),
        tool: tool ?? undefined,
        ...(method ? { method } : {}),
      });
      glog("ui", "executeCreatePR.result", { ok: r.ok, code: r.ok ? undefined : r.code, prNumber: r.ok ? r.prNumber : null, existed: r.ok ? !!r.existed : null });
      if (r.ok) {
        // Optimistic Merge UI — flip the strip from "Create PR" to
        // "Open + Merge" the instant the backend returns, instead of
        // waiting for the prStatus round-trip (~200-500ms gh hop).
        // gh's response refines the details a moment later; in the
        // interim the user already sees the right affordance and
        // doesn't get to click Create PR a second time.
        if (typeof r.prNumber === "number") {
          setPr(prev => prev?.number === r.prNumber ? prev : {
            number: r.prNumber as number,
            url: r.prUrl ?? "",
            state: "OPEN",
            mergeable: "UNKNOWN",
            isDraft: false,
            baseRefName: ctx?.baseBranch ?? "main",
            headRefName: ctx?.branch ?? "",
            checks: { passing: 0, failing: 0, pending: 0, total: 0 },
            commentsCount: 0,
          });
          setPrStatusLoaded(true);
        }
        // Query gh by the specific prNumber we just got back so the
        // lookup is deterministic — gh's branch-to-PR resolution can
        // briefly miss a freshly-created PR (~1-2s lag), but
        // `gh pr view <number>` is lag-free.
        git.prStatus(folder, r.prNumber).then(s => {
          if (s.ok && s.pr) setPr(s.pr);
        });
        // Clear any in-flight recovery banner — the retry worked.
        setRecovery(null);
      } else {
        const raw = r.error || "";
        const code = r.code;

        // REPO_CREATE_FORBIDDEN — the recovery ("create on github.com
        // first") isn't something the RecoveryDialog's allow-list can
        // express, so we surface a red error bubble in the chat and
        // bail. The user clicks the github.com link from there.
        if (code === "REPO_CREATE_FORBIDDEN") {
          const errSid = useAppStore.getState().activeSessionId || COMPOSER_CHAT_KEY;
          pushChatError(
            errSid,
            "GitHub denied repository creation. Create the repo on github.com/new first, then retry Create PR.",
          );
          setAutoCreating(false);
          return;
        }

        // All other failures route through the RecoveryDialog — the
        // session agent diagnoses, picks a whitelisted recovery
        // action, and the user explicitly approves Apply. The raw
        // error string is the input to the diagnosis prompt; we no
        // longer regex-translate it here because the agent's
        // contextual diagnosis is more useful than fixed friendly
        // strings.
        glog("ui", "executeCreatePR.recovery-open", { errorPreview: (raw || "").slice(0, 120) });
        setRecovery({ error: raw || "Create PR failed with no error string." });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const errSid = useAppStore.getState().activeSessionId || COMPOSER_CHAT_KEY;
      pushChatError(errSid, msg || "Create PR failed");
    } finally {
      setAutoCreating(false);
    }
  };

  // submitCreatePR is the entry point both the button onClick and the
  // RecoveryDialog's Retry hand off to. It runs the deterministic
  // pre-flight scan first; if any issues are found, opens the
  // PreflightDialog and returns — `executeCreatePR` only runs after
  // the user clicks Continue inside that dialog. When the scan is
  // clean (the common case), we fall straight through to execute so
  // there's no perceptible latency.
  const submitCreatePR = async () => {
    if (!folder || autoCreating) {
      glog("ui", "submitCreatePR.bail", { reason: !folder ? "no-folder" : "already-creating" });
      return;
    }
    // Starting a new round — let prStatus surface fresh state. If
    // the last merge left this flag set (suppressing the stale
    // MERGED PR), clear it so the new round's OPEN PR can appear.
    postMergeCleanedRef.current = false;
    try {
      glog("ui", "submitCreatePR.preflight", { folder });
      const pf = await git.preflightCheck(folder);
      if (pf.ok && pf.issues.length > 0) {
        glog("ui", "submitCreatePR.preflight-issues", { count: pf.issues.length, types: pf.issues.map(i => i.type).join(",") });
        setPreflight({ issues: pf.issues });
        return;
      }
    } catch (e) {
      // Preflight failures shouldn't block Create PR — they're an
      // optimization layer. Log and continue to executeCreatePR;
      // any structural issue will surface in the dispatcher's
      // RecoveryDialog instead.
      glog("ui", "submitCreatePR.preflight-throw", { error: e instanceof Error ? e.message : String(e) });
    }
    await executeCreatePR();
  };

  // Action button — what we render at the right edge depends on PR state.
  // `showCreatePR` covers no-git, feature branches, and main+diff+no-remote
  // (carve-and-bootstrap). When a PR exists we always swap in the
  // PR-state-driven Merge / Open / Merged / Closed affordance.
  //
  // Wait until the first `gh pr view` poll has landed before showing
  // EITHER Create PR or Merge — otherwise the strip flashes Create PR
  // for ~0.5-1.5s on session mount and the user can click it before
  // the existing PR is detected (which then trips the "already exists"
  // path and a confusing FAIL trace). The `prCheckedOnce` gate is
  // scoped to feature branches (noGit + on-default still show Create
  // PR immediately, since they can't have an existing PR yet).
  //
  // Also stay on the placeholder while the auto-PR effect is mid-
  // dispatch (its createPR call detects an existing PR + flips pr
  // optimistically when it returns). Without this gate the strip
  // showed Create PR for ~2-3s between "poll said no PR" and
  // "auto-PR's optimistic setPr fired."
  const prCheckedOnce = noGit || onDefaultBranch ? true : prStatusLoaded;
  const checkingPr = !prCheckedOnce || (autoPrInFlight && !pr);
  let action: React.ReactNode = null;
  if (checkingPr) {
    // Quiet placeholder so the slot stays the same width during the
    // initial poll — no jumpy layout when Merge / Create PR resolves.
    action = (
      <span
        title="Checking PR status…"
        style={{
          display: "inline-flex", alignItems: "center", gap: 6,
          padding: "3px 10px", borderRadius: 6,
          background: "rgba(var(--fg-rgb), 0.04)",
          color: "var(--c-low)",
          fontSize: 11.5,
          flexShrink: 0,
        }}
      >
        <Loader2 size={11} style={{ animation: "spin 1.2s linear infinite" }} />
        Checking…
      </span>
    );
  } else if (showCreatePR && !pr) {
    // Split button: main "Create PR" + chevron-down for variants
    // (draft PR / manually create on the GitHub website).
    action = (
      <div ref={createMenuRef} style={{ position: "relative", flexShrink: 0 }}>
        <div style={{
          display: "inline-flex", alignItems: "stretch",
          // Dimmer chrome — user said the white frame around "Create PR"
          // was too loud. Tonal-only fill, no visible border so the
          // button reads as a quiet pill instead of a stamped button.
          background: "rgba(var(--fg-rgb), 0.05)",
          border: "1px solid transparent",
          borderRadius: 6,
          overflow: "hidden",
        }}>
          {/* Main action — auto-fill + auto-submit. The user
              explicitly asked for "Create PR" to skip the dialog
              entirely: AI drafts the title and body, the call fires,
              and we let the post-create PR-status poll surface the
              new PR badge. The chevron menu still gives access to
              the dialog ("Create with custom title/body") and the
              draft variant for users who want fine-grained control.

              Heuristic+AI two-pass keeps the call honest even when
              the AI summarizer is slow or unavailable: we fall back
              to the diff-summary body and branch-name title that
              the dialog used as its initial seed. */}
          <button
            onClick={submitCreatePR}
            disabled={autoCreating}
            onMouseDown={e => e.preventDefault()}
            style={{
              padding: "3px 10px",
              background: "transparent",
              border: "none", outline: "none",
              // Matches the branch-label scale at the compact 12px tier:
              // --c-med resting / --c-high on hover keeps contrast
              // legible without overpowering the strip.
              color: "var(--c-med)",
              cursor: autoCreating ? "default" : "pointer",
              fontSize: 12, fontWeight: 500,
              fontFamily: "inherit",
              display: "inline-flex", alignItems: "center", gap: 5,
              opacity: autoCreating ? 0.7 : 1,
              transition: "color 0.1s",
            }}
            onMouseEnter={e => { if (!autoCreating) e.currentTarget.style.color = "var(--c-high)"; }}
            onMouseLeave={e => { e.currentTarget.style.color = "var(--c-med)"; }}
          >
            {autoCreating
              ? <><Loader2 size={10} style={{ animation: "spin 1.2s linear infinite" }} /> Creating…</>
              : "Create PR"}
          </button>

          {/* Divider */}
          <span aria-hidden style={{
            width: 1, alignSelf: "stretch",
            background: "rgba(var(--fg-rgb), 0.10)",
          }} />

          {/* Dropdown trigger — same "no hover" treatment. */}
          <button
            onClick={() => setCreateMenuOpen(o => !o)}
            onMouseDown={e => e.preventDefault()}
            title="More create options"
            style={{
              padding: "0 5px",
              background: "transparent",
              border: "none", outline: "none",
              color: "var(--c-dim)",
              cursor: "pointer",
              display: "inline-flex", alignItems: "center",
            }}
          >
            <ChevronDown size={11} strokeWidth={2.25} style={{
              transform: createMenuOpen ? "rotate(180deg)" : "none",
              transition: "transform 0.15s",
            }} />
          </button>
        </div>

        {/* Dropdown menu — opens below the split button, right-aligned. */}
        {createMenuOpen && (
          <div style={{
            // Opens UPWARD: BranchStrip lives just above a chat
            // input pinned to the bottom of the viewport, so a
            // top-anchored menu got clipped under the textarea (the
            // user saw it half-cut off). bottom: calc(100% + 6px)
            // floats the menu above the trigger with the same 6px
            // gap as the SessionToolbar popovers.
            position: "absolute", bottom: "calc(100% + 6px)", right: 0,
            minWidth: 200,
            // Theme-aware popover surface — was hardcoded #1c1c1c
            // which painted a black popover on the white chrome in
            // light theme.
            background: "var(--popover, #161616)",
            border: "1px solid var(--c-brd, rgba(255,255,255,0.08))",
            borderRadius: 8,
            // Shadow direction flipped to lift the menu OFF the
            // surface beneath (since it now floats up).
            boxShadow: "0 -8px 28px rgba(0,0,0,0.42)",
            padding: 4,
            zIndex: 50,
            display: "flex", flexDirection: "column",
            animation: "fleet-popover-up 0.14s ease-out both",
          }}>
            {/* Main action is the auto-fill flow now (handled by
                the split button itself). The menu is the escape
                hatch for users who want fine-grained control over
                title / body / draft flag — opens the full dialog. */}
            <CreateMenuItem
              icon={<GitPullRequest size={12} />}
              label="Create with custom title…"
              onClick={() => { setCreateMenuOpen(false); setShowDialog(true); }}
            />
            <CreateMenuItem
              icon={<GitPullRequest size={12} />}
              label="Create draft PR"
              onClick={() => { setCreateMenuOpen(false); setDraftDialog(true); }}
            />
            <CreateMenuItem
              icon={<ExternalLink size={12} />}
              label="Open on GitHub"
              onClick={() => { setCreateMenuOpen(false); if (folder) git.openPR(folder); }}
            />
          </div>
        )}

        {/* Auth-method picker — surfaces here (anchored above the
            Create PR button) the instant the dispatcher needs to pick
            between Connect with GitHub and Use GitHub CLI. Replaces
            the legacy modal dialog: clicking anywhere outside dismisses
            without ceremony, and the popover stays open through the gh
            device-code dance so the user sees the code without leaving
            the page. */}
        {authChoiceOpen && (
          <AuthChoicePopover
            onChoose={(method) => {
              try { localStorage.setItem("fleet:github-auth-method", method); } catch { /* private mode */ }
              setAuthChoiceOpen(false);
              authChoiceResolverRef.current?.(method);
              authChoiceResolverRef.current = null;
            }}
            onDismiss={() => {
              setAuthChoiceOpen(false);
              authChoiceResolverRef.current?.(null);
              authChoiceResolverRef.current = null;
            }}
          />
        )}
      </div>
    );
  } else if (pr) {
    // Once a PR exists we always offer "Open ↗" so the user can drop
    // out to GitHub for review / comments / manual merge. The
    // primary affordance to its right is state-driven:
    //   OPEN    → Merge (disabled w/ tooltip when checks/draft block it)
    //   MERGED  → Sync main (post-merge cleanup on the source repo)
    //   CLOSED  → just the Open button — nothing else makes sense
    const openBtn = (
      <ActionBtn onClick={onOpenPR} title={`Open #${pr.number} on GitHub`}>
        <ExternalLink size={11} strokeWidth={1.85} /> Open · #{pr.number}
      </ActionBtn>
    );

    if (pr.state === "MERGED") {
      action = (
        <>
          {openBtn}
          <ActionBtn onClick={onSyncMain} primary disabled={syncing}
            title={`Checkout ${pr.baseRefName || "main"} on the source repo and pull --ff-only`}>
            {syncing
              ? <><Loader2 size={11} style={{ animation: "spin 1.2s linear infinite" }} /> Syncing…</>
              : <><Check size={11} /> Sync {pr.baseRefName || "main"}</>}
          </ActionBtn>
        </>
      );
    } else if (pr.state === "CLOSED") {
      action = (
        <ActionBtn onClick={onOpenPR} title={`Closed · #${pr.number}`}>
          <X size={11} /> Closed · #{pr.number}
        </ActionBtn>
      );
    } else {
      // OPEN. The mergeable / draft / conflicts logic decides whether
      // Merge is enabled. Pending checks DON'T block — gh's `--auto`
      // flag queues the merge and lets GitHub do it once they pass.
      // So pending stays clickable; failing/conflicting/draft do
      // disable the button.
      const checksFailing = pr.checks.failing > 0;
      const checksPending = pr.checks.pending > 0 && pr.checks.failing === 0;
      // Draft no longer disables Merge — the click handler un-drafts
      // the PR first (gh pr ready) and then squash-merges.
      const canMerge = pr.mergeable !== "CONFLICTING" && !checksFailing;
      const mergeTitle = !canMerge
        ? (checksFailing   ? `${pr.checks.failing} check${pr.checks.failing > 1 ? "s" : ""} failing`
          : pr.mergeable === "CONFLICTING" ? "Has merge conflicts — resolve on GitHub or rebase locally"
          : "Merge unavailable")
        : pr.isDraft
          ? `Mark #${pr.number} ready for review and squash + merge into ${pr.baseRefName}`
          : checksPending
            ? `Auto-merge queued — will squash + merge once ${pr.checks.pending} check${pr.checks.pending > 1 ? "s" : ""} pass`
            : `Squash + merge #${pr.number} into ${pr.baseRefName}`;
      action = (
        <>
          {openBtn}
          <ActionBtn onClick={onMerge} primary disabled={!canMerge || merging} title={mergeTitle}>
            {merging
              ? <><Loader2 size={11} style={{ animation: "spin 1.2s linear infinite" }} /> Merging…</>
              : <><GitMerge size={11} /> Merge{checksPending ? " (auto)" : ""}</>}
          </ActionBtn>
        </>
      );
    }
  }

  return (
    <>
      <div style={{
        display: "flex", alignItems: "center", gap: 7,
        // Compact strip — back to a thin band that sits cleanly above
        // the input. The previous 7px vertical was too tall and the
        // strip read as a header instead of a quiet context row.
        padding: "3px 5px 3px 7px",
        borderRadius: 8,
        background: "var(--chat-input-bg, #121212)",
        border: "1px solid var(--c-brd, transparent)",
        color: "var(--c-fg)",
        fontSize: 12,
      }}>
        {/* Branch glyph — small, transparent chip; the icon itself
            carries the leading-status signal. Colour shifts with PR
            state so MERGED / CLOSED stay legible at a glance. */}
        <span style={{
          width: 18, height: 18, borderRadius: 5,
          display: "inline-flex", alignItems: "center", justifyContent: "center",
          background: "transparent",
          color: pr?.state === "MERGED" || pr?.state === "CLOSED" ? prIconColor(pr) : "var(--c-low)",
          flexShrink: 0,
        }}>
          {pr?.state === "MERGED" ? <Check size={12} strokeWidth={2.5} />
            : pr?.state === "CLOSED" ? <X size={12} strokeWidth={2.5} />
            : <GitBranch size={12} strokeWidth={1.85} />}
        </span>

        {/* Branch label — minimal, no decorative dots or pulses.
            Per-pill click handlers: the base/main pill opens the
            BranchPickerMenu in "base" mode (current base + Create new
            main branch), the working pill opens it in "working" mode
            (every other branch + Create new branch). noGit and pure
            planned-only renders stay informational — no menu until a
            real repo exists. */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 5,
            minWidth: 0,
            flex: 1,
            position: "relative",
            padding: "1px 2px",
            borderRadius: 4,
          }}
        >
          {noGit && plannedBranch ? (
            // Planned label — folder isn't a git repo yet, but the
            // dispatcher will carve `plannedBranch` on Create PR. The
            // dimmed/dashed pills read as "not landed yet" — no menu
            // yet because there's nothing to switch *to*.
            <>
              <BranchPill text="main" tone="low" dim />
              <ArrowLeft size={11} strokeWidth={1.75}
                style={{ color: "var(--c-ghost)", flexShrink: 0, opacity: 0.7 }} />
              <BranchPill text={plannedBranch} tone="med" dim />
            </>
          ) : noGit ? (
            <NoGitPill />
          ) : onDefaultBranch && plannedBranch && plannedBranch !== ctxR.branch ? (
            // We DO have a git repo — agent's on main/master and a
            // feature branch will be carved on Create PR. The current
            // (base) pill is clickable for base-menu; planned target
            // stays informational since it doesn't exist yet.
            <>
              <PillTrigger onClick={() => setBranchMenuMode("base")}>
                <BranchPill text={ctxR.branch} tone="low" dim />
              </PillTrigger>
              <ArrowLeft size={11} strokeWidth={1.75}
                style={{ color: "var(--c-ghost)", flexShrink: 0, opacity: 0.7 }} />
              <BranchPill text={plannedBranch} tone="med" dim />
            </>
          ) : onDefaultBranch ? (
            <PillTrigger onClick={() => setBranchMenuMode("base")}>
              <BranchPill text={ctxR.branch} tone="low" />
            </PillTrigger>
          ) : (
            <>
              <PillTrigger onClick={() => setBranchMenuMode("base")}>
                <BranchPill
                  text={ctxR.baseBranch ?? "main"}
                  tone="low"
                  dim={!ctxR.baseBranch}
                />
              </PillTrigger>
              <ArrowLeft size={11} strokeWidth={1.75}
                style={{ color: "var(--c-ghost)", flexShrink: 0, opacity: 0.7 }} />
              <PillTrigger onClick={() => setBranchMenuMode("working")}>
                <BranchPill text={ctxR.branch} tone="med" />
              </PillTrigger>
              {pr && <PRStateBadge pr={pr} />}
            </>
          )}
          {branchMenuMode && folder && (
            <BranchPickerMenu
              folder={folder}
              mode={branchMenuMode}
              currentBranch={ctxR?.branch ?? null}
              baseBranch={ctxR?.baseBranch ?? null}
              newBranchTopic={
                sessionTitle ||
                ((ctxR?.branch || "").replace(/^fleet\//, "").replace(/-[a-f0-9]{8}$/, "")) ||
                "scratch"
              }
              onPick={() => setBranchMenuMode(null)}
              onCreateNew={() => setBranchMenuMode(null)}
              onBaseChanged={() => {
                setBranchMenuMode(null);
                // Re-pull git context so the detected base reflects
                // the new `fleetify.baseBranch` config. The 5s poll
                // would catch it eventually, but a direct refetch
                // keeps the strip from showing the stale base for up
                // to one tick.
                if (folder) {
                  const api = (window as unknown as { electronAPI?: {
                    getGitContext?: (f: string) => Promise<GitContext>;
                  } }).electronAPI;
                  api?.getGitContext?.(folder)
                    .then(c => setCtx(c ?? null))
                    .catch(() => {});
                }
              }}
              onDismiss={() => setBranchMenuMode(null)}
            />
          )}
        </div>

        {/* Worktree indicator — surfaces only when the session's
            project path is a `.fleetify-worktrees/<id>/` checkout, so
            the user knows their file ops are isolated from the source
            repo's working tree. Subtle: low-contrast pill, same height
            as the diff stats, no border. */}
        {isWorktree && (
          <span
            title="This session runs in an isolated git worktree under .fleetify-worktrees/"
            style={{
              display: "inline-flex", alignItems: "center", gap: 4,
              padding: "1px 7px", borderRadius: 5,
              background: "rgba(var(--fg-rgb), 0.05)",
              color: "var(--c-low)",
              fontSize: 10.5,
              fontWeight: 500,
              fontFamily: "var(--font-mono)",
              letterSpacing: "0.02em",
              flexShrink: 0,
            }}
          >
            <FolderTree size={10} strokeWidth={1.85} />
            worktree
          </span>
        )}

        {/* Diff stats — only when there's something to show. hasDiff
            already guarantees ctx is non-null and has positive +/-,
            but TS can't narrow through the derived boolean, so we
            fall back to ctxR for the property reads. */}
        {hasDiff && (!pr || pr.state === "OPEN") && (
          <span style={{
            display: "inline-flex", alignItems: "center", gap: 5,
            padding: "1px 6px", borderRadius: 5,
            background: "rgba(var(--fg-rgb), 0.06)",
            fontFamily: "var(--font-mono)", fontSize: 11,
            flexShrink: 0,
            fontVariantNumeric: "tabular-nums",
          }}>
            <span style={{ color: "#4ade80" }}>+{ctxR.plus}</span>
            <span style={{ color: "#f87171" }}>−{ctxR.minus}</span>
          </span>
        )}

        {showReview && (
          <button
            onClick={() => setReviewOpen(true)}
            onMouseDown={e => e.preventDefault()}
            title={`Review with ${tool || "agent"}`}
            aria-label="Review changes"
            style={{
              padding: "3px 9px",
              background: "transparent",
              border: "1px solid transparent",
              borderRadius: 6,
              color: "var(--c-med)",
              cursor: "pointer",
              fontSize: 12, fontWeight: 500,
              fontFamily: "inherit",
              display: "inline-flex", alignItems: "center", gap: 5,
              flexShrink: 0,
              transition: "color 0.1s, background 0.1s",
            }}
            onMouseEnter={e => {
              e.currentTarget.style.color = "var(--c-high)";
              e.currentTarget.style.background = "rgba(var(--fg-rgb), 0.05)";
            }}
            onMouseLeave={e => {
              e.currentTarget.style.color = "var(--c-med)";
              e.currentTarget.style.background = "transparent";
            }}
          >
            <ScanEye size={11} strokeWidth={1.85} />
            Review
          </button>
        )}
        {action}
      </div>

      {/* PR creation dialog — controlled by Create PR button or the
          "Create draft PR" menu item. Both go through the same dialog;
          the menu item just pre-ticks the draft checkbox. */}
      {!noGit && (showDialog || draftDialog) && folder && ctxR.baseBranch && (
        <PRDialog
          folder={folder}
          branch={ctxR.branch}
          baseBranch={ctxR.baseBranch}
          tool={tool}
          initialDraft={draftDialog}
          onClose={() => { setShowDialog(false); setDraftDialog(false); }}
          onCreated={() => {
            setTimeout(() => folder && git.prStatus(folder).then(s => s.ok && setPr(s.pr)), 600);
          }}
        />
      )}

      {/* Review dialog — opened by the ScanEye button. Asks the
          session's CLI to inspect the current diff and renders the
          response as Markdown. */}
      {reviewOpen && folder && (
        <ReviewDialog
          folder={folder}
          baseBranch={ctx?.baseBranch || "main"}
          tool={tool}
          onClose={() => setReviewOpen(false)}
        />
      )}

      {/* Recovery dialog — opens when Create PR fails with anything
          other than REPO_CREATE_FORBIDDEN. The session's CLI is asked
          to diagnose the failure and propose a whitelisted recovery
          action (pull-rebase / force-with-lease / set-upstream /
          custom-command / manual). Apply runs the corresponding
          command in the main process; Retry re-fires the same Create
          PR call. The app — NOT the agent — executes git, keeping
          the action set safe. */}
      {recovery && folder && (
        <RecoveryDialog
          folder={folder}
          baseBranch={ctx?.baseBranch || "main"}
          tool={tool}
          errorMessage={recovery.error}
          context="Create PR"
          onClose={() => setRecovery(null)}
          onRetry={submitCreatePR}
        />
      )}

      {/* Pre-flight dialog — opens when the deterministic scan finds
          structural blockers (nested-no-commits, mid-rebase). Each
          issue has exactly one obvious fix, applied via
          applyPreflightFix. Continue resumes the Create PR happy
          path; Cancel aborts. */}
      {preflight && folder && (
        <PreflightDialog
          folder={folder}
          issues={preflight.issues}
          onContinue={() => {
            setPreflight(null);
            // executeCreatePR is fresh on each render — captures
            // the latest state. We're calling it AFTER setPreflight
            // schedules an update, but React batches and the
            // closure here is from this render's snapshot, which is
            // fine because submitCreatePR pulled it from the same
            // scope.
            void executeCreatePR();
          }}
          onCancel={() => setPreflight(null)}
        />
      )}
      {/* The mid-flow auth picker now renders as a popover anchored to
          the Create PR button (see action-area JSX above). The legacy
          full-screen GithubAuthChoiceDialog is kept as a fallback for
          code paths that don't have a Create PR button to anchor on. */}
    </>
  );
}

/** Action button at the right edge of the BranchStrip. Two visual
 *  weights — primary (Create PR / Merge) lifts onto the foreground,
 *  ghost (Open / Merged status) sits on a subtle bg. */
/** Single row inside the Create-PR split-button dropdown.
 *  Icon + label, optional trailing checkmark for the "current" choice. */
function CreateMenuItem({
  icon, label, checked, onClick,
}: {
  icon: React.ReactNode;
  label: string;
  checked?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      onMouseDown={e => e.preventDefault()}
      style={{
        display: "flex", alignItems: "center", gap: 9,
        width: "100%", padding: "6px 10px",
        background: "transparent", border: "none", outline: "none",
        color: "#e8e8e8",
        fontSize: 12.5, fontWeight: 400,
        cursor: "pointer", textAlign: "left",
        borderRadius: 5, fontFamily: "inherit",
        transition: "background 0.1s",
      }}
      onMouseEnter={e => { e.currentTarget.style.background = "rgba(255,255,255,0.06)"; }}
      onMouseLeave={e => { e.currentTarget.style.background = "transparent"; }}
    >
      <span style={{ display: "flex", color: "#a8a8a8", flexShrink: 0 }}>{icon}</span>
      <span style={{ flex: 1 }}>{label}</span>
      {checked && <Check size={12} strokeWidth={2.5} style={{ color: "#c8c8c8", flexShrink: 0 }} />}
    </button>
  );
}

function ActionBtn({
  children, onClick, primary, disabled, title,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  primary?: boolean;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        padding: "4px 10px", borderRadius: 5, flexShrink: 0,
        background: primary ? "#f5f5f5" : "rgba(255,255,255,0.07)",
        border: primary ? "none" : "1px solid rgba(255,255,255,0.12)",
        color: primary ? "#0a0a0a" : "#f0f0f0",
        cursor: disabled ? "default" : "pointer",
        fontSize: 11.5, fontWeight: primary ? 600 : 500,
        transition: "background 0.12s, opacity 0.12s",
        opacity: disabled ? 0.6 : 1,
        display: "inline-flex", alignItems: "center", gap: 5,
        fontFamily: "inherit",
        // Kill the browser's default focus ring (the yellow/orange
        // halo the user complained about — Electron's default focus
        // outline lingered on the button after click). The hover
        // background is the affordance now.
        outline: "none",
      }}
      // Suppress focus ring on click but keep keyboard a11y by only
      // blurring after a mouse-driven click.
      onMouseDown={e => e.preventDefault()}
      onMouseEnter={e => {
        if (disabled) return;
        if (primary) e.currentTarget.style.opacity = "0.82";
        else e.currentTarget.style.background = "rgba(255,255,255,0.13)";
      }}
      onMouseLeave={e => {
        if (primary) e.currentTarget.style.opacity = "1";
        else e.currentTarget.style.background = "rgba(255,255,255,0.07)";
      }}
    >
      {children}
    </button>
  );
}

/** Tiny PR state pill that sits inline next to the branch name when a
 *  PR exists. Communicates checks/conflicts/draft status at a glance. */
function PRStateBadge({ pr }: { pr: PRStatus }) {
  let icon: React.ReactNode = null;
  let label = "";
  let color = "var(--c-low)";
  let bg = "rgba(var(--fg-rgb),0.05)";

  if (pr.state === "MERGED") {
    icon = <Check size={10} />; label = "merged"; color = "#a78bfa";
    bg = "rgba(167,139,250,0.10)";
  } else if (pr.state === "CLOSED") {
    icon = <X size={10} />; label = "closed"; color = "#f87171";
    bg = "rgba(248,113,113,0.10)";
  } else if (pr.isDraft) {
    icon = <Circle size={10} />; label = "draft";
  } else if (pr.checks.failing > 0) {
    icon = <AlertCircle size={10} />; label = `${pr.checks.failing} failing`;
    color = "#f87171"; bg = "rgba(248,113,113,0.10)";
  } else if (pr.checks.pending > 0) {
    icon = <Loader2 size={10} style={{ animation: "spin 1.4s linear infinite" }} />;
    label = `${pr.checks.pending} pending`;
    color = "#fbbf24"; bg = "rgba(251,191,36,0.10)";
  } else if (pr.mergeable === "CONFLICTING") {
    icon = <AlertCircle size={10} />; label = "conflicts";
    color = "#fb923c"; bg = "rgba(251,146,60,0.10)";
  } else if (pr.checks.passing > 0) {
    icon = <CheckCircle2 size={10} />; label = `${pr.checks.passing} passing`;
    color = "#4ade80"; bg = "rgba(74,222,128,0.10)";
  } else {
    icon = <CheckCircle2 size={10} />; label = "ready";
    color = "#4ade80"; bg = "rgba(74,222,128,0.10)";
  }

  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 4,
      padding: "2px 6px", borderRadius: 4,
      background: bg, color,
      fontSize: 10.5, fontWeight: 500,
      flexShrink: 0,
    }}>
      {icon} {label}
    </span>
  );
}

function prIconColor(pr: PRStatus | null): string {
  if (!pr) return "var(--c-low)";
  if (pr.state === "MERGED") return "#a78bfa";
  if (pr.state === "CLOSED") return "#f87171";
  if (pr.checks.failing > 0) return "#f87171";
  if (pr.mergeable === "CONFLICTING") return "#fb923c";
  if (pr.checks.pending > 0) return "#fbbf24";
  return "#4ade80";
}

/* ─────────────────── main component ─────────────────── */

export function ChatInput({
  onSend, onStop, onModelChange, onEffortChange,
  disabled, streaming, locked,
  placeholder, model,
  effort: effortProp,
  contextPercent = 0,
  contextUsedTokens,
  contextMaxTokens,
  sessionUsage,
  projectPath, worktreePath, tool, sessionId,
  autoMode: _autoMode, onToggleAutoMode: _onToggleAutoMode,
  agentMentions,
  slotAbove,
  controlCenter,
  permissionMode,
  hideBranchStrip,
  sessionTitle,
}: ChatInputProps) {
  const [value, setValue]       = useState("");
  const [focused, setFocused]   = useState(false);
  // Prompt-enhance state — Sparkles button's lifecycle. While
  // `enhancing` is true the icon flips to a spinner and the click is
  // gated; on success we stash the original in `enhanceUndo` so the
  // user can press Undo (visible for ~6 s after) to restore it.
  const [enhancing, setEnhancing] = useState(false);
  const [enhanceUndo, setEnhanceUndo] = useState<string | null>(null);
  const [enhanceToast, setEnhanceToast] = useState<string | null>(null);

  // Fleet co-pilot state — intercepts the chat submit on agent
  // sessions (not the control-center) and runs the prompt through
  // the Haiku-tier refiner BEFORE handing it to the agent. The
  // resulting refine card replaces the textarea momentarily with
  // {original, refined, [Send refined / Original / Edit]}. Fleet
  // off ⇒ submit goes straight to the agent like before. Per-
  // session mode comes from fleet-store (manual / refine-only /
  // copilot / auto). Mode determines whether submit goes through
  // the Haiku refiner first.
  const [refining, setRefining] = useState(false);
  const [pendingRefine, setPendingRefine] = useState<{
    original: string;
    refined: string;
    rationale: string | null;
    attachments: Attachment[];
  } | null>(null);
  // Provider tiles flow from the registry. We build the picker groups ONCE
  // here (the same way SessionToolbar does — providerTiles + connected CLI
  // agents + the live session models from the store) and reuse them for both
  // the model chip face and the dropdown, so the composer chip resolves the
  // current model to the exact same provider icon + label as the toolbar chip.
  const { tiles: providerTiles } = useProvidersConfig();
  const sessionDynModels = useChatStore((s) => (sessionId ? s.dynamicModels[sessionId] : undefined));
  const pickerGroups = useMemo(() => {
    const enabledAgentIds = providerTiles
      .filter((t) => t.spec.kind === "cli" && t.connected)
      .map((t) => t.spec.id);
    // Live models (OpenCode / Cursor / GitHub Copilot) arrive over the bridge
    // keyed under the session's own tool — mirror SessionToolbar's merge so
    // the same model id resolves to the same group in both places.
    const dyn =
      sessionDynModels && sessionDynModels.models.length > 0
        ? {
            [tool ?? "claude"]: sessionDynModels.models.map((m) => ({
              id: m.id,
              label: m.label,
              supports_effort: false,
            })),
          }
        : undefined;
    return buildPickerGroups(providerTiles, enabledAgentIds, dyn);
  }, [providerTiles, sessionDynModels, tool]);

  const fleetMode = useFleetStore(s => sessionId ? s.getSession(sessionId).mode : "manual");
  const fleetPaused = useFleetStore(s => sessionId ? s.getSession(sessionId).status === "paused" : false);
  const recordCost = useFleetStore(s => s.recordCost);
  // Fleet hub-only: global default mode (settable from this surface).
  const globalFleetMode = useFleetStore(s => s.globalMode);
  // Refine fires whenever mode is anything except "manual" — refine-only,
  // copilot, and auto all share the refine-on-send behaviour.
  const fleetActive = !controlCenter && !!sessionId && fleetMode !== "manual" && !fleetPaused;

  // Message history (up/down arrow navigation, terminal-style)
  const historyRef    = useRef<string[]>([]);
  const historyIdxRef = useRef(-1);   // -1 = not navigating
  const draftRef      = useRef("");   // saved draft before navigating
  const [dragging, setDragging] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);

  // Names the user has actually picked from a @mention popover this
  // session. Used by buildMentionHtml to decide whether a token earns
  // the chip background — typed-but-unmatched tokens stay as plain text.
  const [pickedMentions, setPickedMentions] = useState<Set<string>>(() => new Set());

  const [openDrop, setOpenDrop] = useState<"model" | "fleet-mode" | null>(null);

  // Controlled-or-local effort
  const [effortLocal, setEffortLocal] = useState<Effort>("high");
  const effort = effortProp ?? effortLocal;
  const setEffort = useCallback((e: Effort) => { setEffortLocal(e); onEffortChange?.(e); }, [onEffortChange]);

  // @ mention state (file search)
  const [mentionOpen,    setMentionOpen]    = useState(false);
  const [mentionQuery,   setMentionQuery]   = useState("");
  const [mentionResults, setMentionResults] = useState<FileSearchEntry[]>([]);
  const [mentionLoading, setMentionLoading] = useState(false);
  const [mentionIndex,   setMentionIndex]   = useState(0);
  const mentionStartRef  = useRef<number>(-1);
  const mentionReqRef    = useRef(0);
  const dismissedAtRef   = useRef<number>(-1);

  // @ mention state (agent picker)
  const [agentMentionOpen,  setAgentMentionOpen]  = useState(false);
  const [agentMentionQuery, setAgentMentionQuery] = useState("");
  const [agentMentionIndex, setAgentMentionIndex] = useState(0);

  // Slash command state
  const [slashOpen,  setSlashOpen]  = useState(false);
  const [slashQuery, setSlashQuery] = useState("");
  const [slashIndex, setSlashIndex] = useState(0);
  const [pluginCmds, setPluginCmds] = useState<Array<{ cmd: string; desc: string; body: string | null; args: string[] }>>([]);
  // Fetch plugin slash commands for the active session
  useEffect(() => {
    if (!sessionId) { setPluginCmds([]); return; }
    const u = new URLSearchParams({ session_id: sessionId });
    if (projectPath) u.set("project_path", projectPath);
    apiFetch(`/api/runtime/commands?${u}`)
      .then(r => r.ok ? r.json() : [])
      .then((cmds: Array<{ name: string; description: string; body: string; args: string[] }>) => {
        setPluginCmds(cmds.map(c => ({
          cmd: "/" + c.name,
          desc: c.description || `From ${c.name}`,
          body: c.body, args: c.args || [],
        })));
      })
      .catch(() => setPluginCmds([]));
  }, [sessionId, projectPath]);

  const ref        = useRef<HTMLTextAreaElement>(null);
  const mirrorRef  = useRef<HTMLDivElement>(null);
  const fileRef    = useRef<HTMLInputElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  /* close dropdowns on outside click */
  useEffect(() => {
    if (!openDrop) return;
    const h = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node))
        setOpenDrop(null);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [openDrop]);

  /* ESC → stop streaming */
  useEffect(() => {
    if (!streaming) return;
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); onStop?.(); } };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, [streaming, onStop]);

  /* auto-resize textarea */
  const adjust = useCallback(() => {
    const t = ref.current;
    if (!t) return;
    t.style.height = "0px";
    t.style.height = Math.min(t.scrollHeight, 200) + "px";
  }, []);
  useEffect(() => { adjust(); }, [value, adjust]);

  /* ── file handling ──
     Text files are read as PLAIN TEXT (utf-8), not base64. Older
     versions of this component DataURL'd every file regardless of
     type — a 16 KB .txt then landed at the provider as a 22 KB
     base64 string (tokenises poorly: ~1 token per char ≈ 22k
     tokens for what should have been 4-5k of plain text). The
     same 16 KB file attached 3 times then ate the whole 200k
     context window in a single turn. Now:
       text/* / source-code-extensions → readAsText (utf-8 string)
       everything else (image / pdf / bin)  → readAsDataURL (base64)
     The backend branches on mimeType to embed text inline as a
     text block instead of treating it like an image. */
  const isTextLike = (file: File): boolean => {
    if (file.type.startsWith("text/")) return true;
    if (/^(application\/json|application\/xml|application\/yaml|application\/x-yaml)$/.test(file.type)) return true;
    return /\.(txt|md|markdown|json|ya?ml|toml|csv|tsv|log|env|sh|bash|zsh|fish|js|jsx|ts|tsx|mjs|cjs|py|rb|go|rs|java|kt|swift|c|cc|cpp|cxx|h|hh|hpp|hxx|cs|m|mm|css|scss|sass|less|html?|xml|svg|sql|graphql|gql|conf|cfg|ini|dockerfile)$/i.test(file.name);
  };
  const readFile = useCallback((file: File): Promise<Attachment> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      const textMode = isTextLike(file);
      reader.onload = () => {
        if (textMode) {
          // Plain-text path: data is the raw utf-8 string. Backend
          // embeds it as an inline text block (no base64, no image
          // block), so tokenisation stays at the natural ~4 chars
          // per token rate.
          resolve({
            id: crypto.randomUUID(), name: file.name,
            mimeType: file.type || "text/plain",
            data: String(reader.result ?? ""),
            preview: undefined,
          });
        } else {
          const dataUrl = reader.result as string;
          const mimeType = file.type || "application/octet-stream";
          resolve({
            id: crypto.randomUUID(), name: file.name,
            mimeType,
            data: dataUrl.split(",")[1] ?? "",
            preview: mimeType.startsWith("image/") ? dataUrl : undefined,
          });
        }
      };
      reader.onerror = reject;
      if (textMode) reader.readAsText(file);
      else reader.readAsDataURL(file);
    }), []);

  const addFiles = useCallback(async (files: FileList | File[]) => {
    const results = await Promise.all(Array.from(files).slice(0, 5).map(readFile));
    setAttachments(prev => [...prev, ...results].slice(0, 10));
  }, [readFile]);

  const removeAttachment = useCallback((id: string) => {
    setAttachments(prev => prev.filter(a => a.id !== id));
  }, []);

  /* ── @ mention detection ── */
  const detectMention = useCallback((text: string, caret: number): { query: string; start: number } | null => {
    if (caret <= 0) return null;
    let i = caret - 1;
    while (i >= 0) {
      const ch = text[i] ?? "";
      if (ch === "@") {
        const before = i > 0 ? (text[i - 1] ?? "") : "";
        if (i === 0 || /\s/.test(before)) return { query: text.slice(i + 1, caret), start: i + 1 };
        return null;
      }
      if (/\s/.test(ch)) return null;
      i--;
    }
    return null;
  }, []);

  const closeMention = useCallback(() => {
    setMentionOpen(false); setMentionQuery(""); setMentionResults([]); setMentionIndex(0);
    mentionStartRef.current = -1;
  }, []);

  const closeAgentMention = useCallback(() => {
    setAgentMentionOpen(false); setAgentMentionQuery(""); setAgentMentionIndex(0);
    mentionStartRef.current = -1;
  }, []);

  const checkMentionState = useCallback((text: string, caret: number) => {
    const hit = detectMention(text, caret);
    if (!hit) {
      dismissedAtRef.current = -1;
      if (mentionOpen) closeMention();
      if (agentMentionOpen) closeAgentMention();
      return;
    }
    // Agent mention takes priority when agentMentions list is provided
    if (agentMentions && agentMentions.length > 0) {
      if (dismissedAtRef.current === hit.start) return; // stay closed after Escape at same @
      const tokenChanged = mentionStartRef.current !== hit.start;
      mentionStartRef.current = hit.start;
      setAgentMentionQuery(hit.query);
      setAgentMentionOpen(true);
      if (tokenChanged) setAgentMentionIndex(0); // only reset when @ token changes
      return;
    }
    // File mention fallback
    if (!projectPath) return;
    if (dismissedAtRef.current === hit.start) return;
    const tokenChanged = mentionStartRef.current !== hit.start;
    mentionStartRef.current = hit.start;
    setMentionQuery(hit.query); setMentionOpen(true);
    if (tokenChanged) setMentionIndex(0);
  }, [projectPath, agentMentions, detectMention, mentionOpen, agentMentionOpen, closeMention, closeAgentMention]);

  useEffect(() => {
    if (!mentionOpen || !projectPath) return;
    const reqId = ++mentionReqRef.current;
    setMentionLoading(true);
    const t = setTimeout(async () => {
      try {
        const res = await searchProjectFiles(projectPath, mentionQuery, 50);
        if (reqId !== mentionReqRef.current) return;
        setMentionResults(res);
      } catch {
        if (reqId !== mentionReqRef.current) return;
        setMentionResults([]);
      } finally {
        if (reqId === mentionReqRef.current) setMentionLoading(false);
      }
    }, 120);
    return () => clearTimeout(t);
  }, [mentionOpen, mentionQuery, projectPath]);

  useEffect(() => {
    if (mentionIndex >= mentionResults.length)
      setMentionIndex(Math.max(0, mentionResults.length - 1));
  }, [mentionResults, mentionIndex]);

  const pickMention = useCallback((entry: FileSearchEntry) => {
    const start = mentionStartRef.current;
    if (start < 0) { closeMention(); return; }
    const caret = ref.current?.selectionStart ?? value.length;
    const insert = entry.relative + " ";
    const next = value.slice(0, start) + insert + value.slice(caret);
    setValue(next); closeMention();
    setPickedMentions(prev => {
      if (prev.has(entry.relative)) return prev;
      const n = new Set(prev); n.add(entry.relative); return n;
    });
    requestAnimationFrame(() => {
      const t = ref.current;
      if (!t) return;
      const pos = start + insert.length;
      t.focus(); t.setSelectionRange(pos, pos);
    });
  }, [value, closeMention]);

  const pickAgentMention = useCallback((agent: AgentMention) => {
    const start = mentionStartRef.current;
    if (start < 0) { closeAgentMention(); return; }
    const caret = ref.current?.selectionStart ?? value.length;
    // start points to char after @, so value.slice(0, start) includes the @
    const insert = agent.name + " ";
    const next = value.slice(0, start) + insert + value.slice(caret);
    setValue(next); closeAgentMention();
    setPickedMentions(prev => {
      if (prev.has(agent.name)) return prev;
      const n = new Set(prev); n.add(agent.name); return n;
    });
    requestAnimationFrame(() => {
      const t = ref.current;
      if (!t) return;
      const pos = start + insert.length;
      t.focus(); t.setSelectionRange(pos, pos);
    });
  }, [value, closeAgentMention]);

  // Filtered agent list based on current query
  const filteredAgents = agentMentions
    ? (agentMentionQuery
        ? agentMentions.filter(a => a.name.toLowerCase().includes(agentMentionQuery.toLowerCase()))
        : agentMentions)
    : [];

  // Set of names eligible for the @mention chip background — picked
  // tokens (committed via the popover) plus any currently-known agent
  // name (so the chip survives a re-render even when the user didn't
  // pick the token in *this* mount; e.g. drafts restored from storage).
  const validMentionsSet = useMemo(() => {
    const s = new Set(pickedMentions);
    if (agentMentions) for (const a of agentMentions) s.add(a.name);
    return s;
  }, [pickedMentions, agentMentions]);

  // Clamp agentMentionIndex when filtered list shrinks (e.g. user types more chars)
  useEffect(() => {
    if (filteredAgents.length > 0 && agentMentionIndex >= filteredAgents.length)
      setAgentMentionIndex(filteredAgents.length - 1);
  }, [filteredAgents.length, agentMentionIndex]);

  /* ── slash command detection ── */
  const detectSlash = useCallback((text: string, caret: number): string | null => {
    const before = text.slice(0, caret);
    const m = before.match(/(^|\n)(\/\S*)$/);
    return m ? (m[2] ?? null) : null;
  }, []);

  // Merge built-in commands (from the provider-aware registry) with
  // plugin-contributed ones; dedupe by cmd. Plugins appear first so a plugin
  // can override a builtin if it ships the same name.
  const builtinCmds = useMemo<Array<{ cmd: string; desc: string; body: null; intent: string; providerCmd?: string }>>(
    () => commandsForContext("session-chat", tool).map((c: SlashCmdDef) => ({
      cmd: c.cmd,
      desc: c.desc,
      body: null,
      intent: c.intent,
      providerCmd: c.providerCmd,
    })),
    [tool],
  );
  // OpenCode advertises its slash commands at runtime over ACP
  // (`available_commands_update`); ws-manager stores them per session. Merge
  // them in as plain insert-the-text commands (body: null) so the CLI
  // receives `/<name>` as prompt text.
  const dynCmds = useChatStore((s) => (sessionId ? s.dynamicCommands[sessionId] : undefined));
  const openCodeCmds = useMemo<Array<{ cmd: string; desc: string; body: null }>>(
    () =>
      tool === "opencode" && dynCmds
        ? dynCmds.map((c) => ({ cmd: `/${c.name}`, desc: c.description, body: null }))
        : [],
    [tool, dynCmds],
  );
  const slashAll = (() => {
    const seen = new Set<string>();
    const out: Array<{ cmd: string; desc: string; body: string | null; args?: string[]; intent?: string; providerCmd?: string }> = [];
    for (const c of [...pluginCmds, ...builtinCmds, ...openCodeCmds]) {
      if (seen.has(c.cmd)) continue;
      seen.add(c.cmd); out.push(c);
    }
    return out;
  })();
  const slashFiltered = slashQuery
    ? slashAll.filter(c => c.cmd.startsWith(slashQuery))
    : slashAll;

  const checkSlashState = useCallback((text: string, caret: number) => {
    const hit = detectSlash(text, caret);
    if (!hit) { if (slashOpen) setSlashOpen(false); return; }
    setSlashQuery(hit); setSlashOpen(true); setSlashIndex(0);
  }, [detectSlash, slashOpen]);

  const pickSlash = useCallback((cmd: string) => {
    // Plugin-contributed commands have a non-null body — expand it (replacing
    // the entire input contents, preserving any trailing args after the
    // typed `/cmd <args>`). Built-in commands keep the prior behavior of
    // simply inserting the command text.
    const plugin = pluginCmds.find(c => c.cmd === cmd);
    if (plugin && plugin.body) {
      // Capture args typed after the slash command (positional, space-separated)
      const caret = ref.current?.selectionStart ?? value.length;
      const before = value.slice(0, caret);
      const m = before.match(/(^|\n)(\/\S+)(\s+(.*))?$/);
      const argsText = (m && m[4]) ? m[4] : "";
      const argsArr = argsText.length > 0 ? argsText.split(/\s+/) : [];
      let body = plugin.body;
      // Substitute {{argName}} from frontmatter args list, in order.
      (plugin.args || []).forEach((argName, i) => {
        body = body!.replaceAll(`{{${argName}}}`, argsArr[i] ?? "");
      });
      // Also support {{args}} → all args joined.
      body = body.replaceAll("{{args}}", argsText);
      setValue(body);
      setSlashOpen(false);
      requestAnimationFrame(() => ref.current?.focus());
      return;
    }
    const caret = ref.current?.selectionStart ?? value.length;
    const before = value.slice(0, caret);
    const next = before.replace(/(^|\n)(\/\S*)$/, `$1${cmd} `) + value.slice(caret);
    setValue(next); setSlashOpen(false);
    requestAnimationFrame(() => ref.current?.focus());
  }, [value, pluginCmds]);

  /** Tries to intercept a Fleetify-side slash command before it reaches
   *  the underlying CLI. Returns true if the command was handled (and
   *  the caller must skip onSend), false otherwise. Handlers fire-and-
   *  forget their async API calls and push their result into the chat
   *  transcript as a ResourceCardBlock — see message-content's
   *  renderResourceCard for the dispatch. */
  const handleSlashIntent = useCallback((t: string): boolean => {
    if (!sessionId || !tool) return false;
    if (!t.startsWith("/")) return false;
    const head = t.split(/\s+/)[0] ?? "";

    const push = (
      role: "user" | "assistant",
      content: Array<{ type: string;[k: string]: unknown }>,
    ) => {
      useChatStore.getState().addMessage(sessionId, {
        id: crypto.randomUUID(),
        role,
        content: content as unknown as Parameters<ReturnType<typeof useChatStore.getState>["addMessage"]>[1]["content"],
        timestamp: new Date().toISOString(),
      });
    };
    const echoUser = () => push("user", [{ type: "text", text: t }]);
    const pushCard = (card_kind: string, data: unknown) =>
      push("assistant", [{ type: "resource_card", card_kind, data }]);
    const pushInfo = (title: string, message: string, tone: "info" | "warn" | "error" = "info") =>
      pushCard("info", { title, message, tone });

    const fetchAndPushCard = (path: string, cardKind: string, extra: Record<string, unknown> = {}) => {
      apiFetch(path)
        .then(async (r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text().catch(() => "")}`);
          return r.json();
        })
        .then((data) => pushCard(cardKind, { ...data, provider: tool, ...extra }))
        .catch((e) => pushInfo("Request failed", String(e instanceof Error ? e.message : e), "error"));
    };

    /* /skills, /hooks, /commands, /prompts ─ inspector endpoints */
    if (head === "/skills") {
      echoUser();
      fetchAndPushCard(`/api/sessions/${sessionId}/skills`, "skills");
      return true;
    }
    if (head === "/hooks") {
      echoUser();
      fetchAndPushCard(`/api/sessions/${sessionId}/hooks`, "hooks");
      return true;
    }
    if (head === "/commands" || head === "/prompts") {
      echoUser();
      const cardKind = head === "/prompts" ? "prompts" : "commands";
      fetchAndPushCard(`/api/sessions/${sessionId}/commands`, cardKind);
      return true;
    }

    /* /usage ─ combines account overview with this session's bulk row */
    if (head === "/usage") {
      echoUser();
      Promise.all([
        apiFetch("/api/sessions/stats/overview").then((r) => r.ok ? r.json() : null).catch(() => null),
        apiFetch(`/api/sessions/stats/bulk?ids=${encodeURIComponent(sessionId)}`).then((r) => r.ok ? r.json() : null).catch(() => null),
      ]).then(([overview, bulk]) => {
        const bulkRow = bulk && typeof bulk === "object" && (bulk as Record<string, unknown>)[sessionId];
        const br = (bulkRow ?? {}) as Record<string, unknown>;
        const ov = (overview ?? {}) as Record<string, unknown>;
        pushCard("usage", {
          session_cost_usd: typeof br.cost_usd === "number" ? br.cost_usd : (typeof br.total_cost_usd === "number" ? br.total_cost_usd : undefined),
          session_input_tokens: typeof br.input_tokens === "number" ? br.input_tokens : undefined,
          session_output_tokens: typeof br.output_tokens === "number" ? br.output_tokens : undefined,
          account_cost_usd: typeof ov.total_cost_usd === "number" ? ov.total_cost_usd : undefined,
          account_messages: typeof ov.total_messages === "number" ? ov.total_messages : undefined,
          account_sessions: typeof ov.total_sessions === "number" ? ov.total_sessions : undefined,
          model: typeof br.model === "string" ? br.model : undefined,
        });
      });
      return true;
    }

    /* /mcp ─ reads the in-memory MCP store; triggers a refresh in the
       background so the next /mcp call has fresh probe results */
    if (head === "/mcp") {
      echoUser();
      const servers = useMCPStore.getState().servers;
      const mapped = servers.map((s) => ({
        name: s.name,
        status: s.status?.status,
        tool_count: s.status?.tool_count,
        error: s.status?.error ?? undefined,
      }));
      pushCard("mcp", { servers: mapped });
      useMCPStore.getState().refresh().catch(() => {});
      return true;
    }

    /* /init ─ writes CLAUDE.md / GEMINI.md / AGENTS.md from a Fleetify
       template. window.confirm for the overwrite branch. */
    if (head === "/init") {
      echoUser();
      void (async () => {
        const post = (overwrite: boolean) => apiFetch(`/api/sessions/${sessionId}/init-context`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ overwrite }),
        });
        let res = await post(false);
        if (res.status === 409) {
          const body = await res.json().catch(() => ({}));
          const detail = (body as { detail?: { path?: string } }).detail;
          const filename = detail?.path?.split(/[\\/]/).pop() ?? "the agent context file";
          const ok = window.confirm(`${filename} already exists. Overwrite with the Fleetify starter template?`);
          if (!ok) {
            pushInfo("Cancelled", "Existing file kept.", "info");
            return;
          }
          res = await post(true);
        }
        if (!res.ok) {
          const err = await res.text().catch(() => `HTTP ${res.status}`);
          pushInfo("Init failed", err, "error");
          return;
        }
        const data = await res.json();
        pushCard("init_done", data);
      })();
      return true;
    }

    /* /effort [level] ─ persisted via PATCH; bridges read it on next
       spawn. No-arg form prints usage. */
    if (head === "/effort") {
      echoUser();
      const arg = t.slice(head.length).trim().toLowerCase();
      const validEfforts = new Set<Effort>(EFFORTS.map((e) => e.id));
      if (!arg) {
        pushInfo("Effort", `Usage: /effort <${EFFORTS.join("|")}>. Current: ${effort}.`);
        return true;
      }
      if (!validEfforts.has(arg as Effort)) {
        pushInfo("Unknown effort", `Pick one of: ${EFFORTS.join(", ")}.`, "warn");
        return true;
      }
      const next = arg as Effort;
      apiUpdateSession(sessionId, { effort: next })
        .then(() => {
          setEffortLocal(next);
          onEffortChange?.(next);
          pushInfo("Effort updated", `Reasoning effort set to ${next}. Takes effect on the next turn.`);
        })
        .catch((e) => pushInfo("Update failed", String(e instanceof Error ? e.message : e), "error"));
      return true;
    }

    /* /permissions [mode] ─ same PATCH path the bottom-left picker uses.
       Codex/Gemini bridges respawn on next turn, so warn the user. */
    if (head === "/permissions") {
      echoUser();
      const arg = t.slice(head.length).trim();
      const VALID = new Set(["default", "acceptEdits", "plan", "auto", "bypassPermissions"]);
      if (!arg) {
        pushInfo("Permissions", "Usage: /permissions <default|acceptEdits|plan|auto|bypassPermissions>.");
        return true;
      }
      if (!VALID.has(arg)) {
        pushInfo("Unknown mode", "Pick one of: default, acceptEdits, plan, auto, bypassPermissions.", "warn");
        return true;
      }
      apiUpdateSession(sessionId, { permission_mode: arg })
        .then(() => {
          const respawnHint = (tool === "codex" || tool === "gemini")
            ? " Codex/Gemini pick this up on the next spawn — stop and restart the session to apply now."
            : "";
          pushInfo("Permissions updated", `Mode set to ${arg}.${respawnHint}`);
          // mirror to local store so the bottom-left picker reflects it
          useAppStore.getState().updateSession?.(sessionId, { permission_mode: arg });
        })
        .catch((e) => pushInfo("Update failed", String(e instanceof Error ? e.message : e), "error"));
      return true;
    }

    return false;
  }, [sessionId, tool, effort, setEffortLocal, onEffortChange]);

  /** Dispatches the actual send. Bypasses Fleet refine — used both
   *  by the post-refine "Send refined" / "Send original" buttons and
   *  by the direct submit path when Fleet is off / control-center /
   *  the refine call no-op'd. */
  const dispatchSend = useCallback((text: string, atts: Attachment[]) => {
    const t = text.trim();
    if (!t && atts.length === 0) return;
    // App-owned slash commands intercepted before they hit the CLI.
    // handleSlashIntent returns true when it handled the command — we
    // clear the input and exit without invoking onSend.
    if (handleSlashIntent(t)) {
      setValue(""); setAttachments([]);
      setPendingRefine(null);
      setEnhanceUndo(null); setEnhanceToast(null);
      if (ref.current) ref.current.style.height = "0px";
      return;
    }
    if (t && historyRef.current[0] !== t) historyRef.current.unshift(t);
    historyIdxRef.current = -1;
    draftRef.current = "";
    // Compaction routing. The compactor is now app-owned and provider-
    // agnostic — `/compact` (and the Gemini-flavour alias `/compress`)
    // route through the same backend service that summarises the
    // transcript with the staff session's model and hard-deletes the
    // pre-compact messages. Tagging the wire payload with
    // [fleet:compaction] flags it for the chat router's short-circuit.
    const isCompactionCmd = t === "/compact" || t === "/compress";
    if (isCompactionCmd && sessionId) {
      // ── Pre-flight threshold check ──
      // Mirrors the backend floor (services/compactor.py MIN_MESSAGE_COUNT /
      // MIN_CHAR_COUNT). The backend is authoritative — but rejecting here
      // skips a wasted WS round-trip and gives instant feedback instead of
      // a 1-2s "Compacting…" flash followed by an error.
      const COMPACT_MIN_MESSAGES = 6;
      const COMPACT_MIN_CHARS = 4000;
      const cs = useChatStore.getState().sessions[sessionId];
      const msgs = cs?.messages ?? [];
      const totalChars = msgs.reduce((sum, m) => {
        return sum + m.content.reduce((s, b) => {
          if ((b as { type: string }).type === "text") {
            return s + ((b as { text?: string }).text?.length ?? 0);
          }
          return s;
        }, 0);
      }, 0);
      if (msgs.length < COMPACT_MIN_MESSAGES || totalChars < COMPACT_MIN_CHARS) {
        const reason = msgs.length < COMPACT_MIN_MESSAGES
          ? `Need at least ${COMPACT_MIN_MESSAGES} messages — have ${msgs.length}.`
          : `Need at least ${COMPACT_MIN_CHARS} chars of conversation — have ${totalChars}.`;
        // Push an optimistic "/compact" row so the chat behaves like a
        // normal send: messages array grows → chat-view's "scroll on
        // new message" effect runs → the rejection feedback ends up
        // in view instead of off-screen above the input. Local-only;
        // on next reload it vanishes (the backend never saw this turn).
        useChatStore.getState().addMessage(sessionId, {
          id: crypto.randomUUID(),
          role: "user",
          content: [{ type: "text", text: t }],
          timestamp: new Date().toISOString(),
        });
        // Surface as a failed compaction pill so the feedback uses the
        // same surface a real failure would. Start → fail atomically so
        // the user never sees a fake "Compacting…" beat.
        useChatStore.getState().startCompactionPill(sessionId, {
          provider: tool ?? "claude",
          command: t,
        });
        useChatStore.getState().failCompactionPill(sessionId, reason);
        setValue(""); setAttachments([]);
        setPendingRefine(null);
        setEnhanceUndo(null); setEnhanceToast(null);
        if (ref.current) ref.current.style.height = "0px";
        return;
      }
      // Clear any stale finished pill so the new pill starts cleanly.
      useChatStore.getState().clearCompactionPill(sessionId);
      onSend(`[fleet:compaction]${t}`, undefined);
    } else {
      // A fresh non-compaction message dismisses a lingering done/failed
      // pill — the result was visible long enough to read; now make
      // room for the new turn.
      if (sessionId) {
        const pill = useChatStore.getState().sessions[sessionId]?.compactionPill;
        if (pill && pill.state !== "running") {
          useChatStore.getState().clearCompactionPill(sessionId);
        }
      }
      onSend(t, atts.length > 0 ? atts : undefined);
    }
    setValue(""); setAttachments([]);
    setPendingRefine(null);
    setEnhanceUndo(null); setEnhanceToast(null);
    if (ref.current) ref.current.style.height = "0px";
  }, [onSend, tool, sessionId]);

  /* ── submit ──
   * When Fleet co-pilot is active (agent session, not turned off),
   * the submit first runs the prompt through the Haiku-tier refiner.
   * If the refiner returns a meaningfully different version we stash
   * it in pendingRefine and the input slot flips to the refine card
   * — the user picks Send refined / Send original / Edit. On no_op
   * or any failure we fall straight through to the legacy send path
   * so Fleet is never in the way of getting a message out. */
  const submit = useCallback(() => {
    if (locked) return;
    if (streaming) { onStop?.(); return; }
    if (refining) return; // Already refining — ignore double-Enter
    if (pendingRefine) {
      // Refine card is on screen; treat Enter as "Send refined".
      dispatchSend(pendingRefine.refined, pendingRefine.attachments);
      return;
    }
    const t = value.trim();
    if (!t && attachments.length === 0) return;
    if (disabled) return;

    if (!fleetActive) {
      dispatchSend(t, attachments);
      return;
    }

    // Fleet path — refine, then either auto-send (no-op) or surface
    // the refine card. Short prompts (< 8 chars or one word) skip
    // the refine — they're commands like "ok", "stop", "y", "go on"
    // that the refiner would either no-op or over-engineer.
    const trivialPrompt = t.length < 8 || !/\s/.test(t);
    if (trivialPrompt) {
      dispatchSend(t, attachments);
      return;
    }

    const snapshotAtts = attachments;
    setRefining(true);
    enhancePrompt(t, {
      projectPath: projectPath ?? undefined,
      tool: tool ?? null,
      model: model ?? null,
    })
      .then(result => {
        // Approximate per-call cost — Haiku one-shot ~$0.0005. Real
        // accounting can come from backend cost_usd later.
        if (sessionId) recordCost(sessionId, 0.0005);
        const refined = (result.enhanced || "").trim();
        if (result.no_op || !refined || refined === t) {
          // Refiner had nothing to add — send the original as-is.
          dispatchSend(t, snapshotAtts);
          return;
        }
        setPendingRefine({
          original: t,
          refined,
          rationale: result.rationale ?? null,
          attachments: snapshotAtts,
        });
      })
      .catch(() => {
        // Refiner unreachable / errored — fail-soft: send original
        // so the user is never blocked by Fleet on a transient.
        dispatchSend(t, snapshotAtts);
      })
      .finally(() => setRefining(false));
  }, [value, disabled, streaming, locked, onStop, attachments, fleetActive, refining, pendingRefine, dispatchSend, projectPath, tool, model, sessionId, recordCost]);

  /* Refine-card actions */
  const confirmRefined = useCallback(() => {
    if (!pendingRefine) return;
    dispatchSend(pendingRefine.refined, pendingRefine.attachments);
  }, [pendingRefine, dispatchSend]);

  const sendOriginal = useCallback(() => {
    if (!pendingRefine) return;
    dispatchSend(pendingRefine.original, pendingRefine.attachments);
  }, [pendingRefine, dispatchSend]);

  const editRefined = useCallback(() => {
    if (!pendingRefine) return;
    setValue(pendingRefine.refined);
    setAttachments(pendingRefine.attachments);
    setPendingRefine(null);
    requestAnimationFrame(() => {
      ref.current?.focus();
      if (ref.current) {
        ref.current.style.height = "0px";
        ref.current.style.height = `${Math.min(220, ref.current.scrollHeight)}px`;
      }
    });
  }, [pendingRefine]);

  const cancelRefine = useCallback(() => {
    if (!pendingRefine) return;
    // Restore the user's draft so they can keep editing. Refine
    // ditched without sending.
    setValue(pendingRefine.original);
    setAttachments(pendingRefine.attachments);
    setPendingRefine(null);
    requestAnimationFrame(() => {
      ref.current?.focus();
      if (ref.current) {
        ref.current.style.height = "0px";
        ref.current.style.height = `${Math.min(220, ref.current.scrollHeight)}px`;
      }
    });
  }, [pendingRefine]);

  // ── Fleet decision card → "Answer below" ──
  // The decision card (ask kind) dispatches a `fleet:focus-input`
  // event with the question text. We pre-fill the textarea with it
  // so the user can edit / append before sending. Same channel the
  // EmptyFleetWelcome cards use to deep-link into the input.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ text?: string }>).detail;
      const text = detail?.text;
      if (typeof text !== "string") return;
      setValue(prev => prev ? `${prev}\n${text}` : text);
      requestAnimationFrame(() => {
        if (ref.current) {
          ref.current.focus();
          ref.current.style.height = "0px";
          ref.current.style.height = `${Math.min(220, ref.current.scrollHeight)}px`;
        }
      });
    };
    window.addEventListener("fleet:focus-input", handler);
    return () => window.removeEventListener("fleet:focus-input", handler);
  }, []);

  /** Wand button handler — routes through the SAME WS bridge the
   *  chat itself uses, so the rewrite is produced by whatever CLI
   *  the session is wired to (Claude / Codex / Gemini). The flow:
   *
   *  1. wsManager.enhance() sends `[fleet:enhance-prompt]\n…` via WS
   *  2. backend strips the marker, runs the agent normally, but
   *     skips DB persist on both user prompt and assistant reply
   *  3. backend emits `enhance_done` with the rewrite text on stop
   *  4. ws-manager swallows the streaming events for the duration
   *     so they never appear in chat history; resolves a promise
   *     with the final text
   *
   *  Fail-soft: any error path keeps the user's draft intact and
   *  surfaces a "try again" toast. */
  const handleEnhance = useCallback(async () => {
    const t = value.trim();
    if (!t || enhancing || disabled || streaming || locked) return;
    if (!sessionId) {
      setEnhanceToast("No active session");
      return;
    }
    setEnhancing(true);
    setEnhanceToast(null);
    try {
      const rewrite = await wsManager.enhance(sessionId, t);
      const cleaned = rewrite.trim().replace(/^["'`]|["'`]$/g, "").trim();
      if (!cleaned || cleaned === "__NOOP__" || cleaned.toUpperCase() === "NO-OP") {
        setEnhanceToast("Looks good as is");
      } else if (cleaned === t) {
        setEnhanceToast("Looks good as is");
      } else {
        setEnhanceUndo(t);
        setValue(cleaned);
        // Re-grow the textarea to fit the rewrite.
        requestAnimationFrame(() => {
          if (ref.current) {
            ref.current.style.height = "0px";
            ref.current.style.height = `${Math.min(220, ref.current.scrollHeight)}px`;
          }
        });
      }
    } catch (err) {
      // Surface the actual failure rather than the misleading
      // "Looks good as is" — the user wants to know when the
      // CLI couldn't be reached or the request timed out.
      const msg = err instanceof Error ? err.message : "Enhance failed";
      setEnhanceToast(msg.includes("timed out") ? "Enhance timed out" : "Enhance unavailable, try again");
    } finally {
      setEnhancing(false);
    }
  }, [value, enhancing, disabled, streaming, locked, sessionId]);

  /** Undo restores the pre-enhance draft. The chip auto-hides after
   *  6 s; the keyboard shortcut (⌘Z while focused on input) hits
   *  the same handler. */
  const handleUndoEnhance = useCallback(() => {
    if (!enhanceUndo) return;
    setValue(enhanceUndo);
    setEnhanceUndo(null);
    setEnhanceToast(null);
    requestAnimationFrame(() => {
      if (ref.current) {
        ref.current.style.height = "0px";
        ref.current.style.height = `${Math.min(220, ref.current.scrollHeight)}px`;
      }
    });
  }, [enhanceUndo]);

  // Auto-hide the Undo chip + toast after 6 s.
  useEffect(() => {
    if (!enhanceUndo && !enhanceToast) return;
    const t = setTimeout(() => {
      setEnhanceUndo(null);
      setEnhanceToast(null);
    }, 6000);
    return () => clearTimeout(t);
  }, [enhanceUndo, enhanceToast]);

  /* ── drag & drop ── */
  const onDragOver  = useCallback((e: React.DragEvent) => { e.preventDefault(); setDragging(true); }, []);
  const onDragLeave = useCallback(() => setDragging(false), []);
  const onDrop      = useCallback((e: React.DragEvent) => {
    e.preventDefault(); setDragging(false);
    if (e.dataTransfer.files.length > 0) addFiles(e.dataTransfer.files);
  }, [addFiles]);

  /* ── derived ── */
  const hasText    = value.trim().length > 0;
  const canSend    = (hasText || attachments.length > 0) && !disabled && !streaming && !locked;
  const btnActive  = !locked && (streaming || canSend);
  // Resolve the chip face (provider icon + label) via the shared resolver
  // against the SAME groups the dropdown uses — identical logic to the
  // SessionToolbar chip, so the two never disagree. `fmtModel` remains the
  // last-resort label for ids not present in any group (rare cold-start).
  const { dispatchTool: chipDispatchTool, label: chipLabel } = resolveModelChip(
    pickerGroups,
    tool ?? "claude",
    model ?? null,
  );
  const modelLabel = model && chipLabel === model ? fmtModel(model, tool) : chipLabel;

  return (
    <div style={{ flexShrink: 0, padding: "0 16px 16px" }} ref={wrapperRef}>
      <div data-tour="chat-input" style={{ maxWidth: 900, margin: "0 auto", position: "relative" }}>

        {/* @ mention popup — file search */}
        {mentionOpen && projectPath && (
          <FileMentionPopup
            query={mentionQuery} results={mentionResults}
            loading={mentionLoading} activeIndex={mentionIndex}
            onHover={setMentionIndex} onPick={pickMention}
          />
        )}

        {/* @ mention popup — agent + folder picker */}
        {agentMentionOpen && filteredAgents.length > 0 && (
          <div style={{
            position: "absolute", bottom: "calc(100% + 6px)", left: 0,
            minWidth: 260, maxWidth: 340, zIndex: 50,
            background: "var(--popover)", border: "1px solid var(--c-brd)",
            borderRadius: 9, padding: "3px 0",
            boxShadow: "0 16px 40px rgba(0,0,0,0.55)",
          }}>
            {/* ── Agents section ── */}
            {filteredAgents.some(a => (a.kind ?? "agent") === "agent") && (
              <>
                <div style={{ padding: "5px 10px 3px", fontSize: 10.5, color: "var(--c-dim)", fontWeight: 500 }}>
                  Agents
                </div>
                {filteredAgents.filter(a => (a.kind ?? "agent") === "agent").map((agent) => {
                  const globalIdx = filteredAgents.indexOf(agent);
                  const st = agent.status;
                  const isRunning  = st === "running";
                  const isWaiting  = st === "waiting";
                  const isStarting = st === "starting";
                  const isSelected = globalIdx === agentMentionIndex;
                  const projectFolder = folderName(agent.project_path) ?? "";
                  return (
                    <button key={agent.id}
                      onClick={() => pickAgentMention(agent)}
                      onMouseEnter={() => setAgentMentionIndex(globalIdx)}
                      style={{
                        display: "flex", alignItems: "center", gap: 8, width: "100%",
                        padding: "5px 10px", border: "none", cursor: "pointer", textAlign: "left",
                        background: isSelected ? "var(--c-srf)" : "none",
                      }}
                    >
                      {/* Status indicator */}
                      <span style={{ width: 14, height: 14, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
                        {isRunning ? (
                          <span style={{ display: "flex", gap: 2 }}>
                            {[0,1,2].map(j => (
                              <span key={j} style={{ width: 3, height: 3, borderRadius: "50%", background: "var(--c-high)", display: "block", animation: `dot-seq 1.4s ease-in-out ${j*0.22}s infinite` }} />
                            ))}
                          </span>
                        ) : isWaiting ? (
                          <span style={{ display: "flex", gap: 2 }}>
                            {[0,1].map(j => (
                              <span key={j} style={{ width: 2.5, height: 7, borderRadius: 2, background: "#fb923c", display: "block", animation: `pause-bar 1.8s ease-in-out ${j*0.25}s infinite`, transformOrigin: "center" }} />
                            ))}
                          </span>
                        ) : isStarting ? (
                          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" style={{ flexShrink: 0 }}>
                            <circle cx="5" cy="5" r="3.5" stroke="rgba(var(--fg-rgb),0.45)" strokeWidth="1.5" strokeDasharray="3 2" strokeLinecap="round" style={{ transformOrigin: "5px 5px", animation: "ring-spin 1.2s linear infinite" }} />
                          </svg>
                        ) : (
                          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" style={{ flexShrink: 0 }}>
                            <circle cx="5" cy="5" r="3.5" stroke="rgba(var(--fg-rgb),0.22)" strokeWidth="1.4" strokeDasharray="2.5 2.5" strokeLinecap="round" style={{ transform: "rotate(-90deg)", transformOrigin: "5px 5px" }} />
                          </svg>
                        )}
                      </span>

                      {/* Agent name */}
                      <span style={{ flex: 1, fontSize: 12.5, fontWeight: 500, color: "var(--c-high)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {agent.name}
                      </span>

                      {/* Right: folder name OR enter hint */}
                      {isSelected ? (
                        <span style={{ fontSize: 9, color: "var(--c-dim)", flexShrink: 0, opacity: 0.7 }}>↵</span>
                      ) : projectFolder ? (
                        <span style={{ fontSize: 10.5, color: "var(--c-ghost)", flexShrink: 0, maxWidth: 80, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {projectFolder}
                        </span>
                      ) : (
                        <span style={{ fontSize: 11, color: "var(--c-ghost)", flexShrink: 0 }}>
                          {isRunning ? "running" : isWaiting ? "waiting" : isStarting ? "starting" : "idle"}
                        </span>
                      )}
                    </button>
                  );
                })}
              </>
            )}

            {/* ── Folders section ── */}
            {filteredAgents.some(a => a.kind === "folder") && (
              <>
                {filteredAgents.some(a => (a.kind ?? "agent") === "agent") && (
                  <div style={{ height: 1, background: "var(--c-brd)", margin: "3px 0", opacity: 0.6 }} />
                )}
                <div style={{ padding: "5px 10px 3px", fontSize: 10.5, color: "var(--c-dim)", fontWeight: 500 }}>
                  Folders
                </div>
                {filteredAgents.filter(a => a.kind === "folder").map((folder) => {
                  const globalIdx = filteredAgents.indexOf(folder);
                  const isSelected = globalIdx === agentMentionIndex;
                  return (
                    <button key={folder.id}
                      onClick={() => pickAgentMention(folder)}
                      onMouseEnter={() => setAgentMentionIndex(globalIdx)}
                      style={{
                        display: "flex", alignItems: "center", gap: 8, width: "100%",
                        padding: "5px 10px", border: "none", cursor: "pointer", textAlign: "left",
                        background: isSelected ? "var(--c-srf)" : "none",
                      }}
                    >
                      <span style={{ width: 14, height: 14, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--c-ghost)" }}>
                        <FolderOpen size={11} />
                      </span>
                      <span style={{ flex: 1, fontSize: 12.5, fontWeight: 500, color: "var(--c-high)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {folder.name}
                      </span>
                      {isSelected ? (
                        <span style={{ fontSize: 9, color: "var(--c-dim)", flexShrink: 0, opacity: 0.7 }}>↵</span>
                      ) : (
                        <span style={{ fontSize: 10.5, color: "var(--c-ghost)", flexShrink: 0, maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {folder.project_path}
                        </span>
                      )}
                    </button>
                  );
                })}
              </>
            )}

            <div style={{ height: 3 }} />
          </div>
        )}

        {/* / slash command popup */}
        {slashOpen && slashFiltered.length > 0 && (
          <div style={{
            position: "absolute", bottom: "calc(100% + 6px)", left: 0,
            minWidth: 270, zIndex: 50,
            background: "var(--popover)", border: "1px solid var(--c-brd)",
            borderRadius: 9, padding: "3px 0",
            boxShadow: "0 16px 40px rgba(0,0,0,0.5)",
          }}>
            <div style={{ padding: "5px 10px 3px", fontSize: 10.5, color: "var(--c-dim)", fontWeight: 500 }}>
              Commands
            </div>
            {slashFiltered.map((c, i) => (
              <button key={c.cmd} onClick={() => pickSlash(c.cmd)}
                onMouseEnter={() => setSlashIndex(i)}
                style={{
                  display: "flex", alignItems: "baseline", gap: 10, width: "100%",
                  padding: "5px 10px", border: "none", cursor: "pointer", textAlign: "left",
                  background: i === slashIndex ? "var(--c-srf)" : "none",
                }}>
                <span style={{ fontSize: 12.5, fontWeight: 500, color: "var(--c-high)", fontFamily: "'SF Mono','Menlo','Consolas',monospace", flexShrink: 0 }}>
                  {c.cmd}
                </span>
                <span style={{ fontSize: 11.5, color: "var(--c-dim)" }}>{c.desc}</span>
              </button>
            ))}
            <div style={{ height: 3 }} />
          </div>
        )}

        {/* Model + Effort dropdown — the shared three-column
            UnifiedModelPicker. Rendered HERE as a child of the compose
            wrapper (the maxWidth:900, position:relative box) — NOT next to
            the model button — so it opens far-LEFT and ABOVE the textarea,
            using the same `left:0; bottom:calc(100%+6px)` anchor as the
            @mention / slash popups above. Picking a cross-provider model
            PATCHes the session's tool so the toolbar logo flips to match. */}
        {openDrop === "model" && (
          <UnifiedModelPicker
            tool={tool ?? "claude"}
            model={model ?? null}
            effort={effort as UMEffort}
            groups={pickerGroups}
            onPickModel={(groupId, modelId) => {
              const dispatchTool = resolveDispatchTool(groupId);
              const tid = dispatchTool as import("@/types/session").AgentTool;
              if (sessionId) {
                // Active session: change tool + model (cross-provider) or
                // just model (same-provider). `onModelChange` covers the
                // same-provider path via the parent's handleModelChange.
                if (dispatchTool !== tool) {
                  apiUpdateSession(sessionId, { tool: tid, model_name: modelId }).catch(() => {});
                  useAppStore.getState().updateSession(sessionId, { tool: tid, model_name: modelId });
                } else {
                  onModelChange?.(modelId);
                }
              } else {
                // Composer / Control Center — no session row exists yet.
                // Write the pick into the open composer so `commitComposer`
                // creates the new session with the right (tool, model)
                // pair. Without this branch, picks vanished into the
                // void because `onModelChange` is undefined when
                // `activeSessionId` is null.
                useAppStore.getState().setComposerField({ tool: tid, modelName: modelId });
              }
            }}
            onPickEffort={(e) => setEffort(e)}
            onClose={() => setOpenDrop(null)}
            anchor="bottom"
          />
        )}


        {/* Hidden file input */}
        <input ref={fileRef} type="file" multiple
          accept="image/*,.pdf,.txt,.md,.json,.csv,.py,.js,.ts,.jsx,.tsx,.html,.css,.yaml,.yml"
          style={{ display: "none" }}
          onChange={e => { if (e.target.files) addFiles(e.target.files); e.target.value = ""; }}
        />

        {/* ── Slot above ──
            Caller-provided content (e.g. permission card) rendered as
            part of the input cluster so it visually attaches to the
            box below. */}
        {slotAbove}

        {/* ── Fleet refine card ──
            Shown after the Haiku-tier refiner has rewritten the
            user's prompt and we're waiting for the user to choose
            Send refined / Send original / Edit. The original card
            visually attaches to the chat input below by sharing the
            same width + sitting flush. */}
        {pendingRefine && (
          <div style={{
            marginBottom: 8,
            padding: "10px 12px",
            background: "var(--c-srf)",
            border: "1px solid var(--c-brd)",
            borderRadius: 9,
            display: "flex", flexDirection: "column", gap: 8,
            animation: "fleet-pane-in 0.18s cubic-bezier(0.22, 1, 0.36, 1) both",
          }}>
            {/* Header row */}
            <div style={{
              display: "flex", alignItems: "center", gap: 6,
              fontSize: 11.5, fontWeight: 600,
              color: "var(--c-low)",
            }}>
              <span style={{
                fontFamily: "'Geist Variable', 'Geist', system-ui, sans-serif",
                fontSize: 11, fontWeight: 700,
                letterSpacing: "-0.005em",
                color: "var(--c-high)",
              }}>Fleet</span>
              <span style={{ color: "var(--c-dim)" }}>refined your prompt</span>
              <div style={{ flex: 1 }} />
              <button
                onClick={cancelRefine}
                title="Discard refine"
                style={{
                  width: 18, height: 18, borderRadius: 4,
                  display: "inline-flex", alignItems: "center", justifyContent: "center",
                  background: "none", border: "none", cursor: "pointer",
                  color: "var(--c-ghost)",
                }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = "var(--c-med)"; }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = "var(--c-ghost)"; }}
              >
                <X size={11} />
              </button>
            </div>

            {/* Original */}
            <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
              <span style={{
                fontSize: 10, fontWeight: 600,
                color: "var(--c-ghost)",
                letterSpacing: "0.05em", textTransform: "uppercase",
              }}>Original</span>
              <div style={{
                fontSize: 12.5, lineHeight: 1.45,
                color: "var(--c-dim)",
                whiteSpace: "pre-wrap", wordBreak: "break-word",
              }}>
                {pendingRefine.original}
              </div>
            </div>

            {/* Refined */}
            <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
              <span style={{
                fontSize: 10, fontWeight: 600,
                color: "var(--c-ghost)",
                letterSpacing: "0.05em", textTransform: "uppercase",
              }}>Refined</span>
              <div style={{
                fontSize: 13, lineHeight: 1.5,
                color: "var(--c-high)",
                whiteSpace: "pre-wrap", wordBreak: "break-word",
              }}>
                {pendingRefine.refined}
              </div>
              {pendingRefine.rationale && (
                <span style={{
                  fontSize: 11, color: "var(--c-ghost)",
                  marginTop: 2,
                }}>
                  ↳ {pendingRefine.rationale}
                </span>
              )}
            </div>

            {/* Actions */}
            <div style={{
              display: "flex", alignItems: "center", gap: 6,
              marginTop: 2,
            }}>
              <button
                onClick={confirmRefined}
                style={{
                  padding: "5px 11px", borderRadius: 6,
                  fontSize: 12, fontWeight: 600,
                  color: "var(--c-high)",
                  background: "var(--c-srf2)",
                  border: "1px solid var(--c-brd2)",
                  cursor: "pointer", fontFamily: "inherit",
                  transition: "background 0.1s, border-color 0.1s",
                }}
                onMouseEnter={e => {
                  (e.currentTarget as HTMLElement).style.background = "var(--c-brd)";
                }}
                onMouseLeave={e => {
                  (e.currentTarget as HTMLElement).style.background = "var(--c-srf2)";
                }}
              >
                Send refined
              </button>
              <button
                onClick={sendOriginal}
                style={{
                  padding: "5px 11px", borderRadius: 6,
                  fontSize: 12, fontWeight: 500,
                  color: "var(--c-med)",
                  background: "transparent",
                  border: "1px solid var(--c-brd)",
                  cursor: "pointer", fontFamily: "inherit",
                  transition: "background 0.1s, color 0.1s",
                }}
                onMouseEnter={e => {
                  (e.currentTarget as HTMLElement).style.color = "var(--c-high)";
                  (e.currentTarget as HTMLElement).style.background = "var(--c-srf)";
                }}
                onMouseLeave={e => {
                  (e.currentTarget as HTMLElement).style.color = "var(--c-med)";
                  (e.currentTarget as HTMLElement).style.background = "transparent";
                }}
              >
                Send original
              </button>
              <button
                onClick={editRefined}
                style={{
                  padding: "5px 11px", borderRadius: 6,
                  fontSize: 12, fontWeight: 500,
                  color: "var(--c-med)",
                  background: "transparent",
                  border: "1px solid var(--c-brd)",
                  cursor: "pointer", fontFamily: "inherit",
                  transition: "background 0.1s, color 0.1s",
                }}
                onMouseEnter={e => {
                  (e.currentTarget as HTMLElement).style.color = "var(--c-high)";
                  (e.currentTarget as HTMLElement).style.background = "var(--c-srf)";
                }}
                onMouseLeave={e => {
                  (e.currentTarget as HTMLElement).style.color = "var(--c-med)";
                  (e.currentTarget as HTMLElement).style.background = "transparent";
                }}
              >
                Edit
              </button>
              <div style={{ flex: 1 }} />
              <button
                onClick={() => { if (sessionId) useFleetStore.getState().setMode(sessionId, "manual"); cancelRefine(); }}
                title="Turn Fleet off for this session"
                style={{
                  padding: "4px 9px", borderRadius: 5,
                  fontSize: 11, fontWeight: 500,
                  color: "var(--c-ghost)",
                  background: "transparent",
                  border: "none",
                  cursor: "pointer", fontFamily: "inherit",
                  transition: "color 0.1s",
                }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = "var(--c-med)"; }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = "var(--c-ghost)"; }}
              >
                Turn off for this session
              </button>
            </div>
          </div>
        )}

        {/* SessionSetupStrip removed — config now lives in the
            SessionBriefing canvas (chat-view) shown for new sessions
            instead of an empty chat with chips above. */}

        {/* ── Branch strip — sits above the input when we're on a
              feature branch. Prefers the worktree path so we read
              the agent's fleet/<slug>-<id> branch, not the source
              repo's HEAD. The wrapper adds breathing room between
              the strip and the textarea — without it the strip's
              border kissed the input's top edge and the two read
              as one cramped block. */}
        {!hideBranchStrip && (
          <div style={{ marginBottom: 10 }}>
            <BranchStrip
              projectPath={worktreePath || projectPath}
              sourcePath={projectPath}
              tool={tool}
              controlCenter={controlCenter}
              sessionTitle={sessionTitle}
              plannedBranch={sessionId ? computeBranchName(sessionTitle, sessionId, projectPath) : null}
              isWorktree={!!worktreePath}
            />
          </div>
        )}

        {/* ── Main box ── */}
        <div
          onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}
          style={{
            // 10px corners — sharp enough for terminal emulator,
            // soft enough to not feel like a tech demo.
            borderRadius: 10,
            position: "relative",
            // Four-tier border: rest / focused / dragging /
            // ENHANCING. Enhancing keeps a soft blue base ring
            // (so the box still reads as "in enhance mode" when
            // the traveling line is on the far side); the actual
            // animated stroke is the SVG overlay rendered as the
            // last child below.
            border: `1px solid ${
              enhancing ? "rgba(var(--fg-rgb), 0.18)"
              : dragging ? "rgba(var(--fg-rgb),0.28)"
              : focused ? "rgba(var(--fg-rgb),0.22)"
              : "rgba(var(--fg-rgb),0.10)"
            }`,
            background: "var(--chat-input-bg)",
            transition: "border-color 0.18s, opacity 0.15s, box-shadow 0.18s",
            // No outer halo while enhancing — the user asked for
            // the cue to be subtle. The traveling dash is the
            // signal; the static border just stays at its quiet
            // baseline. Focused / rest states keep their existing
            // box-shadows so the input looks the same when not
            // generating.
            boxShadow: focused
              ? "inset 0 1px 0 rgba(var(--fg-rgb),0.05), 0 0 0 1px rgba(var(--fg-rgb),0.06)"
              : "inset 0 1px 0 rgba(var(--fg-rgb),0.04)",
            overflow: "hidden",
            // No opacity dim when locked — that made the input look
            // visually disconnected from the permission card stacked
            // above it (one bright, one washed out). The placeholder
            // text + textarea disabled attribute already communicate
            // "you can't type now"; we don't need a global dim.
            pointerEvents: locked ? "none" : undefined,
          }}
        >
          {/* Attachments */}
          {attachments.length > 0 && (
            <div style={{ padding: "10px 12px 0", display: "flex", flexWrap: "wrap", gap: 6 }}>
              {attachments.map(att => (
                <div key={att.id} style={{
                  display: "flex", alignItems: "center", gap: 6,
                  padding: att.preview ? 0 : "4px 8px", borderRadius: 7,
                  border: "1px solid rgba(var(--fg-rgb),0.1)", background: "rgba(var(--fg-rgb),0.05)",
                  position: "relative", overflow: "hidden",
                }}>
                  {att.preview ? (
                    <div style={{ position: "relative" }}>
                      <img src={att.preview} alt={att.name}
                        style={{ width: 56, height: 56, objectFit: "cover", borderRadius: 6, display: "block" }} />
                      <button onClick={() => removeAttachment(att.id)}
                        style={{ position: "absolute", top: 2, right: 2, width: 16, height: 16, borderRadius: 4, background: "rgba(0,0,0,0.7)", border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff" }}>
                        <X size={9} />
                      </button>
                    </div>
                  ) : (
                    <>
                      <FileText size={12} style={{ color: "var(--c-dim)", flexShrink: 0 }} />
                      <span style={{ fontSize: 12, color: "var(--c-low)", maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{att.name}</span>
                      <button onClick={() => removeAttachment(att.id)}
                        style={{ background: "none", border: "none", cursor: "pointer", color: "var(--c-ghost)", display: "flex", padding: 0 }}>
                        <X size={11} />
                      </button>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Drag overlay */}
          {dragging && (
            <div style={{ padding: "16px", textAlign: "center", fontSize: 13, color: "var(--c-low)", borderRadius: 9, margin: "8px", border: `1.5px dashed rgba(var(--fg-rgb),0.18)` }}>
              Drop files here
            </div>
          )}

          {/* Textarea + @mention highlight mirror */}
          <div style={{ position: "relative" }}>
            {/* CLI-style prompt chevron — sits at the left edge of the
                textarea like a shell `>` prompt. Static, dim. Reinforces
                the "issue a command" mental model without hijacking
                space (it's just an absolute-positioned glyph). Hidden
                while attachments are stacked above so it doesn't fight
                with their tighter top padding. */}
            {/* Prompt `›` chevron removed at the user's request — they
                wanted a clean text-only composer without the CLI prompt
                affordance on the left. */}
            {/* Mirror sits behind textarea (no z-index = below position:relative textarea).
                Marks paint only a background (text:transparent) — no doubling with textarea text. */}
            {value.includes("@") && (
              <div
                ref={mirrorRef}
                aria-hidden="true"
                style={{
                  position: "absolute", inset: 0, pointerEvents: "none",
                  padding: attachments.length > 0 ? "10px 34px 4px 14px" : "11px 34px 4px 14px",
                  fontSize: 13, lineHeight: 1.55, fontFamily: "inherit",
                  whiteSpace: "pre-wrap", wordBreak: "break-word",
                  overflow: "hidden", color: "transparent",
                  boxSizing: "border-box",
                }}
                dangerouslySetInnerHTML={{ __html: buildMentionHtml(value, validMentionsSet) }}
              />
            )}
          <textarea
            ref={ref} value={value}
            onScroll={() => {
              if (mirrorRef.current && ref.current) {
                mirrorRef.current.scrollTop = ref.current.scrollTop;
                mirrorRef.current.scrollLeft = ref.current.scrollLeft;
              }
            }}
            onChange={e => {
              const next = e.target.value;
              setValue(next);
              const caret = e.target.selectionStart ?? next.length;
              checkMentionState(next, caret);
              checkSlashState(next, caret);
            }}
            onKeyUp={e => {
              const t = e.currentTarget;
              const caret = t.selectionStart ?? t.value.length;
              checkMentionState(t.value, caret);
              checkSlashState(t.value, caret);
            }}
            onClick={e => {
              const t = e.currentTarget;
              const caret = t.selectionStart ?? t.value.length;
              checkMentionState(t.value, caret);
              checkSlashState(t.value, caret);
            }}
            onKeyDown={e => {
              if (agentMentionOpen && filteredAgents.length > 0) {
                if (e.key === "ArrowDown") { e.preventDefault(); setAgentMentionIndex(i => Math.min(i + 1, filteredAgents.length - 1)); return; }
                if (e.key === "ArrowUp")   { e.preventDefault(); setAgentMentionIndex(i => Math.max(i - 1, 0)); return; }
                if (e.key === "Escape")    { e.preventDefault(); dismissedAtRef.current = mentionStartRef.current; closeAgentMention(); return; }
                if (e.key === "Enter" || e.key === "Tab") {
                  e.preventDefault();
                  const pick = filteredAgents[agentMentionIndex] ?? filteredAgents[0];
                  if (pick) pickAgentMention(pick);
                  return;
                }
              }
              if (mentionOpen) {
                if (e.key === "ArrowDown") { e.preventDefault(); setMentionIndex(i => Math.min(i + 1, Math.max(mentionResults.length - 1, 0))); return; }
                if (e.key === "ArrowUp")   { e.preventDefault(); setMentionIndex(i => Math.max(i - 1, 0)); return; }
                if (e.key === "Escape")    { e.preventDefault(); dismissedAtRef.current = mentionStartRef.current; closeMention(); return; }
                if ((e.key === "Enter" || e.key === "Tab") && mentionResults.length > 0) {
                  e.preventDefault();
                  const pick = mentionResults[mentionIndex] ?? mentionResults[0];
                  if (pick) pickMention(pick);
                  return;
                }
              }
              if (slashOpen && slashFiltered.length > 0) {
                if (e.key === "ArrowDown") { e.preventDefault(); setSlashIndex(i => Math.min(i + 1, slashFiltered.length - 1)); return; }
                if (e.key === "ArrowUp")   { e.preventDefault(); setSlashIndex(i => Math.max(i - 1, 0)); return; }
                if (e.key === "Escape")    { e.preventDefault(); setSlashOpen(false); return; }
                if (e.key === "Tab" || e.key === "Enter") {
                  const c = slashFiltered[slashIndex];
                  if (c) { e.preventDefault(); pickSlash(c.cmd); return; }
                }
              }
              // History navigation — only when no dropdown is open and cursor is at line 0
              if (!mentionOpen && !slashOpen && !agentMentionOpen) {
                const ta = e.currentTarget;
                const atTop = ta.selectionStart === ta.selectionEnd &&
                  !ta.value.slice(0, ta.selectionStart).includes("\n");
                const atBottom = ta.selectionStart === ta.selectionEnd &&
                  !ta.value.slice(ta.selectionStart).includes("\n");
                const hist = historyRef.current;

                if (e.key === "ArrowUp" && atTop && hist.length > 0) {
                  e.preventDefault();
                  if (historyIdxRef.current === -1) draftRef.current = value;
                  const next = Math.min(historyIdxRef.current + 1, hist.length - 1);
                  historyIdxRef.current = next;
                  const msg = hist[next] ?? "";
                  setValue(msg);
                  requestAnimationFrame(() => {
                    if (ref.current) { ref.current.selectionStart = ref.current.selectionEnd = 0; }
                  });
                  return;
                }
                if (e.key === "ArrowDown" && atBottom && historyIdxRef.current >= 0) {
                  e.preventDefault();
                  const next = historyIdxRef.current - 1;
                  historyIdxRef.current = next;
                  setValue(next < 0 ? draftRef.current : (hist[next] ?? ""));
                  requestAnimationFrame(() => {
                    if (ref.current) { const l = ref.current.value.length; ref.current.selectionStart = ref.current.selectionEnd = l; }
                  });
                  return;
                }
              }
              // ⌘I / Ctrl+I — fire the prompt enhancer. Same gate as
              // the on-screen Sparkles button (text + not busy). The
              // shortcut works whether or not the icon is visible.
              if ((e.metaKey || e.ctrlKey) && (e.key === "i" || e.key === "I")) {
                e.preventDefault();
                void handleEnhance();
                return;
              }
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
            }}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onPaste={e => {
              const imgs = Array.from(e.clipboardData.items).filter(i => i.kind === "file" && i.type.startsWith("image/"));
              if (imgs.length > 0) {
                const files = imgs.map(i => i.getAsFile()).filter(Boolean) as File[];
                if (files.length > 0) { e.preventDefault(); addFiles(files); }
              }
            }}
            placeholder={dragging ? "" : (placeholder ?? "Send a message…")}
            disabled={locked || (disabled && !streaming)}
            rows={1}
            style={{
              display: "block", width: "100%",
              // Compact composer: 11px vertical padding for ~42px
              // total height — matches the reference's tighter row.
              padding: attachments.length > 0
                ? "10px 34px 10px 14px"
                : "11px 34px 11px 14px",
              background: "transparent", border: "none", outline: "none", resize: "none",
              fontSize: 13, lineHeight: 1.55, color: "var(--foreground)", fontFamily: "inherit",
              minHeight: 42, maxHeight: 220, overflowY: "auto", boxSizing: "border-box",
              position: "relative", /* sits above absolute mirror */
            }}
          />

          {/* Enhance button moved out of the input box and into the
              bottom toolbar — see the LEFT cluster below where it
              sits next to + / Notebook / Mic. Inside the input it
              competed with Send for visual weight; the toolbar is
              where input-actions naturally live in Fleet. */}

          {/* Undo / toast chip — fades in below the input box for
              ~6 s after a successful enhance OR a no-op toast. Never
              both at once. The Undo button restores the pre-enhance
              draft; the toast variant ("Looks good as is") is purely
              informational and dismisses on its own. */}
          {(enhanceUndo || enhanceToast) && (
            <div style={{
              position: "absolute", right: 10, bottom: -22,
              display: "inline-flex", alignItems: "center", gap: 6,
              padding: "3px 8px",
              borderRadius: 5,
              background: "var(--c-srf2, rgba(255,255,255,0.04))",
              border: "1px solid var(--c-brd, rgba(255,255,255,0.08))",
              fontSize: 10.5, color: "var(--c-dim)",
              fontFamily: "var(--font-sans)",
              pointerEvents: "auto",
              animation: "fleet-popover-up 0.15s ease-out both",
              zIndex: 5,
            }}>
              {enhanceUndo ? (
                <button
                  onClick={handleUndoEnhance}
                  onMouseDown={(e) => e.preventDefault()}
                  style={{
                    display: "inline-flex", alignItems: "center", gap: 4,
                    padding: 0, background: "transparent", border: "none",
                    color: "var(--c-fg)", cursor: "pointer", outline: "none",
                    fontSize: 10.5, fontFamily: "inherit",
                  }}
                >
                  <Undo2 size={10} strokeWidth={2} />
                  <span>Undo enhance</span>
                </button>
              ) : (
                <>
                  <Sparkles size={10} strokeWidth={1.75} />
                  <span>{enhanceToast}</span>
                </>
              )}
            </div>
          )}

          {/* In-box send / stop — frameless icon flush right.
              Two states only:
                • streaming     → filled red Square (stop)
                • idle / typing → CornerDownLeft (⏎ Enter glyph)
              Position mirrors the `›` prompt chevron on the left:
              left:11 → right:11, same vertical center. Frameless
              (no bg, no border) — single glyph affordance. */}
          <button
            onClick={submit}
            title={streaming ? "Stop (Esc)" : "Send (Enter)"}
            disabled={!btnActive}
            onMouseDown={e => e.preventDefault()}
            style={{
              position: "absolute", right: 11, bottom: 11,
              width: 18, height: 18, borderRadius: 4, flexShrink: 0,
              display: "flex", alignItems: "center", justifyContent: "center",
              background: "transparent",
              border: "none", outline: "none",
              color: streaming
                ? "#f87171"
                : canSend
                ? "#f5f5f5"
                : "#9a9a9a",
              cursor: btnActive ? "pointer" : "default",
              transition: "color 0.15s",
            }}
            onMouseEnter={e => {
              if (!btnActive) return;
              if (streaming) e.currentTarget.style.color = "#fb7474";
              else e.currentTarget.style.color = "#ffffff";
            }}
            onMouseLeave={e => {
              e.currentTarget.style.color = streaming
                ? "#f87171"
                : canSend
                ? "#f5f5f5"
                : "#9a9a9a";
            }}
          >
            {streaming
              ? <Square size={12} strokeWidth={0} style={{ fill: "currentColor" }} />
              : <CornerDownLeft size={14} strokeWidth={2} />}
          </button>

          {/* Border-trace overlay — SVG that follows the input's
              rounded perimeter with a soft white segment drifting
              slowly around the box. Tuned per user feedback:
              "daha smooth, az belirgin, beyaz olsun, çok hızlı
              dönmesin". So we use:
                • white stroke (var(--c-fg)) at 0.55 alpha — there
                  but not loud
                • 1 px stroke (was 1.5) — finer line reads as a
                  delicate cursor rather than a fat ring
                • 120-unit visible segment with a 700-unit gap —
                  longer dash than before so the bright tail is
                  always visible somewhere on the perimeter,
                  giving a continuous "drifting" feel
                • 3.2 s loop — slow ambient drift, not a frantic
                  chase */}
          {enhancing && (
            <svg
              aria-hidden
              style={{
                position: "absolute",
                inset: 0,
                width: "100%",
                height: "100%",
                pointerEvents: "none",
                zIndex: 3,
                overflow: "visible",
              }}
            >
              <rect
                x="0.5"
                y="0.5"
                width="calc(100% - 1px)"
                height="calc(100% - 1px)"
                rx="9.5"
                ry="9.5"
                fill="none"
                stroke="rgba(var(--fg-rgb), 0.55)"
                strokeWidth="1"
                strokeLinecap="round"
                strokeDasharray="120 700"
                style={{ animation: "border-trace 3.2s linear infinite" }}
              />
            </svg>
          )}
          </div>
        </div>

        {/* ── External toolbar ── (outside the input box, transparent bg)
            Compact one-row toolbar — bigger size felt like a separate
            "panel" rather than a footer for the input. Now sized to
            match a status-bar / command-bar in modern editors. */}
        <div style={{
          display: "flex", alignItems: "center",
          padding: "6px 2px 0", gap: 0,
        }}>

          {/* LEFT — flex:1 so the right cluster gets pushed to the
              right edge but only WITHIN the available row width
              (right cluster has flexShrink:0 so it never overflows).
              The user reverted: model + context belong on the right
              like a status bar's right pane, not glued to the
              toolbar buttons. */}
          <div style={{ display: "flex", alignItems: "center", gap: 3, flex: 1, minWidth: 0 }}>

            {/* Permission-mode picker — only on agent chats. The
                Fleet hub doesn't execute tools, so a permission
                policy is meaningless there. (Fleet's own policy
                lives in the Fleet mode chip below.) */}
            {!controlCenter ? (
              <PermissionModePicker
                mode={permissionMode ?? "default"}
                onPick={(m) => {
                  if (!sessionId) return;
                  const store = useAppStore.getState();
                  const session = store.sessions.find(s => s.id === sessionId);
                  if (session?.local_only) {
                    store.setDraftField({ permission_mode: m });
                    return;
                  }
                  store.updateSession(sessionId, { permission_mode: m });
                  apiUpdateSession(sessionId, { permission_mode: m }).catch(() => {});
                }}
              />
            ) : (() => {
              // Fleet hub: Fleet co-pilot mode picker takes the
              // leftmost slot where the permission picker would sit
              // on an agent session. Fleet doesn't execute tools so
              // a permission policy is meaningless on the hub —
              // the Fleet policy is what matters here.
              const modeMeta = fleetModeMeta(globalFleetMode);
              const isOpen = openDrop === "fleet-mode";
              return (
                <div style={{ position: "relative" }}>
                  <button
                    onClick={() => setOpenDrop(d => d === "fleet-mode" ? null : "fleet-mode")}
                    onMouseDown={(e) => e.preventDefault()}
                    title={`Fleet co-pilot · ${modeMeta.label}`}
                    style={{
                      display: "inline-flex", alignItems: "center", gap: 6,
                      height: 22, padding: "0 6px", borderRadius: 4,
                      flexShrink: 0,
                      background: isOpen ? "var(--c-srf)" : "transparent",
                      border: "none", outline: "none",
                      cursor: "pointer", fontFamily: "inherit",
                      transition: "background 0.12s",
                    }}
                    onMouseEnter={(e) => { if (!isOpen) e.currentTarget.style.background = "var(--c-srf)"; }}
                    onMouseLeave={(e) => { if (!isOpen) e.currentTarget.style.background = "transparent"; }}
                  >
                    <LogoMark
                      size={11}
                      color={modeMeta.color}
                      opacities={globalFleetMode === "manual" ? [0.5, 0.42, 0.34] : [1, 0.85, 0.7]}
                      style={{ flexShrink: 0 }}
                    />
                    <span style={{
                      fontSize: 11.5, fontWeight: 500,
                      color: "var(--c-low)",
                      letterSpacing: "0.005em",
                    }}>Fleet</span>
                    <span aria-hidden style={{ color: "var(--c-brd2)", fontSize: 11 }}>·</span>
                    <span style={{
                      fontSize: 11.5, fontWeight: 600,
                      color: modeMeta.color,
                      letterSpacing: "0.005em",
                    }}>{modeMeta.label}</span>
                    <ChevronDown
                      size={10} strokeWidth={2.2}
                      style={{
                        color: "var(--c-dim)",
                        marginLeft: -1,
                        transform: isOpen ? "rotate(180deg)" : "none",
                        transition: "transform 0.12s",
                      }}
                    />
                  </button>

                  {isOpen && (
                    <div
                      role="menu"
                      style={{
                        position: "absolute", bottom: "calc(100% + 8px)", left: 0,
                        width: 232, zIndex: 50,
                        background: "var(--popover)",
                        border: "1px solid var(--c-brd)",
                        borderRadius: 9,
                        padding: "3px 0",
                        boxShadow: "0 16px 40px rgba(0,0,0,0.5), 0 2px 8px rgba(0,0,0,0.2)",
                        animation: "fleet-popover-up 0.14s ease-out both",
                      }}
                    >
                      <div style={{
                        padding: "5px 10px 4px",
                      }}>
                        <div style={{
                          fontSize: 10.5, fontWeight: 500, color: "var(--c-dim)",
                          letterSpacing: 0,
                        }}>Fleet co-pilot</div>
                      </div>

                      {(["manual", "refine-only", "copilot", "auto"] as const).map(m => {
                        const meta = fleetModeMeta(m);
                        const active = m === globalFleetMode;
                        const desc =
                          m === "manual"       ? "Prompts go straight to the agent."
                        : m === "refine-only"  ? "Rewrites your prompt on send."
                        : m === "copilot"      ? "Refines + asks you what's next."
                        :                        "Auto-fires obvious next steps.";
                        return (
                          <button
                            key={m}
                            role="menuitemradio"
                            aria-checked={active}
                            onClick={() => {
                              useFleetStore.getState().setGlobalMode(m);
                              setOpenDrop(null);
                            }}
                            onMouseDown={(e) => e.preventDefault()}
                            style={{
                              display: "flex", alignItems: "flex-start", gap: 8,
                              width: "100%", padding: "5px 10px",
                              background: active ? "var(--c-srf)" : "none",
                              border: "none", outline: "none",
                              cursor: "pointer", textAlign: "left",
                              fontFamily: "inherit",
                            }}
                            onMouseEnter={(e) => { if (!active) (e.currentTarget as HTMLElement).style.background = "var(--c-srf)"; }}
                            onMouseLeave={(e) => { if (!active) (e.currentTarget as HTMLElement).style.background = "none"; }}
                          >
                            <span
                              aria-hidden
                              style={{
                                marginTop: 5, flexShrink: 0,
                                width: 6, height: 6, borderRadius: 999,
                                background: meta.color,
                                boxShadow: active
                                  ? `0 0 0 3px ${meta.color}26`
                                  : `0 0 0 2px ${meta.color}18`,
                              }}
                            />
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                <span style={{
                                  fontSize: 12.5,
                                  fontWeight: active ? 500 : 400,
                                  color: active ? "var(--c-high)" : "var(--c-low)",
                                }}>{meta.label}</span>
                                {active && <Check size={10} style={{ color: "var(--c-dim)" }} />}
                              </div>
                              <div style={{
                                fontSize: 10.5, color: "var(--c-ghost)", lineHeight: 1.35,
                                marginTop: 1,
                              }}>{desc}</div>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })()}

            {/* Tool cluster — + (attach), then mic with its own
                device-picker chevron RIGHT NEXT TO it (split
                button). The user explicitly asked for the chevron
                to live next to the mic, since it's the mic's
                input-device dropdown — not a separate "more". */}
            <ToolBtn title="Attach file (or drag & drop)" onClick={() => fileRef.current?.click()}><Plus size={12} strokeWidth={2} /></ToolBtn>
            {/* Enhance — Wand icon. Sits between + and the
                transcript-view button so it reads as an "input
                action". Dim + non-interactive when there's no text;
                vibrant fg color when there IS text; ⌘I keyboard
                shortcut still works whether the icon is dim or
                live. While running, the icon swaps to a glowing
                wand with a pulsing blue halo (wand-shimmer
                keyframe) — purposely "working" feel, not a generic
                spinner. The click triggers a brief wand-pop pop so
                the user gets immediate feedback before the network
                call returns. */}
            <button
              onClick={() => void handleEnhance()}
              onMouseDown={(e) => e.preventDefault()}
              disabled={enhancing || disabled || locked || !hasText}
              title={
                enhancing  ? "Enhancing…"
                : !hasText ? "Type a prompt to enhance"
                : "Enhance prompt (⌘I)"
              }
              style={{
                width: 22, height: 22, borderRadius: 5, flexShrink: 0,
                display: "flex", alignItems: "center", justifyContent: "center",
                background: enhancing ? "rgba(96,165,250,0.10)" : "none",
                border: "none", outline: "none",
                cursor: (enhancing || !hasText) ? "default" : "pointer",
                color: enhancing
                  ? "rgba(96, 165, 250, 0.95)"          // vibrant blue while working
                  : hasText
                    ? "var(--c-fg)"                      // FULL fg when ready (was --c-low)
                    : "var(--c-dim)",                    // dim when empty
                transition: "color 0.12s, background 0.12s",
              }}
              onMouseEnter={(e) => {
                if (!enhancing && hasText) {
                  e.currentTarget.style.background = "rgba(var(--fg-rgb), 0.08)";
                }
              }}
              onMouseLeave={(e) => {
                if (!enhancing) {
                  e.currentTarget.style.background = "none";
                }
              }}
            >
              <Wand2 size={12} strokeWidth={1.75} />
            </button>
            <TranscriptViewButton />
            <MicButton />
          </div>

          {/* RIGHT — provider · model · effort + context arc.
              flexShrink:0 keeps it from overflowing when the row
              gets tight; the left flex:1 spacer pushes it to the
              right edge. Layout: [logo] [model] [·] [effort] [▾] [arc] */}
          <div style={{
            display: "flex", alignItems: "center", gap: 6,
            flexShrink: 0,
          }}>
            {/* Routing status — sits LEFT of the model button. Green
                dot when intelligent routing is on; clicking opens a
                small popover with the active decision + proxy. The
                "below the composer" status bar is replaced by this
                tighter placement so the toolbar doesn't get crowded. */}
            <RoutingChip />
            <button
              onClick={() => setOpenDrop(d => d === "model" ? null : "model")}
              style={{
                display: "flex", alignItems: "center", gap: 5,
                padding: "2px 7px", borderRadius: 5, border: "none", cursor: "pointer",
                background: openDrop === "model" ? "var(--c-srf2)" : "none",
                // Mono font kept (was the original) — sans drift made
                // the model name look chat-y where it should read as
                // a system-config token.
                fontSize: 12, fontFamily: "var(--font-mono)",
                transition: "all 0.12s",
                outline: "none",
              }}
              onMouseEnter={e => { if (openDrop !== "model") { e.currentTarget.style.background = "var(--c-srf)"; } }}
              onMouseLeave={e => { if (openDrop !== "model") { e.currentTarget.style.background = "none"; } }}
              onMouseDown={e => e.preventDefault()}
            >
              {/* Provider logo lead — resolved from the model's group (same
                  as the toolbar chip), so it flips to the right provider even
                  when the model lives under another agent's catalog. */}
              <ProviderLogo tool={chipDispatchTool} size={11} />
              <span style={{ color: "var(--c-high)", fontWeight: 500 }}>{modelLabel}</span>
              <span style={{ color: "var(--c-dim)", fontSize: 10 }}>·</span>
              <span style={{ color: "var(--c-low)", fontSize: 10.5 }}>{EFFORT_SHORT[effort]}</span>
              <ChevronDown size={9} strokeWidth={2} style={{
                color: "var(--c-low)", marginLeft: 0,
                transform: openDrop === "model" ? "rotate(180deg)" : "none",
                transition: "transform 0.15s",
              }} />
            </button>

            {/* MCP status — small connected/total badge with a
                click-to-expand popover. Sits LEFT of the context
                ring so the two live-system-state indicators
                cluster together (tools vs. tokens). */}
            <MCPStatusButton />

            {/* Context-window ring — sits IMMEDIATELY to the
                right of the model button. Auto-polls every 8s
                even when closed, so the fill grows live as the
                conversation progresses (was previously only
                fetched on click → ring stayed empty most of
                the time). Click expands the breakdown. */}
            <ContextArcPopover
              sessionId={sessionId}
              max={contextMaxTokens}
              fallbackPct={contextPercent}
              fallbackUsed={contextUsedTokens}
              fallbackUsage={sessionUsage}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
