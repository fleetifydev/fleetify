/**
 * Settings page — full-viewport route, NOT a modal.
 *
 * Rendered by App.tsx in place of the main shell when the user opens
 * Settings (sidebar Settings button → fleet:open-settings event).
 * Closing (X / Esc / Sign-out) goes back to wherever the user was.
 *
 * Layout: 220px sidebar on the left, scrollable content on the right.
 * Every preference is a Card containing one or more Rows separated by
 * hairlines. Toggles are pill-shaped (green when on). Section headers
 * are quiet uppercase letter-spaced labels.
 *
 * Sections live as discrete components so this file stays scannable
 * even as the catalog grows (Account, General, Appearance, Models,
 * MCPs, plus stubs for the rest).
 */
import { useState, useEffect, useCallback } from "react";
import {
  Settings, Palette, Wand2, Cpu, Plug, Cable,
  FileCode, Webhook, FileText, FolderOpen, Loader2, Bug,
  Check, User, ArrowUpRight, HelpCircle, Sun, ArrowLeft,
  Eye, EyeOff, Volume2, Copy, MessageCircle,
} from "lucide-react";
import { isWindowsPlatform } from "@/lib/utils";
import { useAppStore } from "@/stores/app-store";
import { useThemeStore } from "@/stores/theme-store";
import { THEMES } from "@/lib/themes";
import type { ColorTheme } from "@/stores/theme-store";
import { MCPSection } from "./settings/mcp-section";
import { IntegrationsSection } from "./settings/integrations-section";
import { WindowsTitleBar } from "./layout/windows-title-bar";
import { openDocs } from "./layout/sidebar";
import { FeedbackModal } from "./feedback-modal";

interface SettingsProps {
  /** Tab to land on (e.g. "Account" / "Appearance"). Defaults to General. */
  initialTab?: string;
  /** Called when the user closes Settings (X button, Esc key, Sign-out). */
  onClose: () => void;
}

const NAV: { id: string; icon: React.FC<{ size?: number; style?: React.CSSProperties }> }[] = [
  { id: "Account",      icon: User       },
  { id: "General",      icon: Settings   },
  { id: "Appearance",   icon: Palette    },
  { id: "Agents",       icon: Wand2      },
  { id: "Models",       icon: Cpu        },
  { id: "Plugins",      icon: Plug       },
  { id: "Integrations", icon: Cable      },
  { id: "Rules",        icon: FileCode   },
  { id: "Tools & MCPs", icon: Webhook    },
  { id: "Diagnostics",  icon: Bug        },
];

/* ── Audible "ding" using WebAudio. Used both as the test-button
   action in Settings and (eventually) by the agent-completion event. ── */
function playCompletionBeep() {
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(660, ctx.currentTime + 0.18);
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.32);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.34);
    osc.onended = () => { ctx.close().catch(() => {}); };
  } catch { /* WebAudio unavailable — silently no-op */ }
}

/* ══ Local-storage hook for boolean toggles ══════════════════════
   Persists the current state under "fleet:settings:<key>". Default
   value is used on first read. Writes happen synchronously on every
   change — fine because settings change is a rare event. */
function useToggle(key: string, defaultValue: boolean): [boolean, () => void] {
  const [v, setV] = useState<boolean>(() => {
    try {
      const raw = localStorage.getItem(`fleet:settings:${key}`);
      return raw == null ? defaultValue : raw === "1";
    } catch {
      return defaultValue;
    }
  });
  const toggle = useCallback(() => {
    setV(prev => {
      const next = !prev;
      try { localStorage.setItem(`fleet:settings:${key}`, next ? "1" : "0"); } catch { /* noop */ }
      return next;
    });
  }, [key]);
  return [v, toggle];
}

/* ── Toggle — pill switch ─────────────────────────────────────── */
function Toggle({ on, onChange }: { on: boolean; onChange: () => void }) {
  return (
    <button
      onClick={onChange}
      role="switch"
      aria-checked={on}
      style={{
        width: 36, height: 21, borderRadius: 999,
        padding: 0,
        position: "relative",
        border: "1px solid var(--c-brd)",
        cursor: "pointer", flexShrink: 0,
        background: on ? "rgb(74,222,128)" : "var(--c-srf)",
        transition: "background 0.18s, border-color 0.18s",
        outline: "none",
      }}
    >
      <span style={{
        position: "absolute",
        top: 2, left: on ? 17 : 2,
        width: 15, height: 15, borderRadius: "50%",
        background: "#fff",
        boxShadow: "0 1px 2px rgba(0,0,0,0.25)",
        transition: "left 0.18s cubic-bezier(0.4,0,0.2,1)",
      }} />
    </button>
  );
}

/* ── Row — single preference row inside a Card ────────────────── */
function Row({
  title, desc, children, last,
}: {
  title: string;
  desc?: string;
  children?: React.ReactNode;
  last?: boolean;
}) {
  return (
    <div style={{
      display: "flex", alignItems: "center", justifyContent: "space-between",
      padding: "13px 14px", gap: 16,
      borderBottom: last ? "none" : "1px solid var(--c-brd)",
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 13, fontWeight: 500,
          color: "var(--c-high)",
          lineHeight: 1.3,
        }}>
          {title}
        </div>
        {desc && (
          <div style={{
            fontSize: 12, color: "var(--c-low)",
            marginTop: 3, lineHeight: 1.5,
          }}>
            {desc}
          </div>
        )}
      </div>
      {children && <div style={{ flexShrink: 0 }}>{children}</div>}
    </div>
  );
}

/* ── Card — bordered group containing 1+ Rows ───────────────────
   Cards in Fleet share the SAME background as the page they sit on
   (var(--card)) and lean on a 1px border for visual separation —
   same pattern mcp-card, staff-message-cards, and the chat-view
   notification cards use. Filling cards with the lighter --c-srf
   grey was the mistake the user flagged: it made cards read as
   "uploaded" patches against the surface instead of being part of
   the same surface. Hierarchy inside the card now comes from the
   subtler --c-srf inputs / pills, not from the card itself. */
function Card({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{
      borderRadius: 10,
      border: "1px solid var(--c-brd)",
      background: "var(--card)",
      overflow: "hidden",
      marginBottom: 22,
      ...style,
    }}>
      {children}
    </div>
  );
}

/* ── Section header — small uppercase letter-spaced label ─────── */
function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontSize: 10.5, fontWeight: 600, letterSpacing: "0.10em",
      color: "var(--c-dim)",
      textTransform: "uppercase",
      marginTop: 4, marginBottom: 10,
      paddingLeft: 1,
    }}>
      {children}
    </div>
  );
}

/* ── Buttons ──────────────────────────────────────────────────── */
const btnGhost: React.CSSProperties = {
  fontFamily: "inherit", cursor: "pointer", outline: "none",
  display: "inline-flex", alignItems: "center", gap: 5,
  padding: "6px 12px", borderRadius: 7, fontSize: 12.5, fontWeight: 500,
  background: "transparent",
  border: "1px solid var(--c-brd)",
  color: "var(--c-high)",
  transition: "background 0.12s, border-color 0.12s",
};

const btnPrimary: React.CSSProperties = {
  fontFamily: "inherit", cursor: "pointer", outline: "none",
  display: "inline-flex", alignItems: "center", gap: 5,
  padding: "6px 14px", borderRadius: 7, fontSize: 12.5, fontWeight: 600,
  background: "var(--c-high)",
  border: "none",
  color: "var(--card)",
  transition: "opacity 0.12s, transform 0.08s",
};

const btnDanger: React.CSSProperties = {
  fontFamily: "inherit", cursor: "pointer", outline: "none",
  display: "inline-flex", alignItems: "center", gap: 5,
  padding: "6px 12px", borderRadius: 7, fontSize: 12.5, fontWeight: 500,
  background: "rgba(248,113,113,0.10)",
  border: "1px solid rgba(248,113,113,0.30)",
  color: "rgb(248,113,113)",
};

function GhostButton({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) {
  return (
    <button
      onClick={onClick}
      style={btnGhost}
      onMouseEnter={e => {
        e.currentTarget.style.background = "var(--c-srf2)";
        e.currentTarget.style.borderColor = "var(--c-brd2)";
      }}
      onMouseLeave={e => {
        e.currentTarget.style.background = "transparent";
        e.currentTarget.style.borderColor = "var(--c-brd)";
      }}
    >
      {children}
    </button>
  );
}

function PrimaryButton({ children, onClick, disabled }: { children: React.ReactNode; onClick?: () => void; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{ ...btnPrimary, opacity: disabled ? 0.5 : 1, cursor: disabled ? "default" : "pointer" }}
      onMouseEnter={e => { if (!disabled) e.currentTarget.style.opacity = "0.85"; }}
      onMouseLeave={e => { if (!disabled) e.currentTarget.style.opacity = "1"; }}
      onMouseDown={e => { if (!disabled) e.currentTarget.style.transform = "translateY(0.5px)"; }}
      onMouseUp={e => { if (!disabled) e.currentTarget.style.transform = "none"; }}
    >
      {children}
    </button>
  );
}

/* ── FleetConfig hook — load once, expose patch helper ────────── */
function useFleetConfig() {
  const [cfg, setCfg] = useState<FleetConfig | null>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let mounted = true;
    window.electronAPI?.getConfig?.()
      .then(c => { if (mounted) { setCfg(c ?? { onboardingComplete: false, apiKeys: {} }); setLoaded(true); } })
      .catch(() => { if (mounted) { setCfg({ onboardingComplete: false, apiKeys: {} }); setLoaded(true); } });
    return () => { mounted = false; };
  }, []);

  const patch = useCallback(async (next: Partial<FleetConfig>) => {
    const base: FleetConfig = { onboardingComplete: false, apiKeys: {}, ...(cfg ?? {}) };
    const merged: FleetConfig = {
      ...base,
      ...next,
      apiKeys: { ...(base.apiKeys ?? {}), ...(next.apiKeys ?? {}) },
    };
    setCfg(merged);
    try { await window.electronAPI?.setConfig?.(merged); } catch { /* noop */ }
  }, [cfg]);

  return { cfg, loaded, patch };
}

/* ── Select — themed dropdown matching the input chrome ───────── */
function Select<T extends string>({
  value, options, onChange, width = 160,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  width?: number;
}) {
  return (
    <div style={{ position: "relative", width }}>
      <select
        value={value}
        onChange={e => onChange(e.target.value as T)}
        style={{
          width: "100%", boxSizing: "border-box",
          appearance: "none",
          background: "var(--c-srf)",
          border: "1px solid var(--c-brd)",
          borderRadius: 7, padding: "6px 26px 6px 10px",
          fontSize: 12.5, color: "var(--c-high)",
          fontFamily: "inherit", outline: "none", cursor: "pointer",
          transition: "border-color 0.12s",
        }}
        onFocus={e => (e.currentTarget.style.borderColor = "var(--c-brd2)")}
        onBlur={e => (e.currentTarget.style.borderColor = "var(--c-brd)")}
      >
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <span style={{
        position: "absolute", right: 8, top: "50%",
        transform: "translateY(-50%) rotate(45deg)",
        width: 6, height: 6,
        borderRight: "1.5px solid var(--c-low)",
        borderBottom: "1.5px solid var(--c-low)",
        pointerEvents: "none",
      }} />
    </div>
  );
}

/* ── useConfigField — one-liner read/write against FleetConfig ── */
function useConfigField<K extends keyof FleetConfig>(
  key: K,
  fallback: NonNullable<FleetConfig[K]>,
): [NonNullable<FleetConfig[K]>, (v: NonNullable<FleetConfig[K]>) => void, boolean] {
  const { cfg, loaded, patch } = useFleetConfig();
  const value = (cfg?.[key] ?? fallback) as NonNullable<FleetConfig[K]>;
  const setValue = (v: NonNullable<FleetConfig[K]>) => {
    void patch({ [key]: v } as unknown as Partial<FleetConfig>);
  };
  return [value, setValue, loaded];
}

/* ══════════════════════════════════════════════════════════════
   Section: Account
══════════════════════════════════════════════════════════════ */
/* ── Diagnostics ───────────────────────────────────────────────────
   Three actions the user / support might need:
     • Export logs — bundles the last N days of on-disk log files +
                     system info JSON into a single .zip the user
                     attaches to a bug report.
     • Open log folder — reveals the log directory in the OS file
                         manager. For power users who want to tail
                         live or scrub specific files manually.
     • Copy diagnostic info — short JSON dump (app version, OS, arch,
                              user agent) on the clipboard. Useful in
                              quick async support exchanges where the
                              full zip is overkill.

   No PII / credentials surface in any of these — the export bundles
   logs that the backend redact layer already scrubbed, and the
   diagnostic info is build metadata only. */
function DiagnosticsSection() {
  const [exporting, setExporting] = useState(false);
  const [opening,   setOpening]   = useState(false);
  const [copied,    setCopied]    = useState(false);
  const [status,    setStatus]    = useState<string | null>(null);
  const [error,     setError]     = useState<string | null>(null);

  const onExport = useCallback(async () => {
    setStatus(null); setError(null); setExporting(true);
    try {
      const r = await window.electronAPI?.logsExport?.();
      if (!r) { setError("Logging IPC unavailable."); return; }
      if (!r.ok) { setError(r.error || "Export failed."); return; }
      const mb = (r.bytes / (1024 * 1024)).toFixed(2);
      setStatus(`Saved diagnostics bundle (${mb} MB)`);
      // Reveal the zip in OS file manager so the user can grab it
      // without having to memorise the temp dir path.
      try { await window.electronAPI?.showItemInFolder?.(r.path); } catch { /* best effort */ }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Export failed.");
    } finally {
      setExporting(false);
    }
  }, []);

  const onOpenFolder = useCallback(async () => {
    setStatus(null); setError(null); setOpening(true);
    try {
      const r = await window.electronAPI?.logsOpenFolder?.();
      if (!r) { setError("Logging IPC unavailable."); return; }
      if (!r.ok) { setError(r.error || "Couldn't open folder."); return; }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't open folder.");
    } finally {
      setOpening(false);
    }
  }, []);

  const onCopyDiag = useCallback(async () => {
    setStatus(null); setError(null);
    const info = {
      app_version: __APP_VERSION__ ?? "unknown",
      user_agent: typeof navigator !== "undefined" ? navigator.userAgent : null,
      language: typeof navigator !== "undefined" ? navigator.language : null,
      platform: typeof navigator !== "undefined" ? navigator.platform : null,
      captured_at: new Date().toISOString(),
    };
    try {
      await navigator.clipboard.writeText(JSON.stringify(info, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't copy.");
    }
  }, []);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
      <div>
        <h2 style={{ fontSize: 14, fontWeight: 600, color: "var(--c-high)", margin: "0 0 4px" }}>
          Logs & diagnostics
        </h2>
        <p style={{ fontSize: 12.5, color: "var(--c-med)", margin: 0, lineHeight: 1.55, maxWidth: 540 }}>
          Fleetify keeps the last 30 days of logs locally on your machine —
          tokens, API keys, and message bodies are scrubbed before they hit
          disk. Export the bundle and share it with support when you run into
          a bug.
        </p>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8, maxWidth: 540 }}>
        <DiagButton
          icon={exporting ? <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} /> : <FileText size={14} />}
          label={exporting ? "Bundling…" : "Export logs"}
          hint="Save a .zip of recent logs + system info"
          onClick={onExport}
          disabled={exporting}
          primary
        />
        <DiagButton
          icon={opening ? <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} /> : <FolderOpen size={14} />}
          label={opening ? "Opening…" : "Open log folder"}
          hint="Reveal the on-disk log directory"
          onClick={onOpenFolder}
          disabled={opening}
        />
        <DiagButton
          icon={copied ? <Check size={14} /> : <Copy size={14} />}
          label={copied ? "Copied" : "Copy diagnostic info"}
          hint="Build version + OS + locale on the clipboard"
          onClick={onCopyDiag}
        />
      </div>

      {status && (
        <div style={{
          padding: "9px 12px", borderRadius: 7,
          background: "rgba(74,222,128,0.08)",
          border: "1px solid rgba(74,222,128,0.25)",
          color: "rgb(74,222,128)",
          fontSize: 12.5,
          maxWidth: 540,
        }}>{status}</div>
      )}
      {error && (
        <div style={{
          padding: "9px 12px", borderRadius: 7,
          background: "rgba(248,113,113,0.08)",
          border: "1px solid rgba(248,113,113,0.30)",
          color: "rgb(248,113,113)",
          fontSize: 12.5,
          maxWidth: 540,
        }}>{error}</div>
      )}
    </div>
  );
}

function DiagButton({
  icon, label, hint, onClick, disabled, primary,
}: {
  icon: React.ReactNode;
  label: string;
  hint: string;
  onClick: () => void;
  disabled?: boolean;
  primary?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        display: "flex", alignItems: "center", gap: 10,
        padding: "11px 13px",
        background: primary ? "var(--c-fg)" : "rgba(var(--fg-rgb), 0.04)",
        border: primary ? "1px solid var(--c-fg)" : "1px solid var(--c-brd)",
        borderRadius: 8,
        color: primary ? "var(--c-bg, #0c0c0c)" : "var(--c-high)",
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.55 : 1,
        fontFamily: "inherit",
        textAlign: "left",
        transition: "background 0.12s, border-color 0.12s",
      }}
      onMouseEnter={e => {
        if (disabled) return;
        if (!primary) e.currentTarget.style.background = "rgba(var(--fg-rgb), 0.07)";
      }}
      onMouseLeave={e => {
        if (disabled) return;
        if (!primary) e.currentTarget.style.background = "rgba(var(--fg-rgb), 0.04)";
      }}
    >
      <span style={{ display: "inline-flex", flexShrink: 0 }}>{icon}</span>
      <span style={{ flex: 1, display: "flex", flexDirection: "column", gap: 1 }}>
        <span style={{ fontSize: 13, fontWeight: 600 }}>{label}</span>
        <span style={{
          fontSize: 11.5,
          color: primary ? "rgba(0,0,0,0.65)" : "var(--c-low)",
          fontWeight: 400,
        }}>{hint}</span>
      </span>
    </button>
  );
}

// Build-time replaced by Vite's `define` if configured; falls back to
// the package version otherwise. We keep this string literal so the
// renderer doesn't need a runtime fetch for something this static.
declare const __APP_VERSION__: string | undefined;

function AccountSection() {
  const { patch } = useFleetConfig();
  const raw = (() => {
    try { return localStorage.getItem("fleet:user"); } catch { return null; }
  })();
  const stored = raw ? (() => { try { return JSON.parse(raw); } catch { return null; } })() : null;

  const [name, setName] = useState<string>(stored?.name ?? "");
  const [saved, setSaved] = useState(false);
  const [copiedId, setCopiedId] = useState(false);
  const email = stored?.email ?? "";
  const accountId = stored?.id ?? "";
  // First-launch timestamp — best-effort. Stored on first sign-in so we can
  // surface a "joined" date without a backend round-trip.
  const memberSince = (() => {
    try {
      const v = localStorage.getItem("fleet:member-since");
      if (v) return v;
      const now = new Date().toISOString();
      localStorage.setItem("fleet:member-since", now);
      return now;
    } catch { return null; }
  })();
  const dirty = name.trim() !== (stored?.name ?? "");

  const initials = (name
    .split(/\s+/)
    .slice(0, 2)
    .map((w: string) => w[0]?.toUpperCase() ?? "")
    .join("") || email[0]?.toUpperCase() || "?").slice(0, 2);

  const handleSave = async () => {
    const trimmed = name.trim();
    try {
      const next = { ...(stored ?? {}), name: trimmed };
      localStorage.setItem("fleet:user", JSON.stringify(next));
    } catch { /* noop */ }
    await patch({ userName: trimmed });
    setSaved(true);
    setTimeout(() => setSaved(false), 1800);
  };

  const copyId = () => {
    if (!accountId) return;
    void window.electronAPI?.writeText?.(accountId);
    setCopiedId(true);
    setTimeout(() => setCopiedId(false), 1400);
  };

  const memberLabel = memberSince
    ? new Date(memberSince).toLocaleDateString(undefined, { year: "numeric", month: "long" })
    : "—";

  return (
    <>
      {/* ── Identity hero ──
          Sits above the section headers as the page's "who you are"
          anchor. Bigger avatar (56), name as the typographic centre,
          email as quiet metadata. No card chrome around it — the page
          background carries the weight. Mirrors the Cursor / Linear
          settings hero pattern. */}
      <div style={{
        display: "flex", alignItems: "center", gap: 16,
        padding: "4px 0 22px",
        marginBottom: 6,
        borderBottom: "1px solid var(--c-brd)",
      }}>
        <div style={{
          width: 56, height: 56, borderRadius: 14, flexShrink: 0,
          background: "var(--c-srf2)",
          border: "1px solid var(--c-brd)",
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 19, fontWeight: 600, letterSpacing: "0.02em",
          color: "var(--c-high)",
        }}>{initials}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontSize: 17, fontWeight: 600, letterSpacing: "-0.012em",
            color: "var(--c-high)",
            lineHeight: 1.25,
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}>
            {name || email || "Anonymous"}
          </div>
          <div style={{
            fontSize: 12.5, color: "var(--c-low)",
            marginTop: 4, lineHeight: 1.4,
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}>
            {email}
          </div>
        </div>
      </div>

      <SectionHeader>Account details</SectionHeader>
      <Card>
        {/* Display name — title on the left, edit field + Save inline on
            the right, just like every other Row in the app. */}
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "13px 14px", gap: 16,
          borderBottom: "1px solid var(--c-brd)",
        }}>
          <div style={{ flex: "0 0 auto", minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 500, color: "var(--c-high)", lineHeight: 1.3 }}>
              Display name
            </div>
            <div style={{ fontSize: 12, color: "var(--c-low)", marginTop: 3, lineHeight: 1.5 }}>
              Shown in chat exports and the sidebar.
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Your name"
              style={{
                width: 200, boxSizing: "border-box",
                background: "var(--c-srf)",
                border: "1px solid var(--c-brd)",
                borderRadius: 7, padding: "6px 10px",
                fontSize: 12.5, color: "var(--c-high)",
                fontFamily: "inherit", outline: "none",
                transition: "border-color 0.12s",
              }}
              onFocus={e => (e.currentTarget.style.borderColor = "var(--c-brd2)")}
              onBlur={e => (e.currentTarget.style.borderColor = "var(--c-brd)")}
            />
            <PrimaryButton onClick={handleSave} disabled={!dirty && !saved}>
              {saved ? <><Check size={12} /> Saved</> : "Save"}
            </PrimaryButton>
          </div>
        </div>

        <Row title="Email" desc="Managed by your Fleetify identity.">
          <ValueText>{email}</ValueText>
        </Row>

        <Row title="Account ID" desc="Reference this when contacting support.">
          <button
            onClick={copyId}
            title="Copy ID"
            style={{
              display: "inline-flex", alignItems: "center", gap: 6,
              padding: "5px 9px", borderRadius: 6,
              background: "var(--c-srf)", border: "1px solid var(--c-brd)",
              cursor: "pointer", outline: "none",
              fontFamily: "var(--font-mono, ui-monospace, monospace)",
              fontSize: 11.5, color: "var(--c-low)",
              transition: "border-color 0.12s, color 0.12s",
            }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = "var(--c-brd2)"; e.currentTarget.style.color = "var(--c-high)"; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = "var(--c-brd)"; e.currentTarget.style.color = "var(--c-low)"; }}
          >
            <span>{accountId ? `${accountId.slice(0, 8)}…${accountId.slice(-4)}` : "—"}</span>
            {copiedId ? <Check size={11} style={{ color: "rgb(74,222,128)" }} /> : <Copy size={11} />}
          </button>
        </Row>

        <Row title="Member since" desc="When you first joined Fleetify on this device." last>
          <ValueText>{memberLabel}</ValueText>
        </Row>
      </Card>

      <SectionHeader>Sign out</SectionHeader>
      <Card>
        <Row title="Sign out of Fleetify" desc="You'll need to sign in again to use Fleet." last>
          <button
            onClick={() => window.dispatchEvent(new CustomEvent("fleet:logout"))}
            style={btnDanger}
            onMouseEnter={e => {
              e.currentTarget.style.background = "rgba(248,113,113,0.18)";
              e.currentTarget.style.borderColor = "rgba(248,113,113,0.45)";
            }}
            onMouseLeave={e => {
              e.currentTarget.style.background = "rgba(248,113,113,0.10)";
              e.currentTarget.style.borderColor = "rgba(248,113,113,0.30)";
            }}
          >
            Sign out
          </button>
        </Row>
      </Card>
    </>
  );
}

/* ── ValueText — quiet right-hand value text used in Rows ─────── */
function ValueText({ children }: { children: React.ReactNode }) {
  return (
    <span style={{
      fontSize: 12.5, color: "var(--c-low)",
      maxWidth: 260,
      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
      display: "inline-block",
    }}>
      {children}
    </span>
  );
}

/* ══════════════════════════════════════════════════════════════
   Section: General
══════════════════════════════════════════════════════════════ */
function GeneralSection() {
  const [completionSound, toggleCompletionSound] = useToggle("completion-sound", false);
  const { cfg, patch } = useFleetConfig();
  const githubUser = cfg?.githubUsername ?? "";
  const [checking, setChecking] = useState(false);

  const connectGithub = async () => {
    setChecking(true);
    try {
      const res = await window.electronAPI?.checkGithubAuth?.();
      if (res?.ok && res.username) {
        await patch({ githubUsername: res.username });
      }
    } finally {
      setChecking(false);
    }
  };

  const disconnectGithub = async () => {
    await patch({ githubUsername: undefined, githubToken: undefined });
  };

  return (
    <>
      <SectionHeader>Integrations</SectionHeader>
      <Card>
        <Row
          title="GitHub"
          desc={githubUser
            ? `Connected as @${githubUser}. Used for git operations the agent runs on your behalf.`
            : "Authorize the GitHub CLI so agents can clone, push, and open PRs as you."}
          last
        >
          {githubUser ? (
            <button
              onClick={disconnectGithub}
              style={btnDanger}
              onMouseEnter={e => {
                e.currentTarget.style.background = "rgba(248,113,113,0.18)";
                e.currentTarget.style.borderColor = "rgba(248,113,113,0.45)";
              }}
              onMouseLeave={e => {
                e.currentTarget.style.background = "rgba(248,113,113,0.10)";
                e.currentTarget.style.borderColor = "rgba(248,113,113,0.30)";
              }}
            >
              Disconnect
            </button>
          ) : (
            <PrimaryButton onClick={connectGithub} disabled={checking}>
              {checking ? "Checking…" : "Connect"}
            </PrimaryButton>
          )}
        </Row>
      </Card>

      <SectionHeader>Sound</SectionHeader>
      <Card>
        <Row title="Completion sound" desc="Play a short ding when an agent finishes a task." last>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button
              onClick={() => playCompletionBeep()}
              title="Test sound"
              style={{
                width: 26, height: 26, borderRadius: 6,
                display: "flex", alignItems: "center", justifyContent: "center",
                background: "transparent",
                border: "1px solid var(--c-brd)",
                color: "var(--c-med)",
                cursor: "pointer", outline: "none",
                transition: "background 0.1s, color 0.1s, border-color 0.1s",
              }}
              onMouseEnter={e => {
                e.currentTarget.style.background = "var(--c-srf2)";
                e.currentTarget.style.color = "var(--c-high)";
                e.currentTarget.style.borderColor = "var(--c-brd2)";
              }}
              onMouseLeave={e => {
                e.currentTarget.style.background = "transparent";
                e.currentTarget.style.color = "var(--c-med)";
                e.currentTarget.style.borderColor = "var(--c-brd)";
              }}
            >
              <Volume2 size={12} />
            </button>
            <Toggle on={completionSound} onChange={toggleCompletionSound} />
          </div>
        </Row>
      </Card>
    </>
  );
}

/* ══════════════════════════════════════════════════════════════
   Section: Appearance
══════════════════════════════════════════════════════════════ */
function ThemeCard({
  themeId, active, onClick,
}: {
  themeId: string;
  active: boolean;
  onClick: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const t = THEMES.find(x => x.id === themeId)!;
  const p = t.preview;
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        background: "none", border: "none", padding: 0, cursor: "pointer",
        textAlign: "left", borderRadius: 10,
        outline: active
          ? "2px solid var(--c-high)"
          : hovered ? "1px solid var(--c-brd2)" : "1px solid var(--c-brd)",
        outlineOffset: active ? 1 : 0,
        transition: "outline 0.12s",
      }}
    >
      <div style={{ padding: "9px 9px 8px" }}>
        <div style={{
          width: "100%", height: 76, borderRadius: 7,
          border: `1px solid ${p.border}`,
          display: "flex", overflow: "hidden", marginBottom: 8,
        }}>
          <div style={{
            width: 26, background: p.sidebar, flexShrink: 0,
            padding: "6px 4px", display: "flex", flexDirection: "column", gap: 3,
          }}>
            {[0.7, 0.45, 0.45, 0.25].map((op, i) => (
              <div key={i} style={{ height: 2.5, borderRadius: 2, background: p.text, opacity: op }} />
            ))}
          </div>
          <div style={{ flex: 1, background: p.card, padding: "6px 8px", display: "flex", flexDirection: "column", gap: 4 }}>
            <div style={{ display: "flex", gap: 3, alignItems: "center" }}>
              <div style={{ width: 6, height: 6, borderRadius: "50%", background: p.accent }} />
              <div style={{ flex: 1, height: 2.5, borderRadius: 2, background: p.text, opacity: 0.5 }} />
            </div>
            <div style={{ height: 2.5, borderRadius: 2, background: p.text, opacity: 0.28, width: "75%" }} />
            <div style={{ height: 2.5, borderRadius: 2, background: p.text, opacity: 0.28, width: "50%" }} />
            <div style={{ marginTop: 1, padding: "3px 5px", borderRadius: 3, background: p.border }}>
              <div style={{ height: 2, borderRadius: 2, background: p.text, opacity: 0.35 }} />
            </div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <span style={{
            fontSize: 12.5,
            fontWeight: active ? 600 : 500,
            color: active ? "var(--c-high)" : "var(--c-med)",
          }}>
            {t.name}
          </span>
          {active && <Check size={11} style={{ color: "var(--c-high)", flexShrink: 0 }} />}
        </div>
        <div style={{ fontSize: 11, color: "var(--c-dim)", marginTop: 2 }}>
          {t.description}
        </div>
      </div>
    </button>
  );
}

function AppearanceSection() {
  const { colorTheme, setColorTheme } = useThemeStore();
  const dark  = THEMES.filter(t => t.type === "dark");
  const light = THEMES.filter(t => t.type === "light");

  const Grid = ({ themes }: { themes: typeof THEMES }) => (
    <div style={{
      display: "grid",
      gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))",
      gap: 9, marginBottom: 22,
    }}>
      {themes.map(t => (
        <ThemeCard key={t.id} themeId={t.id} active={colorTheme === t.id}
          onClick={() => setColorTheme(t.id as ColorTheme)} />
      ))}
    </div>
  );
  return (
    <>
      <SectionHeader>Dark Themes</SectionHeader>
      <Grid themes={dark} />
      <SectionHeader>Light Themes</SectionHeader>
      <Grid themes={light} />
    </>
  );
}

/* ══════════════════════════════════════════════════════════════
   Section: Models
══════════════════════════════════════════════════════════════ */

type ProviderKey = "anthropic" | "openai" | "gemini" | "groq";

const MODELS = [
  { id: "claude-opus-4-7",           label: "Claude Opus 4.7",   desc: "Most capable — complex tasks, long context" },
  { id: "claude-sonnet-4-6",         label: "Claude Sonnet 4.6", desc: "Balanced speed and quality" },
  { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5",  desc: "Fastest — simple tasks and quick responses" },
];

const PROVIDERS: { key: ProviderKey; label: string; placeholder: string; desc: string }[] = [
  { key: "anthropic", label: "Anthropic",       placeholder: "sk-ant-…", desc: "Claude models — Opus, Sonnet, Haiku" },
  { key: "openai",    label: "OpenAI",          placeholder: "sk-…",     desc: "GPT models, used by Codex CLI" },
  { key: "gemini",    label: "Google Gemini",   placeholder: "AIza…",    desc: "Gemini models, used by Gemini CLI" },
  { key: "groq",      label: "Groq",            placeholder: "gsk_…",    desc: "Fast inference for open models" },
];

/* ── ApiKeyRow — masked input + reveal/save controls ─────────── */
function ApiKeyRow({
  label, desc, value, onSave, placeholder, last,
}: {
  label: string;
  desc: string;
  value: string;
  onSave: (v: string) => Promise<void> | void;
  placeholder: string;
  last?: boolean;
}) {
  const [draft, setDraft] = useState(value);
  const [revealed, setRevealed] = useState(false);
  const [saved, setSaved] = useState(false);
  const dirty = draft !== value;

  // Sync from outer value when config loads
  useEffect(() => { setDraft(value); }, [value]);

  const handleSave = async () => {
    await onSave(draft.trim());
    setSaved(true);
    setTimeout(() => setSaved(false), 1600);
  };

  return (
    <div style={{
      padding: "13px 14px",
      borderBottom: last ? "none" : "1px solid var(--c-brd)",
    }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, marginBottom: 8 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 500, color: "var(--c-high)", lineHeight: 1.3 }}>
            {label}
            {value && (
              <span style={{
                marginLeft: 8, fontSize: 10.5, fontWeight: 600, letterSpacing: "0.05em",
                color: "rgb(74,222,128)", textTransform: "uppercase",
              }}>● Saved</span>
            )}
          </div>
          <div style={{ fontSize: 12, color: "var(--c-low)", marginTop: 3, lineHeight: 1.5 }}>
            {desc}
          </div>
        </div>
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        <div style={{ flex: 1, position: "relative" }}>
          <input
            type={revealed ? "text" : "password"}
            value={draft}
            placeholder={placeholder}
            onChange={e => setDraft(e.target.value)}
            style={{
              width: "100%", boxSizing: "border-box",
              background: "var(--c-srf)",
              border: "1px solid var(--c-brd)",
              borderRadius: 7, padding: "7px 32px 7px 10px",
              fontSize: 12.5, color: "var(--c-high)",
              fontFamily: "var(--font-mono, ui-monospace, monospace)",
              outline: "none", transition: "border-color 0.12s",
            }}
            onFocus={e => (e.currentTarget.style.borderColor = "var(--c-brd2)")}
            onBlur={e => (e.currentTarget.style.borderColor = "var(--c-brd)")}
          />
          <button
            onClick={() => setRevealed(v => !v)}
            title={revealed ? "Hide" : "Reveal"}
            style={{
              position: "absolute", right: 6, top: "50%", transform: "translateY(-50%)",
              width: 24, height: 24, borderRadius: 5,
              display: "flex", alignItems: "center", justifyContent: "center",
              background: "transparent", border: "none", cursor: "pointer",
              color: "var(--c-dim)", outline: "none",
            }}
            onMouseEnter={e => (e.currentTarget.style.color = "var(--c-high)")}
            onMouseLeave={e => (e.currentTarget.style.color = "var(--c-dim)")}
          >
            {revealed ? <EyeOff size={13} /> : <Eye size={13} />}
          </button>
        </div>
        <PrimaryButton onClick={handleSave} disabled={!dirty}>
          {saved ? <><Check size={12} /> Saved</> : "Save"}
        </PrimaryButton>
      </div>
    </div>
  );
}

function ModelsSection() {
  const { cfg, loaded, patch } = useFleetConfig();
  const defaultModel = cfg?.defaultModel ?? "claude-sonnet-4-6";

  const pick = (id: string) => { void patch({ defaultModel: id }); };
  const saveKey = async (key: ProviderKey, value: string) => {
    await patch({ apiKeys: { ...(cfg?.apiKeys ?? {}), [key]: value || undefined } });
  };

  return (
    <>
      <SectionHeader>Default Model</SectionHeader>
      <Card>
        {MODELS.map((m, i, arr) => {
          const active = defaultModel === m.id;
          return (
            <Row key={m.id} title={m.label} desc={m.desc} last={i === arr.length - 1}>
              <button
                onClick={() => pick(m.id)}
                aria-label={active ? "Selected" : "Select"}
                style={{
                  width: 18, height: 18, borderRadius: "50%",
                  border: active
                    ? "5px solid rgb(74,222,128)"
                    : "1.5px solid var(--c-brd2)",
                  background: "transparent",
                  cursor: "pointer", outline: "none",
                  transition: "border 0.12s",
                }}
              />
            </Row>
          );
        })}
      </Card>

      <SectionHeader>API Keys</SectionHeader>
      <Card>
        {PROVIDERS.map((p, i, arr) => (
          <ApiKeyRow
            key={p.key}
            label={p.label}
            desc={p.desc}
            placeholder={p.placeholder}
            value={loaded ? (cfg?.apiKeys?.[p.key] ?? "") : ""}
            onSave={(v) => saveKey(p.key, v)}
            last={i === arr.length - 1}
          />
        ))}
      </Card>
      <div style={{ fontSize: 11.5, color: "var(--c-dim)", marginTop: -10, marginBottom: 22, paddingLeft: 2 }}>
        Keys are stored locally on this machine and never sent to Fleetify servers.
      </div>
    </>
  );
}

/* ══════════════════════════════════════════════════════════════
   Section: Agents — defaults that apply when creating new sessions
══════════════════════════════════════════════════════════════ */
function AgentsSection() {
  const [provider, setProvider] = useConfigField("defaultProvider", "claude");

  return (
    <>
      <SectionHeader>Default agent</SectionHeader>
      <Card>
        <Row
          title="Default provider"
          desc="CLI used when you create a new agent without explicitly picking one in the chip strip."
          last
        >
          <Select
            value={provider}
            onChange={setProvider}
            options={[
              { value: "claude", label: "Claude Code" },
              { value: "codex",  label: "Codex"       },
              { value: "cursor", label: "Cursor"      },
              { value: "gemini", label: "Gemini CLI"  },
              { value: "kimi",   label: "Kimi"        },
              { value: "ollama", label: "Ollama"      },
            ]}
            width={170}
          />
        </Row>
      </Card>

      <SectionHeader>Per-session controls</SectionHeader>
      <Card>
        <Row
          title="Permission mode"
          desc="Each agent's mode (default / acceptEdits / plan) lives on the session and is changed from the chip strip above the chat input."
        >
          <ValueText>Per session</ValueText>
        </Row>
        <Row
          title="Budget limit"
          desc="Each agent has its own spending cap. Set it from the session's chip strip — Fleet pauses the run when the cap is hit."
          last
        >
          <ValueText>Per session</ValueText>
        </Row>
      </Card>
    </>
  );
}

/* ══════════════════════════════════════════════════════════════
   Section: Plugins — hand off to the Marketplace surface
══════════════════════════════════════════════════════════════ */
function PluginsSection({ onClose }: { onClose: () => void }) {
  const setMainView = useAppStore(s => s.setMainView);
  const goMarketplace = () => {
    setMainView("marketplace");
    onClose();
  };
  return (
    <>
      <SectionHeader>Marketplace</SectionHeader>
      <Card>
        <Row title="Browse plugins" desc="Discover agents, tools, and rule packs published by the community.">
          <GhostButton onClick={goMarketplace}>
            Open <ArrowUpRight size={11} />
          </GhostButton>
        </Row>
        <Row title="Installed plugins" desc="Manage what you've installed. Switch to the Installed tab inside Marketplace." last>
          <GhostButton onClick={goMarketplace}>
            Manage <ArrowUpRight size={11} />
          </GhostButton>
        </Row>
      </Card>
    </>
  );
}

/* ══════════════════════════════════════════════════════════════
   Section: Rules — global system prompt that rides every agent
══════════════════════════════════════════════════════════════ */
function RulesSection() {
  return (
    <>
      <SectionHeader>How rules work</SectionHeader>
      <div style={{ fontSize: 12.5, color: "var(--c-low)", lineHeight: 1.6, marginTop: -6, marginBottom: 16 }}>
        Fleet doesn't store rules in app settings — they live in your repo. Drop one of the files below at
        the project root and every agent run inside that folder picks them up automatically.
      </div>
      <Card>
        <Row
          title="AGENTS.md"
          desc="Agent-agnostic. Fleet reads this for every provider."
        >
          <ValueText>Auto-detected</ValueText>
        </Row>
        <Row
          title=".cursorrules"
          desc="Cursor's convention. Picked up by Codex / Cursor providers and surfaced to others."
        >
          <ValueText>Auto-detected</ValueText>
        </Row>
        <Row
          title="CLAUDE.md"
          desc="Claude Code's convention. Read by Claude provider; other CLIs inherit via AGENTS.md fallback."
          last
        >
          <ValueText>Auto-detected</ValueText>
        </Row>
      </Card>
    </>
  );
}


/* ── SideRow ──
   Pixel-identical copy of the SideRow primitive in components/layout/
   sidebar.tsx. Same metrics (4px 9px padding, 9px gap, 12.5px label,
   font-weight 400→500 on active, 5px radius, --c-srf2 active surface)
   so the Settings sidebar list reads as the same primitive as the main
   app's sidebar list — the user spec is "the only difference between
   the two surfaces is which rows live in them". */
function SideRow({
  icon, label, onClick, active,
}: {
  icon: React.ReactNode;
  label: string;
  onClick?: () => void;
  active?: boolean;
}) {
  const baseBg = active ? "var(--c-srf2)" : "transparent";
  const baseColor = active ? "var(--c-high)" : "var(--c-med)";
  const iconColor = active ? "var(--c-high)" : "var(--c-dim)";
  return (
    <button onClick={onClick} style={{
      display: "flex", alignItems: "center", gap: 9, width: "100%",
      padding: "4px 9px", border: "none", cursor: "pointer",
      textAlign: "left", fontSize: 12.5,
      fontWeight: active ? 500 : 400,
      borderRadius: 5, background: baseBg,
      color: baseColor,
      fontFamily: "inherit", outline: "none",
      transition: "background 0.08s, color 0.08s",
    }}
      onMouseEnter={e => { if (!active) { e.currentTarget.style.background = "var(--c-srf)"; e.currentTarget.style.color = "var(--c-high)"; } }}
      onMouseLeave={e => { if (!active) { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--c-med)"; } }}
    >
      <span style={{ flexShrink: 0, display: "flex", color: iconColor, transition: "color 0.08s" }}>{icon}</span>
      <span style={{ flex: 1 }}>{label}</span>
    </button>
  );
}

/* ── SettingsAccountFooter ──
   Mirror of components/layout/sidebar.tsx → AccountFooter. Clicking it
   here jumps to the Account tab inside the same Settings page; the
   theme toggle on the right behaves identically. */
function SettingsAccountFooter({ onClickAccount }: { onClickAccount?: () => void } = {}) {
  const raw = (() => { try { return localStorage.getItem("fleet:user"); } catch { return null; } })();
  const user = raw ? (() => { try { return JSON.parse(raw); } catch { return null; } })() : null;
  const displayName: string = user?.name ?? user?.email?.split("@")[0] ?? "User";
  const { toggle: toggleTheme } = useThemeStore();

  return (
    <button
      onClick={onClickAccount}
      style={{
        display: "flex", alignItems: "center", gap: 9, width: "100%",
        padding: "4px 9px", border: "none", cursor: "pointer",
        textAlign: "left", fontSize: 12.5, fontWeight: 400,
        borderRadius: 5, background: "none", color: "var(--c-med)",
        fontFamily: "inherit", outline: "none",
        transition: "background 0.08s, color 0.08s",
      }}
      onMouseEnter={e => { e.currentTarget.style.background = "var(--c-srf)"; e.currentTarget.style.color = "var(--c-high)"; }}
      onMouseLeave={e => { e.currentTarget.style.background = "none";       e.currentTarget.style.color = "var(--c-med)"; }}
    >
      <User size={12} style={{ color: "var(--c-dim)", flexShrink: 0 }} />
      <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {displayName}
      </span>
      <span
        role="button"
        title="Toggle theme"
        onClick={(e) => { e.stopPropagation(); toggleTheme(); }}
        style={{
          display: "inline-flex", alignItems: "center", justifyContent: "center",
          width: 18, height: 18, borderRadius: 4, flexShrink: 0,
          color: "var(--c-dim)",
        }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--c-high)"; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--c-dim)"; }}
      >
        <Sun size={11} />
      </span>
    </button>
  );
}

/* ══════════════════════════════════════════════════════════════
   Settings page — full-viewport surface (sidebar + content)
══════════════════════════════════════════════════════════════ */
export function SettingsPage({ initialTab = "General", onClose }: SettingsProps) {
  const [active, setActive] = useState(initialTab);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  useEffect(() => { setActive(initialTab); }, [initialTab]);

  // Esc closes the page — same shortcut users learn from the rest of
  // the app's overlays. Owned at the page level so any focused input
  // inside still respects it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div style={{
      width: "100vw",
      height: "100vh",
      background: "var(--card)",
      display: "flex", flexDirection: "column", overflow: "hidden",
      position: "relative",
    }}>
      {/* Windows-only caption row. macOS returns null so this is a
          zero-cost mount everywhere else. ``backTo`` swaps the
          sidebar-controls trio for a single back arrow that closes
          the page — without this, opening Settings on Windows lost
          the min/max/close + drag affordances entirely. */}
      <WindowsTitleBar backTo={{ onBack: onClose, title: "Back to workspace" }} />

      <div style={{
        flex: 1, minHeight: 0,
        display: "flex", overflow: "hidden",
        // Inner shell carries the 8px L/R gutters so the title bar
        // above can span the full window width like the main shell.
        padding: "0 8px",
      }}>
      {/* ── Sidebar — pixel-identical to AppShell's left sidebar ── */}
      <div style={{
        width: 224, flexShrink: 0,
        marginTop: 8, marginBottom: 8,
        borderRadius: 8,
        border: "1px solid var(--c-brd)",
        background: "var(--sidebar)",
        overflow: "hidden",
      }}>
        <nav style={{
          height: "100%",
          display: "flex", flexDirection: "column",
          background: "var(--sidebar)",
          overflow: "hidden", userSelect: "none",
        }}>
          {/* Windows-only top spacer. The 44px drag-bar below this
              renders only on macOS (it carries the back-arrow and
              reserves space for the traffic lights); without it the
              first nav row sat flush against the sidebar's top
              border. 12px gives the rail a bit of breathing room
              without re-introducing the dead header band the user
              explicitly asked us to remove. */}
          {isWindowsPlatform() && (
            <div style={{ height: 12, flexShrink: 0 }} />
          )}

          {/* Top bar — same 44px height + 78px traffic-light reservation
              as the main sidebar. The right-side button is a back-arrow
              that returns to the workspace; ``marginTop:-8`` lines its
              center up with the macOS traffic lights. Windows suppresses
              this whole block: WindowsTitleBar above already carries the
              back arrow + caption buttons, and an empty 78px traffic-
              light pad would otherwise waste vertical space the user
              specifically asked us to reclaim. */}
          {!isWindowsPlatform() && (
            <div className="drag-region" style={{
              height: 44, flexShrink: 0,
              display: "flex", alignItems: "center",
              padding: "0 10px 0 78px",
            }}>
              <div style={{ flex: 1 }} />
              <div className="no-drag" style={{ display: "flex", gap: 1, marginTop: -8 }}>
                <button
                  onClick={onClose}
                  title="Back (Esc)"
                  style={{
                    width: 24, height: 24, borderRadius: 5, flexShrink: 0,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    background: "none", border: "none", cursor: "pointer",
                    color: "var(--c-dim)",
                    outline: "none",
                    transition: "background 0.1s, color 0.1s",
                  }}
                  onMouseEnter={e => {
                    e.currentTarget.style.background = "var(--c-srf)";
                    e.currentTarget.style.color = "var(--c-med)";
                  }}
                  onMouseLeave={e => {
                    e.currentTarget.style.background = "none";
                    e.currentTarget.style.color = "var(--c-dim)";
                  }}
                >
                  <ArrowLeft size={12} />
                </button>
              </div>
            </div>
          )}

          {/* Rail caption — same uppercase glyph + label pattern the
              Library page uses so the two full-viewport routes feel
              like the same surface with a different list. Pinned
              above the scroll area so it doesn't move with NAV row
              scrolling. */}
          <div style={{
            display: "flex", alignItems: "center", gap: 8,
            padding: "0 12px 12px",
            color: "var(--c-dim)",
            fontSize: 11.5, fontWeight: 600, letterSpacing: "0.08em",
            textTransform: "uppercase",
          }}>
            <Settings size={13} />
            <span>Settings</span>
          </div>

          {/* Scroll area — same metrics as the main sidebar (padding 0 6px).
              The only difference is the rows themselves: Settings tabs
              instead of agent sessions. */}
          <div className="scroll-subtle" style={{
            flex: 1, overflowY: "auto", minHeight: 0, padding: "0 6px",
          }}>
            {NAV.map(item => (
              <SideRow
                key={item.id}
                icon={<item.icon size={13} />}
                label={item.id}
                active={active === item.id}
                onClick={() => setActive(item.id)}
              />
            ))}
          </div>

          {/* Footer — same Help + Account stack as the main sidebar so the
              two surfaces feel like the same rail with a different list. */}
          <div style={{ flexShrink: 0, padding: "6px 6px 8px" }}>
            <SideRow icon={<HelpCircle size={13} />} label="Get Help" onClick={openDocs} />
            <SideRow icon={<MessageCircle size={13} />} label="Give Feedback"
              onClick={() => setFeedbackOpen(true)} />
            <SettingsAccountFooter onClickAccount={() => setActive("Account")} />
          </div>
        </nav>
      </div>

      {/* ── Content ── */}
      <div style={{
        flex: 1, minWidth: 0,
        display: "flex", flexDirection: "column",
        background: "var(--card)",
      }}>
        {/* Drag strip — matches the sidebar's 44px header so the entire
            top row reads as one continuous title bar. Hidden on Windows
            to match the sidebar-side suppression: there's nothing for
            it to align with, and the user asked us to pull content
            upward instead of reserving a phantom title-bar row. */}
        {!isWindowsPlatform() && (
          <div className="drag-region" style={{
            height: 44, flexShrink: 0,
          }} />
        )}

        <div className="scroll-subtle" style={{
          flex: 1, minHeight: 0, overflowY: "auto",
        }}>
          <div style={{
            padding: "8px 40px 56px",
            maxWidth: 760, margin: "0 auto",
          }}>
            <h1 style={{
              fontSize: 24, fontWeight: 600,
              color: "var(--c-high)",
              margin: "0 0 24px",
              letterSpacing: "-0.022em",
            }}>
              {active}
            </h1>

            {active === "Account"      && <AccountSection />}
            {active === "General"      && <GeneralSection />}
            {active === "Appearance"   && <AppearanceSection />}
            {active === "Agents"       && <AgentsSection />}
            {active === "Models"       && <ModelsSection />}
            {active === "Plugins"      && <PluginsSection onClose={onClose} />}
            {active === "Rules"        && <RulesSection />}
            {active === "Integrations" && <IntegrationsSection />}
            {active === "Tools & MCPs" && <MCPSection />}
            {active === "Diagnostics"  && <DiagnosticsSection />}
          </div>
        </div>
      </div>
      </div>
      <FeedbackModal open={feedbackOpen} onClose={() => setFeedbackOpen(false)} />
    </div>
  );
}

/* Backwards-compatible shim — older imports referenced SettingsModal.
   The page is no longer a modal, but the name lingered in a couple
   of call sites; alias it to SettingsPage so they keep building. */
export const SettingsModal = SettingsPage;
