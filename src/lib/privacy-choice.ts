/**
 * Sending a privacy choice (dashboard sync, product analytics) to the shell.
 *
 * `telemetry_set_cloud_enabled` and `telemetry_set_posthog_enabled` apply the
 * choice to the backend's live gate, then save it. They resolve to
 * `{ ok: true }`, or to `{ ok: false, error }` when the save failed: the
 * choice then holds only until Fleetify restarts. A call that throws, or a
 * bridge that isn't there, never reached the backend, so nothing changed.
 *
 * Settings → Privacy and the onboarding questions both go through here.
 */

/** What both privacy commands resolve to. */
export type PrivacySaveResult = { ok: true } | { ok: false; error: string };

export interface PrivacyChoiceOutcome {
  /** False when the call never reached the backend, so nothing changed. */
  applied: boolean;
  /** What to tell the user when the choice wasn't saved; null when it was. */
  error: string | null;
}

/** Shown when the call never reached the backend. */
export const PRIVACY_CHOICE_FAILED = "Couldn't change this setting.";

/**
 * Runs one privacy command. `send` returns undefined when the bridge is
 * missing (`window.electronAPI?.telemetrySet…?.(enabled)`). Never throws.
 */
export async function sendPrivacyChoice(
  send: () => Promise<PrivacySaveResult> | undefined,
): Promise<PrivacyChoiceOutcome> {
  try {
    const result = await send();
    if (!result) return { applied: false, error: PRIVACY_CHOICE_FAILED };
    return { applied: true, error: result.ok === false ? result.error : null };
  } catch {
    return { applied: false, error: PRIVACY_CHOICE_FAILED };
  }
}
