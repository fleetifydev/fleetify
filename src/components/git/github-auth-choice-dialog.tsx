/**
 * GithubAuthChoiceDialog — mid-flow picker shown when the user clicks
 * "Create PR" without having chosen a GitHub auth method during
 * onboarding (i.e. they hit "Skip"). Mirrors the onboarding picker's
 * two-option layout (Connect with GitHub / Use GitHub CLI) minus the
 * Skip row — the user is already past the optional decision point.
 *
 * Selection persists to localStorage["fleet:github-auth-method"] so
 * the next Create PR runs through directly. Resolves the consumer's
 * promise with the chosen method (or null on dismiss) so the caller
 * can decide whether to proceed with PR creation or bail.
 */

import { useEffect, useRef, useState } from "react";
import { claimEscape } from "@/hooks/use-escape-to-stop";
import { Github, Terminal, Loader2, X } from "lucide-react";

export type GithubAuthMethod = "oauth" | "cli";

interface Props {
  onChoose: (method: GithubAuthMethod, username?: string) => void;
  onDismiss: () => void;
}

type CliState =
  | { kind: "probing" }
  | { kind: "missing" }
  | { kind: "needs-auth" }
  | { kind: "ready"; login: string };

export function GithubAuthChoiceDialog({ onChoose, onDismiss }: Props) {
  const [cliState, setCliState] = useState<CliState>({ kind: "probing" });
  const [pending, setPending] = useState<"oauth" | "cli" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollCancelRef = useRef<{ cancelled: boolean }>({ cancelled: false });

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
      pollCancelRef.current.cancelled = true;
    };
  }, []);

  // Esc closes — but only when no flow is in flight, otherwise the user
  // could lose track of a half-completed auth round-trip.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Claim it: closing must not also stop a stream or deny a card.
      if (e.key === "Escape" && pending === null) { claimEscape(e); onDismiss(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pending, onDismiss]);

  const pickGhCli = async () => {
    setError(null);
    if (cliState.kind === "ready") {
      onChoose("cli", cliState.login);
      return;
    }
    if (cliState.kind !== "needs-auth") return;
    setPending("cli");
    try {
      const launch = await window.electronAPI?.ghAuthLoginLaunch?.();
      if (!launch?.ok) {
        setError(launch?.error || "Couldn't launch the gh terminal.");
        setPending(null);
        return;
      }
      pollCancelRef.current = { cancelled: false };
      const handle = pollCancelRef.current;
      const deadline = Date.now() + 3 * 60 * 1000;
      while (Date.now() < deadline && !handle.cancelled) {
        await new Promise(r => setTimeout(r, 2000));
        if (handle.cancelled) return;
        try {
          const r = await window.electronAPI?.hasGhCli?.();
          if (r?.ok && r.authed && r.ghLogin) {
            setCliState({ kind: "ready", login: r.ghLogin });
            setPending(null);
            onChoose("cli", r.ghLogin);
            return;
          }
        } catch { /* keep polling */ }
      }
      if (!handle.cancelled) {
        setError("Timed out waiting for gh auth. Try again or use GitHub OAuth.");
        setPending(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't start gh auth.");
      setPending(null);
    }
  };

  const pickOAuth = async () => {
    setError(null);
    setPending("oauth");
    try {
      const r = await window.electronAPI?.github?.beginOAuth?.();
      if (r?.ok) {
        onChoose("oauth", r.link?.github_login);
        return;
      }
      setError(r?.error || "GitHub OAuth didn't complete.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't reach GitHub.");
    } finally {
      setPending(null);
    }
  };

  const cliLoading = pending === "cli";
  const cliDisabled =
    cliState.kind === "probing" ||
    cliState.kind === "missing" ||
    pending === "oauth";
  const cliTitle =
    cliState.kind === "ready"
      ? `Use GitHub CLI · @${cliState.login}`
      : "Use GitHub CLI";
  const cliSubtitle =
    cliState.kind === "probing"
      ? "Checking gh CLI…"
      : cliState.kind === "missing"
        ? "gh CLI not detected on PATH"
        : cliState.kind === "needs-auth"
          ? cliLoading
            ? "Complete the auth in the opened terminal…"
            : "Opens a terminal to run gh auth login"
          : "Reuses gh's existing credentials — no extra setup";

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9500,
        background: "rgba(0,0,0,0.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && pending === null) onDismiss();
      }}
    >
      <div
        style={{
          width: 420,
          maxWidth: "100%",
          background: "var(--card, #161616)",
          border: "1px solid rgba(255,255,255,0.10)",
          borderRadius: 12,
          boxShadow: "0 24px 60px rgba(0,0,0,0.55)",
          overflow: "hidden",
        }}
      >
        <div style={{
          padding: "13px 14px 11px",
          display: "flex",
          alignItems: "center",
          gap: 10,
          borderBottom: "1px solid rgba(255,255,255,0.06)",
        }}>
          <Github size={15} style={{ color: "var(--m-text)" }} />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--c-high)" }}>
              Pick a GitHub connection
            </div>
            <div style={{ fontSize: 11.5, color: "var(--m-text-3)", marginTop: 2 }}>
              Required to open a pull request.
            </div>
          </div>
          <button
            onClick={() => { if (pending === null) onDismiss(); }}
            disabled={pending !== null}
            title="Close"
            style={{
              width: 24, height: 24, borderRadius: 6,
              display: "inline-flex", alignItems: "center", justifyContent: "center",
              background: "transparent", border: "none",
              color: "var(--m-text-3)",
              cursor: pending !== null ? "not-allowed" : "pointer",
              opacity: pending !== null ? 0.4 : 1,
            }}
          >
            <X size={13} />
          </button>
        </div>

        <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 7 }}>
          <ChoiceRow
            icon={<Github size={14} />}
            title="Connect with GitHub"
            subtitle="OAuth via Fleetify — browser hand-off, no token to paste"
            onClick={pickOAuth}
            loading={pending === "oauth"}
            disabled={pending === "cli"}
            primary
          />
          <ChoiceRow
            icon={<Terminal size={14} />}
            title={cliTitle}
            subtitle={cliSubtitle}
            onClick={pickGhCli}
            loading={cliLoading}
            disabled={cliDisabled}
            badge={cliState.kind === "missing" ? "Not Installed" : undefined}
          />
        </div>

        {error && (
          <div style={{
            padding: "0 14px 12px",
            fontSize: 11.5,
            color: "rgba(248,113,113,0.92)",
          }}>
            {error}
          </div>
        )}

        {pending === "cli" && (
          <div style={{
            padding: "10px 14px 14px",
            borderTop: "1px solid rgba(255,255,255,0.05)",
            display: "flex",
            justifyContent: "flex-end",
          }}>
            <button
              onClick={() => {
                pollCancelRef.current.cancelled = true;
                setPending(null);
                setError("Stopped waiting for gh auth.");
              }}
              style={{
                height: 28,
                padding: "0 13px",
                fontSize: 12,
                fontWeight: 500,
                borderRadius: 6,
                background: "transparent",
                border: "1px solid rgba(255,255,255,0.12)",
                color: "var(--m-text-2)",
                cursor: "pointer",
              }}
            >
              Stop waiting
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function ChoiceRow({
  icon,
  title,
  subtitle,
  onClick,
  disabled,
  loading,
  badge,
  primary,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
  onClick: () => void;
  disabled?: boolean;
  loading?: boolean;
  badge?: string;
  primary?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled || loading}
      style={{
        width: "100%",
        display: "flex",
        alignItems: "center",
        gap: 11,
        padding: "11px 13px",
        background: primary
          ? "rgba(255,255,255,0.06)"
          : "rgba(255,255,255,0.025)",
        border: "1px solid rgba(255,255,255,0.08)",
        borderRadius: 8,
        color: disabled ? "var(--m-text-3)" : "var(--m-text)",
        fontSize: 12.5,
        fontWeight: 500,
        cursor: disabled || loading ? "not-allowed" : "pointer",
        opacity: disabled ? 0.55 : 1,
        textAlign: "left",
        transition: "background 0.12s ease, border-color 0.12s ease",
        fontFamily: "inherit",
      }}
      onMouseEnter={e => {
        if (disabled || loading) return;
        e.currentTarget.style.background = "rgba(255,255,255,0.08)";
        e.currentTarget.style.borderColor = "rgba(255,255,255,0.18)";
      }}
      onMouseLeave={e => {
        if (disabled || loading) return;
        e.currentTarget.style.background = primary
          ? "rgba(255,255,255,0.06)"
          : "rgba(255,255,255,0.025)";
        e.currentTarget.style.borderColor = "rgba(255,255,255,0.08)";
      }}
    >
      <span style={{ display: "flex", color: disabled ? "var(--m-text-3)" : "var(--m-text-2)" }}>
        {loading ? (
          <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} />
        ) : icon}
      </span>
      <span style={{ flex: 1, display: "flex", flexDirection: "column", gap: 2 }}>
        <span style={{ fontWeight: 600, fontSize: 13 }}>{title}</span>
        {subtitle && (
          <span style={{ fontSize: 11, color: "var(--m-text-3)" }}>{subtitle}</span>
        )}
      </span>
      {badge && (
        <span style={{
          fontSize: 10,
          fontWeight: 600,
          letterSpacing: "0.04em",
          textTransform: "uppercase",
          padding: "3px 7px",
          borderRadius: 4,
          background: "rgba(255,255,255,0.05)",
          color: "var(--m-text-3)",
        }}>
          {badge}
        </span>
      )}
    </button>
  );
}
