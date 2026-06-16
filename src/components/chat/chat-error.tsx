import { AlertCircle } from "lucide-react";

/** The single in-chat error surface. Every error shown in the transcript —
 *  a failed turn, a provider error, a rejected slash command (e.g. an
 *  undersized /compact), a git-op failure — renders through this, so errors
 *  always look the same and adapt to light/dark via the --c-err* tokens.
 *
 *  Deliberately plain (no shadow, no animation beyond the shared fade-in):
 *  a danger-tinted rounded block with an alert icon, a small "Error" heading
 *  (overridable via `title`), and the message body. */
export function ChatError({
  message,
  title = "Error",
}: {
  message: string;
  title?: string;
}) {
  return (
    <div
      role="alert"
      className="fade-in"
      style={{
        // Same neutral card shell as the compaction / permission cards (border
        // + surface + radius + inset highlight) so every in-chat surface reads
        // as one family. The error signal is a single restrained red icon, not
        // a loud red block.
        margin: "8px 0 16px",
        padding: "9px 12px",
        borderRadius: 11,
        background: "var(--chat-input-bg)",
        border: "1px solid var(--c-brd)",
        boxShadow: "inset 0 1px 0 rgba(var(--fg-rgb),0.03)",
        display: "flex",
        alignItems: "flex-start",
        gap: 9,
        overflow: "hidden",
      }}
    >
      <AlertCircle
        size={14}
        aria-hidden
        style={{ color: "var(--c-err)", flexShrink: 0, marginTop: 1.5 }}
      />
      <div
        style={{
          flex: 1,
          minWidth: 0,
          display: "flex",
          flexDirection: "column",
          gap: 2,
        }}
      >
        {title && (
          <span
            style={{
              fontSize: 10,
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: "0.3px",
              color: "var(--c-dim)",
            }}
          >
            {title}
          </span>
        )}
        <span
          style={{
            fontSize: 13,
            color: "var(--c-high)",
            lineHeight: 1.5,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            overflowWrap: "anywhere",
          }}
        >
          {message}
        </span>
      </div>
    </div>
  );
}
