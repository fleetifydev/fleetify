/**
 * Privacy card — Settings → General.
 *
 * Two switches:
 *   - Dashboard sync: sessions on the user's fleetify.dev dashboard (the
 *     Fleetify cloud channel). On by default.
 *   - Product analytics: usage data for PostHog. Off until the user turns
 *     it on.
 *
 * Both show the backend's live gate from `telemetryGetConfig` and change it
 * through their own Tauri command, which saves the flag and then sets the
 * gate. Neither goes through `saveConfigPatch`: a whole-config write could
 * put back a stale `telemetry` section.
 *
 * A switch shows the new choice at once. If the command never reached the
 * backend, the switch flips back and says so. If the backend took the change
 * but couldn't save it, the switch keeps it and shows the backend's message.
 */
import { useEffect, useRef, useState } from "react";
import { CardShell, Row, Toggle } from "./_primitives";
import { optIn, optOut } from "@/lib/posthog";
import { sendPrivacyChoice, type PrivacySaveResult } from "@/lib/privacy-choice";

type ElectronShim = {
  telemetryGetConfig?: () => Promise<{
    distinct_id: string;
    posthog_enabled: boolean;
    cloud_enabled: boolean;
  }>;
  telemetrySetCloudEnabled?: (enabled: boolean) => Promise<PrivacySaveResult>;
  telemetrySetPosthogEnabled?: (enabled: boolean) => Promise<PrivacySaveResult>;
};
function electron(): ElectronShim {
  return (window as unknown as { electronAPI?: ElectronShim }).electronAPI ?? {};
}

const DASHBOARD_SYNC = "Dashboard sync";
const PRODUCT_ANALYTICS = "Product analytics";

export function PrivacyCard() {
  const [cloud, setCloud] = useState(false);
  const [cloudError, setCloudError] = useState<string | null>(null);
  const [posthog, setPosthog] = useState(false);
  const [posthogError, setPosthogError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  // One command per switch at a time: two in flight could land in either
  // order and leave the backend's gate disagreeing with the switch.
  const busy = useRef({ cloud: false, posthog: false });

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const saved = await electron().telemetryGetConfig?.();
        if (mounted && saved) {
          setCloud(saved.cloud_enabled === true);
          setPosthog(saved.posthog_enabled === true);
        }
      } catch {
        /* both switches stay off */
      }
      if (mounted) setLoaded(true);
    })();
    return () => { mounted = false; };
  }, []);

  const toggleCloud = async () => {
    if (busy.current.cloud) return;
    busy.current.cloud = true;
    const next = !cloud;
    setCloud(next);
    const { applied, error } = await sendPrivacyChoice(
      () => electron().telemetrySetCloudEnabled?.(next),
    );
    if (!applied) setCloud(!next);
    setCloudError(error);
    busy.current.cloud = false;
  };

  const togglePosthog = async () => {
    if (busy.current.posthog) return;
    busy.current.posthog = true;
    const next = !posthog;
    setPosthog(next);
    // Flip the SDK first so a live opt-out stops new sends at once, even if
    // the backend round-trip is slow.
    if (next) optIn(); else optOut();
    const { applied, error } = await sendPrivacyChoice(
      () => electron().telemetrySetPosthogEnabled?.(next),
    );
    if (!applied) {
      setPosthog(!next);
      // The backend never got the opt-in: stop capturing again. A failed
      // opt-out leaves the SDK off, since that is what the user asked for.
      if (next) optOut();
    }
    setPosthogError(error);
    busy.current.posthog = false;
  };

  if (!loaded) {
    return <CardShell><div style={{ padding: 16, fontSize: 13, color: "var(--c-low)" }}>Loading…</div></CardShell>;
  }

  return (
    <CardShell>
      <Row title={DASHBOARD_SYNC}
           desc="Shows your sessions on your fleetify.dev dashboard. Sends session titles (the folder name, or a name you typed), project folder names, which agent and model each session uses, the kind of each agent action, token usage and cost, and a heartbeat every minute while Fleetify is open, linked to your account. Never your code, file contents, commands or API keys. On by default."
           error={cloudError}>
        <Toggle on={cloud} label={DASHBOARD_SYNC} onChange={() => void toggleCloud()} />
      </Row>
      <Row title={PRODUCT_ANALYTICS}
           desc="Usage data that helps us see which features matter (for example, whether onboarding is too long), linked to your account after you sign in. Never message content, API keys or file paths. Off by default."
           error={posthogError}
           last>
        <Toggle on={posthog} label={PRODUCT_ANALYTICS} onChange={() => void togglePosthog()} />
      </Row>
    </CardShell>
  );
}
