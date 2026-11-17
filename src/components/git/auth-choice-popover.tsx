/**
 * AuthChoicePopover — compact "Connect with GitHub / Use GitHub CLI"
 * picker that pops above the Create PR button when neither auth method
 * is live. Click-outside (anywhere on the page) or Esc dismisses.
 *
 * Behaviour:
 *   • Connect with GitHub → resolves "oauth" immediately; the parent
 *     (executeCreatePR) drives the OAuth round-trip from there.
 *   • Use GitHub CLI → if `gh` is already authed, resolves "cli"
 *     immediately. If not, drives `ghAuthLoginCapture` inline: the
 *     popover stays open, surfaces the one-time device code, and
 *     resolves "cli" once gh reports a successful login.
 *   • Disabled "Use GitHub CLI" when gh isn't installed (badge says
 *     "Not Installed").
 *
 * Positioning: the caller renders this inside a `position: relative`
 * container (typically the Create PR split-button wrapper). The popover
 * floats above it (`bottom: calc(100% + 6px)`).
 */

import { useEffect, useRef, useState } from "react";
import { Github, Terminal, Loader2, ExternalLink, X } from "lucide-react";

export type AuthChoiceMethod = "oauth" | "cli";

interface Props {
  /** Resolves with the picked method + (for CLI) the resolved gh login,
   *  or dismisses via `onDismiss` if the user clicks outside / hits Esc
   *  before choosing. */
  onChoose: (method: AuthChoiceMethod, username?: string) => void;
  onDismiss: () => void;
}

type CliState =
  | { kind: "probing" }
  | { kind: "missing" }
  | { kind: "needs-auth" }
  | { kind: "ready"; login: string };

export function AuthChoicePopover({ onChoose, onDismiss }: Props) {
  const [cliState, setCliState] = useState<CliState>({ kind: "probing" });
  const [pending, setPending] = useState<AuthChoiceMethod | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deviceCode, setDeviceCode] = useState<string | null>(null);
  const [verifyUrl, setVerifyUrl] = useState<string | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const ghEventUnsubRef = useRef<(() => void) | null>(null);
  const cancelledRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await window.electronAPI?.hasGhCli?.();
        if (cancelled) return;
        if (!r || !r.ok) {
          setCliState({ kind: "missing" });
        } else if (r.authed && r.ghLogin) {
          setCliState({ kind: "ready", login: r.ghLogin });
        } else {
          setCliState({ kind: "needs-auth" });
        }
      } catch {
        if (!cancelled) setCliState({ kind: "missing" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Click-outside (anywhere on the page) + Esc — both close the popover
  // UNLESS a CLI auth round-trip is in flight, since dismissing mid-flow
  // would leave a half-completed gh process hanging.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (pending === "cli") return;
      if (!wrapperRef.current) return;
      if (wrapperRef.current.contains(e.target as Node)) return;
      onDismiss();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (pending === "cli") return;
      // Claim the key so the chat's Escape-to-stop leaves the stream
      // running. This document listener always runs before that window one.
      e.preventDefault();
      onDismiss();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onDismiss, pending]);

  // Tear the gh-auth listener down on unmount so a half-finished flow
  // can't fire callbacks into a dead component.
  useEffect(() => {
    return () => {
      cancelledRef.current = true;
      try { ghEventUnsubRef.current?.(); } catch { /* idempotent */ }
      ghEventUnsubRef.current = null;
    };
  }, []);

  const pickOAuth = () => {
    if (pending) return;
    onChoose("oauth");
  };

  const pickGhCli = async () => {
    if (pending) return;
    setError(null);
    if (cliState.kind === "ready") {
      onChoose("cli", cliState.login);
      return;
    }
    if (cliState.kind !== "needs-auth") return;

    setPending("cli");
    setDeviceCode(null);
    setVerifyUrl(null);
    cancelledRef.current = false;

    try { ghEventUnsubRef.current?.(); } catch { /* idempotent */ }
    ghEventUnsubRef.current = window.electronAPI?.onGhAuthEvent?.((ev) => {
      if (cancelledRef.current) return;
      if (ev.phase === "code") {
        setDeviceCode(ev.code);
      } else if (ev.phase === "url") {
        setVerifyUrl(ev.url);
        try { window.electronAPI?.openExternal?.(ev.url); } catch { /* best effort */ }
      } else if (ev.phase === "done") {
        if (ev.ok && ev.login) {
          setCliState({ kind: "ready", login: ev.login });
          setPending(null);
          try { ghEventUnsubRef.current?.(); } catch { /* idempotent */ }
          ghEventUnsubRef.current = null;
          onChoose("cli", ev.login);
        } else if (!ev.ok) {
          setError(ev.error || "gh auth didn't complete.");
          setPending(null);
        }
      }
    }) || null;

    try {
      const r = await window.electronAPI?.ghAuthLoginCapture?.();
      if (r && !r.ok && !cancelledRef.current) {
        setError(r.error || "Couldn't run gh auth login.");
        setPending(null);
      }
    } catch (e) {
      if (!cancelledRef.current) {
        setError(e instanceof Error ? e.message : "Couldn't start gh auth.");
        setPending(null);
      }
    } finally {
      try { ghEventUnsubRef.current?.(); } catch { /* idempotent */ }
      ghEventUnsubRef.current = null;
    }
  };

  const cancelGhCli = async () => {
    cancelledRef.current = true;
    try { await window.electronAPI?.ghAuthLoginCancel?.(); } catch { /* best effort */ }
    try { ghEventUnsubRef.current?.(); } catch { /* idempotent */ }
    ghEventUnsubRef.current = null;
    setPending(null);
    setDeviceCode(null);
    setVerifyUrl(null);
  };

  const cliDisabled =
    cliState.kind === "probing" ||
    cliState.kind === "missing" ||
    pending === "oauth";
  const cliTitle =
    cliState.kind === "ready" && cliState.login
      ? `Use GitHub CLI · @${cliState.login}`
      : "Use GitHub CLI";
  const cliBadge = cliState.kind === "missing" ? "Not Installed" : undefined;

  return (
    <div
      ref={wrapperRef}
      role="dialog"
      aria-modal="false"
      style={{
        position: "absolute",
        bottom: "calc(100% + 8px)",
        right: 0,
        minWidth: 320,
        maxWidth: 380,
        background: "var(--popover, #161616)",
        border: "1px solid var(--c-brd, rgba(255,255,255,0.10))",
        borderRadius: 10,
        boxShadow: "0 -16px 40px rgba(0,0,0,0.50)",
        zIndex: 60,
        overflow: "hidden",
        animation: "fleet-popover-up 0.14s ease-out both",
      }}
    >
      <div style={{
        padding: "10px 12px 8px",
        display: "flex",
        alignItems: "center",
        gap: 8,
        borderBottom: "1px solid rgba(255,255,255,0.06)",
      }}>
        <Github size={13} style={{ color: "var(--c-fg)" }} />
        <div style={{ flex: 1, fontSize: 12.5, fontWeight: 600, color: "var(--c-fg)" }}>
          Connect GitHub to open a PR
        </div>
        {pending !== "cli" && (
          <button
            onClick={onDismiss}
            title="Close"
            style={{
              width: 22, height: 22, borderRadius: 5,
              display: "inline-flex", alignItems: "center", justifyContent: "center",
              background: "transparent", border: "none",
              color: "var(--c-dim)", cursor: "pointer",
            }}
          >
            <X size={12} />
          </button>
        )}
      </div>

      <div style={{ padding: 10, display: "flex", flexDirection: "column", gap: 6 }}>
        <ChoiceRow
          icon={<Github size={13} />}
          title="Connect with GitHub"
          onClick={pickOAuth}
          loading={pending === "oauth"}
          disabled={pending === "cli"}
          variant="white"
        />
        <ChoiceRow
          icon={<Terminal size={13} />}
          title={cliTitle}
          onClick={pickGhCli}
          loading={pending === "cli"}
          disabled={cliDisabled}
          badge={cliBadge}
          variant="black"
        />
      </div>

      {pending === "cli" && (
        <div style={{
          margin: "0 10px 10px",
          padding: "9px 10px",
          borderRadius: 7,
          background: "rgba(255,255,255,0.03)",
          border: "1px solid rgba(255,255,255,0.08)",
        }}>
          <div style={{
            fontSize: 10,
            color: "var(--c-low)",
            textTransform: "uppercase",
            letterSpacing: "0.06em",
            marginBottom: 5,
          }}>
            {deviceCode ? "One-time code" : "Starting gh auth…"}
          </div>
          {deviceCode ? (
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <code style={{
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                fontSize: 15,
                fontWeight: 700,
                letterSpacing: "0.16em",
                color: "var(--c-fg)",
                padding: "3px 8px",
                borderRadius: 5,
                background: "rgba(255,255,255,0.06)",
              }}>
                {deviceCode}
              </code>
              <button
                onClick={() => {
                  try { window.electronAPI?.writeText?.(deviceCode); } catch { /* best effort */ }
                }}
                style={popoverGhostBtn}
              >
                Copy
              </button>
              {verifyUrl && (
                <button
                  onClick={() => {
                    try { window.electronAPI?.openExternal?.(verifyUrl); } catch { /* best effort */ }
                  }}
                  style={{ ...popoverGhostBtn, display: "inline-flex", alignItems: "center", gap: 4 }}
                >
                  Open browser <ExternalLink size={10} />
                </button>
              )}
            </div>
          ) : (
            <div style={{ display: "flex", alignItems: "center", gap: 7, color: "var(--c-med)", fontSize: 11.5 }}>
              <Loader2 size={12} style={{ animation: "spin 1s linear infinite" }} />
              Waiting for the device code…
            </div>
          )}
          {deviceCode && (
            <div style={{ marginTop: 6, fontSize: 11, color: "var(--c-low)", lineHeight: 1.45 }}>
              Paste this code in the GitHub tab that just opened. Auth completes automatically.
            </div>
          )}
          <div style={{ marginTop: 8, display: "flex", justifyContent: "flex-end" }}>
            <button onClick={cancelGhCli} style={popoverGhostBtn}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {error && (
        <div style={{
          padding: "0 12px 10px",
          fontSize: 11,
          color: "rgba(248,113,113,0.92)",
        }}>
          {error}
        </div>
      )}
    </div>
  );
}

const popoverGhostBtn: React.CSSProperties = {
  height: 22,
  padding: "0 8px",
  fontSize: 10.5,
  fontWeight: 500,
  borderRadius: 4,
  background: "transparent",
  border: "1px solid rgba(255,255,255,0.14)",
  color: "var(--c-med)",
  cursor: "pointer",
  fontFamily: "inherit",
};

function ChoiceRow({
  icon,
  title,
  onClick,
  disabled,
  loading,
  badge,
  variant,
}: {
  icon: React.ReactNode;
  title: string;
  onClick: () => void;
  disabled?: boolean;
  loading?: boolean;
  badge?: string;
  variant?: "white" | "black";
}) {
  const isWhite = variant === "white";
  const isBlack = variant === "black";
  const baseBg = isWhite ? "#fff" : isBlack ? "#000" : "rgba(255,255,255,0.025)";
  const hoverBg = isWhite ? "#f1f1f1" : isBlack ? "#111" : "rgba(255,255,255,0.08)";
  const baseBorder = isWhite
    ? "rgba(0,0,0,0.08)"
    : isBlack
      ? "rgba(255,255,255,0.12)"
      : "rgba(255,255,255,0.08)";
  const hoverBorder = isWhite
    ? "rgba(0,0,0,0.16)"
    : isBlack
      ? "rgba(255,255,255,0.22)"
      : "rgba(255,255,255,0.18)";
  const textColor = isWhite ? "#000" : isBlack ? "#fff" : "var(--c-fg)";
  const iconColor = isWhite ? "#000" : isBlack ? "#fff" : "var(--c-med)";
  const badgeBg = isWhite
    ? "rgba(0,0,0,0.06)"
    : isBlack
      ? "rgba(255,255,255,0.10)"
      : "rgba(255,255,255,0.05)";
  const badgeColor = isWhite
    ? "rgba(0,0,0,0.7)"
    : isBlack
      ? "rgba(255,255,255,0.75)"
      : "var(--c-low)";

  return (
    <button
      onClick={onClick}
      disabled={disabled || loading}
      style={{
        width: "100%",
        position: "relative",
        display: "flex",
        alignItems: "center",
        height: 36,
        padding: "0 12px",
        background: baseBg,
        border: `1px solid ${baseBorder}`,
        borderRadius: 7,
        color: textColor,
        fontSize: 12.5,
        fontWeight: 600,
        cursor: disabled || loading ? "not-allowed" : "pointer",
        opacity: disabled ? 0.55 : 1,
        transition: "background 0.12s ease, border-color 0.12s ease",
        fontFamily: "inherit",
      }}
      onMouseEnter={e => {
        if (disabled || loading) return;
        e.currentTarget.style.background = hoverBg;
        e.currentTarget.style.borderColor = hoverBorder;
      }}
      onMouseLeave={e => {
        if (disabled || loading) return;
        e.currentTarget.style.background = baseBg;
        e.currentTarget.style.borderColor = baseBorder;
      }}
    >
      <span style={{
        position: "absolute", left: 12, top: "50%",
        transform: "translateY(-50%)",
        display: "flex", color: iconColor,
      }}>
        {loading
          ? <Loader2 size={13} style={{ animation: "spin 1s linear infinite" }} />
          : icon}
      </span>
      <span style={{ flex: 1, textAlign: "center" }}>{title}</span>
      {badge && (
        <span style={{
          position: "absolute", right: 9, top: "50%",
          transform: "translateY(-50%)",
          fontSize: 9.5,
          fontWeight: 600,
          letterSpacing: "0.04em",
          textTransform: "uppercase",
          padding: "2px 6px",
          borderRadius: 4,
          background: badgeBg,
          color: badgeColor,
        }}>
          {badge}
        </span>
      )}
    </button>
  );
}
