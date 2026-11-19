/**
 * Router card with three visual states that read at a glance:
 *
 *   • Active           — Voice-style selection: neutral high-contrast
 *                        border + filled surface background + a check
 *                        mark pinned to the far right. No green chrome;
 *                        the background shift, border, and tick carry the
 *                        "this one is selected" signal.
 *   • Connected/idle   — neutral card with a small "connected" tag.
 *                        Clickable to flip active immediately.
 *   • Needs setup      — yellow "Needs setup" badge in place of any
 *                        primary button. Clicking the card (or the
 *                        badge) opens the inline configuration form.
 *
 * Click semantics (whole card is clickable):
 *   - active or expanded → no-op (let inner controls handle their own
 *     clicks; inputs/buttons stopPropagation)
 *   - connected & not active → setActive immediately
 *   - immortal (builtin / none-proxy) & not active → setActive
 *   - disconnected & has modes → expand the form
 *
 * Form behaviour when re-opening a connected router:
 *   - The card fetches `routers.getKeyPreview(id)` to display a masked
 *     version of the stored key (e.g. `sk-•••abcd`) along with an
 *     underlined "edit" link.
 *   - Clicking edit reveals the real password input (empty by default —
 *     full key never leaves the keychain), at which point the user can
 *     paste a new value and hit "Connect & activate" to rotate it.
 *   - For self-hosted routers, the saved `metadata.base_url` is also
 *     pre-populated so the user doesn't have to retype it.
 */
import type { MouseEvent } from "react";
import { useEffect, useState } from "react";
import { Check, ExternalLink } from "lucide-react";

import { routers, type RouterMode, type RouterTile } from "@/lib/routers-api";
import { ConnectionStatusPill } from "@/components/settings/shared/connection-status-pill";
import { followLink } from "@/components/markdown-link";

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

// ── Card chrome ───────────────────────────────────────────────────
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

// Selected state mirrors Settings → Voice's engine picker: a neutral
// high-contrast border + a filled surface background (no green stripe),
// paired with the far-right check mark rendered in the header row.
const cardActive: React.CSSProperties = {
  ...cardBase,
  borderColor: "var(--c-high)",
  background: "var(--c-srf)",
};

// ── Buttons ───────────────────────────────────────────────────────
const primaryBtn: React.CSSProperties = {
  fontSize: 12.5,
  padding: "7px 14px",
  borderRadius: 7,
  background: "#ffffff",
  border: "1px solid #e5e5e5",
  color: "#0d0d0d",
  cursor: "pointer",
  fontWeight: 600,
  fontFamily: "inherit",
  whiteSpace: "nowrap",
  boxShadow: "0 1px 2px rgba(0,0,0,0.18)",
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

const segmentedWrap: React.CSSProperties = {
  display: "inline-flex",
  background: "var(--c-srf2)",
  border: "1px solid var(--c-brd)",
  borderRadius: 8,
  padding: 3,
  gap: 2,
};

const segmentBtnBase: React.CSSProperties = {
  fontSize: 12,
  padding: "5px 14px",
  borderRadius: 5,
  border: "none",
  cursor: "pointer",
  fontFamily: "inherit",
  fontWeight: 600,
  letterSpacing: 0.3,
  transition: "background 120ms ease, color 120ms ease",
  background: "transparent",
  color: "var(--c-low)",
};

const segmentBtnActive: React.CSSProperties = {
  ...segmentBtnBase,
  background: "#ffffff",
  color: "#0d0d0d",
  boxShadow: "0 1px 2px rgba(0,0,0,0.15)",
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

export function RouterCard({ tile, category, meta, onChanged }: Props) {
  const isActive =
    category === "decision" ? tile.active_for_decision : tile.active_for_proxy;
  const isImmortal = tile.id === "builtin" || tile.id === "none-proxy";
  const needsSetup = tile.modes.length > 0 && !tile.connected;
  const savedBaseUrl = (() => {
    const m = tile.metadata as Record<string, unknown> | null | undefined;
    const v = m && typeof m === "object" ? m.base_url : undefined;
    return typeof v === "string" ? v : "";
  })();

  const [expanded, setExpanded] = useState(false);
  const [hover, setHover] = useState(false);
  const [mode, setMode] = useState<RouterMode>(() => {
    // Default the mode to the one that matches the saved metadata when we
    // can detect it (self-hosted iff a base_url was saved), otherwise the
    // first supported mode.
    if (savedBaseUrl && tile.modes.includes("self_hosted")) return "self_hosted";
    return tile.modes[0] ?? "managed";
  });
  const [secret, setSecret] = useState("");
  const [baseUrl, setBaseUrl] = useState(savedBaseUrl);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The masked preview of the stored key. Null until fetched OR when no
  // key is on file. While not null, the password input stays collapsed
  // behind the "edit" link.
  const [keyPreview, setKeyPreview] = useState<string | null>(null);
  // Once the user clicks "edit", reveal the password input so they can
  // type a new key. Independent of expansion so re-collapsing the card
  // resets the rotate flow.
  const [rotating, setRotating] = useState(false);

  const hasModeChoice = tile.modes.length > 1;
  const needsUrl = mode === "self_hosted";

  // Fetch the masked key preview the first time the card is expanded for
  // a connected router. Cheap (single keychain read on the main process)
  // and never carries the real key over IPC.
  useEffect(() => {
    if (!expanded || !tile.connected || isImmortal) return;
    let cancelled = false;
    routers
      .getKeyPreview(tile.id)
      .then((r) => {
        if (cancelled) return;
        setKeyPreview(r.ok ? r.preview : null);
      })
      .catch(() => {
        if (!cancelled) setKeyPreview(null);
      });
    return () => {
      cancelled = true;
    };
  }, [expanded, tile.connected, tile.id, isImmortal]);

  // Keep baseUrl in sync with the saved metadata when the card opens, so
  // the user sees their previously-entered URL pre-filled. Repo style
  // discourages setState-in-effect (the autofocus / config-rehydrate
  // pattern is the well-known exception — same shape as use-router-config
  // and use-session-routing).
  useEffect(() => {
    if (expanded) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setBaseUrl(savedBaseUrl);
    }
  }, [expanded, savedBaseUrl]);

  const cardClickable = !isActive && !expanded;
  const cardStyle: React.CSSProperties = isActive
    ? cardActive
    : {
        ...cardBase,
        cursor: cardClickable ? "pointer" : "default",
        background: hover && cardClickable ? "var(--c-srf2)" : "var(--card)",
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
    setBaseUrl(savedBaseUrl);
    setError(null);
    setRotating(false);
  };

  const changeMode = (m: RouterMode) => {
    setMode(m);
    // When the user explicitly flips the mode, drop any pre-fill so the
    // managed-default vs user-provided URL never leak into each other.
    setBaseUrl(m === "self_hosted" ? savedBaseUrl : "");
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

  const stop = (e: MouseEvent) => e.stopPropagation();

  const submit = async (e: MouseEvent) => {
    stop(e);
    setSubmitting(true);
    setError(null);
    try {
      // The rotate flow: if the user is editing a connected router but
      // hasn't typed a new key, hold the existing one in keychain — we
      // only re-write the secret when they actually type a new value.
      const wantsKeyRotation = rotating || !tile.connected;
      if (wantsKeyRotation && !secret.trim()) {
        setError("API key is required");
        return;
      }
      if (needsUrl && !baseUrl.trim()) {
        setError("Base URL is required for self-hosted mode");
        return;
      }

      const metadata: Record<string, unknown> = { mode };
      if (needsUrl) metadata.base_url = baseUrl.trim();

      // When the user didn't type a new key (just changed mode or URL on
      // an already-connected router), we can't write secret="" or we'd
      // wipe the keychain entry. Skip connect() in that case and only
      // re-activate / update metadata via a re-connect with the EXISTING
      // key — which means we DO need the real key. As a Day-1 compromise
      // we make the user type the key to "save" any change. The masked
      // preview makes that explicit.
      if (secret.trim()) {
        const r = await routers.connect(tile.id, secret.trim(), metadata);
        if (!r.ok) {
          setError("error" in r ? r.error : "Connection failed");
          return;
        }
      } else if (tile.connected) {
        // Mode / URL-only change with an existing key: just toggle the
        // saved metadata via a no-op "edit" by re-reading the key would
        // require crossing IPC for the full secret, which we deliberately
        // don't do. Tell the user to enter the key to confirm.
        setError("Enter your API key to confirm the change.");
        setRotating(true);
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
        {!isActive && tile.connected && !isImmortal && (
          <ConnectionStatusPill status="connected" />
        )}
        {needsSetup && !expanded && (
          <span data-testid={`router-needs-setup-${category}-${tile.id}`}>
            <ConnectionStatusPill status="needs_setup" label="Needs setup" />
          </span>
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
          {/* Connected but not active → "Set as active" primary */}
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
              {submitting ? "Activating…" : "Set as active"}
            </button>
          )}

          {/* Immortal & not active → "Set as active" */}
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
              {submitting ? "Activating…" : "Set as active"}
            </button>
          )}

          {/* Connected non-immortal → small Edit link, regardless of
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

          {/* Voice-style selection tick, pinned far-right when active. */}
          {isActive && (
            <Check
              size={15}
              strokeWidth={2.5}
              aria-label="Active"
              data-testid={`router-active-check-${category}-${tile.id}`}
              style={{ color: "var(--c-accent, var(--c-high))", flexShrink: 0 }}
            />
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
              rel="noopener noreferrer"
              onClick={(e) => {
                stop(e);
                followLink(e, meta.docsUrl);
              }}
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
              <div
                style={segmentedWrap}
                role="radiogroup"
                aria-label="Connection mode"
              >
                {tile.modes.map((m) => {
                  const selected = mode === m;
                  return (
                    <button
                      key={m}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      onClick={(e) => {
                        stop(e);
                        if (!selected) changeMode(m);
                      }}
                      style={selected ? segmentBtnActive : segmentBtnBase}
                      data-testid={`router-mode-${category}-${tile.id}-${m}`}
                    >
                      {m === "managed" ? "API" : "Local"}
                    </button>
                  );
                })}
              </div>
              <div
                style={{
                  fontSize: 11,
                  color: "var(--c-dim)",
                  marginTop: 6,
                  lineHeight: 1.5,
                }}
              >
                {mode === "managed"
                  ? meta.managedBaseUrl
                    ? `Uses the hosted API at ${meta.managedBaseUrl}. Provide your API key below.`
                    : "Uses the hosted API. Provide your API key below."
                  : "Self-hosted deployment. Provide the base URL of your instance + an API key."}
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
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                marginBottom: 5,
              }}
            >
              <span style={{ ...labelStyle, marginBottom: 0 }}>API key</span>
              {tile.connected && keyPreview && !rotating && (
                <button
                  type="button"
                  style={{
                    ...ghostLink,
                    fontSize: 11,
                  }}
                  onClick={(e) => {
                    stop(e);
                    setRotating(true);
                  }}
                  data-testid={`router-rotate-${category}-${tile.id}`}
                >
                  edit
                </button>
              )}
            </div>
            {tile.connected && keyPreview && !rotating ? (
              <div
                style={{
                  ...inputStyle,
                  display: "flex",
                  alignItems: "center",
                  color: "var(--c-low)",
                  fontFamily:
                    "ui-monospace, SFMono-Regular, Menlo, monospace",
                  letterSpacing: 0.5,
                }}
                data-testid={`router-key-preview-${category}-${tile.id}`}
              >
                {keyPreview}
              </div>
            ) : (
              <input
                type="password"
                style={inputStyle}
                placeholder={
                  tile.connected
                    ? "Enter a new key to rotate (or leave blank to keep)"
                    : "••••••••••••••••••••"
                }
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                onClick={stop}
                data-testid={`router-secret-${category}-${tile.id}`}
                autoComplete="off"
                autoFocus
              />
            )}
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
