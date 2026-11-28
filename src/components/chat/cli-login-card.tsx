/**
 * CliLoginCard — signs a session's CLI agent in when its turn stopped because
 * it isn't signed in (a `cli_login` block, pushed on the backend's
 * `login_required` event), then re-sends the user's prompt.
 *
 * How depends on the agent (`login_kind`, from the backend catalog):
 *  - browser: the agent's own login (`claude auth login`, `codex login`,
 *    `grok login --device-auth`, …) runs without a terminal. The agent opens
 *    the browser itself; the card shows the sign-in URL in case it didn't, a
 *    device code to confirm, and a field for a code the browser hands back
 *    (Claude Code's paste fallback, written to the process's stdin).
 *  - terminal: an interactive login (`hermes model`, `opencode auth login`,
 *    the `agy` TUI) runs in a terminal inside the card.
 *  - api_key: the Antigravity SDK takes a Gemini API key.
 *
 * Starts on its own — the user asked the agent something and it needs a
 * sign-in first. The login process outlives a remount: the block records its
 * id, and a remounted card re-attaches instead of starting another. After the
 * process exits cleanly the card re-checks the agent (`/api/agents/scan`)
 * before resuming, so a cancelled browser flow doesn't resend into the same
 * error.
 */
import { useEffect, useRef, useState } from "react";
import { AlertCircle, Check, Copy, ExternalLink, KeyRound, RotateCw } from "lucide-react";
import type { CliLoginBlock } from "@/types/chat";
import { copyText } from "@/lib/clipboard";
import { openExternalUrl } from "@/lib/links";
import { parseLoginOutput, type LoginOutput } from "@/lib/cli-login-output";
import { providers as providersApi } from "@/lib/providers-api";
import { wsManager } from "@/services/ws-manager";
import { updateCliLogin } from "@/stores/chat-store";
import { useAgentScanStore } from "@/stores/agent-scan-store";
import { ProviderLogo } from "@/components/ui/provider-logo";
import { AccountLoginTerminal } from "@/components/settings/shared/account-login-terminal";

const AI_STUDIO_KEY_URL = "https://aistudio.google.com/apikey";

/** Catalog display names, for when the scan hasn't loaded. */
const AGENT_NAMES: Record<string, string> = {
  "claude-code": "Claude Code",
  "codex-cli": "Codex CLI",
  "kimi-code": "Kimi Code",
  opencode: "OpenCode",
  "github-copilot": "GitHub Copilot CLI",
  "cursor-cli": "Cursor CLI",
  "grok-build": "Grok Build",
  "hermes-agent": "Hermes Agent",
  "antigravity-cli": "Antigravity CLI",
  "antigravity-sdk": "Antigravity SDK",
};

/** How each agent signs in, for a block from before `login_kind` existed. */
const FALLBACK_KIND: Record<string, NonNullable<CliLoginBlock["login_kind"]>> = {
  opencode: "terminal",
  "hermes-agent": "terminal",
  "antigravity-cli": "terminal",
  "antigravity-sdk": "api_key",
};

/** A login left running (the user walked away) is stopped after this. */
const LOGIN_LIFETIME_MS = 15 * 60 * 1000;

// Module state: survives remounts, so a re-rendered card neither starts a
// second login (React StrictMode mounts twice) nor loses an exit it missed.
const startedLogins = new Set<string>();
const loginExits = new Map<string, number>();

type Phase =
  | "starting"
  | "waiting"
  | "checking"
  | "not_signed_in"
  | "error"
  | "success";

interface Props {
  block: CliLoginBlock;
  /** The transcript message holding the block: one login per card. */
  messageId: string;
}

export function CliLoginCard({ block, messageId }: Props) {
  const {
    provider,
    session_id: sessionId,
    account_id: accountId,
    pty_id: ptyId,
    error: startError,
  } = block;
  const kind = block.login_kind ?? FALLBACK_KIND[provider] ?? "browser";
  const scanName = useAgentScanStore((s) => s.scan[provider]?.display_name);
  const name = scanName || AGENT_NAMES[provider] || provider;

  const [phase, setPhase] = useState<Phase>(block.signed_in ? "success" : "starting");
  const [output, setOutput] = useState<LoginOutput | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [resumed, setResumed] = useState<boolean | null>(null);
  const [copied, setCopied] = useState(false);
  const [pasted, setPasted] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [keyInput, setKeyInput] = useState("");
  const [savingKey, setSavingKey] = useState(false);
  const finishing = useRef(false);
  // The user stopped this login: its exit is not a failure to report.
  const cancelledPty = useRef<string | null>(null);

  // ── Finishing: re-check the agent, then resume the prompt ───────────────
  const finish = async (exitCode: number | null) => {
    if (finishing.current) return;
    finishing.current = true;
    if (exitCode !== null && exitCode !== 0) {
      setErrorMsg(`The sign-in exited with code ${exitCode}.`);
      setPhase("error");
      finishing.current = false;
      return;
    }
    setPhase("checking");
    const scan = await useAgentScanStore.getState().refresh(true);
    const row = scan[provider];
    // The scan checks the System account; a saved account's login can't be
    // verified from here, so trust a clean exit for it.
    const signedIn = accountId ? true : row ? row.authenticated : exitCode === 0;
    if (!signedIn) {
      setPhase("not_signed_in");
      finishing.current = false;
      return;
    }
    updateCliLogin(sessionId, provider, { signed_in: true });
    setPhase("success");
    setResumed(await wsManager.resumeAfterLogin(sessionId));
  };

  // ── Starting the login ──────────────────────────────────────────────────
  // The outcome goes into the block (not this instance's state), so a card
  // that remounted while the login was starting still sees it.
  const start = async () => {
    setErrorMsg(null);
    setOutput(null);
    setCodeSent(false);
    setPasted("");
    setPhase("starting");
    updateCliLogin(sessionId, provider, { pty_id: undefined, error: undefined });
    const res =
      kind === "terminal"
        ? await providersApi.openAccountLogin(provider, accountId ?? "system")
        : await providersApi.startAgentLogin(provider, accountId ?? null);
    if (!res.ok || !res.pty_id) {
      const message = (!res.ok && res.error) || "The sign-in couldn't start.";
      updateCliLogin(sessionId, provider, { error: message });
      return;
    }
    const id = res.pty_id;
    // Don't leave a login waiting forever if the user walks away.
    setTimeout(() => {
      if (!loginExits.has(id)) window.electronAPI?.ptyKill(id);
    }, LOGIN_LIFETIME_MS);
    updateCliLogin(sessionId, provider, { pty_id: id });
  };

  // Start once per card (API keys wait for the user instead). Deferred a
  // tick: starting updates the card, which an effect body shouldn't do.
  useEffect(() => {
    if (block.signed_in || ptyId || startError || kind === "api_key") return;
    if (startedLogins.has(messageId)) return;
    startedLogins.add(messageId);
    void Promise.resolve().then(start);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messageId]);

  // ── Following a browser login: its output and its exit ──────────────────
  useEffect(() => {
    if (!ptyId || kind !== "browser" || block.signed_in) return;
    const api = window.electronAPI;
    if (!api) return;
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    finishing.current = false;

    // It already exited while this card was away: settle from that.
    const known = loginExits.get(ptyId);
    if (known !== undefined) {
      void Promise.resolve().then(() => finish(known));
      return;
    }
    const unsubExit = api.onPtyExit(ptyId, ({ exitCode }) => {
      loginExits.set(ptyId, exitCode);
      if (timer) clearInterval(timer);
      if (!cancelled && cancelledPty.current !== ptyId) void finish(exitCode);
    });
    // Poll the buffered output: the URL is printed before any listener could
    // register, and the buffer holds everything from the start.
    const poll = async () => {
      const r = await api.ptyBuffer?.(ptyId).catch(() => null);
      if (cancelled) return;
      if (r?.ok) {
        setOutput(parseLoginOutput(r.data));
      } else if (r && !r.ok && !loginExits.has(ptyId)) {
        // The process is gone and its exit was missed (the card was
        // unmounted): find out from the agent itself.
        if (timer) clearInterval(timer);
        void finish(null);
      }
    };
    void poll();
    timer = setInterval(() => void poll(), 400);
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      unsubExit?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ptyId, kind]);

  const cancel = () => {
    if (ptyId) {
      cancelledPty.current = ptyId;
      loginExits.set(ptyId, -1);
      window.electronAPI?.ptyKill(ptyId);
    }
    setErrorMsg("Sign-in cancelled.");
    setPhase("error");
  };

  const retry = () => {
    if (ptyId && !loginExits.has(ptyId)) window.electronAPI?.ptyKill(ptyId);
    finishing.current = false;
    void start();
  };

  const sendCode = async () => {
    const code = pasted.trim();
    if (!code || !ptyId) return;
    await window.electronAPI?.ptyWrite(ptyId, `${code}\n`);
    setCodeSent(true);
  };

  const saveKey = async () => {
    const key = keyInput.trim();
    if (!key) return;
    setSavingKey(true);
    setErrorMsg(null);
    const res = await providersApi.setKey(provider, key);
    setSavingKey(false);
    if (!res.ok) {
      setErrorMsg(res.error || "Couldn't save the key.");
      return;
    }
    setKeyInput("");
    void finish(0);
  };

  const onCopy = async () => {
    if (output?.code && (await copyText(output.code))) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  // ── Rendering ───────────────────────────────────────────────────────────
  if (phase === "success" || block.signed_in) {
    return (
      <div role="status" style={successWrap}>
        <Check size={13} style={{ color: "var(--c-low)", flexShrink: 0 }} />
        <span>
          Signed in to {name}
          {output?.signedInAs ? ` as ${output.signedInAs}` : ""}
          {resumed === false ? ". Send your message again." : " — resuming your message…"}
        </span>
      </div>
    );
  }

  // A login that couldn't start is an error, whichever instance started it;
  // one that's running is waiting on the user.
  const shown: Phase =
    phase !== "starting" ? phase : startError ? "error" : ptyId ? "waiting" : "starting";
  const shownError = errorMsg ?? startError ?? null;
  const title =
    kind === "api_key"
      ? `${name} needs a Gemini API key`
      : shown === "error"
        ? `Couldn’t sign in to ${name}`
        : `Sign in to ${name}`;

  return (
    <div role="status" style={cardWrap}>
      <div style={headerRow}>
        <ProviderLogo tool={provider} size={15} />
        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--c-high)" }}>{title}</span>
      </div>
      {block.detail && kind !== "api_key" && shown !== "error" && (
        <div style={detailLine}>
          {name} said: “{agentWords(block.detail)}”
        </div>
      )}

      {kind === "api_key" ? (
        <>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              type="password"
              autoComplete="off"
              aria-label="Gemini API key"
              placeholder="AIza…"
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void saveKey();
              }}
              style={textInput}
            />
            <button
              type="button"
              onClick={() => void saveKey()}
              disabled={savingKey || !keyInput.trim()}
              style={{ ...primaryBtn, opacity: savingKey || !keyInput.trim() ? 0.55 : 1 }}
            >
              <KeyRound size={11} /> Save and continue
            </button>
          </div>
          <a
            href={AI_STUDIO_KEY_URL}
            onClick={(e) => {
              e.preventDefault();
              openExternalUrl(AI_STUDIO_KEY_URL);
            }}
            style={actionLink}
          >
            Get a key from Google AI Studio <ExternalLink size={11} />
          </a>
          {shownError && <ErrorRow message={shownError} />}
          {shown === "not_signed_in" && (
            <ErrorRow message={`The key was saved, but ${name} still has no key. Try again.`} />
          )}
        </>
      ) : shown === "error" ? (
        <>
          <ErrorRow message={shownError ?? "The sign-in failed."} />
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" onClick={retry} style={ghostBtn}>
              <RotateCw size={11} /> Try again
            </button>
          </div>
          <div style={hintLine}>You can also sign in from Settings → Providers.</div>
        </>
      ) : shown === "not_signed_in" ? (
        <>
          <ErrorRow message={`The sign-in finished, but ${name} still isn’t signed in.`} />
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" onClick={retry} style={ghostBtn}>
              <RotateCw size={11} /> Try again
            </button>
            <button type="button" onClick={() => void finish(0)} style={ghostBtn}>
              Check again
            </button>
          </div>
        </>
      ) : kind === "terminal" ? (
        <>
          <div style={hintLine}>Finish signing in below.</div>
          {ptyId && (
            <div style={terminalBox}>
              <AccountLoginTerminal
                ptyId={ptyId}
                keepAlive
                onExit={(code) => {
                  loginExits.set(ptyId, code);
                  if (cancelledPty.current !== ptyId) void finish(code);
                }}
              />
            </div>
          )}
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" onClick={() => void finish(0)} style={ghostBtn}>
              I’ve signed in — check again
            </button>
            <button type="button" onClick={cancel} style={ghostBtn}>
              Cancel
            </button>
          </div>
        </>
      ) : (
        <>
          <div style={waitingRow}>
            <span aria-hidden style={pulseDot} />
            {shown === "checking"
              ? "Checking the sign-in…"
              : shown === "starting"
                ? "Starting sign-in…"
                : "Waiting for you to finish signing in in your browser…"}
          </div>

          {output?.url && (
            <div style={fieldGroup}>
              <span style={fieldLabel}>If your browser didn’t open, open this page:</span>
              <a
                href={output.url}
                onClick={(e) => {
                  e.preventDefault();
                  openExternalUrl(output.url!);
                }}
                style={actionLink}
              >
                {output.url.replace(/^https?:\/\//, "").slice(0, 44)}
                {output.url.replace(/^https?:\/\//, "").length > 44 ? "…" : ""}
                <ExternalLink size={11} style={{ flexShrink: 0 }} />
              </a>
            </div>
          )}

          {output?.code && (
            <div style={fieldGroup}>
              <span style={fieldLabel}>Confirm this code in your browser:</span>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <code style={codeChip}>{output.code}</code>
                <button type="button" onClick={() => void onCopy()} style={copyBtn}>
                  {copied ? <Check size={11} /> : <Copy size={11} />}
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
            </div>
          )}

          {output?.asksForCode && (
            <div style={fieldGroup}>
              <span style={fieldLabel}>
                {codeSent
                  ? "Code sent — finishing…"
                  : "If the page shows a code, paste it here:"}
              </span>
              {!codeSent && (
                <div style={{ display: "flex", gap: 8 }}>
                  <input
                    aria-label="Sign-in code"
                    value={pasted}
                    onChange={(e) => setPasted(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void sendCode();
                    }}
                    style={textInput}
                  />
                  <button
                    type="button"
                    onClick={() => void sendCode()}
                    disabled={!pasted.trim()}
                    style={{ ...ghostBtn, opacity: pasted.trim() ? 1 : 0.55 }}
                  >
                    Submit
                  </button>
                </div>
              )}
            </div>
          )}

          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" onClick={cancel} style={ghostBtn}>
              Cancel
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/** What the agent said, without the plumbing Fleetify wraps around an ACP
 *  error ("session/new failed: ACP error -32000: Authentication required —
 *  …" reads "Authentication required — …"). */
function agentWords(detail: string): string {
  return detail
    .replace(/^(?:[\w/ -]+ failed: )+/i, "")
    .replace(/^ACP error -?\d+: /i, "")
    .trim();
}

function ErrorRow({ message }: { message: string }) {
  return (
    <div style={errorRow} role="alert">
      <AlertCircle size={12} style={{ flexShrink: 0, marginTop: 1 }} />
      <span>{message}</span>
    </div>
  );
}

const cardWrap: React.CSSProperties = {
  margin: "6px 0",
  display: "flex",
  flexDirection: "column",
  gap: 8,
  maxWidth: 520,
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
const detailLine: React.CSSProperties = { fontSize: 11.5, color: "var(--c-dim)", lineHeight: 1.5 };
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
const ghostBtn: React.CSSProperties = {
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
const primaryBtn: React.CSSProperties = {
  ...ghostBtn,
  background: "var(--c-high)",
  color: "var(--card)",
  border: "none",
  fontWeight: 600,
};
const textInput: React.CSSProperties = {
  flex: 1,
  padding: "6px 9px",
  borderRadius: 6,
  background: "var(--card)",
  border: "1px solid var(--c-brd)",
  color: "var(--c-high)",
  fontFamily: "var(--font-mono)",
  fontSize: 12,
  outline: "none",
};
const terminalBox: React.CSSProperties = {
  height: 260,
  borderRadius: 8,
  overflow: "hidden",
  border: "1px solid var(--c-brd)",
};
