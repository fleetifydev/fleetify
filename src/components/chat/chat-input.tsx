import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import {
  Square, ChevronDown, Check,
  FolderOpen, Mic, X, FileText,
  Plus, Loader2,
  AlignLeft,
  Sparkles, Undo2, Wand2, MoreHorizontal,
  Plug, RefreshCw, ArrowUp,
} from "lucide-react";
import { folderName } from "@/lib/utils";
import { searchProjectFiles, apiFetch, type FileSearchEntry, updateSession as apiUpdateSession, enhancePrompt } from "@/lib/api";
import { registerConfigPatch } from "@/lib/session-config-sync";
import { useDiscoveredModelsStore } from "@/stores/discovered-models-store";
import { effortLabel } from "@/lib/effort";
import { useFleetStore, type FleetMode } from "@/stores/fleet-store";
import { LogoMark } from "@/components/brand/logo-mark";
import { wsManager } from "@/services/ws-manager";
import { FileMentionPopup } from "./file-mention-popup";
import { BranchStrip, computeBranchName } from "@/components/git/branch-strip";
import { useVoiceDictation, isVoiceReady } from "@/hooks/use-voice-dictation";
import { voice } from "@/lib/voice-api";
import { useAppStore } from "@/stores/app-store";
import { useChatStore, pushChatError } from "@/stores/chat-store";
import { useMCPStore } from "@/stores/mcp-store";
import { ProviderLogo } from "@/components/ui/provider-logo";
import { RoutingChip } from "@/components/settings/routers/routing-chip";
import { commandsForContext, type SlashCmdDef } from "@/lib/slash-commands";
import { useProvidersConfig } from "@/hooks/use-providers-config";
import { UnifiedModelPicker, type Effort as UMEffort } from "./unified-model-picker";
import { buildPickerGroups, effortForDiscoveredModel, resolveDispatchTool, resolveModelChip, type PickerModel } from "@/lib/picker-groups";
import { permissionCapabilityFor, permissionModesFor, defaultPermissionMode, isLoudMode, toolMatrixFor, parseToolOverrides, sandboxOptionsFor } from "@/lib/capabilities";
import { decideModeCommand } from "@/lib/permission-modes";
import type { PermMode } from "@/lib/providers-api";
import { ToolMatrixEditor } from "./tool-matrix-editor";
import { SandboxControl } from "./sandbox-control";
import { PromptsPicker } from "./prompts-picker";
import { listPrompts, resolvePromptArg } from "@/lib/prompts-api";

/* ─────────────────── constants ─────────────────── */

interface ModelOption { id: string; label: string; ctx: string }

const CLAUDE_MODELS: ModelOption[] = [
  { id: "claude-fable-5",            label: "Fable 5",    ctx: "1M"   },
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
  if (tool === "gemini-cli") return GEMINI_MODELS;
  if (tool === "codex-cli")  return CODEX_MODELS;
  if (tool === "antigravity-cli")    return AGY_MODELS;
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
    if (tool === "codex-cli") return "GPT-5.4";
    if (tool === "antigravity-cli") return "Auto";
    if (tool === "antigravity-sdk") return "Gemini 3.5 Flash (Medium)";
    return list[0]?.label ?? "Model";
  }
  // Fallback: best-effort label inference from the id substring.
  const m = id.toLowerCase();
  if (m.includes("fable"))   return "Fable 5";
  if (m.includes("opus"))    return "Opus 4.8";
  if (m.includes("sonnet"))  return "Sonnet 4.6";
  if (m.includes("haiku"))   return "Haiku 4.5";
  if (m.includes("3.1-pro")) return "3.1 Pro";
  if (m.includes("3-flash")) return "3 Flash";
  if (m.includes("3.1-flash-lite")) return "3.1 Lite";
  if (m.startsWith("gpt-5.")) return `GPT-${id.slice(4)}`;  // gpt-5.2 → GPT-5.2
  return id;
}

/* ─────────────────── tiny components ─────────────────── */


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
  // Refined palette — same family as the branch strip / status dots so the
  // chat footer reads as one coherent row of muted indicators.
  const dotColor = servers.length === 0
    ? "var(--c-low)"
    : hasFailed ? "rgb(216,110,118)"
    : hasAuthNeeded ? "rgb(210,170,90)"
    : allConnected ? "rgb(64,180,120)"
    : "rgb(110,162,228)";

  // Self-hide when no MCP servers are configured — the always-on "0/0" badge
  // was just visual noise the user asked to remove. Add servers in Settings →
  // MCP and the chip reappears automatically (the hook polls).
  if (servers.length === 0) return null;

  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={`MCP — ${connectedCount}/${servers.length} connected`}
        style={{
          // Same "calm pill" family as Bypass perms / Routing / model chip:
          // ghost background, neutral muted label, tiny state-coloured dot.
          // Equal scale so the whole right cluster reads as one row.
          display: "inline-flex", alignItems: "center", gap: 6,
          padding: "3px 8px", borderRadius: 5,
          background: "transparent", border: "none",
          color: "var(--c-low)", fontSize: 12, fontWeight: 500,
          cursor: "pointer",
          transition: "background 0.12s, color 0.12s",
          outline: "none",
        }}
        onMouseEnter={e => {
          (e.currentTarget as HTMLElement).style.background = "rgba(var(--fg-rgb), 0.05)";
          (e.currentTarget as HTMLElement).style.color = "var(--c-high)";
        }}
        onMouseLeave={e => {
          (e.currentTarget as HTMLElement).style.background = "transparent";
          (e.currentTarget as HTMLElement).style.color = "var(--c-low)";
        }}
      >
        <span style={{ width: 5, height: 5, borderRadius: "50%", background: dotColor }} />
        <span>MCP</span>
        <span style={{ color: "var(--c-dim)", fontFamily: "var(--font-mono)", fontSize: 11 }}>
          {connectedCount}/{servers.length}
        </span>
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
                  : st === "checking" ? "#3b82f6"
                  : "var(--c-low)";
                const label = st === "connected" ? "Connected"
                  : st === "auth_needed" ? "Auth needed"
                  : st === "failed" ? "Failed"
                  : st === "checking" ? "Checking…"
                  : "Unknown";
                // Raw error / auth challenge stays available on hover, not
                // dumped into the row.
                const detail = st === "failed" ? (s.status?.error ?? "")
                  : st === "auth_needed" ? (s.status?.auth_hint ?? "")
                  : "";
                return (
                  <div key={s.name} title={detail || undefined} style={{
                    display: "flex", alignItems: "center", gap: 8,
                    padding: "6px 0",
                    borderBottom: "1px solid var(--border)",
                  }}>
                    <span style={{ width: 6, height: 6, borderRadius: "50%", background: color, flexShrink: 0 }} />
                    <span style={{ flex: 1, minWidth: 0, fontSize: 11.5, fontWeight: 500, color: "var(--foreground)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {s.name}
                    </span>
                    <span style={{ flexShrink: 0, fontSize: 10.5, fontWeight: 500, color }}>
                      {label}
                    </span>
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

/** Keyboard shortcut badge */
function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", justifyContent: "center",
      minWidth: 14, height: 14, padding: "0 2px", borderRadius: 3,
      background: "rgba(var(--fg-rgb),0.06)", border: "1px solid rgba(var(--fg-rgb),0.09)",
      fontSize: 8.5, color: "var(--c-dim)", fontFamily: "inherit",
    }}>{children}</span>
  );
}

/** Toolbar icon button — compact 22×22, ghosted at rest, lifts on
 *  hover. Sized down from 26×26 so the toolbar reads as one tight
 *  control row rather than spaced affordances. */
function ToolBtn({ children, title, onClick, disabled }: {
  children: React.ReactNode; title?: string; onClick?: () => void; disabled?: boolean;
}) {
  return (
    <button onClick={disabled ? undefined : onClick} title={title} disabled={disabled}
      onMouseDown={e => e.preventDefault()} style={{
      width: 24, height: 24, borderRadius: 5, flexShrink: 0,
      display: "flex", alignItems: "center", justifyContent: "center",
      // Bare ghost icons (Cursor-minimal): low at rest, subtle bg + high on
      // hover. No chunky chrome.
      background: "none", border: "none", outline: "none",
      cursor: disabled ? "not-allowed" : "pointer",
      color: "var(--c-low)",
      opacity: disabled ? 0.4 : 1,
      transition: "color 0.12s, background 0.12s",
    }}
      onMouseEnter={e => { if (disabled) return; e.currentTarget.style.color = "var(--c-high)"; e.currentTarget.style.background = "rgba(var(--fg-rgb),0.06)"; }}
      onMouseLeave={e => { if (disabled) return; e.currentTarget.style.color = "var(--c-low)"; e.currentTarget.style.background = "none"; }}
    >{children}</button>
  );
}

/** Mic button with a device picker. The user wanted the mic icon
 *  to open a small menu listing the system's input devices so they
 *  can choose which mic the dictation flow will use, rather than
 *  the icon being a no-op affordance. We persist the selected
 *  deviceId in localStorage so it sticks across sessions. */
function MicButton({ onTranscript }: { onTranscript: (text: string) => void }) {
  const [open, setOpen] = useState(false);
  const [devices, setDevices] = useState<{ id: string; name: string }[]>([]);
  const [selected, setSelected] = useState<string | null>(() => {
    try { return localStorage.getItem("fleet.mic.deviceId"); } catch { return null; }
  });
  const wrapRef = useRef<HTMLDivElement>(null);
  // Mic icon = record toggle (start → stop & transcribe → insert at caret);
  // the chevron still opens the device picker below.
  const dict = useVoiceDictation(onTranscript);
  // On-device engine with no model picked → the mic can only error, so disable
  // it (read per-render; the composer re-renders when you return from Settings).
  const voiceReady = isVoiceReady();

  // Lazy-load device list from Rust (cpal) — no getUserMedia needed.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    voice.listDevices().then((r) => {
      if (!cancelled) setDevices(r.devices ?? []);
    }).catch(() => { if (!cancelled) setDevices([]); });
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

  // `id === null` means "System Default" — clear the pin so the renderer
  // sends a null deviceId and Rust (cpal) resolves the OS default at record
  // time. A specific id pins that device across sessions.
  const pick = (id: string | null) => {
    setSelected(id);
    try {
      if (id === null) localStorage.removeItem("fleet.mic.deviceId");
      else localStorage.setItem("fleet.mic.deviceId", id);
    } catch { /* ignore */ }
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
      <ToolBtn
        title={!voiceReady
          ? "Select an on-device model in Settings → Voice to use the mic"
          : dict.recording ? "Stop & insert" : dict.busy ? "Transcribing…" : dict.error ? dict.error : "Voice input — click to dictate"}
        disabled={!voiceReady}
        onClick={dict.busy ? undefined : dict.toggle}
      >
        {dict.busy
          ? <Loader2 size={12} style={{ animation: "spin 1s linear infinite" }} />
          : <Mic size={12} color={dict.recording ? "rgb(248,113,113)" : dict.error ? "rgb(250,204,21)" : undefined} />}
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
          {/* System Default — always first. Active on a fresh install (no
              pinned deviceId → selected === null), so the menu reflects that
              recording follows the OS's chosen mic until the user pins one. */}
          <button
            onClick={() => pick(null)}
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
            {selected === null
              ? <Check size={11} strokeWidth={2.5} style={{ color: "var(--c-fg)", flexShrink: 0 }} />
              : <span style={{ width: 11, flexShrink: 0 }} />
            }
            <span style={{
              flex: 1, fontSize: 11.5,
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            }}>System Default</span>
          </button>
          {devices.length === 0 && (
            <div style={{ padding: "8px 10px", fontSize: 11.5, color: "var(--c-dim)" }}>
              No input devices found.
            </div>
          )}
          {devices.map(d => {
            const active = selected === d.id;
            return (
              <button
                key={d.id}
                onClick={() => pick(d.id)}
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
                }}>{d.name}</span>
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

/** "More" popover that collapses two secondary input affordances — Enhance
 *  prompt (⌘I) and Transcript view (Normal / Thinking / Verbose / Summary) —
 *  behind a single horizontal-dots button. Keeps the footer row scannable:
 *  the frequent actions (Attach, Mic) stay visible, the rest tucks away.
 *  Enhance still has its full lifecycle inside the menu row: dim/disabled
 *  when there's no prompt to enhance, vibrant + "Enhancing…" while in flight. */
function MoreActionsMenu({
  onEnhance, enhancing, canEnhance,
}: {
  onEnhance: () => void;
  enhancing: boolean;
  canEnhance: boolean;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const view  = useAppStore(s => s.transcriptView);
  const setView = useAppStore(s => s.setTranscriptView);

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

  const modes = [
    { id: "normal",   label: "Normal" },
    { id: "thinking", label: "Thinking" },
    { id: "verbose",  label: "Verbose" },
    { id: "summary",  label: "Summary" },
  ] as const;

  return (
    <div ref={wrapRef} style={{ position: "relative", flexShrink: 0 }}>
      <ToolBtn title="More actions" onClick={() => setOpen(o => !o)}>
        <MoreHorizontal size={14} strokeWidth={1.85} />
      </ToolBtn>
      {open && (
        <div style={{
          position: "absolute", bottom: "calc(100% + 6px)", left: 0,
          minWidth: 194,
          background: "var(--popover, #161616)",
          border: "1px solid var(--c-brd)",
          borderRadius: 7,
          padding: 3,
          boxShadow: "0 -8px 28px rgba(0,0,0,0.42)",
          zIndex: 60,
          fontFamily: "var(--font-sans)",
          animation: "fleet-popover-up 0.14s ease-out both",
        }}>
          {/* Enhance prompt — keeps its disabled state + ⌘I shortcut. */}
          <button
            onClick={() => { onEnhance(); setOpen(false); }}
            onMouseDown={e => e.preventDefault()}
            disabled={!canEnhance && !enhancing}
            style={{
              display: "flex", alignItems: "center", justifyContent: "space-between",
              gap: 8, width: "100%", padding: "4px 8px",
              background: "transparent", border: "none", outline: "none",
              cursor: canEnhance ? "pointer" : "default",
              color: enhancing ? "rgba(96,165,250,0.95)" : canEnhance ? "var(--c-med)" : "var(--c-dim)",
              borderRadius: 4,
              textAlign: "left", fontFamily: "inherit",
            }}
            onMouseEnter={e => { if (canEnhance) (e.currentTarget as HTMLButtonElement).style.background = "rgba(var(--fg-rgb),0.04)"; }}
            onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
          >
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 12, fontWeight: 500 }}>
              <Wand2 size={12} strokeWidth={1.75} />
              {enhancing ? "Enhancing…" : "Enhance prompt"}
            </span>
            <span style={{ fontSize: 10, fontFamily: "var(--font-mono)", color: "var(--c-dim)" }}>⌘I</span>
          </button>

          {/* Tiny separator before the view modes — same hairline as the
              other popovers in the chrome. */}
          <div style={{ height: 1, background: "var(--c-brd)", margin: "3px 8px" }} />

          <div style={{
            padding: "3px 8px 3px",
            fontSize: 10, fontWeight: 500,
            letterSpacing: 0.3, textTransform: "uppercase",
            color: "var(--c-dim)",
            display: "flex", alignItems: "center", gap: 6,
          }}>
            <AlignLeft size={10} strokeWidth={1.85} />
            Transcript view
          </div>
          {modes.map(m => {
            const active = view === m.id;
            return (
              <button
                key={m.id}
                onClick={() => { setView(m.id); setOpen(false); }}
                onMouseDown={e => e.preventDefault()}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "space-between",
                  width: "100%", padding: "4px 8px",
                  background: active ? "rgba(var(--fg-rgb),0.06)" : "transparent",
                  border: "none", outline: "none", cursor: "pointer",
                  color: active ? "var(--c-high)" : "var(--c-med)",
                  fontSize: 12, fontWeight: active ? 600 : 500,
                  borderRadius: 4, textAlign: "left", fontFamily: "inherit",
                }}
                onMouseEnter={e => { if (!active) (e.currentTarget as HTMLButtonElement).style.background = "rgba(var(--fg-rgb),0.04)"; }}
                onMouseLeave={e => { if (!active) (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
              >
                <span>{m.label}</span>
                {active && <Check size={10} style={{ color: "var(--c-low)" }} />}
              </button>
            );
          })}
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
function PermissionModePicker({
  mode, modes, onPick,
}: {
  mode: string;
  modes: PermMode[];
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

  if (modes.length === 0) return null;

  const fullLabel = modes.find((m) => m.id === mode)?.label ?? modes.find((m) => m.id === "default")?.label ?? modes[0]?.label ?? mode;
  // Single-word label for the chip — the dropdown still shows the long
  // descriptive labels. "Bypass permissions" / "Accept edits" / "Ask
  // permissions" → "Bypass" / "Accept" / "Ask".
  const shortLabel = fullLabel.split(/\s+/)[0] ?? fullLabel;

  return (
    <div ref={wrapRef} style={{ position: "relative", flexShrink: 0 }}>
      <button
        onClick={() => setOpen(o => !o)}
        onMouseDown={e => e.preventDefault()}
        title={`Permission mode: ${fullLabel}`}
        style={{
          // Deliberately understated — the user doesn't want this to look
          // important. Just quiet dim text + a small chevron, no dot, no
          // colour, no pill. It recedes like a status label; the dropdown
          // carries the actual mode detail. Brightens only on hover/open.
          padding: "4px 7px", marginRight: 1,
          background: open ? "rgba(var(--fg-rgb), 0.06)" : "none",
          border: "none",
          color: open ? "var(--c-med)" : "var(--c-low)",
          fontSize: 12, fontWeight: 500, cursor: "pointer",
          borderRadius: 5,
          transition: "color 0.12s, background 0.12s",
          flexShrink: 0, display: "inline-flex", alignItems: "center", gap: 4,
          fontFamily: "var(--font-sans)",
          outline: "none",
        }}
        onMouseEnter={e => {
          if (open) return;
          e.currentTarget.style.background = "rgba(var(--fg-rgb),0.06)";
          e.currentTarget.style.color = "var(--c-med)";
        }}
        onMouseLeave={e => {
          if (open) return;
          e.currentTarget.style.background = "none";
          e.currentTarget.style.color = "var(--c-low)";
        }}
      >
        {shortLabel}
        <ChevronDown size={11} strokeWidth={2} style={{ color: "var(--c-ghost)", flexShrink: 0 }} />
      </button>
      {open && (
        <div style={{
          position: "absolute", bottom: "calc(100% + 6px)", left: 0,
          minWidth: 194,
          background: "var(--popover, #161616)",
          border: "1px solid var(--c-brd, rgba(255,255,255,0.08))",
          borderRadius: 7,
          padding: 3,
          boxShadow: "0 -8px 28px rgba(0,0,0,0.42)",
          zIndex: 60,
          fontFamily: "var(--font-sans)",
          animation: "fleet-popover-up 0.14s ease-out both",
        }}>
          <div style={{
            display: "flex", alignItems: "center", justifyContent: "space-between",
            padding: "3px 8px 3px",
          }}>
            <span style={{ fontSize: 10, color: "var(--c-dim)", fontWeight: 500 }}>Mode</span>
            <div style={{ display: "flex", gap: 2 }}>
              <Kbd>⇧</Kbd><Kbd>⌘</Kbd><Kbd>M</Kbd>
            </div>
          </div>
          {modes.map((m, i) => {
            const active = mode === m.id;
            const loudRow = isLoudMode(m.id);
            return (
              <button
                key={m.id}
                onClick={() => { onPick(m.id); setOpen(false); }}
                onMouseDown={e => e.preventDefault()}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "space-between",
                  width: "100%", padding: "4px 8px",
                  background: active ? "rgba(var(--fg-rgb),0.06)" : "transparent",
                  border: "none", outline: "none", cursor: "pointer",
                  borderRadius: 4,
                  textAlign: "left",
                  fontFamily: "inherit",
                }}
                onMouseEnter={e => { if (!active) e.currentTarget.style.background = "rgba(var(--fg-rgb),0.04)"; }}
                onMouseLeave={e => { if (!active) e.currentTarget.style.background = "transparent"; }}
              >
                <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  {/* Minimal dot indicator — amber for the loud modes
                      (Bypass / Accept), quiet grey otherwise. */}
                  <span aria-hidden style={{
                    width: 4, height: 4, borderRadius: "50%", flexShrink: 0,
                    background: loudRow ? "rgb(210,170,90)" : "var(--c-low)",
                  }}/>
                  <span style={{
                    fontSize: 12,
                    fontWeight: active ? 600 : 500,
                    color: active ? "var(--c-high)" : "var(--c-med)",
                  }}>{m.label}</span>
                </span>
                <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  {active && <Check size={10} style={{ color: "var(--c-low)" }} />}
                  <span style={{
                    fontSize: 10, color: "var(--c-dim)",
                    fontFamily: "var(--font-mono)",
                  }}>{i + 1}</span>
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
    case "auto":        return { label: "Auto",        color: "rgba(64,180,120,0.95)",   hint: "refine + auto-continue" };
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
  /** Provider/tool of the current agent ("claude-code" | "gemini-cli" | ...). Drives the model dropdown. */
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
  /** Active interactive question (AskUserQuestion). When set, the composer
   *  GROWS to render the options inline above the textarea — the box itself
   *  becomes the answer surface (pick an option, or type a custom answer and
   *  Send). Cleared by the parent once answered → the box shrinks back. */
  askQuestion?: import("@/stores/chat-store").AskQuestion | null;
  onAnswerQuestion?: (id: string, answers: Array<{ header?: string; question: string; selected: string[] }>) => void;
  onSkipQuestion?: (id: string) => void;
  /** True on the Fleet / staff / control-center chat. Suppresses the
   *  BranchStrip — PR/branch context doesn't apply to the orchestrator
   *  conversation, only to agent sessions bound to a worktree. */
  controlCenter?: boolean;
  /** Session permission mode ("default" | "acceptEdits" | "bypassPermissions" | "plan").
   *  Drives the Permissions chip in the SessionSetupStrip. */
  permissionMode?: string;
  /** Session sandbox value (provider-specific string or null). Passed
   *  as a prop so draft/Local sessions show and can edit their own value. */
  sandbox?: string | null;
  /** Session tool_overrides JSON string or null. Passed as a prop so
   *  draft/Local sessions show and can edit their own overrides. */
  toolOverridesRaw?: string | null;
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



/* ─────────────────── main component ─────────────────── */

export function ChatInput({
  onSend, onStop, onModelChange, onEffortChange,
  disabled, streaming, locked,
  placeholder, model,
  effort: effortProp,
  contextPercent = 0,
  contextUsedTokens,
  contextMaxTokens,
  sessionUsage: _sessionUsage,
  projectPath, worktreePath, tool, sessionId,
  autoMode: _autoMode, onToggleAutoMode: _onToggleAutoMode,
  agentMentions,
  slotAbove,
  askQuestion,
  onAnswerQuestion,
  onSkipQuestion,
  controlCenter,
  permissionMode,
  sandbox,
  toolOverridesRaw,
  hideBranchStrip,
  sessionTitle,
}: ChatInputProps) {
  const [value, setValue]       = useState("");
  // Inline AskUserQuestion selection — per-question chosen option labels.
  // Reset whenever a new question arrives (keyed on its id).
  const [askSelected, setAskSelected] = useState<Record<number, string[]>>({});
  // Wizard step — multi-question asks show ONE question at a time, so the
  // composer doesn't balloon into a wall of options. Next/Submit advances.
  const [askStep, setAskStep] = useState(0);
  const askId = askQuestion?.id ?? null;
  useEffect(() => { setAskSelected({}); setAskStep(0); }, [askId]);
  const askCount = askQuestion?.questions.length ?? 0;
  const askIsLast = askStep >= askCount - 1;
  const askStepAnswered = (askSelected[askStep] ?? []).length > 0 || value.trim().length > 0;
  const askActive = !!askQuestion;
  const askAnyPicked = askActive && (askQuestion?.questions ?? []).some((_, i) => (askSelected[i] ?? []).length > 0);
  const toggleAskOption = useCallback((qIdx: number, label: string, multi: boolean) => {
    setAskSelected(prev => {
      const cur = prev[qIdx] ?? [];
      if (multi) {
        return { ...prev, [qIdx]: cur.includes(label) ? cur.filter(x => x !== label) : [...cur, label] };
      }
      return { ...prev, [qIdx]: [label] };
    });
  }, []);
  const submitAsk = useCallback((customText?: string) => {
    if (!askQuestion || !onAnswerQuestion) return;
    const t = (customText ?? "").trim();
    const answers = askQuestion.questions.map((q, i) => {
      const picked = askSelected[i] ?? [];
      // A typed custom answer overrides picks for that question (applied to
      // the first question when multiple — single-question is the norm).
      const selected = (t && (i === 0 || picked.length === 0)) ? [t] : picked;
      return { header: q.header, question: q.question, selected };
    });
    const hasAny = answers.some(a => a.selected.length > 0);
    if (!hasAny) return;
    onAnswerQuestion(askQuestion.id, answers);
    setAskSelected({});
    setValue("");
  }, [askQuestion, onAnswerQuestion, askSelected]);
  // Advance the wizard: not last → next question; last → submit all answers.
  const advanceAsk = useCallback(() => {
    if (!askQuestion) return;
    if (askStep < askQuestion.questions.length - 1) {
      setValue("");
      setAskStep(s => s + 1);
    } else {
      submitAsk(value);
    }
  }, [askQuestion, askStep, submitAsk, value]);
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
  // Discovered model catalogs — app-wide store, hydrated eagerly on mount (and
  // refreshed when the picker opens, below). Previously component-local state
  // populated only while the picker was open, so a remount dropped the remote
  // catalog and the model chip showed the raw id for any model the static
  // tables don't know (e.g. "claude-fable-5" instead of "Fable 5").
  const discoveredModels = useDiscoveredModelsStore((s) => s.models);
  useEffect(() => {
    void useDiscoveredModelsStore.getState().hydrate(providerTiles);
  }, [providerTiles]);
  const pickerGroups = useMemo(() => {
    const enabledAgentIds = providerTiles
      .filter((t) => t.spec.kind === "cli" && t.connected)
      .map((t) => t.spec.id);
    // Merge the HTTP-discovered catalog (keyed by agent id) with the live bridge
    // models (keyed under the session's own tool) — same precedence as
    // SessionToolbar, so a model id resolves to the same group in both places.
    const merged: Record<string, PickerModel[]> = { ...discoveredModels };
    if (sessionDynModels && sessionDynModels.models.length > 0) {
      // Union live session models with the discovered catalog rather than
      // replacing it — for Hermes the catalog spans every authenticated
      // provider while the live list is only the active provider's subset, and
      // replacing would collapse the provider chip-row to one provider.
      const key = tool ?? "claude-code";
      const base = merged[key] ?? [];
      const seen = new Set(base.map((m) => m.id));
      const live = sessionDynModels.models
        .filter((m) => !seen.has(m.id))
        .map((m) => {
          const eff = effortForDiscoveredModel(key, m.id, providerTiles);
          return { id: m.id, label: m.label, effort: eff, supports_effort: eff.kind !== "none" };
        });
      merged[key] = [...base, ...live];
    }
    const dyn = Object.keys(merged).length > 0 ? merged : undefined;
    return buildPickerGroups(providerTiles, enabledAgentIds, dyn);
  }, [providerTiles, sessionDynModels, tool, discoveredModels]);

  const fleetMode = useFleetStore(s => sessionId ? s.getSession(sessionId).mode : "manual");
  const fleetPaused = useFleetStore(s => sessionId ? s.getSession(sessionId).status === "paused" : false);
  const recordCost = useFleetStore(s => s.recordCost);
  // Fleet hub-only: global default mode (settable from this surface).
  const globalFleetMode = useFleetStore(s => s.globalMode);
  // sandbox and toolOverridesRaw are now passed as props from chat-view
  // (which reads them from activeSession, covering both real sessions and
  // the composer's synthetic draft session). Using props means drafts
  // are no longer frozen — the composer's ComposerState is the source of
  // truth and updates reactively when the user picks.
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

  // Refresh the discovered catalogs when the model picker opens — adds the
  // live-probe agents (opencode/cursor/github-copilot/hermes, a local CLI/ACP
  // probe each) on top of the eager mount hydrate. Same fan-out SessionToolbar
  // runs; results land in the shared store. Empty results keep the static
  // fallback; the backend caches per agent (TTL).
  useEffect(() => {
    if (openDrop !== "model") return;
    void useDiscoveredModelsStore.getState().discoverLive(providerTiles, projectPath ?? "");
  }, [openDrop, projectPath, providerTiles]);

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
  // /prompts picker open state (the no-arg `/prompts` dialog).
  const [promptsOpen, setPromptsOpen] = useState(false);
  // Fetch plugin slash commands for the active session
  useEffect(() => {
    if (!sessionId) { setPluginCmds([]); return; }
    const u = new URLSearchParams({ session_id: sessionId });
    if (projectPath) u.set("project_path", projectPath);
    if (tool) u.set("tool", tool);
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
  }, [sessionId, projectPath, tool]);

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

  // Insert a voice transcript at the composer caret (space-padded so it
  // doesn't glue onto existing text), then restore focus + caret.
  const insertVoiceText = useCallback((text: string) => {
    const t = text.trim();
    if (!t) return;
    const caret = ref.current?.selectionStart ?? value.length;
    const before = value.slice(0, caret);
    const after = value.slice(caret);
    const pad = before && !/\s$/.test(before) ? " " : "";
    const insert = pad + t;
    setValue(before + insert + after);
    requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      const pos = caret + insert.length;
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  }, [value]);

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
    // No active session → this is the Fleet composer / command center, which
    // surfaces ONLY provider-agnostic fleet commands. Session-only commands
    // (/review, /plan, /yolo, …) are meaningless without a session, so
    // they must not leak here even though a default `tool` is selected.
    () => commandsForContext(sessionId ? "session-chat" : "fleet", tool).map((c: SlashCmdDef) => ({
      cmd: c.cmd,
      desc: c.desc,
      body: null,
      intent: c.intent,
      providerCmd: c.providerCmd,
    })),
    [tool, sessionId],
  );
  // ACP agents advertise their slash commands at runtime over ACP
  // (`available_commands_update` — OpenCode, Cursor, Hermes today); ws-manager
  // stores them per session. Surface them for ANY provider that advertised (the
  // store is only populated for those that do) as plain insert-the-text commands
  // (body: null) so the CLI receives `/<name>` as prompt text.
  const dynCmds = useChatStore((s) => (sessionId ? s.dynamicCommands[sessionId] : undefined));
  const agentCmds = useMemo<Array<{ cmd: string; desc: string; body: null }>>(
    () =>
      dynCmds
        ? dynCmds.map((c) => ({ cmd: `/${c.name}`, desc: c.description, body: null }))
        : [],
    [dynCmds],
  );
  const slashAll = (() => {
    const seen = new Set<string>();
    const out: Array<{ cmd: string; desc: string; body: string | null; args?: string[]; intent?: string; providerCmd?: string }> = [];
    for (const c of [...pluginCmds, ...builtinCmds, ...agentCmds]) {
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

    /* /context ─ render this session's context-window usage as a card from the
       token figures chat-view already computes (latest-turn input view vs. the
       model's cap). Fleetify-side — never forwarded to the CLI. */
    if (head === "/context") {
      echoUser();
      const used = contextUsedTokens ?? 0;
      const max = contextMaxTokens ?? 0;
      const pct = max > 0 ? Math.round((used / max) * 100) : Math.round((contextPercent ?? 0) * 100);
      pushCard("context", { used_tokens: used, max_tokens: max, percent: pct });
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
          const respawnHint = (tool === "codex-cli" || tool === "gemini-cli")
            ? " Codex/Gemini pick this up on the next spawn — stop and restart the session to apply now."
            : "";
          pushInfo("Permissions updated", `Mode set to ${arg}.${respawnHint}`);
          // mirror to local store so the bottom-left picker reflects it
          useAppStore.getState().updateSession?.(sessionId, { permission_mode: arg });
        })
        .catch((e) => pushInfo("Update failed", String(e instanceof Error ? e.message : e), "error"));
      return true;
    }

    /* /plan, /yolo ─ provider-aware permission-mode switch. Resolves the
       semantic mode to THIS provider's native id and persists it via the same
       PATCH path the bottom-left picker uses — never sends "/plan" to the CLI. */
    if (head === "/plan" || head === "/yolo") {
      echoUser();
      const semantic = head === "/plan" ? "plan" : "yolo";
      const cap = permissionCapabilityFor(providerTiles, tool ?? null);
      const outcome = decideModeCommand(semantic, cap, tool ?? null);
      if (outcome.kind === "info") {
        pushInfo(outcome.title, outcome.message, outcome.tone);
        return true;
      }
      registerConfigPatch(sessionId, apiUpdateSession(sessionId, outcome.patch));
      useAppStore.getState().updateSession?.(sessionId, outcome.patch);
      pushInfo(outcome.title, outcome.message, outcome.tone);
      return true;
    }

    return false;
  }, [sessionId, tool, effort, setEffortLocal, onEffortChange, contextUsedTokens, contextMaxTokens, contextPercent, providerTiles]);

  /** `/prompts` — app-owned. No argument opens the picker; `/prompts <slug>`
   *  resolves and sends the prompt's body, or toasts on an unknown slug. Works
   *  in both a session and the Fleet composer (no provider needed) and runs
   *  before Fleet refine so the command itself is never rewritten. */
  const handlePromptsCommand = useCallback((t: string) => {
    const arg = t.slice("/prompts".length).trim();
    setValue(""); setAttachments([]);
    if (ref.current) ref.current.style.height = "0px";
    if (!arg) { setPromptsOpen(true); return; }
    void (async () => {
      try {
        const list = await listPrompts();
        const hit = resolvePromptArg(list, arg);
        if (hit) onSend(hit.body);
        else setEnhanceToast(`No prompt matches "${arg}"`);
      } catch (e) {
        setEnhanceToast(`Couldn't load prompts: ${e instanceof Error ? e.message : String(e)}`);
      }
    })();
  }, [onSend]);

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
        // Surface the rejection through the shared in-chat error surface —
        // the same <ChatError> a real backend compaction failure routes to,
        // so command errors look like every other error (and there's no
        // transient "Compacting…" pill flash for an instant rejection).
        pushChatError(sessionId, reason);
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
    // Interactive question active → the composer answers it instead of
    // sending a chat message. Enter / Send submits the typed custom answer
    // (if any) or the picked option(s).
    if (askQuestion) {
      advanceAsk();
      return;
    }
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

    // /prompts is app-owned — open the picker or send a named prompt. Handled
    // before the Fleet refine branch so the command is never rewritten.
    if (t.split(/\s+/)[0] === "/prompts") {
      handlePromptsCommand(t);
      return;
    }

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
  }, [value, disabled, streaming, locked, onStop, attachments, fleetActive, refining, pendingRefine, dispatchSend, projectPath, tool, model, sessionId, recordCost, askQuestion, advanceAsk, handlePromptsCommand]);

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

  // Heal a stale permission_mode: if the session (or draft) is carrying a
  // mode id that doesn't exist for its current provider, snap it to the
  // provider's default. Covers existing sessions whose provider was switched
  // elsewhere and draft composers opened before this fix landed.
  // Uses `tool` (from props) directly so this effect can live before
  // chipDispatchTool's declaration. The `modes.some(...)` guard makes this
  // idempotent — no render loop.
  useEffect(() => {
    if (controlCenter) return;
    const cap = permissionCapabilityFor(providerTiles, tool ?? null);
    const modes = permissionModesFor(cap);
    if (modes.length === 0) return; // None capability (Perplexity) — leave as-is
    const current = permissionMode ?? "default";
    if (modes.some((m) => m.id === current)) return; // already valid — no-op
    const defaultMode = modes.find((m) => m.id === "default");
    const def = defaultMode ? defaultMode.id : modes[0]!.id;
    const store = useAppStore.getState();
    // Compose mode: effectiveSessionId is null and the "__composer__" virtual
    // session isn't in sessions[], so heal the composer field directly.
    if (!sessionId) {
      store.setComposerField({ permissionMode: def });
      return;
    }
    const sess = store.sessions.find((s) => s.id === sessionId);
    if (sess?.local_only) {
      store.setDraftField({ permission_mode: def });
      return;
    }
    store.updateSession(sessionId, { permission_mode: def });
    apiUpdateSession(sessionId, { permission_mode: def }).catch(() => {});
  }, [sessionId, tool, permissionMode, providerTiles, controlCenter]);

  /* ── drag & drop ── */
  const onDragOver  = useCallback((e: React.DragEvent) => { e.preventDefault(); setDragging(true); }, []);
  const onDragLeave = useCallback(() => setDragging(false), []);
  const onDrop      = useCallback((e: React.DragEvent) => {
    e.preventDefault(); setDragging(false);
    if (e.dataTransfer.files.length > 0) addFiles(e.dataTransfer.files);
  }, [addFiles]);

  /* ── derived ── */
  const hasText    = value.trim().length > 0;
  // While a question is active the Send button answers it: enabled when an
  // option is picked OR the user typed a custom answer.
  const canSend    = askActive
    ? (askAnyPicked || hasText) && !streaming
    : (hasText || attachments.length > 0) && !disabled && !streaming && !locked;
  const btnActive  = streaming || canSend;
  // Resolve the chip face (provider icon + label) via the shared resolver
  // against the SAME groups the dropdown uses — identical logic to the
  // SessionToolbar chip, so the two never disagree. `fmtModel` remains the
  // last-resort label for ids not present in any group (rare cold-start).
  const { dispatchTool: chipDispatchTool, label: chipLabel } = resolveModelChip(
    pickerGroups,
    tool ?? "claude-code",
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
            tool={tool ?? "claude-code"}
            model={model ?? null}
            effort={effort as UMEffort}
            groups={pickerGroups}
            onPickModel={(groupId, modelId) => {
              if (groupId === "auto") {
                // Auto is Fleet-owned: the backend routes via Fleet's own Not
                // Diamond key (.env), independent of the user's Settings →
                // Routers config. Just pin the routing sentinel.
                if (sessionId) {
                  registerConfigPatch(sessionId, apiUpdateSession(sessionId, { tool: "auto", model_name: "auto" }));
                  useAppStore.getState().updateSession(sessionId, { tool: "auto", model_name: "auto" });
                } else {
                  useAppStore.getState().setComposerField({ tool: "auto", modelName: "auto" });
                }
                return;
              }
              const dispatchTool = resolveDispatchTool(groupId);
              const tid = dispatchTool as import("@/types/session").AgentTool;
              if (sessionId) {
                // Active session: change tool + model (cross-provider) or
                // just model (same-provider). `onModelChange` covers the
                // same-provider path via the parent's handleModelChange.
                if (dispatchTool !== tool) {
                  // Cross-provider: snap permission_mode to the new provider's
                  // default and clear sandbox so stale values from the old
                  // provider don't leak through.
                  const cap = permissionCapabilityFor(providerTiles, dispatchTool);
                  const patch = { tool: tid, model_name: modelId, permission_mode: defaultPermissionMode(cap), sandbox: null as string | null };
                  registerConfigPatch(sessionId, apiUpdateSession(sessionId, patch));
                  useAppStore.getState().updateSession(sessionId, patch);
                } else {
                  onModelChange?.(modelId);
                }
              } else {
                // Composer / Control Center — no session row exists yet.
                // Write the pick into the open composer so `commitComposer`
                // creates the new session with the right (tool, model)
                // pair. Snap permission + clear sandbox for the new provider.
                const cap = permissionCapabilityFor(providerTiles, dispatchTool);
                useAppStore.getState().setComposerField({ tool: tid, modelName: modelId, permissionMode: defaultPermissionMode(cap), sandbox: null });
              }
            }}
            onPickEffort={(e) => setEffort(e)}
            onClose={() => setOpenDrop(null)}
            anchor="bottom"
            contextPercent={contextPercent}
            contextUsedTokens={contextUsedTokens}
            contextMaxTokens={contextMaxTokens}
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
        <PromptsPicker
          open={promptsOpen}
          onClose={() => setPromptsOpen(false)}
          onPick={(p) => { setPromptsOpen(false); onSend(p.body); }}
        />

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
          <div style={{ marginBottom: 5 }}>
            <BranchStrip
              projectPath={worktreePath || projectPath}
              sourcePath={projectPath}
              tool={tool}
              controlCenter={controlCenter}
              sessionTitle={sessionTitle}
              plannedBranch={sessionId ? computeBranchName(sessionTitle, sessionId, projectPath) : null}
              isWorktree={!!worktreePath}
              onResolveConflicts={(p) => onSend(p)}
              permissionMode={permissionMode}
            />
          </div>
        )}

        {/* ── Main box ── */}
        <div
          onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}
          style={{
            // 8px corners — sharp / minimal (Cursor-style), not pill-soft.
            borderRadius: 8,
            position: "relative",
            // Four-tier border: rest / focused / dragging /
            // ENHANCING. Enhancing keeps a soft blue base ring
            // (so the box still reads as "in enhance mode" when
            // the traveling line is on the far side); the actual
            // animated stroke is the SVG overlay rendered as the
            // last child below.
            border: `1px solid ${
              enhancing ? "var(--c-brd2)"
              : dragging ? "rgba(var(--fg-rgb),0.28)"
              : focused ? "var(--c-brd2)"
              : "var(--c-brd)"
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
            // visible (was hidden) — the toolbar now lives INSIDE this card,
            // and its model / permission / MCP popovers open UPWARD. With
            // overflow:hidden they'd be clipped by the card's top edge. The
            // rounded corners are still clipped by border-radius on the
            // background itself; only the escaping popovers need to overflow.
            overflow: "visible",
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

          {/* ── Inline AskUserQuestion ── The composer GROWS to host the
              question: header + options render here, the textarea below
              becomes the custom-answer field, and Send submits the pick or
              the typed text. Animated open/close so the box grows then
              shrinks. Fully monochrome — composer design language. */}
          <div style={{
            display: "grid",
            gridTemplateRows: askActive ? "1fr" : "0fr",
            transition: "grid-template-rows 0.24s cubic-bezier(0.22,1,0.36,1)",
          }}>
            <div style={{ overflow: "hidden" }}>
              {askQuestion && (() => {
                const q = askQuestion.questions[askStep];
                if (!q) return null;
                const multi = q.multiSelect ?? false;
                const chosen = askSelected[askStep] ?? [];
                return (
                <div style={{ padding: "12px 13px 4px" }}>
                  {/* Header — eyebrow + step counter (only when multi-question) */}
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 7 }}>
                    <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.3px", textTransform: "uppercase", color: "var(--c-dim)" }}>
                      Question
                    </span>
                    {askCount > 1 && (
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                        {askQuestion.questions.map((_, i) => (
                          <span key={i} aria-hidden style={{
                            width: i === askStep ? 14 : 5, height: 5, borderRadius: 3,
                            background: i < askStep ? "var(--c-low)" : i === askStep ? "var(--c-high)" : "rgba(var(--fg-rgb),0.18)",
                            transition: "width 0.2s, background 0.2s",
                          }}/>
                        ))}
                        <span style={{ fontSize: 10.5, color: "var(--c-dim)", fontFamily: "var(--font-mono)", marginLeft: 4 }}>
                          {askStep + 1}/{askCount}
                        </span>
                      </span>
                    )}
                  </div>

                  <div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--c-high)", lineHeight: 1.4, marginBottom: 9 }}>
                    {q.question}
                  </div>

                  <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                    {q.options.map(opt => {
                      const isOn = chosen.includes(opt.label);
                      return (
                        <button
                          key={opt.label}
                          onClick={() => {
                            if (multi) { toggleAskOption(askStep, opt.label, true); return; }
                            // Single-select → record + auto-advance (or submit
                            // if last). Build the answer from the clicked label
                            // directly so we don't depend on async state.
                            const next = { ...askSelected, [askStep]: [opt.label] };
                            setAskSelected(next);
                            setValue("");
                            if (askIsLast && onAnswerQuestion && askQuestion) {
                              onAnswerQuestion(askQuestion.id, askQuestion.questions.map((qq, i) => ({
                                header: qq.header, question: qq.question, selected: next[i] ?? [],
                              })));
                              setAskSelected({}); setAskStep(0);
                            } else {
                              setAskStep(s => s + 1);
                            }
                          }}
                          onMouseDown={e => e.preventDefault()}
                          onMouseEnter={e => { if (!isOn) (e.currentTarget as HTMLButtonElement).style.background = "rgba(var(--fg-rgb),0.04)"; }}
                          onMouseLeave={e => { if (!isOn) (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
                          style={{
                            display: "flex", alignItems: "flex-start", gap: 10,
                            width: "100%", textAlign: "left", padding: "9px 11px",
                            borderRadius: 7,
                            border: `1px solid ${isOn ? "var(--c-brd2)" : "var(--c-brd)"}`,
                            background: isOn ? "rgba(var(--fg-rgb),0.07)" : "transparent",
                            color: "var(--c-high)", fontSize: 12.5, fontFamily: "inherit",
                            cursor: "pointer", transition: "border-color 0.12s, background 0.12s",
                          }}
                        >
                          {/* Tick — filled accent with a crisp check when on;
                              clean hollow ring/box when off. */}
                          <span aria-hidden style={{
                            width: 17, height: 17, flexShrink: 0, marginTop: 0.5,
                            borderRadius: multi ? 5 : "50%",
                            border: `1.5px solid ${isOn ? "var(--c-high)" : "rgba(var(--fg-rgb),0.28)"}`,
                            background: isOn ? "var(--c-high)" : "transparent",
                            display: "inline-flex", alignItems: "center", justifyContent: "center",
                            transition: "background 0.12s, border-color 0.12s",
                          }}>
                            {isOn && <Check size={11} strokeWidth={3} style={{ color: "var(--background)" }} />}
                          </span>
                          <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                            <span style={{ fontWeight: 500, lineHeight: 1.35, color: isOn ? "var(--c-high)" : "var(--c-med)" }}>{opt.label}</span>
                            {opt.description && (
                              <span style={{ fontSize: 11.5, color: "var(--c-dim)", lineHeight: 1.4 }}>{opt.description}</span>
                            )}
                          </span>
                        </button>
                      );
                    })}
                  </div>

                  {/* Action row — Skip (left), Back (when stepped), Next/Submit (right) */}
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
                    <button
                      onClick={() => { if (askQuestion && onSkipQuestion) onSkipQuestion(askQuestion.id); }}
                      onMouseDown={e => e.preventDefault()}
                      style={{
                        height: 26, padding: "0 9px", background: "transparent", border: "none",
                        borderRadius: 6, color: "var(--c-dim)", fontSize: 12, fontWeight: 500,
                        cursor: "pointer", fontFamily: "inherit",
                      }}
                    >Skip</button>
                    {askStep > 0 && (
                      <button
                        onClick={() => { setAskStep(s => Math.max(0, s - 1)); setValue(""); }}
                        onMouseDown={e => e.preventDefault()}
                        style={{
                          height: 26, padding: "0 9px", background: "transparent", border: "none",
                          borderRadius: 6, color: "var(--c-low)", fontSize: 12, fontWeight: 500,
                          cursor: "pointer", fontFamily: "inherit",
                        }}
                      >Back</button>
                    )}
                    <div style={{ flex: 1 }} />
                    {/* Next/Submit — for multi-select & custom answers. Single-
                        select auto-advances on click, so it only shows when
                        the current step is answerable that way. */}
                    {(multi ? askStepAnswered : false) || hasText ? (
                      <button
                        onClick={advanceAsk}
                        onMouseDown={e => e.preventDefault()}
                        style={{
                          height: 26, padding: "0 14px",
                          background: "var(--c-high)", border: "1px solid var(--c-high)",
                          borderRadius: 6, color: "var(--background)",
                          fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
                        }}
                      >{askIsLast ? "Submit" : "Next"}</button>
                    ) : null}
                  </div>
                  <div style={{ height: 1, background: "var(--c-brd)", margin: "9px -13px 0" }} />
                </div>
                );
              })()}
            </div>
          </div>

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
                  padding: attachments.length > 0 ? "11px 13px 7px 13px" : "12px 13px 7px 13px",
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
              // Tight single-line composer when empty — grows as the user
              // types. The toolbar sits right below so there's no dead
              // vertical void in the card.
              // Tighter top padding while a question is open so the custom-
              // answer line sits snug under the divider (no dead gap).
              padding: askActive
                ? "8px 13px 6px 13px"
                : attachments.length > 0
                ? "11px 13px 7px 13px"
                : "12px 13px 7px 13px",
              background: "transparent", border: "none", outline: "none", resize: "none",
              fontSize: 13, lineHeight: 1.5, color: "var(--foreground)", fontFamily: "inherit",
              minHeight: askActive ? 20 : 22, maxHeight: 220, overflowY: "auto", boxSizing: "border-box",
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

          {/* (Send button lives in the in-box toolbar row below now —
              see the right cluster — so the input area stays a clean
              text field with no floating glyph.) */}

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

          {/* ── In-box toolbar ── the control row lives INSIDE the input
              card (bottom bar), so the whole composer reads as ONE cohesive
              surface: text field on top, controls + Send on the bottom edge.
              Left = permission + tool actions; right = model chip + Send. */}
          <div style={{
            display: "flex", alignItems: "center",
            padding: "1px 8px 8px", gap: 1,
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
              <>
                <PermissionModePicker
                  mode={permissionMode ?? "default"}
                  modes={permissionModesFor(permissionCapabilityFor(providerTiles, chipDispatchTool))}
                  onPick={(m) => {
                    const store = useAppStore.getState();
                    // Compose mode: sessionId is null + the virtual session isn't
                    // in sessions[], so write straight to the composer.
                    if (!sessionId) { store.setComposerField({ permissionMode: m }); return; }
                    const session = store.sessions.find(s => s.id === sessionId);
                    if (session?.local_only) {
                      store.setDraftField({ permission_mode: m });
                      return;
                    }
                    store.updateSession(sessionId, { permission_mode: m });
                    apiUpdateSession(sessionId, { permission_mode: m }).catch(() => {});
                  }}
                />
                {(() => {
                  const sandboxOpts = sandboxOptionsFor(providerTiles, chipDispatchTool);
                  if (!sandboxOpts) return null;
                  return (
                    <SandboxControl
                      options={sandboxOpts}
                      value={sandbox ?? null}
                      onChange={(v) => {
                        const st = useAppStore.getState();
                        if (!sessionId) { st.setComposerField({ sandbox: v ?? null }); return; }
                        const sess = st.sessions.find(s => s.id === sessionId);
                        if (sess?.local_only) {
                          st.setDraftField({ sandbox: v ?? undefined });
                          return;
                        }
                        st.updateSession(sessionId, { sandbox: v });
                        apiUpdateSession(sessionId, { sandbox: v }).catch(() => {});
                      }}
                    />
                  );
                })()}
                {(() => {
                  const matrix = toolMatrixFor(providerTiles, chipDispatchTool);
                  if (!matrix) return null;
                  const currentOverrides = parseToolOverrides(toolOverridesRaw);
                  return (
                    <ToolMatrixEditor
                      matrix={matrix}
                      overrides={currentOverrides}
                      onChange={(next) => {
                        const st = useAppStore.getState();
                        const serialized = Object.keys(next).length === 0 ? "{}" : JSON.stringify(next);
                        if (!sessionId) { st.setComposerField({ toolOverrides: serialized }); return; }
                        const sess = st.sessions.find(s => s.id === sessionId);
                        if (sess?.local_only) {
                          st.setDraftField({ tool_overrides: serialized });
                          return;
                        }
                        st.updateSession(sessionId, { tool_overrides: serialized });
                        apiUpdateSession(sessionId, { tool_overrides: serialized }).catch(() => {});
                      }}
                    />
                  );
                })()}
              </>
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

            {/* Tool cluster — sleeker. The frequent actions stay visible
                (Plus = attach, Mic = voice), and the secondary actions
                (Enhance + Transcript view) collapse into a single "More"
                popover so the footer reads as 3 buttons instead of 5.
                Result: same affordances, calmer row. */}
            <ToolBtn title="Attach file (or drag & drop)" onClick={() => fileRef.current?.click()}><Plus size={14} strokeWidth={1.9} /></ToolBtn>
            <MoreActionsMenu
              onEnhance={() => void handleEnhance()}
              enhancing={enhancing}
              canEnhance={!enhancing && !disabled && !locked && hasText}
            />
            <MicButton onTranscript={insertVoiceText} />
          </div>

          {/* RIGHT — Routing · Model · MCP. Plain row, no enclosing pill or
              dividers, so the right side reads the SAME way as the left
              (Bypass + tool icons). RoutingChip / MCPStatusButton self-hide
              when their service is off (lit=false / 0 servers) so the row
              stays compact when nothing's live. */}
          <div style={{
            display: "inline-flex", alignItems: "center", gap: 6,
            flexShrink: 0,
          }}>
            <RoutingChip />
            <button
              data-model-trigger="1"
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
              <span style={{ color: "var(--c-low)", fontSize: 10.5 }}>{effortLabel(effort)}</span>
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

            {/* Context-window indicator moved OUT of the toolbar — it now
                lives inside the model picker (click the model chip → context
                usage shown at the bottom). Keeps the toolbar minimal. */}

            {/* Send / stop — ultra-minimal: a bare ↑ glyph, no fill, no
                border. Brightens from low→high as the prompt becomes
                sendable; streaming shows a red ▢ stop. Subtle hover bg keeps
                it tactile without chrome. */}
            <button
              onClick={submit}
              title={streaming ? "Stop (Esc)" : "Send (Enter)"}
              disabled={!btnActive}
              onMouseDown={e => e.preventDefault()}
              style={{
                marginLeft: 2,
                width: 24, height: 24, borderRadius: 5, flexShrink: 0,
                display: "inline-flex", alignItems: "center", justifyContent: "center",
                background: "transparent",
                border: "none", outline: "none",
                color: streaming
                  ? "#f87171"
                  : canSend
                    ? "var(--c-high)"
                    : "var(--c-dim)",
                cursor: btnActive ? "pointer" : "default",
                transition: "background 0.12s, color 0.12s",
              }}
              onMouseEnter={e => {
                if (!btnActive) return;
                e.currentTarget.style.background = streaming
                  ? "rgba(248,113,113,0.12)"
                  : "rgba(var(--fg-rgb),0.06)";
                if (!streaming) e.currentTarget.style.color = "var(--c-high)";
              }}
              onMouseLeave={e => {
                e.currentTarget.style.background = "transparent";
                if (!streaming) e.currentTarget.style.color = canSend ? "var(--c-high)" : "var(--c-dim)";
              }}
            >
              {streaming
                ? <Square size={11} strokeWidth={0} style={{ fill: "currentColor" }} />
                : <ArrowUp size={16} strokeWidth={2.2} />}
            </button>

          </div>
        </div>
      </div>
      </div>
    </div>
  );
}
