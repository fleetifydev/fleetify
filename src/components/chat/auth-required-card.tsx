import { useState } from "react";
import { ExternalLink, Copy, Check } from "lucide-react";
import type { AuthRequiredBlock } from "@/types/chat";
import { copyText } from "@/lib/clipboard";
import { wsManager } from "@/services/ws-manager";

interface AuthRequiredCardProps {
  block: AuthRequiredBlock;
}

/** Open a URL in the OS default browser. In the Tauri webview a plain
 *  `<a target="_blank">` is swallowed (no new tab, no OS browser), so we
 *  route through the preload `openExternal` bridge — the same path the
 *  backend uses — and only fall back to `window.open` in a plain web
 *  dev view. */
function openExternal(url: string): void {
  const w = window as unknown as {
    electronAPI?: { openExternal?: (u: string) => unknown };
  };
  if (w.electronAPI?.openExternal) {
    void w.electronAPI.openExternal(url);
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

const actionStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  background: "transparent",
  border: "none",
  padding: 0,
  margin: 0,
  cursor: "pointer",
  color: "var(--c-med)",
  fontSize: 12,
  fontWeight: 500,
  fontFamily: "var(--font-sans)",
  textDecoration: "none",
};

/**
 * Borderless, inline sign-in notice — styled to sit in the chat flow
 * like the "thinking" row rather than a boxed card. A bold headline
 * (with a soft pulsing dot while sign-in is in progress) sits on top;
 * a thinner, dimmer info line, an "Open / Copy link" action row, and a
 * code-paste field (for providers whose OAuth hands back an out-of-band
 * code) follow.
 */
export function AuthRequiredCard({ block }: AuthRequiredCardProps) {
  const { provider, url, opened_in_browser: openedInBrowser, session_id: sessionId } = block;
  const providerLabel = provider === "antigravity" ? "Antigravity" : provider;
  // Browser launched → sign-in is actively in progress; phrase it that
  // way ("Signing in…") rather than the passive "sign-in required".
  const headline = openedInBrowser
    ? `Signing in to ${providerLabel}…`
    : `${providerLabel} sign-in required`;
  const linkLabel = openedInBrowser ? "Re-open sign-in" : "Open sign-in";
  // Indent the info + actions under the headline text when the pulsing
  // dot is shown so the block reads as one aligned unit.
  const indent = openedInBrowser ? 14 : 0;

  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    if (await copyText(url)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const submitCode = () => {
    const c = code.trim();
    if (!c || !sessionId || sent) return;
    void wsManager.sendAuthCode(sessionId, c);
    setSent(true);
  };

  const hover = (e: React.MouseEvent<HTMLElement>, on: boolean) => {
    (e.currentTarget as HTMLElement).style.color = on
      ? "var(--c-high)"
      : "var(--c-med)";
  };

  // Sign-in finished (a reply landed) → collapse the whole card to a
  // single success line. No pulsing dot, no link/copy/code-input clutter.
  if (block.signed_in) {
    return (
      <div
        role="status"
        style={{
          margin: "6px 0",
          display: "inline-flex",
          alignItems: "center",
          gap: 7,
          fontFamily: "var(--font-sans)",
          fontSize: 13,
          fontWeight: 600,
          color: "var(--c-high)",
        }}
      >
        <Check size={13} color="rgb(34, 197, 94)" />
        Successfully signed in to {providerLabel}
      </div>
    );
  }

  return (
    <div
      role="status"
      style={{
        margin: "6px 0",
        display: "flex",
        flexDirection: "column",
        gap: 4,
        fontFamily: "var(--font-sans)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {openedInBrowser && (
          <span
            aria-hidden
            style={{
              display: "inline-block",
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: "rgb(251, 191, 36)",
              animation: "thinking-cursor 1.2s ease-in-out infinite",
              flexShrink: 0,
            }}
          />
        )}
        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--c-high)" }}>
          {headline}
        </span>
      </div>

      <div
        style={{
          paddingLeft: indent,
          fontSize: 12,
          fontWeight: 400,
          color: "var(--c-dim)",
          lineHeight: 1.5,
        }}
      >
        {openedInBrowser
          ? "Finish the sign-in in your browser, copy the code it gives you, and paste it below."
          : "Your session expired — sign in, copy the code, and paste it below."}
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 16,
          marginLeft: indent,
        }}
      >
        <a
          href={url}
          onClick={(e) => {
            // The webview won't honour target="_blank"; open via the
            // bridge instead. preventDefault stops the dead in-webview
            // navigation. The href stays for accessibility + right-click.
            e.preventDefault();
            openExternal(url);
          }}
          onMouseEnter={(e) => hover(e, true)}
          onMouseLeave={(e) => hover(e, false)}
          style={actionStyle}
        >
          {linkLabel}
          <ExternalLink size={11} />
        </a>
        <button
          type="button"
          onClick={() => void onCopy()}
          onMouseEnter={(e) => hover(e, true)}
          onMouseLeave={(e) => hover(e, false)}
          style={actionStyle}
        >
          {copied ? <Check size={11} /> : <Copy size={11} />}
          {copied ? "Copied" : "Copy link"}
        </button>
      </div>

      {sessionId &&
        (sent ? (
          <div
            style={{
              marginLeft: indent,
              marginTop: 1,
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              fontSize: 12,
              color: "var(--c-med)",
            }}
          >
            <Check size={12} />
            Code sent — completing sign-in…
          </div>
        ) : (
          <div
            style={{
              marginLeft: indent,
              marginTop: 1,
              display: "flex",
              alignItems: "stretch",
              maxWidth: 420,
              background: "var(--c-srf2)",
              border: "1px solid var(--c-brd)",
              borderRadius: 6,
              overflow: "hidden",
            }}
          >
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  submitCode();
                }
              }}
              placeholder="Paste the code from the browser"
              spellCheck={false}
              autoComplete="off"
              style={{
                flex: 1,
                minWidth: 0,
                padding: "6px 9px",
                background: "transparent",
                border: "none",
                color: "var(--c-high)",
                fontFamily: "var(--font-mono)",
                fontSize: 11.5,
                outline: "none",
              }}
            />
            <button
              type="button"
              onClick={submitCode}
              disabled={!code.trim()}
              style={{
                padding: "0 12px",
                fontSize: 11.5,
                fontWeight: 600,
                fontFamily: "var(--font-sans)",
                color: code.trim() ? "var(--card, #0a0a0a)" : "var(--c-dim)",
                background: code.trim() ? "var(--c-high)" : "transparent",
                border: "none",
                borderLeft: "1px solid var(--c-brd)",
                cursor: code.trim() ? "pointer" : "default",
                outline: "none",
                flexShrink: 0,
                transition: "background 0.12s, color 0.12s",
              }}
            >
              Submit
            </button>
          </div>
        ))}
    </div>
  );
}
