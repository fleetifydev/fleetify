/**
 * A single router card. The whole card is clickable:
 *   - Active card → click is a no-op (it's already active).
 *   - Connected, not active → click flips active to this router.
 *   - Disconnected (needs credentials) → click expands the inline setup
 *     form (API key + optional base URL with a Managed / Self-hosted
 *     toggle for routers that support both).
 *   - Immortal (Built-in / None / Direct) → click sets it active.
 *
 * The active card shows ONLY a small "active" pill — no green border or
 * tinted background. Cards that aren't expanded have a subtle hover
 * affordance so it's obvious the whole row is interactive.
 *
 * Interactive children (inputs, buttons inside the expanded form, the
 * inline Edit / Disconnect links) call `e.stopPropagation()` so the
 * card-level click handler doesn't trigger when the user is editing
 * credentials or pressing Cancel.
 */
import type { MouseEvent } from "react";
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
  transition: "background 120ms ease, border-color 120ms ease",
};

const nameStyle: React.CSSProperties = {
  fontSize: 13.5,
  fontWeight: 600,
  color: "var(--c-high)",
};

const descStyle: React.CSSProperties = {
  fontSize: 12,
  color: "var(--c-low)",
  lineHeight: 1.5,
};

const activePill: React.CSSProperties = {
  fontSize: 10.5,
  textTransform: "uppercase",
  letterSpacing: 0.5,
  padding: "2px 7px",
  borderRadius: 4,
  background: "var(--c-srf2)",
  color: "var(--c-high)",
  fontWeight: 700,
};

const connectedPill: React.CSSProperties = {
  fontSize: 10.5,
  textTransform: "uppercase",
  letterSpacing: 0.5,
  padding: "2px 7px",
  borderRadius: 4,
  background: "transparent",
  color: "var(--c-low)",
  fontWeight: 600,
  border: "1px solid var(--c-brd)",
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

const chevron: React.CSSProperties = {
  fontSize: 14,
  color: "var(--c-low)",
  marginLeft: 4,
};

export function RouterCard({ tile, category, meta, onChanged }: Props) {
  const isActive =
    category === "decision" ? tile.active_for_decision : tile.active_for_proxy;
  const isImmortal = tile.id === "builtin" || tile.id === "none-proxy";
  const needsSetup = tile.modes.length > 0 && !tile.connected;

  const [expanded, setExpanded] = useState(false);
  const [hover, setHover] = useState(false);
  const [mode, setMode] = useState<RouterMode>(tile.modes[0] ?? "managed");
  const [secret, setSecret] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasModeChoice = tile.modes.length > 1;
  const needsUrl = mode === "self_hosted";

  // The whole-card click semantics:
  //   - active or expanded → no-op (let inner controls handle it)
  //   - connected & not active → flip active immediately
  //   - immortal & not active → flip active immediately
  //   - disconnected → expand into the setup form
  const cardClickable = !isActive && !expanded;
  const cardCursor = cardClickable ? "pointer" : "default";
  const cardBg = hover && cardClickable ? "var(--c-srf2)" : "var(--card)";

  const cardStyle: React.CSSProperties = {
    ...cardBase,
    cursor: cardCursor,
    background: cardBg,
  };

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

  const onCardClick = () => {
    if (!cardClickable) return;
    if (tile.connected || isImmortal) {
      void setAsActive();
    } else {
      setExpanded(true);
    }
  };

  // Used on inner interactive elements so they don't bubble up to the
  // card-level click handler. We still want the inner element to run its
  // own onClick if it has one.
  const stop = (e: MouseEvent) => e.stopPropagation();

  const submit = async (e: MouseEvent) => {
    stop(e);
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
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const disconnect = async (e: MouseEvent) => {
    stop(e);
    setSubmitting(true);
    setError(null);
    try {
      await routers.disconnect(tile.id);
      collapseAndReset();
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      data-testid={`router-card-${category}-${tile.id}`}
      style={cardStyle}
      onClick={onCardClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      role={cardClickable ? "button" : undefined}
      tabIndex={cardClickable ? 0 : undefined}
      onKeyDown={(e) => {
        if (!cardClickable) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onCardClick();
        }
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <span style={nameStyle}>{tile.display_name}</span>
        {isActive && <span style={activePill}>active</span>}
        {!isActive && tile.connected && !isImmortal && (
          <span style={connectedPill}>connected</span>
        )}

        <div
          style={{
            marginLeft: "auto",
            display: "flex",
            gap: 10,
            alignItems: "center",
            flexWrap: "wrap",
          }}
        >
          {/* Disconnected, needs setup → primary "Set up" (also triggered
              by clicking anywhere on the card). */}
          {needsSetup && !expanded && (
            <button
              type="button"
              style={primaryBtn}
              onClick={(e) => {
                stop(e);
                setExpanded(true);
              }}
              data-testid={`router-setup-${category}-${tile.id}`}
            >
              Set up
            </button>
          )}

          {/* Connected but not active → explicit "Use this" button
              (in addition to clicking the card) so the action is obvious
              for users who don't realise the whole card is clickable. */}
          {tile.connected && !isActive && !isImmortal && !expanded && (
            <button
              type="button"
              style={primaryBtn}
              disabled={submitting}
              onClick={(e) => {
                stop(e);
                void setAsActive();
              }}
              data-testid={`router-activate-${category}-${tile.id}`}
            >
              {submitting ? "Activating…" : "Use this"}
            </button>
          )}

          {/* Immortal & not active → "Use this" */}
          {isImmortal && !isActive && (
            <button
              type="button"
              style={primaryBtn}
              disabled={submitting}
              onClick={(e) => {
                stop(e);
                void setAsActive();
              }}
              data-testid={`router-activate-${category}-${tile.id}`}
            >
              {submitting ? "Activating…" : "Use this"}
            </button>
          )}

          {/* Connected and non-immortal → small Edit link, regardless of
              active state. Lets the user rotate keys without disconnecting. */}
          {tile.connected && !isImmortal && !expanded && (
            <button
              type="button"
              style={ghostLink}
              onClick={(e) => {
                stop(e);
                setExpanded(true);
              }}
              data-testid={`router-edit-${category}-${tile.id}`}
            >
              Edit
            </button>
          )}

          {cardClickable && !expanded && (
            <span style={chevron} aria-hidden>
              ›
            </span>
          )}
        </div>
      </div>

      <div style={descStyle}>{meta.description}</div>

      {expanded && (
        <div
          data-testid={`router-form-${category}-${tile.id}`}
          onClick={stop}
          style={{
            marginTop: 6,
            paddingTop: 12,
            borderTop: "1px solid var(--c-brd)",
            display: "flex",
            flexDirection: "column",
            gap: 12,
            cursor: "default",
          }}
        >
          {meta.docsUrl && (
            <a
              href={meta.docsUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={stop}
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
                  <label key={m} style={radioLabel} onClick={stop}>
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
                onClick={stop}
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
              onClick={stop}
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
              onClick={(e) => {
                stop(e);
                collapseAndReset();
              }}
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
