/**
 * One tile in Settings → Models for a cloud HTTP provider (OpenAI,
 * DeepSeek, Grok, NVIDIA NIM, Kimi-API, Gemini-API, Perplexity).
 *
 * Header is a single tap target — clicking expands the card to reveal
 * the key input + model checkboxes. Click again (or away) to collapse.
 * Status pill in the header reflects the persisted state so the user
 * doesn't need to expand every tile to see what's connected.
 */
import { useState } from "react";
import { Eye, EyeOff, X, Loader2 } from "lucide-react";
import { ProviderLogo } from "@/components/ui/provider-logo";
import {
  providers as providersApi,
  type ProviderTile,
  type ProvidersTestResult,
} from "@/lib/providers-api";
import { useProvidersConfig } from "@/hooks/use-providers-config";
import { ModelPickerChecklist, useEffectiveModels } from "./model-picker-checklist";
import { ConnectionStatusPill } from "@/components/settings/shared/connection-status-pill";
import { Toggle } from "@/components/settings/general/_primitives";
import type { ProviderHealth } from "@/hooks/use-provider-health";

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
  transition: "border-color 0.12s",
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
};

function DefaultBadge() {
  return (
    <span
      style={{
        fontSize: 9.5,
        fontWeight: 700,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        padding: "2px 6px",
        borderRadius: 4,
        background: "rgba(74,222,128,0.16)",
        color: "rgb(74,222,128)",
        border: "1px solid rgba(74,222,128,0.30)",
      }}
    >
      Default
    </span>
  );
}

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
};

export function ProviderCard({
  tile,
  health,
  onHealthChange,
}: {
  tile: ProviderTile;
  health: ProviderHealth;
  onHealthChange: () => void;
}) {
  const { setKey, deleteKey, setEnabled, setDefault } = useProvidersConfig();
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draftKey, setDraftKey] = useState("");
  const [keyRevealed, setKeyRevealed] = useState(false);
  const [savedPreview, setSavedPreview] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [testResult, setTestResult] = useState<ProvidersTestResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);

  // Pill drives off the parent hook's launch-time test result. We never
  // fall back to tile.connected here — `health` is the single source of
  // truth, with `no_key` as the safe default the parent passes when a
  // tile lacks a saved key.
  const status =
    health.kind === "ok"
      ? ("connected" as const)
      : health.kind === "failed"
      ? ("error" as const)
      : health.kind === "testing"
      ? ("testing" as const)
      : ("needs_setup" as const);

  const statusLabel: string | undefined =
    health.kind === "ok"
      ? `Connected · ${health.latencyMs}ms`
      : health.kind === "failed"
      ? `Error · ${health.code ?? "?"}`
      : health.kind === "testing"
      ? "Testing…"
      : "Not connected";

  // Effective catalog — the live discovered list (OpenRouter / Cloudflare)
  // when connected, else the static curated list — drives the header count
  // and the checkbox checklist below.
  const effectiveModels = useEffectiveModels(tile, status === "connected");
  const modelCount = effectiveModels.length;

  // Lazy-load masked key preview when the user expands the card (avoids
  // an N×N IPC storm on initial Settings page render).
  const onToggleExpand = async () => {
    const next = !expanded;
    setExpanded(next);
    if (next && tile.has_key && savedPreview === null) {
      setPreviewLoading(true);
      const r = await providersApi.getKeyPreview(tile.spec.id);
      if (r.ok) setSavedPreview(r.preview);
      setPreviewLoading(false);
    }
  };

  const onSaveKey = async () => {
    const k = draftKey.trim();
    if (!k) return;
    setSaving(true);
    await setKey(tile.spec.id, k);
    setDraftKey("");
    setSavedPreview(null); // force re-fetch on next expand
    setSaving(false);
    setEditing(false);
    // Re-run the parent's launch-time scan so the pill transitions
    // testing → ok/failed without waiting for a page reload.
    onHealthChange();
  };

  const onDisconnect = async () => {
    await deleteKey(tile.spec.id);
    setSavedPreview(null);
    setTestResult(null);
    onHealthChange();
  };

  const onTest = async () => {
    const k = draftKey.trim();
    if (!k) return;
    setTesting(true);
    setTestResult(null);
    const r = await providersApi.testConnection(tile.spec.id, k);
    setTestResult(r);
    setTesting(false);
  };


  return (
    <div
      style={{
        border: "1px solid var(--c-brd)",
        borderRadius: 10,
        marginBottom: 10,
        overflow: "hidden",
        background: "var(--card)",
        transition: "border-color 0.15s",
      }}
    >
      {/* ── header row (always visible, click to expand) ── */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "12px 14px",
          width: "100%",
          color: "var(--c-high)",
          // Dim the header when the user has explicitly disabled the
          // provider — the status pill + name still read, but the
          // muted opacity signals "not in the picker right now."
          opacity: tile.connected ? 1 : 0.55,
          transition: "opacity 0.15s",
        }}
      >
        <button
          onClick={onToggleExpand}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            flex: 1,
            minWidth: 0,
            background: "transparent",
            border: "none",
            textAlign: "left",
            cursor: "pointer",
            color: "inherit",
            fontFamily: "inherit",
            padding: 0,
          }}
        >
          <ProviderLogo tool={tile.spec.id} size={20} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ fontSize: 13, fontWeight: 500 }}>{tile.spec.display_name}</span>
              {tile.is_default && <DefaultBadge />}
            </div>
            <div style={{ fontSize: 11.5, color: "var(--c-low)", marginTop: 2 }}>
              {modelCount} models · {tile.spec.default_base_url}
            </div>
          </div>
          <ConnectionStatusPill status={status} label={statusLabel} />
          <span
            style={{
              marginLeft: 6,
              transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
              transition: "transform 0.15s",
              display: "inline-block",
              color: "var(--c-dim)",
              fontSize: 12,
            }}
          >
            ▸
          </span>
        </button>
        {/* Master enable/disable. Stops propagation so flipping the
            toggle doesn't also expand/collapse the card. Always
            interactive (opacity reset to 1) so a disabled tile can be
            re-enabled without expanding. */}
        <div
          onClick={(e) => e.stopPropagation()}
          style={{ opacity: 1, flexShrink: 0 }}
          title={tile.connected ? "Enabled — uncheck to hide from picker" : "Disabled — toggle on to enable in Fleet"}
        >
          <Toggle
            on={tile.connected}
            onChange={() => { void setEnabled(tile.spec.id, !tile.connected); }}
          />
        </div>
      </div>

      {expanded && (
        <div style={{ padding: "0 14px 14px 14px", borderTop: "1px solid var(--c-brd)" }}>
          {/* ── API key row ── */}
          {tile.has_key && !editing ? (
            /* ── Saved-key view: masked preview + Edit + Disconnect ── */
            <div style={{ padding: "14px 0 12px 0" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                  <span style={{
                    fontFamily: "var(--font-mono, monospace)",
                    fontSize: 12.5,
                    color: "var(--c-high)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}>
                    {previewLoading ? "loading…" : (savedPreview ?? "saved")}
                  </span>
                  <span style={{ fontSize: 11, color: "var(--c-dim)" }}>✓ Saved</span>
                </div>
                <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                  <button onClick={() => setEditing(true)} style={ghostBtn}>Edit</button>
                  {tile.connected && (
                    <button onClick={onDisconnect} style={dangerBtn}>
                      <X size={11} /> Disconnect
                    </button>
                  )}
                </div>
              </div>
            </div>
          ) : (
            /* ── Input view: no-key initial flow OR editing an existing key ── */
            <div style={{ padding: "14px 0 12px 0" }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                <div style={{ fontSize: 12, fontWeight: 500, color: "var(--c-high)" }}>
                  {editing ? `Replacing ${savedPreview ?? "key"}` : "API Key"}
                </div>
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <div style={{ flex: 1, position: "relative" }}>
                  <input
                    type={keyRevealed ? "text" : "password"}
                    value={draftKey}
                    placeholder={editing ? `Replace key for ${tile.spec.display_name}…` : `Paste your ${tile.spec.display_name} key`}
                    onChange={(e) => setDraftKey(e.target.value)}
                    style={inputStyle}
                  />
                  <button
                    onClick={() => setKeyRevealed((v) => !v)}
                    title={keyRevealed ? "Hide" : "Reveal"}
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
                      outline: "none",
                    }}
                  >
                    {keyRevealed ? <EyeOff size={13} /> : <Eye size={13} />}
                  </button>
                </div>
                <button
                  onClick={onTest}
                  disabled={!draftKey.trim() || testing}
                  style={{ ...ghostBtn, opacity: !draftKey.trim() || testing ? 0.5 : 1 }}
                >
                  {testing ? <Loader2 size={12} className="spin" /> : "Test"}
                </button>
                <button
                  onClick={onSaveKey}
                  disabled={!draftKey.trim() || saving}
                  style={{ ...primaryBtn, opacity: !draftKey.trim() || saving ? 0.5 : 1 }}
                >
                  {saving ? <Loader2 size={12} className="spin" /> : "Save"}
                </button>
                {editing && (
                  <button
                    onClick={() => { setEditing(false); setDraftKey(""); }}
                    style={ghostBtn}
                  >
                    Cancel
                  </button>
                )}
              </div>
              {testResult && (
                <div style={{ marginTop: 8 }}>
                  {testResult.ok ? (
                    <ConnectionStatusPill
                      status="connected"
                      label={`✓ ${testResult.latency_ms}ms${
                        testResult.model_count ? ` · ${testResult.model_count} models` : ""
                      }`}
                    />
                  ) : (
                    <ConnectionStatusPill
                      status="error"
                      label={`${testResult.code}${testResult.error ? ` — ${testResult.error}` : ""}`}
                    />
                  )}
                </div>
              )}
              {tile.connected && !editing && (
                <div style={{ marginTop: 10 }}>
                  <button onClick={onDisconnect} style={dangerBtn}>
                    <X size={11} /> Disconnect
                  </button>
                </div>
              )}
            </div>
          )}

          {/* ── Fleet default — "Make default" button (or read-only
              indicator when already default). Hidden when the tile
              is disabled, since picking a disabled provider as the
              default would set the user up for an immediate "no key"
              error on their next message. ── */}
          {tile.connected && (
            <div
              style={{
                padding: "10px 0 2px 0",
                borderTop: "1px solid var(--c-brd)",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 10,
              }}
            >
              <div style={{ fontSize: 12, color: "var(--c-low)" }}>
                {tile.is_default
                  ? "This provider is your Fleet default — new chats open with it."
                  : "Use this provider as Fleet's default for new chats."}
              </div>
              {tile.is_default ? (
                <span
                  style={{
                    ...ghostBtn,
                    cursor: "default",
                    opacity: 0.7,
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                  }}
                >
                  ✓ Default
                </span>
              ) : (
                <button
                  onClick={() => { void setDefault(tile.spec.id); }}
                  style={ghostBtn}
                >
                  Make default
                </button>
              )}
            </div>
          )}

          {/* ── Model checklist (live catalog + search for discovery providers) ── */}
          <ModelPickerChecklist tile={tile} models={effectiveModels} />

          {/* ── env-hint footer (small) ── */}
          {tile.spec.auth.kind === "bearer" && tile.spec.auth.env_hint && (
            <div style={{ fontSize: 11, color: "var(--c-dim)", marginTop: 10 }}>
              Falls back to <code>{tile.spec.auth.env_hint}</code> env var when no key is saved.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
