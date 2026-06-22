/**
 * Onboarding (intro) gate — decides whether the one-time onboarding-chat
 * "intro" has already been completed on this device.
 *
 * The intro must show EXACTLY ONCE per device, ever — never again on
 * sign-out/sign-in, app restart, or a change of run-mode/port. To survive
 * all of those, the authoritative signal lives in the durable backend config
 * (`fleet.config.json::onboardingComplete`, scoped to the device, not the
 * webview origin).
 *
 * `fleet:setup-done` in localStorage is the LEGACY signal: it's origin-scoped
 * (keyed by `http://localhost:<port>`), so it doesn't carry across run modes.
 * We still honour it as a migration path so users who completed onboarding
 * before the gate moved to durable config aren't forced through it again.
 */
export interface IntroGateInputs {
  /** Durable backend-config flag (`fleet.config.json::onboardingComplete`). */
  onboardingComplete?: boolean | null;
  /** Legacy localStorage marker (`fleet:setup-done === "1"`). Migration only. */
  legacySetupDone?: boolean | null;
}

/**
 * The intro is complete — and must be skipped — when EITHER the durable
 * config flag is set OR the legacy localStorage marker is present.
 */
export function isIntroComplete(inputs: IntroGateInputs): boolean {
  return inputs.onboardingComplete === true || inputs.legacySetupDone === true;
}
