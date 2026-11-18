/**
 * Right-click menu for a session row.
 *
 * Lived inside sidebar.tsx as a module-private `CtxMenu` until the Fleet
 * panel's session list needed the same menu. Extracted rather than copied:
 * two context menus for the same entity drift apart, and the destructive rows
 * (reset, delete) are exactly where drift hurts.
 *
 * Every action prop is optional. A surface wires the ones it can drive
 * correctly and omits the rest — the Fleet panel has no pin/fork/restart/reset
 * plumbing, so those rows simply do not appear there.
 */
import { useAppStore } from "@/stores/app-store";
import { useChatStore } from "@/stores/chat-store";
import { exportChat } from "@/lib/export-chat";
import { apiFetch } from "@/lib/api";
import {
  Pin, PinOff, Type, GitFork, Download, Square, RotateCcw, RefreshCw, Trash2,
  MessageSquare,
} from "lucide-react";
import type { Session } from "@/types/session";

/* Hoisted out of the component body: defining these inline re-created the
   component type on every render, which React flags and which throws away
   the subtree between renders. Both are pure functions of their props. */
const Row = ({ icon: Icon, label, danger = false, iconColor, onClick }: {
  icon: React.ElementType; label: string; danger?: boolean;
  iconColor?: string; onClick: () => void;
}) => (
  <button
    onClick={onClick}
    style={{
      display: "flex", alignItems: "center", gap: 8, width: "100%",
      padding: "5px 8px", background: "none", border: "none",
      borderRadius: 6, cursor: "pointer", fontSize: 12, textAlign: "left",
      color: danger ? "#f87171" : "var(--c-med)",
      transition: "none",
      fontFamily: "inherit",
    }}
    onMouseEnter={e => {
      e.currentTarget.style.background = danger ? "rgba(248,113,113,0.09)" : "var(--c-srf)";
      if (!danger) e.currentTarget.style.color = "var(--c-high)";
    }}
    onMouseLeave={e => {
      e.currentTarget.style.background = "none";
      e.currentTarget.style.color = danger ? "#f87171" : "var(--c-med)";
    }}
  >
    <Icon size={13} style={{ color: iconColor ?? (danger ? "#f87171" : "var(--c-ghost)"), flexShrink: 0 }} />
    <span>{label}</span>
  </button>
);

const Sep = () => <div style={{ height: 1, background: "var(--c-brd)", margin: "3px 0" }} />;

export function SessionContextMenu({ x, y, menuRef, session, onClose, onOpen, onPin, onFork, onStop, onRestart, onReset, onDelete }: {
  x: number; y: number; menuRef: React.RefObject<HTMLDivElement | null>;
  session: Session; onClose: () => void;
  /** Every action is optional: a surface that cannot wire one correctly omits
   *  it and the row simply does not render. Better a shorter menu than a
   *  second copy of this one with subtly different semantics. */
  onOpen?: () => void;
  onPin?: () => void; onFork?: () => void;
  onStop?: () => void; onRestart?: () => void; onReset?: () => void; onDelete?: () => void;
}) {
  // Per-field selectors — full-state useAppStore() subscribed the menu
  // to every store mutation, even though it only needs two action
  // refs that never change identity.
  const updateSession = useAppStore(s => s.updateSession);

  const doRename = () => {
    const n = prompt("Rename:", session.title);
    if (n) {
      apiFetch(`/api/sessions/${session.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: n }) })
        .then(() => updateSession(session.id, { title: n }));
    }
  };

  const isActive = ["running", "waiting", "starting"].includes(session.status);



  /* Smart positioning — flip up if too close to bottom edge */
  const winH = typeof window !== "undefined" ? window.innerHeight : 800;
  const menuH = isActive ? 230 : 200;
  const top = y + menuH > winH - 16 ? y - menuH : y;

  return (
    <div ref={menuRef} style={{
      position: "fixed", left: x, top,
      zIndex: 9999, minWidth: 180,
      borderRadius: 10, padding: "4px",
      background: "var(--popover)",
      border: "1px solid var(--c-brd2)",
      boxShadow: "0 8px 24px rgba(0,0,0,0.18), 0 2px 8px rgba(0,0,0,0.10), 0 0 0 0.5px rgba(0,0,0,0.06)",
    }}>
      {/* Session title header */}
      <div style={{
        padding: "5px 8px 6px", borderBottom: "1px solid var(--c-brd)", marginBottom: 3,
      }}>
        <div style={{
          fontSize: 11, fontWeight: 500, color: "var(--c-ghost)",
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>
          {session.title}
        </div>
      </div>

      {onOpen && <Row icon={MessageSquare} label="Open chat" onClick={() => { onClose(); onOpen(); }} />}
      {onPin && <Row icon={session.pinned ? PinOff : Pin} label={session.pinned ? "Unpin" : "Pin to top"} onClick={() => { onClose(); onPin(); }} />}
      <Row icon={Type}    label="Rename"       onClick={() => { onClose(); doRename(); }} />
      {onFork && <Row icon={GitFork} label="Fork session" onClick={() => { onClose(); onFork(); }} />}

      <Sep />

      {/* Export — was the chat-header "..." popover; relocated
          here per the user's spec. Reads messages live from the
          chat-store at click time so we don't have to keep them
          in sync as a prop. */}
      <Row icon={Download} label="Export as Markdown" onClick={() => {
        onClose();
        const msgs = useChatStore.getState().sessions[session.id]?.messages ?? [];
        exportChat({ title: session.title, sessionId: session.id, messages: msgs, format: "md" });
      }} />
      <Row icon={Download} label="Export as JSON" onClick={() => {
        onClose();
        const msgs = useChatStore.getState().sessions[session.id]?.messages ?? [];
        exportChat({ title: session.title, sessionId: session.id, messages: msgs, format: "json" });
      }} />

      <Sep />

      {isActive && onStop && (
        <Row icon={Square} label="Stop agent" iconColor="#fb923c" onClick={() => { onClose(); onStop(); }} />
      )}
      {onRestart && <Row icon={RotateCcw} label="Restart agent" onClick={() => { onClose(); onRestart(); }} />}
      {onReset && <Row icon={RefreshCw} label="Reset session" onClick={() => { onClose(); onReset(); }} />}

      <Sep />

      {onDelete && <Row icon={Trash2} label="Delete" danger onClick={() => { onClose(); onDelete(); }} />}
    </div>
  );
}
