/**
 * Settings → Models tile for the Ollama provider. Shape differs from
 * cloud providers because Ollama (a) needs no API key, (b) exposes a
 * dynamic model catalog via /api/tags, (c) can be local OR LAN-remote.
 *
 * Health (scanning / missing / installing / running / error) is owned
 * by useProviderHealth in the parent. This card derives its visible
 * state from the `health` prop and surfaces an Install button when
 * missing — wired to `onInstall` which calls the hook's installOllama().
 */
import { useState, useEffect, useCallback } from "react";
import { Loader2, RefreshCw, Download, X } from "lucide-react";
import { ProviderLogo } from "@/components/ui/provider-logo";
import {
  providers as providersApi,
  type ProviderTile,
  type OllamaModelEntry,
} from "@/lib/providers-api";
import { useProvidersConfig } from "@/hooks/use-providers-config";
import { ConnectionStatusPill, type ConnectionStatus } from "@/components/settings/shared/connection-status-pill";
import type { OllamaHealth } from "@/hooks/use-provider-health";

const inputStyle: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  background: "var(--c-srf)",
  border: "1px solid var(--c-brd)",
  borderRadius: 7,
  padding: "7px 10px",
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

function humanBytes(n?: number): string {
  if (!n || n <= 0) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
}

export function OllamaConfigCard({
  tile,
  health,
  onInstall,
  onCancelInstall,
}: {
  tile: ProviderTile;
  health: OllamaHealth;
  onInstall: () => void;
  onCancelInstall: () => void;
}) {
  const { setOllamaBaseUrl, setEnabledModels } = useProvidersConfig();
  const [expanded, setExpanded] = useState(false);
  const [draftUrl, setDraftUrl] = useState("");
  const [savedUrl, setSavedUrl] = useState<string | null>(null);
  // Per-card probe state (only meaningful while running, for the "Detect"
  // button + base-URL save flow). Mount-time presence detection is
  // owned by the parent hook.
  const [probing, setProbing] = useState(false);
  const [probeError, setProbeError] = useState<string | null>(null);
  const [probedModels, setProbedModels] = useState<OllamaModelEntry[]>([]);

  // Auto-expand when the daemon comes up so the model grid is visible
  // without a click. Plus auto-expand during install so the progress
  // panel is visible. The setState-in-effect is intentional here: this
  // is a one-shot React-internal sync, not external state, and the
  // health.kind dep gates it to actual transitions.
  useEffect(() => {
    if (health.kind === "running" || health.kind === "installing") {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setExpanded(true);
    }
  }, [health.kind]);

  // When we transition into "running", probe once to populate the
  // model grid (the scan only carries name strings, not sizes).
  const probe = useCallback(
    async (url?: string | null) => {
      setProbing(true);
      setProbeError(null);
      const r = await providersApi.ollamaProbe(url ?? null);
      setProbing(false);
      setSavedUrl(r.base_url);
      if (r.ok) {
        setProbedModels(r.models);
      } else {
        setProbedModels([]);
        setProbeError(`${r.code}${r.error ? ` — ${r.error}` : ""}`);
      }
    },
    [],
  );

  useEffect(() => {
    if (health.kind === "running" && probedModels.length === 0 && !probing && !probeError) {
      void probe();
    }
  }, [health.kind, probedModels.length, probing, probeError, probe]);

  const onSaveUrl = async () => {
    const trimmed = draftUrl.trim();
    if (!trimmed) return;
    await setOllamaBaseUrl(trimmed);
    setDraftUrl("");
    await probe(trimmed);
  };

  const enabled = new Set(tile.enabled_models);

  const onToggleModel = async (name: string) => {
    const next = new Set(enabled);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    await setEnabledModels(tile.spec.id, Array.from(next));
  };

  let status: ConnectionStatus = "needs_setup";
  let label: string | undefined;
  if (health.kind === "scanning") {
    status = "testing";
    label = "Detecting…";
  } else if (health.kind === "missing") {
    status = "needs_setup";
    label = "Not installed";
  } else if (health.kind === "installing") {
    status = "testing";
    label =
      health.substate === "running-installer"
        ? "Installing…"
        : health.substate === "waiting-daemon"
          ? "Starting Ollama…"
          : "Install timed out";
  } else if (health.kind === "running") {
    status = "connected";
    label = `${health.models.length} model${health.models.length === 1 ? "" : "s"}`;
  } else if (health.kind === "error") {
    status = "error";
    label = health.message;
  }

  return (
    <div
      style={{
        border: `1px solid ${health.kind === "running" ? "rgba(74,222,128,0.30)" : "var(--c-brd)"}`,
        borderRadius: 10,
        marginBottom: 10,
        overflow: "hidden",
        background: "var(--card)",
        transition: "border-color 0.15s",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 14px" }}>
        <ProviderLogo tool="ollama" size={20} />
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
            {savedUrl ?? tile.spec.default_base_url} · local LLM runtime
          </div>
        </button>
        <ConnectionStatusPill status={status} label={label} />
        {health.kind === "missing" && (
          <button
            onClick={onInstall}
            style={primaryBtn}
            title="Run the official Ollama installer for your OS"
          >
            <Download size={11} /> Install Ollama
          </button>
        )}
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
      </div>

      {expanded && (
        <div style={{ padding: "0 14px 14px 14px", borderTop: "1px solid var(--c-brd)" }}>
          {health.kind === "installing" && (
            <div style={{ padding: "14px 0 4px 0" }}>
              <div
                style={{
                  padding: "13px 14px",
                  borderRadius: 8,
                  background: "var(--c-srf)",
                  border: "1px solid var(--c-brd)",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
                  <Loader2
                    size={14}
                    style={{ animation: "spin 1s linear infinite", color: "var(--c-high)" }}
                  />
                  <span style={{ fontSize: 13, fontWeight: 600, color: "var(--c-high)" }}>
                    {health.substate === "running-installer"
                      ? "Running native installer…"
                      : health.substate === "waiting-daemon"
                        ? "Starting Ollama…"
                        : "Install didn't complete in 10 minutes"}
                  </span>
                </div>
                <div style={{ fontSize: 11.5, color: "var(--c-low)", lineHeight: 1.55 }}>
                  {health.openedBrowser
                    ? "Installer opened in your browser — finish it there, we'll detect the daemon automatically."
                    : "Native script: curl … | sh (or irm … | iex). This may take up to 10 minutes. We'll detect the daemon automatically."}
                </div>
                <button
                  onClick={onCancelInstall}
                  style={{ ...ghostBtn, marginTop: 10 }}
                  title="Stop waiting (the native installer may keep running in the background)"
                >
                  <X size={11} /> Cancel
                </button>
              </div>
            </div>
          )}

          {health.kind === "error" && (
            <div style={{ padding: "14px 0 4px 0", fontSize: 12, color: "rgb(248,113,113)" }}>
              {health.message}
            </div>
          )}

          {/* Base URL form is always available when expanded — even when
              missing, in case the user has a remote Ollama at a LAN URL. */}
          <div style={{ padding: "14px 0 12px 0" }}>
            <div style={{ fontSize: 12, fontWeight: 500, color: "var(--c-high)", marginBottom: 6 }}>
              Base URL
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <input
                value={draftUrl}
                placeholder={savedUrl ?? tile.spec.default_base_url}
                onChange={(e) => setDraftUrl(e.target.value)}
                style={inputStyle}
              />
              <button
                onClick={() => void probe(draftUrl.trim() || null)}
                disabled={probing}
                style={{ ...ghostBtn, opacity: probing ? 0.5 : 1 }}
              >
                {probing ? <Loader2 size={12} className="spin" /> : <RefreshCw size={11} />} Detect
              </button>
              <button
                onClick={onSaveUrl}
                disabled={!draftUrl.trim()}
                style={{ ...primaryBtn, opacity: !draftUrl.trim() ? 0.5 : 1 }}
              >
                Save
              </button>
            </div>
            <div style={{ fontSize: 11, color: "var(--c-dim)", marginTop: 6 }}>
              Use <code>http://localhost:11434</code> for a local install, or a LAN URL
              like <code>http://192.168.1.50:11434</code> to talk to a remote rig.
            </div>
            {probeError && (
              <div style={{ fontSize: 11.5, color: "rgb(248,113,113)", marginTop: 6 }}>
                {probeError}
              </div>
            )}
          </div>

          {health.kind === "running" && probedModels.length > 0 && (
            <div style={{ padding: "12px 0 4px 0", borderTop: "1px solid var(--c-brd)" }}>
              <div style={{ fontSize: 12, fontWeight: 500, color: "var(--c-high)", marginBottom: 8 }}>
                Detected models
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 6 }}>
                {probedModels.map((m) => {
                  const checked = enabled.has(m.name);
                  return (
                    <label
                      key={m.name}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        padding: "6px 8px",
                        borderRadius: 6,
                        cursor: "pointer",
                        fontSize: 12,
                        color: "var(--c-high)",
                        background: checked ? "var(--c-srf)" : "transparent",
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => onToggleModel(m.name)}
                        style={{ cursor: "pointer" }}
                      />
                      <span
                        style={{
                          flex: 1,
                          minWidth: 0,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          fontFamily: "var(--font-mono, monospace)",
                        }}
                      >
                        {m.name}
                      </span>
                      {m.size && (
                        <span style={{ fontSize: 10, color: "var(--c-dim)" }}>
                          {humanBytes(m.size)}
                        </span>
                      )}
                    </label>
                  );
                })}
              </div>
            </div>
          )}

          {health.kind === "running" && probedModels.length === 0 && !probing && (
            <div style={{ fontSize: 12, color: "var(--c-low)", padding: "8px 0" }}>
              No models found. Run <code>ollama pull &lt;model&gt;</code> to download one.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
