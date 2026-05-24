/**
 * Updates card — Settings → General.
 *
 * Renders the surface but disables it in "Coming soon" mode because
 * the Tauri updater plugin isn't wired in this build. The Automatic-
 * updates toggle still persists the user's intent so flipping the
 * plugin on later is a no-touch UX change. The channel select and
 * Check-now button are visibly disabled with a hint in the master
 * row's description.
 */
import { useEffect, useState } from "react";
import { CardShell, Row, Toggle } from "./_primitives";

interface UpdatesCfg {
  updatesAuto?: boolean;
  updatesChannel?: "stable" | "beta" | "canary";
}

type ElectronShim = {
  getConfig?: () => Promise<UpdatesCfg | null>;
  setConfig?: (cfg: UpdatesCfg) => Promise<unknown>;
};
function electron(): ElectronShim {
  return (window as unknown as { electronAPI?: ElectronShim }).electronAPI ?? {};
}

declare const __APP_VERSION__: string | undefined;

/* `__APP_VERSION__` is a Vite `define` replacement — it gets inlined at
   build time. In test runs (and any context where the define isn't
   wired) the symbol is undeclared and reading it throws ReferenceError,
   which would unmount the whole card. Resolve through a try/catch so
   the surface still renders. */
function appVersion(): string {
  try { return __APP_VERSION__ ?? "—"; } catch { return "—"; }
}

export function UpdatesCard() {
  const [cfg, setCfg] = useState<UpdatesCfg>({});
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let mounted = true;
    electron().getConfig?.()
      .then(c => { if (mounted) { setCfg(c ?? {}); setLoaded(true); } })
      .catch(() => { if (mounted) setLoaded(true); });
    return () => { mounted = false; };
  }, []);

  const patch = async (next: Partial<UpdatesCfg>) => {
    const merged = { ...cfg, ...next };
    setCfg(merged);
    try { await electron().setConfig?.(merged); } catch { /* best effort */ }
  };

  if (!loaded) {
    return <CardShell><div style={{ padding: 16, fontSize: 13, color: "var(--c-low)" }}>Loading…</div></CardShell>;
  }

  const auto = cfg.updatesAuto ?? true;
  const channel = cfg.updatesChannel ?? "stable";

  // The Tauri updater plugin isn't wired in this build (see Cargo.toml).
  // We render the controls so the surface exists, but disable them with
  // a "Coming soon" hint instead of pretending they work. This is a
  // strict UX win over hiding the section.
  const updaterReady = false;

  return (
    <CardShell>
      <Row title="Automatic updates" desc={updaterReady
        ? "Download and install in the background when available."
        : "Download and install in the background when available. (Coming soon)"}>
        <Toggle on={auto} onChange={() => void patch({ updatesAuto: !auto })} />
      </Row>
      <Row title="Update channel" desc="Pick how often you receive new features.">
        <select
          value={channel}
          onChange={(e) => void patch({ updatesChannel: e.target.value as UpdatesCfg["updatesChannel"] })}
          disabled={!updaterReady}
          style={{
            background: "var(--c-srf)", border: "1px solid var(--c-brd)",
            borderRadius: 7, padding: "5px 22px 5px 10px",
            fontSize: 12.5, color: "var(--c-high)",
            fontFamily: "inherit", outline: "none",
            cursor: updaterReady ? "pointer" : "not-allowed",
            opacity: updaterReady ? 1 : 0.55,
          }}
        >
          <option value="stable">Stable</option>
          <option value="beta">Beta</option>
          <option value="canary">Canary</option>
        </select>
      </Row>
      <Row title="Check for updates"
           desc={`Current: v${appVersion()}`}
           last>
        <button
          disabled={!updaterReady}
          style={{
            padding: "6px 14px", borderRadius: 7,
            background: "var(--c-high)", border: "none",
            color: "var(--card)", fontSize: 12, fontWeight: 600,
            cursor: updaterReady ? "pointer" : "not-allowed",
            opacity: updaterReady ? 1 : 0.55,
            fontFamily: "inherit",
          }}
        >
          Check now
        </button>
      </Row>
    </CardShell>
  );
}
