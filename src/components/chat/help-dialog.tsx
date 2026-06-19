/**
 * Help dialog — the `/help` command surface. A single, read-only reference:
 * general keyboard shortcuts, Fleet commands, and Session commands (grouped by
 * provider — all tools). Same content everywhere. Styled to match the app's
 * other composer modals (see prompts-picker.tsx). Pure-presentational: all
 * content comes from imported data.
 */
import { useEffect } from "react";
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

const SHORTCUT_ORDER: ShortcutGroup[] = ["Navigation", "Layout & panels", "Git & PRs", "Agents"];

const SESSION_GROUPS: { label: string; cmds: SlashCmdDef[] }[] = [
  { label: "Common", cmds: [...SESSION_CMDS_BASE, ...SESSION_CMDS_COMMON] },
  { label: "Claude Code", cmds: SESSION_CMDS_BY_TOOL["claude-code"] },
  { label: "Codex CLI", cmds: SESSION_CMDS_BY_TOOL["codex-cli"] },
  { label: "Gemini CLI", cmds: SESSION_CMDS_BY_TOOL["gemini-cli"] },
];

export function HelpDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
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
        <div style={headerRow}>
          <span style={{ fontSize: 14, fontWeight: 600, color: "var(--c-high)" }}>Help</span>
          <button onClick={onClose} aria-label="Close" style={closeBtn}><X size={15} /></button>
        </div>

        <div className="scroll-subtle" style={body}>
          <Section title="Keyboard shortcuts">
            {SHORTCUT_ORDER.map((group) => {
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
          </Section>

          <Section title="Fleet commands">
            {FLEET_CMDS.map((c) => <CmdRow key={c.intent} cmd={c.cmd} desc={c.desc} />)}
          </Section>

          <Section title="Session commands">
            {SESSION_GROUPS.map((g) =>
              g.cmds.length === 0 ? null : (
                <div key={g.label} style={{ marginBottom: 10 }}>
                  <SubHeader text={g.label} />
                  {g.cmds.map((c) => <CmdRow key={`${g.label}:${c.cmd}`} cmd={c.cmd} desc={c.desc} />)}
                </div>
              ),
            )}
          </Section>
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={sectionTitle}>{title}</div>
      {children}
    </div>
  );
}

function SubHeader({ text }: { text: string }) {
  return <div style={subHeader}>{text}</div>;
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
const headerRow: React.CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "11px 14px", borderBottom: "1px solid var(--c-brd)" };
const closeBtn: React.CSSProperties = { background: "none", border: "none", cursor: "pointer", color: "var(--c-dim)", display: "flex", flexShrink: 0 };
const body: React.CSSProperties = { flex: 1, minHeight: 0, overflowY: "auto", padding: "12px 14px" };
const sectionTitle: React.CSSProperties = { fontSize: 10.5, fontWeight: 700, color: "var(--c-ghost)", letterSpacing: "0.07em", textTransform: "uppercase", padding: "2px 2px 8px" };
const subHeader: React.CSSProperties = { fontSize: 9.5, fontWeight: 700, color: "var(--c-ghost)", letterSpacing: "0.06em", textTransform: "uppercase", padding: "2px 2px 4px", opacity: 0.6 };
const rowStyle: React.CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "4px 2px" };
const rowDesc: React.CSSProperties = { fontSize: 12.5, color: "var(--c-low)", flex: 1, minWidth: 0 };
const cmdName: React.CSSProperties = { fontSize: 12, fontFamily: "var(--font-mono)", color: "var(--c-med)", flexShrink: 0 };
const kbd: React.CSSProperties = { fontSize: 10, fontFamily: "var(--font-mono)", color: "var(--c-dim)", background: "var(--c-srf)", border: "1px solid var(--c-brd2)", borderRadius: 4, padding: "1px 5px", lineHeight: "16px" };
