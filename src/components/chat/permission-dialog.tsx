import { useEffect, useRef } from "react";
import type { PermissionRequest } from "@/stores/chat-store";
import { useAppStore } from "@/stores/app-store";
import { formatShortcut } from "@/lib/keyboard-shortcuts";
import { isOnScreen, cardKeyOwnedElsewhere } from "@/hooks/use-escape-to-stop";
import { paneOwnsInput } from "./pane-session-context";

interface Props {
  request: PermissionRequest;
  /** The split-view pane this card is in; undefined in the single view. */
  paneIdx?: number;
  onAllow: (id: string, toolName: string) => void;
  onAllowAlways: (id: string, toolName: string) => void;
  onDeny: (id: string, toolName: string) => void;
}

/* ── Tool metadata ── */
const TOOL_VERB: Record<string, string> = {
  Bash: "run a shell command",
  PowerShell: "run a shell command",
  Read: "read a file",
  Write: "create a new file",
  Edit: "edit a file",
  MultiEdit: "edit multiple files",
  Glob: "search for files",
  Grep: "search the code",
  Agent: "dispatch a subagent",
  WebFetch: "fetch a URL",
  WebSearch: "search the web",
  TodoWrite: "update the task list",
  NotebookEdit: "edit a notebook",
  NotebookRead: "read a notebook",
  EnterPlanMode: "switch to planning mode",
  ExitPlanMode: "exit planning mode and begin execution",
  AskUserQuestion: "ask you a question",
};

function toolVerb(name: string): string {
  return TOOL_VERB[name] ?? name.toLowerCase();
}

const MONO = "'SF Mono','Menlo','Monaco','Consolas',monospace";

/* ── Card variants ─────────────────────────────────────────────────────── */
type CardVariant = "permission" | "question" | "plan";

function cardVariant(toolName: string): CardVariant {
  if (toolName === "AskUserQuestion") return "question";
  if (toolName === "EnterPlanMode" || toolName === "ExitPlanMode") return "plan";
  return "permission";
}

const VARIANT_META: Record<CardVariant, { label: string; accentColor: string }> = {
  permission: { label: "Permission",  accentColor: "var(--c-ghost)" },
  question:   { label: "Question",    accentColor: "#7C6AF7" },
  plan:       { label: "Plan",        accentColor: "#2D9B75" },
};

export function PermissionDialog({
  request,
  paneIdx,
  onAllow,
  onAllowAlways,
  onDeny,
}: Props) {
  const verb = request.tool_description ?? toolVerb(request.tool_name);
  const variant = cardVariant(request.tool_name);
  const meta = VARIANT_META[variant];
  const isQuestion = variant === "question";
  const isPlan     = variant === "plan";

  /* Keyboard shortcuts.
   *
   * Pane guard: a window-level keydown fires whichever pane the user is
   * in. A split view shows every pane's card at once, so only the pane
   * that owns input may answer: the focused pane, the same rule as
   * Escape-to-stop (`paneOwnsInput`). The single view always owns it. The
   * focused pane is read at handler time, so it is never stale.
   *
   * Parked guard: App.tsx keeps the shell mounted under `display: none`
   * while Settings or Library is open, so this listener outlives the
   * card's visibility. The Escape that closes either of them must not
   * also deny the request hidden underneath.
   *
   * Elsewhere guard (`cardKeyOwnedElsewhere`): a key that belongs to
   * something else answers nothing. That is the Escape a popover or modal
   * claimed to close itself, a key typed in a field outside this chat,
   * and any key while a modal is open. The Escape that stops the stream
   * is not a claim, so it still skips the question. */
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Only Esc and ⌘↵ / ⌘⇧↵ act. Return on any other key first, so
      // ordinary typing never pays for isOnScreen's computed-style walk.
      if (e.key !== "Escape" && !(e.key === "Enter" && e.metaKey)) return;
      if (cardKeyOwnedElsewhere(e, rootRef.current)) return;
      if (!paneOwnsInput(paneIdx, useAppStore.getState().focusedPaneIdx)) return;
      if (!isOnScreen(rootRef.current)) return;
      if (e.key === "Escape") {
        e.preventDefault();
        onDeny(request.id, request.tool_name);
      } else if (e.key === "Enter" && e.metaKey && e.shiftKey && !isQuestion) {
        e.preventDefault();
        onAllowAlways(request.id, request.tool_name);
      } else if (e.key === "Enter" && e.metaKey) {
        e.preventDefault();
        onAllow(request.id, request.tool_name);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [request.id, request.tool_name, paneIdx, onAllow, onAllowAlways, onDeny, isQuestion]);

  return (
    <>
      <style>{`
        @keyframes permCardIn {
          from { opacity: 0; transform: translateY(6px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        .perm-btn:active { transform: translateY(0.5px); }
      `}</style>

      {/* Compact attached card — uses the EXACT same surface tokens as
          the chat input box (var(--chat-input-bg), 10px corners,
          rgba(fg,0.10) border, inset top highlight). Tiny 6px gap
          before the BranchStrip so the two cards read as a stacked
          pair, not as one element. Theme-adaptive (#161616 in dark,
          #ffffff in light) so it works for both. */}
      <div ref={rootRef} style={{
        animation: "permCardIn 0.18s cubic-bezier(0.22, 1, 0.36, 1) both",
      }}>
        <div style={{
          borderRadius: 10,
          border: "1px solid rgba(var(--fg-rgb),0.10)",
          background: "var(--chat-input-bg)",
          boxShadow: "inset 0 1px 0 rgba(var(--fg-rgb),0.04)",
          overflow: "hidden",
          marginBottom: 6,
        }}>
          <div style={{ padding: "10px 12px 10px" }}>
            {/* Header: VARIANT · TOOL */}
            <div style={{
              display: "flex", alignItems: "center", gap: 8,
              fontFamily: MONO,
              fontSize: 10,
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              marginBottom: 6,
            }}>
              <span style={{
                color: variant === "permission" ? "#a8a8a8" : meta.accentColor,
                fontWeight: 600,
              }}>{meta.label}</span>
              <span style={{ color: "#6a6a6a" }}>·</span>
              <span style={{ color: "#c4c4c4", fontWeight: 500 }}>{request.tool_name}</span>
            </div>

            {/* Main prompt text — bright, readable on #161616 */}
            <div style={{
              fontSize: 13.5,
              fontWeight: 600,
              color: "#f5f5f5",
              letterSpacing: "-0.005em",
              lineHeight: 1.4,
              marginBottom: request.command ? 8 : 10,
            }}>
              {isQuestion ? (
                <>The agent wants to <span>ask you something</span>:</>
              ) : isPlan ? (
                <>Allow this agent to <span style={{ color: meta.accentColor }}>{verb}</span>?</>
              ) : (
                <>Allow this agent to <span>{verb}</span>?</>
              )}
            </div>

            {/* Command / question / plan preview — inset surface deeper
                than the card so it reads as quoted content. */}
            {request.command && (
              <div style={{
                padding: "8px 12px",
                background: "#0e0e0e",
                border: "1px solid rgba(255,255,255,0.08)",
                borderRadius: 7,
                fontFamily: isQuestion ? "inherit" : MONO,
                fontSize: isQuestion ? 13 : 11.5,
                lineHeight: 1.55,
                color: isQuestion ? "#ececec" : "#dcdcdc",
                fontWeight: isQuestion ? 500 : 400,
                maxHeight: 180,
                overflowY: "auto",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                marginBottom: 10,
              }}>
                {request.command}
              </div>
            )}

            {/* Button row — compact, all on one line */}
            <div style={{
              display: "flex",
              justifyContent: "flex-end",
              alignItems: "center",
              gap: 6,
            }}>
              {/* Deny / Skip */}
              <button
                className="perm-btn"
                onClick={() => onDeny(request.id, request.tool_name)}
                style={{
                  display: "inline-flex", alignItems: "center", gap: 6,
                  height: 26, padding: "0 10px",
                  background: "transparent",
                  border: "none",
                  borderRadius: 6,
                  color: "#a8a8a8",
                  fontSize: 12, fontWeight: 500,
                  cursor: "pointer",
                  transition: "color 0.12s, background 0.12s",
                  fontFamily: "inherit",
                }}
                onMouseEnter={e => { e.currentTarget.style.color = "#f0f0f0"; e.currentTarget.style.background = "rgba(255,255,255,0.06)"; }}
                onMouseLeave={e => { e.currentTarget.style.color = "#a8a8a8"; e.currentTarget.style.background = "transparent"; }}
              >
                {isQuestion ? "Skip" : "Deny"}
                <kbd style={{ fontFamily: MONO, fontSize: 9.5, opacity: 0.55 }}>Esc</kbd>
              </button>

              {/* Allow / Continue */}
              <button
                className="perm-btn"
                onClick={() => onAllow(request.id, request.tool_name)}
                style={{
                  display: "inline-flex", alignItems: "center", gap: 6,
                  height: 26, padding: "0 11px",
                  background: "rgba(255,255,255,0.07)",
                  border: "1px solid rgba(255,255,255,0.12)",
                  borderRadius: 6,
                  color: "#f0f0f0",
                  fontSize: 12, fontWeight: 600,
                  cursor: "pointer",
                  transition: "background 0.12s",
                  fontFamily: "inherit",
                }}
                onMouseEnter={e => { e.currentTarget.style.background = "rgba(255,255,255,0.13)"; }}
                onMouseLeave={e => { e.currentTarget.style.background = "rgba(255,255,255,0.07)"; }}
              >
                {isQuestion ? "Continue" : "Allow"}
                <kbd style={{ fontFamily: MONO, fontSize: 9.5, opacity: 0.55 }}>{formatShortcut(["Mod", "Enter"])}</kbd>
              </button>

              {/* Always allow — hidden for questions. Highest weight,
                  bright surface, primary CTA. */}
              {!isQuestion && (
                <button
                  className="perm-btn"
                  onClick={() => onAllowAlways(request.id, request.tool_name)}
                  style={{
                    display: "inline-flex", alignItems: "center", gap: 6,
                    height: 26, padding: "0 11px",
                    background: "#f5f5f5",
                    border: "1px solid #f5f5f5",
                    borderRadius: 6,
                    color: "#0a0a0a",
                    fontSize: 12, fontWeight: 600,
                    cursor: "pointer",
                    transition: "opacity 0.12s",
                    fontFamily: "inherit",
                  }}
                  onMouseEnter={e => { e.currentTarget.style.opacity = "0.85"; }}
                  onMouseLeave={e => { e.currentTarget.style.opacity = "1"; }}
                >
                  Always allow
                  <kbd style={{ fontFamily: MONO, fontSize: 9.5, opacity: 0.55, color: "#0a0a0a" }}>{formatShortcut(["Mod", "Shift", "Enter"])}</kbd>
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
