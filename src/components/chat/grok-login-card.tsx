/**
 * GrokLoginCard — in-chat recovery for the "not signed in" case.
 *
 * Pushed (as a `grok_login` content block) when a CLI agent's `session/new`
 * fails with `-32000 Authentication required` (today: Grok Build). On mount it
 * spawns `<bin> login` in a PTY via `providersApi.startAgentLogin`, parses the
 * device-OAuth flow's output (sign-in URL + device code + "Signed in as …")
 * from the streamed `pty:data`, and renders a clean card — NOT a raw terminal:
 * a clickable URL, a copyable code, and a "Waiting for authorization…" state.
 * On `pty:exit` code 0 it flips to a calm success line and asks the ws-manager
 * to resume the user's original prompt. Non-zero exit / spawn failure → an
 * error state with Retry.
 */
import { useEffect, useRef, useState } from "react";
import { ExternalLink, Copy, Check, AlertCircle, RotateCw } from "lucide-react";
import type { GrokLoginBlock } from "@/types/chat";
import { copyText } from "@/lib/clipboard";
import { providers as providersApi } from "@/lib/providers-api";
import { wsManager } from "@/services/ws-manager";
import { ProviderLogo } from "@/components/ui/provider-logo";

interface Props {
  block: GrokLoginBlock;
}

/** Open a URL in the OS default browser (the Tauri webview swallows
 *  `target="_blank"`), matching AuthRequiredCard's bridge path. */
function openExternal(url: string): void {
  const w = window as unknown as { electronAPI?: { openExternal?: (u: string) => unknown } };
  if (w.electronAPI?.openExternal) void w.electronAPI.openExternal(url);
  else window.open(url, "_blank", "noopener,noreferrer");
}

function providerLabel(provider: string): string {
  return provider.startsWith("grok") ? "Grok Build" : provider;
}

// Strip ANSI/terminal escape sequences (CSI, OSC, single-char escapes) so a
// regex isn't broken by cursor-positioning codes. The piped login output is
// already clean; this is defense-in-depth (e.g. if a ConPTY ever feeds in).
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07\x1B]*(?:\x07|\x1B\\))/g;

// Device-flow parsers, run over the (ANSI-stripped) accumulated buffer so a
// regex never misses a match split across two reads.
const URL_RE = /(https?:\/\/\S*oauth2\/device\S*)/i;
const CODE_IN_URL_RE = /user_code=([A-Za-z0-9-]+)/i;
const CODE_LINE_RE = /\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/;
const SIGNED_IN_RE = /signed in as\s+(\S+)/i;

type Phase = "starting" | "waiting" | "success" | "error";

export function GrokLoginCard({ block }: Props) {
  const { provider, session_id: sessionId } = block;
  const label = providerLabel(provider);

  const [phase, setPhase] = useState<Phase>("starting");
  const [url, setUrl] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // Bumping this re-runs the login effect (Retry).
  const [attempt, setAttempt] = useState(0);

  // Refs the async/interval callbacks read without re-subscribing.
  const bufferRef = useRef("");
  const resumedRef = useRef(false);
  const openedRef = useRef(false);

  useEffect(() => {
    const api = window.electronAPI;
    let ptyId: string | null = null;
    let unsubExit: (() => void) | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let cancelled = false;
    let exited = false;

    // Reset per-attempt refs (state is reset by the Retry handler before it
    // bumps `attempt`, so we don't setState in the effect body).
    bufferRef.current = "";
    resumedRef.current = false;
    openedRef.current = false;

    // Parse the FULL accumulated output (idempotent). We read the whole buffer
    // each poll rather than incremental chunks, so timing never matters — the
    // device URL/code are extracted whenever they first appear.
    const ingest = (raw: string) => {
      if (!raw || raw.length < bufferRef.current.length) return;
      bufferRef.current = raw;
      // Replace escapes with a space (not ""): a ConPTY encodes line breaks as
      // cursor-move escapes, so deleting them would glue the URL to the next
      // word and over-match. The piped output is already clean (no escapes).
      const text = raw.replace(ANSI_RE, " ");
      const u = text.match(URL_RE);
      if (u) {
        // Trim trailing punctuation a terminal might wrap the URL with.
        const clean = u[1]!.replace(/[)\].,'"]+$/, "");
        setUrl(clean);
        // Open the sign-in page for the user — `grok login` opens it itself in
        // a real terminal, but not reliably under our PTY. Once only.
        if (!openedRef.current) {
          openedRef.current = true;
          openExternal(clean);
        }
      }
      const parsedCode = text.match(CODE_IN_URL_RE)?.[1] ?? text.match(CODE_LINE_RE)?.[1] ?? null;
      if (parsedCode) setCode(parsedCode);
      const signed = text.match(SIGNED_IN_RE);
      if (signed) setEmail(signed[1]!.replace(/[.,]+$/, ""));
      if (u || parsedCode) setPhase((p) => (p === "starting" ? "waiting" : p));
    };

    void (async () => {
      const res = await providersApi.startAgentLogin(provider);
      if (cancelled) return;
      if (!res.ok || !res.pty_id) {
        setErrorMsg(res.ok ? "Could not start the login process." : res.error ?? "Login failed to start.");
        setPhase("error");
        return;
      }
      ptyId = res.pty_id;
      if (!api) {
        setErrorMsg("Login is only available in the desktop app.");
        setPhase("error");
        return;
      }
      // Completion: the login process exits only after the user authorises (or
      // it errors), seconds later — long after this listener is registered, so
      // it's not subject to the early-output race the buffer poll handles.
      unsubExit = api.onPtyExit(ptyId, ({ exitCode }) => {
        exited = true;
        if (pollTimer) clearInterval(pollTimer);
        if (cancelled) return;
        if (exitCode === 0) {
          setPhase("success");
          if (!resumedRef.current) {
            resumedRef.current = true;
            void wsManager.resumeAfterLogin(sessionId);
          }
        } else {
          setErrorMsg(`Sign-in exited with code ${exitCode}.`);
          setPhase("error");
        }
      });

      // Poll the backend's PTY buffer for the full output. This is race-proof:
      // `grok login` prints the device URL within milliseconds — before an
      // async `pty:data` listener finishes registering — so live events would
      // be dropped. The buffer holds everything from t=0.
      const pollOnce = async () => {
        const r = await api.ptyBuffer?.(ptyId!);
        if (!cancelled && r?.ok && r.data) ingest(r.data);
      };
      void pollOnce();
      pollTimer = setInterval(() => void pollOnce(), 400);
    })();

    return () => {
      cancelled = true;
      if (pollTimer) clearInterval(pollTimer);
      unsubExit?.();
      // Kill the login PTY if it's still running when the card unmounts
      // (e.g. user navigated away mid sign-in) — never after a clean exit.
      if (ptyId && !exited) window.electronAPI?.ptyKill(ptyId);
    };
  }, [provider, sessionId, attempt]);

  const onCopy = async () => {
    if (code && (await copyText(code))) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  // Retry: reset visible state, then bump `attempt` to re-run the login effect.
  const onRetry = () => {
    setUrl(null);
    setCode(null);
    setEmail(null);
    setErrorMsg(null);
    setPhase("starting");
    setAttempt((a) => a + 1);
  };

  // ── Success: collapse to a single calm line (non-green per app aesthetic) ──
  if (phase === "success") {
    return (
      <div role="status" style={successWrap}>
        <Check size={13} style={{ color: "var(--c-low)", flexShrink: 0 }} />
        <span>
          Signed in to {label}
          {email ? ` as ${email}` : ""} — resuming your message…
        </span>
      </div>
    );
  }

  return (
    <div role="status" style={cardWrap}>
      <div style={headerRow}>
        <ProviderLogo tool={provider} size={15} />
        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--c-high)" }}>
          {phase === "error" ? `Couldn’t sign in to ${label}` : `Signing in to ${label}…`}
        </span>
      </div>

      {phase === "error" ? (
        <>
          <div style={errorRow}>
            <AlertCircle size={12} style={{ flexShrink: 0, marginTop: 1 }} />
            <span>{errorMsg ?? "The login process failed."}</span>
          </div>
          <button type="button" onClick={onRetry} style={retryBtn}>
            <RotateCw size={11} />
            Try again
          </button>
        </>
      ) : (
        <>
          <div style={waitingRow}>
            <span aria-hidden style={pulseDot} />
            Waiting for authorization…
          </div>

          {url ? (
            <div style={fieldGroup}>
              <span style={fieldLabel}>Open this URL to sign in:</span>
              <a
                href={url}
                onClick={(e) => {
                  e.preventDefault();
                  openExternal(url);
                }}
                style={actionLink}
              >
                {url.replace(/^https?:\/\//, "").slice(0, 44)}
                {url.replace(/^https?:\/\//, "").length > 44 ? "…" : ""}
                <ExternalLink size={11} style={{ flexShrink: 0 }} />
              </a>
            </div>
          ) : (
            <div style={fieldLabel}>Starting sign-in…</div>
          )}

          {code && (
            <div style={fieldGroup}>
              <span style={fieldLabel}>Confirm this code in your browser:</span>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <code style={codeChip}>{code}</code>
                <button type="button" onClick={() => void onCopy()} style={copyBtn}>
                  {copied ? <Check size={11} /> : <Copy size={11} />}
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
            </div>
          )}

          <div style={hintLine}>Opened in your browser — finish signing in there.</div>
        </>
      )}
    </div>
  );
}

const cardWrap: React.CSSProperties = {
  margin: "6px 0",
  display: "flex",
  flexDirection: "column",
  gap: 8,
  maxWidth: 460,
  padding: "11px 13px",
  borderRadius: 10,
  border: "1px solid var(--c-brd)",
  background: "var(--c-srf)",
  fontFamily: "var(--font-sans)",
};
const successWrap: React.CSSProperties = {
  margin: "6px 0",
  display: "inline-flex",
  alignItems: "center",
  gap: 7,
  fontFamily: "var(--font-sans)",
  fontSize: 13,
  fontWeight: 500,
  color: "var(--c-low)",
};
const headerRow: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8 };
const waitingRow: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 8,
  fontSize: 12.5,
  color: "var(--c-med)",
};
const pulseDot: React.CSSProperties = {
  display: "inline-block",
  width: 6,
  height: 6,
  borderRadius: "50%",
  background: "var(--c-med)",
  animation: "thinking-cursor 1.2s ease-in-out infinite",
  flexShrink: 0,
};
const fieldGroup: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 3 };
const fieldLabel: React.CSSProperties = { fontSize: 11.5, color: "var(--c-dim)" };
const actionLink: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  color: "var(--c-med)",
  fontSize: 12,
  fontFamily: "var(--font-mono)",
  textDecoration: "none",
  cursor: "pointer",
  width: "fit-content",
};
const codeChip: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 14,
  fontWeight: 600,
  letterSpacing: "0.08em",
  color: "var(--c-high)",
  background: "var(--c-srf2)",
  border: "1px solid var(--c-brd)",
  borderRadius: 6,
  padding: "3px 9px",
};
const copyBtn: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  background: "transparent",
  border: "none",
  padding: 0,
  cursor: "pointer",
  color: "var(--c-med)",
  fontSize: 12,
  fontWeight: 500,
  fontFamily: "var(--font-sans)",
};
const hintLine: React.CSSProperties = { fontSize: 11.5, color: "var(--c-dim)", lineHeight: 1.5 };
const errorRow: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 6,
  fontSize: 12,
  color: "var(--c-dim)",
  lineHeight: 1.5,
};
const retryBtn: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  width: "fit-content",
  background: "transparent",
  border: "1px solid var(--c-brd)",
  borderRadius: 6,
  padding: "4px 10px",
  cursor: "pointer",
  color: "var(--c-med)",
  fontSize: 12,
  fontWeight: 500,
  fontFamily: "var(--font-sans)",
};
