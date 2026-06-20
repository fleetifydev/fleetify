/**
 * Help dialog — the `/help` command surface. A read-only reference split into
 * three tabs at the top — Keyboard Shortcuts, Fleet Commands, and Session
 * Commands (grouped by provider, all tools). The active tab's content scrolls
 * below. Styled to match the app's other composer modals (see prompts-picker).
 * Pure-presentational: all content comes from imported data.
 */
import { useEffect, useState } from "react";
import { X } from "lucide-react";
import {
  KEYBOARD_SHORTCUTS,
  renderKey,
  isMac,
  type ShortcutGroup,
} from "@/lib/keyboard-shortcuts";
import {
  FLEET_CMDS,
  SESSION_CMDS_BASE,
  SESSION_CMDS_BY_TOOL,
  SESSION_CMDS_COMMON,
  type SlashCmdDef,
} from "@/lib/slash-commands";
import { ProviderLogo } from "@/components/ui/provider-logo";

const SHORTCUT_ORDER: ShortcutGroup[] = ["Navigation", "Layout & panels", "Git & PRs", "Agents"];

// Session commands grouped by provider. `tool` is the ProviderLogo id whose
// brand mark renders left of the header; "Common" is provider-agnostic, so it
// carries none.
const SESSION_GROUPS: { label: string; tool?: string; cmds: SlashCmdDef[] }[] = [
  { label: "Common", cmds: [...SESSION_CMDS_BASE, ...SESSION_CMDS_COMMON] },
  { label: "Claude Code", tool: "claude-code", cmds: SESSION_CMDS_BY_TOOL["claude-code"] },
  { label: "Codex CLI", tool: "codex-cli", cmds: SESSION_CMDS_BY_TOOL["codex-cli"] },
  { label: "Gemini CLI", tool: "gemini-cli", cmds: SESSION_CMDS_BY_TOOL["gemini-cli"] },
];

type TabKey = "shortcuts" | "fleet" | "session";
const TABS: { key: TabKey; label: string }[] = [
  { key: "shortcuts", label: "Keyboard Shortcuts" },
  { key: "fleet", label: "Fleet Commands" },
  { key: "session", label: "Session Commands" },
];

export function HelpDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [tab, setTab] = useState<TabKey>("shortcuts");

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
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  const mac = isMac();

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
                        {s.keys.map((k, i) => (
                          <span key={i} style={kbd}>{renderKey(k, mac)}</span>
                        ))}
                      </span>
                    </div>
                  ))}
                </div>
              );
            })}

          {tab === "fleet" &&
            FLEET_CMDS.map((c) => <CmdRow key={c.intent} cmd={c.cmd} desc={c.desc} />)}

          {tab === "session" &&
            SESSION_GROUPS.map((g) =>
              g.cmds.length === 0 ? null : (
                <div key={g.label} style={{ marginBottom: 10 }}>
                  <SubHeader text={g.label} tool={g.tool} />
                  {g.cmds.map((c) => <CmdRow key={`${g.label}:${c.cmd}`} cmd={c.cmd} desc={c.desc} />)}
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
