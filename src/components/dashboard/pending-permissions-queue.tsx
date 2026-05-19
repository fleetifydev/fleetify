/**
 * Pending Permissions Queue — top-of-hub queue that aggregates every
 * pending permission request across every session.
 *
 * Vision: the user can approve/deny without ever leaving the operations hub.
 * Background-dispatched agents that hit a permission ask must surface here,
 * not get buried inside a per-agent chat the user might not be looking at.
 *
 * Design discipline (the user's rule: "no hacker-tool greens"):
 *   - One small pulsing orange dot per row carries all the urgency. Every
 *     other surface is monochrome.
 *   - The primary CTA uses --c-high on --card, exactly like the inline
 *     DispatchPermBtn and the Reply Send button — one button language
 *     across the whole product.
 *   - Solid colors only. Never rgba on dark surfaces.
 */
import { Check, X, ChevronRight } from "lucide-react";
import { wsManager } from "@/services/ws-manager";
import type { Session } from "@/types/session";
import type { SessionChatState } from "@/stores/chat-store";

interface Props {
  sessions: Session[];
  // Only the permissionRequest field is consumed — narrow shape lets
  // the parent provide a perf-optimised projection (see
  // ControlCenterPanel's `chatSessions` selector + ChatSessionsDigest).
  chatSessions: Record<string, { permissionRequest: SessionChatState["permissionRequest"] }>;
  /** Optional — caller can decide what "jump to that agent" means. */
  onJump?: (sessionId: string) => void;
}

export function PendingPermissionsQueue({ sessions, chatSessions, onJump }: Props) {
  const pending = sessions
    .map(s => ({ session: s, req: chatSessions[s.id]?.permissionRequest }))
    .filter((x): x is { session: Session; req: NonNullable<SessionChatState["permissionRequest"]> } => !!x.req);

  if (pending.length === 0) return null;

  return (
    <div style={{ paddingBottom: 4 }}>
      {/* Header — quiet GroupLabel rhythm. Orange is restricted to the
          tiny pulsing dot; the text is plain ghost-grey like every other
          section header in the panel. */}
      <div style={{ display: "flex", alignItems: "center", padding: "10px 12px 4px", gap: 6 }}>
        <span
          aria-hidden
          style={{
            width: 5, height: 5, borderRadius: 999,
            background: "#fb923c",
            animation: "cc-pulse 1.6s ease-in-out infinite",
            flexShrink: 0,
          }}
        />
        <span
          style={{
            flex: 1,
            fontSize: 10.5,
            fontWeight: 500,
            letterSpacing: "0.01em",
            color: "var(--c-ghost)",
          }}
        >
          Awaiting approval
        </span>
        <span
          style={{
            fontSize: 10,
            color: "var(--c-ghost)",
            fontWeight: 500,
            fontFamily: "var(--font-mono)",
          }}
        >
          {pending.length}
        </span>
      </div>

      <div style={{ display: "flex", flexDirection: "column" }}>
        {pending.map(({ session, req }) => {
          const isQuestion = req.tool_name?.toLowerCase().includes("question");
          return (
            <div
              key={`${session.id}:${req.id}`}
              style={{
                position: "relative",
                padding: "8px 12px 10px 14px",
                display: "flex",
                flexDirection: "column",
                gap: 6,
              }}
            >
              {/* Left accent stripe — solid muted ghost, not neon. The
                  pulsing dot in the header above already carries the
                  attention; the row only needs a quiet "this is the one". */}
              <span
                aria-hidden
                style={{
                  position: "absolute",
                  left: 0, top: 6, bottom: 8, width: 2,
                  background: "var(--c-brd2)",
                  borderRadius: 2,
                }}
              />

              {/* Title row — agent name, tool tag, jump caret */}
              <button
                onClick={() => onJump?.(session.id)}
                title={onJump ? "Open this agent" : undefined}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  background: "transparent",
                  border: "none",
                  padding: 0,
                  cursor: onJump ? "pointer" : "default",
                  textAlign: "left",
                  color: "inherit",
                }}
              >
                <span
                  style={{
                    fontSize: 12.5,
                    fontWeight: 500,
                    color: "var(--c-high)",
                    flex: 1,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    minWidth: 0,
                  }}
                >
                  {session.title}
                </span>
                <span
                  style={{
                    fontSize: 10,
                    fontFamily: "var(--font-mono)",
                    color: "var(--c-low)",
                    fontWeight: 500,
                    letterSpacing: "0.01em",
                    flexShrink: 0,
                    padding: "1px 6px",
                    borderRadius: 4,
                    background: "var(--c-srf)",
                  }}
                >
                  {req.tool_name}
                </span>
                {onJump && (
                  <ChevronRight
                    size={11}
                    style={{ color: "var(--c-ghost)", flexShrink: 0 }}
                  />
                )}
              </button>

              {/* Command preview — single line, fades right, monospace */}
              {req.command && (
                <div
                  title={req.command}
                  style={{
                    fontSize: 11,
                    fontFamily: "var(--font-mono)",
                    color: "var(--c-low)",
                    lineHeight: 1.4,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    WebkitMaskImage: "linear-gradient(to right, black 80%, transparent 100%)",
                    maskImage: "linear-gradient(to right, black 80%, transparent 100%)",
                  }}
                >
                  {req.command}
                </div>
              )}

              {/* Action row — three buttons, one design language with the
                  inline DispatchPermBtn:
                    Allow    → primary (light fill, dark text)
                    Always   → secondary (subtle surface)
                    Deny     → ghost (text only, red only on hover) */}
              <div style={{ display: "flex", gap: 4, marginTop: 2 }}>
                <button
                  onClick={() =>
                    wsManager.sendPermissionResponse(session.id, req.id, true, false, req.tool_name)
                  }
                  style={{
                    flex: 1,
                    padding: "6px 0",
                    borderRadius: 6,
                    border: "1px solid var(--c-high)",
                    cursor: "pointer",
                    fontSize: 11,
                    fontWeight: 600,
                    background: "var(--c-high)",
                    color: "var(--card)",
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 5,
                    transition: "background 0.12s, border-color 0.12s",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = "var(--c-med)";
                    e.currentTarget.style.borderColor = "var(--c-med)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = "var(--c-high)";
                    e.currentTarget.style.borderColor = "var(--c-high)";
                  }}
                >
                  <Check size={10} strokeWidth={2.5} />
                  {isQuestion ? "Reply" : "Allow"}
                </button>
                <button
                  onClick={() =>
                    wsManager.sendPermissionResponse(session.id, req.id, true, true, req.tool_name)
                  }
                  title="Allow this tool every time for this agent"
                  style={{
                    flex: 1,
                    padding: "6px 0",
                    borderRadius: 6,
                    border: "1px solid var(--c-brd2)",
                    cursor: "pointer",
                    fontSize: 11,
                    fontWeight: 500,
                    background: "var(--card)",
                    color: "var(--c-low)",
                    transition: "background 0.12s, color 0.12s",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = "var(--c-srf2)";
                    e.currentTarget.style.color = "var(--c-high)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = "var(--card)";
                    e.currentTarget.style.color = "var(--c-low)";
                  }}
                >
                  Always
                </button>
                <button
                  onClick={() =>
                    wsManager.sendPermissionResponse(session.id, req.id, false, false, req.tool_name)
                  }
                  style={{
                    flex: "0 0 auto",
                    padding: "6px 10px",
                    borderRadius: 6,
                    border: "1px solid transparent",
                    cursor: "pointer",
                    fontSize: 11,
                    fontWeight: 500,
                    background: "transparent",
                    color: "var(--c-dim)",
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 4,
                    transition: "color 0.12s, background 0.12s",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.color = "var(--c-high)";
                    e.currentTarget.style.background = "var(--c-srf)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.color = "var(--c-dim)";
                    e.currentTarget.style.background = "transparent";
                  }}
                >
                  <X size={10} strokeWidth={2} />
                  Deny
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
