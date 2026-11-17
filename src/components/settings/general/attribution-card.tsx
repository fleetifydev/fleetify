/**
 * Attribution card — Settings → General.
 *
 * One row: credit Fleetify in the commits it makes (a
 * `Co-Authored-By: Fleetify` trailer) and the pull requests it opens (a
 * short footer). On by default; switching it off writes
 * `gitAttribution: false` to fleet.config.json, which the shell reads on
 * every Create-PR.
 */
import { CardShell, Row, Toggle } from "./_primitives";
import { useConfigCard } from "./_config";

interface AttributionCfg {
  gitAttribution?: boolean;
}

const TITLE = "Credit Fleetify in commits and pull requests";

export function AttributionCard() {
  // A failed save puts the switch back and shows why: the switch must not
  // say off while the file still says on, since Create PR reads the file.
  const { cfg, loaded, patch, errorFor } = useConfigCard<AttributionCfg>();

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
           error={errorFor("gitAttribution")}
           last>
        <Toggle on={attribution} label={TITLE}
                onChange={() => void patch({ gitAttribution: !attribution })} />
      </Row>
    </CardShell>
  );
}
