import { useEffect, useState } from "react";
import { ArrowRight, Check, Loader2, AlertCircle, X } from "lucide-react";
import { apiScanProviders, type ProviderScan } from "@/lib/api";
import { LogoMark } from "@/components/brand/logo-mark";
import { ProviderLogo } from "@/components/ui/provider-logo";

interface Props { onDone: () => void }
type ScanState = "scanning" | "done" | "error";
type RowAction = "install" | "key" | "open";
type RowState = "idle" | "installing" | "installed" | "error" | "expanded";

interface Provider {
  key: string;
  logo: string;
  name: string;
  action: RowAction;
  externalUrl?: string;
  configKey?: "anthropic" | "openai" | "gemini-cli" | "groq";
}

const PROVIDERS: Provider[] = [
  { key: "claude_cli", logo: "claude-code", name: "Claude Code", action: "install" },
  { key: "gemini_cli", logo: "gemini-cli", name: "Gemini CLI",  action: "install" },
  { key: "codex_cli",  logo: "codex-cli",  name: "Codex CLI",   action: "install" },
  { key: "ollama",     logo: "ollama", name: "Ollama",      action: "open", externalUrl: "https://ollama.com/download" },
  { key: "anthropic",  logo: "claude-code", name: "Anthropic",   action: "key", configKey: "anthropic" },
  { key: "openai",     logo: "openai", name: "OpenAI",      action: "key", configKey: "openai" },
  { key: "gemini_api", logo: "gemini-cli", name: "Google AI",   action: "key", configKey: "gemini-cli" },
  { key: "groq",       logo: "groq",   name: "Groq",        action: "key", configKey: "groq" },
];

/* ── Provider row — tight macOS-settings density ───────────── */
function Row({
  provider, detected, state, onAction, onSubmitKey, onCancel, error, isLast,
}: {
  provider: Provider;
  detected: boolean;
  state: RowState;
  onAction: () => void;
  onSubmitKey: (value: string) => void;
  onCancel: () => void;
  error?: string;
  isLast: boolean;
}) {
  const [keyValue, setKeyValue] = useState("");
  const isReady = detected || state === "installed";

  return (
    <div style={{ borderBottom: isLast ? "none" : "1px solid rgba(255,255,255,0.05)" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "8px 12px",
          height: 38,
        }}
      >
        <ProviderLogo tool={provider.logo} size={16} />
        <span style={{ flex: 1, fontSize: 12.5, fontWeight: 500, color: "var(--m-text)" }}>
          {provider.name}
        </span>

        {isReady ? (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, color: "#4ade80" }}>
            <Check size={11} strokeWidth={2.8} /> Ready
          </span>
        ) : state === "installing" ? (
          <Loader2 size={11} style={{ color: "var(--m-text-2)", animation: "spin 1s linear infinite" }} />
        ) : (
          <button
            onClick={onAction}
            style={{
              fontSize: 11,
              fontWeight: 500,
              padding: "3px 8px",
              borderRadius: 5,
              background: "transparent",
              color: "var(--m-text-2)",
              border: "1px solid rgba(255,255,255,0.10)",
              cursor: "pointer",
              transition: "color 0.15s, border-color 0.15s, background 0.15s",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = "var(--m-text)";
              e.currentTarget.style.borderColor = "rgba(255,255,255,0.18)";
              e.currentTarget.style.background = "rgba(255,255,255,0.04)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = "var(--m-text-2)";
              e.currentTarget.style.borderColor = "rgba(255,255,255,0.10)";
              e.currentTarget.style.background = "transparent";
            }}
          >
            {provider.action === "install" ? "Install" : provider.action === "key" ? "Add key" : "Get"}
          </button>
        )}
      </div>

      {/* Inline expansion for API-key entry */}
      {state === "expanded" && provider.action === "key" && (
        <div style={{ padding: "0 12px 8px", display: "flex", gap: 5 }}>
          <input
            type="password"
            placeholder="Paste API key"
            value={keyValue}
            onChange={(e) => setKeyValue(e.target.value)}
            autoFocus
            style={{
              flex: 1,
              height: 28,
              padding: "0 9px",
              borderRadius: 5,
              fontSize: 11.5,
              background: "rgba(0,0,0,0.3)",
              border: "1px solid rgba(255,255,255,0.10)",
              color: "var(--m-text)",
              outline: "none",
              fontFamily: "var(--font-mono, monospace)",
            }}
            onKeyDown={(e) => { if (e.key === "Enter" && keyValue.trim()) onSubmitKey(keyValue.trim()); }}
          />
          <button
            onClick={() => keyValue.trim() && onSubmitKey(keyValue.trim())}
            disabled={!keyValue.trim()}
            style={{
              height: 28,
              padding: "0 10px",
              borderRadius: 5,
              fontSize: 11,
              fontWeight: 600,
              background: keyValue.trim() ? "#fff" : "rgba(255,255,255,0.06)",
              color: keyValue.trim() ? "#000" : "var(--m-text-3)",
              border: "none",
              cursor: keyValue.trim() ? "pointer" : "not-allowed",
            }}
          >
            Save
          </button>
          <button
            onClick={onCancel}
            aria-label="Cancel"
            style={{
              width: 28, height: 28,
              display: "inline-flex", alignItems: "center", justifyContent: "center",
              borderRadius: 5,
              background: "transparent",
              color: "var(--m-text-3)",
              border: "1px solid rgba(255,255,255,0.08)",
              cursor: "pointer",
            }}
          >
            <X size={11} />
          </button>
        </div>
      )}

      {state === "error" && error && (
        <div style={{ padding: "0 12px 8px", fontSize: 11, color: "#f87171", display: "flex", gap: 6, alignItems: "flex-start" }}>
          <AlertCircle size={10} style={{ flexShrink: 0, marginTop: 2 }} />
          <span style={{ flex: 1 }}>{error}</span>
        </div>
      )}
    </div>
  );
}

function ProvidersStep({ onDone }: { onDone: () => void }) {
  const [v, setV] = useState(false);
  const [scanState, setScanState] = useState<ScanState>("scanning");
  const [scan, setScan] = useState<ProviderScan | null>(null);
  const [rowStates, setRowStates] = useState<Record<string, RowState>>({});
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [installedNow, setInstalledNow] = useState<Record<string, boolean>>({});

  useEffect(() => {
    const t = setTimeout(() => setV(true), 60);
    apiScanProviders()
      .then((d) => { setScan(d); setScanState("done"); })
      .catch(() => setScanState("error"));
    return () => clearTimeout(t);
  }, []);

  const detected = (key: string): boolean => {
    if (installedNow[key]) return true;
    if (!scan) return false;
    switch (key) {
      case "claude_cli": return scan.claude_cli.installed && scan.claude_cli.authenticated;
      case "gemini_cli": return scan.gemini_cli.installed && scan.gemini_cli.authenticated;
      case "codex_cli":  return scan.codex_cli.installed && scan.codex_cli.authenticated;
      case "ollama":     return scan.ollama.running;
      case "anthropic":  return scan.env_keys.anthropic;
      case "openai":     return scan.env_keys.openai;
      case "gemini_api": return scan.env_keys.gemini;
      case "groq":       return scan.env_keys.groq;
      default:           return false;
    }
  };

  const setRowState = (key: string, state: RowState, error?: string) => {
    setRowStates((s) => ({ ...s, [key]: state }));
    setRowErrors((s) => ({ ...s, [key]: error ?? "" }));
  };

  const handleAction = async (p: Provider) => {
    if (p.action === "install") {
      setRowState(p.key, "installing");
      const result = await window.electronAPI?.installProvider(p.key);
      if (result?.success) {
        setInstalledNow((s) => ({ ...s, [p.key]: true }));
        setRowState(p.key, "installed");
      } else {
        setRowState(p.key, "error", result?.error || "Install failed");
      }
    } else if (p.action === "key") {
      setRowState(p.key, "expanded");
    } else if (p.action === "open" && p.externalUrl) {
      window.electronAPI?.openExternal(p.externalUrl);
    }
  };

  const handleSubmitKey = async (p: Provider, value: string) => {
    if (!p.configKey) return;
    setRowState(p.key, "installing");
    try {
      const cfg = (await window.electronAPI?.getConfig()) ?? { onboardingComplete: false, apiKeys: {} };
      const apiKeys = { ...(cfg.apiKeys || {}), [p.configKey]: value };
      await window.electronAPI?.setConfig({ ...cfg, apiKeys });
      setInstalledNow((s) => ({ ...s, [p.key]: true }));
      setRowState(p.key, "installed");
    } catch (err) {
      setRowState(p.key, "error", err instanceof Error ? err.message : "Save failed");
    }
  };

  return (
    <div
      className="app-drag"
      style={{
        height: "100vh",
        width: "100vw",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "transparent",
        padding: "32px",
      }}
    >
      <div
        className="app-no-drag"
        style={{
          width: "100%",
          maxWidth: 360,
          opacity: v ? 1 : 0,
          transform: v ? "translateY(0)" : "translateY(12px)",
          transition: "all 0.5s cubic-bezier(0.16, 1, 0.3, 1)",
        }}
      >
        {/* Brand lockup */}
        <div
          style={{
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
            gap: 9,
            marginBottom: 18,
            color: "var(--m-text)",
          }}
        >
          <LogoMark size={20} color="currentColor" />
          <span
            style={{
              fontFamily: "'Geist Variable', 'Geist', system-ui, sans-serif",
              fontWeight: 700,
              fontSize: 17,
              letterSpacing: "-0.025em",
              lineHeight: 1,
            }}
          >
            Fleetify
          </span>
        </div>

        <h1
          style={{
            fontSize: 17,
            fontWeight: 600,
            color: "var(--m-text)",
            letterSpacing: "-0.02em",
            textAlign: "center",
            marginBottom: 4,
          }}
        >
          Choose your providers
        </h1>
        <p
          style={{
            fontSize: 12,
            color: "var(--m-text-2)",
            textAlign: "center",
            marginBottom: 18,
          }}
        >
          One click to set up.
        </p>

        {scanState === "error" ? (
          <div
            style={{
              display: "flex", gap: 7, alignItems: "center",
              padding: "8px 10px", borderRadius: 7, marginBottom: 12,
              background: "rgba(239,68,68,0.06)", border: "1px solid rgba(239,68,68,0.14)",
            }}
          >
            <AlertCircle size={11} style={{ color: "#f87171", flexShrink: 0 }} />
            <span style={{ fontSize: 11.5, color: "#f87171" }}>
              Backend unreachable.
            </span>
          </div>
        ) : (
          <div
            style={{
              borderRadius: 8,
              background: "rgba(255,255,255,0.02)",
              border: "1px solid rgba(255,255,255,0.06)",
              marginBottom: 14,
              overflow: "hidden",
            }}
          >
            {PROVIDERS.map((p, i) => (
              <Row
                key={p.key}
                provider={p}
                detected={detected(p.key)}
                state={rowStates[p.key] ?? "idle"}
                error={rowErrors[p.key]}
                onAction={() => handleAction(p)}
                onSubmitKey={(v) => handleSubmitKey(p, v)}
                onCancel={() => setRowState(p.key, "idle")}
                isLast={i === PROVIDERS.length - 1}
              />
            ))}
          </div>
        )}

        <button
          onClick={onDone}
          style={{
            width: "100%",
            height: 38,
            borderRadius: 8,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
            fontSize: 12.5,
            fontWeight: 600,
            background: "#fff",
            color: "#000",
            border: "1px solid rgba(255,255,255,0.9)",
            cursor: "pointer",
            boxShadow: "0 1px 0 rgba(255,255,255,0.4) inset, 0 1px 2px rgba(0,0,0,0.4)",
            transition: "transform 0.15s ease, box-shadow 0.15s ease",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.transform = "translateY(-1px)";
            e.currentTarget.style.boxShadow = "0 1px 0 rgba(255,255,255,0.5) inset, 0 4px 10px rgba(0,0,0,0.5)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.transform = "translateY(0)";
            e.currentTarget.style.boxShadow = "0 1px 0 rgba(255,255,255,0.4) inset, 0 1px 2px rgba(0,0,0,0.4)";
          }}
        >
          Enter Fleet
          <ArrowRight size={12} strokeWidth={2.2} />
        </button>
      </div>
    </div>
  );
}

export function SetupScreen({ onDone }: Props) {
  return <ProvidersStep onDone={onDone} />;
}
