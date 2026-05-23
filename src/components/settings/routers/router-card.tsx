/**
 * A single router card. Renders three visually-distinct states in one shell:
 *
 *   1. Active           — currently the live router for `category`. Card
 *                         shows a filled radio dot and an "active" pill.
 *   2. Connected, idle  — credentials exist but another router is active.
 *                         "Set as active" button + Edit/Disconnect actions.
 *   3. Disconnected     — needs credentials. "Set up & activate" expands
 *                         the inline form (mode toggle, optional base URL,
 *                         API key, and a clearly-visible primary button).
 *
 * Built-in (decision) and None / Direct (proxy) are immortal: no
 * credentials, no Edit/Disconnect, just the active dot + radio.
 *
 * The mode toggle (Managed / Self-hosted) only appears when the router
 * advertises both modes — currently only Weave Router. Single-mode
 * routers skip the radios and show the relevant fields directly.
 */
import { useState } from "react";
import { ExternalLink } from "lucide-react";

import { routers, type RouterMode, type RouterTile } from "@/lib/routers-api";

type Category = "decision" | "proxy";

interface RouterMeta {
  description: string;
  docsUrl?: string;
  managedBaseUrl?: string;
}

interface Props {
  tile: RouterTile;
  category: Category;
  meta: RouterMeta;
  onChanged: () => Promise<void> | void;
}

const cardBase: React.CSSProperties = {
  border: "1px solid var(--c-brd)",
  borderRadius: 10,
  background: "var(--card)",
  padding: "12px 14px",
  display: "flex",
  flexDirection: "column",
  gap: 8,
  transition: "border-color 120ms ease, background 120ms ease",
};

const cardActive: React.CSSProperties = {
  ...cardBase,
  borderColor: "rgba(34,197,94,0.55)",
  background:
    "linear-gradient(0deg, rgba(34,197,94,0.04), rgba(34,197,94,0.04)), var(--card)",
};

const radioDot = (active: boolean): React.CSSProperties => ({
  width: 12,
  height: 12,
  borderRadius: "50%",
  border: active
    ? "2px solid #22c55e"
    : "2px solid var(--c-brd, rgba(255,255,255,0.2))",
  background: active ? "#22c55e" : "transparent",
  flexShrink: 0,
  boxSizing: "border-box",
});

const nameStyle: React.CSSProperties = {
  fontSize: 13.5,
  fontWeight: 600,
  color: "var(--c-high)",
};

const descStyle: React.CSSProperties = {
  fontSize: 12,
  color: "var(--c-low)",
  lineHeight: 1.5,
  marginLeft: 20,
};

const activePill: React.CSSProperties = {
  fontSize: 10.5,
  textTransform: "uppercase",
  letterSpacing: 0.5,
  padding: "2px 7px",
  borderRadius: 4,
  background: "rgba(34,197,94,0.15)",
  color: "#22c55e",
  fontWeight: 700,
};

const connectedPill: React.CSSProperties = {
  fontSize: 10.5,
  textTransform: "uppercase",
  letterSpacing: 0.5,
  padding: "2px 7px",
  borderRadius: 4,
  background: "var(--c-srf2)",
  color: "var(--c-high)",
  fontWeight: 600,
};

const primaryBtn: React.CSSProperties = {
  fontSize: 12.5,
  padding: "7px 14px",
  borderRadius: 7,
  background: "var(--c-fg)",
  border: "1px solid var(--c-fg)",
  color: "var(--card, #0d0d0d)",
  cursor: "pointer",
  fontWeight: 600,
  fontFamily: "inherit",
  whiteSpace: "nowrap",
};

const secondaryBtn: React.CSSProperties = {
  fontSize: 12.5,
  padding: "6px 12px",
  borderRadius: 7,
  background: "transparent",
  border: "1px solid var(--c-brd)",
  color: "var(--c-high)",
  cursor: "pointer",
  fontFamily: "inherit",
  whiteSpace: "nowrap",
};

const ghostLink: React.CSSProperties = {
  fontSize: 11.5,
  padding: 0,
  background: "transparent",
  border: "none",
  color: "var(--c-low)",
  cursor: "pointer",
  textDecoration: "underline",
  fontFamily: "inherit",
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  background: "var(--c-srf2)",
  border: "1px solid var(--c-brd)",
  borderRadius: 7,
  fontSize: 12.5,
  color: "var(--c-high)",
  fontFamily: "inherit",
  boxSizing: "border-box",
  outline: "none",
};

const labelStyle: React.CSSProperties = {
  fontSize: 10.5,
  color: "var(--c-low)",
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: 0.4,
  marginBottom: 5,
  display: "block",
};

const radioLabel: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  cursor: "pointer",
  fontSize: 12.5,
  color: "var(--c-high)",
};

export function RouterCard({ tile, category, meta, onChanged }: Props) {
  const isActive =
    category === "decision" ? tile.active_for_decision : tile.active_for_proxy;
  const isImmortal = tile.id === "builtin" || tile.id === "none-proxy";

  const [expanded, setExpanded] = useState(false);
  const [mode, setMode] = useState<RouterMode>(tile.modes[0] ?? "managed");
  const [secret, setSecret] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasModeChoice = tile.modes.length > 1;
  const needsUrl = mode === "self_hosted";

  const setAsActive = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const r = await routers.setActive(category, tile.id);
      if (!r.ok) {
        setError(r.error || "Activation failed");
        return;
      }
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  const collapseAndReset = () => {
    setExpanded(false);
    setSecret("");
    setBaseUrl("");
    setError(null);
  };

  const changeMode = (m: RouterMode) => {
    setMode(m);
    setBaseUrl("");
    setError(null);
  };

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      if (!secret.trim()) {
        setError("API key is required");
        return;
      }
      if (needsUrl && !baseUrl.trim()) {
        setError("Base URL is required for self-hosted mode");
        return;
      }
      const metadata: Record<string, unknown> = { mode };
      if (needsUrl) metadata.base_url = baseUrl.trim();

      const r = await routers.connect(tile.id, secret.trim(), metadata);
      if (!r.ok) {
        setError("error" in r ? r.error : "Connection failed");
        return;
      }
      const a = await routers.setActive(category, tile.id);
      if (!a.ok) {
        setError(a.error || "Saved key but activation failed");
        return;
      }
      collapseAndReset();
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  const disconnect = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await routers.disconnect(tile.id);
      collapseAndReset();
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      data-testid={`router-card-${category}-${tile.id}`}
      style={isActive ? cardActive : cardBase}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <span style={radioDot(isActive)} aria-hidden />
        <span style={nameStyle}>{tile.display_name}</span>
        {isActive && <span style={activePill}>active</span>}
        {!isActive && tile.connected && !isImmortal && (
          <span style={connectedPill}>connected</span>
        )}

        <div
          style={{
            marginLeft: "auto",
            display: "flex",
            gap: 8,
            alignItems: "center",
            flexWrap: "wrap",
          }}
        >
          {/* Disconnected & not immortal → primary "Set up & activate" */}
          {!tile.connected && !isImmortal && !expanded && (
            <button
              type="button"
              style={primaryBtn}
              onClick={() => setExpanded(true)}
              data-testid={`router-setup-${category}-${tile.id}`}
            >
              Set up &amp; activate
            </button>
          )}

          {/* Connected but not active → "Set as active" + Edit + Disconnect */}
          {tile.connected && !isActive && !isImmortal && !expanded && (
            <>
              <button
                type="button"
                style={primaryBtn}
                disabled={submitting}
                onClick={setAsActive}
                data-testid={`router-activate-${category}-${tile.id}`}
              >
                {submitting ? "Activating…" : "Set as active"}
              </button>
              <button
                type="button"
                style={ghostLink}
                onClick={() => setExpanded(true)}
                data-testid={`router-edit-${category}-${tile.id}`}
              >
                Edit
              </button>
            </>
          )}

          {/* Active, connected, not immortal → Edit + Disconnect (no primary) */}
          {tile.connected && isActive && !isImmortal && !expanded && (
            <>
              <button
                type="button"
                style={ghostLink}
                onClick={() => setExpanded(true)}
                data-testid={`router-edit-${category}-${tile.id}`}
              >
                Edit credentials
              </button>
            </>
          )}

          {/* Immortal & not active → "Set as active" */}
          {isImmortal && !isActive && (
            <button
              type="button"
              style={primaryBtn}
              disabled={submitting}
              onClick={setAsActive}
              data-testid={`router-activate-${category}-${tile.id}`}
            >
              {submitting ? "Activating…" : "Set as active"}
            </button>
          )}
        </div>
      </div>

      <div style={descStyle}>{meta.description}</div>

      {expanded && (
        <div
          data-testid={`router-form-${category}-${tile.id}`}
          style={{
            marginTop: 6,
            paddingTop: 12,
            borderTop: "1px solid var(--c-brd)",
            display: "flex",
            flexDirection: "column",
            gap: 12,
          }}
        >
          {meta.docsUrl && (
            <a
              href={meta.docsUrl}
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
            <div>
              <span style={labelStyle}>Connection mode</span>
              <div style={{ display: "flex", gap: 18, flexWrap: "wrap" }}>
                {tile.modes.map((m) => (
                  <label key={m} style={radioLabel}>
                    <input
                      type="radio"
                      name={`mode-${tile.id}-${category}`}
                      checked={mode === m}
                      onChange={() => changeMode(m)}
                      data-testid={`router-mode-${category}-${tile.id}-${m}`}
                    />
                    {m === "managed"
                      ? `Managed${meta.managedBaseUrl ? ` (${meta.managedBaseUrl})` : ""}`
                      : "Self-hosted"}
                  </label>
                ))}
              </div>
            </div>
          )}

          {needsUrl && (
            <div>
              <span style={labelStyle}>Base URL</span>
              <input
                type="text"
                style={inputStyle}
                placeholder={
                  tile.id === "litellm"
                    ? "http://localhost:4000"
                    : "https://router.your-domain.example"
                }
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                data-testid={`router-baseurl-${category}-${tile.id}`}
                autoComplete="off"
              />
            </div>
          )}

          <div>
            <span style={labelStyle}>API key</span>
            <input
              type="password"
              style={inputStyle}
              placeholder="••••••••••••••••••••"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              data-testid={`router-secret-${category}-${tile.id}`}
              autoComplete="off"
              autoFocus
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
              alignItems: "center",
              flexWrap: "wrap",
            }}
          >
            {tile.connected && (
              <button
                type="button"
                style={{ ...ghostLink, marginRight: "auto" }}
                onClick={disconnect}
                disabled={submitting}
                data-testid={`router-disconnect-${category}-${tile.id}`}
              >
                Disconnect
              </button>
            )}
            <button
              type="button"
              style={secondaryBtn}
              onClick={collapseAndReset}
              disabled={submitting}
            >
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
              data-testid={`router-save-${category}-${tile.id}`}
            >
              {submitting
                ? "Connecting…"
                : tile.connected
                  ? "Save & activate"
                  : "Connect & activate"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
