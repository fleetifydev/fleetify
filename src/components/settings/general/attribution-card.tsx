/**
 * Attribution card — Settings → General.
 *
 * One row: credit Fleetify in the commits it makes (a
 * `Co-Authored-By: Fleetify` trailer) and the pull requests it opens (a
 * short footer). On by default; switching it off writes
 * `gitAttribution: false` to fleet.config.json, which the shell reads on
 * every Create-PR.
 */
import { useEffect, useState } from "react";
import { CardShell, Row, Toggle } from "./_primitives";
import { saveConfigPatch } from "./_config";

interface AttributionCfg {
  gitAttribution?: boolean;
}

type ElectronShim = {
  getConfig?: () => Promise<AttributionCfg | null>;
};
function electron(): ElectronShim {
  return (window as unknown as { electronAPI?: ElectronShim }).electronAPI ?? {};
}

const TITLE = "Credit Fleetify in commits and pull requests";

export function AttributionCard() {
  const [cfg, setCfg] = useState<AttributionCfg>({});
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let mounted = true;
    electron().getConfig?.()
      .then(c => { if (mounted) { setCfg(c ?? {}); setLoaded(true); } })
      .catch(() => { if (mounted) setLoaded(true); });
    return () => { mounted = false; };
  }, []);

  const patch = async (next: Partial<AttributionCfg>) => {
    setCfg(prev => ({ ...prev, ...next }));
    try { await saveConfigPatch(next); } catch { /* best effort */ }
  };

  if (!loaded) {
    return <CardShell><div style={{ padding: 16, fontSize: 13, color: "var(--c-low)" }}>Loading…</div></CardShell>;
  }

  // Same rule as the shell's `git_attribution_from`: only an explicit
  // `false` turns attribution off.
  const attribution = cfg.gitAttribution !== false;

  return (
    <CardShell>
      <Row title={TITLE}
           desc='Adds a "Co-Authored-By: Fleetify" line to commits Fleetify makes and a short footer to pull requests it opens.'
           last>
        <Toggle on={attribution} label={TITLE}
                onChange={() => void patch({ gitAttribution: !attribution })} />
      </Row>
    </CardShell>
  );
}
