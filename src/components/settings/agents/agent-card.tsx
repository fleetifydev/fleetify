/**
 * One tile in Settings → Agents for a CLI agent. Detection state +
 * install/login hints come from the registry-driven /api/agents/scan
 * endpoint (via the shared agent-scan store). The Enable toggle writes the
 * agent id into ProvidersConfig.enabled_agents — Onboarding seeds the
 * initial list, Settings edits it later.
 *
 * Install and Sign in run fixed commands from the backend catalog (never
 * text the user typed): Install through the shell's installer, Sign in in a
 * visible terminal so the user sees and drives the agent's own login. The
 * Copy buttons offer the same commands for the user's own terminal.
 */
import { useState, useEffect } from "react";
import { Check, Copy, Terminal, Loader2, KeyRound, ExternalLink, LogIn } from "lucide-react";
import { ProviderLogo } from "@/components/ui/provider-logo";
import {
  providers as providersApi,
  type AgentScanEntry,
  type ProviderSpec,
} from "@/lib/providers-api";
import { LoginTerminalModal } from "@/components/settings/shared/login-terminal-modal";
import { useProvidersConfig } from "@/hooks/use-providers-config";
import { ConnectionStatusPill } from "@/components/settings/shared/connection-status-pill";
import { Toggle } from "@/components/settings/general/_primitives";
import { AntigravitySdkSetupRow } from "./antigravity-sdk-setup";
import { AccountsManager } from "@/components/settings/shared/accounts-manager";
import { followLink } from "@/components/markdown-link";
import "@/components/settings/settings-ui.css";
import { checkPythonRuntime } from "@/lib/api";

export type { AgentScanEntry };

/** Where an API key the user saves ends up, named the way their OS does. */
function keyStoreName(): string {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  if (ua.includes("Mac")) return "Keychain";
  if (ua.includes("Windows")) return "Credential Manager";
  return "your system keyring";
}

/** Where the Gemini API key field's "Get a key from Google AI Studio" link goes. */
const AI_STUDIO_KEY_URL = "https://aistudio.google.com/apikey";

function DefaultBadge() {
  return <span className="s-tag">Default</span>;
}

const ghostBtn: React.CSSProperties = {
  fontFamily: "inherit",
  cursor: "pointer",
  outline: "none",
  padding: "6px 12px",
  borderRadius: 8,
  fontSize: 12,
  fontWeight: 500,
  background: "var(--c-srf)",
  border: "1px solid var(--c-brd)",
  color: "var(--c-med)",
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
};

const primaryBtn: React.CSSProperties = {
  fontFamily: "inherit",
  cursor: "pointer",
  outline: "none",
  padding: "8px 14px",
  borderRadius: 8,
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
  enabled,
  isDefault,
  scan,
  scanFailed = false,
  onChanged,
  installing = false,
  installError,
  onInstall,
}: {
  spec: ProviderSpec;
  /** Master enable flag — the user-visible Toggle in the header writes
   *  through `providers.setEnabled(spec.id, …)` and the chat composer's
   *  picker skips disabled agents. Defaults to true on first paint when
   *  the parent doesn't pass an explicit value. */
  enabled: boolean;
  /** True when this CLI agent is the current Fleet default — header
   *  shows a "DEFAULT" badge and the per-tile "Make default" affordance
   *  switches to a read-only indicator. */
  isDefault: boolean;
  scan: AgentScanEntry | undefined;
  /** The scan request failed: say so instead of claiming "Not installed". */
  scanFailed?: boolean;
  onChanged: () => void;
  installing?: boolean;
  installError?: string;
  onInstall?: () => void;
}) {
  const { setEnabled, setDefault } = useProvidersConfig();
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
  // OpenCode runs its free models without any sign-in.
  const signInRequired = scan?.auth_required ?? true;
  const installHint = scan?.install_hint || spec.install_hint;
  const loginHint = scan?.login_hint || spec.login_hint;
  const [loginPty, setLoginPty] = useState<string | null>(null);
  const [loginError, setLoginError] = useState<string | null>(null);

  const status = !scan
    ? ("needs_setup" as const)
    : !installed
    ? ("needs_setup" as const)
    : !authenticated
    ? ("error" as const)
    : ("connected" as const);
  const statusLabel = !scan
    ? scanFailed
      ? "Couldn't check"
      : "Checking…"
    : !installed
    ? "Not installed"
    : !authenticated
    ? "Sign in required"
    : signInRequired
    ? "Signed in"
    : "Ready";

  // Sign the System account (the real HOME, where chat sessions read the
  // login) in, in a terminal the user watches.
  const onSignIn = async () => {
    setLoginError(null);
    const res = await providersApi.openAccountLogin(spec.id, "system");
    if (res.ok) setLoginPty(res.pty_id);
    else setLoginError(res.error || "The sign-in couldn't start.");
  };

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
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "12px 14px",
          width: "100%",
          color: "var(--c-high)",
          // Dim the header when the user has explicitly disabled the
          // agent — picker hides it but install/login affordances stay
          // reachable so the user can still set it up.
          opacity: enabled ? 1 : 0.55,
          transition: "opacity 0.15s",
        }}
      >
        <button
          onClick={() => setExpanded((v) => !v)}
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
          <ProviderLogo tool={spec.id} size={20} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ fontSize: 13, fontWeight: 500 }}>{spec.display_name}</span>
              {isDefault && <DefaultBadge />}
            </div>
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
        <div
          onClick={(e) => e.stopPropagation()}
          style={{ opacity: 1, flexShrink: 0 }}
          title={enabled ? "Enabled — uncheck to hide from picker" : "Disabled — toggle on to enable in Fleet"}
        >
          <Toggle
            on={enabled}
            onChange={() => { void setEnabled(spec.id, !enabled); }}
          />
        </div>
      </div>

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
          {/* Multiple accounts: HOME-isolated logins per CLI agent. Shown once
              the binary is installed (the SDK has no on-disk login home). */}
          {!isSdk && installed && (
            <AccountsManager
              providerId={spec.id}
              kind="cli"
              providerName={spec.display_name}
              onChanged={onChanged}
            />
          )}
          {/* All other agents keep the legacy install-hint block. */}
          {!isSdk && !installed && installHint && (
            <div>
              <div style={{ fontSize: 12, fontWeight: 500, color: "var(--c-high)", marginBottom: 6 }}>
                Install
              </div>
              <div className="s-cmd">
                <code>{installHint}</code>
                <button onClick={onCopyInstall} className="s-cmd-copy">
                  {copiedInstall ? <Check size={12} /> : <Copy size={12} />}
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
                  href={AI_STUDIO_KEY_URL}
                  rel="noreferrer"
                  onClick={(e) => followLink(e, AI_STUDIO_KEY_URL)}
                  style={{ color: "var(--c-link, #4F8AFF)", textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 4 }}
                >
                  Get a key from Google AI Studio <ExternalLink size={10} />
                </a>
                <span style={{ marginLeft: "auto" }}>Stored in {keyStoreName()}</span>
              </div>
              {saveError && (
                <div style={{ fontSize: 11, color: "rgb(248,113,113)", marginTop: 6 }}>
                  {saveError}
                </div>
              )}
            </div>
          )}

          {!isSdk && installed && !authenticated && (
            <div>
              <div style={{ fontSize: 12, fontWeight: 500, color: "var(--c-high)", marginBottom: 6 }}>
                {signInRequired ? "Sign in" : "Connect a provider (optional)"}
              </div>
              {!signInRequired && (
                <div style={{ fontSize: 11.5, color: "var(--c-low)", marginBottom: 8 }}>
                  {spec.display_name} works without signing in. Sign in to add a
                  paid provider's models.
                </div>
              )}
              <button
                type="button"
                onClick={() => void onSignIn()}
                style={{
                  ...primaryBtn,
                  width: "100%",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 8,
                }}
              >
                <LogIn size={12} /> Sign in to {spec.display_name}
              </button>
              {loginError && (
                <div role="alert" style={{ fontSize: 11, color: "rgb(248,113,113)", marginTop: 6 }}>
                  {loginError}
                </div>
              )}
              {loginHint && (
                <>
                  <div style={{ fontSize: 11, color: "var(--c-dim)", margin: "10px 0 6px" }}>
                    Or run this in your own terminal:
                  </div>
                  <div className="s-cmd">
                    <code>{loginHint}</code>
                    <button onClick={onCopyLogin} className="s-cmd-copy">
                      {copiedLogin ? <Check size={12} /> : <Terminal size={12} />}
                      {copiedLogin ? "Copied" : "Copy"}
                    </button>
                  </div>
                  <div style={{ fontSize: 11, color: "var(--c-dim)", marginTop: 6 }}>
                    Fleetify checks again when you come back to this window.
                  </div>
                </>
              )}
            </div>
          )}

          {loginPty && (
            <LoginTerminalModal
              ptyId={loginPty}
              title={spec.display_name}
              onExit={() => onChanged()}
              onClose={() => {
                setLoginPty(null);
                onChanged();
              }}
            />
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

          {/* ── Fleet default — "Make default" button (or read-only
              indicator when already default). Hidden when the agent
              is disabled or not installed-and-authed; picking an
              unready agent as the default would seed new chats with
              a tool that immediately errors. ── */}
          {enabled && installed && authenticated && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 10,
                paddingTop: 4,
              }}
            >
              <div style={{ fontSize: 11.5, color: "var(--c-low)" }}>
                {isDefault
                  ? "This agent is your Fleet default — new chats open with it."
                  : "Use this agent as Fleet's default for new chats."}
              </div>
              {isDefault ? (
                <span
                  style={{
                    ...ghostBtn,
                    cursor: "default",
                    opacity: 0.7,
                  }}
                >
                  ✓ Default
                </span>
              ) : (
                <button
                  onClick={() => { void setDefault(spec.id); }}
                  style={ghostBtn}
                >
                  Make default
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
