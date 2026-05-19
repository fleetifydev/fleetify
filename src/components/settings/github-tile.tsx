import { useState } from "react";
import { Github, Loader2, ExternalLink } from "lucide-react";
import { useGitHubLink } from "@/hooks/use-github-link";

export function GitHubTile() {
  const { state, link, browserFallbackUrl, connect, disconnect, openInstallation } = useGitHubLink();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const tile: React.CSSProperties = {
    border: "1px solid var(--c-brd)",
    borderRadius: 10,
    background: "var(--card)",
    padding: "14px 16px",
    display: "flex", alignItems: "flex-start", gap: 14,
  };

  if (state.status === "loading") {
    return (
      <div style={tile}>
        <Loader2 size={18} style={{ animation: "spin 1.2s linear infinite", color: "var(--c-dim)" }} />
        <div style={{ fontSize: 13, color: "var(--c-low)" }}>Loading…</div>
      </div>
    );
  }

  if (state.status === "connecting") {
    return (
      <div style={tile}>
        <Github size={20} style={{ color: "var(--c-fg)", flexShrink: 0, marginTop: 1 }} />
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13.5, fontWeight: 500, color: "var(--c-high)" }}>GitHub</div>
          <div style={{ fontSize: 12, color: "var(--c-low)", marginTop: 4, display: "flex", alignItems: "center", gap: 8 }}>
            <Loader2 size={12} style={{ animation: "spin 1.2s linear infinite" }} />
            Waiting for authorization in your browser…
          </div>
          {browserFallbackUrl && (
            <div style={{
              marginTop: 10,
              fontSize: 11.5,
              color: "#fde68a",
              background: "rgba(251,191,36,0.08)",
              border: "1px solid rgba(251,191,36,0.25)",
              borderRadius: 6, padding: "8px 10px",
              lineHeight: 1.55,
            }}>
              <div style={{ fontWeight: 600, marginBottom: 3 }}>Browser couldn't open</div>
              <div style={{ color: "#e8d4a0" }}>
                The authorization URL is on your clipboard — paste it into a browser to continue:
              </div>
              <code style={{
                display: "block", marginTop: 6,
                fontFamily: "var(--font-mono)", fontSize: 11,
                background: "rgba(0,0,0,0.25)", padding: "4px 6px", borderRadius: 4,
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              }}>{browserFallbackUrl}</code>
            </div>
          )}
        </div>
      </div>
    );
  }

  if (state.status === "disconnected") {
    return (
      <div style={tile}>
        <Github size={20} style={{ color: "var(--c-fg)", flexShrink: 0, marginTop: 1 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 500, color: "var(--c-high)" }}>GitHub</div>
          <div style={{ fontSize: 12, color: "var(--c-low)", marginTop: 4 }}>
            Not connected. Required for PR creation when the gh CLI isn't installed.
          </div>
          {error && (
            <div style={{ fontSize: 11.5, color: "#fca5a5", marginTop: 8 }}>{error}</div>
          )}
        </div>
        <button
          onClick={async () => {
            setError(null);
            const r = await connect();
            if (!r.ok) setError(r.error || r.code || "Connect failed");
          }}
          style={btnPrimary}
        >
          Connect →
        </button>
      </div>
    );
  }

  return (
    <div style={{ ...tile, alignItems: "flex-start" }}>
      {link?.github_avatar_url ? (
        <img src={link.github_avatar_url} alt="" width={32} height={32}
          style={{ borderRadius: 999, flexShrink: 0, marginTop: 1 }} />
      ) : (
        <Github size={32} style={{ color: "var(--c-fg)", flexShrink: 0, marginTop: 1 }} />
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13.5, fontWeight: 500, color: "var(--c-high)" }}>
          @{link?.github_login}
        </div>
        <div style={{ fontSize: 12, color: "var(--c-low)", marginTop: 3 }}>
          Connected{link?.connected_at ? ` · ${new Date(link.connected_at).toLocaleDateString()}` : ""}
        </div>
        <button
          onClick={() => openInstallation()}
          style={{
            marginTop: 10,
            background: "none", border: "none",
            color: "var(--c-fg)", padding: 0,
            fontSize: 12, fontFamily: "inherit",
            display: "inline-flex", alignItems: "center", gap: 5,
            cursor: "pointer",
          }}
        >
          Manage repositories on GitHub <ExternalLink size={11} />
        </button>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, flexShrink: 0 }}>
        <button
          onClick={async () => {
            const r = await disconnect();
            if (r.ok) await connect();
          }}
          style={btnGhost}
        >Switch</button>
        {!confirming ? (
          <button onClick={() => setConfirming(true)} style={btnGhost}>Disconnect</button>
        ) : (
          <div style={{ display: "flex", gap: 6 }}>
            <button onClick={async () => { setConfirming(false); await disconnect(); }} style={btnDanger}>Confirm</button>
            <button onClick={() => setConfirming(false)} style={btnGhost}>Cancel</button>
          </div>
        )}
      </div>
    </div>
  );
}

const btnPrimary: React.CSSProperties = {
  padding: "7px 14px", borderRadius: 7,
  background: "var(--c-fg)", border: "1px solid var(--c-fg)",
  color: "var(--card, #0d0d0d)",
  cursor: "pointer", fontSize: 12.5,
  fontFamily: "inherit", fontWeight: 600,
  flexShrink: 0,
};

const btnGhost: React.CSSProperties = {
  padding: "6px 12px", borderRadius: 6,
  background: "transparent", border: "1px solid var(--c-brd)",
  color: "var(--c-high)", cursor: "pointer", fontSize: 12,
  fontFamily: "inherit", whiteSpace: "nowrap",
};

const btnDanger: React.CSSProperties = {
  ...btnGhost,
  background: "rgba(248,113,113,0.10)",
  borderColor: "rgba(248,113,113,0.30)",
  color: "#fca5a5",
};
