/**
 * Settings → Models card for Cloudflare Workers AI. Unlike a plain cloud
 * provider, connecting needs (a) a Workers AI API token AND (b) an account id.
 * Flow: "Open Cloudflare" deep-links to the Workers AI dashboard page → user
 * creates + copies the token AND copies their Account ID → pastes both → we
 * verify the pair against the Workers AI catalog via the backend, then store
 * the token in the keychain and the account id in config.
 *
 * Why the account id is typed by hand: the token this card mints is scoped to
 * Workers AI only, which can't list accounts (`GET /accounts` returns []), so
 * it can't be auto-discovered. Cloudflare's own REST API quickstart copies the
 * Account ID by hand for the same reason.
 */
import { useState } from "react";
import { Eye, EyeOff, X, Loader2, ExternalLink } from "lucide-react";
import { ProviderLogo } from "@/components/ui/provider-logo";
import { providers as providersApi, type ProviderTile } from "@/lib/providers-api";
import { useProvidersConfig } from "@/hooks/use-providers-config";
import { ConnectionStatusPill } from "@/components/settings/shared/connection-status-pill";
import { Toggle } from "@/components/settings/general/_primitives";

// Cloudflare's deep-link to the Workers AI dashboard page. From there the
// user picks "Use REST API" → "Create a Workers AI API Token" — Cloudflare's
// own template, which grants the required Workers AI Read + Edit permissions.
//
// We deliberately do NOT build a custom `permissionGroupKeys` template URL:
// Cloudflare's template short-key system has no key for Workers AI, so a
// guessed key (`workers_ai`) is silently dropped, leaving a token that
// verifies + lists accounts but is 401'd ("Authentication error", code 10000)
// by the `/ai/v1` endpoint. The first-party template is the only reliable
// way to mint a token with Workers AI permissions.
function workersAiTokenUrl(): string {
  return "https://dash.cloudflare.com/?to=/:account/ai/workers-ai";
}

function openExternal(url: string) {
  const w = window as unknown as {
    electronAPI?: { openExternal?: (u: string) => Promise<unknown> };
  };
  if (w.electronAPI?.openExternal) void w.electronAPI.openExternal(url);
  else window.open(url, "_blank", "noopener");
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  background: "var(--c-srf)",
  border: "1px solid var(--c-brd)",
  borderRadius: 7,
  padding: "7px 32px 7px 10px",
  fontSize: 12.5,
  color: "var(--c-high)",
  fontFamily: "var(--font-mono, ui-monospace, monospace)",
  outline: "none",
};

const ghostBtn: React.CSSProperties = {
  fontFamily: "inherit",
  cursor: "pointer",
  outline: "none",
  padding: "6px 12px",
  borderRadius: 7,
  fontSize: 12,
  fontWeight: 500,
  background: "transparent",
  border: "1px solid var(--c-brd)",
  color: "var(--c-high)",
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
};

const primaryBtn: React.CSSProperties = {
  fontFamily: "inherit",
  cursor: "pointer",
  outline: "none",
  padding: "6px 14px",
  borderRadius: 7,
  fontSize: 12,
  fontWeight: 600,
  background: "var(--c-high)",
  border: "none",
  color: "var(--card)",
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
};

const dangerBtn: React.CSSProperties = {
  fontFamily: "inherit",
  cursor: "pointer",
  outline: "none",
  padding: "6px 12px",
  borderRadius: 7,
  fontSize: 12,
  fontWeight: 500,
  background: "rgba(248,113,113,0.10)",
  border: "1px solid rgba(248,113,113,0.30)",
  color: "rgb(248,113,113)",
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
};

export function CloudflareConfigCard({
  tile,
  onHealthChange,
}: {
  tile: ProviderTile;
  onHealthChange: () => void;
}) {
  const { setKey, deleteKey, setEnabled, setCloudflareAccountId } =
    useProvidersConfig();
  const [expanded, setExpanded] = useState(!tile.has_key);
  const [editing, setEditing] = useState(false);
  const [token, setToken] = useState("");
  const [accountId, setAccountId] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const status = tile.connected
    ? ("connected" as const)
    : ("needs_setup" as const);
  const statusLabel = tile.connected
    ? "Connected"
    : tile.has_key
      ? "Disabled"
      : "Not connected";

  const persist = async (tok: string, acct: string) => {
    await setKey(tile.spec.id, tok);
    await setCloudflareAccountId(acct);
    setToken("");
    setAccountId("");
    setEditing(false);
    onHealthChange();
  };

  const onDisconnect = async () => {
    await deleteKey(tile.spec.id);
    // Clear the account id too — empty string maps to None server-side, which
    // the next backend reload uses to disable dispatch for this provider.
    await setCloudflareAccountId("");
    setToken("");
    setAccountId("");
    setEditing(false);
    setError(null);
    onHealthChange();
  };

  const onVerify = async () => {
    const t = token.trim();
    const acct = accountId.trim();
    if (!t || !acct) return;
    setBusy(true);
    setError(null);
    const r = await providersApi.cloudflareVerify(t, acct);
    setBusy(false);
    if (!r.valid) {
      setError(r.error ?? "Couldn't verify the token for this account.");
      return;
    }
    await persist(t, acct);
  };

  return (
    <div
      style={{
        border: `1px solid ${tile.connected ? "rgba(74,222,128,0.30)" : "var(--c-brd)"}`,
        borderRadius: 10,
        marginBottom: 10,
        overflow: "hidden",
        background: "var(--card)",
      }}
    >
      <div
        style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 14px" }}
      >
        <ProviderLogo tool="cloudflare-workers-ai" size={20} />
        <button
          onClick={() => setExpanded((v) => !v)}
          style={{
            flex: 1,
            minWidth: 0,
            background: "transparent",
            border: "none",
            textAlign: "left",
            cursor: "pointer",
            color: "var(--c-high)",
            fontFamily: "inherit",
            padding: 0,
          }}
        >
          <div style={{ fontSize: 13, fontWeight: 500 }}>{tile.spec.display_name}</div>
          <div style={{ fontSize: 11.5, color: "var(--c-low)", marginTop: 2 }}>
            {tile.spec.default_models.length} models · serverless GPU inference
          </div>
        </button>
        <ConnectionStatusPill status={status} label={statusLabel} />
        <span
          onClick={() => setExpanded((v) => !v)}
          style={{
            marginLeft: 4,
            transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
            transition: "transform 0.15s",
            color: "var(--c-dim)",
            fontSize: 12,
            cursor: "pointer",
          }}
        >
          ▸
        </span>
        {/* Master enable/disable — hides the provider from the composer
            picker without deleting the saved token. Mirrors ProviderCard. */}
        <div
          onClick={(e) => e.stopPropagation()}
          style={{ flexShrink: 0 }}
          title={
            tile.connected
              ? "Enabled — toggle off to hide from the picker"
              : "Disabled — toggle on to use in Fleet"
          }
        >
          <Toggle
            on={tile.connected}
            onChange={() => {
              void setEnabled(tile.spec.id, !tile.connected);
            }}
          />
        </div>
      </div>

      {expanded && (
        <div style={{ padding: "0 14px 14px 14px", borderTop: "1px solid var(--c-brd)" }}>
          {tile.has_key && !editing ? (
            <div style={{ padding: "14px 0 4px 0" }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    fontSize: 12.5,
                    color: "var(--c-high)",
                    minWidth: 0,
                  }}
                >
                  <span style={{ color: "rgb(74,222,128)" }}>✓</span>
                  <span>API token saved in your OS keychain.</span>
                </div>
                <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                  <button
                    onClick={() => {
                      setEditing(true);
                      setError(null);
                      setToken("");
                      setAccountId("");
                    }}
                    style={ghostBtn}
                  >
                    Replace token
                  </button>
                  <button onClick={() => void onDisconnect()} style={dangerBtn}>
                    <X size={11} /> Disconnect
                  </button>
                </div>
              </div>
              <div style={{ fontSize: 11, color: "var(--c-dim)", marginTop: 8 }}>
                {tile.spec.default_models.length} models available in the composer
                picker. Selecting one runs inference straight on your Cloudflare
                account — no Worker is deployed.
              </div>
            </div>
          ) : (
            <>
              <div
                style={{
                  padding: "14px 0 8px 0",
                  fontSize: 12,
                  color: "var(--c-low)",
                  lineHeight: 1.55,
                }}
              >
                1. Open Workers AI, then <strong>Use REST API → Create a
                Workers AI API Token</strong> → Create → Copy. 2. On the same
                page, copy your <strong>Account ID</strong>. 3. Paste both below.
              </div>
              <button
                onClick={() => openExternal(workersAiTokenUrl())}
                style={{ ...ghostBtn, marginBottom: 12 }}
                aria-label="Open Cloudflare Workers AI"
              >
                <ExternalLink size={12} /> Open Cloudflare Workers AI
              </button>

              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ position: "relative" }}>
                  <input
                    type={revealed ? "text" : "password"}
                    value={token}
                    placeholder="Paste your Cloudflare API token"
                    onChange={(e) => setToken(e.target.value)}
                    style={inputStyle}
                  />
                  <button
                    onClick={() => setRevealed((v) => !v)}
                    title={revealed ? "Hide" : "Reveal"}
                    style={{
                      position: "absolute",
                      right: 6,
                      top: "50%",
                      transform: "translateY(-50%)",
                      width: 24,
                      height: 24,
                      borderRadius: 5,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      background: "transparent",
                      border: "none",
                      cursor: "pointer",
                      color: "var(--c-dim)",
                    }}
                  >
                    {revealed ? <EyeOff size={13} /> : <Eye size={13} />}
                  </button>
                </div>
                <input
                  type="text"
                  value={accountId}
                  placeholder="Account ID (32-char hex, from the same page)"
                  onChange={(e) => setAccountId(e.target.value)}
                  spellCheck={false}
                  autoComplete="off"
                  style={{ ...inputStyle, paddingRight: 10 }}
                />
                <div style={{ display: "flex", gap: 6 }}>
                  <button
                    onClick={() => void onVerify()}
                    disabled={!token.trim() || !accountId.trim() || busy}
                    style={{
                      ...primaryBtn,
                      opacity:
                        !token.trim() || !accountId.trim() || busy ? 0.5 : 1,
                    }}
                  >
                    {busy ? <Loader2 size={12} className="spin" /> : null} Verify
                    &amp; Connect
                  </button>
                  {tile.connected && editing && (
                    <button
                      onClick={() => {
                        setEditing(false);
                        setToken("");
                        setAccountId("");
                        setError(null);
                      }}
                      style={ghostBtn}
                    >
                      Cancel
                    </button>
                  )}
                </div>
              </div>

              {error && (
                <div
                  style={{
                    marginTop: 8,
                    fontSize: 11.5,
                    color: "rgb(248,113,113)",
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                  }}
                >
                  <X size={12} /> {error}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
