/**
 * Privacy card — Settings → General.
 *
 * Two rows:
 *   - Anonymous usage analytics (opt-out; default ON).
 *   - Crash reports (opt-out; default ON).
 *
 * Both flip the corresponding FleetConfig fields. The actual
 * telemetry/crash-report pipelines read those flags directly — this
 * card just persists the user's preference.
 */
import { useEffect, useState } from "react";
import { CardShell, Row, Toggle } from "./_primitives";

interface PrivacyCfg {
  telemetryEnabled?: boolean;
  crashReportsEnabled?: boolean;
}

type ElectronShim = {
  getConfig?: () => Promise<PrivacyCfg | null>;
  setConfig?: (cfg: PrivacyCfg) => Promise<unknown>;
};
function electron(): ElectronShim {
  return (window as unknown as { electronAPI?: ElectronShim }).electronAPI ?? {};
}

export function PrivacyCard() {
  const [cfg, setCfg] = useState<PrivacyCfg>({});
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let mounted = true;
    electron().getConfig?.()
      .then(c => { if (mounted) { setCfg(c ?? {}); setLoaded(true); } })
      .catch(() => { if (mounted) setLoaded(true); });
    return () => { mounted = false; };
  }, []);

  const patch = async (next: Partial<PrivacyCfg>) => {
    const merged = { ...cfg, ...next };
    setCfg(merged);
    try { await electron().setConfig?.(merged); } catch { /* best effort */ }
  };

  if (!loaded) {
    return <CardShell><div style={{ padding: 16, fontSize: 13, color: "var(--c-low)" }}>Loading…</div></CardShell>;
  }

  const telemetry = cfg.telemetryEnabled ?? true;
  const crashReports = cfg.crashReportsEnabled ?? true;

  return (
    <CardShell>
      <Row title="Anonymous usage analytics"
           desc="Helps us prioritize features. Never includes prompt content, API keys, or file paths.">
        <Toggle on={telemetry} onChange={() => void patch({ telemetryEnabled: !telemetry })} />
      </Row>
      <Row title="Crash reports" desc="Send stack traces when Fleetify crashes." last>
        <Toggle on={crashReports} onChange={() => void patch({ crashReportsEnabled: !crashReports })} />
      </Row>
    </CardShell>
  );
}
