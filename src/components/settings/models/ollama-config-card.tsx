/**
 * Settings → Models tile for the Ollama provider. Shape differs from
 * cloud providers because Ollama (a) needs no API key, (b) exposes a
 * dynamic model catalog via /api/tags, (c) can be local OR LAN-remote.
 */
import { useState, useEffect, useCallback } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { ProviderLogo } from "@/components/ui/provider-logo";
import {
  providers as providersApi,
  type ProviderTile,
  type OllamaModelEntry,
} from "@/lib/providers-api";
import { useProvidersConfig } from "@/hooks/use-providers-config";
import { ConnectionStatusPill, type ConnectionStatus } from "./connection-status-pill";

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

export function OllamaConfigCard({ tile }: { tile: ProviderTile }) {
  const { setOllamaBaseUrl, setEnabledModels } = useProvidersConfig();
  const [expanded, setExpanded] = useState(false);
  const [draftUrl, setDraftUrl] = useState("");
  const [savedUrl, setSavedUrl] = useState<string | null>(null);
  const [probing, setProbing] = useState(false);
  const [probeError, setProbeError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [models, setModels] = useState<OllamaModelEntry[]>([]);

  const enabled = new Set(tile.enabled_models);

  const probe = useCallback(
    async (url?: string | null) => {
      setProbing(true);
      setProbeError(null);
      const r = await providersApi.ollamaProbe(url ?? null);
      setProbing(false);
      setSavedUrl(r.base_url);
      if (r.ok) {
        setRunning(true);
        setModels(r.models);
      } else {
        setRunning(false);
        setModels([]);
        setProbeError(`${r.code}${r.error ? ` — ${r.error}` : ""}`);
      }
    },
    [],
  );

  // Auto-probe on first expand so the user doesn't have to click Detect.
  useEffect(() => {
    if (expanded && models.length === 0 && !probing && !probeError) {
      void probe();
    }
  }, [expanded, models.length, probing, probeError, probe]);

  const onSaveUrl = async () => {
    const trimmed = draftUrl.trim();
    if (!trimmed) return;
    await setOllamaBaseUrl(trimmed);
    setDraftUrl("");
    await probe(trimmed);
  };

  const onToggleModel = async (name: string) => {
    const next = new Set(enabled);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    await setEnabledModels(tile.spec.id, Array.from(next));
  };

  let status: ConnectionStatus = "needs_setup";
  let label: string | undefined;
  if (probing) {
    status = "testing";
    label = "Probing…";
  } else if (running) {
    status = "connected";
    label = `${models.length} model${models.length === 1 ? "" : "s"}`;
  } else if (probeError) {
    status = "error";
    label = probeError;
  }

  return (
    <div
      style={{
        border: `1px solid ${running ? "rgba(74,222,128,0.30)" : "var(--c-brd)"}`,
        borderRadius: 10,
        marginBottom: 10,
        overflow: "hidden",
        background: "var(--card)",
        transition: "border-color 0.15s",
      }}
    >
      <button
        onClick={() => setExpanded((v) => !v)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "12px 14px",
          width: "100%",
          background: "transparent",
          border: "none",
          textAlign: "left",
          cursor: "pointer",
          color: "var(--c-high)",
          fontFamily: "inherit",
        }}
      >
        <ProviderLogo tool="ollama" size={20} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 500 }}>{tile.spec.display_name}</div>
          <div style={{ fontSize: 11.5, color: "var(--c-low)", marginTop: 2 }}>
            {savedUrl ?? tile.spec.default_base_url} · local LLM runtime
          </div>
        </div>
        <ConnectionStatusPill status={status} label={label} />
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

      {expanded && (
        <div style={{ padding: "0 14px 14px 14px", borderTop: "1px solid var(--c-brd)" }}>
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
          </div>

          {running && models.length > 0 && (
            <div style={{ padding: "12px 0 4px 0", borderTop: "1px solid var(--c-brd)" }}>
              <div style={{ fontSize: 12, fontWeight: 500, color: "var(--c-high)", marginBottom: 8 }}>
                Detected models
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 6 }}>
                {models.map((m) => {
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

          {running && models.length === 0 && (
            <div style={{ fontSize: 12, color: "var(--c-low)", padding: "8px 0" }}>
              No models found. Run <code>ollama pull &lt;model&gt;</code> to download one.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
