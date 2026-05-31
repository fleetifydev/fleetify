/**
 * Settings → Models card for Cloudflare Workers AI. Unlike a plain cloud
 * provider, connecting needs (a) a broad API token AND (b) an account id.
 * Flow: "Open Cloudflare" deep-links to a token-template page with
 * permissions pre-filled → user creates + copies the token → pastes it →
 * we verify + discover the account(s) via the backend, then store the token
 * in the keychain and the account id in config.
 */
import { useState } from "react";
import { Eye, EyeOff, X, Loader2, ExternalLink } from "lucide-react";
import { ProviderLogo } from "@/components/ui/provider-logo";
import {
  providers as providersApi,
  type ProviderTile,
  type CloudflareAccount,
} from "@/lib/providers-api";
import { useProvidersConfig } from "@/hooks/use-providers-config";
import { ConnectionStatusPill } from "@/components/settings/shared/connection-status-pill";
import { Toggle } from "@/components/settings/general/_primitives";

// Pre-filled token-template permissions (covers Workers AI + AI Gateway +
// Workers Scripts for phases 1-3). Slugs follow Cloudflare's snake_case
// convention — verify via GET /user/tokens/permission_groups.
const PERMISSION_GROUPS = [
  { key: "workers_ai", type: "read" },
  { key: "workers_ai", type: "edit" },
  { key: "ai_gateway", type: "read" },
  { key: "ai_gateway", type: "edit" },
  { key: "workers_scripts", type: "edit" },
  { key: "account_settings", type: "read" },
];

function templateUrl(): string {
  const keys = encodeURIComponent(JSON.stringify(PERMISSION_GROUPS));
  return `https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=${keys}&accountId=*&zoneId=all&name=${encodeURIComponent("Fleetify Cloudflare")}`;
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
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<CloudflareAccount[] | null>(null);

  const status = tile.connected
    ? ("connected" as const)
    : ("needs_setup" as const);
  const statusLabel = tile.connected
    ? "Connected"
    : tile.has_key
      ? "Disabled"
      : "Not connected";

  const persist = async (tok: string, accountId: string) => {
    await setKey(tile.spec.id, tok);
    await setCloudflareAccountId(accountId);
    setToken("");
    setAccounts(null);
    setEditing(false);
    onHealthChange();
  };

  const onDisconnect = async () => {
    await deleteKey(tile.spec.id);
    // Clear the account id too — empty string maps to None server-side, which
    // the next backend reload uses to disable dispatch for this provider.
    await setCloudflareAccountId("");
    setToken("");
    setAccounts(null);
    setEditing(false);
    setError(null);
    onHealthChange();
  };

  const onVerify = async () => {
    const t = token.trim();
    if (!t) return;
    setBusy(true);
    setError(null);
    const r = await providersApi.cloudflareVerify(t);
    setBusy(false);
    if (!r.valid) {
      setError(r.error ?? "Token is not valid or active.");
      return;
    }
    if (r.accounts.length === 0) {
      setError(
        "Token has no account access — check Workers AI permissions / billing.",
      );
      return;
    }
    const only = r.accounts.length === 1 ? r.accounts[0] : undefined;
    if (only) {
      await persist(t, only.id);
      return;
    }
    setAccounts(r.accounts);
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
                1. Open Cloudflare and create the pre-filled token. 2. Copy it. 3.
                Paste it below — we&apos;ll detect your account automatically.
              </div>
              <button
                onClick={() => openExternal(templateUrl())}
                style={{ ...ghostBtn, marginBottom: 12 }}
                aria-label="Open Cloudflare token page"
              >
                <ExternalLink size={12} /> Open Cloudflare (create token)
              </button>

              {accounts ? (
                <div>
                  <div
                    style={{
                      fontSize: 12,
                      fontWeight: 500,
                      color: "var(--c-high)",
                      marginBottom: 6,
                    }}
                  >
                    Choose an account
                  </div>
                  {accounts.map((a) => (
                    <button
                      key={a.id}
                      onClick={() => void persist(token.trim(), a.id)}
                      style={{
                        ...ghostBtn,
                        width: "100%",
                        justifyContent: "space-between",
                        marginBottom: 6,
                      }}
                    >
                      <span>{a.name}</span>
                      <span style={{ color: "var(--c-dim)", fontFamily: "monospace" }}>
                        {a.id}
                      </span>
                    </button>
                  ))}
                </div>
              ) : (
                <div style={{ display: "flex", gap: 6 }}>
                  <div style={{ flex: 1, position: "relative" }}>
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
                  <button
                    onClick={() => void onVerify()}
                    disabled={!token.trim() || busy}
                    style={{ ...primaryBtn, opacity: !token.trim() || busy ? 0.5 : 1 }}
                  >
                    {busy ? <Loader2 size={12} className="spin" /> : null} Verify &amp; Connect
                  </button>
                  {tile.connected && editing && (
                    <button
                      onClick={() => {
                        setEditing(false);
                        setToken("");
                        setError(null);
                        setAccounts(null);
                      }}
                      style={ghostBtn}
                    >
                      Cancel
                    </button>
                  )}
                </div>
              )}

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
