/**
 * Privacy card — Settings → General.
 *
 * Three rows:
 *   - Anonymous usage analytics (Fleetify cloud, opt-out; default ON).
 *   - Crash reports (opt-out; default ON).
 *   - Product analytics (PostHog, opt-IN; default OFF).
 *
 * The first two read/write the flat `telemetryEnabled` /
 * `crashReportsEnabled` fields on FleetConfig. The third uses the
 * dedicated `telemetryGetConfig` / `telemetrySetPosthogEnabled`
 * commands so the toggle and the backend's live runtime gate stay in
 * lockstep without an extra round-trip through `fleet.config.json`.
 */
import { useEffect, useState } from "react";
import { CardShell, Row, Toggle } from "./_primitives";
import { saveConfigPatch } from "./_config";
import { optIn, optOut } from "@/lib/posthog";

interface PrivacyCfg {
  telemetryEnabled?: boolean;
  crashReportsEnabled?: boolean;
}

type ElectronShim = {
  getConfig?: () => Promise<PrivacyCfg | null>;
  telemetryGetConfig?: () => Promise<{ distinct_id: string; posthog_enabled: boolean }>;
  telemetrySetPosthogEnabled?: (enabled: boolean) => Promise<unknown>;
};
function electron(): ElectronShim {
  return (window as unknown as { electronAPI?: ElectronShim }).electronAPI ?? {};
}

export function PrivacyCard() {
  const [cfg, setCfg] = useState<PrivacyCfg>({});
  const [posthogEnabled, setPosthogEnabled] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let mounted = true;
    // Two independent reads — the flat FleetConfig (telemetryEnabled +
    // crashReportsEnabled) and the backend-owned posthog flag. Either
    // failing leaves its half at its default; the card still renders.
    Promise.allSettled([
      electron().getConfig?.() ?? Promise.resolve(null),
      electron().telemetryGetConfig?.() ?? Promise.resolve(null),
    ]).then(([cfgRes, telemRes]) => {
      if (!mounted) return;
      if (cfgRes.status === "fulfilled" && cfgRes.value) {
        setCfg(cfgRes.value as PrivacyCfg);
      }
      if (telemRes.status === "fulfilled" && telemRes.value) {
        setPosthogEnabled((telemRes.value as { posthog_enabled: boolean }).posthog_enabled);
      }
      setLoaded(true);
    });
    return () => { mounted = false; };
  }, []);

  const patch = async (next: Partial<PrivacyCfg>) => {
    setCfg(prev => ({ ...prev, ...next }));
    try { await saveConfigPatch(next); } catch { /* best effort */ }
  };

  const togglePosthog = async (next: boolean) => {
    setPosthogEnabled(next);
    // Flip the SDK client-side FIRST so a live opt-out stops new sends
    // immediately even if the backend round-trip is slow.
    if (next) optIn(); else optOut();
    try { await electron().telemetrySetPosthogEnabled?.(next); } catch { /* best effort */ }
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
      <Row title="Crash reports" desc="Send stack traces when Fleetify crashes.">
        <Toggle on={crashReports} onChange={() => void patch({ crashReportsEnabled: !crashReports })} />
      </Row>
      <Row title="Product analytics"
           desc="Anonymous behavioural data so we can see which features matter (e.g. is onboarding too long?). Same privacy floor — no message content, keys, or file paths. Off by default."
           last>
        <Toggle on={posthogEnabled} onChange={() => void togglePosthog(!posthogEnabled)} />
      </Row>
    </CardShell>
  );
}
