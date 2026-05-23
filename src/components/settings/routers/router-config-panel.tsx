/**
 * Inline configuration panel for a router that needs credentials.
 *
 * Shown by routers-section.tsx when the user picks a router that:
 *   (a) requires credentials (modes.length > 0), and
 *   (b) is either not connected yet, or the user clicked "Edit" on an
 *       already-connected router.
 *
 * Mode toggle (Managed / Self-hosted) appears only when the router
 * advertises more than one mode — currently only Weave Router. Routers
 * with a single mode skip the toggle and just show the relevant fields.
 *
 * Saving calls `routers.connect(id, secret, { base_url? })` then
 * `routers.setActive(category, id)` and finally `onSaved()` so the
 * parent can refresh and close the panel.
 */
import { useMemo, useState } from "react";
import { ExternalLink } from "lucide-react";

import { routers, type RouterMode, type RouterTile } from "@/lib/routers-api";

type Category = "decision" | "proxy";

interface Props {
  tile: RouterTile;
  category: Category;
  docsUrl?: string;
  managedBaseUrl?: string;
  onSaved: () => Promise<void> | void;
  onCancel: () => void;
}

const panelStyle: React.CSSProperties = {
  border: "1px solid var(--c-brd)",
  borderRadius: 10,
  background: "var(--card)",
  padding: "16px 18px",
  display: "flex",
  flexDirection: "column",
  gap: 12,
};

const labelStyle: React.CSSProperties = {
  fontSize: 11.5,
  color: "var(--c-low)",
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: 0.4,
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  background: "var(--c-srf2)",
  border: "1px solid var(--c-brd)",
  borderRadius: 7,
  fontSize: 13,
  color: "var(--c-high)",
  fontFamily: "inherit",
  boxSizing: "border-box",
  outline: "none",
};

const primaryBtn: React.CSSProperties = {
  fontSize: 12.5,
  padding: "8px 14px",
  borderRadius: 7,
  background: "var(--c-fg)",
  border: "1px solid var(--c-fg)",
  color: "var(--card, #0d0d0d)",
  cursor: "pointer",
  fontWeight: 600,
  fontFamily: "inherit",
};

const ghostBtn: React.CSSProperties = {
  fontSize: 12.5,
  padding: "8px 12px",
  borderRadius: 7,
  background: "transparent",
  border: "1px solid var(--c-brd)",
  color: "var(--c-high)",
  cursor: "pointer",
  fontFamily: "inherit",
};

const dangerGhostBtn: React.CSSProperties = {
  fontSize: 12,
  padding: 0,
  background: "transparent",
  border: "none",
  color: "var(--c-low)",
  cursor: "pointer",
  textDecoration: "underline",
  fontFamily: "inherit",
};

const radioRow: React.CSSProperties = {
  display: "flex",
  gap: 18,
  flexWrap: "wrap",
};

const radioLabel: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  cursor: "pointer",
  fontSize: 12.5,
  color: "var(--c-high)",
};

export function RouterConfigPanel({
  tile,
  category,
  docsUrl,
  managedBaseUrl,
  onSaved,
  onCancel,
}: Props) {
  // Initial mode = the first mode the router supports. Weave (managed +
  // self-hosted) defaults to "managed"; LiteLLM defaults to "self_hosted".
  const initialMode: RouterMode = tile.modes[0] ?? "managed";
  const [mode, setMode] = useState<RouterMode>(initialMode);
  const [secret, setSecret] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasModeChoice = tile.modes.length > 1;
  const needsUrl = mode === "self_hosted";

  // When the user flips mode, clear the URL so the managed-default vs the
  // user-provided URL never leak into each other. Don't clear the secret
  // — that's user-provided either way and re-typing is annoying.
  const changeMode = (m: RouterMode) => {
    setMode(m);
    setBaseUrl("");
    setError(null);
  };

  const urlPlaceholder = useMemo(() => {
    if (tile.id === "weave") return "https://router.your-domain.example";
    if (tile.id === "litellm") return "http://localhost:4000";
    return "https://your-router.example";
  }, [tile.id]);

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      if (!secret.trim()) {
        setError("API key is required");
        setSubmitting(false);
        return;
      }
      if (needsUrl && !baseUrl.trim()) {
        setError("Base URL is required for self-hosted mode");
        setSubmitting(false);
        return;
      }

      // Metadata: persist mode + base_url when self-hosted. For managed
      // mode we send an empty base_url so the backend's setup hydration
      // falls back to the router's hardcoded managed default.
      const metadata: Record<string, unknown> = { mode };
      if (needsUrl) {
        metadata.base_url = baseUrl.trim();
      }

      const r = await routers.connect(tile.id, secret.trim(), metadata);
      if (!r.ok) {
        const msg = "error" in r ? r.error : "Connection failed";
        setError(msg);
        setSubmitting(false);
        return;
      }
      // Auto-activate the freshly-connected router for the dropdown's
      // category. If the user wants a different active selection they
      // can switch via the dropdown afterward.
      await routers.setActive(category, tile.id);
      await onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSubmitting(false);
    }
  };

  const disconnect = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await routers.disconnect(tile.id);
      await onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSubmitting(false);
    }
  };

  return (
    <div data-testid={`router-config-${tile.id}`} style={panelStyle}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--c-high)" }}>
          Configure {tile.display_name}
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          {tile.connected && (
            <span style={{ fontSize: 11.5, color: "#22c55e" }}>
              ✓ connected
            </span>
          )}
          {tile.connected && (
            <button
              type="button"
              style={dangerGhostBtn}
              onClick={disconnect}
              data-testid={`router-disconnect-${tile.id}`}
            >
              Disconnect
            </button>
          )}
        </div>
      </div>

      {docsUrl && (
        <a
          href={docsUrl}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            fontSize: 11.5,
            color: "#60a5fa",
            textDecoration: "none",
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
          }}
        >
          Where to find your API key <ExternalLink size={11} />
        </a>
      )}

      {hasModeChoice && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span style={labelStyle}>Mode</span>
          <div style={radioRow}>
            {tile.modes.map((m) => (
              <label key={m} style={radioLabel}>
                <input
                  type="radio"
                  name={`mode-${tile.id}`}
                  checked={mode === m}
                  onChange={() => changeMode(m)}
                  data-testid={`router-mode-${tile.id}-${m}`}
                />
                {m === "managed"
                  ? `Managed${managedBaseUrl ? ` (${managedBaseUrl})` : ""}`
                  : "Self-hosted"}
              </label>
            ))}
          </div>
        </div>
      )}

      {needsUrl && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span style={labelStyle}>Base URL</span>
          <input
            type="text"
            style={inputStyle}
            placeholder={urlPlaceholder}
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            data-testid={`router-baseurl-${tile.id}`}
            autoComplete="off"
          />
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <span style={labelStyle}>API Key</span>
        <input
          type="password"
          style={inputStyle}
          placeholder="••••••••••••••••••••"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          data-testid={`router-secret-${tile.id}`}
          autoFocus
          autoComplete="off"
        />
      </div>

      {error && (
        <div style={{ fontSize: 11.5, color: "#fca5a5" }}>{error}</div>
      )}

      <div
        style={{
          display: "flex",
          gap: 8,
          justifyContent: "flex-end",
          marginTop: 4,
        }}
      >
        <button type="button" style={ghostBtn} onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          style={{
            ...primaryBtn,
            opacity: submitting ? 0.55 : 1,
            cursor: submitting ? "not-allowed" : "pointer",
          }}
          disabled={submitting}
          onClick={submit}
          data-testid={`router-save-${tile.id}`}
        >
          {submitting
            ? "Connecting…"
            : tile.connected
              ? "Save & Activate"
              : "Connect & Activate"}
        </button>
      </div>
    </div>
  );
}
