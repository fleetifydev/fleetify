/**
 * One tile in Settings → Agents for a CLI agent. Detection state +
 * install/login hints come from the registry-driven /api/agents/scan
 * endpoint. The Enable toggle writes the agent id into
 * ProvidersConfig.enabled_agents — Onboarding seeds the initial list,
 * Settings edits it later.
 *
 * Security: this card NEVER executes the install or login command on
 * the user's behalf. The buttons copy the command to clipboard so the
 * user runs it in their own terminal — keeps Fleetify out of the
 * shell-injection blast radius and makes the action transparent.
 */
import { useState, useEffect } from "react";
import { Check, Copy, Terminal, Loader2, KeyRound, ExternalLink } from "lucide-react";
import { ProviderLogo } from "@/components/ui/provider-logo";
import { providers as providersApi, type ProviderSpec } from "@/lib/providers-api";
import { ConnectionStatusPill } from "@/components/settings/shared/connection-status-pill";
import { AntigravitySdkSetupRow } from "./antigravity-sdk-setup";
import { checkPythonRuntime } from "@/lib/api";

export interface AgentScanEntry {
  id: string;
  display_name: string;
  installed: boolean;
  authenticated: boolean;
  path: string | null;
  install_hint: string;
  login_hint: string;
}

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
  padding: "8px 14px",
  borderRadius: 7,
  fontSize: 12,
  fontWeight: 600,
  background: "var(--c-high)",
  border: "none",
  color: "var(--card)",
};

async function copyToClipboard(text: string): Promise<boolean> {
  // Tauri's preload wires writeText — fall back to navigator.clipboard
  // for tests / Storybook.
  const w = window as unknown as { electronAPI?: { writeText?: (t: string) => unknown } };
  if (w.electronAPI?.writeText) {
    try {
      await w.electronAPI.writeText(text);
      return true;
    } catch {
      /* fall through */
    }
  }
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function AgentCard({
  spec,
  scan,
  onChanged,
  installing = false,
  installError,
  onInstall,
}: {
  spec: ProviderSpec;
  scan: AgentScanEntry | undefined;
  onChanged: () => void;
  installing?: boolean;
  installError?: string;
  onInstall?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [copiedInstall, setCopiedInstall] = useState(false);
  const [copiedLogin, setCopiedLogin] = useState(false);
  // Antigravity SDK auths via Gemini API key (no OAuth, no env-var
  // login command). The agent card renders a key-input panel inline
  // instead of the usual "copy this login command" hint when this
  // particular agent needs a key.
  const isSdk = spec.id === "antigravity-sdk";
  const [keyInput, setKeyInput] = useState("");
  const [savingKey, setSavingKey] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [showKeyEditor, setShowKeyEditor] = useState(false);
  const [pythonProbe, setPythonProbe] = useState<PythonRuntimeResult | null>(null);
  useEffect(() => {
    if (!isSdk) return;
    if (!expanded) return;
    let cancelled = false;
    void checkPythonRuntime().then((r) => {
      if (!cancelled) setPythonProbe(r);
    });
    return () => { cancelled = true; };
  }, [isSdk, expanded]);
  const installed = scan?.installed ?? false;
  const authenticated = scan?.authenticated ?? false;
  const installHint = scan?.install_hint || spec.install_hint;
  const loginHint = scan?.login_hint || spec.login_hint;

  const status = !installed
    ? ("needs_setup" as const)
    : !authenticated
    ? ("error" as const)
    : ("connected" as const);
  const statusLabel = !installed
    ? "Not installed"
    : !authenticated
    ? "Login required"
    : "Detected";

  const onCopyInstall = async () => {
    if (!installHint) return;
    const ok = await copyToClipboard(installHint);
    if (ok) {
      setCopiedInstall(true);
      setTimeout(() => setCopiedInstall(false), 1400);
    }
  };
  const onCopyLogin = async () => {
    if (!loginHint) return;
    const ok = await copyToClipboard(loginHint);
    if (ok) {
      setCopiedLogin(true);
      setTimeout(() => setCopiedLogin(false), 1400);
    }
    // Re-scan in case the user runs the login in another window — they
    // can click "Refresh" inside the expanded card too.
    setTimeout(onChanged, 800);
  };

  // SDK key save: writes to keychain via the same providers IPC the
  // HTTP-provider tiles use (service: Fleetify-Provider-antigravity-sdk).
  // Then triggers a re-scan so the status pill flips from "Login
  // required" to "Detected" without a manual refresh click.
  const onSaveKey = async () => {
    const trimmed = keyInput.trim();
    if (!trimmed) {
      setSaveError("Paste a Gemini API key first.");
      return;
    }
    setSavingKey(true);
    setSaveError(null);
    try {
      const result = await providersApi.setKey("antigravity-sdk", trimmed);
      if (!result.ok) {
        setSaveError(result.error || "Key save failed.");
        setSavingKey(false);
        return;
      }
      setKeyInput("");
      setShowKeyEditor(false);
      // Tiny defer so the keychain write settles before we re-probe.
      setTimeout(() => {
        onChanged();
        setSavingKey(false);
      }, 250);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
      setSavingKey(false);
    }
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
        <ProviderLogo tool={spec.id} size={20} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 500 }}>{spec.display_name}</div>
          <div style={{ fontSize: 11.5, color: "var(--c-low)", marginTop: 2 }}>
            CLI agent
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

      {expanded && (
        <div
          style={{
            padding: "10px 14px 14px 14px",
            borderTop: "1px solid var(--c-brd)",
            display: "flex",
            flexDirection: "column",
            gap: 12,
          }}
        >
          {/* Antigravity SDK uses the dedicated Setup row: Python required → Setup → Done. */}
          {isSdk && !installed && pythonProbe && (
            <AntigravitySdkSetupRow
              python={pythonProbe}
              sdkInstalled={installed}
              installing={!!installing}
              installError={installError ?? null}
              onSetup={() => onInstall?.()}
            />
          )}
          {/* All other agents keep the legacy install-hint block. */}
          {!isSdk && !installed && installHint && (
            <div>
              <div style={{ fontSize: 12, fontWeight: 500, color: "var(--c-high)", marginBottom: 6 }}>
                Install
              </div>
              <div
                style={{
                  fontFamily: "var(--font-mono, monospace)",
                  fontSize: 12,
                  padding: "8px 10px",
                  borderRadius: 6,
                  background: "var(--c-srf)",
                  border: "1px solid var(--c-brd)",
                  color: "var(--c-high)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                }}
              >
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  $ {installHint}
                </span>
                <button onClick={onCopyInstall} style={ghostBtn}>
                  {copiedInstall ? <Check size={11} /> : <Copy size={11} />}
                  {copiedInstall ? "Copied" : "Copy"}
                </button>
              </div>
              {onInstall && (
                <button
                  type="button"
                  onClick={onInstall}
                  disabled={installing}
                  style={{
                    ...primaryBtn,
                    width: "100%",
                    marginTop: 8,
                    opacity: installing ? 0.6 : 1,
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 8,
                  }}
                >
                  {installing ? (
                    <>
                      <Loader2 size={12} className="spin" /> Installing…
                    </>
                  ) : (
                    "Install"
                  )}
                </button>
              )}
              {installError && (
                <div
                  style={{
                    fontSize: 11,
                    color: "rgb(248,113,113)",
                    marginTop: 6,
                  }}
                >
                  {installError}
                </div>
              )}
            </div>
          )}

          {/* SDK-specific: API key entry replaces the standard
              "run this login command" block. Shown when the SDK
              package is installed but no key is on file (or when
              the user clicks "Replace key" on an already-authed
              card to rotate). */}
          {isSdk && installed && (!authenticated || showKeyEditor) && (
            <div>
              <div
                style={{
                  fontSize: 12,
                  fontWeight: 500,
                  color: "var(--c-high)",
                  marginBottom: 6,
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                }}
              >
                <KeyRound size={12} /> Gemini API key
              </div>
              <div style={{ display: "flex", gap: 8, marginBottom: 6 }}>
                <input
                  type="password"
                  autoComplete="off"
                  value={keyInput}
                  onChange={(e) => {
                    setKeyInput(e.target.value);
                    setSaveError(null);
                  }}
                  placeholder="AIza…"
                  style={{
                    flex: 1,
                    padding: "8px 10px",
                    borderRadius: 6,
                    background: "var(--c-srf)",
                    border: "1px solid var(--c-brd)",
                    color: "var(--c-high)",
                    fontFamily: "var(--font-mono, monospace)",
                    fontSize: 12,
                    outline: "none",
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && keyInput.trim()) onSaveKey();
                  }}
                />
                <button
                  type="button"
                  onClick={onSaveKey}
                  disabled={savingKey || !keyInput.trim()}
                  style={{
                    ...primaryBtn,
                    opacity: savingKey || !keyInput.trim() ? 0.55 : 1,
                    cursor:
                      savingKey || !keyInput.trim() ? "not-allowed" : "pointer",
                  }}
                >
                  {savingKey ? <Loader2 size={11} className="spin" /> : "Save"}
                </button>
              </div>
              <div style={{ fontSize: 11, color: "var(--c-dim)", display: "flex", alignItems: "center", gap: 4 }}>
                <a
                  href="https://aistudio.google.com/apikey"
                  target="_blank"
                  rel="noreferrer"
                  style={{ color: "var(--c-link, #4F8AFF)", textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 4 }}
                >
                  Get a key from Google AI Studio <ExternalLink size={10} />
                </a>
                <span style={{ marginLeft: "auto" }}>
                  Stored in {navigator?.userAgent?.includes("Mac") ? "Keychain" : "Credential Manager"}
                </span>
              </div>
              {saveError && (
                <div style={{ fontSize: 11, color: "rgb(248,113,113)", marginTop: 6 }}>
                  {saveError}
                </div>
              )}
            </div>
          )}

          {!isSdk && installed && !authenticated && loginHint && (
            <div>
              <div style={{ fontSize: 12, fontWeight: 500, color: "var(--c-high)", marginBottom: 6 }}>
                Login
              </div>
              <div
                style={{
                  fontFamily: "var(--font-mono, monospace)",
                  fontSize: 12,
                  padding: "8px 10px",
                  borderRadius: 6,
                  background: "var(--c-srf)",
                  border: "1px solid var(--c-brd)",
                  color: "var(--c-high)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                }}
              >
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  $ {loginHint}
                </span>
                <button onClick={onCopyLogin} style={ghostBtn}>
                  {copiedLogin ? <Check size={11} /> : <Terminal size={11} />}
                  {copiedLogin ? "Copied" : "Copy"}
                </button>
              </div>
              <div style={{ fontSize: 11, color: "var(--c-dim)", marginTop: 6 }}>
                Run this in a terminal — Fleetify will re-scan when the
                login finishes and the auth indicator file appears.
              </div>
            </div>
          )}

          {installed && authenticated && !showKeyEditor && (
            <div style={{ fontSize: 11.5, color: "var(--c-low)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
              <span>
                Ready to use. Pick this agent from the chat composer's
                tool chip or the New Agent dialog.
              </span>
              {/* SDK key rotation — opens the inline editor without
                  losing the existing key until the user saves a new one. */}
              {isSdk && (
                <button
                  type="button"
                  onClick={() => {
                    setShowKeyEditor(true);
                    setSaveError(null);
                    setKeyInput("");
                  }}
                  style={{ ...ghostBtn, fontSize: 11 }}
                >
                  <KeyRound size={10} /> Replace key
                </button>
              )}
            </div>
          )}

          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button onClick={onChanged} style={ghostBtn}>
              Refresh status
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
