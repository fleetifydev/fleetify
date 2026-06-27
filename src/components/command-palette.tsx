import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  Search, ArrowRight, Square, Send,
  Layers, StopCircle, Plus, Zap, GitBranch,
  MessageSquareX, PanelLeft, Settings, Sun, Moon, Monitor,
  ChevronRight,
} from "lucide-react";
import { useAppStore } from "@/stores/app-store";
import { wsManager } from "@/services/ws-manager";
import { useThemeStore } from "@/stores/theme-store";
import { formatShortcut, shortcutLabel } from "@/lib/keyboard-shortcuts";

// ─── Types ────────────────────────────────────────────────────────────────────

interface BaseCommand {
  id: string;
  title: string;
  description?: string;
  section: string;
  shortcut?: string;
  icon: React.ElementType;
  iconColor?: string;
  danger?: boolean;
}

interface ActionCommand extends BaseCommand {
  kind: "action";
  execute: () => void;
}

interface DispatchCommand extends BaseCommand {
  kind: "dispatch";
  sessionId: string;
  agentName: string;
}

type Command = ActionCommand | DispatchCommand;

// ─── Props ────────────────────────────────────────────────────────────────────

interface Props {
  open: boolean;
  onClose: () => void;
  onAction: (action: string) => void;
}

// ─── Tiny fuzzy match — checks if all query chars appear in order ─────────────

function fuzzyMatch(text: string, query: string): boolean {
  if (!query) return true;
  const t = text.toLowerCase();
  const q = query.toLowerCase();
  // Fast path: substring
  if (t.includes(q)) return true;
  // Fuzzy path: chars in order
  let qi = 0;
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) qi++;
  }
  return qi === q.length;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function CommandPalette({ open, onClose, onAction }: Props) {
  const [query, setQuery]           = useState("");
  const [cursor, setCursor]         = useState(0);
  const [dispatchCmd, setDispatchCmd] = useState<DispatchCommand | null>(null);
  const [taskText, setTaskText]     = useState("");
  const [dispatching, setDispatching] = useState(false);

  const inputRef     = useRef<HTMLInputElement>(null);
  const taskInputRef = useRef<HTMLInputElement>(null);
  const listRef      = useRef<HTMLDivElement>(null);

  // Store state
  const {
    sessions,
    setActiveSession,
    setMainView,
    toggleSidebar,
    toggleFleetAutoMode,
    fleetAutoMode,
  } = useAppStore();

  const { mode, cycleMode } = useThemeStore();

  // ─── Build command list ───────────────────────────────────────────────────

  const commands = useMemo((): Command[] => {
    const cmds: Command[] = [];

    // ── Agent commands (dynamic per session) ────────────────────────────────
    for (const session of sessions) {
      cmds.push({
        kind: "action",
        id: `open-${session.id}`,
        section: "Agents",
        icon: ArrowRight,
        title: `Open ${session.title}`,
        description: session.status,
        execute: () => {
          setMainView("fleet");
          setActiveSession(session.id);
          onClose();
        },
      });

      if (session.status === "running") {
        cmds.push({
          kind: "action",
          id: `stop-${session.id}`,
          section: "Agents",
          icon: Square,
          iconColor: "#ef4444",
          title: `Stop ${session.title}`,
          description: "Abort the running task",
          danger: true,
          execute: () => {
            wsManager.abort(session.id);
            onClose();
          },
        });
      }

      cmds.push({
        kind: "dispatch",
        id: `dispatch-${session.id}`,
        section: "Agents",
        icon: Send,
        title: `Dispatch to ${session.title}…`,
        description: "Send a task directly to this agent",
        sessionId: session.id,
        agentName: session.title,
      });
    }

    // ── Fleet commands ───────────────────────────────────────────────────────
    cmds.push({
      kind: "action",
      id: "fleet-home",
      section: "Fleetify",
      icon: Layers,
      title: "Go to Fleetify",
      shortcut: formatShortcut(["Mod", "1"]),
      description: "Return to the agent overview",
      execute: () => { setMainView("fleet"); onClose(); },
    });

    cmds.push({
      kind: "action",
      id: "fleet-workflows",
      section: "Fleetify",
      icon: GitBranch,
      title: "Go to Workflows",
      shortcut: formatShortcut(["Mod", "2"]),
      description: "View and manage automation workflows",
      execute: () => { setMainView("workflows"); onClose(); },
    });

    cmds.push({
      kind: "action",
      id: "fleet-new-agent",
      section: "Fleetify",
      icon: Plus,
      title: "New Agent",
      shortcut: shortcutLabel("new-draft"),
      description: "Spawn a new agent session",
      execute: () => {
        onClose();
        onAction("new-agent");
      },
    });

    const runningSessions = sessions.filter(s => s.status === "running");
    if (runningSessions.length > 0) {
      cmds.push({
        kind: "action",
        id: "stop-all",
        section: "Fleetify",
        icon: StopCircle,
        iconColor: "#ef4444",
        title: "Stop All Agents",
        description: `Abort ${runningSessions.length} running agent${runningSessions.length > 1 ? "s" : ""}`,
        danger: true,
        execute: () => {
          for (const s of runningSessions) wsManager.abort(s.id);
          onClose();
        },
      });
    }

    cmds.push({
      kind: "action",
      id: "toggle-auto-mode",
      section: "Fleetify",
      icon: Zap,
      iconColor: fleetAutoMode ? "#f59e0b" : undefined,
      title: fleetAutoMode ? "Disable Auto Mode" : "Enable Auto Mode",
      description: "Fleetify auto-processes incoming tasks",
      execute: () => { toggleFleetAutoMode(); onClose(); },
    });

    // ── Session commands ─────────────────────────────────────────────────────
    cmds.push({
      kind: "action",
      id: "clear-chat",
      section: "Session",
      icon: MessageSquareX,
      title: "Clear Chat",
      description: "Clear the active session's chat history",
      execute: () => {
        window.dispatchEvent(new Event("fleet:clear-chat"));
        onClose();
      },
    });

    cmds.push({
      kind: "action",
      id: "toggle-sidebar",
      section: "Session",
      icon: PanelLeft,
      title: "Toggle Sidebar",
      shortcut: formatShortcut(["Mod", "B"]),
      description: "Show or hide the left sidebar",
      execute: () => { toggleSidebar(); onClose(); },
    });

    // ── App commands ─────────────────────────────────────────────────────────
    cmds.push({
      kind: "action",
      id: "open-settings",
      section: "App",
      icon: Settings,
      title: "Settings",
      shortcut: formatShortcut(["Mod", ","]),
      description: "Open app settings",
      execute: () => { onClose(); onAction("settings"); },
    });

    cmds.push({
      kind: "action",
      id: "toggle-theme",
      section: "App",
      icon: mode === "light" ? Sun : mode === "dark" ? Moon : Monitor,
      title: `Switch theme — now ${mode === "system" ? "System" : mode === "dark" ? "Dark" : "Light"}`,
      description: "Cycle System → Light → Dark",
      execute: () => { cycleMode(); onClose(); },
    });

    return cmds;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions, fleetAutoMode, mode]);

  // ─── Filtered + sectioned list ────────────────────────────────────────────

  const filtered = useMemo(() => {
    if (!query.trim()) return commands;
    return commands.filter(c =>
      fuzzyMatch(c.title, query) ||
      (c.description ? fuzzyMatch(c.description, query) : false)
    );
  }, [commands, query]);

  const sections = useMemo(() => {
    const map = new Map<string, Command[]>();
    for (const cmd of filtered) {
      const list = map.get(cmd.section) ?? [];
      list.push(cmd);
      map.set(cmd.section, list);
    }
    return Array.from(map.entries()).map(([label, items]) => ({ label, items }));
  }, [filtered]);

  // Clamp cursor when filtered list changes
  useEffect(() => {
    setCursor(c => Math.min(c, Math.max(filtered.length - 1, 0)));
  }, [filtered.length]);

  // ─── Open / close reset ───────────────────────────────────────────────────

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setCursor(0);
    setDispatchCmd(null);
    setTaskText("");
    setDispatching(false);
    const t = setTimeout(() => inputRef.current?.focus(), 30);
    return () => clearTimeout(t);
  }, [open]);

  // Focus task input when dispatch mode activates
  useEffect(() => {
    if (!dispatchCmd) return;
    const t = setTimeout(() => taskInputRef.current?.focus(), 30);
    return () => clearTimeout(t);
  }, [dispatchCmd]);

  // Scroll highlighted row into view
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const active = list.querySelector<HTMLElement>(".cp-active");
    if (active) active.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  // ─── Execute a command ────────────────────────────────────────────────────

  const executeCommand = useCallback((cmd: Command) => {
    if (cmd.kind === "dispatch") {
      setDispatchCmd(cmd);
      return;
    }
    cmd.execute();
  }, []);

  const handleDispatchSend = useCallback(async () => {
    if (!dispatchCmd || !taskText.trim()) return;
    setDispatching(true);
    try {
      await wsManager.send(dispatchCmd.sessionId, taskText.trim());
    } finally {
      setDispatching(false);
      setDispatchCmd(null);
      setTaskText("");
      onClose();
    }
  }, [dispatchCmd, taskText, onClose]);

  // ─── Global keyboard shortcuts ────────────────────────────────────────────

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Toggle open/close
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        if (open) onClose(); else onAction("open");
        return;
      }
      if (!open) return;

      if (e.key === "Escape") {
        e.preventDefault();
        if (dispatchCmd) { setDispatchCmd(null); setTaskText(""); }
        else onClose();
        return;
      }

      if (dispatchCmd) {
        // In dispatch sub-input mode: Enter sends
        if (e.key === "Enter") { e.preventDefault(); handleDispatchSend(); }
        return;
      }

      if (e.key === "ArrowDown") {
        e.preventDefault();
        setCursor(c => Math.min(c + 1, filtered.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setCursor(c => Math.max(c - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (filtered[cursor]) executeCommand(filtered[cursor]);
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose, onAction, cursor, filtered, executeCommand, dispatchCmd, handleDispatchSend]);

  if (!open) return null;

  let globalIdx = -1;

  return (
    <>
      <style>{`
        @keyframes cp-fade-in {
          from { opacity: 0; transform: translateX(-50%) translateY(-8px) scale(0.97); }
          to   { opacity: 1; transform: translateX(-50%) translateY(0)    scale(1);    }
        }
        @keyframes cp-bg-in {
          from { opacity: 0; }
          to   { opacity: 1; }
        }
        .cp-row {
          transition: background 80ms ease, color 80ms ease;
        }
        .cp-row:hover,
        .cp-row.cp-active {
          background: var(--c-srf2) !important;
        }
        .cp-row:hover .cp-title,
        .cp-row.cp-active .cp-title {
          color: var(--c-high) !important;
        }
        .cp-row.cp-danger:hover .cp-title,
        .cp-row.cp-danger.cp-active .cp-title {
          color: #ef4444 !important;
        }
        .cp-row.cp-active .cp-chevron {
          opacity: 1 !important;
        }
        .cp-input-main:focus {
          outline: none;
        }
        .cp-task-input:focus {
          outline: none;
        }
      `}</style>

      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{
          position: "fixed", inset: 0, zIndex: 99998,
          background: "rgba(0,0,0,0.6)",
          animation: "cp-bg-in 0.12s ease",
        }}
      />

      {/* Modal */}
      <div
        style={{
          position: "fixed",
          top: "14vh",
          left: "50%",
          transform: "translateX(-50%)",
          zIndex: 99999,
          width: 560,
          maxWidth: "calc(100vw - 32px)",
          borderRadius: 12,
          background: "var(--sidebar)",
          border: "1px solid var(--c-brd2, var(--c-brd))",
          boxShadow: "0 32px 80px rgba(0,0,0,0.65), 0 0 0 1px rgba(255,255,255,0.04) inset",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          animation: "cp-fade-in 0.14s cubic-bezier(0.22,1,0.36,1)",
        }}
      >
        {/* Search row */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "0 14px",
            height: 48,
            borderBottom: "1px solid var(--c-brd)",
            flexShrink: 0,
          }}
        >
          <Search size={15} style={{ color: "var(--c-dim)", flexShrink: 0 }} />
          <input
            ref={inputRef}
            className="cp-input-main"
            value={query}
            onChange={e => { setQuery(e.target.value); setCursor(0); }}
            placeholder="Type a command or search…"
            style={{
              flex: 1,
              height: "100%",
              background: "transparent",
              border: "none",
              outline: "none",
              fontSize: 15,
              color: "var(--c-high)",
              fontFamily: "inherit",
              caretColor: "var(--c-high)",
            }}
          />
          <kbd style={{
            fontSize: 10,
            padding: "2px 6px",
            borderRadius: 5,
            flexShrink: 0,
            background: "var(--c-srf)",
            color: "var(--c-ghost)",
            border: "1px solid var(--c-brd)",
            fontFamily: "inherit",
          }}>
            ESC
          </kbd>
        </div>

        {/* Dispatch sub-input — slides in below search when active */}
        {dispatchCmd && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "0 14px",
              height: 44,
              borderBottom: "1px solid var(--c-brd)",
              background: "rgba(59,130,246,0.06)",
              flexShrink: 0,
            }}
          >
            <Send size={13} style={{ color: "#3b82f6", flexShrink: 0 }} />
            <span style={{ fontSize: 12, color: "#3b82f6", fontWeight: 500, flexShrink: 0, whiteSpace: "nowrap" }}>
              → {dispatchCmd.agentName}
            </span>
            <div style={{ width: 1, height: 16, background: "var(--c-brd)", flexShrink: 0 }} />
            <input
              ref={taskInputRef}
              className="cp-task-input"
              value={taskText}
              onChange={e => setTaskText(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter") { e.preventDefault(); handleDispatchSend(); }
              }}
              placeholder={`Task for ${dispatchCmd.agentName}…`}
              disabled={dispatching}
              style={{
                flex: 1,
                height: "100%",
                background: "transparent",
                border: "none",
                outline: "none",
                fontSize: 13.5,
                color: "var(--c-high)",
                fontFamily: "inherit",
                caretColor: "var(--c-high)",
                opacity: dispatching ? 0.5 : 1,
              }}
            />
            <button
              onClick={handleDispatchSend}
              disabled={!taskText.trim() || dispatching}
              style={{
                flexShrink: 0,
                padding: "3px 10px",
                borderRadius: 6,
                border: "none",
                cursor: taskText.trim() && !dispatching ? "pointer" : "default",
                background: taskText.trim() && !dispatching ? "#3b82f6" : "var(--c-srf)",
                color: taskText.trim() && !dispatching ? "#fff" : "var(--c-ghost)",
                fontSize: 11,
                fontWeight: 600,
                fontFamily: "inherit",
                transition: "background 120ms, color 120ms",
              }}
            >
              {dispatching ? "Sending…" : "Send ↵"}
            </button>
          </div>
        )}

        {/* Results */}
        <div
          ref={listRef}
          className="scroll-subtle"
          style={{
            flex: 1,
            overflowY: "auto",
            padding: "4px 0",
            maxHeight: 360,
          }}
        >
          {sections.length === 0 && (
            <div style={{
              padding: "32px 16px",
              textAlign: "center",
              fontSize: 13,
              color: "var(--c-ghost)",
            }}>
              No results for "{query}"
            </div>
          )}

          {sections.map(({ label, items }) => (
            <div key={label}>
              {/* Section header */}
              <div style={{
                padding: "8px 14px 3px",
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: "0.08em",
                color: "var(--c-ghost)",
                textTransform: "uppercase",
              }}>
                {label}
              </div>

              {items.map(cmd => {
                const Icon = cmd.icon;
                globalIdx++;
                const idx = globalIdx;
                const isActive = !dispatchCmd && cursor === idx;
                const iconColor = cmd.iconColor ?? "var(--c-dim)";

                return (
                  <button
                    key={cmd.id}
                    className={[
                      "cp-row",
                      isActive ? "cp-active" : "",
                      cmd.danger ? "cp-danger" : "",
                    ].filter(Boolean).join(" ")}
                    onMouseEnter={() => { if (!dispatchCmd) setCursor(idx); }}
                    onClick={() => executeCommand(cmd)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 9,
                      width: "100%",
                      padding: "7px 14px",
                      background: "none",
                      border: "none",
                      cursor: "pointer",
                      textAlign: "left",
                    }}
                  >
                    {/* Icon */}
                    <span style={{
                      width: 28,
                      height: 28,
                      borderRadius: 7,
                      background: "var(--c-srf)",
                      border: "1px solid var(--c-brd)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      flexShrink: 0,
                    }}>
                      <Icon size={13} style={{ color: iconColor }} />
                    </span>

                    {/* Text */}
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span
                        className="cp-title"
                        style={{
                          display: "block",
                          fontSize: 13.5,
                          fontWeight: 450,
                          color: cmd.danger ? "#f87171" : "var(--c-med)",
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}
                      >
                        {cmd.title}
                      </span>
                      {cmd.description && (
                        <span style={{
                          display: "block",
                          fontSize: 11,
                          color: "var(--c-ghost)",
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          marginTop: 1,
                        }}>
                          {cmd.description}
                        </span>
                      )}
                    </span>

                    {/* Right side: shortcut or dispatch chevron */}
                    {cmd.kind === "dispatch" ? (
                      <ChevronRight
                        size={13}
                        className="cp-chevron"
                        style={{ color: "var(--c-ghost)", flexShrink: 0, opacity: isActive ? 1 : 0.4 }}
                      />
                    ) : cmd.shortcut ? (
                      <kbd style={{
                        fontSize: 10,
                        padding: "2px 6px",
                        borderRadius: 5,
                        flexShrink: 0,
                        background: "var(--c-srf)",
                        color: "var(--c-dim)",
                        border: "1px solid var(--c-brd)",
                        fontFamily: "inherit",
                        letterSpacing: "0.04em",
                      }}>
                        {cmd.shortcut}
                      </kbd>
                    ) : null}
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        {/* Footer */}
        <div style={{
          display: "flex",
          alignItems: "center",
          gap: 14,
          padding: "7px 14px",
          borderTop: "1px solid var(--c-brd)",
          flexShrink: 0,
        }}>
          {[
            { key: "↑↓", hint: "navigate" },
            { key: "↵",  hint: dispatchCmd ? "send" : "open" },
            { key: formatShortcut(["Mod", "K"]), hint: "close" },
          ].map(({ key, hint }) => (
            <span key={key} style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <kbd style={{
                fontSize: 9.5,
                padding: "1px 5px",
                borderRadius: 4,
                background: "var(--c-srf)",
                color: "var(--c-dim)",
                border: "1px solid var(--c-brd)",
                fontFamily: "inherit",
              }}>
                {key}
              </kbd>
              <span style={{ fontSize: 10.5, color: "var(--c-ghost)" }}>{hint}</span>
            </span>
          ))}

          {/* Status text right-aligned */}
          <span style={{ marginLeft: "auto", fontSize: 10.5, color: "var(--c-ghost)" }}>
            {dispatchCmd
              ? `Dispatching to ${dispatchCmd.agentName}`
              : filtered.length > 0
                ? `${filtered.length} command${filtered.length > 1 ? "s" : ""}`
                : ""}
          </span>
        </div>
      </div>
    </>
  );
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

/**
 * Convenience hook for imperative open/close/toggle of the command palette.
 * The palette state lives in App.tsx; this hook fires custom events that
 * bubble up to the App-level handler so no prop drilling is required from
 * deeply nested components.
 */
export function useCommandPalette() {
  const open   = useCallback(() => window.dispatchEvent(new CustomEvent("fleet:cmd-palette", { detail: { action: "open" } })), []);
  const close  = useCallback(() => window.dispatchEvent(new CustomEvent("fleet:cmd-palette", { detail: { action: "close" } })), []);
  const toggle = useCallback(() => window.dispatchEvent(new CustomEvent("fleet:cmd-palette", { detail: { action: "toggle" } })), []);
  return { open, close, toggle };
}
