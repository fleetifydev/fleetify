/**
 * Help dialog — the `/help` command surface. A read-only reference split into
 * three tabs — Keyboard Shortcuts, Fleet Commands, and Session Commands. The
 * Session tab lists, for EVERY provider (not just the active one), the commands
 * that actually work: a universal group Fleetify handles for all agents, then
 * one group per provider carrying that agent's real native commands
 * (PROVIDER_NATIVE_CMDS — probe-verified ACP-advertised / method-wired). The
 * active session's agent additionally gets its LIVE-advertised set (incl.
 * per-user skills) merged into its group. Antigravity (print mode) advertises
 * nothing over its transport and has no provider group — its working commands
 * are the universal set.
 */
import { useEffect, useState } from "react";
import { claimEscape } from "@/hooks/use-escape-to-stop";
import { X } from "lucide-react";
import {
  KEYBOARD_SHORTCUTS,
  formatShortcut,
  shortcutKeysForDoc,
  type ShortcutGroup,
} from "@/lib/keyboard-shortcuts";
import {
  FLEET_CMDS,
  SESSION_CMDS_BASE,
  SESSION_CMDS_COMMON,
  PROVIDER_NATIVE_CMDS,
} from "@/lib/slash-commands";
import { ProviderLogo, providerName } from "@/components/ui/provider-logo";
import { useChatStore } from "@/stores/chat-store";

const SHORTCUT_ORDER: ShortcutGroup[] = ["Navigation", "Layout & panels", "Git & PRs", "Agents"];

// Provider groups on the Session tab, in display order. Each maps to a
// PROVIDER_NATIVE_CMDS entry; the label/icon come from providerName/ProviderLogo.
const PROVIDER_ORDER = [
  "claude-code",
  "grok-build",
  "github-copilot",
  "opencode",
  "cursor-cli",
  "hermes-agent",
  "codex-cli",
] as const;

type TabKey = "shortcuts" | "fleet" | "session";
const TABS: { key: TabKey; label: string }[] = [
  { key: "shortcuts", label: "Keyboard Shortcuts" },
  { key: "fleet", label: "Fleet Commands" },
  { key: "session", label: "Session Commands" },
];

export function HelpDialog({
  open,
  onClose,
  tool,
  sessionId,
}: {
  open: boolean;
  onClose: () => void;
  tool?: string | null;
  sessionId?: string | null;
}) {
  const [tab, setTab] = useState<TabKey>("shortcuts");
  // The active session's LIVE provider-advertised commands. The store is only
  // populated for agents that push `available_commands_update` over ACP, so this
  // is empty for Claude/Codex/Antigravity (and in the Fleet composer).
  const liveCmds = useChatStore((s) => (sessionId ? s.dynamicCommands[sessionId] : undefined));

  // Reset to the first tab whenever the dialog (re)opens. The component stays
  // mounted (only `open` toggles), so without this a reopen would keep the last
  // tab. Done during render via a prev-prop compare — React's sanctioned
  // "adjust state on prop change" pattern — not in an effect, which would
  // cascade-render.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setTab("shortcuts");
  }

  // Esc closes.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      // Claim it: closing must not also stop a stream or deny a card.
      if (e.key === "Escape") { claimEscape(e); onClose(); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  // 1) the universal group Fleetify intercepts for EVERY agent, then 2) one
  // group per provider carrying its real native commands (PROVIDER_NATIVE_CMDS).
  // For the active session's provider we merge its LIVE-advertised set on top
  // (deduped) so per-user skills + version-specific commands show too. Agents
  // with no native set (Antigravity) simply have no group here.
  const universal = [...SESSION_CMDS_BASE, ...SESSION_CMDS_COMMON].map((c) => ({ cmd: c.cmd, desc: c.desc }));
  // Commands already shown under "Works in every agent" — dropped from each
  // provider group so a universal command (e.g. /plan, /model) isn't repeated.
  const universalCmds = new Set(universal.map((c) => c.cmd));
  const sessionGroups: { label: string; tool?: string; rows: { cmd: string; desc: string }[] }[] = [
    { label: "Works in every agent", rows: universal },
    ...PROVIDER_ORDER.map((p) => {
      const base = PROVIDER_NATIVE_CMDS[p] ?? [];
      // The active provider's live-advertised commands (skills + version extras)
      // merged on top of its static core.
      const live =
        tool === p && liveCmds
          ? liveCmds.map((c) => ({ cmd: `/${c.name}`, desc: c.description }))
          : [];
      // Dedup by command text AND drop anything already in the universal group.
      const seen = new Set<string>();
      const rows = [...base, ...live].filter((r) => {
        if (universalCmds.has(r.cmd) || seen.has(r.cmd)) return false;
        seen.add(r.cmd);
        return true;
      });
      return { label: providerName(p), tool: p, rows };
    }),
  ];

  return (
    <div onClick={onClose} style={overlay} role="dialog" aria-modal="true" aria-label="Help">
      <div onClick={(e) => e.stopPropagation()} style={card}>
        <div style={tabBar} role="tablist" aria-label="Help sections">
          {TABS.map((t) => {
            const active = t.key === tab;
            return (
              <button
                key={t.key}
                role="tab"
                aria-selected={active}
                onClick={() => setTab(t.key)}
                style={tabBtn(active)}
              >
                {t.label}
              </button>
            );
          })}
          <button onClick={onClose} aria-label="Close" style={closeBtn}><X size={15} /></button>
        </div>

        <div className="scroll-subtle" style={body} role="tabpanel">
          {tab === "shortcuts" &&
            SHORTCUT_ORDER.map((group) => {
              const rows = KEYBOARD_SHORTCUTS.filter((s) => s.group === group);
              if (rows.length === 0) return null;
              return (
                <div key={group} style={{ marginBottom: 10 }}>
                  <SubHeader text={group} />
                  {rows.map((s) => (
                    <div key={s.id} style={rowStyle}>
                      <span style={rowDesc}>{s.label}</span>
                      <span style={{ display: "flex", gap: 2, flexShrink: 0 }}>
                        <span style={kbd}>{formatShortcut(shortcutKeysForDoc(s))}</span>
                      </span>
                    </div>
                  ))}
                </div>
              );
            })}

          {tab === "fleet" &&
            FLEET_CMDS.map((c) => <CmdRow key={c.intent} cmd={c.cmd} desc={c.desc} />)}

          {tab === "session" &&
            sessionGroups.map((g) =>
              g.rows.length === 0 ? null : (
                <div key={g.label} style={{ marginBottom: 10 }}>
                  <SubHeader text={g.label} tool={g.tool} />
                  {g.rows.map((c) => <CmdRow key={`${g.label}:${c.cmd}`} cmd={c.cmd} desc={c.desc} />)}
                </div>
              ),
            )}
        </div>
      </div>
    </div>
  );
}

function SubHeader({ text, tool }: { text: string; tool?: string }) {
  if (!tool) return <div style={subHeader}>{text}</div>;
  // Provider groups carry their brand mark left of the label. The icon keeps
  // its own colour (it's not subject to the header's ghost fill), but inherits
  // the header's faded opacity so it reads as part of the same quiet label.
  return (
    <div style={subHeaderWithIcon}>
      <ProviderLogo tool={tool} size={13} />
      {text}
    </div>
  );
}

function CmdRow({ cmd, desc }: { cmd: string; desc: string }) {
  return (
    <div style={rowStyle}>
      <span style={{ ...rowDesc, display: "flex", gap: 8, alignItems: "baseline" }}>
        <span style={cmdName}>{cmd}</span>
        <span style={{ color: "var(--c-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{desc}</span>
      </span>
    </div>
  );
}

const overlay: React.CSSProperties = { position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "flex-start", justifyContent: "center", zIndex: 1000, padding: "12vh 24px 24px" };
const card: React.CSSProperties = { width: 600, maxWidth: "100%", maxHeight: "72vh", background: "var(--card)", border: "1px solid var(--c-brd)", borderRadius: 12, display: "flex", flexDirection: "column", overflow: "hidden", boxShadow: "0 20px 60px rgba(0,0,0,0.4)" };
const tabBar: React.CSSProperties = { display: "flex", alignItems: "center", gap: 4, padding: "8px 10px", borderBottom: "1px solid var(--c-brd)" };
const closeBtn: React.CSSProperties = { background: "none", border: "none", cursor: "pointer", color: "var(--c-dim)", display: "flex", flexShrink: 0, marginLeft: "auto" };
const body: React.CSSProperties = { flex: 1, minHeight: 0, overflowY: "auto", padding: "12px 14px" };
const subHeader: React.CSSProperties = { fontSize: 9.5, fontWeight: 700, color: "var(--c-ghost)", letterSpacing: "0.06em", textTransform: "uppercase", padding: "2px 2px 4px", opacity: 0.6 };
const subHeaderWithIcon: React.CSSProperties = { ...subHeader, display: "flex", alignItems: "center", gap: 6 };
const rowStyle: React.CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "4px 2px" };
const rowDesc: React.CSSProperties = { fontSize: 12.5, color: "var(--c-low)", flex: 1, minWidth: 0 };
const cmdName: React.CSSProperties = { fontSize: 12, fontFamily: "var(--font-mono)", color: "var(--c-med)", flexShrink: 0 };
const kbd: React.CSSProperties = { fontSize: 10, fontFamily: "var(--font-mono)", color: "var(--c-dim)", background: "var(--c-srf)", border: "1px solid var(--c-brd2)", borderRadius: 4, padding: "1px 5px", lineHeight: "16px" };
function tabBtn(active: boolean): React.CSSProperties {
  return {
    appearance: "none",
    background: active ? "var(--c-srf)" : "transparent",
    color: active ? "var(--c-high)" : "var(--c-low)",
    border: `1px solid ${active ? "var(--c-brd2)" : "transparent"}`,
    borderRadius: 7,
    padding: "5px 11px",
    fontSize: 12,
    fontWeight: active ? 600 : 500,
    cursor: "pointer",
    fontFamily: "inherit",
    whiteSpace: "nowrap",
    transition: "background 0.12s ease, color 0.12s ease, border-color 0.12s ease",
  };
}
