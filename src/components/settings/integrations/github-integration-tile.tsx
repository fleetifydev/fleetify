/**
 * Settings → Integrations → GitHub tile.
 *
 * Master toggle + OAuth/CLI choice picker (when not yet connected) +
 * connected-state header showing whichever auth method completed. Mirrors
 * the visual pattern of the onboarding GithubWidget but respects Settings'
 * card chrome conventions. Kept deliberately separate from the onboarding
 * widget — duplicating the rendering is cheaper than the abstraction
 * we'd need to share it across two surfaces with different chrome.
 */
import { useEffect, useRef, useState } from "react";
import { Github, Terminal, Loader2, ExternalLink, Copy } from "lucide-react";
import { useGitHubIdentity, type GhAuthEvent } from "@/hooks/use-github-identity";
import { ConnectionStatusPill } from "@/components/settings/shared/connection-status-pill";
import { copyText } from "@/lib/clipboard";

export function GitHubIntegrationTile() {
  const gh = useGitHubIdentity();
  const [pending, setPending] = useState<"oauth" | "cli" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deviceCode, setDeviceCode] = useState<string | null>(null);
  const [verifyUrl, setVerifyUrl] = useState<string | null>(null);
  const eventCleanupRef = useRef<(() => void) | null>(null);

  // Tear down any in-flight event listener on unmount.
  useEffect(() => {
    return () => {
      try { eventCleanupRef.current?.(); } catch { /* idempotent */ }
      eventCleanupRef.current = null;
    };
  }, []);

  const pickOAuth = async () => {
    setError(null);
    setPending("oauth");
    const r = await gh.beginOAuth();
    setPending(null);
    // ABORTED is the renderer pressing Cancel — silent state-reset, not
    // an error worth surfacing. Anything else (BEGIN_FAILED, TIMEOUT,
    // NO_TOKEN, BAD_BEGIN, KEYCHAIN, …) still bubbles up.
    if (!r.ok && r.code !== "ABORTED") setError(r.error ?? "OAuth failed.");
  };

  const pickCli = async () => {
    setError(null);
    setPending("cli");
    setDeviceCode(null);
    setVerifyUrl(null);
    try { eventCleanupRef.current?.(); } catch { /* idempotent */ }
    eventCleanupRef.current = gh.onCliAuthEvent((ev: GhAuthEvent) => {
      if (ev.phase === "code" && ev.code) setDeviceCode(ev.code);
      else if (ev.phase === "url" && ev.url) {
        setVerifyUrl(ev.url);
        try { window.electronAPI?.openExternal?.(ev.url); } catch { /* best effort */ }
      } else if (ev.phase === "done") {
        try { eventCleanupRef.current?.(); } catch { /* idempotent */ }
        eventCleanupRef.current = null;
        if (!ev.ok) setError(ev.error ?? "gh auth didn't complete.");
        setPending(null);
        setDeviceCode(null);
        setVerifyUrl(null);
      }
    });
    const r = await gh.beginCliAuth();
    if (!r.ok) {
      setError(r.error ?? "gh auth failed.");
      setPending(null);
    } else {
      // 'ready' resolves synchronously without a 'done' event — tear down the
      // listener we registered preemptively so stray gh-auth-events don't fire
      // into this component after it's already in the connected state.
      if (gh.ghCli.kind === "ready") {
        try { eventCleanupRef.current?.(); } catch { /* idempotent */ }
        eventCleanupRef.current = null;
        setPending(null);
      }
    }
  };

  const cancelPending = async () => {
    if (pending === "cli")   await gh.cancelCliAuth();
    if (pending === "oauth") await gh.cancelOAuth();
    try { eventCleanupRef.current?.(); } catch { /* idempotent */ }
    eventCleanupRef.current = null;
    setPending(null);
    setDeviceCode(null);
    setVerifyUrl(null);
  };

  if (gh.loading) {
    return (
      <div style={tileStyle}>
        <Loader2 size={18} style={{ animation: "spin 1.2s linear infinite", color: "var(--c-dim)" }} />
        <div style={{ fontSize: 13, color: "var(--c-low)" }}>Loading…</div>
      </div>
    );
  }

  return (
    <div style={tileStyle}>
      <div style={headerRow}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flex: 1, minWidth: 0 }}>
          {/* Always render the GitHub mark — same visual whether the
              user connected via OAuth (we have an avatarUrl) or the
              gh CLI (we don't). Keeps the tile consistent with every
              other integration row, which doesn't surface per-source
              avatars. The login/source distinction already lives in
              the text underneath ("via Fleetify OAuth" vs "via gh CLI"). */}
          <Github size={22} style={{ color: "var(--c-fg)", flexShrink: 0 }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 13.5, fontWeight: 500, color: "var(--c-high)" }}>
                {gh.identity ? `@${gh.identity.login}` : "GitHub"}
              </span>
              {gh.identity && gh.enabled && <ConnectionStatusPill status="connected" />}
              {gh.identity && !gh.enabled && (
                <ConnectionStatusPill status="needs_setup" label="Paused" />
              )}
            </div>
            <div style={{ fontSize: 12, color: "var(--c-low)", marginTop: 3 }}>
              {gh.identity?.source === "oauth"
                ? `via Fleetify OAuth · ${new Date(gh.identity.connectedAt).toLocaleDateString()}`
                : gh.identity?.source === "cli"
                  ? "via gh CLI"
                  : "Not connected. Used for PR creation and repo context."}
            </div>
          </div>
        </div>
        <Switch
          on={gh.enabled}
          ariaLabel="GitHub"
          onChange={() => gh.setEnabled(!gh.enabled)}
        />
      </div>

      {gh.enabled && !gh.identity && (
        <div style={{ display: "flex", flexDirection: "column", gap: 7, marginTop: 14 }}>
          <ChoiceRow
            icon={<Github size={14} />}
            title="Connect with GitHub"
            onClick={pickOAuth}
            loading={pending === "oauth"}
            disabled={pending === "cli"}
            variant="white"
          />
          <ChoiceRow
            icon={<Terminal size={14} />}
            title={
              gh.ghCli.kind === "ready" && gh.ghCli.login
                ? `Use GitHub CLI · @${gh.ghCli.login}`
                : "Use GitHub CLI"
            }
            onClick={pickCli}
            loading={pending === "cli"}
            disabled={gh.ghCli.kind === "missing" || gh.ghCli.kind === "probing" || pending === "oauth"}
            badge={gh.ghCli.kind === "missing" ? "Not Installed" : undefined}
            variant="black"
          />
        </div>
      )}

      {pending === "oauth" && (
        <div style={deviceCodePanel}>
          <div style={{
            display: "flex", alignItems: "center", gap: 10,
            justifyContent: "space-between",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, flex: 1 }}>
              <Loader2 size={13} style={{
                animation: "spin 1s linear infinite",
                color: "var(--c-dim)", flexShrink: 0,
              }} />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 12.5, color: "var(--c-high)", lineHeight: 1.3 }}>
                  Waiting for GitHub authorization…
                </div>
                <div style={{ fontSize: 11, color: "var(--c-dim)", marginTop: 2 }}>
                  Complete the flow in your browser, or cancel to try again.
                </div>
              </div>
            </div>
            <button
              onClick={cancelPending}
              style={{ ...miniBtn, flexShrink: 0 }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {pending === "cli" && (deviceCode || verifyUrl) && (
        <div style={deviceCodePanel}>
          <div style={{ fontSize: 11, color: "var(--c-dim)", textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 6 }}>
            One-time code
          </div>
          {deviceCode && (
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <code style={codeStyle}>{deviceCode}</code>
              <button
                onClick={() => { void copyText(deviceCode); }}
                style={miniBtn}
              >
                <Copy size={11} /> Copy
              </button>
              {verifyUrl && (
                <button
                  onClick={() => {
                    try { window.electronAPI?.openExternal?.(verifyUrl); } catch { /* best effort */ }
                  }}
                  style={miniBtn}
                >
                  Open browser <ExternalLink size={10} />
                </button>
              )}
            </div>
          )}
          <button onClick={cancelPending} style={{ ...miniBtn, marginTop: 8 }}>
            Stop waiting
          </button>
        </div>
      )}

      {gh.enabled && gh.identity && (
        <div style={{ display: "flex", gap: 8, marginTop: 12, justifyContent: "flex-end" }}>
          <button
            onClick={() => { void gh.disconnect().then(() => { setDeviceCode(null); setVerifyUrl(null); }); }}
            style={ghostBtn}
          >
            Disconnect
          </button>
        </div>
      )}

      {error && (
        <div style={{ fontSize: 11.5, color: "rgb(248,113,113)", marginTop: 10 }}>{error}</div>
      )}
    </div>
  );
}

// ── styles ─────────────────────────────────────────────────────

const tileStyle: React.CSSProperties = {
  border: "1px solid var(--c-brd)",
  borderRadius: 10,
  background: "var(--card)",
  padding: "14px 16px",
};
const headerRow: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 12,
};
const deviceCodePanel: React.CSSProperties = {
  marginTop: 12, padding: "11px 12px",
  borderRadius: 8,
  background: "var(--c-srf)",
  border: "1px solid var(--c-brd)",
};
const codeStyle: React.CSSProperties = {
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: 17, fontWeight: 700, letterSpacing: "0.18em",
  color: "var(--c-high)",
  padding: "4px 10px", borderRadius: 6,
  background: "var(--c-srf2)",
};
const miniBtn: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 5,
  height: 24, padding: "0 9px",
  fontSize: 11, fontWeight: 500,
  borderRadius: 5,
  background: "transparent",
  border: "1px solid var(--c-brd)",
  color: "var(--c-low)",
  cursor: "pointer", fontFamily: "inherit",
};
const ghostBtn: React.CSSProperties = {
  padding: "6px 12px", borderRadius: 6,
  background: "transparent", border: "1px solid var(--c-brd)",
  color: "var(--c-high)", cursor: "pointer", fontSize: 12,
  fontFamily: "inherit",
};

// ── Switch — local copy of the Settings page Toggle, kept here so the
//    tile doesn't have to thread the same primitive through props ──

function Switch({
  on, onChange, ariaLabel,
}: { on: boolean; onChange: () => void; ariaLabel: string }) {
  return (
    <button
      onClick={onChange}
      role="switch"
      aria-checked={on}
      aria-label={ariaLabel}
      style={{
        width: 36, height: 21, borderRadius: 999, padding: 0, position: "relative",
        border: "1px solid var(--c-brd)",
        cursor: "pointer", flexShrink: 0,
        background: on ? "rgb(64,180,120)" : "var(--c-srf)",
        transition: "background 0.18s",
        outline: "none",
      }}
    >
      <span style={{
        position: "absolute",
        top: 2, left: on ? 17 : 2,
        width: 15, height: 15, borderRadius: "50%",
        background: "#fff",
        boxShadow: "0 1px 2px rgba(0,0,0,0.25)",
        transition: "left 0.18s cubic-bezier(0.4,0,0.2,1)",
      }} />
    </button>
  );
}

// ── ChoiceRow — visual echo of the onboarding picker rows ──

function ChoiceRow({
  icon, title, onClick, disabled, loading, badge, variant,
}: {
  icon: React.ReactNode;
  title: string;
  onClick: () => void;
  disabled?: boolean;
  loading?: boolean;
  badge?: string;
  variant: "white" | "black";
}) {
  const isWhite = variant === "white";
  const baseBg = isWhite ? "#fff" : "#000";
  const hoverBg = isWhite ? "#f1f1f1" : "#111";
  const baseBorder = isWhite ? "rgba(0,0,0,0.08)" : "rgba(255,255,255,0.12)";
  const hoverBorder = isWhite ? "rgba(0,0,0,0.16)" : "rgba(255,255,255,0.22)";
  const textColor = isWhite ? "#000" : "#fff";
  const badgeBg = isWhite ? "rgba(0,0,0,0.06)" : "rgba(255,255,255,0.10)";
  const badgeColor = isWhite ? "rgba(0,0,0,0.7)" : "rgba(255,255,255,0.75)";
  return (
    <button
      onClick={onClick}
      disabled={disabled || loading}
      style={{
        width: "100%", position: "relative",
        display: "flex", alignItems: "center",
        height: 40, padding: "0 13px",
        background: baseBg, border: `1px solid ${baseBorder}`,
        borderRadius: 8, color: textColor,
        fontSize: 13, fontWeight: 600,
        cursor: disabled || loading ? "not-allowed" : "pointer",
        opacity: disabled ? 0.55 : 1,
        transition: "background 0.12s, border-color 0.12s",
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
        position: "absolute", left: 13, top: "50%", transform: "translateY(-50%)",
        display: "flex", color: textColor,
      }}>
        {loading ? <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} /> : icon}
      </span>
      <span style={{ flex: 1, textAlign: "center" }}>{title}</span>
      {badge && (
        <span style={{
          position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)",
          fontSize: 10, fontWeight: 600, letterSpacing: "0.04em",
          textTransform: "uppercase",
          padding: "3px 7px", borderRadius: 4,
          background: badgeBg, color: badgeColor,
        }}>
          {badge}
        </span>
      )}
    </button>
  );
}
