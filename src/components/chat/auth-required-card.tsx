import { ExternalLink } from "lucide-react";
import type { AuthRequiredBlock } from "@/types/chat";

interface AuthRequiredCardProps {
  block: AuthRequiredBlock;
}

export function AuthRequiredCard({ block }: AuthRequiredCardProps) {
  const { provider, url, opened_in_browser: openedInBrowser } = block;
  const headline =
    provider === "antigravity"
      ? "Antigravity sign-in required"
      : `${provider} sign-in required`;
  const linkLabel = openedInBrowser ? "Re-open sign-in" : "Open sign-in";

  return (
    <div
      role="status"
      style={{
        margin: "8px 0",
        padding: "10px 12px",
        border: "1px solid rgba(251, 191, 36, 0.40)",
        background: "rgba(251, 191, 36, 0.08)",
        borderRadius: 9,
        display: "flex", flexDirection: "column", gap: 8,
        fontSize: 12.5, color: "var(--c-high)",
      }}
    >
      <div style={{ fontWeight: 600 }}>{headline}</div>
      <div style={{ color: "var(--c-low)" }}>
        Your session expired.
        {openedInBrowser
          ? " We opened your browser — finish sign-in and re-send your message."
          : " Click below to sign in, then re-send your message."}
        {" Codes can't be pasted here; finish the OAuth flow in your browser."}
      </div>
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        style={{
          alignSelf: "flex-start",
          display: "inline-flex", alignItems: "center", gap: 6,
          padding: "6px 10px", borderRadius: 6,
          border: "1px solid var(--c-brd)",
          background: openedInBrowser ? "transparent" : "var(--c-srf)",
          color: "var(--c-high)", fontSize: 12, textDecoration: "none",
          fontWeight: openedInBrowser ? 400 : 500,
        }}
      >
        {linkLabel}
        <ExternalLink size={11} />
      </a>
    </div>
  );
}
