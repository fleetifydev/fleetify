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
        margin: "8px 0 16px",
        padding: "10px 13px",
        borderRadius: 8,
        background: "var(--c-err-bg)",
        border: "1px solid var(--c-err-brd)",
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
              fontSize: 11,
              fontWeight: 600,
              color: "var(--c-err)",
              letterSpacing: "0.03em",
            }}
          >
            {title}
          </span>
        )}
        <span
          style={{
            fontSize: 13,
            color: "var(--c-fg)",
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
